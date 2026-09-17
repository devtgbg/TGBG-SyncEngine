/**
 * The sweep for everything that is not a job.
 *
 * sweep.ts catches job changes whose webhook never arrived. Customers, assets,
 * notes, punches and the rest can miss a delivery just the same — during a
 * deploy, an outage longer than Zuper's retries, or before their webhooks were
 * registered — and nothing else would ever bring them back.
 *
 * Each kind is checked the cheapest way Zuper allows:
 *
 *   by updated_at   organizations, assets, products, contracts, requests, quotes,
 *                   invoices. List them, compare Zuper's updated_at with our
 *                   synced_at, and re-read (by uid) only the ones that moved or
 *                   that Tuper does not have.
 *   by value        customers. Zuper's customer list carries no updated_at (and
 *                   has no filter endpoint), so each list row is mapped exactly as
 *                   the import maps it and compared with our row, field by field.
 *   newest first    notes: the first pages of Zuper's list, for notes Tuper lacks.
 *   by window       punches and time off (collections.ts).
 *
 * The small lists (a page or two each) and notes, punches and time off run on
 * every pass. Organizations, assets, products and customers are ~100 list pages
 * together, so they run every few passes (`full`).
 */

import { config, errorText } from "./config.js";
import { tuper as db } from "./tuper-client.js";
import { customerFields, getSyncConfig, zuperFilterPages, zuperGet, type SyncConfig } from "./lib/migration/zuper-sync.js";
import { syncOne, syncRecord } from "./processor.js";
import { syncCollection } from "./collections.js";

export interface KindResult {
  kind: string;
  listed: number;
  behind: number;
  missing: number;
  resynced: number;
  failed: number;
  errors: string[];
}

type Pager = (cfg: SyncConfig) => AsyncGenerator<any[]>;

/** GET list paging, as the import pages /api/organization and /api/customers. */
async function* getPages(cfg: SyncConfig, path: string): AsyncGenerator<any[]> {
  let last = "";
  for (let page = 1; page <= 200; page++) {
    const j = await zuperGet(cfg, `${path}?page=${page}&count=100`);
    const rows: any[] = j?.data ?? [];
    const sig = JSON.stringify(rows[0] ?? null);
    if (!rows.length || sig === last) return;   // Zuper repeats the last page past the end
    last = sig;
    yield rows;
    if (rows.length < 100) return;
  }
}

interface ListSpec { entity: string; uid: (r: any) => string | undefined; pages: Pager; full: boolean }

const BY_UPDATED_AT: ListSpec[] = [
  { entity: "contracts", uid: (r) => r.contract_uid ?? r.service_contract_uid, pages: (c) => zuperFilterPages(c, "/api/service_contract/filter"), full: false },
  { entity: "requests", uid: (r) => r.request_uid, pages: (c) => zuperFilterPages(c, "/api/request/filter"), full: false },
  { entity: "estimates", uid: (r) => r.estimate_uid, pages: (c) => zuperFilterPages(c, "/api/estimate/filter"), full: false },
  { entity: "invoices", uid: (r) => r.invoice_uid, pages: (c) => zuperFilterPages(c, "/api/invoice/filter"), full: false },
  { entity: "organizations", uid: (r) => r.organization_uid, pages: (c) => getPages(c, "/api/organization"), full: true },
  { entity: "assets", uid: (r) => r.asset_uid, pages: (c) => zuperFilterPages(c, "/api/assets/filter"), full: true },
  { entity: "products", uid: (r) => r.product_uid, pages: (c) => zuperFilterPages(c, "/api/product/filter"), full: true },
];

async function syncedAt(entity: string, uids: string[]): Promise<Map<string, { jms_id: string; synced_at: string }>> {
  const out = new Map<string, { jms_id: string; synced_at: string }>();
  for (let i = 0; i < uids.length; i += 150) {
    const { data, error } = await db().schema("jms").from("zuper_sync_map").select("zuper_uid, jms_id, synced_at")
      .eq("tenant_id", config.tenantId).eq("entity", entity).in("zuper_uid", uids.slice(i, i + 150));
    if (error) throw error;
    for (const m of (data ?? []) as { zuper_uid: string; jms_id: string; synced_at: string }[]) out.set(m.zuper_uid, m);
  }
  return out;
}

const blank = (kind: string): KindResult => ({ kind, listed: 0, behind: 0, missing: 0, resynced: 0, failed: 0, errors: [] });
const fail = (r: KindResult, err: unknown) => { r.failed++; if (r.errors.length < 3) r.errors.push(errorText(err).slice(0, 140)); };

async function byUpdatedAt(cfg: SyncConfig, spec: ListSpec, o: SweepOpts): Promise<KindResult> {
  const r = blank(spec.entity);
  const rows: any[] = [];
  for await (const page of spec.pages(cfg)) { rows.push(...page); await o.pace(); }
  r.listed = rows.length;
  const uids = rows.map(spec.uid).filter(Boolean) as string[];
  const ours = await syncedAt(spec.entity, uids);
  const todo = rows.filter((row) => {
    const uid = spec.uid(row);
    if (!uid) return false;
    const m = ours.get(uid);
    if (!m) { r.missing++; return true; }
    if (String(row.updated_at ?? "") > String(m.synced_at)) { r.behind++; return true; }
    return false;
  });
  if (o.dryRun) return r;
  for (const row of todo) {
    if (o.budget() <= 0) break;
    await o.pace();
    try { await syncRecord(spec.entity, String(spec.uid(row))); r.resynced++; } catch (err) { fail(r, err); }
  }
  return r;
}

/** The columns customerFields writes that a person can change in Zuper. */
const CUSTOMER_COLUMNS = [
  "first_name", "last_name", "company_name", "email", "additional_emails", "contact_no", "accounts",
  "is_portal_enabled", "has_card_on_file", "tax_exempt", "has_sla", "do_not_service", "is_active", "is_deleted", "no_of_jobs",
];
/** Order-independent JSON, with null and missing treated alike. */
function canon(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (typeof v === "object") return `{${Object.keys(v as object).sort().filter((k) => (v as any)[k] !== undefined && (v as any)[k] !== null).map((k) => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(",")}}`;
  if (typeof v === "number") return String(Number(v.toFixed(6)));
  return JSON.stringify(v);
}

async function customers(cfg: SyncConfig, o: SweepOpts): Promise<KindResult> {
  const r = blank("customers");
  const rows: any[] = [];
  for await (const page of getPages(cfg, "/api/customers")) { rows.push(...page); await o.pace(); }
  r.listed = rows.length;
  const ours = await syncedAt("customers", rows.map((x) => x.customer_uid).filter(Boolean));
  const stored = new Map<string, Record<string, unknown>>();
  const ids = [...new Set([...ours.values()].map((m) => m.jms_id))];
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await db().schema("jms").from("customers").select(["id", ...CUSTOMER_COLUMNS].join(","))
      .eq("tenant_id", config.tenantId).in("id", ids.slice(i, i + 150));
    if (error) throw error;
    for (const row of (data ?? []) as unknown as Record<string, unknown>[]) stored.set(String(row.id), row);
  }
  const todo: any[] = [];
  for (const row of rows) {
    const m = ours.get(row.customer_uid);
    if (!m) { r.missing++; todo.push(row); continue; }
    const mine = stored.get(m.jms_id);
    const theirs: Record<string, unknown> = { ...customerFields(row), no_of_jobs: Number(row.no_of_jobs ?? 0) || 0 };
    if (!mine || CUSTOMER_COLUMNS.some((k) => canon(mine[k]) !== canon(theirs[k]))) { r.behind++; todo.push(row); }
  }
  if (o.dryRun) return r;
  for (const row of todo) {
    if (o.budget() <= 0) break;
    // The list row is what the import maps; no extra read is needed.
    try { await syncOne("customers", String(row.customer_uid), { raw: row }); r.resynced++; } catch (err) { fail(r, err); }
  }
  return r;
}

const NOTE_HOSTS = ["job", "customer", "request", "asset"];

async function notes(cfg: SyncConfig, o: SweepOpts): Promise<KindResult> {
  const r = blank("notes");
  const rows: any[] = [];
  for (let page = 1; page <= 3; page++) {
    const d: any[] = (await zuperGet(cfg, `/api/notes?page=${page}&count=100`))?.data ?? [];
    rows.push(...d);
    await o.pace();
    if (d.length < 100) break;
  }
  r.listed = rows.length;
  const ours = await syncedAt("notes", rows.map((n) => n.note_uid).filter(Boolean));
  const todo = rows.filter((n) => {
    if (!n?.note_uid || !NOTE_HOSTS.some((h) => n[h])) return false;
    const m = ours.get(n.note_uid);
    if (!m) { r.missing++; return true; }
    if (n.updated_at && String(n.updated_at) > String(m.synced_at)) { r.behind++; return true; }
    return false;
  });
  if (o.dryRun) return r;
  for (const n of todo) {
    if (o.budget() <= 0) break;
    try { await syncOne("notes", String(n.note_uid), { raw: n }); r.resynced++; } catch (err) { fail(r, err); }
  }
  return r;
}

export interface SweepOpts {
  full: boolean;
  dryRun: boolean;
  /** Waits as needed to keep under the request ceiling. */
  pace: () => Promise<void>;
  /** Re-syncs still allowed in this run. */
  budget: () => number;
}

/** Everything except jobs. Each kind fails on its own; one bad list does not stop the rest. */
export async function sweepRecords(o: SweepOpts): Promise<KindResult[]> {
  const cfg = await getSyncConfig(db(), config.tenantId);
  const out: KindResult[] = [];
  const run = async (kind: string, f: () => Promise<KindResult>) => {
    try { out.push(await f()); } catch (err) { const r = blank(kind); fail(r, err); out.push(r); }
  };

  for (const spec of BY_UPDATED_AT.filter((s) => o.full || !s.full)) await run(spec.entity, () => byUpdatedAt(cfg, spec, o));
  if (o.full) await run("customers", () => customers(cfg, o));
  await run("notes", () => notes(cfg, o));
  if (!o.dryRun) {
    for (const c of ["timesheets", "timeoff_requests"] as const) {
      await run(c, async () => {
        const res = await syncCollection(c);
        return { kind: c, listed: res.listed, behind: 0, missing: 0, resynced: res.written, failed: res.failed, errors: res.errors };
      });
    }
  }
  return out;
}
