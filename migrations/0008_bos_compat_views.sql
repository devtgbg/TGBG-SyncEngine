-- 0008 — the Business OS apps' job, customer and technician reads, served from live jms.
--
-- The Business OS apps (OS dashboard, the old JMS pages on main, the OS admin routes and the
-- agents) read through @tgbg/api-client's JMSAdapter, whose shapes are the ones the retired
-- jms_mirror schema had. jms_mirror was last synced on 2026-03-12. These views give the same
-- shapes from jms, which Zupersync keeps live, so jms_mirror can be dropped.
--
-- Read-only. Jobs are written by Tuper and by Zupersync, never through these views.
-- security_invoker: the caller's jms row policies apply (tenant from the JWT; service_role
-- bypasses), exactly as for the base tables.
--
-- Status: jms has Zuper's 13 status types; the Business OS model has six.
--   NEW, SCHEDULED, OTHER                   → assigned / unassigned (by whether anyone is assigned)
--   ON_MY_WAY, STARTED                      → in_progress
--   ON_HOLD, FOLLOW_UP, FOLLOW_UP_SAME_JOB,
--   CANNOT_COMPLETE                         → on_hold
--   COMPLETED, CLOSED                       → completed
--   CANCELED, FAILED                        → cancelled
BEGIN;

CREATE OR REPLACE VIEW jms.bos_jobs WITH (security_invoker = true) AS
SELECT
    j.id,
    j.tenant_id,
    (SELECT m.zuper_uid FROM jms.zuper_sync_map m
      WHERE m.tenant_id = j.tenant_id AND m.entity = 'jobs' AND m.jms_id = j.id LIMIT 1) AS external_id,
    j.work_order_number                  AS job_number,
    NULL::uuid                           AS job_type_id,
    j.title,
    j.description,
    COALESCE(cat.name, '')               AS category,
    CASE
      WHEN st.status_type::text IN ('ON_MY_WAY', 'STARTED') THEN 'in_progress'
      WHEN st.status_type::text IN ('ON_HOLD', 'FOLLOW_UP', 'FOLLOW_UP_SAME_JOB', 'CANNOT_COMPLETE') THEN 'on_hold'
      WHEN st.status_type::text IN ('COMPLETED', 'CLOSED') THEN 'completed'
      WHEN st.status_type::text IN ('CANCELED', 'FAILED') THEN 'cancelled'
      WHEN tech.user_id IS NOT NULL THEN 'assigned'
      ELSE 'unassigned'
    END                                  AS status,
    lower(j.priority::text)              AS priority,
    j.customer_id::text                  AS customer_id,
    tech.user_id::text                   AS technician_id,
    j.asset_id,
    j.contract_id,
    j.scheduled_start_time               AS scheduled_start,
    j.scheduled_end_time                 AS scheduled_end,
    j.actual_start_time                  AS actual_start,
    j.actual_end_time                    AS actual_end,
    cat.estimated_duration_minutes       AS estimated_duration,
    CASE WHEN j.service_address IS NULL THEN NULL ELSE jsonb_build_object(
      'address', concat_ws(', ', j.service_address->>'street', j.service_address->>'landmark'),
      'city', j.service_address->>'city', 'state', j.service_address->>'state',
      'postal_code', j.service_address->>'zip_code', 'country', j.service_address->>'country',
      'latitude', (j.service_address->>'latitude')::numeric, 'longitude', (j.service_address->>'longitude')::numeric)
    END                                  AS location,
    '{}'::jsonb                          AS custom_fields,
    COALESCE(j.job_tags, '{}')           AS tags,
    NULL::text                           AS notes,
    NULL::text                           AS completion_notes,
    NULL::text                           AS signature_url,
    '[]'::jsonb                          AS photos,
    NULLIF(regexp_replace(COALESCE(j.feedback_rating::text, ''), '\D', '', 'g'), '')::int AS rating,
    j.due_date                           AS sla_due_at,
    COALESCE(j.is_delayed, false)        AS sla_breached,
    j.created_by,
    j.created_at,
    j.updated_at
FROM jms.jobs j
LEFT JOIN jms.job_categories cat ON cat.id = j.category_id
LEFT JOIN jms.job_statuses st ON st.id = j.current_status_id
LEFT JOIN LATERAL (
    SELECT ja.user_id FROM jms.job_assignments ja
     WHERE ja.job_id = j.id
     ORDER BY ja.is_primary DESC, ja.created_at
     LIMIT 1
) tech ON true
WHERE NOT j.is_deleted;

CREATE OR REPLACE VIEW jms.bos_customers WITH (security_invoker = true) AS
SELECT
    c.id,
    c.tenant_id,
    (SELECT m.zuper_uid FROM jms.zuper_sync_map m
      WHERE m.tenant_id = c.tenant_id AND m.entity = 'customers' AND m.jms_id = c.id LIMIT 1) AS external_id,
    COALESCE(NULLIF(trim(concat_ws(' ', c.first_name, c.last_name)), ''), c.company_name, c.email, 'Customer') AS name,
    c.email,
    COALESCE(c.contact_no->>'mobile', c.contact_no->>'work', c.contact_no->>'home') AS phone,
    c.company_name                       AS company,
    NULL::jsonb                          AS address,
    '{}'::jsonb                          AS metadata,
    c.created_at,
    c.updated_at
FROM jms.customers c
WHERE NOT c.is_deleted;

CREATE OR REPLACE VIEW jms.bos_technicians WITH (security_invoker = true) AS
SELECT
    u.id,
    u.tenant_id,
    (SELECT m.zuper_uid FROM jms.zuper_sync_map m
      WHERE m.tenant_id = u.tenant_id AND m.entity = 'users' AND m.jms_id = u.id LIMIT 1) AS external_id,
    u.id::text                           AS user_id,
    COALESCE(NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), ''), cu.full_name, cu.email) AS name,
    cu.email,
    COALESCE(u.mobile_phone, u.work_phone, u.home_phone) AS phone,
    COALESCE((SELECT array_agg(s.name ORDER BY s.name) FROM jms.user_skills us JOIN jms.skills s ON s.id = us.skill_id
               WHERE us.user_id = u.id), '{}') AS skills,
    (NOT u.is_deleted AND COALESCE(cu.is_active, true)) AS is_active,
    '{}'::jsonb                          AS metadata,
    u.created_at,
    u.updated_at
FROM jms.users u
LEFT JOIN core.users cu ON cu.id = u.id;

COMMENT ON VIEW jms.bos_jobs IS 'Business OS JMSAdapter shape of jms.jobs (read-only; replaces jms_mirror.jobs).';
COMMENT ON VIEW jms.bos_customers IS 'Business OS JMSAdapter shape of jms.customers (read-only; replaces jms_mirror.customers).';
COMMENT ON VIEW jms.bos_technicians IS 'Business OS JMSAdapter shape of jms.users (read-only; replaces jms_mirror.technicians).';

GRANT SELECT ON jms.bos_jobs, jms.bos_customers, jms.bos_technicians TO authenticated, service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';
