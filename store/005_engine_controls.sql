-- ── The engine's controls, and what it reports back ──
-- The dashboard is where the sync is run from: which way it syncs, whether Tuper's changes are sent to Zuper, the
-- safety nets, the call log. Until now every one of those was an environment variable read once at boot, so changing
-- one meant editing Coolify and redeploying. Now:
--
--   settings          one document per tenant, written by the dashboard, read by the service every few seconds and
--                     applied without a restart. `version` goes up by one on every save. The environment still gives
--                     the first document's values, so a fresh store starts as the deployment was configured.
--   settings_history  every save: who, when, what it was before and after.
--   engine            what the running service says about itself: its heartbeat, the settings version it has
--                     applied, which timers are running, the last replay, sweep and push. The dashboard reads it to
--                     say "applied" rather than assume it.
--   commands          one-off actions asked for on the dashboard (replay the failed deliveries, check the webhook
--                     registrations, …), picked up by the service, with their outcome.
--   snapshots         the latest of something the service measured for the dashboard, by kind: the event catalogue
--                     it routes by, and the webhooks registered in Zuper and in Tuper. The dashboard holds no API key,
--                     so it reads them from here.

CREATE TABLE IF NOT EXISTS sync.settings (
    tenant_id   UUID PRIMARY KEY,
    data        JSONB NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  TEXT
);

CREATE TABLE IF NOT EXISTS sync.settings_history (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   UUID NOT NULL,
    version     INTEGER NOT NULL,
    before      JSONB,
    after       JSONB NOT NULL,
    at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    by          TEXT
);
CREATE INDEX IF NOT EXISTS settings_history_recent_idx ON sync.settings_history (tenant_id, id DESC);

CREATE TABLE IF NOT EXISTS sync.engine (
    tenant_id        UUID PRIMARY KEY,
    started_at       TIMESTAMPTZ NOT NULL,
    heartbeat_at     TIMESTAMPTZ NOT NULL,
    commit           TEXT,
    applied_version  INTEGER,
    applied_at       TIMESTAMPTZ,
    applied          JSONB,
    state            JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS sync.commands (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     UUID NOT NULL,
    command       TEXT NOT NULL,
    args          JSONB NOT NULL DEFAULT '{}'::jsonb,
    requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    requested_by  TEXT,
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ,
    ok            BOOLEAN,
    result        TEXT
);
CREATE INDEX IF NOT EXISTS commands_pending_idx ON sync.commands (tenant_id, id) WHERE started_at IS NULL;
CREATE INDEX IF NOT EXISTS commands_recent_idx ON sync.commands (tenant_id, id DESC);

CREATE TABLE IF NOT EXISTS sync.snapshots (
    tenant_id  UUID NOT NULL,
    kind       TEXT NOT NULL,
    data       JSONB NOT NULL,
    taken_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, kind)
);
