/**
 * Every record written to Tuper, one row each (sync.tuper_writes) — the mirror of the outbox, which holds what goes to
 * Zuper. The dashboard's "To Tuper" page reads it.
 *
 * A write is whatever turns one Zuper record into Tuper rows: a job with its details and activity, a customer, a
 * deletion, one note host's notes, one pass over the recent punches. The outermost is the one recorded — a job's three
 * passes are one row — and every API call made inside it carries its id (sync.api_calls.write_id), so the page can list
 * exactly what writing that record took.
 *
 * Recording never changes the work: a write that throws still throws, after its row says why.
 */
import { randomUUID } from "node:crypto";
import { config, errorText } from "./config.js";
import { currentCause, inWrite, logWrite, type WriteTally } from "./api-log.js";

export interface WriteOutcome {
  action: string;
  /** The record's id in Tuper, when it has one. */
  id?: string | null;
  label?: string | null;
  detail?: string | null;
  /** For a pass over many records that finished with some of them failing. */
  ok?: boolean;
  error?: string | null;
}

/**
 * Run `fn` as the writing of one record into Tuper, and record it. Inside another write it is only `fn`: the outer one
 * is the record, and its calls count towards it.
 */
export async function trackWrite<T>(
  what: { entity: string; uid?: string | null; label?: string | null },
  fn: () => Promise<T>,
  outcome: (result: T) => WriteOutcome = (r) => r as unknown as WriteOutcome,
): Promise<T> {
  if (!config.apiLog.enabled || currentCause()?.write) return fn();
  const tally: WriteTally = { id: randomUUID(), label: what.label ?? null, tuperId: null, zuper: 0, tuper: 0, failed: 0 };
  const started = Date.now();
  const record = (o: { ok: boolean; action: string; id?: string | null; label?: string | null; detail?: string | null; error?: string | null }) => {
    const c = currentCause();
    logWrite({
      write_id: tally.id, at: new Date(started).toISOString(), ms: Date.now() - started,
      entity: what.entity, zuper_uid: what.uid ?? null, tuper_id: o.id ?? tally.tuperId,
      label: (o.label ?? tally.label)?.slice(0, 200) ?? null, action: o.action, ok: o.ok,
      error: o.error ? o.error.slice(0, 500) : null, detail: o.detail?.slice(0, 500) ?? null,
      origin: c?.origin ?? null, event_id: c?.eventId ?? null,
      zuper_calls: tally.zuper, tuper_calls: tally.tuper, failed_calls: tally.failed,
    });
  };
  let result: T;
  try {
    result = await inWrite(tally, fn);
  } catch (err) {
    record({ ok: false, action: "failed", error: errorText(err) });
    throw err;
  }
  try {
    const o = outcome(result);
    record({ ok: o?.ok ?? true, action: o?.action ?? "written", id: o?.id ?? null, label: o?.label ?? null, detail: o?.detail ?? null, error: o?.error ?? null });
  } catch { /* describing the outcome must never fail the write */ }
  return result;
}

/**
 * Tell the write in progress what the record is, as soon as that is known — the record read from Zuper, or the id it
 * got in Tuper — so even a write that fails later says which record it was. The first name given stands: that is the
 * record the write is about, not one of the records it touches on the way.
 */
export function noteRecord(entity: string, raw: unknown, tuperId?: string | null): void {
  const w = currentCause()?.write;
  if (!w) return;
  if (!w.label) w.label = labelOf(entity, raw);
  if (tuperId && !w.tuperId) w.tuperId = tuperId;
}

const s = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const join = (...parts: unknown[]) => parts.map(s).filter(Boolean).join(" ");

/** What a person would call a Zuper record: a job's work order number, a customer's name, a quote's number. */
export function labelOf(entity: string, raw: unknown): string | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  switch (entity) {
    case "jobs": case "job_details": case "job_activity":
      return r.work_order_number != null ? `job ${s(r.work_order_number)}` : s(r.job_title) || null;
    case "customers":
      return join(r.customer_first_name, r.customer_last_name) || s(r.customer_company_name) || null;
    case "organizations": return s(r.organization_name) || null;
    // The default below would look for "propertie_name" — so properties say their own name.
    case "properties": return s(r.property_name) || null;
    case "users": return join(r.first_name, r.last_name) || s(r.email) || null;
    case "assets": return join(r.asset_name, r.asset_code ? `(${s(r.asset_code)})` : "") || null;
    case "products": return s(r.product_name) || null;
    case "estimates": case "estimate_activity":
      return r.estimate_number != null ? `quote ${join(r.prefix, r.estimate_number)}` : null;
    case "invoices": return r.invoice_number != null ? `invoice ${join(r.prefix, r.invoice_number)}` : null;
    case "contracts": return s(r.contract_name) || (r.contract_number != null ? `contract ${s(r.contract_number)}` : null);
    case "requests": return r.request_number != null ? `request ${s(r.request_number)}` : s(r.request_title) || null;
    case "notes": {
      const text = s(r.note).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return text ? `note “${text.slice(0, 40)}${text.length > 40 ? "…" : ""}”` : null;
    }
    default: {
      for (const k of ["name", "title", `${entity.replace(/s$/, "")}_name`, "label"]) if (s(r[k])) return s(r[k]);
      return null;
    }
  }
}
