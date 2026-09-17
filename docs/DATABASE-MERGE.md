# Merging the Client Portal, Staff Portal and AMC Engine databases into Supabase

**Status:** plan, 2026-09-17. Nothing below has been created or copied yet unless marked **done**.
**Audience:** the owner, and the Claude Code sessions that will change each application.

## Goal

One database — the self-hosted Supabase Postgres on `tgbgaws` — serving every application:

- **`jms.*`** holds everything Zuper knows about (jobs, customers, organizations, assets,
  users, statuses, checklists, notes, quotes, invoices, contracts, requests, products,
  time logs, timesheets, time off). **Zupersync is its only writer**; it is kept live from
  Zuper's webhooks plus a 30-minute sweep.
- **`client.*`**, **`staff.*`** and **`amc.*`** hold only what each application creates
  itself. Nothing that exists in Zuper is copied into them.
- Every place an application calls Zuper's API **to read**, it reads `jms.*` instead.
  **Writes to Zuper stay as they are** for now (status pushes, bookings, quote decisions,
  new requests): the application writes to Zuper, Zuper fires its webhook, and Zupersync
  brings the change into `jms.*` within seconds. Pushing Tuper edits back to Zuper is built
  but switched off (`PUSH_MODE=off`) and is out of scope here.

## What is in production today

All three applications run on `tgbgaws` under Coolify.

| Application | Coolify app | Database | Size | Own Zuper feed |
|---|---|---|---|---|
| Client Portal (`customer.golfbuggyguy.com`) | `d474sjhh2no9xu6h93gwotbr` | Postgres 17 `gbg`, container `g13ju6epg6wnum4nabolt8se` (Coolify DB "gbg-postgres", public host `paneldb.golfbuggyguy.com`) | 637 MB | 68 Zuper webhooks + nightly full copy script + live API reads |
| Staff Portal (`staff.golfbuggyguy.com`) | `vvoodx0d7ib60o0qk7iuexub` | **the same** `gbg` database, same `public` schema | — | category ingest, customer sync, live API reads and writes |
| AMC Engine (`amc.golfbuggyguy.com`) | `sti1wkudfqfsvk2s98sqn9df` | SQLite `/data/amc/reminders.db` on the host, mounted at `/app/data` (better-sqlite3, WAL) | 25 MB | its own webhook mirror, a 30-minute pull, and live API reads and writes |
| Supabase (target) | service `x123f7phha4w5nas4dtq2k50` | Postgres 15, container `supabase-db-x123f7phha4w5nas4dtq2k50` | `jms` 1.37 GB | — |

Snapshots taken for this plan (structure only is kept in the repo; data stays on the server):

- `gbg` structure: `pg_dump --schema-only` — 29 tables, 16 enum types, 8 protection triggers,
  Drizzle migration journal in `drizzle.__drizzle_migrations`.
- AMC: consistent online backup (`.backup`) at `tgbgaws:~/merge-snapshots/amc-reminders-20260917.db`
  (mode 600, integrity ok) — 26 tables, 1 view, 74 indexes, no triggers.

### Row counts (2026-09-17)

**`gbg`** — app data is small; the bulk is the Zuper mirror.

| Table | Rows | Table | Rows |
|---|---:|---|---:|
| zuper_records | 46,993 | review_items | 254 |
| customers | 4,706 | job_status_steps | 95 |
| assets | 2,253 | engine_snapshots | 50 |
| zuper_webhook_events | 7,188 | job_status_step_revisions | 37 |
| governed_rows | 1,244 | governed_drt_rules | 28 |
| audit_log | 728 | jobs | 23 |
| notifications | 16 | report_versions | 14 |
| issuances | 13 | customer_decisions | 10 |
| client_users | 8 | quotations | 7 |
| job_step_attachments | 7 | portal_enrollment_pins | 6 |
| staff_users | 3 | governed_seed_state | 2 |
| portal_password_reset_tokens | 1 | portal_password_setup_tokens | 1 |
| applicability_determinations, legacy_reports, rectifications, staff_password_reset_tokens, zuper_sync_runs | 0 | | |

**AMC** — `whatsapp_messages` 5,040 · `reminders` 1,713 · `zuper_job_assignees` 1,541 ·
`zuper_jobs` 1,486 · `reminder_messages` 1,372 · `scheduled_job_reminders` 1,037 ·
`booking_activity` 567 · `audit_bookings` 246 · `reminder_campaigns` 130 · `audit_reminders` 97 ·
`location_settings` 65 · `audit_auth` 62 · `technician_day_offs` 33 · `settings` 22 ·
`excluded_customers` 21 · `user_locations` 20 · `audit_settings` 13 · `users` 8 ·
`password_resets` 6 · `locations` 5 · `booking_holds` 4 · `audit_dayoffs` 2 ·
`audit_locations`, `audit_users`, `slot_reservations`, `zuper_webhook_events` 0.

## Target layout

### What is retired, and what replaces it

| Today | Replaced by |
|---|---|
| `gbg.customers` (Zuper customers) | `jms.customers` (+ `jms.addresses`, `jms.customer_contacts`) |
| `gbg.assets` | `jms.assets` |
| `gbg.zuper_records` (jobs, requests, estimates, invoices, contracts, properties as JSON) | `jms.jobs`, `jms.requests`, `jms.quotes`, `jms.invoices`, `jms.service_contracts`, `jms.properties` |
| `gbg.zuper_webhook_events`, `gbg.zuper_sync_runs` | Zupersync's `jms.zuper_webhook_events` |
| `amc.zuper_jobs`, `amc.zuper_job_assignees` | `jms.jobs`, `jms.job_assignments` |
| `amc.zuper_webhook_events` (empty) | Zupersync |
| AMC `settings` caches `zuper_users`, `zuper_categories` | `jms.users`, `jms.job_categories` |
| Supabase `jms_mirror.*` (stale mirror from an earlier design) | `jms.*` — drop once nothing reads it |

These tables are **not copied**.

### `client.*` — the customer portal's own data

| New table | From `gbg` | Notes |
|---|---|---|
| `client.users` | `client_users` | `customer_id` → **`jms.customers.id`** (see *Re-pointing*); keep `password_updated_at` bigint (session version) |
| `client.enrollment_pins` | `portal_enrollment_pins` | `customer_uid` kept; `tuper:<id>` values become the jms id |
| `client.password_reset_tokens` | `portal_password_reset_tokens` | still used by three routes |
| `client.password_setup_tokens` | `portal_password_setup_tokens` | legacy flow; copied, candidate for removal |
| `client.legacy_reports` | `legacy_reports` | empty; table created, no data |

### `staff.*` — the review pipeline and everything the staff portal creates

Both portals use these tables; the staff portal creates the rows, so the staff schema owns
them and the client portal gets narrow grants.

| New table | From `gbg` | Client portal access |
|---|---|---|
| `staff.users`, `staff.password_reset_tokens` | `staff_users`, `staff_password_reset_tokens` | none |
| `staff.jobs` | `jobs` | read. `customer_id`/`asset_id` → jms ids; **add `jms_job_id`** from `zuper_job_uid` |
| `staff.engine_snapshots`, `staff.review_items`, `staff.rectifications` | same names | read |
| `staff.report_versions` | `report_versions` | read |
| `staff.issuances` | `issuances` | read. `customer_id` → jms id |
| `staff.customer_decisions` | `customer_decisions` | read + insert |
| `staff.quotations` | `quotations` | read + update status |
| `staff.job_status_steps`, `staff.job_status_step_revisions`, `staff.job_step_attachments` | same names | read |
| `staff.applicability_determinations`, `staff.governed_rows`, `staff.governed_drt_rules`, `staff.governed_seed_state` | same names | read |
| `staff.audit_log`, `staff.notifications` | same names | insert |

The 16 enum types move to `staff.*` (`client.*` uses none). Names are kept so the Drizzle
schema changes only by `pgSchema("staff")`. Primary keys, tokens and object keys keep
their values: Zuper already holds attachment and quotation URLs built from them, S3 keys
embed the uuids, and session cookies carry the user ids.

### `amc.*` — reminders, bookings and AMC's own accounts

| New table | From SQLite | Notes |
|---|---|---|
| `amc.locations`, `amc.location_settings`, `amc.user_locations` | same | `location_settings.value` stays text (it mixes JSON and plain values) |
| `amc.users`, `amc.password_resets` | same | ids kept — the login JWT carries `users.id` |
| `amc.settings` | `settings` | **without** the `zuper_*` cache keys and without secrets (see *Secrets*) |
| `amc.reminder_campaigns`, `amc.reminders`, `amc.reminder_messages` | same | `reminders` keeps its Zuper copies for now; add `jms_job_id`, `jms_customer_id` |
| `amc.scheduled_job_reminders`, `amc.whatsapp_messages` | same | add `jms_job_id` |
| `amc.booking_activity`, `amc.booking_holds`, `amc.slot_reservations` | same | `booking_holds.start_ts/end_ts` bigint (epoch ms) |
| `amc.technician_day_offs`, `amc.excluded_customers` | same | add `jms_user_id` / `jms_customer_id` |
| `amc.audit_auth`, `…_settings`, `…_users`, `…_locations`, `…_bookings`, `…_reminders`, `…_dayoffs` + view `amc.audit_all` | same | kept as seven tables so the code maps one to one |

**Type conversion from SQLite:** `INTEGER PRIMARY KEY AUTOINCREMENT` → `bigint` identity
with the original values and `setval` afterwards · 0/1 → `boolean` · SQLite
`YYYY-MM-DD HH:MM:SS` (UTC) and ISO strings → `timestamptz` · date-only strings → `date` ·
"9:00 AM" display times stay `text` · JSON text → `jsonb` where the column is always JSON
(`booking_activity.details`, `audit_*.metadata`, `reminders.child_job_uids`) · CHECK lists
kept · copied by **column name**, because production's table history differs from a fresh
install.

### Every new table follows the Business OS pattern

`id`, `tenant_id uuid not null references core.tenants(id)` (value
`00000000-0000-0000-0000-000000000001`), `created_at`/`updated_at` as `timestamptz`, row-level
security enabled, an index on `tenant_id`. Original id types are kept where the application
depends on them (bigint ids in `amc.*`, `bigserial` in `staff.audit_log`).

### Re-pointing links to Zuper records

App tables reference Zuper records in two ways today: by Zuper uid (text) and by the
portal mirror's own uuid. After the move:

- Each reference to a Zuper record becomes a **`jms` uuid column** (`jms_customer_id`,
  `jms_asset_id`, `jms_job_id`, `jms_user_id`), resolved at copy time through
  `jms.zuper_sync_map` (`entity`, `zuper_uid` → `jms_id`). Portal values of the form
  `tuper:<id>` are already jms ids.
- The **Zuper uid columns stay** alongside: the applications still write to Zuper and need
  them, and they keep the rows traceable.
- **No foreign-key constraints into `jms`.** `jms` rows are never hard-deleted (they are
  soft-deleted), and the Business OS rule is that module schemas stay independent of each
  other's migrations. The copy script reports any reference it cannot resolve.

Zuper-shaped **read views** in `jms` give the applications what their mirrors used to hold,
so most reads change a table name rather than a query:

- `jms.v_job_summary` — one row per job with its Zuper uid, work order, title, category
  and status (name, uid, type), customer (uid, name, phone, email), workshop location,
  schedule, due date, priority, assigned technicians (uids, names), asset (name, serial),
  deleted flag and `updated_at`. Replaces `amc.zuper_jobs` and most of `gbg.zuper_records`.
- `jms.v_customer`, `jms.v_asset` — with their Zuper uids, for the portals.
- `jms.v_uid` — `(entity, zuper_uid, jms_id)` for lookups in either direction.

## Access

**One login role per application**, used over a direct Postgres connection (Drizzle / `pg`):

| Role | Own schema | `jms` | Other |
|---|---|---|---|
| `client_portal_app` | all DML on `client.*` | `SELECT` on the tables and views the portal reads | `staff.*`: read; insert `customer_decisions`, `audit_log`, `notifications`; update `quotations(status, decided_at)` |
| `staff_portal_app` | all DML on `staff.*` | `SELECT` | — |
| `amc_app` | all DML on `amc.*` | `SELECT` | — |

None of them may write `jms.*`. Row-level security is on; each role gets a policy for its own
schema. The existing `tgbg_portal` PostgREST role (the client portal's "Tuper" data source)
keeps working and is retired when the portal moves to `client_portal_app`.

**Getting there on the network.** The Supabase database has no published port and sits on
Docker network `x123f7phha4w5nas4dtq2k50`; the three applications are on `coolify`. Attach
each application to the Supabase network (Coolify → application → *Connect to predefined
network*) and connect through the pooler, `supabase-supavisor-x123f7phha4w5nas4dtq2k50`.
Local development goes through an SSH tunnel, as the portals already do. The client portal's
PostgREST path (`supabase.golfbuggyguy.com`) stays available as an alternative; the new
schemas are **not** added to `PGRST_DB_SCHEMAS` unless an application needs them there.

## Doing it

### Phase 1 — create and copy (this session)

1. Migration files in `TGBG-Zupersync/migrations/`: schemas `client`, `staff`, `amc`; the
   enum types; every table with its constraints, partial indexes and the eight `gbg_*`
   protection triggers (rewritten schema-qualified); the read views; the three roles and
   their grants and policies.
2. A copy script (`npm run merge:copy -- --app client|staff|amc [--apply]`, dry run by
   default) that:
   - reads `gbg` over `docker exec` and the AMC **snapshot** (never the live file);
   - converts and re-points as described above, and reports every unresolved reference;
   - loads with triggers held off (`session_replication_role = replica`), fills circular
     links (`jobs.current_snapshot_id`, `jobs.current_report_version_id`,
     `review_items.superseded_by_id`) in a second pass, and resets sequences;
   - is **repeatable**: it empties the app's tables and loads them again, so it can run once
     now and once more at cutover;
   - verifies: row counts per table, no orphaned references, protection triggers present.
3. Nothing in `gbg`, the AMC file or the running applications changes.

### Phase 2 — change each application (per-project sessions)

Each session works behind a switch so the application can run on either database until
cutover. See the briefs below.

### Phase 3 — cut over, one application at a time

1. Pause writes (maintenance page, or stop the container for a few minutes).
2. Take a fresh AMC snapshot / re-read `gbg`, and re-run `merge:copy --app … --apply`.
3. Deploy the application pointed at Supabase; check sign-in, lists, one write each.
4. Keep the old database untouched for two weeks as the fallback.

Suggested order: **Client Portal** (already reads `jms` in its Tuper mode) → **AMC Engine**
reads → **Staff Portal** → **AMC Engine** own tables (the async rewrite).

### Phase 4 — retire

- Remove the portal's 68 Zuper webhooks (`customer.golfbuggyguy.com/api/webhooks/zuper`) and
  AMC's webhook once nothing ingests through them. **DataHouse's webhooks are not touched.**
- Drop `jms_mirror.*` after confirming no reader.
- Archive and stop `gbg-postgres`; close its public port 5432 now (see *Security*).

## Briefs for the application sessions

### Client Portal (`C:\Projects\tgbg-portal\apps\client-portal`)

- Connection: `DATABASE_URL` → Supabase as `client_portal_app`. In `@tgbg/db`, move the
  client tables to `pgSchema("client")` and the shared pipeline tables to `pgSchema("staff")`.
- Records: make the `tuper` data source the only one — it already reads `jms` — and read it
  through the direct connection instead of PostgREST. Delete the Zuper-mirror reads
  (`customer-mirror.ts`, `records/zuper.ts` reads) and the webhook receiver after cutover.
- Customer identity: `client.users.customer_id` is a `jms.customers.id`. Sign-in lookups by
  email go to `jms.customers` / `jms.customer_contacts`, not to Zuper's API.
- Keep: quote decisions and new requests are still sent to Zuper; the result arrives in
  `jms` through Zupersync.

### Staff Portal (`C:\Projects\tgbg-portal\apps\staff-portal`)

- The container **runs migrations on every boot** (`scripts/start.mjs` → `migrate.mjs`).
  Change that before pointing it at Supabase, or it will create its tables in `public`.
  The migration manifest must target `staff.*`, and `governed_seed_state` must be copied so
  the governed seed does not run again.
- Ingest: replace `fetchJobsByCategory` / `fetchJobDetail` / `fetchPortalEnabledCustomers`
  with reads from `jms` (`jms.v_job_summary`, `jms.jobs` + checklist history). The immutable
  `engine_snapshots.raw_payload` should be built from `jms` data from now on; existing
  snapshots stay as they are.
- Keep: status and checklist pushes to Zuper (`packages/zuper/src/jobStatusWrite.ts`).

### AMC Engine (`C:\Projects\TGBG-AmcEngine`)

- **Step A — reads.** Add a Postgres client (`pg`) for `jms` only and replace Zuper reads:
  `getTBCJobs` / `getJobDetails` / `GET /team` / `GET /user/all` / the settings caches → 
  `jms.v_job_summary`, `jms.job_assignments`, `jms.users`, `jms.teams`,
  `jms.job_categories`. Retire `zuper_jobs`, `zuper_job_assignees` and the webhook mirror.
  SQLite stays for AMC's own tables during this step.
- **Step B — own tables.** Move the data layer to `amc.*` on Postgres. `better-sqlite3` is
  synchronous, so every query, `db.transaction()`, the `getSetting()` call inside the Zuper
  HTTP hook and the audit insert in `res.on('finish')` become async. Rewrite
  `INSERT OR IGNORE` / `INSERT OR REPLACE` (the latter changes ids today),
  `datetime('now', …)`, `lastInsertRowid` (→ `RETURNING id`) and case-insensitive `LIKE`
  (→ `ILIKE`). The default-user seed in `database.js` must never run against `amc.*`.
- Keep: bookings still write to Zuper (`src/clients/zuper-write.js`).

## Risks and how the plan handles them

| Risk | Handling |
|---|---|
| A write lands in the old database after the copy | Copy is repeatable; cutover pauses writes and copies again |
| Zuper holds URLs built from portal tokens and ids | Ids, tokens and object keys are copied unchanged |
| Protection triggers block the load | Loaded with `session_replication_role = replica`; triggers verified afterwards |
| Circular foreign keys | Loaded with the pointers empty, set in a second pass |
| A reference to a Zuper record is not in `jms` | Reported by the copy; Zupersync imports the record first |
| The staff container re-creates tables in `public` | Migration target changed before the first Supabase boot |
| Mixed date formats in AMC | Converted column by column with explicit rules; rows that do not parse are reported, not guessed |
| Two accounts named `admin@golfbuggyguy.com` (client and staff) | They stay separate, in separate schemas |

## Security notes found while surveying

- `gbg-postgres` is published on port 5432 (`paneldb.golfbuggyguy.com`) with a superuser
  login. Close the public port; the portals reach it over the SSH tunnel or the Docker network.
- AMC's `settings` / `location_settings` hold the Zuper API token, WhatsApp key and booking
  secret. They are **not** copied into `amc.settings`; the application reads them from
  environment variables after the move.
- AMC's `zuper_webhook_events.headers` can hold the webhook secret. The table is retired and
  not copied.
- `database.js` in AMC creates four default users with a shared password when `users` is
  empty — disable before Step B.

## Decisions for the owner

1. Shared portal tables in `staff.*` (as above) or a single `portal.*` schema for both portals.
2. Direct Postgres over the Supabase Docker network (as above) or PostgREST over HTTPS.
3. Cutover order (as above) and a maintenance window for each application.
4. Removing the portal's 68 Zuper webhooks after the portal cutover.
