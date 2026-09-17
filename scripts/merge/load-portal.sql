-- Load portal.* from the rows staged in merge_stage.rows (src = 'gbg').
-- Run by scripts/merge/merge-copy.sh inside one transaction; it decides COMMIT or ROLLBACK.
--
-- Rows keep their ids, tokens and object keys. References to the retired Zuper mirror
-- (customers.id, assets.id) are replaced by jms ids through jms.zuper_sync_map; a mirror
-- customer stored as 'tuper:<id>' already is one.

SET LOCAL session_replication_role = replica;   -- no FK checks or protection triggers while loading

-- The mirror ids the app tables point at → jms ids.
CREATE TEMP TABLE cust_map ON COMMIT DROP AS
SELECT (r.row->>'id')::uuid AS old_id,
       r.row->>'zuper_customer_uid' AS uid,
       CASE WHEN r.row->>'zuper_customer_uid' LIKE 'tuper:%'
            THEN substring(r.row->>'zuper_customer_uid' FROM 7)::uuid
            ELSE (SELECT m.jms_id FROM jms.zuper_sync_map m
                   WHERE m.tenant_id = '00000000-0000-0000-0000-000000000001'
                     AND m.entity = 'customers' AND m.zuper_uid = r.row->>'zuper_customer_uid' LIMIT 1)
       END AS jms_id
  FROM merge_stage.rows r WHERE r.src = 'gbg' AND r.tbl = 'customers';

CREATE TEMP TABLE asset_map ON COMMIT DROP AS
SELECT (r.row->>'id')::uuid AS old_id,
       r.row->>'zuper_asset_uid' AS uid,
       (SELECT m.jms_id FROM jms.zuper_sync_map m
         WHERE m.tenant_id = '00000000-0000-0000-0000-000000000001'
           AND m.entity = 'assets' AND m.zuper_uid = r.row->>'zuper_asset_uid' LIMIT 1) AS jms_id
  FROM merge_stage.rows r WHERE r.src = 'gbg' AND r.tbl = 'assets';

-- The tenant every row belongs to.
CREATE FUNCTION pg_temp.t(p jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS
  $$ SELECT p || '{"tenant_id": "00000000-0000-0000-0000-000000000001"}'::jsonb $$;
CREATE FUNCTION pg_temp.cust(p text) RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT jms_id FROM cust_map WHERE old_id = p::uuid $$;
CREATE FUNCTION pg_temp.asset(p text) RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT jms_id FROM asset_map WHERE old_id = p::uuid $$;
CREATE FUNCTION pg_temp.cust_uid(p text) RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT uid FROM cust_map WHERE old_id = p::uuid $$;
CREATE FUNCTION pg_temp.asset_uid(p text) RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT uid FROM asset_map WHERE old_id = p::uuid $$;
CREATE FUNCTION pg_temp.uid_to_jms(p_entity text, p_uid text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_uid LIKE 'tuper:%' THEN substring(p_uid FROM 7)::uuid
    ELSE (SELECT m.jms_id FROM jms.zuper_sync_map m
           WHERE m.tenant_id = '00000000-0000-0000-0000-000000000001'
             AND m.entity = p_entity AND m.zuper_uid = p_uid LIMIT 1) END
$$;

-- Start clean: the copy is repeatable (once now, once more at cutover).
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'portal' LOOP
    EXECUTE format('TRUNCATE portal.%I CASCADE', t);
  END LOOP;
END $$;

-- Every table whose rows copy as they are (plus the tenant).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'portal_password_reset_tokens', 'portal_password_setup_tokens', 'legacy_reports',
    'staff_users', 'staff_password_reset_tokens', 'engine_snapshots', 'review_items', 'rectifications',
    'report_versions', 'customer_decisions', 'quotations', 'job_status_steps',
    'job_status_step_revisions', 'job_step_attachments', 'applicability_determinations',
    'governed_rows', 'governed_drt_rules', 'governed_seed_state', 'audit_log', 'notifications'
  ] LOOP
    EXECUTE format(
      'INSERT INTO portal.%1$I SELECT (jsonb_populate_record(NULL::portal.%1$I, pg_temp.t(r.row))).* FROM merge_stage.rows r WHERE r.src = %2$L AND r.tbl = %3$L',
      t, 'gbg', t);
  END LOOP;
END $$;

-- Tables that pointed at the mirror.
INSERT INTO portal.client_users
SELECT (jsonb_populate_record(NULL::portal.client_users,
          pg_temp.t(r.row) || jsonb_build_object('customer_id', pg_temp.cust(r.row->>'customer_id'),
                                                 'zuper_customer_uid', pg_temp.cust_uid(r.row->>'customer_id')))).*
  FROM merge_stage.rows r WHERE r.src = 'gbg' AND r.tbl = 'client_users';

INSERT INTO portal.issuances
SELECT (jsonb_populate_record(NULL::portal.issuances,
          pg_temp.t(r.row) || jsonb_build_object('customer_id', pg_temp.cust(r.row->>'customer_id'),
                                                 'zuper_customer_uid', pg_temp.cust_uid(r.row->>'customer_id')))).*
  FROM merge_stage.rows r WHERE r.src = 'gbg' AND r.tbl = 'issuances';

INSERT INTO portal.jobs
SELECT (jsonb_populate_record(NULL::portal.jobs,
          pg_temp.t(r.row) || jsonb_build_object(
            'customer_id', pg_temp.cust(r.row->>'customer_id'),
            'zuper_customer_uid', pg_temp.cust_uid(r.row->>'customer_id'),
            'asset_id',    pg_temp.asset(r.row->>'asset_id'),
            'zuper_asset_uid', pg_temp.asset_uid(r.row->>'asset_id'),
            'jms_job_id',  pg_temp.uid_to_jms('jobs', r.row->>'zuper_job_uid')))).*
  FROM merge_stage.rows r WHERE r.src = 'gbg' AND r.tbl = 'jobs';

INSERT INTO portal.portal_enrollment_pins
SELECT (jsonb_populate_record(NULL::portal.portal_enrollment_pins,
          pg_temp.t(r.row) || jsonb_build_object('jms_customer_id', pg_temp.uid_to_jms('customers', r.row->>'customer_uid')))).*
  FROM merge_stage.rows r WHERE r.src = 'gbg' AND r.tbl = 'portal_enrollment_pins';

INSERT INTO portal.__drizzle_migrations (id, hash, created_at)
SELECT (r.row->>'id')::int, r.row->>'hash', (r.row->>'created_at')::bigint
  FROM merge_stage.rows r WHERE r.src = 'gbg' AND r.tbl = '__drizzle_migrations';

SET LOCAL session_replication_role = origin;

-- Sequences continue after the copied ids.
DO $$
DECLARE c record; top bigint;
BEGIN
  FOR c IN SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = 'portal' AND pg_get_serial_sequence('portal.' || table_name, column_name) IS NOT NULL
  LOOP
    EXECUTE format('SELECT max(%I) FROM portal.%I', c.column_name, c.table_name) INTO top;
    PERFORM setval(pg_get_serial_sequence('portal.' || c.table_name, c.column_name), COALESCE(top, 0) + 1, false);
  END LOOP;
END $$;

-- ── report ───────────────────────────────────────────────────────────────────

\echo '== rows: staged in gbg → loaded in portal'
SELECT s.tbl AS "table", s.n AS gbg,
       (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM portal.%I', s.tbl), false, true, '')))[1]::text::int AS portal
  FROM (SELECT tbl, count(*) AS n FROM merge_stage.rows WHERE src = 'gbg'
          AND tbl NOT IN ('customers', 'assets') GROUP BY tbl) s
 ORDER BY 1;

\echo '== references to Zuper records that could not be resolved to jms'
SELECT 'client_users.customer_id' AS ref, count(*) FILTER (WHERE r.row->>'customer_id' IS NOT NULL AND pg_temp.cust(r.row->>'customer_id') IS NULL) AS unresolved, count(*) FILTER (WHERE r.row->>'customer_id' IS NOT NULL) AS total
  FROM merge_stage.rows r WHERE r.src = 'gbg' AND r.tbl = 'client_users'
UNION ALL
SELECT 'issuances.customer_id', count(*) FILTER (WHERE pg_temp.cust(r.row->>'customer_id') IS NULL), count(*)
  FROM merge_stage.rows r WHERE r.src = 'gbg' AND r.tbl = 'issuances'
UNION ALL
SELECT 'jobs.customer_id', count(*) FILTER (WHERE r.row->>'customer_id' IS NOT NULL AND pg_temp.cust(r.row->>'customer_id') IS NULL), count(*) FILTER (WHERE r.row->>'customer_id' IS NOT NULL)
  FROM merge_stage.rows r WHERE r.src = 'gbg' AND r.tbl = 'jobs'
UNION ALL
SELECT 'jobs.asset_id', count(*) FILTER (WHERE r.row->>'asset_id' IS NOT NULL AND pg_temp.asset(r.row->>'asset_id') IS NULL), count(*) FILTER (WHERE r.row->>'asset_id' IS NOT NULL)
  FROM merge_stage.rows r WHERE r.src = 'gbg' AND r.tbl = 'jobs'
UNION ALL
SELECT 'jobs.zuper_job_uid', count(*) FILTER (WHERE pg_temp.uid_to_jms('jobs', r.row->>'zuper_job_uid') IS NULL), count(*)
  FROM merge_stage.rows r WHERE r.src = 'gbg' AND r.tbl = 'jobs'
UNION ALL
SELECT 'portal_enrollment_pins.customer_uid', count(*) FILTER (WHERE r.row->>'customer_uid' IS NOT NULL AND pg_temp.uid_to_jms('customers', r.row->>'customer_uid') IS NULL), count(*) FILTER (WHERE r.row->>'customer_uid' IS NOT NULL)
  FROM merge_stage.rows r WHERE r.src = 'gbg' AND r.tbl = 'portal_enrollment_pins';

\echo '== foreign keys inside portal with no parent row (must all be 0)'
DO $$
DECLARE c record; n bigint; bad int := 0;
BEGIN
  FOR c IN
    SELECT con.conname, cl.relname AS child, a.attname AS col, pcl.relname AS parent, pa.attname AS pcol
      FROM pg_constraint con
      JOIN pg_class cl ON cl.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      JOIN pg_class pcl ON pcl.oid = con.confrelid
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
     WHERE con.contype = 'f' AND n.nspname = 'portal' AND array_length(con.conkey, 1) = 1
       AND pcl.relnamespace = n.oid
  LOOP
    EXECUTE format('SELECT count(*) FROM portal.%I x WHERE x.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM portal.%I p WHERE p.%I = x.%I)',
                   c.child, c.col, c.parent, c.pcol, c.col) INTO n;
    IF n > 0 THEN RAISE WARNING 'orphans: %.% → % : %', c.child, c.col, c.parent, n; bad := bad + 1; END IF;
  END LOOP;
  RAISE NOTICE 'foreign-key check: % constraint(s) with orphans', bad;
END $$;

\echo '== protection triggers present'
SELECT count(*) AS portal_triggers FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'portal' AND NOT t.tgisinternal;
