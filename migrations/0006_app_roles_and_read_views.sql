-- 0006 — application roles, their access, and Zuper-shaped read views over jms.
--
-- Roles are created WITHOUT a password and without LOGIN. The password is set out of band
-- (scripts/merge/set-app-role-password.sh), stored only in the application's Coolify
-- environment, and never written to a file.
--
--   portal_app  both portals: everything in portal.*, read-only on jms
--   amc_app     AMC Engine:   everything in amc.*,    read-only on jms
--
-- Neither role may write jms.* (Zupersync is its only writer) or read Zupersync's own
-- tables (the Zuper API key in zuper_sync_config, delivery bodies, the push outbox).
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_app') THEN CREATE ROLE portal_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'amc_app') THEN CREATE ROLE amc_app NOLOGIN; END IF;
END $$;
ALTER ROLE portal_app SET search_path = portal, jms, public;
ALTER ROLE amc_app SET search_path = amc, jms, public;
-- Supabase's API roles get statement timeouts; a direct connection should too.
ALTER ROLE portal_app SET statement_timeout = '30s';
ALTER ROLE amc_app SET statement_timeout = '30s';

-- ── own schemas ──────────────────────────────────────────────────────────────

GRANT USAGE ON SCHEMA portal TO portal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA portal TO portal_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA portal TO portal_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA portal TO portal_app;
-- The portals' migrator creates and alters its own tables in portal.*.
GRANT CREATE ON SCHEMA portal TO portal_app;

GRANT USAGE ON SCHEMA amc TO amc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA amc TO amc_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA amc TO amc_app;
GRANT CREATE ON SCHEMA amc TO amc_app;
GRANT EXECUTE ON FUNCTION amc.secret(text) TO amc_app;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'portal' LOOP
    EXECUTE format('DROP POLICY IF EXISTS portal_app_all ON portal.%I', t);
    EXECUTE format('CREATE POLICY portal_app_all ON portal.%I FOR ALL TO portal_app USING (true) WITH CHECK (true)', t);
  END LOOP;
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'amc' LOOP
    EXECUTE format('DROP POLICY IF EXISTS amc_app_all ON amc.%I', t);
    EXECUTE format('CREATE POLICY amc_app_all ON amc.%I FOR ALL TO amc_app USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- ── jms: read-only, tenant-pinned ────────────────────────────────────────────

GRANT USAGE ON SCHEMA jms TO portal_app, amc_app;
GRANT SELECT ON ALL TABLES IN SCHEMA jms TO portal_app, amc_app;
-- Zupersync's own tables: the Zuper API key, raw delivery bodies, the push outbox.
REVOKE ALL ON jms.zuper_sync_config, jms.zuper_webhook_events, jms.zuper_outbox FROM portal_app, amc_app;

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'jms' AND c.relkind = 'r' AND c.relrowsecurity
       AND c.relname NOT IN ('zuper_sync_config', 'zuper_webhook_events', 'zuper_outbox')
       AND EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'jms' AND table_name = c.relname AND column_name = 'tenant_id')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS app_read ON jms.%I', t);
    EXECUTE format('CREATE POLICY app_read ON jms.%I FOR SELECT TO portal_app, amc_app USING (tenant_id = %L)',
                   t, '00000000-0000-0000-0000-000000000001');
  END LOOP;
END $$;

-- ── Zuper-shaped read views ──────────────────────────────────────────────────
-- security_invoker: the caller's grants and row policies apply, not the view owner's.

-- Any record's Zuper uid, both ways.
CREATE OR REPLACE VIEW jms.v_uid WITH (security_invoker = true) AS
SELECT tenant_id, entity, zuper_uid, jms_id, synced_at
  FROM jms.zuper_sync_map;

-- One row per job, with what the portals' and AMC's mirrors used to hold. Filter on
-- job_uid, id, work_order_number or the schedule; each uses an index.
CREATE OR REPLACE VIEW jms.v_job_summary WITH (security_invoker = true) AS
SELECT
    j.id,
    j.tenant_id,
    jm.zuper_uid                                   AS job_uid,
    j.work_order_number,
    j.prefix,
    j.title                                        AS job_title,
    j.description,
    j.category_id,
    cat.name                                       AS category_name,
    (SELECT m.zuper_uid FROM jms.zuper_sync_map m
      WHERE m.tenant_id = j.tenant_id AND m.entity = 'job_categories' AND m.jms_id = j.category_id
      ORDER BY m.synced_at DESC LIMIT 1)           AS category_uid,
    j.current_status_id                            AS status_id,
    st.name                                        AS status_name,
    st.status_type,
    (SELECT m.zuper_uid FROM jms.zuper_sync_map m
      WHERE m.tenant_id = j.tenant_id AND m.entity = 'job_statuses' AND m.jms_id = j.current_status_id
      ORDER BY m.synced_at DESC LIMIT 1)           AS status_uid,
    j.current_status_color                         AS status_color,
    j.customer_id,
    (SELECT m.zuper_uid FROM jms.zuper_sync_map m
      WHERE m.tenant_id = j.tenant_id AND m.entity = 'customers' AND m.jms_id = j.customer_id
      LIMIT 1)                                     AS customer_uid,
    NULLIF(trim(concat_ws(' ', cu.first_name, cu.last_name)), '') AS customer_name,
    cu.company_name                                AS customer_company,
    COALESCE(cu.contact_no->>'mobile', cu.contact_no->>'work', cu.contact_no->>'home') AS customer_phone,
    cu.email                                       AS customer_email,
    j.organization_id,
    (SELECT v.value_text FROM jms.custom_field_values v
       JOIN jms.custom_field_definitions d ON d.id = v.definition_id
      WHERE v.entity_id = j.id AND v.entity_type = 'JOB' AND d.label = 'Workshop Location'
      LIMIT 1)                                     AS workshop_location,
    j.scheduled_start_time                         AS scheduled_start,
    j.scheduled_end_time                           AS scheduled_end,
    j.due_date,
    j.actual_start_time,
    j.actual_end_time,
    j.job_type,
    j.priority,
    j.is_recurring,
    j.parent_job_id,
    (SELECT m.zuper_uid FROM jms.zuper_sync_map m
      WHERE m.tenant_id = j.tenant_id AND m.entity = 'jobs' AND m.jms_id = j.parent_job_id
      LIMIT 1)                                     AS parent_job_uid,
    tech.user_ids                                  AS assigned_user_ids,
    tech.user_uids                                 AS assigned_tech_uids,
    tech.names                                     AS assigned_tech_names,
    j.asset_id,
    a.name                                         AS asset_name,
    a.serial_number                                AS asset_serial_number,
    a.asset_code,
    j.service_address,
    j.job_tags,
    j.is_deleted,
    j.created_at,
    j.updated_at
FROM jms.jobs j
LEFT JOIN jms.zuper_sync_map jm
       ON jm.tenant_id = j.tenant_id AND jm.entity = 'jobs' AND jm.jms_id = j.id
LEFT JOIN jms.job_categories cat ON cat.id = j.category_id
LEFT JOIN jms.job_statuses st ON st.id = j.current_status_id
LEFT JOIN jms.customers cu ON cu.id = j.customer_id
LEFT JOIN jms.assets a ON a.id = j.asset_id
LEFT JOIN LATERAL (
    SELECT array_agg(ja.user_id ORDER BY ja.is_primary DESC, ja.created_at)                  AS user_ids,
           array_agg(um.zuper_uid ORDER BY ja.is_primary DESC, ja.created_at)                AS user_uids,
           array_agg(NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), '')
                     ORDER BY ja.is_primary DESC, ja.created_at)                              AS names
      FROM jms.job_assignments ja
      LEFT JOIN jms.users u ON u.id = ja.user_id
      LEFT JOIN jms.zuper_sync_map um
             ON um.tenant_id = ja.tenant_id AND um.entity = 'users' AND um.jms_id = ja.user_id
     WHERE ja.job_id = j.id
) tech ON true;

CREATE OR REPLACE VIEW jms.v_customer WITH (security_invoker = true) AS
SELECT
    c.id,
    c.tenant_id,
    (SELECT m.zuper_uid FROM jms.zuper_sync_map m
      WHERE m.tenant_id = c.tenant_id AND m.entity = 'customers' AND m.jms_id = c.id LIMIT 1) AS customer_uid,
    c.first_name, c.last_name, c.company_name,
    COALESCE(NULLIF(trim(concat_ws(' ', c.first_name, c.last_name)), ''), c.company_name) AS display_name,
    c.email, c.additional_emails,
    c.contact_no->>'mobile' AS mobile, c.contact_no->>'work' AS work_phone, c.contact_no->>'home' AS home_phone,
    c.organization_id,
    (SELECT m.zuper_uid FROM jms.zuper_sync_map m
      WHERE m.tenant_id = c.tenant_id AND m.entity = 'organizations' AND m.jms_id = c.organization_id LIMIT 1) AS organization_uid,
    c.is_portal_enabled, c.is_active, c.is_deleted, c.no_of_jobs,
    c.created_at, c.updated_at
FROM jms.customers c;

CREATE OR REPLACE VIEW jms.v_asset WITH (security_invoker = true) AS
SELECT
    a.id,
    a.tenant_id,
    (SELECT m.zuper_uid FROM jms.zuper_sync_map m
      WHERE m.tenant_id = a.tenant_id AND m.entity = 'assets' AND m.jms_id = a.id LIMIT 1) AS asset_uid,
    a.name, a.asset_code, a.serial_number, a.model, a.manufacturer,
    ac.name AS category_name,
    a.customer_id,
    (SELECT m.zuper_uid FROM jms.zuper_sync_map m
      WHERE m.tenant_id = a.tenant_id AND m.entity = 'customers' AND m.jms_id = a.customer_id LIMIT 1) AS customer_uid,
    a.property_id, a.purchase_date, a.warranty_expiry,
    a.is_active, a.is_deleted, a.created_at, a.updated_at
FROM jms.assets a
LEFT JOIN jms.asset_categories ac ON ac.id = a.category_id;

CREATE OR REPLACE VIEW jms.v_user WITH (security_invoker = true) AS
SELECT
    u.id,
    u.tenant_id,
    (SELECT m.zuper_uid FROM jms.zuper_sync_map m
      WHERE m.tenant_id = u.tenant_id AND m.entity = 'users' AND m.jms_id = u.id LIMIT 1) AS user_uid,
    u.emp_code, u.first_name, u.last_name,
    NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), '') AS full_name,
    u.designation, u.mobile_phone, u.work_phone,
    (SELECT array_agg(t.name ORDER BY t.name) FROM jms.team_members tm JOIN jms.teams t ON t.id = tm.team_id
      WHERE tm.user_id = u.id) AS team_names,
    (SELECT array_agg(m.zuper_uid) FROM jms.team_members tm JOIN jms.zuper_sync_map m
         ON m.tenant_id = tm.tenant_id AND m.entity = 'teams' AND m.jms_id = tm.team_id
      WHERE tm.user_id = u.id) AS team_uids,
    u.is_deleted, u.created_at, u.updated_at
FROM jms.users u;

GRANT SELECT ON jms.v_uid, jms.v_job_summary, jms.v_customer, jms.v_asset, jms.v_user TO portal_app, amc_app;

COMMIT;
