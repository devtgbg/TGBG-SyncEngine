/**
 * What connects Zuper and Tuper, measured for the dashboard's Connections page.
 *
 * The dashboard holds no API key, so the service measures and leaves the answer in its store (sync.snapshots):
 *
 *   catalogue      every Zuper event and what the service does with it — the record it writes, the Zuper API it reads
 *                  that record from — the Tuper events it queues for Zuper, and the Zuper writes a push makes.
 *   registrations  the webhooks actually registered in Zuper and in Tuper, pointing at this service.
 *   traffic        over the last 24 hours, for each kind of record written to Tuper: the Zuper endpoints its writes
 *                  read and the Tuper tables they wrote, and every endpoint's calls, failures and median time.
 *
 * Refreshed at boot, every 30 minutes, and whenever the dashboard asks (src/commands.ts). Reading registrations is a
 * GET against each system; the one write here, creating the Zuper webhooks Zupersync needs, runs only when asked.
 */
import { config, errorText, secretConfigured } from "./config.js";
import { logCall } from "./api-log.js";
import { sql } from "./store.js";
import { EVENT_CATALOGUE, resolveRoute, detailPathFor } from "./routes.js";
import { ENTITIES } from "./lib/migration/zuper-sync.js";
import { tuperEventCatalogue } from "./receiver-tuper.js";
import { report } from "./settings.js";

const PUBLIC_URL = (process.env.PUBLIC_URL ?? "https://zupersync.golfbuggyguy.com").replace(/\/+$/, "");
export const ZUPER_ENDPOINT = `${PUBLIC_URL}/webhooks/zuper`;
export const TUPER_ENDPOINT = `${PUBLIC_URL}/webhooks/tuper`;

/** The Zuper writes a push makes, by kind of record (src/pusher.ts, src/pusher-customers.ts). */
const PUSH_WRITES: Record<string, { request: string; when: string }[]> = {
  jobs: [
    { request: "PUT /api/jobs", when: "title, priority, type, dates, tags, description, addresses, customer, asset" },
    { request: "PUT /api/jobs/schedule", when: "the schedule" },
    { request: "PUT /api/jobs/{uid}/status", when: "the status" },
    { request: "POST /api/jobs/assign", when: "who is assigned" },
    { request: "POST /api/jobs", when: "a job Zuper has never had" },
    { request: "DELETE /api/jobs/{uid}/delete", when: "a deletion, only when deletes are allowed" },
  ],
  customers: [
    { request: "PUT /api/customers/{uid}", when: "names, contacts, flags, organization, addresses" },
    { request: "POST /api/customers_new", when: "a customer Zuper has never had" },
  ],
};

/** How a route gets its record from Zuper, in words. */
function readOf(r: NonNullable<ReturnType<typeof resolveRoute>>): string {
  if (r.deletion) return "no read: the record is flagged deleted";
  if (r.noteHost) return `GET /api/notes?filter.${r.noteHost}={uid}`;
  if (r.collection) return "re-reads the recent part of its list";
  if (r.fetch === "detail" && r.detail) return `GET ${r.detail("{uid}")}`;
  if (r.fetch === "self") return "the importer reads it for itself";
  return String(r.fetch);
}

export function catalogue() {
  const zuperEvents = Object.entries(EVENT_CATALOGUE).flatMap(([module, events]) => events.map((event) => {
    const r = resolveRoute(module, event);
    return {
      module, event,
      entity: r && !r.skip ? r.entity : null,
      then: r && !r.skip ? r.enrich ?? [] : [],
      read: r && !r.skip ? readOf(r) : null,
      skip: r?.skip ?? (r ? null : "no route"),
    };
  }));
  const entities = Object.entries(ENTITIES).map(([name, e]: [string, any]) => ({
    name, table: `${e.schema ?? "jms"}.${e.table ?? "?"}`, read: detailPathFor(name) ? `GET ${detailPathFor(name)!("{uid}")}` : null,
  }));
  return {
    zuperEndpoint: ZUPER_ENDPOINT, tuperEndpoint: TUPER_ENDPOINT,
    zuperEvents, entities, tuperEvents: tuperEventCatalogue(), pushWrites: PUSH_WRITES,
  };
}

// ── registrations ────────────────────────────────────────────────────────────

/** One request, recorded in the API log. `logged` is what the log keeps of the body, when that must differ from it. */
async function call(system: "zuper" | "tuper", method: string, url: string, path: string, key: string, body?: unknown, logged: unknown = body) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    logCall({ system, method, path, status: res.status, ok: res.ok, started, request: logged, response: text });
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { ok: res.ok, status: res.status, json, text };
  } catch (err) {
    logCall({ system, method, path, status: null, ok: false, started, error: errorText(err), request: logged });
    throw err;
  }
}

export interface Hook { uid: string; module: string; event: string; url: string; active: boolean | null; signed: boolean | null }

/** Every webhook registered in Zuper. Its list returns each one's secret_key: dropped here, never stored. */
export async function zuperWebhooks(): Promise<Hook[]> {
  const out: Hook[] = [];
  for (let page = 1; page <= 10; page++) {
    const path = `/service/notifications/webhook?page=${page}&count=100`;
    const r = await call("zuper", "GET", `${config.zuper.apiUrl}${path}`, path, config.zuper.apiKey);
    if (!r.ok) throw new Error(`Zuper's webhook list answered ${r.status}`);
    const rows = (r.json?.data ?? []) as any[];
    for (const w of rows) {
      out.push({
        uid: String(w.webhook_uid ?? ""), module: String(w.webhook_module ?? ""), event: String(w.webhook_event ?? ""),
        url: String(w.webhook_url ?? ""), active: typeof w.is_active === "boolean" ? w.is_active : null, signed: null,
      });
    }
    if (rows.length < 100) break;
  }
  return out;
}

/** Every webhook registered in Tuper. Tuper says whether one has a secret, never what it is. */
export async function tuperWebhooks(): Promise<Hook[]> {
  const path = "/service/notifications/webhook?count=1000";
  const r = await call("tuper", "GET", `${config.tuper.url}${path}`, path, config.tuper.apiKey);
  if (!r.ok) throw new Error(`Tuper's webhook list answered ${r.status}`);
  return ((r.json?.data ?? []) as any[]).map((w) => ({
    uid: String(w.webhook_uid ?? ""), module: String(w.webhook_module ?? ""), event: String(w.webhook_event ?? ""),
    url: String(w.webhook_url ?? ""), active: w.is_active === true, signed: w.has_secret === true,
  }));
}

/** Zuper events Zupersync acts on, by module. */
export function wantedZuperEvents(): { module: string; event: string }[] {
  return Object.entries(EVENT_CATALOGUE).flatMap(([module, events]) =>
    events.filter((event) => { const r = resolveRoute(module, event); return r && !r.skip; }).map((event) => ({ module, event })));
}

/**
 * Create one Zuper webhook pointing here. The header goes as an OBJECT: Zuper stringifies it once for storage, as its
 * own form does; a pre-stringified one is stored double-encoded and never sent as a header (src/cli/webhooks.ts).
 */
async function createZuperWebhook(module: string, event: string): Promise<{ ok: boolean; detail: string }> {
  const body = {
    web_hook: {
      webhook_name: `Zupersync - ${event}`, webhook_module: module, webhook_event: event, webhook_url: ZUPER_ENDPOINT,
      request_method: "POST", content_type: "application/json",
      headers: { [config.webhook.header]: config.webhook.secret },
    },
  };
  const path = "/service/notifications/webhook";
  // The body carries the shared secret as the header's value, under a name (x-zupersync-key) the API log's masking
  // does not recognise as a credential — so the log is given a copy with the value taken out, not the body itself.
  const logged = { web_hook: { ...body.web_hook, headers: { [config.webhook.header]: "(hidden)" } } };
  const r = await call("zuper", "POST", `${config.zuper.apiUrl}${path}`, path, config.zuper.apiKey, body, logged);
  return { ok: r.ok, detail: r.ok ? String(r.json?.data?.webhook_uid ?? "created") : `HTTP ${r.status} ${r.text.slice(0, 160)}` };
}

/** Register every Zuper event Zupersync acts on that has no webhook pointing here yet. */
export async function registerMissingZuperWebhooks(): Promise<string> {
  if (!secretConfigured()) return "not run: ZUPER_WEBHOOK_SECRET is not set, so every delivery would be refused";
  const have = new Set((await zuperWebhooks()).filter((w) => w.url === ZUPER_ENDPOINT).map((w) => `${w.module}|${w.event}`));
  const missing = wantedZuperEvents().filter((t) => !have.has(`${t.module}|${t.event}`));
  if (!missing.length) return "nothing to register: every event Zupersync acts on already has its webhook";
  let made = 0;
  const failed: string[] = [];
  for (const t of missing) {
    const r = await createZuperWebhook(t.module, t.event);
    if (r.ok) made++; else failed.push(`${t.event}: ${r.detail}`);
    await new Promise((s) => setTimeout(s, 250)); // well inside Zuper's rate limit
  }
  await refreshConnections();
  return `${made} of ${missing.length} webhook(s) registered in Zuper` + (failed.length ? `; ${failed.length} failed — ${failed.slice(0, 3).join("; ")}` : "");
}

// ── traffic ──────────────────────────────────────────────────────────────────

/** A Zuper path with its ids taken out, so calls to the same endpoint count together. */
const ENDPOINT_SQL = `regexp_replace(regexp_replace(regexp_replace(split_part(c.path, '?', 1),
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '{uid}', 'g'), '/[0-9a-f]{24}', '/{id}', 'g'), '/[0-9]+(/|$)', '/{n}\\1', 'g')`;

async function traffic() {
  const links = await sql(
    `SELECT w.entity, c.system,
            CASE WHEN c.system = 'tuper' THEN coalesce(c.action, c.method || ' ' || split_part(c.path, '?', 1))
                 ELSE c.method || ' ' || ${ENDPOINT_SQL} END AS call,
            count(*)::int AS calls, count(*) FILTER (WHERE NOT c.ok)::int AS failed
       FROM sync.api_calls c JOIN sync.tuper_writes w ON w.write_id = c.write_id
      WHERE c.tenant_id = $1 AND c.at > now() - interval '24 hours' AND c.write_id IS NOT NULL
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 4 DESC`, [config.tenantId]);
  const writes = await sql(
    `SELECT entity, count(*)::int AS writes, count(*) FILTER (WHERE NOT ok)::int AS failed,
            coalesce(round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)), 0)::int AS median_ms
       FROM sync.tuper_writes WHERE tenant_id = $1 AND at > now() - interval '24 hours' AND origin IS NOT NULL
      GROUP BY entity ORDER BY writes DESC`, [config.tenantId]);
  // The service's own calls only: a command-line import can make hundreds of thousands and would bury them.
  const endpoints = await sql(
    `SELECT c.system,
            CASE WHEN c.system = 'tuper' THEN c.method || ' ' || split_part(c.path, '?', 1) ELSE c.method || ' ' || ${ENDPOINT_SQL} END AS endpoint,
            count(*)::int AS calls, count(*) FILTER (WHERE NOT c.ok)::int AS failed,
            coalesce(round(percentile_cont(0.5) WITHIN GROUP (ORDER BY c.ms)), 0)::int AS median_ms, max(c.at) AS last_at
       FROM sync.api_calls c
      WHERE c.tenant_id = $1 AND c.at > now() - interval '24 hours' AND c.origin IS NOT NULL
      GROUP BY 1, 2 ORDER BY 1, 3 DESC`, [config.tenantId]);
  return { links, writes, endpoints };
}

// ── refreshing ───────────────────────────────────────────────────────────────

async function save(kind: string, data: unknown): Promise<void> {
  await sql(
    `INSERT INTO sync.snapshots (tenant_id, kind, data, taken_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (tenant_id, kind) DO UPDATE SET data = EXCLUDED.data, taken_at = now()`,
    [config.tenantId, kind, JSON.stringify(data)]);
}

/** Measure everything the Connections page shows. A system that cannot be asked says so in its part, not by failing the rest. */
export async function refreshConnections(): Promise<string> {
  await save("catalogue", catalogue());
  const [z, t] = await Promise.allSettled([zuperWebhooks(), tuperWebhooks()]);
  const zuper = z.status === "fulfilled"
    ? { total: z.value.length, ours: z.value.filter((w) => w.url === ZUPER_ENDPOINT), others: z.value.filter((w) => w.url !== ZUPER_ENDPOINT).length }
    : { error: errorText(z.reason) };
  const tuper = t.status === "fulfilled"
    ? { total: t.value.length, ours: t.value.filter((w) => w.url === TUPER_ENDPOINT), others: t.value.filter((w) => w.url !== TUPER_ENDPOINT).length }
    : { error: errorText(t.reason) };
  await save("registrations", { zuper, tuper });
  await save("traffic", await traffic());
  const say = (x: any, name: string) => ("error" in x ? `${name}: could not be read (${x.error})` : `${name}: ${x.ours.length} pointing here`);
  const summary = `${say(zuper, "Zuper")}; ${say(tuper, "Tuper")}`;
  report("connections", { summary });
  return summary;
}

let timer: NodeJS.Timeout | null = null;

export function startConnections(): void {
  const run = () => refreshConnections().catch((err) => console.warn("[connections] could not refresh:", errorText(err)));
  setTimeout(run, 20_000).unref?.();
  timer = setInterval(run, 30 * 60_000);
  timer.unref?.();
}

export function stopConnections(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
