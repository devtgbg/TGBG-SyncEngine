-- 0002 — Pushing changes back to Zuper.
--
-- The problem this solves. Applications other than Zupersync write jms.* (Tuper today; the portals and
-- AMC once they move onto this database). Zuper is the system of record, so a change made in any of
-- them has to reach Zuper, or the next webhook overwrites it with Zuper's older value and the edit
-- silently disappears.
--
-- The hazard it must avoid. Zupersync writes jms.jobs in response to a Zuper webhook. If that write
-- enqueued a push back to Zuper, Zuper would fire another webhook, which writes the row again, which
-- enqueues again — an echo loop that never settles and burns the 150 req/min API budget.
--
-- The origin marker. PostgREST exposes each request's headers to SQL, and Zupersync's client sends
-- `x-sync-origin: zupersync` on every request (src/supabase.ts), so its writes are skipped. Writes over
-- a direct Postgres connection have no request headers, so they count as 'app' and are queued.
--
-- Safety for the applications. The trigger fires inside Tuper's own writes, as Tuper's own role. So:
--   * SECURITY DEFINER — the writer needs no rights on the outbox or the sync map;
--   * any failure is caught and reported as a WARNING — queueing a push must never fail the save it
--     describes. A missed push is recovered by hand; a job that cannot be saved is an outage.
--
-- Nothing is sent from here. The pusher (src/pusher.ts) reads this table. In `dry-run` it only records
-- the requests it WOULD make (`planned`), which is how this is watched before anything reaches Zuper.
BEGIN;

CREATE TABLE IF NOT EXISTS jms.zuper_outbox (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES core.tenants(id),

    -- What changed, in our terms and in Zuper's.
    entity          TEXT NOT NULL,          -- sync entity name: jobs, …
    jms_id          UUID NOT NULL,
    zuper_uid       TEXT,                   -- NULL when the record does not exist in Zuper yet
    operation       TEXT NOT NULL CHECK (operation IN ('create', 'update')),

    -- Only the columns whose values changed, with their new values. Zuper's updates are partial, and
    -- sending the whole row would clobber fields someone changed in Zuper in between.
    changed         JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- The same columns' previous values, for the log and for a human deciding whether to replay.
    previous        JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Who made the change: the request's origin marker, and the signed-in user when there is one.
    origin          TEXT NOT NULL DEFAULT 'app',
    actor_id        UUID,

    -- queued → planned (dry run) → sent | failed | skipped | superseded
    status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'planned', 'sent', 'failed', 'skipped', 'superseded')),
    planned         JSONB,                  -- the Zuper request(s) the pusher built
    response        JSONB,                  -- what Zuper answered (status code, uid, message)
    queued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at         TIMESTAMPTZ,
    attempts        SMALLINT NOT NULL DEFAULT 0,
    last_error      TEXT,
    -- Backoff: the pusher takes rows where next_try_at <= now(), so a failing row stops hammering
    -- Zuper without blocking the ones behind it.
    next_try_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The pusher's only query.
CREATE INDEX IF NOT EXISTS zuper_outbox_due_idx
    ON jms.zuper_outbox (tenant_id, next_try_at)
    WHERE status IN ('queued', 'planned', 'failed');

-- "What is pending for this record?" — the pusher merges a record's rows before sending.
CREATE INDEX IF NOT EXISTS zuper_outbox_record_idx
    ON jms.zuper_outbox (tenant_id, entity, jms_id, queued_at);

-- Who wrote this row? The x-sync-origin header when the client sent one, 'app' otherwise (including
-- every direct Postgres connection, which has no request headers at all).
CREATE OR REPLACE FUNCTION jms.origin_of() RETURNS TEXT
LANGUAGE plpgsql STABLE AS $$
DECLARE hdrs TEXT;
BEGIN
    hdrs := current_setting('request.headers', true);
    IF hdrs IS NULL OR hdrs = '' THEN RETURN 'app'; END IF;
    RETURN COALESCE(NULLIF(hdrs::json ->> 'x-sync-origin', ''), 'app');
EXCEPTION WHEN OTHERS THEN
    RETURN 'app';   -- a malformed header must never fail the write it describes
END;
$$;
GRANT EXECUTE ON FUNCTION jms.origin_of() TO anon, authenticated, service_role;

-- Queue a push for an application-made change. Zupersync's own writes return early.
CREATE OR REPLACE FUNCTION jms.queue_zuper_push() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = jms, pg_temp AS $$
DECLARE
    v_origin   TEXT := jms.origin_of();
    v_entity   TEXT := TG_ARGV[0];
    v_uid      TEXT;
    v_actor    UUID;
    v_new      JSONB := to_jsonb(NEW);
    v_old      JSONB;
    v_changed  JSONB := '{}'::jsonb;
    v_previous JSONB := '{}'::jsonb;
    k          TEXT;
BEGIN
    -- The echo-loop guard. Everything else in this function is bookkeeping; this line is the design.
    IF v_origin = 'zupersync' THEN RETURN NULL; END IF;

    BEGIN
        IF TG_OP = 'UPDATE' THEN
            v_old := to_jsonb(OLD);
            FOR k IN SELECT jsonb_object_keys(v_new) LOOP
                -- Bookkeeping and values other triggers derive are not changes anyone made.
                CONTINUE WHEN k IN ('id', 'tenant_id', 'updated_at', 'created_at', 'current_status_color', 'is_recurring');
                IF v_new -> k IS DISTINCT FROM v_old -> k THEN
                    v_changed  := v_changed  || jsonb_build_object(k, v_new -> k);
                    v_previous := v_previous || jsonb_build_object(k, v_old -> k);
                END IF;
            END LOOP;
            IF v_changed = '{}'::jsonb THEN RETURN NULL; END IF;
        ELSE
            v_changed := v_new - 'id' - 'tenant_id' - 'updated_at' - 'current_status_color';
        END IF;

        SELECT zuper_uid INTO v_uid FROM jms.zuper_sync_map
         WHERE tenant_id = NEW.tenant_id AND entity = v_entity AND jms_id = NEW.id
         LIMIT 1;

        BEGIN
            v_actor := NULLIF(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid;
        EXCEPTION WHEN OTHERS THEN
            v_actor := NULL;   -- service-role requests and direct connections carry no user
        END;

        INSERT INTO jms.zuper_outbox (tenant_id, entity, jms_id, zuper_uid, operation, changed, previous, origin, actor_id)
        VALUES (NEW.tenant_id, v_entity, NEW.id, v_uid,
                CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END,
                v_changed, v_previous, v_origin, v_actor);
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'zuper outbox: could not queue % % %: %', v_entity, TG_OP, NEW.id, SQLERRM;
    END;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION jms.queue_zuper_push() FROM PUBLIC;

-- One table at a time: each trigger needs its sync-entity name and adds write cost to a hot table.
-- Jobs first, which is where application-side edits happen.
DROP TRIGGER IF EXISTS queue_zuper_push ON jms.jobs;
CREATE TRIGGER queue_zuper_push
    AFTER INSERT OR UPDATE ON jms.jobs
    FOR EACH ROW EXECUTE FUNCTION jms.queue_zuper_push('jobs');

-- A job's people and teams live in their own tables, so assigning someone in Tuper never touches the
-- jms.jobs row. These queue a marker on the JOB instead; the pusher reads the job's current assignees
-- and teams and works out the difference from what Zuper holds, so it does not matter how many rows
-- one action inserted or deleted.
CREATE OR REPLACE FUNCTION jms.queue_zuper_push_job_child() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = jms, pg_temp AS $$
DECLARE
    v_origin TEXT := jms.origin_of();
    v_row    RECORD;
    v_uid    TEXT;
BEGIN
    IF v_origin = 'zupersync' THEN RETURN NULL; END IF;
    BEGIN
        IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;
        SELECT zuper_uid INTO v_uid FROM jms.zuper_sync_map
         WHERE tenant_id = v_row.tenant_id AND entity = 'jobs' AND jms_id = v_row.job_id
         LIMIT 1;
        INSERT INTO jms.zuper_outbox (tenant_id, entity, jms_id, zuper_uid, operation, changed, origin)
        VALUES (v_row.tenant_id, 'jobs', v_row.job_id, v_uid, 'update',
                jsonb_build_object(TG_ARGV[0], true), v_origin);
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'zuper outbox: could not queue % on % %: %', TG_ARGV[0], TG_TABLE_NAME, TG_OP, SQLERRM;
    END;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION jms.queue_zuper_push_job_child() FROM PUBLIC;

DROP TRIGGER IF EXISTS queue_zuper_push ON jms.job_assignments;
CREATE TRIGGER queue_zuper_push
    AFTER INSERT OR UPDATE OR DELETE ON jms.job_assignments
    FOR EACH ROW EXECUTE FUNCTION jms.queue_zuper_push_job_child('_assignees');

DROP TRIGGER IF EXISTS queue_zuper_push ON jms.job_team_assignments;
CREATE TRIGGER queue_zuper_push
    AFTER INSERT OR UPDATE OR DELETE ON jms.job_team_assignments
    FOR EACH ROW EXECUTE FUNCTION jms.queue_zuper_push_job_child('_teams');

ALTER TABLE jms.zuper_outbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_all ON jms.zuper_outbox;
CREATE POLICY service_role_all ON jms.zuper_outbox FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON jms.zuper_outbox TO service_role;

COMMIT;

-- Re-issue this separately if the table still 404s over PostgREST — it does not reliably reach
-- PostgREST from inside the applying session:
NOTIFY pgrst, 'reload schema';
