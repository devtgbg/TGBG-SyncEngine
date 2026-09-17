-- 0007 — keep the Zuper uid beside each jms reference in portal.*.
--
-- The first dry-run copy found references jms cannot resolve: two end-to-end test customers
-- in the production portal database (uids beginning 'e2e-'), used by portal users, issued
-- reports and review jobs, and one asset Zuper has since deleted (its detail answers 404).
-- Rather than drop those rows, the jms id is left empty and the uid the reference was made
-- with is kept, so nothing is lost and the rows stay traceable.
BEGIN;

ALTER TABLE portal.client_users ADD COLUMN IF NOT EXISTS zuper_customer_uid text;
ALTER TABLE portal.issuances ADD COLUMN IF NOT EXISTS zuper_customer_uid text;
ALTER TABLE portal.issuances ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE portal.jobs ADD COLUMN IF NOT EXISTS zuper_customer_uid text;
ALTER TABLE portal.jobs ADD COLUMN IF NOT EXISTS zuper_asset_uid text;

COMMENT ON COLUMN portal.client_users.zuper_customer_uid IS 'the Zuper customer the account was made for; customer_id is its jms id when jms has it';
COMMENT ON COLUMN portal.issuances.zuper_customer_uid IS 'the Zuper customer the report was issued to; customer_id is its jms id when jms has it';
COMMENT ON COLUMN portal.jobs.zuper_customer_uid IS 'Zuper customer uid; customer_id is its jms id when jms has it';
COMMENT ON COLUMN portal.jobs.zuper_asset_uid IS 'Zuper asset uid; asset_id is its jms id when jms has it';

COMMIT;
