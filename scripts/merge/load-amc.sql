-- Load amc.* from the rows staged in merge_stage.rows (src = 'amc'), taken from a SQLite
-- snapshot. Run by scripts/merge/merge-copy.sh inside one transaction.
--
-- Every column is converted explicitly (see migrations/0005). Ids are kept: the login JWT
-- carries users.id, and reminders/messages/settings point at each other by id.
-- Secrets go to Vault, not to amc.settings / amc.location_settings.

SET LOCAL session_replication_role = replica;

-- SQLite writes 'YYYY-MM-DD HH:MM:SS' in UTC with no zone; ISO strings carry their own.
CREATE FUNCTION pg_temp.ts(v text) RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN v IS NULL OR v = '' THEN NULL
    WHEN v ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$' THEN (v || '+00')::timestamptz
    ELSE v::timestamptz END
$$;
CREATE FUNCTION pg_temp.d(v text) RETURNS date LANGUAGE sql IMMUTABLE AS
  $$ SELECT NULLIF(v, '')::date $$;
CREATE FUNCTION pg_temp.b(v text) RETURNS boolean LANGUAGE sql IMMUTABLE AS
  $$ SELECT CASE WHEN v IS NULL OR v = '' THEN NULL ELSE v::int <> 0 END $$;
CREATE FUNCTION pg_temp.j(v text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS
  $$ SELECT NULLIF(v, '')::jsonb $$;
CREATE FUNCTION pg_temp.jms(p_entity text, p_uid text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT m.jms_id FROM jms.zuper_sync_map m
   WHERE m.tenant_id = '00000000-0000-0000-0000-000000000001'
     AND m.entity = p_entity AND m.zuper_uid = p_uid LIMIT 1
$$;

CREATE TEMP VIEW src AS
  SELECT tbl, row FROM merge_stage.rows WHERE src = 'amc';

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'amc' LOOP
    EXECUTE format('TRUNCATE amc.%I CASCADE', t);
  END LOOP;
END $$;

-- Keys that are secrets, and keys that were caches of Zuper data (jms replaces them).
CREATE TEMP TABLE secret_keys (key text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO secret_keys VALUES ('zuper_api_token'), ('whatsapp_api_key'), ('booking_secret_key');
CREATE TEMP TABLE cache_keys (key text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO cache_keys VALUES ('zuper_users'), ('zuper_categories'), ('zuper_last_synced');

INSERT INTO amc.users (id, email, password_hash, name, role, created_at)
SELECT (row->>'id')::bigint, row->>'email', row->>'password_hash', row->>'name', row->>'role', pg_temp.ts(row->>'created_at')
  FROM src WHERE tbl = 'users';

INSERT INTO amc.locations (id, zuper_property_uid, name, address, is_active, is_default, created_at, updated_at)
SELECT (row->>'id')::bigint, row->>'zuper_property_uid', row->>'name', row->>'address',
       pg_temp.b(row->>'is_active'), pg_temp.b(row->>'is_default'), pg_temp.ts(row->>'created_at'), pg_temp.ts(row->>'updated_at')
  FROM src WHERE tbl = 'locations';

INSERT INTO amc.location_settings (id, location_id, key, value, updated_at)
SELECT (row->>'id')::bigint, (row->>'location_id')::bigint, row->>'key', row->>'value', pg_temp.ts(row->>'updated_at')
  FROM src WHERE tbl = 'location_settings' AND row->>'key' NOT IN (SELECT key FROM secret_keys);

INSERT INTO amc.user_locations (id, user_id, location_id, role, created_at)
SELECT (row->>'id')::bigint, (row->>'user_id')::bigint, (row->>'location_id')::bigint, row->>'role', pg_temp.ts(row->>'created_at')
  FROM src WHERE tbl = 'user_locations';

INSERT INTO amc.password_resets (id, user_id, token_hash, expires_at, used_at, requested_ip, created_at)
SELECT (row->>'id')::bigint, (row->>'user_id')::bigint, row->>'token_hash', pg_temp.ts(row->>'expires_at'),
       pg_temp.ts(row->>'used_at'), row->>'requested_ip', pg_temp.ts(row->>'created_at')
  FROM src WHERE tbl = 'password_resets';

INSERT INTO amc.settings (key, value, updated_at)
SELECT row->>'key', row->>'value', pg_temp.ts(row->>'updated_at')
  FROM src WHERE tbl = 'settings'
   AND row->>'key' NOT IN (SELECT key FROM secret_keys)
   AND row->>'key' NOT IN (SELECT key FROM cache_keys);

INSERT INTO amc.reminder_campaigns (id, location_id, week_start, week_end, status, last_synced_at, created_at, updated_at)
SELECT (row->>'id')::bigint, (row->>'location_id')::bigint, pg_temp.d(row->>'week_start'), pg_temp.d(row->>'week_end'),
       row->>'status', pg_temp.ts(row->>'last_synced_at'), pg_temp.ts(row->>'created_at'), pg_temp.ts(row->>'updated_at')
  FROM src WHERE tbl = 'reminder_campaigns';

INSERT INTO amc.reminders (id, campaign_id, job_uid, jms_job_id, work_order_number, customer_uid, jms_customer_id,
    customer_name, customer_phone, job_category, job_title, scheduled_date, scheduled_time, status, reminder_count,
    last_reminder_sent_at, scheduled_at, scheduled_by, buggy_position, created_at, updated_at,
    assigned_mechanic_uid, assigned_mechanic_name, asset_name, asset_serial_number, asset_code, workshop_location,
    slot_label, child_job_uids)
SELECT (row->>'id')::bigint, (row->>'campaign_id')::bigint, row->>'job_uid', pg_temp.jms('jobs', row->>'job_uid'),
       row->>'work_order_number', row->>'customer_uid', pg_temp.jms('customers', row->>'customer_uid'),
       row->>'customer_name', row->>'customer_phone', row->>'job_category', row->>'job_title',
       pg_temp.d(row->>'scheduled_date'), row->>'scheduled_time', row->>'status', (row->>'reminder_count')::int,
       pg_temp.ts(row->>'last_reminder_sent_at'), pg_temp.ts(row->>'scheduled_at'), row->>'scheduled_by',
       (row->>'buggy_position')::int, pg_temp.ts(row->>'created_at'), pg_temp.ts(row->>'updated_at'),
       row->>'assigned_mechanic_uid', row->>'assigned_mechanic_name', row->>'asset_name', row->>'asset_serial_number',
       row->>'asset_code', row->>'workshop_location', row->>'slot_label', pg_temp.j(row->>'child_job_uids')
  FROM src WHERE tbl = 'reminders';

INSERT INTO amc.reminder_messages (id, reminder_id, whatsapp_message_id, phone_number, template_name, sent_at, status, error_message)
SELECT (row->>'id')::bigint, (row->>'reminder_id')::bigint, row->>'whatsapp_message_id', row->>'phone_number',
       row->>'template_name', pg_temp.ts(row->>'sent_at'), row->>'status', row->>'error_message'
  FROM src WHERE tbl = 'reminder_messages';

INSERT INTO amc.scheduled_job_reminders (id, job_uid, jms_job_id, work_order_number, customer_uid, customer_name,
    customer_phone, asset_name, asset_serial_number, scheduled_date, scheduled_time, slot_label, reminder_type, status,
    whatsapp_message_id, template_name, sent_at, error_message, location_id, created_at)
SELECT (row->>'id')::bigint, row->>'job_uid', pg_temp.jms('jobs', row->>'job_uid'), row->>'work_order_number',
       row->>'customer_uid', row->>'customer_name', row->>'customer_phone', row->>'asset_name', row->>'asset_serial_number',
       pg_temp.d(row->>'scheduled_date'), row->>'scheduled_time', row->>'slot_label', row->>'reminder_type', row->>'status',
       row->>'whatsapp_message_id', row->>'template_name', pg_temp.ts(row->>'sent_at'), row->>'error_message',
       (row->>'location_id')::bigint, pg_temp.ts(row->>'created_at')
  FROM src WHERE tbl = 'scheduled_job_reminders';

INSERT INTO amc.whatsapp_messages (id, message_id, phone, template_name, message_type, status, error_message, job_uid,
    jms_job_id, work_order_number, customer_name, location_id, created_at, updated_at, idempotency_key)
SELECT (row->>'id')::bigint, row->>'message_id', row->>'phone', row->>'template_name', row->>'message_type',
       row->>'status', row->>'error_message', row->>'job_uid', pg_temp.jms('jobs', row->>'job_uid'),
       row->>'work_order_number', row->>'customer_name', (row->>'location_id')::bigint,
       pg_temp.ts(row->>'created_at'), pg_temp.ts(row->>'updated_at'), row->>'idempotency_key'
  FROM src WHERE tbl = 'whatsapp_messages';

INSERT INTO amc.technician_day_offs (id, mechanic_uid, jms_user_id, mechanic_name, date, period, reason, created_by, location_id, created_at)
SELECT (row->>'id')::bigint, row->>'mechanic_uid', pg_temp.jms('users', row->>'mechanic_uid'), row->>'mechanic_name',
       pg_temp.d(row->>'date'), row->>'period', row->>'reason', row->>'created_by', (row->>'location_id')::bigint,
       pg_temp.ts(row->>'created_at')
  FROM src WHERE tbl = 'technician_day_offs';

INSERT INTO amc.excluded_customers (id, customer_uid, jms_customer_id, customer_name, reason, excluded_by, created_at, location_id)
SELECT (row->>'id')::bigint, row->>'customer_uid', pg_temp.jms('customers', row->>'customer_uid'), row->>'customer_name',
       row->>'reason', row->>'excluded_by', pg_temp.ts(row->>'created_at'), (row->>'location_id')::bigint
  FROM src WHERE tbl = 'excluded_customers';

INSERT INTO amc.booking_activity (id, job_uid, jms_job_id, work_order_number, customer_uid, customer_name, customer_phone,
    asset_name, action, booked_by, scheduled_date, scheduled_time, slot_label, mechanic_name, location_id, details, created_at)
SELECT (row->>'id')::bigint, row->>'job_uid', pg_temp.jms('jobs', row->>'job_uid'), row->>'work_order_number',
       row->>'customer_uid', row->>'customer_name', row->>'customer_phone', row->>'asset_name', row->>'action',
       row->>'booked_by', pg_temp.d(row->>'scheduled_date'), row->>'scheduled_time', row->>'slot_label',
       row->>'mechanic_name', (row->>'location_id')::bigint, row->>'details', pg_temp.ts(row->>'created_at')
  FROM src WHERE tbl = 'booking_activity';

INSERT INTO amc.slot_reservations (id, date, slot_label, position_number, location_id, job_uid, reserved_at, expires_at)
SELECT (row->>'id')::bigint, pg_temp.d(row->>'date'), row->>'slot_label', (row->>'position_number')::int,
       (row->>'location_id')::bigint, row->>'job_uid', pg_temp.ts(row->>'reserved_at'), pg_temp.ts(row->>'expires_at')
  FROM src WHERE tbl = 'slot_reservations';

INSERT INTO amc.booking_holds (id, date, slot_label, position_number, location_id, tech_uid, jms_user_id, start_ts, end_ts, created_at, expires_at)
SELECT (row->>'id')::bigint, pg_temp.d(row->>'date'), row->>'slot_label', (row->>'position_number')::int,
       (row->>'location_id')::bigint, row->>'tech_uid', pg_temp.jms('users', row->>'tech_uid'),
       (row->>'start_ts')::bigint, (row->>'end_ts')::bigint, pg_temp.ts(row->>'created_at'), pg_temp.ts(row->>'expires_at')
  FROM src WHERE tbl = 'booking_holds';

DO $$
DECLARE area text;
BEGIN
  FOREACH area IN ARRAY ARRAY['auth', 'settings', 'users', 'locations', 'bookings', 'reminders', 'dayoffs'] LOOP
    EXECUTE format($f$
      INSERT INTO amc.%1$I (id, created_at, actor_type, user_id, user_email, user_role, location_id, action,
          entity_type, entity_id, summary, metadata, method, path, status_code, ip, request_id)
      SELECT (row->>'id')::bigint, pg_temp.ts(row->>'created_at'), row->>'actor_type', (row->>'user_id')::bigint,
             row->>'user_email', row->>'user_role', (row->>'location_id')::bigint, row->>'action',
             row->>'entity_type', row->>'entity_id', row->>'summary', pg_temp.j(row->>'metadata'),
             row->>'method', row->>'path', (row->>'status_code')::int, row->>'ip', row->>'request_id'
        FROM src WHERE tbl = %1$L
    $f$, 'audit_' || area);
  END LOOP;
END $$;

-- Secrets → Vault. Named 'amc/<key>' and 'amc/location/<id>/<key>'; replaced on every run.
DELETE FROM vault.secrets WHERE name LIKE 'amc/%';
SELECT count(vault.create_secret(row->>'value', 'amc/' || (row->>'key'), 'AMC Engine setting, copied 2026-09-17'))
       AS global_secrets_to_vault
  FROM src WHERE tbl = 'settings' AND row->>'key' IN (SELECT key FROM secret_keys) AND coalesce(row->>'value', '') <> '';
SELECT count(vault.create_secret(row->>'value', 'amc/location/' || (row->>'location_id') || '/' || (row->>'key'),
                                 'AMC Engine location setting, copied 2026-09-17'))
       AS location_secrets_to_vault
  FROM src WHERE tbl = 'location_settings' AND row->>'key' IN (SELECT key FROM secret_keys) AND coalesce(row->>'value', '') <> '';

SET LOCAL session_replication_role = origin;

DO $$
DECLARE c record; top bigint;
BEGIN
  FOR c IN SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = 'amc' AND is_identity = 'YES'
  LOOP
    EXECUTE format('SELECT max(%I) FROM amc.%I', c.column_name, c.table_name) INTO top;
    PERFORM setval(pg_get_serial_sequence('amc.' || c.table_name, c.column_name), COALESCE(top, 0) + 1, false);
  END LOOP;
END $$;

-- ── report ───────────────────────────────────────────────────────────────────

\echo '== rows: SQLite snapshot → amc'
SELECT s.tbl AS "table", s.n AS sqlite,
       CASE WHEN to_regclass('amc.' || quote_ident(s.tbl)) IS NULL THEN NULL
            ELSE (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM amc.%I', s.tbl), false, true, '')))[1]::text::int
       END AS amc
  FROM (SELECT tbl, count(*) AS n FROM src GROUP BY tbl) s
 ORDER BY 1;

\echo '== settings kept out of the tables (secrets → Vault, Zuper caches → jms)'
SELECT tbl, row->>'key' AS key, CASE WHEN row->>'key' IN (SELECT key FROM secret_keys) THEN 'vault' ELSE 'dropped (jms)' END AS moved_to
  FROM src WHERE tbl IN ('settings', 'location_settings')
   AND (row->>'key' IN (SELECT key FROM secret_keys) OR (tbl = 'settings' AND row->>'key' IN (SELECT key FROM cache_keys)))
 ORDER BY 1, 2;

\echo '== Zuper references resolved to jms'
SELECT 'reminders.job_uid' AS ref, count(jms_job_id) AS resolved, count(*) AS total FROM amc.reminders
UNION ALL SELECT 'reminders.customer_uid', count(jms_customer_id), count(*) FROM amc.reminders
UNION ALL SELECT 'scheduled_job_reminders.job_uid', count(jms_job_id), count(*) FROM amc.scheduled_job_reminders
UNION ALL SELECT 'whatsapp_messages.job_uid', count(jms_job_id), count(job_uid) FROM amc.whatsapp_messages
UNION ALL SELECT 'booking_activity.job_uid', count(jms_job_id), count(*) FROM amc.booking_activity
UNION ALL SELECT 'technician_day_offs.mechanic_uid', count(jms_user_id), count(*) FROM amc.technician_day_offs
UNION ALL SELECT 'excluded_customers.customer_uid', count(jms_customer_id), count(*) FROM amc.excluded_customers
UNION ALL SELECT 'booking_holds.tech_uid', count(jms_user_id), count(*) FROM amc.booking_holds;

\echo '== timestamps that did not convert (must be 0)'
SELECT count(*) FILTER (WHERE row->>'created_at' IS NOT NULL AND row->>'created_at' <> '' AND pg_temp.ts(row->>'created_at') IS NULL) AS bad_created_at
  FROM src;

\echo '== foreign keys inside amc with no parent row (must all be 0)'
DO $$
DECLARE c record; n bigint; bad int := 0;
BEGIN
  FOR c IN
    SELECT cl.relname AS child, a.attname AS col, pcl.relname AS parent, pa.attname AS pcol
      FROM pg_constraint con
      JOIN pg_class cl ON cl.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      JOIN pg_class pcl ON pcl.oid = con.confrelid
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
     WHERE con.contype = 'f' AND n.nspname = 'amc' AND pcl.relnamespace = n.oid
  LOOP
    EXECUTE format('SELECT count(*) FROM amc.%I x WHERE x.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM amc.%I p WHERE p.%I = x.%I)',
                   c.child, c.col, c.parent, c.pcol, c.col) INTO n;
    IF n > 0 THEN RAISE WARNING 'orphans: %.% → % : %', c.child, c.col, c.parent, n; bad := bad + 1; END IF;
  END LOOP;
  RAISE NOTICE 'foreign-key check: % constraint(s) with orphans', bad;
END $$;
