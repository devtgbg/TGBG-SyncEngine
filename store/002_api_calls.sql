-- ── Every call to Zuper's API and to Tuper's ──
-- The delivery log (webhook_events) says what arrived. This says what the service did about it: each request it made,
-- to which system, what came back and how long it took, and which delivery, sweep, replay or push caused it. Written by
-- src/api-log.ts in batches, off the request path. Read by the dashboard.
--
-- Bodies are the bulk, so they are cut (API_LOG_BODY_MAX) and dropped after API_LOG_BODY_HOURS; the rows go after
-- API_LOG_DAYS. Headers are never kept: both API keys travel in them.

CREATE TABLE IF NOT EXISTS sync.api_calls (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       UUID NOT NULL,
    at              TIMESTAMPTZ NOT NULL,
    system          TEXT NOT NULL CHECK (system IN ('zuper', 'tuper')),
    method          TEXT NOT NULL,
    path            TEXT NOT NULL,
    -- What the call does where the path does not say: Tuper takes every write at one endpoint ("update jobs").
    action          TEXT,
    -- Null when nothing answered (a timeout, a refused connection).
    status          SMALLINT,
    ok              BOOLEAN NOT NULL,
    ms              INTEGER NOT NULL,
    attempt         SMALLINT NOT NULL DEFAULT 1,
    error           TEXT,
    -- webhook, tuper-webhook, replay, sweep, push, admin; null for anything else (startup, a CLI).
    origin          TEXT,
    -- The delivery that caused the call. No foreign key: a call is recorded even when its delivery could not be.
    event_id        UUID,
    request         JSONB,
    response        JSONB,
    request_bytes   INTEGER,
    response_bytes  INTEGER
);

CREATE INDEX IF NOT EXISTS api_calls_recent_idx ON sync.api_calls (tenant_id, id DESC);
CREATE INDEX IF NOT EXISTS api_calls_system_idx ON sync.api_calls (tenant_id, system, id DESC);
CREATE INDEX IF NOT EXISTS api_calls_failed_idx ON sync.api_calls (tenant_id, id DESC) WHERE NOT ok;
CREATE INDEX IF NOT EXISTS api_calls_event_idx ON sync.api_calls (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS api_calls_at_idx ON sync.api_calls (at);
-- Only rows still holding a body, so the purge that empties them never re-reads the ones it already emptied.
CREATE INDEX IF NOT EXISTS api_calls_bodies_idx ON sync.api_calls (at) WHERE request IS NOT NULL OR response IS NOT NULL;

-- Who a user uid is. An assignment delivery names people by uid only, and the dashboard names them from the
-- deliveries those people triggered themselves — without reading Tuper's user table.
CREATE INDEX IF NOT EXISTS webhook_events_actor_idx ON sync.webhook_events ((body -> 'triggered_by' ->> 'user_uid'));
