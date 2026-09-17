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
}

const COLUMNS =
  "id, received_at, verified, verify_reason, module, event, zuper_uid, work_order_number, sync_entity, processed_at, process_error, attempts";

export async function recentDeliveries(limit = 100, filter?: string): Promise<Delivery[]> {
  let q = db().schema("jms").from("zuper_webhook_events")
    .select(COLUMNS).eq("tenant_id", tenantId())
    .order("received_at", { ascending: false }).limit(limit);

  // Each filter answers a question someone actually asks of a sync log.
  // A deliberate skip is stored as "skipped: …" in process_error, but is not a failure.
  if (filter === "failed") q = q.not("process_error", "is", null).not("process_error", "like", "skipped:%");
  else if (filter === "skipped") q = q.like("process_error", "skipped:%");
  else if (filter === "unprocessed") q = q.is("processed_at", null).is("process_error", null);
  else if (filter === "refused") q = q.eq("verified", false);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as Delivery[];
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

export async function recentPushes(limit = 100, status?: string): Promise<Push[]> {
  let q = db().schema("jms").from("zuper_outbox")
    .select("id, queued_at, sent_at, operation, status, origin, changed, previous, planned, response, last_error, attempts")
    .eq("tenant_id", tenantId()).order("queued_at", { ascending: false }).limit(limit);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as Push[];
}

export async function pushTotals(): Promise<Record<string, number>> {
  const statuses = ["queued", "planned", "sent", "failed", "skipped"];
  const counts = await Promise.all(statuses.map((s) =>
    db().schema("jms").from("zuper_outbox").select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId()).eq("status", s)));
  return Object.fromEntries(statuses.map((s, i) => [s, counts[i].count ?? 0]));
}
