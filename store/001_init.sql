-- ── Zupersync's own database ──
-- Until now this service kept its working state inside Tuper's database: the deliveries it received, the queue of
-- changes waiting to go to Zuper, its configuration and its run history. That was never Tuper's data, and holding it
-- there is why the service needed a database key at all.
--
-- Here it keeps its own. Four tables in one schema, no foreign key into Tuper — records are named by uid — so the
-- service keeps logging and queueing even while Tuper is unreachable, and Tuper owes it nothing.
--
-- The columns are the ones the tables had in jms, so the rows can be copied across and the code that reads them does
-- not change. What is new is `source` on a delivery: this service now hears from both systems.

CREATE SCHEMA IF NOT EXISTS sync;

-- Every delivery received, from either side, exactly as it arrived.
CREATE TABLE IF NOT EXISTS sync.webhook_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL,
    -- Zuper's tell us what changed there. Tuper's replace the database triggers that used to queue a push, so a
    -- change made in Tuper reaches Zuper the same way.
    source              TEXT NOT NULL DEFAULT 'zuper' CHECK (source IN ('zuper', 'tuper')),
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    verified            BOOLEAN NOT NULL DEFAULT false,
    verify_reason       TEXT,
    module              TEXT,
    event               TEXT,
    zuper_uid           TEXT,
    work_order_number   TEXT,
    headers             JSONB NOT NULL DEFAULT '{}'::jsonb,
    body                JSONB NOT NULL DEFAULT '{}'::jsonb,
    processed_at        TIMESTAMPTZ,
    process_error       TEXT,
    sync_entity         TEXT,
    attempts            SMALLINT NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_events_recent_idx ON sync.webhook_events (tenant_id, received_at DESC);
CREATE INDEX IF NOT EXISTS webhook_events_uid_idx ON sync.webhook_events (tenant_id, zuper_uid, received_at DESC) WHERE zuper_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS webhook_events_unprocessed_idx ON sync.webhook_events (tenant_id, received_at DESC) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS webhook_events_source_idx ON sync.webhook_events (tenant_id, source, received_at DESC);

-- Changes made in Tuper that are on their way to Zuper. Filled from Tuper's webhooks now, not from database triggers.
CREATE TABLE IF NOT EXISTS sync.outbox (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL,
    entity      TEXT NOT NULL,
    jms_id      UUID NOT NULL,
    zuper_uid   TEXT,
    operation   TEXT NOT NULL,
    changed     JSONB NOT NULL DEFAULT '{}'::jsonb,
    previous    JSONB NOT NULL DEFAULT '{}'::jsonb,
    origin      TEXT NOT NULL DEFAULT 'app',
    actor_id    UUID,
    status      TEXT NOT NULL DEFAULT 'queued',
    planned     JSONB,
    response    JSONB,
    queued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at     TIMESTAMPTZ,
    attempts    SMALLINT NOT NULL DEFAULT 0,
    last_error  TEXT,
    next_try_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The delivery that caused this, so a queue entry can be traced back to what Tuper said.
    event_id    UUID REFERENCES sync.webhook_events(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS outbox_due_idx ON sync.outbox (tenant_id, status, next_try_at) WHERE status IN ('queued', 'planned', 'failed');
CREATE INDEX IF NOT EXISTS outbox_record_idx ON sync.outbox (tenant_id, entity, jms_id, queued_at DESC);

-- The service's own settings and where it has got to. api_key is Zuper's key: never selected with *, never logged.
CREATE TABLE IF NOT EXISTS sync.config (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL UNIQUE,
    api_key         TEXT,
    api_base        TEXT,
    company         TEXT,
    enabled         BOOLEAN NOT NULL DEFAULT true,
    interval_hours  INTEGER NOT NULL DEFAULT 24,
    last_run_at     TIMESTAMPTZ,
    next_run_at     TIMESTAMPTZ,
    is_syncing      BOOLEAN NOT NULL DEFAULT false,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per import or sweep run, for the log.
CREATE TABLE IF NOT EXISTS sync.runs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL,
    entity      TEXT,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    fetched     INTEGER NOT NULL DEFAULT 0,
    upserted    INTEGER NOT NULL DEFAULT 0,
    failed      INTEGER NOT NULL DEFAULT 0,
    status      TEXT,
    -- Free text, as it always was: what went wrong, or what was skipped and why.
    detail      TEXT
);
CREATE INDEX IF NOT EXISTS runs_recent_idx ON sync.runs (tenant_id, started_at DESC);

CREATE OR REPLACE FUNCTION sync.touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_updated_at ON sync.webhook_events;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON sync.webhook_events
    FOR EACH ROW EXECUTE FUNCTION sync.touch_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON sync.outbox;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON sync.outbox
    FOR EACH ROW EXECUTE FUNCTION sync.touch_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON sync.config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON sync.config
    FOR EACH ROW EXECUTE FUNCTION sync.touch_updated_at();
