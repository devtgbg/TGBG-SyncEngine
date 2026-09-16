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

`src/routes.ts` holds the full catalogue: 11 modules, 192 events, 117 routed.

Zuper's webhook **form labels are not its wire names**, and assuming otherwise
breaks routing silently. The form says module "Quotes"; the wire says `ESTIMATES`.
Organizations are `PROPERTY`. Events are lowercase dotted (`estimate.delete`, not
"Quote Delete"). Only one module of nine matches as-is.

38 of Zuper's 73 live event names aren't in the catalogue by name at all, so an
uncatalogued event on a *known* module falls back to re-syncing the record rather
than being dropped — which is the right default when a webhook only means
"something about this record changed".

Entities Zuper offers no by-uid read for (notes, timesheets, timelogs) are
**refused, not stubbed**. Handing a bare uid to a transform written for a full
record would write a near-empty payload over a live row.

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
| `npm run check-wire-routes` | all 73 of Zuper's real wire strings route; 8/8 deletions exact |
| `npm run check-checklist-import` | what the Zuper checklist import preserves |

`check-wire-routes` exists because `check-routes` validates the catalogue against
itself — the blind spot that hid three live routing bugs.

## The dashboard

`dashboard/` is a read-only Next.js view of the delivery log on `:3021`: what
Zuper sent, whether it was accepted, whether it was applied, and if not, why.

> **It authenticates nobody** and renders stored webhook bodies containing
> customer data. Put auth in front of it before exposing it publicly.

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
- `0002_zuper_outbox.sql` — pushing changes back to Zuper. **Not applied**: it adds
  a trigger to `jms.jobs`, which four applications write.

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
