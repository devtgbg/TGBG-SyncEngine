-- ── Every record written to Tuper ──
-- The mirror of sync.outbox, which holds what goes to Zuper: one row per record this service wrote into Tuper, whatever
-- caused it — a Zuper webhook, a replay, the sweep, an admin re-sync. What the record is (a job's work order number, a
-- customer's name), what happened to it in Tuper (created, updated, deleted — or failed, and why), and what it cost in
-- API calls. Written by src/tuper-writes.ts; read by the dashboard's "To Tuper" page.
--
-- A record's passes (a job's details and activity after the job itself) are one row, and so is a list re-read in one
-- pass (the last three days of punches): the outermost write is the one recorded.

CREATE TABLE IF NOT EXISTS sync.tuper_writes (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- The id its API calls carry (sync.api_calls.write_id), known before any of them is made.
    write_id        UUID NOT NULL UNIQUE,
    tenant_id       UUID NOT NULL,
    at              TIMESTAMPTZ NOT NULL,
    ms              INTEGER NOT NULL,
    -- The sync entity: jobs, customers, notes, timesheets, …
    entity          TEXT NOT NULL,
    zuper_uid       TEXT,
    -- The record's id in Tuper, once known.
    tuper_id        TEXT,
    -- What a person would call it: "job 54626", a customer's name.
    label           TEXT,
    -- created, updated, deleted, skipped, re-synced — or failed.
    action          TEXT NOT NULL,
    ok              BOOLEAN NOT NULL,
    error           TEXT,
    -- A pass over many records says how many: "42 written of 42 listed".
    detail          TEXT,
    origin          TEXT,
    event_id        UUID,
    zuper_calls     INTEGER NOT NULL DEFAULT 0,
    tuper_calls     INTEGER NOT NULL DEFAULT 0,
    failed_calls    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS tuper_writes_recent_idx ON sync.tuper_writes (tenant_id, id DESC);
CREATE INDEX IF NOT EXISTS tuper_writes_failed_idx ON sync.tuper_writes (tenant_id, id DESC) WHERE NOT ok;
CREATE INDEX IF NOT EXISTS tuper_writes_entity_idx ON sync.tuper_writes (tenant_id, entity, id DESC);
CREATE INDEX IF NOT EXISTS tuper_writes_event_idx ON sync.tuper_writes (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tuper_writes_at_idx ON sync.tuper_writes (at);

-- The calls a record's writing made. Nullable and without a default, so adding it rewrites nothing.
ALTER TABLE sync.api_calls ADD COLUMN IF NOT EXISTS write_id UUID;
CREATE INDEX IF NOT EXISTS api_calls_write_idx ON sync.api_calls (write_id) WHERE write_id IS NOT NULL;
