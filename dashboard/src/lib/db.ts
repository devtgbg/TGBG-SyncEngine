/**
 * Read access to the delivery log.
 *
 * Service-role, so it bypasses RLS — which is why every query here pins
 * tenant_id explicitly rather than relying on a policy to do it.
 *
 * SECURITY: nothing in this app authenticates anyone. The rows it shows include
 * the stored webhook bodies, which carry customer names, addresses and job
 * details. That is fine for a tool running on localhost and NOT fine on a public
 * URL — put auth in front of it before deploying it anywhere reachable.
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
  if (filter === "failed") q = q.not("process_error", "is", null);
  else if (filter === "unprocessed") q = q.is("processed_at", null).is("process_error", null);
  else if (filter === "refused") q = q.eq("verified", false);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as Delivery[];
}

export interface Totals { total: number; refused: number; processed: number; failed: number; waiting: number }

/** Counts via head requests — the log can grow large and none of the rows are needed. */
export async function totals(): Promise<Totals> {
  const base = () => db().schema("jms").from("zuper_webhook_events")
    .select("id", { count: "exact", head: true }).eq("tenant_id", tenantId());

  const [all, refused, processed, failed] = await Promise.all([
    base(),
    base().eq("verified", false),
    base().not("processed_at", "is", null).is("process_error", null),
    base().not("process_error", "is", null),
  ]);

  const n = (r: { count: number | null }) => r.count ?? 0;
  const total = n(all);
  return {
    total,
    refused: n(refused),
    processed: n(processed),
    failed: n(failed),
    waiting: Math.max(0, total - n(processed) - n(failed) - n(refused)),
  };
}
