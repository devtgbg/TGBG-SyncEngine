-- 0009 — publish jms.jobs to Supabase Realtime.
--
-- The Business OS apps refresh their job lists when a job changes
-- (@tgbg/ui-shared useRealtimeInvalidation). That hook listened on jms_mirror.jobs, which
-- was in the supabase_realtime publication; it now listens on jms.jobs. Realtime applies the
-- subscriber's row policies, so each viewer only hears about jobs they can read.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname = 'supabase_realtime' AND schemaname = 'jms' AND tablename = 'jobs') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE jms.jobs;
  END IF;
END $$;
