// ── Record numbers ── a new job, contract or part is numbered by the database (migration 00076): the next available
// number — its module's Sequence Start Number, or one past the highest already used — and numbering continues from
// there. While Zuper still runs, a record imported from Zuper can arrive with a number a record made in Tuper already
// took. Zuper owns its numbers, so the Tuper-made record moves to the next number, and its activity says so.
import type { TuperClient as SupabaseClient } from "../../tuper-client.js";

export type NumberedKind = "job" | "contract" | "product" | "request";
const SPEC: Record<NumberedKind, { table: string; column: string; next: string; renumber: string; syncEntity: string; activity: "job" | "contract" | "request" | null }> = {
  job: { table: "jobs", column: "work_order_number", next: "next_job_number", renumber: "renumber_job", syncEntity: "jobs", activity: "job" },
  // Requests (00094): numbered 1, 2, 3 … as Zuper's are (parity report 14).
  request: { table: "requests", column: "request_number", next: "next_request_number", renumber: "renumber_request", syncEntity: "requests", activity: "request" },
  contract: { table: "service_contracts", column: "contract_number", next: "next_contract_number", renumber: "renumber_contract", syncEntity: "contracts", activity: "contract" },
  product: { table: "products", column: "product_no", next: "next_product_no", renumber: "renumber_product", syncEntity: "products", activity: null },
};

/** The number the next new record of this kind would get. (Reading it holds nothing — it is decided on insert.) */
export async function nextNumber(client: SupabaseClient, tenantId: string, kind: NumberedKind): Promise<string> {
  const { data, error } = await client.schema("jms").rpc(SPEC[kind].next, { p_tenant: tenantId });
  if (error) throw error;
  return String(data);
}

/**
 * Move a record made in Tuper off `value`, so a record arriving from Zuper with that number can take it. Returns what
 * moved, or null when no Tuper-made record holds the number (a record imported from Zuper is never moved).
 */
export async function releaseNumber(
  client: SupabaseClient, tenantId: string, kind: NumberedKind, value: string | number, keepId?: string,
): Promise<{ id: string; from: string; to: string } | null> {
  const s = SPEC[kind];
  let q = client.schema("jms").from(s.table).select("id").eq("tenant_id", tenantId).eq(s.column, value);
  if (keepId) q = q.neq("id", keepId);
  const { data, error } = await q.limit(1).maybeSingle();
  if (error) throw error;
  const holder = (data as { id: string } | null)?.id;
  if (!holder) return null;
  const { data: imported, error: mapError } = await client.schema("jms").from("zuper_sync_map").select("jms_id")
    .eq("tenant_id", tenantId).eq("entity", s.syncEntity).eq("jms_id", holder).limit(1).maybeSingle();
  if (mapError) throw mapError;
  if (imported) return null;
  const { data: to, error: moveError } = await client.schema("jms").rpc(s.renumber, { p_tenant: tenantId, p_id: holder });
  if (moveError) throw moveError;
  if (s.activity) {
    const { logActivity } = await import("./threads");
    await logActivity(client, tenantId, s.activity, holder, null, "renumbered", { from: String(value), to: String(to), reason: "a record from Zuper with this number was imported" });
  }
  return { id: holder, from: String(value), to: String(to) };
}
