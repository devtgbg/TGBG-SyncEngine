-- 00107 — Inbound Zuper webhook deliveries.
--
-- This is an INBOX, not a mirror: it holds the raw delivery (headers + body) exactly as Zuper sent it, never a copy
-- of the records themselves. The records live where they always have — jms.jobs, jms.customers and the rest — which
-- every application reads. Zupersync writes those directly.
--
-- Why persist deliveries at all:
--   • store-then-ack — the 200 must never wait on an upsert, so the delivery is saved first and processed after;
--   • replay — a delivery whose processing failed can be run again from the stored body;
--   • forensics — a delivery whose secret header didn't match is kept but never processed, so an attempted forgery
--     leaves a trace instead of vanishing.
--
-- Zuper authenticates with ONE custom header chosen when the webhook is created (its form fields are literally
-- `key` and `value`); there is no Zuper-generated secret. `verified` records whether that header matched.
BEGIN;

CREATE TABLE IF NOT EXISTS jms.zuper_webhook_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES core.tenants(id),
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Authentication outcome. FALSE with reason 'no_secret_configured' means the service had no secret to check
    -- against — captured, but not to be trusted.
    verified            BOOLEAN NOT NULL DEFAULT FALSE,
    verify_reason       TEXT,

    -- What Zuper said changed. Nullable on purpose: the payload shape is undocumented and varies by module, and a
    -- delivery we can't parse is still worth keeping.
    module              TEXT,
    event               TEXT,
    zuper_uid           TEXT,
    work_order_number   TEXT,

    headers             JSONB NOT NULL DEFAULT '{}'::jsonb,
    body                JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Processing outcome. processed_at set with a NULL error = applied to the live tables.
    processed_at        TIMESTAMPTZ,
    process_error       TEXT,
    sync_entity         TEXT,          -- which sync entity handled it (jobs, customers, …)
    attempts            SMALLINT NOT NULL DEFAULT 0,

    -- The house pattern (supabase/CLAUDE.md) requires both on every table. `received_at` is kept
    -- separate on purpose: it is when the delivery arrived, which is a domain fact we may later want
    -- to take from Zuper's own timestamp, whereas created_at is simply when this row was written.
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unprocessed first: the replay sweep and the "what's stuck?" view both read this way.
CREATE INDEX IF NOT EXISTS zuper_webhook_events_unprocessed_idx
    ON jms.zuper_webhook_events (tenant_id, received_at DESC)
    WHERE processed_at IS NULL;

-- The log UI pages by arrival.
CREATE INDEX IF NOT EXISTS zuper_webhook_events_recent_idx
    ON jms.zuper_webhook_events (tenant_id, received_at DESC);

-- "What happened to this job?" — answered without scanning.
CREATE INDEX IF NOT EXISTS zuper_webhook_events_uid_idx
    ON jms.zuper_webhook_events (tenant_id, zuper_uid, received_at DESC)
    WHERE zuper_uid IS NOT NULL;

ALTER TABLE jms.zuper_webhook_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON jms.zuper_webhook_events;
CREATE POLICY tenant_isolation ON jms.zuper_webhook_events USING (tenant_id = (auth.jwt() ->> 'tenant_id')::UUID);
DROP POLICY IF EXISTS service_role_bypass ON jms.zuper_webhook_events;
CREATE POLICY service_role_bypass ON jms.zuper_webhook_events FOR ALL USING (auth.role() = 'service_role');
GRANT SELECT, INSERT, UPDATE, DELETE ON jms.zuper_webhook_events TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
