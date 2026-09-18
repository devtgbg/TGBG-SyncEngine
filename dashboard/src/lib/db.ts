/**
 * Read access to Zupersync's own store — the only database the dashboard touches.
 *
 * Everything shown is the service's own record: the webhooks it received from Zuper and from Tuper
 * (sync.webhook_events), every call it made to either system's API (sync.api_calls), and the changes queued for Zuper
 * (sync.outbox). Nothing is read from Tuper's database; the dashboard holds no key to it.
 *
 * Read-only by construction: every session starts with default_transaction_read_only, so no query here can write,
 * even over the service's own credentials. Every query pins tenant_id.
 *
 * SECURITY: the rows carry webhook bodies and API bodies — customer names, addresses and job details. Every page is
 * behind the sign-in in src/middleware.ts.
 */

import { Pool, types, type QueryResultRow } from "pg";

// A timestamp as the ISO text PostgreSQL prints, never a JS Date. A Date keeps milliseconds only, and a page pinned to
// its newest row's time would then lose any row stamped in the same millisecond. Sessions run in UTC (below).
types.setTypeParser(1184, (v: string) => v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));

const cache = globalThis as unknown as { __zupersyncStore?: Pool };

function pool(): Pool {
  if (cache.__zupersyncStore) return cache.__zupersyncStore;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set: the connection string of Zupersync's own store");
  const p = new Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    options: "-c default_transaction_read_only=on -c statement_timeout=15000 -c TimeZone=UTC",
  });
  p.on("error", (err) => console.error("[dashboard] idle store connection failed:", err.message));
  cache.__zupersyncStore = p;
  return p;
}

async function q<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await pool().query<T>(text, values)).rows;
}

export const tenantId = () => process.env.DEFAULT_TENANT_ID ?? "";

/** The call log arrives with the service version that writes it; until then its table does not exist. */
export const missingTable = (err: unknown) => (err as { code?: string })?.code === "42P01";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One page of rows, and how many rows there are in all under the same filter. */
export interface Paged<T> { rows: T[]; total: number }

export interface PageOpts {
  limit: number;
  offset: number;
  /** Only rows at or before this timestamp, so a page holds still while newer rows arrive (see pager.tsx). */
  upto?: string;
}

// ── Webhooks, from Zuper and from Tuper ──────────────────────────────────────

export type Source = "zuper" | "tuper";

export interface Delivery {
  id: string;
  source: Source;
  received_at: string;
  verified: boolean;
  verify_reason: string | null;
  module: string | null;
  event: string | null;
  zuper_uid: string | null;
  work_order_number: string | null;
  sync_entity: string | null;
  processed_at: string | null;
  process_error: string | null;
  attempts: number;
  /** Who made the change — in Zuper, or in Tuper, whose deliveries carry the same `triggered_by`. */
  by_first: string | null;
  by_last: string | null;
  by_email: string | null;
  by_role: string | null;
  by_designation: string | null;
  by_emp_code: string | null;
  by_uid: string | null;
}

/**
 * Only the few values the list shows are lifted out of the body, in the database: the list never selects a body, with
 * its customer details. The one delivery someone opens is the exception (deliveryById). Tuper's status and assignment
 * bodies carry the work order number where Zuper's column does not.
 */
const COLUMNS = `
  id, source, received_at, verified, verify_reason, module, event, zuper_uid,
  coalesce(work_order_number, body->>'work_order_number') AS work_order_number,
  sync_entity, processed_at, process_error, attempts,
  body->'triggered_by'->>'first_name' AS by_first, body->'triggered_by'->>'last_name' AS by_last,
  body->'triggered_by'->>'email' AS by_email, body->'triggered_by'->'role'->>'role_name' AS by_role,
  body->'triggered_by'->>'designation' AS by_designation, body->'triggered_by'->>'emp_code' AS by_emp_code,
  body->'triggered_by'->>'user_uid' AS by_uid`;

/** Each filter answers a question someone actually asks of a sync log. A deliberate skip is not a failure. */
function deliveryWhere(opts: { filter?: string; source?: string; upto?: string }): { where: string; values: unknown[] } {
  const values: unknown[] = [tenantId()];
  const parts = ["tenant_id = $1"];
  if (opts.source === "zuper" || opts.source === "tuper") { values.push(opts.source); parts.push(`source = $${values.length}`); }
  const f = opts.filter;
  if (f === "failed") parts.push("process_error IS NOT NULL AND process_error NOT LIKE 'skipped:%'");
  else if (f === "skipped") parts.push("process_error LIKE 'skipped:%'");
  else if (f === "unprocessed") parts.push("verified AND processed_at IS NULL AND process_error IS NULL");
  else if (f === "refused") parts.push("NOT verified");
  if (opts.upto) { values.push(opts.upto); parts.push(`received_at <= $${values.length}::timestamptz`); }
  return { where: parts.join(" AND "), values };
}

export async function deliveriesPage(opts: PageOpts & { filter?: string; source?: string }): Promise<Paged<Delivery>> {
  const { where, values } = deliveryWhere(opts);
  const [rows, count] = await Promise.all([
    // id breaks ties, so two rows stamped in the same instant never swap between pages.
    q<Delivery>(`SELECT ${COLUMNS} FROM sync.webhook_events WHERE ${where}
                 ORDER BY received_at DESC, id DESC LIMIT ${Math.trunc(opts.limit)} OFFSET ${Math.trunc(opts.offset)}`, values),
    q<{ n: number }>(`SELECT count(*)::int AS n FROM sync.webhook_events WHERE ${where}`, values),
  ]);
  return { rows, total: count[0]?.n ?? 0 };
}

export interface Totals { total: number; refused: number; processed: number; skipped: number; failed: number; waiting: number }

export async function totals(source?: string): Promise<Totals> {
  const { where, values } = deliveryWhere({ source });
  const [r] = await q<Omit<Totals, "waiting">>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE NOT verified)::int AS refused,
            count(*) FILTER (WHERE processed_at IS NOT NULL AND process_error IS NULL)::int AS processed,
            count(*) FILTER (WHERE process_error LIKE 'skipped:%')::int AS skipped,
            count(*) FILTER (WHERE process_error IS NOT NULL AND process_error NOT LIKE 'skipped:%')::int AS failed
       FROM sync.webhook_events WHERE ${where}`, values);
  const t = r ?? { total: 0, refused: 0, processed: 0, skipped: 0, failed: 0 };
  return { ...t, waiting: Math.max(0, t.total - t.processed - t.skipped - t.failed - t.refused) };
}

/** How many deliveries each system has sent, for the source filter. */
export async function sourceCounts(): Promise<Record<Source, number>> {
  const rows = await q<{ source: Source; n: number }>(
    "SELECT source, count(*)::int AS n FROM sync.webhook_events WHERE tenant_id = $1 GROUP BY source", [tenantId()]);
  return { zuper: 0, tuper: 0, ...Object.fromEntries(rows.map((r) => [r.source, r.n])) };
}

/** One delivery in full: the only delivery query that reads a body. */
export interface DeliveryDetail extends Delivery {
  /** Already masked — see maskHeaders. The stored secret never leaves this file. */
  headers: Record<string, string>;
  /** Names of the headers whose values were masked. */
  hiddenHeaders: string[];
  body: unknown;
}

/**
 * The receiver stores every request header, and one of them authenticates the delivery: Zuper's shared secret, or
 * Tuper's signature. They are masked HERE, before the row is returned, not in the component that prints them: React
 * serialises a server component's props into the page, so a secret that reaches a component is in the HTML source
 * even when nothing displays it.
 *
 * Testing this, use a production build (`next build` + `next start`). Under `next dev`, React also writes the raw rows a
 * page awaited into the payload for its developer tools, so the unmasked header shows up there and only there.
 */
const CREDENTIAL = /key|secret|token|authorization|cookie|password|signature/i;
function maskHeaders(raw: unknown): { headers: Record<string, string>; hiddenHeaders: string[] } {
  const configured = (process.env.ZUPER_WEBHOOK_HEADER ?? "x-zupersync-key").toLowerCase();
  const headers: Record<string, string> = {};
  const hiddenHeaders: string[] = [];
  const source = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  for (const name of Object.keys(source).sort()) {
    if (CREDENTIAL.test(name) || name.toLowerCase() === configured) {
      headers[name] = "(hidden)";
      hiddenHeaders.push(name);
    } else {
      headers[name] = String(source[name]);
    }
  }
  return { headers, hiddenHeaders };
}

/** Null for an id that is not a uuid or is not this tenant's — never an error page. */
export async function deliveryById(id: string): Promise<DeliveryDetail | null> {
  if (!UUID.test(id)) return null;
  const [row] = await q<Omit<DeliveryDetail, "headers" | "hiddenHeaders"> & { headers: unknown }>(
    `SELECT ${COLUMNS}, headers, body FROM sync.webhook_events WHERE tenant_id = $1 AND id = $2`, [tenantId(), id]);
  if (!row) return null;
  return { ...row, ...maskHeaders(row.headers) };
}

/**
 * User uid → name. An assignment webhook names people by uid only, and "unassigned a3945208-…" tells nobody anything.
 * Named from the deliveries each person triggered themselves, newest first; a uid that has triggered nothing stays a
 * uid.
 */
export async function userNames(uids: string[]): Promise<Record<string, string>> {
  const wanted = [...new Set(uids.filter((u) => UUID.test(u)))].slice(0, 50);
  if (!wanted.length) return {};
  const rows = await q<{ uid: string; first: string | null; last: string | null }>(
    `SELECT DISTINCT ON (uid) uid, first, last FROM (
       SELECT body->'triggered_by'->>'user_uid' AS uid, body->'triggered_by'->>'first_name' AS first,
              body->'triggered_by'->>'last_name' AS last, received_at
         FROM sync.webhook_events
        WHERE tenant_id = $1 AND (body->'triggered_by'->>'user_uid') = ANY($2::text[])) t
     ORDER BY uid, received_at DESC`, [tenantId(), wanted]);
  const out: Record<string, string> = {};
  for (const r of rows) {
    const name = [r.first, r.last].map((s) => s?.trim()).filter(Boolean).join(" ");
    if (name) out[r.uid] = name;
  }
  return out;
}

// ── Calls to Zuper's API and Tuper's ─────────────────────────────────────────

export type Origin = "webhook" | "tuper-webhook" | "replay" | "sweep" | "push" | "admin";

export interface ApiCall {
  id: string;
  at: string;
  system: Source;
  method: string;
  path: string;
  action: string | null;
  status: number | null;
  ok: boolean;
  ms: number;
  attempt: number;
  error: string | null;
  origin: Origin | null;
  event_id: string | null;
  request_bytes: number | null;
  response_bytes: number | null;
  /** The delivery that caused it, when one did. */
  cause_event: string | null;
  cause_source: Source | null;
  cause_wo: string | null;
}

export interface ApiCallDetail extends ApiCall {
  request: unknown;
  response: unknown;
}

const CALL_COLUMNS = `
  c.id::text AS id, c.at, c.system, c.method, c.path, c.action, c.status, c.ok, c.ms, c.attempt, c.error, c.origin,
  c.event_id, c.request_bytes, c.response_bytes,
  e.event AS cause_event, e.source AS cause_source, coalesce(e.work_order_number, e.body->>'work_order_number') AS cause_wo`;

export interface CallFilter { system?: string; failed?: boolean; origin?: string }

/**
 * Newest first, a page at a time by id rather than by offset: the log grows by thousands of rows an hour, and an
 * offset would slide under anyone reading an older page. One extra row says whether there is an older page.
 */
export async function callsPage(opts: CallFilter & { before?: string; limit: number }): Promise<{ rows: ApiCall[]; older: boolean }> {
  const values: unknown[] = [tenantId()];
  const parts = ["c.tenant_id = $1"];
  if (opts.system === "zuper" || opts.system === "tuper") { values.push(opts.system); parts.push(`c.system = $${values.length}`); }
  if (opts.failed) parts.push("NOT c.ok");
  if (opts.origin === "other") parts.push("c.origin IS NULL");
  else if (opts.origin) { values.push(opts.origin); parts.push(`c.origin = $${values.length}`); }
  if (opts.before && /^\d{1,19}$/.test(opts.before)) { values.push(opts.before); parts.push(`c.id < $${values.length}::bigint`); }
  const rows = await q<ApiCall>(
    `SELECT ${CALL_COLUMNS} FROM sync.api_calls c LEFT JOIN sync.webhook_events e ON e.id = c.event_id
      WHERE ${parts.join(" AND ")} ORDER BY c.id DESC LIMIT ${Math.trunc(opts.limit) + 1}`, values);
  return { rows: rows.slice(0, opts.limit), older: rows.length > opts.limit };
}

export interface CallStats { zuper: number; tuper: number; failed: number; zuper_ms: number; tuper_ms: number }

/** The last hour at a glance: how busy each API is, how slow, and how much failed. */
export async function callStats(): Promise<CallStats> {
  const [r] = await q<CallStats>(
    `SELECT count(*) FILTER (WHERE system = 'zuper')::int AS zuper,
            count(*) FILTER (WHERE system = 'tuper')::int AS tuper,
            count(*) FILTER (WHERE NOT ok)::int AS failed,
            coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) FILTER (WHERE system = 'zuper'), 0)::int AS zuper_ms,
            coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) FILTER (WHERE system = 'tuper'), 0)::int AS tuper_ms
       FROM sync.api_calls WHERE tenant_id = $1 AND at > now() - interval '1 hour'`, [tenantId()]);
  return r ?? { zuper: 0, tuper: 0, failed: 0, zuper_ms: 0, tuper_ms: 0 };
}

export async function callById(id: string): Promise<ApiCallDetail | null> {
  if (!/^\d{1,19}$/.test(id)) return null;
  const [row] = await q<ApiCallDetail>(
    `SELECT ${CALL_COLUMNS}, c.request, c.response FROM sync.api_calls c LEFT JOIN sync.webhook_events e ON e.id = c.event_id
      WHERE c.tenant_id = $1 AND c.id = $2::bigint`, [tenantId(), id]);
  return row ?? null;
}

/** The calls one delivery caused, in the order they were made. Bodies are read one call at a time (callById). */
export async function callsFor(eventId: string, limit = 300): Promise<{ rows: ApiCall[]; total: number }> {
  if (!UUID.test(eventId)) return { rows: [], total: 0 };
  const [rows, count] = await Promise.all([
    q<ApiCall>(
      `SELECT ${CALL_COLUMNS} FROM sync.api_calls c LEFT JOIN sync.webhook_events e ON e.id = c.event_id
        WHERE c.tenant_id = $1 AND c.event_id = $2 ORDER BY c.id LIMIT ${Math.trunc(limit)}`, [tenantId(), eventId]),
    q<{ n: number }>("SELECT count(*)::int AS n FROM sync.api_calls WHERE tenant_id = $1 AND event_id = $2", [tenantId(), eventId]),
  ]);
  return { rows, total: count[0]?.n ?? 0 };
}

export interface CallCount { zuper: number; tuper: number; failed: number }

/** Calls per delivery, for a page of the webhook log. Empty until the call log exists. */
export async function callCounts(eventIds: string[]): Promise<Record<string, CallCount>> {
  const ids = eventIds.filter((i) => UUID.test(i));
  if (!ids.length) return {};
  try {
    const rows = await q<CallCount & { event_id: string }>(
      `SELECT event_id::text AS event_id,
              count(*) FILTER (WHERE system = 'zuper')::int AS zuper,
              count(*) FILTER (WHERE system = 'tuper')::int AS tuper,
              count(*) FILTER (WHERE NOT ok)::int AS failed
         FROM sync.api_calls WHERE tenant_id = $1 AND event_id = ANY($2::uuid[]) GROUP BY event_id`, [tenantId(), ids]);
    return Object.fromEntries(rows.map(({ event_id, ...c }) => [event_id, c]));
  } catch (err) {
    if (missingTable(err)) return {};
    throw err;
  }
}

// ── Changes going to Zuper (sync.outbox) ─────────────────────────────────────

export interface PlannedRequest { method: string; path: string; body?: unknown; why: string }
export interface Plan {
  /** Sync entity: jobs, customers, … Absent on plans stored while only jobs were pushed. */
  entity?: string;
  /** What a person would call the record: "WO 54321", a customer's name. */
  label?: string | null;
  workOrder: string | null;
  operation: "create" | "update";
  requests: PlannedRequest[];
  notPushed: { column: string; reason: string }[];
  blocked?: string;
}
export interface Push {
  id: string;
  entity: string;
  queued_at: string;
  sent_at: string | null;
  operation: "create" | "update" | "delete";
  status: "queued" | "planned" | "sent" | "failed" | "skipped" | "superseded";
  origin: string;
  changed: Record<string, unknown>;
  previous: Record<string, unknown>;
  planned: Plan | null;
  response: unknown;
  last_error: string | null;
  attempts: number;
  zuper_uid: string | null;
  /** The Tuper delivery that queued it: its event, the job's number and title, and who made the change. */
  event_id: string | null;
  cause_event: string | null;
  cause_wo: string | null;
  cause_title: string | null;
  by_first: string | null;
  by_last: string | null;
}

const PUSH_COLUMNS = `
  o.id, o.entity, o.queued_at, o.sent_at, o.operation, o.status, o.origin, o.changed, o.previous, o.planned, o.response,
  o.last_error, o.attempts, o.zuper_uid, o.event_id,
  e.event AS cause_event, e.body->>'work_order_number' AS cause_wo, e.body->>'job_title' AS cause_title,
  e.body->'triggered_by'->>'first_name' AS by_first, e.body->'triggered_by'->>'last_name' AS by_last`;

export async function pushesPage(opts: PageOpts & { status?: string }): Promise<Paged<Push>> {
  const values: unknown[] = [tenantId()];
  const parts = ["o.tenant_id = $1"];
  if (opts.status) { values.push(opts.status); parts.push(`o.status = $${values.length}`); }
  if (opts.upto) { values.push(opts.upto); parts.push(`o.queued_at <= $${values.length}::timestamptz`); }
  const where = parts.join(" AND ");
  const [rows, count] = await Promise.all([
    q<Push>(`SELECT ${PUSH_COLUMNS} FROM sync.outbox o LEFT JOIN sync.webhook_events e ON e.id = o.event_id
              WHERE ${where} ORDER BY o.queued_at DESC, o.id DESC
              LIMIT ${Math.trunc(opts.limit)} OFFSET ${Math.trunc(opts.offset)}`, values),
    q<{ n: number }>(`SELECT count(*)::int AS n FROM sync.outbox o WHERE ${where}`, values),
  ]);
  return { rows, total: count[0]?.n ?? 0 };
}

export async function pushTotals(): Promise<Record<string, number>> {
  const rows = await q<{ status: string; n: number }>(
    "SELECT status, count(*)::int AS n FROM sync.outbox WHERE tenant_id = $1 GROUP BY status", [tenantId()]);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

// ── The service itself ───────────────────────────────────────────────────────

export interface ServiceState {
  ok: boolean;
  push: { mode: "off" | "dry-run" | "live"; sentToZuper: string[]; plannedOnly: string[] } | null;
}

let lastState: { at: number; value: ServiceState | null } = { at: 0, value: null };

/**
 * What the running service says about itself (its public /health): whether pushing to Zuper is on, and for what.
 * Asked at most every ten seconds; null when it cannot be reached, which the pages say rather than guess.
 */
export async function serviceState(): Promise<ServiceState | null> {
  if (Date.now() - lastState.at < 10_000) return lastState.value;
  const base = (process.env.ZUPERSYNC_URL ?? "https://zupersync.golfbuggyguy.com").replace(/\/+$/, "");
  let value: ServiceState | null = null;
  try {
    const res = await fetch(`${base}/health`, { cache: "no-store", signal: AbortSignal.timeout(3_000) });
    const j = (await res.json()) as { ok?: boolean; push?: ServiceState["push"] };
    value = { ok: j.ok === true, push: j.push ?? null };
  } catch { /* unreachable: said on the page */ }
  lastState = { at: Date.now(), value };
  return value;
}

// ── Live updates ─────────────────────────────────────────────────────────────

/** FNV-1a, 32-bit. A fingerprint only — nothing here needs to resist anyone. */
function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/**
 * A short value that changes whenever the newest rows of a page change: a row arriving, or one moving from waiting to
 * applied, failed or sent. The browser polls this instead of the page: one indexed query of ids and state columns, no
 * bodies, no customer data. Calls are only ever added, so the newest id is the whole story there.
 */
export async function pulse(view: "deliveries" | "pushes" | "calls"): Promise<string> {
  if (view === "calls") {
    try {
      const [r] = await q<{ v: string | null }>("SELECT max(id)::text AS v FROM sync.api_calls WHERE tenant_id = $1", [tenantId()]);
      return r?.v ?? "0";
    } catch (err) {
      if (missingTable(err)) return "none";
      throw err;
    }
  }
  const rows = view === "pushes"
    ? await q("SELECT id, status, attempts, sent_at, last_error FROM sync.outbox WHERE tenant_id = $1 ORDER BY queued_at DESC LIMIT 100", [tenantId()])
    : await q("SELECT id, verified, processed_at, process_error, attempts FROM sync.webhook_events WHERE tenant_id = $1 ORDER BY received_at DESC LIMIT 100", [tenantId()]);
  return fingerprint(JSON.stringify(rows));
}
