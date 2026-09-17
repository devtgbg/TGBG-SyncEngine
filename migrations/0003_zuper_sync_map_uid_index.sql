-- 0003 — Look up sync-map rows by Zuper id alone.
--
-- Zupersync pre-seeds a record's id maps with one query per chunk:
--   WHERE tenant_id = … AND zuper_uid IN (…)
-- without the entity, because one record names ids of many kinds. The existing
-- indexes lead with (tenant_id, entity, …), so that query was a parallel
-- sequential scan of all 513k rows — about 90 ms each, several per job.
--
-- CONCURRENTLY, so Tuper's writes to the map's readers are never blocked. It cannot
-- run inside a transaction block; apply this file on its own.
CREATE INDEX CONCURRENTLY IF NOT EXISTS zuper_sync_map_tenant_uid_idx
    ON jms.zuper_sync_map (tenant_id, zuper_uid);
