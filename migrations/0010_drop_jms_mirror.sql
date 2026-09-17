-- 0010 — drop jms_mirror, the Zuper snapshot of the early Business OS phases.
--
-- Last written 2026-03-12. Its readers moved to jms (migration 0008 and Business OS commit
-- be97401, 2026-09-17), and nothing outside the schema depends on it (no views, foreign
-- keys, functions or column types). Backup: tgbgaws:~/merge-snapshots/jms_mirror-*.dump.
--
-- BEFORE running this, jms_mirror must be out of PostgREST's schema list. PostgREST fails
-- to load its schema cache when a listed schema is missing, and then answers 503 to every
-- request for every app. The list is set in the database, which overrides the Supabase
-- service's PGRST_DB_SCHEMAS:
--   ALTER ROLE authenticator SET pgrst.db_schemas = '<the list without jms_mirror>';
--   NOTIFY pgrst, 'reload config';
-- The guard below refuses to drop while that setting is missing or still names jms_mirror.
DO $$
DECLARE
  schemas text;
BEGIN
  SELECT substring(cfg FROM '^pgrst\.db_schemas=(.*)$') INTO schemas
    FROM pg_db_role_setting s
    JOIN pg_roles r ON r.oid = s.setrole
    CROSS JOIN LATERAL unnest(s.setconfig) cfg
   WHERE r.rolname = 'authenticator' AND s.setdatabase = 0 AND cfg LIKE 'pgrst.db_schemas=%';
  IF schemas IS NULL OR schemas ~ '(^|,)\s*jms_mirror\s*(,|$)' THEN
    RAISE EXCEPTION 'jms_mirror is still exposed by PostgREST (pgrst.db_schemas = %); remove it first', schemas;
  END IF;
END $$;

DROP SCHEMA IF EXISTS jms_mirror CASCADE;

NOTIFY pgrst, 'reload schema';
