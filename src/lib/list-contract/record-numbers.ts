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
  const to = await moveToNext(client, tenantId, s, holder);
  if (s.activity) {
    const { logActivity } = await import("./threads");
    await logActivity(client, tenantId, s.activity, holder, null, "renumbered", { from: String(value), to: String(to), reason: "a record from Zuper with this number was imported" });
  }
  return { id: holder, from: String(value), to: String(to) };
}

/** Tuper's sync API names the functions a sync key may call; this is its answer for one it does not name. */
const NOT_ALLOWED = /is not a function the sync service may call/;

/**
 * Give the record the next number: jms.renumber_* does it in one call. Tuper's sync API refuses renumber_job and
 * renumber_request (its list names renumber_jobs and renumber_requests, seen 2026-09-18), which left every job Zuper
 * numbered after a Tuper-made one out of Tuper. renumber_* is exactly next_* then an update of the number (migration
 * 00076), and a sync key may call next_* and update the record, so on that refusal this does the two itself. The number
 * is decided under next_*'s lock; a record made in Tuper between the two calls could take it first, which the unique
 * index refuses — then it asks again.
 */
async function moveToNext(client: SupabaseClient, tenantId: string, s: (typeof SPEC)[NumberedKind], holder: string): Promise<string> {
  const { data, error } = await client.schema("jms").rpc(s.renumber, { p_tenant: tenantId, p_id: holder });
  if (!error) return String(data);
  if (!NOT_ALLOWED.test(error.message)) throw error;
  for (let attempt = 1; ; attempt++) {
    const next = await client.schema("jms").rpc(s.next, { p_tenant: tenantId });
    if (next.error) throw next.error;
    const to = String(next.data);
    const { error: moveError } = await client.schema("jms").from(s.table)
      .update({ [s.column]: s.column === "product_no" ? Number(to) : to }).eq("tenant_id", tenantId).eq("id", holder);
    if (!moveError) return to;
    if (moveError.code !== "23505" || attempt >= 3) throw moveError;
  }
}
