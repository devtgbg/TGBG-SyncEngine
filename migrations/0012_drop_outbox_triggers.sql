-- ── The outbox triggers come off jms ──
-- A change made in Tuper used to reach the sync service through these triggers: they wrote a row into
-- jms.zuper_outbox for anything that did not carry the service's own origin header, and the pusher read it from
-- there. That is why the service needed a key to Tuper's database.
--
-- It does not any more. Tuper now delivers its own changes as webhooks (the same shape Zuper sends), the service
-- receives them and queues the push in its own database, and a write the service itself makes through Tuper's sync
-- endpoints fires no webhook at all — which is the echo guard these triggers used the origin header for.
--
-- Leaving them would be worse than untidy. Nothing reads jms.zuper_outbox now, so the rows would pile up unseen; and
-- the service's own writes no longer carry the origin header, so every record it imported from Zuper would queue
-- itself straight back to Zuper the moment anyone revived that path.
--
-- The table and its rows stay for now: they are the record of what the old path did, and the log dashboard still
-- reads them. Nothing writes them after this.

DROP TRIGGER IF EXISTS queue_zuper_push ON jms.jobs;
DROP TRIGGER IF EXISTS queue_zuper_push ON jms.job_assignments;
DROP TRIGGER IF EXISTS queue_zuper_push ON jms.job_team_assignments;
DROP TRIGGER IF EXISTS queue_zuper_push ON jms.customers;
DROP TRIGGER IF EXISTS queue_zuper_push ON jms.addresses;

-- The functions go with them; nothing else calls them.
DROP FUNCTION IF EXISTS jms.queue_zuper_push();
DROP FUNCTION IF EXISTS jms.queue_zuper_push_job_child();
DROP FUNCTION IF EXISTS jms.queue_zuper_push_address();
DROP FUNCTION IF EXISTS jms.origin_of();
