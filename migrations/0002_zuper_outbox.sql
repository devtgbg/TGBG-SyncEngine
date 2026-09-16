-- 0002 — Pushing changes back to Zuper.
--
-- NOT YET APPLIED. Written for review first, because the trigger in it fires on every write to the
-- busiest tables in the database.
--
-- The problem this solves. Four applications write jms.*: Tuper, AMC Engine, the Client Portal and the
-- Staff Portal. Zuper is the system of record, so a change made in any of them has to reach Zuper, or
-- the next webhook will overwrite it with Zuper's older value and the edit silently disappears.
--
-- The hazard it must avoid. Zupersync writes jms.jobs in response to a Zuper webhook. If that write
-- enqueues a push back to Zuper, Zuper fires another webhook, which writes the row again, which
-- enqueues again — an echo loop that never settles and burns the 200–700 req/min API budget.
--
-- The origin marker. Every write carries who made it, and Zupersync's own writes are skipped. PostgREST
-- exposes the request's headers as a GUC, so a client that sets one global header identifies itself for
-- free — no session variable to set per statement, no change at the call site:
--
--     createClient(url, key, { global: { headers: { "x-sync-origin": "zupersync" } } })
--
-- Writes that arrive over a direct Postgres connection (the portals' DATABASE_URL, AMC) have no
-- request.headers, so origin_of() returns 'app' and they are correctly queued.
--
-- Why a trigger rather than application code. The code choke points are real and narrow — the staff
-- portal funnels every Zuper write through packages/zuper/src/jobStatusWrite.ts, AMC through
-- src/clients/zuper-write.js — and intercepting there is cleaner. But both codebases have raw-SQL
-- escape hatches that bypass their own repository layers (client-portal app/lib/customer-mirror.ts,
-- staff-portal lib/notify.ts, AMC's zuperClient.client axios shim). A trigger catches what those miss.
-- Use both: code for the intent, the trigger as the net.
BEGIN;

CREATE TABLE IF NOT EXISTS jms.zuper_outbox (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES core.tenants(id),

    -- What changed, in our terms and in Zuper's.
    entity          TEXT NOT NULL,          -- sync entity name: jobs, customers, …
    jms_id          UUID NOT NULL,
    zuper_uid       TEXT,                   -- NULL until the record has been created in Zuper
    operation       TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),

    -- Only the columns that actually changed. Zuper's update endpoints accept partial bodies, and
    -- sending the whole row would clobber fields another writer changed in between.
    changed         JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Who made the change. 'zupersync' rows are never created (see the trigger) — the column exists so
    -- that if one ever appears, it is visible rather than silently pushed.
    origin          TEXT NOT NULL DEFAULT 'app',

    -- Delivery state.
    queued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at         TIMESTAMPTZ,
    attempts        SMALLINT NOT NULL DEFAULT 0,
    last_error      TEXT,
    -- Backoff: the pusher takes rows where next_try_at <= now(), so a failing row stops hammering
    -- Zuper's rate limit without blocking the ones behind it.
    next_try_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The pusher's only query.
CREATE INDEX IF NOT EXISTS zuper_outbox_due_idx
    ON jms.zuper_outbox (tenant_id, next_try_at)
    WHERE sent_at IS NULL;

-- "Has this record been pushed?" — asked per record, not per table scan.
CREATE INDEX IF NOT EXISTS zuper_outbox_record_idx
    ON jms.zuper_outbox (tenant_id, entity, jms_id, queued_at DESC);

-- Who wrote this row? 'zupersync' when the client announced itself, 'app' otherwise (including every
-- direct Postgres connection, which has no request headers at all).
CREATE OR REPLACE FUNCTION jms.origin_of() RETURNS TEXT
LANGUAGE plpgsql STABLE AS $$
DECLARE hdrs TEXT;
BEGIN
    hdrs := current_setting('request.headers', true);
    IF hdrs IS NULL OR hdrs = '' THEN RETURN 'app'; END IF;
    RETURN COALESCE(NULLIF(hdrs::json ->> 'x-sync-origin', ''), 'app');
EXCEPTION WHEN OTHERS THEN
    -- A malformed header must never fail the write it describes.
    RETURN 'app';
END;
$$;

-- Queue a push for an application-made change. Zuper-originated writes return early.
CREATE OR REPLACE FUNCTION jms.queue_zuper_push() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_origin TEXT := jms.origin_of();
    v_uid    TEXT;
    v_entity TEXT := TG_ARGV[0];
    v_changed JSONB := '{}'::jsonb;
    k TEXT;
BEGIN
    -- The echo-loop guard. Everything else in this function is bookkeeping; this line is the design.
    IF v_origin = 'zupersync' THEN RETURN NULL; END IF;

    SELECT zuper_uid INTO v_uid FROM jms.zuper_sync_map
     WHERE tenant_id = NEW.tenant_id AND entity = v_entity AND jms_id = NEW.id;

    IF TG_OP = 'UPDATE' THEN
        -- Only the columns whose values actually differ.
        FOR k IN SELECT jsonb_object_keys(to_jsonb(NEW)) LOOP
            IF to_jsonb(NEW) -> k IS DISTINCT FROM to_jsonb(OLD) -> k
               AND k NOT IN ('updated_at', 'id', 'tenant_id') THEN
                v_changed := v_changed || jsonb_build_object(k, to_jsonb(NEW) -> k);
            END IF;
        END LOOP;
        IF v_changed = '{}'::jsonb THEN RETURN NULL; END IF;   -- nothing of substance changed
    END IF;

    INSERT INTO jms.zuper_outbox (tenant_id, entity, jms_id, zuper_uid, operation, changed, origin)
    VALUES (
        NEW.tenant_id, v_entity, NEW.id, v_uid,
        CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END,
        v_changed, v_origin
    );
    RETURN NULL;
END;
$$;

-- Triggers are attached per table, deliberately one at a time rather than across jms.* in a loop:
-- each one needs its sync-entity name, and each adds write cost to a hot table. Start with jobs, which
-- is where application-side edits actually happen, and add others once this has been watched in
-- production.
DROP TRIGGER IF EXISTS queue_zuper_push ON jms.jobs;
CREATE TRIGGER queue_zuper_push
    AFTER INSERT OR UPDATE ON jms.jobs
    FOR EACH ROW EXECUTE FUNCTION jms.queue_zuper_push('jobs');

ALTER TABLE jms.zuper_outbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON jms.zuper_outbox;
CREATE POLICY tenant_isolation ON jms.zuper_outbox USING (tenant_id = (auth.jwt() ->> 'tenant_id')::UUID);
DROP POLICY IF EXISTS service_role_bypass ON jms.zuper_outbox;
CREATE POLICY service_role_bypass ON jms.zuper_outbox FOR ALL USING (auth.role() = 'service_role');
GRANT SELECT, INSERT, UPDATE, DELETE ON jms.zuper_outbox TO service_role;

COMMIT;

-- Apply, then verify over PostgREST and re-issue this if the table still 404s — the NOTIFY below does
-- not reliably reach PostgREST from inside the applying session:
NOTIFY pgrst, 'reload schema';
