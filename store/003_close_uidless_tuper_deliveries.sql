-- ── Tuper deliveries that could never be queued ──
-- Before this version, a verified Tuper delivery whose body named no record was left open: no outcome, no error, and
-- nothing replays a Tuper delivery, so it read as "waiting" for ever. 29 did on 2026-09-17, every job.new, job.update,
-- job.delete and customer.* delivery, because Tuper's webhooks were registered under modules it does not know (JOBS,
-- CUSTOMERS) and it leaves the record's uid out of those bodies. The receiver now records why; this closes the old ones
-- the same way.

UPDATE sync.webhook_events
   SET processed_at = now(),
       process_error = 'Tuper sent ' || coalesce(event, 'a delivery') || ' without ' ||
         CASE WHEN event LIKE 'customer.%' THEN 'customer_uid' ELSE 'job_uid' END ||
         ', so there is no record to queue. Tuper leaves it out when the webhook''s module is not one it knows: it must be ' ||
         CASE WHEN event LIKE 'customer.%' THEN 'CUSTOMER' ELSE 'JOB' END || '.'
 WHERE source = 'tuper' AND verified AND processed_at IS NULL AND process_error IS NULL AND zuper_uid IS NULL;
