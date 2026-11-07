-- The nightly reconciliation's answer: what Zuper has, what Tuper has, and what differs.
--
-- The 30-minute sweep asks "what changed in the last 3 hours that we missed?". This asks "does everything
-- match?" — a different question, and the only one that can see a deletion, a merge, or an entity nothing
-- sweeps. Its answer is kept here so a week of them can be read together, which is how a normal noise floor
-- is told from a real divergence.
--
-- One row per kind per run. `sample` holds a bounded list of uids per bucket (not all of them: a bad night
-- could list tens of thousands), enough to chase a cause by hand.

CREATE TABLE IF NOT EXISTS sync.reconciliations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  run_id        uuid NOT NULL,                 -- one id for every kind of the same night
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz,
  kind          text NOT NULL,
  in_zuper      integer NOT NULL DEFAULT 0,
  in_tuper      integer NOT NULL DEFAULT 0,
  excluded      integer NOT NULL DEFAULT 0,
  missing       integer NOT NULL DEFAULT 0,    -- Zuper lists it, Tuper never wrote it
  behind        integer NOT NULL DEFAULT 0,    -- Zuper changed it after Tuper last wrote it
  only_deleted  integer NOT NULL DEFAULT 0,    -- Tuper holds it flagged deleted, Zuper does not list it
  only_live     integer NOT NULL DEFAULT 0,    -- Tuper holds it LIVE, Zuper does not list it (deletion or merge)
  sample        jsonb NOT NULL DEFAULT '{}'::jsonb,
  error         text,
  ms            integer
);

CREATE INDEX IF NOT EXISTS reconciliations_run_idx  ON sync.reconciliations (tenant_id, run_id);
CREATE INDEX IF NOT EXISTS reconciliations_when_idx ON sync.reconciliations (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS reconciliations_kind_idx ON sync.reconciliations (tenant_id, kind, started_at DESC);
