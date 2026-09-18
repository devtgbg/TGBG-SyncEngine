# TGBG-SyncEngine (Zupersync)

Keeps Tuper in step with Zuper, through the two systems' APIs.

Zuper stays the system of record. This service receives Zuper's webhooks, re-reads
the record that changed from Zuper's API, and writes it through Tuper's API. It
holds **no key to Tuper's database**: it talks to both systems the same way, over
HTTPS, and keeps its own working state in its own Postgres.

```
  Zuper ──webhook──▶                                   ◀──webhook── Tuper
        ◀──re-read──   Zupersync  ──write (sync API)──▶
        ◀──push (on hold)──                             
                           │
                           ▼
                  its own store (sync.*)
      deliveries · API call log · push queue · config · runs
                           │
                           ▼
                  the log dashboard (read-only)
```

Tuper (JMS) holds no Zuper or migration code; it reads its own tables like any
other application, and Zupersync writes them through Tuper's sync endpoints.

## How it works

**Store, then acknowledge.** A delivery is persisted to `sync.webhook_events` in
the service's own store and answered `200` *before* any processing. Zuper retries a
non-2XX three times with exponential backoff, so a slow write would otherwise cost
us duplicate deliveries. A delivery whose secret doesn't match is still stored —
and never processed — so an attempted forgery leaves a trace instead of vanishing.

**A webhook is a trigger, not a payload.** Zuper does not publish its payload
shape anywhere, so nothing depends on it: we take the record's uid and re-read the
record from Zuper. That survives undocumented payloads, out-of-order deliveries
and duplicates.

**Authentication.** Zuper's is one custom header, set when the webhook is created
in Zuper and compared in constant time. Zuper generates a `secret_key` per webhook
but documents no verification scheme for it, so the header is the usable
mechanism. Tuper's is a real signature: `x-tuper-signature: sha256=<HMAC of the
body>` with the webhook's secret (`TUPER_WEBHOOK_SECRET`).

**Writes go through Tuper's API.** `src/tuper-client.ts` has the surface of the
database client it replaced (`.schema("jms").from("jobs").select(…).eq(…)`,
returning `{ data, error }` with PostgreSQL's own error codes), so the two thousand
tested lines in `src/lib/` that know how a Zuper record becomes Tuper rows did not
change. Every call goes to `/api/sync/query`, `/api/sync/mutate` or
`/api/sync/rpc` with a key carrying the `sync` scope. Tuper decides which tables
and which database functions a sync key may use (`apps/JMS/web/src/lib/api/sync.ts`
in the Business-Operating-System repo).

**Every API call is recorded.** Each request to Zuper and to Tuper lands in
`sync.api_calls` (`src/api-log.ts`): method, path, what it does, the answer, the
time it took, the bodies, and what caused it — which delivery, or the sweep, a
replay, the pusher or an admin re-sync. The cause travels in `AsyncLocalStorage`,
not through every function signature. Rows are buffered and written once a second
off the request path, so recording never slows or fails a sync. Headers are never
kept (both API keys travel in them), body fields named like a credential are
masked, bodies over `API_LOG_BODY_MAX` are cut, bodies go after
`API_LOG_BODY_HOURS` (48) and rows after `API_LOG_DAYS` (7). The health check is
not recorded.

**Every record written to Tuper is recorded too**, one row each, in
`sync.tuper_writes` (`src/tuper-writes.ts`) — the mirror of `sync.outbox`, which
holds what goes to Zuper. A write is whatever turns one Zuper record into Tuper
rows: a job with its details and activity, a customer, a deletion, one record's
notes, one pass over the recent punches, an admin re-sync of a whole entity. The
outermost is the one recorded, so a job's three passes are one row; it says what
the record is (a work order number, a customer's name, named as soon as Zuper's
record is read so a failure still says which), what happened to it in Tuper
(created, updated, deleted — or failed, and why), its cause, and what it cost.
Every call made inside it carries its id (`sync.api_calls.write_id`). Rows go
after `TUPER_WRITES_DAYS` (30).

### Routing

`src/routes.ts` holds Zuper's whole event catalogue: **12 modules, 203 events** —
117 synced (12 of them deletions), 86 stored with a reason and skipped.

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
- **Every job change runs `jobs`, then `job_details`, then `job_activity`.**
  `job_details` never writes the schedule, title, priority or addresses — running
  it alone left 69 of 73 rescheduled jobs on their old times while the log said
  "applied". `job_activity` rebuilds the job's Zuper activity feed and its time
  logs (`GET /api/jobs/{uid}/timelog`). Punches (`job.timelog*`) and job
  attachments re-read the job.
- **Punches and time off have no read-by-uid**, so their events re-read the recent
  part of the list (`src/collections.ts`): punches for the last three days, time
  off that is new, current or recently decided. Bursts (a bulk check-in) share
  one pass. Deletions are not mirrored; neither table has a deleted flag. Shift
  planning is not used in Zuper here and stays out.
- **The sweep covers every kind of record** (`src/sweep-records.ts`): organizations,
  assets, products, contracts, requests, quotes and invoices by `updated_at`;
  customers by value (Zuper's customer list has no `updated_at`); the newest
  notes; punches and time off. Customers, organizations, assets and products are
  ~100 list pages, so they run on the first pass after a start and then every
  `SWEEP_FULL_EVERY_MINUTES` (180). `npm run sweep -- --records [--full] [--apply]`.
- **A list Zuper refuses stops the pass.** A page of a `…/filter` list that fails
  is re-read a record at a time, so one record Zuper cannot serialise costs only
  that record. But when the first five records fail too, with nothing come back,
  the fault is the list itself (a wrong path, a key without access) and the page's
  error is thrown — before 2026-09-18 it paged on for ever.
- **Job line items are not synced.** None of 12,000 jobs changed since 2025 has
  one, and replacing Tuper's job line items with Zuper's empty list would lose
  data. Photos reach Tuper through checklist answers and note attachments (53 of
  53 checked on 2026-09-17); files attached to the job itself are linked too.
- **A work order number Tuper already used is moved, not refused.** While both
  systems number jobs, a job made in Tuper can take the number Zuper gives its next
  job. The import then moves the Tuper-made job to a new number
  (`jms.renumber_job`, through `/api/sync/rpc`, or its two steps where Tuper
  refuses it — see *Known problems*) and writes Zuper's.

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
cp .env.example .env     # Tuper API key, the store's DATABASE_URL, Zuper key, secrets
npm run check-db         # Tuper's API per table, and the store, read and write
npm run check            # routing + wire-format + mapping guards
npm run dev              # :3020
```

`DATABASE_URL` can be a local Postgres: the store is this service's own and is
migrated at boot. `TUPER_API_URL` cannot be made harmless the same way — there is
one Tuper — so processing a delivery writes the live Tuper records. That is why
`simulate` is a dry run unless asked:

```bash
npm run simulate                                       # resolve only, no writes
npm run simulate -- --module JOB --event job.update --send
npm run simulate -- --send --bad-secret                # prove refusal works
```

### Guards

| | |
|---|---|
| `npm run check-db` | Tuper's API readable and writable per table; the store reachable |
| `npm run check-routes` | every routed event points at a real sync entity |
| `npm run check-wire-routes` | all 203 of Zuper's events route by wire key; 15/15 deletions exact |
| `npm run check-real-payload` | a REAL Zuper body — flat, no module field — still routes |
| `npm run check-checklist-import` | what the Zuper checklist import preserves |
| `npm run check-push` | read-only: are the pusher's decisions right? |

`check-wire-routes` exists because `check-routes` validates the catalogue against
itself — the blind spot that hid a label-keyed catalogue whose rules never matched
real traffic.

### Controls

`/admin`, authenticated with the same header and secret as the Zuper receiver
(and refused outright when no secret is set):

| | |
|---|---|
| `GET /admin/entities` | what can be synced, and when each last ran |
| `POST /admin/sync/{entity}` | read that entity from Zuper again and write it through Tuper (matched by uid, so it updates rather than copies) |
| `GET /admin/runs` | the last runs |
| `GET /admin/state` | the queue, the unprocessed deliveries, the cursors |

## The dashboard

`dashboard/` is a read-only Next.js app on `:3021`. It reads **only the service's
own store** — the same `DATABASE_URL` — and nothing of Tuper's: no Supabase, no
`jms`. Every session it opens is `default_transaction_read_only`, so it cannot
write even over the service's credentials. Four pages:

- **Webhooks** (`/`) — every delivery from Zuper *and* from Tuper, filtered by
  source and by outcome: accepted or refused, applied (Zuper) or queued for Zuper
  (Tuper), not synced (a deliberate skip) or failed, and why. Who made the change
  — name, email, role, designation, employee code, user uid — comes from the
  delivery's `triggered_by`. The **API calls** column counts the calls acting on
  it took (`Z 3 · T 41`, and how many failed). The table never scrolls sideways:
  the columns are fixed shares, and a value that does not fit is cut with an
  ellipsis, with the whole of it in the tooltip.

  Clicking a row opens that delivery (`?open=<id>`, so it can be linked to): what
  Zupersync did with it and the full error, who caused it, **what changed** in
  words, **the API calls it caused** — each one opens to show what was sent and
  what came back (`&call=<id>`), so the record as Zuper returned it is one click
  away — and the **exact webhook** as stored. "What changed" describes the
  webhook, not the write: the record is still re-read from Zuper. Shapes were read
  off real deliveries (`dashboard/src/lib/describe.ts`). An assignment names people
  by uid only; they are named from the deliveries those people triggered
  themselves.

  The receivers store every request header, and two of them authenticate:
  `x-zupersync-key` is Zuper's shared secret, `x-tuper-signature` Tuper's
  signature. They are masked in `lib/db.ts`, before the row is returned, not in
  the component that prints them: React serialises a server component's props
  into the page, so a secret that reaches a component is in the HTML source even
  when nothing displays it. Check that with a production build — under
  `next dev`, React also writes the raw rows a page awaited into the payload for
  its developer tools.
- **To Tuper** (`/tuper`) — every record written into Tuper, one row each, whatever
  caused it: a Zuper webhook, a replay, the sweep catching what a webhook missed,
  an admin re-sync. What the record is, what happened to it in Tuper, what it cost
  in calls, and why it failed when it did, with the last day's created, updated,
  deleted and failed counts. Opening a row lists every call its writing took. A
  Zuper delivery's panel on **Webhooks** links to the records it wrote.
- **API calls** (`/calls`) — every request to Zuper's API and to Tuper's, newest
  first, filtered by system, failures and cause, with the last hour's volume,
  failures and median time per system. Pages by id, not offset, because the log
  grows by thousands of rows an hour. Opening a call shows its bodies and links to
  the delivery that caused it.
- **To Zuper** (`/pushes`) — every change made in Tuper and queued for Zuper: the
  record, what changed, who changed it, the delivery that queued it, the Zuper
  requests planned for it and what is not pushed and why. The page asks the
  service's `/health` whether pushing is on and says so at the top; while it is
  off, nothing on this page will happen.

All pages stay current on their own. The open page asks `/api/pulse` every 3
seconds for a fingerprint of the newest rows (ids and state columns only, no
bodies; for calls, the newest id) and re-renders in place only when it changes, so
the filter, the scroll position and any opened body are kept. A row that has just
arrived is tinted briefly. A background tab does not poll, and everything is
re-read once a minute regardless. The webhook and push logs come 50 to a page (25
or 100 on request), with the filter's own total; a link to an older page carries
`upto`, the newest row's timestamp when it was rendered, so a delivery arriving
while someone reads page 3 does not push every row down by one.

Every page is behind HTTP Basic sign-in (`DASHBOARD_USER`, `DASHBOARD_PASSWORD`);
in production an unset pair answers 503 rather than showing customer data.
Locally (`next dev`) it is open.

`next build` fails on Windows at the standalone copy step (it needs symlink
rights); `NEXT_STANDALONE=0 next build` skips it for a local check. The Docker
build is unaffected.

## Deployment

Two deployables, two Coolify applications from this one repository, and the
store as a Coolify Postgres resource (`zupersync-store`) on the same network. A
push to `main` auto-deploys both applications.

| App | Coolify app | Dockerfile | Base directory | Port | Domain | Health check |
|---|---|---|---|---|---|---|
| Sync service | `odzzb87rii8pelpwd5io885f` | `Dockerfile` | *(repo root)* | 3020 | `zupersync.golfbuggyguy.com` | `/health` |
| Log dashboard | `xlqg5egagiof3f9mb6iabuoq` | `/Dockerfile` | `/dashboard` | 3021 | `synclog.golfbuggyguy.com` | `/healthz`, host `127.0.0.1` |

The service's `/health` returns 503 when Tuper's API or the store is unreachable,
reporting each separately, so it says what matters rather than merely that the
process is alive. It also reports the push state (`push.mode`, `sentToZuper`,
`plannedOnly`), so the state of a deployment is never a guess.

### The service's environment

Three are enforced at boot — the container exits without them:

| | |
|---|---|
| `TUPER_API_KEY` | Tuper's API (`TUPER_API_URL`, default `https://api.tuper.golfbuggyguy.com`), with the `sync` scope; every record is written through it |
| `DATABASE_URL` | the store; its migrations (`store/`) run before anything is served |
| `ZUPER_API_KEY` | every webhook re-reads its record through this |

Three more are *not* enforced, and fail quietly rather than loudly — set them:

| | |
|---|---|
| `ZUPER_WEBHOOK_SECRET` | **Set this before the first deploy.** In production an unset secret refuses every delivery (stored, never processed); locally it processes anything. Also the key to `/admin`. |
| `TUPER_WEBHOOK_SECRET` | the secret Tuper signs its deliveries with. Without it every Tuper delivery is stored and refused. |
| `DEFAULT_TENANT_ID` | the fallback is `00000000-0000-0000-0000-000000000001`, which on this installation happens to be the real tenant ("TGBG"). Set it explicitly anyway: a value that is right by coincidence is not configuration. |

Optional: `PORT` (3020), `ZUPER_API_URL`, `ZUPER_WEBHOOK_HEADER`
(`x-zupersync-key`), the `RECONCILE_*`, `SWEEP_*`, `PUSH_*` and `API_LOG*` settings
in `.env.example`, `NODE_ENV` — the image already sets it to `production`, so do
not override it with `development`.

### The dashboard's environment

Runtime only (none is a build variable): `DATABASE_URL` (the store's, the same
value the service has), `DEFAULT_TENANT_ID`, `DASHBOARD_USER` and
`DASHBOARD_PASSWORD` — the password is generated and can be read in the app's
Environment Variables in Coolify. Optional: `ZUPERSYNC_URL` (where to ask for
`/health`) and `ZUPER_WEBHOOK_HEADER`. The old `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are no longer read and can be removed.

Two things made its first deploys fail, both invisible locally:

- **Coolify sets `HOSTNAME`** on the container, and Next's standalone server
  listens on `$HOSTNAME` — it resolves the container name, fails with
  `getaddrinfo ENOTFOUND` and exits. The image's command sets
  `HOSTNAME=0.0.0.0` itself.
- **Coolify's health check calls `localhost`**, which on Alpine resolves to `::1`
  first, while the server listens on IPv4 — "connection refused" on every
  attempt. The app's health check host is set to `127.0.0.1`.

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
build-variable box for `TUPER_API_KEY`, `DATABASE_URL`, `ZUPER_API_KEY`,
`ZUPER_WEBHOOK_SECRET` and `TUPER_WEBHOOK_SECRET`.

That same injection is why the build stage runs `npm ci --include=dev`: with
`NODE_ENV=production` exported into the build, a bare `npm ci` installs no
devDependencies and the build dies with `sh: esbuild: not found`. It builds
locally, where nothing exports `NODE_ENV`, and fails only on the platform.

The service installs from `package-lock.json` (npm) and the dashboard from
`dashboard/pnpm-lock.yaml` (pnpm). A `pnpm-workspace.yaml` at the repo root makes
pnpm treat the root as a workspace and write the dashboard's dependencies into a
root lockfile the Docker build never reads — keep the root free of pnpm files.

### If the domain returns `404 page not found`

That 18-byte body is Traefik's own 404, not this app's — the hostname has no
route, so requests never reach a container. Over HTTPS the same cause shows up
as a certificate error (curl exit 60), because Let's Encrypt does not issue for a
hostname the proxy is not serving. One cause, two symptoms.

Check, in this order:

1. **The container is not running.** The commonest reason is a missing required
   variable: the process throws at boot, so there is no healthy backend to route
   to. The log line names the variable — `TUPER_API_KEY is required`, and so on.
2. **The domain is not set on the application** in Coolify.
3. **The port does not match.** The app listens on `PORT` (default 3020).

To tell the two apart quickly: a Traefik 404 means nothing is routed; an
Express 404 (`Cannot GET /…`) means the app *is* serving and the path is wrong.
`/health` is always defined, so a 404 there is never the app.

### Registering the webhooks

**In Zuper**, point them at `https://zupersync.golfbuggyguy.com/webhooks/zuper`
with one header whose key and value match `ZUPER_WEBHOOK_HEADER` and
`ZUPER_WEBHOOK_SECRET`. Zuper's webhook form calls these fields literally `key`
and `value`; there is no separate secret field. `npm run webhooks` lists what is
registered against what is needed (plan by default; `apply` creates the missing
ones). On 2026-09-18 all 117 synced events were registered (and `job.new_recurrence`, now a skip). `GET /webhooks/zuper`
answers a liveness probe, which is what Zuper's "test URL" check uses.

**In Tuper**, point them at `https://zupersync.golfbuggyguy.com/webhooks/tuper`,
signed with `TUPER_WEBHOOK_SECRET`, for the ten events the receiver queues:
`job.new`, `job.update`, `job.delete`, `job.update_schedule`, `job.status_update`,
`job.assign_users`, `job.unassign_users`, `customer.create`, `customer.update`,
`customer.delete`. **The module must be Tuper's catalogue name — `JOB`,
`CUSTOMER` — not `JOBS` or `CUSTOMERS`.** Tuper builds the body from the module,
and for a module it does not know it leaves the record's uid out of `job.new`,
`job.update`, `job.delete` and `customer.*`. Zupersync then has nothing to queue;
it records the delivery as failed and says why.

## The store

`store/` is this service's own schema (`sync`), applied at boot in file order,
each file once (recorded in `public.sync_migrations`):

- `001_init.sql` — deliveries from both systems (`webhook_events`, with
  `source`), the push queue (`outbox`), the service's config and its runs.
- `002_api_calls.sql` — the API call log, and an index for naming people from
  `triggered_by`.
- `003_close_uidless_tuper_deliveries.sql` — closes, with the reason, the Tuper
  deliveries that arrived without a record uid before the receiver learned to.
- `004_tuper_writes.sql` — one row per record written to Tuper, and
  `api_calls.write_id` tying each call to it.

### `migrations/` — Tuper's database, historical

`migrations/` is the SQL this service applied to the shared Supabase while it
still held a database key. It is kept as the record of what was done there; none
of it runs at boot, and nothing here needs it now. `0002` added the outbox
triggers on `jms.*` and `0012` removed them (applied 2026-09-17): Tuper's webhooks
replaced them, and the service's writes no longer carry the origin header the
triggers relied on, so reviving them would queue every record imported from Zuper
straight back to Zuper. Applying any of them needs the role that owns the schema
(`supabase_admin`, over `ssh tgbgaws`), not `postgres`.

## Pushing back to Zuper

**On hold** (`PUSH_MODE=off` in production, 2026-09-18). Changes made in Tuper are
received and queued; nothing is planned or sent, and the next Zuper webhook for a
record puts Zuper's values back in Tuper.

A change made in Tuper arrives as a Tuper webhook (`src/receiver-tuper.ts`), is
verified by its signature, stored, and turned into a row in `sync.outbox`. The
echo guard is Tuper's side: a write this service makes through the sync endpoints
fires no webhook, so a change that came from Zuper is never sent back to Zuper.

`src/pusher.ts` reads the queue every 30 seconds and groups rows by record, so
several quick edits become one push of the latest state. The planner compares
what the edit set, what it started from, and what Zuper holds now:

| Zuper holds… | …so |
|---|---|
| the value that was set | nothing to send |
| the value the edit started from | nobody touched it there: the edit is sent, even if the row no longer shows it |
| something else | changed on both sides. `PUSH_ON_CONFLICT=zuper-wins` (default) leaves Zuper alone and says so on the row; `tuper-wins` sends anyway |

A technician moving a job on from the mobile app while someone sets a status at a
desk is the conflict that actually happens; Zuper's is the later fact and stands.

When pushing is live, the inbound sync also pushes a record's pending edits
**before** it re-reads the record (`setBeforeInbound`). Rows are **claimed in the
database** before they are planned, so the tick and that flush — or two
containers during a deploy — can never send the same change twice. A create whose
answer never arrived is not retried: a second `POST` would make a second record.

### Jobs

| Tuper change | Zuper request |
|---|---|
| title, priority, type, due date, prefix, tags, description, addresses, customer, organization, asset | `PUT /api/jobs` `{ job: { job_uid, … } }` — only fields Zuper does not already hold |
| schedule | `PUT /api/jobs/schedule` with `job_timezone` |
| status | `PUT /api/jobs/{uid}/status` with `status_uid` (+ the history row's remarks) — skipped when Zuper already shows it, because every call adds a history entry |
| assignees | `POST /api/jobs/assign` — the difference only; unassign uses the team the user is under in Zuper |
| deleted | `DELETE /api/jobs/{uid}/delete` — only with `PUSH_DELETES=true` |
| a job Zuper has never had | `POST /api/jobs`, then a follow-up for status and people. Zuper assigns its own work order number, which then replaces Tuper's |

### Customers

`src/pusher-customers.ts`, with DataHouse's production calls
(`writeback/zuper/customer_writer.py`) and its rules: `PUT /api/customers/{uid}`
for an update, `POST /api/customers_new` for a new one, and a deletion **never
pushed** (it succeeds in Zuper and orphans the customer's jobs, assets and
contracts there). An email or mobile that is not changing is left out: Zuper
re-checks their uniqueness on every PUT and counts archived customers.

### Everything else

Organizations, assets, products, notes, quotes, invoices, payments, contracts,
requests, checklist answers, custom fields, attachments, timesheets and users are
not pushed, and no call has been proven against this account. Zuper answers 200 to
writes it ignores, so each kind is added the same way: a planner, its Tuper
events, plans watched in dry-run, one supervised real write, then its name in
`PUSH_ENTITIES`.

### Modes, and going live

`PUSH_MODE`: `off` reads and writes nothing. `dry-run` plans each change and
stores the requests on the row; nothing is sent. `live` sends them, then reads the
record back; a 200 that changed nothing fails the row. `live` reaches only the
entities in `PUSH_ENTITIES` (default `jobs`). A change queued more than
`PUSH_MAX_AGE_MINUTES` ago is marked skipped, not sent, so switching on never
replays old edits over what Zuper holds now.

To go live: fix the Tuper webhook modules (above) · deploy with `dry-run` and
read the plans on **To Zuper** · set `live` with `PUSH_ENTITIES=jobs` · make one
edit on one job and watch it sent, applied in Zuper, and Zuper's own webhook come
back in **Webhooks** with no second row in **To Zuper** (which would be an echo).
A status pushed to Zuper is a real status change there: it appears on the
technician's phone and fires whatever notifications Zuper is configured to send.

```bash
npm run outbox            # what is queued, planned and sent
npm run outbox -- --plan  # plan what is queued now, send nothing
npm run check-push        # read-only: are the pusher's decisions right?
```

## Known problems

Found 2026-09-18, all on Tuper's side:

- **Tuper's sync API refuses `renumber_job` and `renumber_request`**
  (`'… is not a function the sync service may call'`): its allowlist names
  `renumber_jobs` and `renumber_requests`, while the database functions are
  `renumber_job`, `renumber_request`, `renumber_contract` and `renumber_product`.
  It kept 15 new Zuper jobs (WO 54614–54629) out of Tuper on 2026-09-18. Worked
  around here: a renumber function is `next_*` then an update of the number
  (migration 00076), both of which a sync key may do, so on that refusal
  `record-numbers.ts` does the two itself. Fixing the allowlist in Tuper makes the
  workaround unnecessary.
- **Tuper's webhooks for Zupersync are registered as `JOBS` / `CUSTOMERS`**, so
  their `job.new`, `job.update`, `job.delete` and `customer.*` bodies carry no
  uid (see *Registering the webhooks*).
- **Tuper's `job.status_update` bodies carry `"status": null`.** The receiver
  only needs the job's uid, so nothing is lost here, but a subscriber reading the
  status from the body gets nothing.

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
