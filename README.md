# TGBG-SyncEngine (Zupersync)

Keeps one Supabase database live with Zuper, in both directions.

Zuper stays the system of record. This service receives Zuper's webhooks,
re-fetches the record that changed, and upserts it into the `jms.*` tables every
application already reads. **There is no mirror schema and no second copy of the
data** — four applications read the same rows:

```
                 ┌─────────────────────────────────────────┐
  Zuper ──webhook──▶  Zupersync  ──upsert──▶  Supabase     │
        ◀──API push──            ◀──outbox──   jms.*       │
                 └──────────────────────┬──────────────────┘
                                        │
              Tuper (JMS) · AMC Engine · Client Portal · Staff Portal
```

Each application keeps only its own non-Zuper tables, in its own schema
(`client.*`, `staff.*`, `amc.*`). Anything Zuper knows about lives once, in `jms.*`.

## How it works

**Store, then acknowledge.** A delivery is persisted to `jms.zuper_webhook_events`
and answered `200` *before* any processing. Zuper retries a non-2XX three times
with exponential backoff, so a slow upsert would otherwise cost us duplicate
deliveries. A delivery whose secret header doesn't match is still stored — and
never processed — so an attempted forgery leaves a trace instead of vanishing.

**A webhook is a trigger, not a payload.** Zuper does not publish its payload
shape anywhere, so nothing depends on it: we take the record's uid and re-read the
record from Zuper. That survives undocumented payloads, out-of-order deliveries
and duplicates.

**Authentication** is one custom header, set when the webhook is created in Zuper
and compared in constant time. Zuper generates a `secret_key` per webhook but
documents no verification scheme for it, so the header is the usable mechanism.

### Routing

`src/routes.ts` holds Zuper's whole event catalogue: **12 modules, 203 events** —
97 synced (12 of them deletions), 106 stored with a reason and skipped.

The catalogue is Zuper's own, not transcribed from its UI. `GET
/api/misc/{MODULE}/events` — the call Zuper's New Webhook form makes when a module
is picked — returns every event's wire key and display name for `JOB`,
`CUSTOMER`, `ORGANIZATION`, `PROPERTY`, `TIMESHEET`, `PRODUCTS`, `ESTIMATES`,
`INVOICE`, `SERVICE_CONTRACTS`, `ASSETS`, `USER` and `REQUEST`. A copy lives in
`src/cli/fixtures/zuper-events.json`.

Things that break routing silently if assumed otherwise:

- **A delivery carries the wire key** (`estimate.delete`), not the form label
  ("Quote Delete"), and no module field at all. Routing is keyed by wire key.
- **The key's prefix is not always its module**: `measurement.*` is `JOB`,
  `inspection_form.*` is `ASSETS`, `timesheet_approval.*` is `TIMESHEET`,
  `import.organization` is `ORGANIZATION`. Every known key is looked up exactly;
  the prefix is only a fallback for events Zuper adds later.
- **`PROPERTY` is not organizations.** They are separate Zuper records (1,008
  organizations, one property here), and `GET /api/organization/{property_uid}`
  answers 404. Properties have no importer, so their events are skipped.
- **Every job change runs `jobs`, then `job_details`.** `job_details` never writes
  the schedule, title, priority or addresses. Running it alone left 69 of 73
  rescheduled jobs on their old times while the log said "applied".

Entities Zuper offers no by-uid read for (timesheets, timelogs) are **refused,
not stubbed**. Handing a bare uid to a transform written for a full record would
write a near-empty payload over a live row.

**Notes** have no by-uid read either, but every note event names the record the
note is on, and `GET /api/notes?filter.<job|customer|request|asset>=uid` lists
that record's notes (pinned ones separately, in `pinned_notes`). A note event
re-reads that list and writes what is new or changed. The list omits deleted
notes, so a deletion is flagged by `note_uid` when the delivery has one and by
absence otherwise. Tuper keeps no notes on quotes, invoices or contracts, so
those note events are skipped.

## Running it

```bash
npm install
cp .env.example .env     # fill in Supabase + Zuper credentials
npm run check-db         # prove the tables are readable and writable
npm run check            # routing + wire-format + mapping guards
npm run dev              # :3020
```

Replay a delivery without waiting on Zuper. Dry run is the default, because there
is no local database — every environment points at the shared Supabase, so
"processing" writes rows four applications read:

```bash
npm run simulate                                       # resolve only, no writes
npm run simulate -- --module JOB --event job.update --send
npm run simulate -- --send --bad-secret                # prove refusal works
```

### Guards

| | |
|---|---|
| `npm run check-db` | every table readable, write permitted |
| `npm run check-routes` | every routed event points at a real sync entity |
| `npm run check-wire-routes` | all 203 of Zuper's events route by wire key; 15/15 deletions exact |
| `npm run check-real-payload` | a REAL Zuper body — flat, no module field — still routes |
| `npm run check-checklist-import` | what the Zuper checklist import preserves |

`check-wire-routes` exists because `check-routes` validates the catalogue against
itself — the blind spot that hid a label-keyed catalogue whose rules never matched
real traffic.

## The dashboard

`dashboard/` is a read-only Next.js app on `:3021` with two pages:

- **From Zuper** (`/`) — every delivery: accepted or refused, applied, not
  synced (a deliberate skip) or failed, and why.
- **To Zuper** (`/pushes`) — every change made in Tuper, the Zuper requests
  planned for it, what is not pushed and why, and whether it was sent. While
  `PUSH_MODE=dry-run`, this page is the review before going live.

Every page is behind HTTP Basic sign-in (`DASHBOARD_USER`,
`DASHBOARD_PASSWORD`); in production an unset pair answers 503 rather than
showing customer data. Locally (`next dev`) it is open.

`next build` fails on Windows at the standalone copy step (it needs symlink
rights); the Docker build is unaffected.

## Deployment

Two deployables, two Coolify applications from this one repository. A push to
`main` auto-deploys.

| App | Dockerfile | Base directory | Port | Domain |
|---|---|---|---|---|
| Sync service | `Dockerfile` | *(repo root)* | 3020 | `zupersync.golfbuggyguy.com` |
| Delivery log | `dashboard/Dockerfile` | `dashboard` | 3021 | *(internal — see the warning above)* |

Health check path: `/health`. It returns 503 when the database is unreachable, so
it reports the thing that matters rather than merely that the process is alive.

### Environment

Three are enforced at boot — the container exits without them:

| | |
|---|---|
| `SUPABASE_URL` | the shared project, the same one Tuper reads |
| `SUPABASE_SERVICE_ROLE_KEY` | writes across `jms.*`, so it must bypass RLS |
| `ZUPER_API_KEY` | every webhook re-reads its record through this |

Two more are *not* enforced, and both fail quietly rather than loudly — set them:

| | |
|---|---|
| `ZUPER_WEBHOOK_SECRET` | **Set this before the first deploy.** The receiver only refuses an unverified delivery `if (!verified && secretConfigured())`. With no secret, that guard never fires and the public endpoint will process anything anyone POSTs to it, straight into the live tables. |
| `DEFAULT_TENANT_ID` | the fallback is `00000000-0000-0000-0000-000000000001`, which on this installation happens to be the real tenant (`core.tenants` → "TGBG"). Set it explicitly anyway: a value that is right by coincidence is not configuration, and on any other tenant the default would fail the `core.tenants` foreign key on every write. |

Optional: `PORT` (3020), `ZUPER_API_URL`, `ZUPER_WEBHOOK_HEADER`
(`x-zupersync-key`), `NODE_ENV` — the image already sets it to `production`, so
do not override it with `development`.

### Two Coolify settings that are not defaults

**Build pack must be `dockerfile`.** A new application defaults to Nixpacks, which
ignores the `Dockerfile` here and builds its own way — skipping the esbuild step.
That step is load-bearing: `src/lib/` uses extensionless relative imports, which
Node refuses under `"type": "module"`, so a Nixpacks image crash-loops on
`ERR_MODULE_NOT_FOUND` and never becomes healthy. Set `ports_exposes` to 3020 too;
the default is 3000.

**Secrets should not be build variables.** Coolify passes every environment
variable into the build as an `ARG`, so anything marked as a build variable is
baked into image layers — Docker warns about this itself
(`SecretsUsedInArgOrEnv`). Nothing here needs a secret at build time; untick the
build-variable box for `SUPABASE_SERVICE_ROLE_KEY`, `ZUPER_API_KEY` and
`ZUPER_WEBHOOK_SECRET`.

That same injection is why the build stage runs `npm ci --include=dev`: with
`NODE_ENV=production` exported into the build, a bare `npm ci` installs no
devDependencies and the build dies with `sh: esbuild: not found`. It builds
locally, where nothing exports `NODE_ENV`, and fails only on the platform.

### If the domain returns `404 page not found`

That 18-byte body is Traefik's own 404, not this app's — the hostname has no
route, so requests never reach a container. Over HTTPS the same cause shows up
as a certificate error (curl exit 60), because Let's Encrypt does not issue for a
hostname the proxy is not serving. One cause, two symptoms.

Check, in this order:

1. **The container is not running.** The commonest reason is a missing required
   variable: the process throws at boot, so there is no healthy backend to route
   to. The log line names the variable — `SUPABASE_URL is required`, and so on.
2. **The domain is not set on the application** in Coolify.
3. **The port does not match.** The app listens on `PORT` (default 3020).

To tell the two apart quickly: a Traefik 404 means nothing is routed; an
Express 404 (`Cannot GET /…`) means the app *is* serving and the path is wrong.
`/health` is always defined, so a 404 there is never the app.

### Registering the webhooks in Zuper

Point them at:

```
https://zupersync.golfbuggyguy.com/webhooks/zuper
```

with one header whose key and value match `ZUPER_WEBHOOK_HEADER` and
`ZUPER_WEBHOOK_SECRET`. Zuper's webhook form calls these fields literally `key`
and `value`; there is no separate secret field.

`GET /webhooks/zuper` answers a liveness probe, which is what Zuper's "test URL"
check uses.

### Migrations

This service owns its own SQL, in `migrations/`. Applying one needs the role that
owns the schema — `postgres` is not a superuser here and has no CREATE on `jms`:

```bash
cat migrations/0001_zuper_webhook_events.sql | ssh tgbgaws \
  "docker exec -i supabase-db-x123f7phha4w5nas4dtq2k50 \
     psql -v ON_ERROR_STOP=1 -U supabase_admin -d postgres"
```

Verify over PostgREST afterwards and re-issue `NOTIFY pgrst, 'reload schema';`
from a fresh session — the one at the end of the file does not reliably reach it.

- `0001_zuper_webhook_events.sql` — the delivery inbox. **Applied.**
- `0002_zuper_outbox.sql` — the push outbox, and triggers on `jms.jobs`,
  `jms.job_assignments` and `jms.job_team_assignments`. **Applied 2026-09-17**,
  after the deployed service began sending `x-sync-origin` (b474d84). Verified:
  a write carrying the header queues nothing; one without it queues the changed
  columns with their previous values.
- `0003_zuper_sync_map_uid_index.sql` — `(tenant_id, zuper_uid)` on the sync map,
  for the per-record id lookups (a 513k-row scan before, 0.08 ms after).
  **Applied 2026-09-17.** Uses `CONCURRENTLY`, so apply it on its own.

## Pushing back to Zuper

A change made in any application has to reach Zuper, or the next webhook
overwrites it and the edit disappears. The hazard is the echo loop — Zupersync
writes a row, the write queues a push, Zuper fires a webhook, forever.

Every write carries its origin and Zupersync's own are skipped. PostgREST exposes
request headers as a GUC, so one global header identifies the service with no
change at any call site:

```ts
createClient(url, key, { global: { headers: { "x-sync-origin": "zupersync" } } })
```

Writes over a direct Postgres connection have no request headers, read as `app`,
and queue correctly.

The triggers are `SECURITY DEFINER` and swallow their own errors (as a
`WARNING`): queueing a push must never fail the save it describes.

`src/pusher.ts` reads the outbox every 30 seconds and groups rows by job. The
outbox says **which** columns changed; the values are read from the job as it is
now, so several quick edits become one push of the latest state.

| Tuper change | Zuper request |
|---|---|
| title, priority, type, due date, prefix, tags, description, addresses, customer, organization, asset | `PUT /api/jobs` `{ job: { job_uid, … } }` — only fields Zuper does not already hold |
| schedule | `PUT /api/jobs/schedule` with `job_timezone` |
| status | `PUT /api/jobs/{uid}/status` with `status_uid` (+ the history row's remarks) — skipped when Zuper already shows it, because every call adds a history entry |
| assignees | `POST /api/jobs/assign` — the difference only; unassign uses the team the user is under in Zuper |
| deleted | `DELETE /api/jobs/{uid}/delete` — only with `PUSH_DELETES=true` |
| a job Zuper has never had | `POST /api/jobs`, then a follow-up for status and people. Zuper assigns its own work order number, which then replaces Tuper's |

Everything else (delay flag, actual times, recurrence, skills, …) is recorded on
the row as *not pushed*, with the reason.

**Modes** (`PUSH_MODE`): `dry-run` is the default — each change is planned and
the requests are stored on the row (`planned`), nothing is sent. `live` sends
them, then reads the job back; a 200 that did not change anything fails the row.
Writes are never retried blindly: a failed row waits (2, 4, 8 … minutes) and is
re-planned against Zuper's current state first.

```bash
npm run outbox            # what is queued, planned and sent
npm run outbox -- --plan  # plan what is queued now, send nothing
```

## Where the engine came from

`src/lib/` is the sync engine extracted from JMS — 13 files, deliberately *not*
the transitive closure. Excluded: ClamAV virus scanning, EXIF parsing, the
timezone tables, and the real body of `list-contract/write.ts`, which would have
dragged in JMS's automation fan-out (outbound webhooks, the workflow engine, a
QuickJS sandbox, customer notification rules). Firing those from a sync would mean
a reconcile over 46,769 jobs fanning out into customer notifications.

`syncOne` reproduces the per-row body of `syncEntity` rather than calling it —
that logic is an inlined closure with no single-record entry point. The one thing
it does not reproduce is the full map load: `syncEntity` reads the whole
`zuper_sync_map` (513,336 rows) up front, so `syncOne` pre-seeds only the uids
present in the one record.

Tuper (JMS) holds no Zuper or migration code; it reads `jms.*` like any other
application.
