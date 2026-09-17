/**
 * Read access to the delivery log.
 *
 * Service-role, so it bypasses RLS — which is why every query here pins
 * tenant_id explicitly rather than relying on a policy to do it.
 *
 * SECURITY: the rows shown include stored webhook bodies and planned Zuper
 * requests, which carry customer names, addresses and job details. Every page
 * is behind the sign-in in src/middleware.ts.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

export const tenantId = () => process.env.DEFAULT_TENANT_ID ?? "";

export interface Delivery {
  id: string;
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
  /** Who made the change in Zuper — null on a delivery that names nobody. */
  by_first: string | null;
  by_last: string | null;
  by_email: string | null;
  by_role: string | null;
  by_designation: string | null;
  by_emp_code: string | null;
  by_uid: string | null;
}

/**
 * Every genuine Zuper delivery carries `triggered_by`: the person whose action
 * fired it. The sync never reads it (the record is re-fetched), so the stored
 * body is the only place it lives. Only these seven values are lifted out, in the
 * database — the body itself, with its customer details, is never selected.
 *
 * A change made through Zuper's API shows the account that owns the API key,
 * so an integration's writes appear under that account's name.
 */
const COLUMNS =
  "id, received_at, verified, verify_reason, module, event, zuper_uid, work_order_number, sync_entity, processed_at, process_error, attempts, " +
  "by_first:body->triggered_by->>first_name, by_last:body->triggered_by->>last_name, " +
  "by_email:body->triggered_by->>email, by_role:body->triggered_by->role->>role_name, " +
  "by_designation:body->triggered_by->>designation, by_emp_code:body->triggered_by->>emp_code, by_uid:body->triggered_by->>user_uid";

/** One page of rows, and how many rows there are in all under the same filter. */
export interface Paged<T> { rows: T[]; total: number }

export interface PageOpts {
  limit: number;
  offset: number;
  /**
   * Only rows at or before this timestamp. Older pages carry it so that a
   * delivery arriving while someone reads page 3 does not push every row down
   * by one. Passed through exactly as the database gave it: a round trip through
   * a JS Date would drop the microseconds and lose the newest row.
   */
  upto?: string;
}

/** PostgREST answers 416 for an offset past the last row; that is an empty page, not a failure. */
const PAST_THE_END = "PGRST103";

export async function deliveriesPage(opts: PageOpts & { filter?: string }): Promise<Paged<Delivery>> {
  const build = (columns: string, head: boolean) => {
    let q = db().schema("jms").from("zuper_webhook_events")
      .select(columns, { count: "exact", head }).eq("tenant_id", tenantId());

    // Each filter answers a question someone actually asks of a sync log.
    // A deliberate skip is stored as "skipped: …" in process_error, but is not a failure.
    const f = opts.filter;
    if (f === "failed") q = q.not("process_error", "is", null).not("process_error", "like", "skipped:%");
    else if (f === "skipped") q = q.like("process_error", "skipped:%");
    else if (f === "unprocessed") q = q.is("processed_at", null).is("process_error", null);
    else if (f === "refused") q = q.eq("verified", false);

    if (opts.upto) q = q.lte("received_at", opts.upto);
    return q;
  };

  // id breaks ties, so two rows stamped in the same instant never swap between pages.
  const { data, error, count } = await build(COLUMNS, false)
    .order("received_at", { ascending: false }).order("id", { ascending: false })
    .range(opts.offset, opts.offset + opts.limit - 1);
  if (error) {
    if (error.code !== PAST_THE_END) throw error;
    const c = await build("id", true);
    if (c.error) throw c.error;
    return { rows: [], total: c.count ?? 0 };
  }
  return { rows: (data ?? []) as unknown as Delivery[], total: count ?? 0 };
}

export interface Totals { total: number; refused: number; processed: number; skipped: number; failed: number; waiting: number }

/** Counts via head requests — the log can grow large and none of the rows are needed. */
export async function totals(): Promise<Totals> {
  const base = () => db().schema("jms").from("zuper_webhook_events")
    .select("id", { count: "exact", head: true }).eq("tenant_id", tenantId());

  const [all, refused, processed, skipped, failed] = await Promise.all([
    base(),
    base().eq("verified", false),
    base().not("processed_at", "is", null).is("process_error", null),
    base().like("process_error", "skipped:%"),
    base().not("process_error", "is", null).not("process_error", "like", "skipped:%"),
  ]);

  const n = (r: { count: number | null }) => r.count ?? 0;
  const total = n(all);
  return {
    total,
    refused: n(refused),
    processed: n(processed),
    skipped: n(skipped),
    failed: n(failed),
    waiting: Math.max(0, total - n(processed) - n(skipped) - n(failed) - n(refused)),
  };
}

// ── Pushes to Zuper (jms.zuper_outbox) ───────────────────────────────────────

export interface PlannedRequest { method: string; path: string; body?: unknown; why: string }
export interface Plan {
  workOrder: string | null;
  operation: "create" | "update";
  requests: PlannedRequest[];
  notPushed: { column: string; reason: string }[];
  blocked?: string;
}
export interface Push {
  id: string;
  queued_at: string;
  sent_at: string | null;
  operation: "create" | "update";
  status: "queued" | "planned" | "sent" | "failed" | "skipped" | "superseded";
  origin: string;
  changed: Record<string, unknown>;
  previous: Record<string, unknown>;
  planned: Plan | null;
  response: unknown;
  last_error: string | null;
  attempts: number;
}

const PUSH_COLUMNS =
  "id, queued_at, sent_at, operation, status, origin, changed, previous, planned, response, last_error, attempts";

export async function pushesPage(opts: PageOpts & { status?: string }): Promise<Paged<Push>> {
  const build = (columns: string, head: boolean) => {
    let q = db().schema("jms").from("zuper_outbox")
      .select(columns, { count: "exact", head }).eq("tenant_id", tenantId());
    if (opts.status) q = q.eq("status", opts.status);
    if (opts.upto) q = q.lte("queued_at", opts.upto);
    return q;
  };

  const { data, error, count } = await build(PUSH_COLUMNS, false)
    .order("queued_at", { ascending: false }).order("id", { ascending: false })
    .range(opts.offset, opts.offset + opts.limit - 1);
  if (error) {
    if (error.code !== PAST_THE_END) throw error;
    const c = await build("id", true);
    if (c.error) throw c.error;
    return { rows: [], total: c.count ?? 0 };
  }
  return { rows: (data ?? []) as unknown as Push[], total: count ?? 0 };
}

export async function pushTotals(): Promise<Record<string, number>> {
  const statuses = ["queued", "planned", "sent", "failed", "skipped"];
  const counts = await Promise.all(statuses.map((s) =>
    db().schema("jms").from("zuper_outbox").select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId()).eq("status", s)));
  return Object.fromEntries(statuses.map((s, i) => [s, counts[i].count ?? 0]));
}

// ── Live updates ─────────────────────────────────────────────────────────────

/** FNV-1a, 32-bit. A fingerprint only — nothing here needs to resist anyone. */
function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/**
 * A short value that changes whenever the newest 100 rows of a page change: a
 * row arriving, or one moving from waiting to applied, failed or sent.
 *
 * The browser polls this instead of the page. It is one indexed query returning
 * ids and state columns — no bodies, no customer data — where a page render is
 * the row query plus five or six exact counts. Neither table has a maintained
 * updated_at (no trigger sets it), so the state columns themselves are hashed.
 *
 * A change to a row older than the newest 100 does not move it; the browser
 * also re-renders once a minute, which picks those up.
 */
export async function pulse(page: "deliveries" | "pushes"): Promise<string> {
  if (page === "pushes") {
    const { data, error } = await db().schema("jms").from("zuper_outbox")
      .select("id, status, attempts, sent_at, last_error")
      .eq("tenant_id", tenantId()).order("queued_at", { ascending: false }).limit(100);
    if (error) throw error;
    return fingerprint(JSON.stringify(data ?? []));
  }
  const { data, error } = await db().schema("jms").from("zuper_webhook_events")
    .select("id, verified, processed_at, process_error, attempts")
    .eq("tenant_id", tenantId()).order("received_at", { ascending: false }).limit(100);
  if (error) throw error;
  return fingerprint(JSON.stringify(data ?? []));
}
