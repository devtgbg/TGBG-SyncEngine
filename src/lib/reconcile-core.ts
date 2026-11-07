/**
 * Zuper against Tuper, record by record — the shared core.
 *
 * Extracted from src/cli/compare.ts so the nightly reconciliation (src/nightly.ts) and the manual CLI ask the
 * SAME question of the SAME kinds. Two definitions of "what should match" would drift, and the one nobody runs
 * would be the one that was wrong.
 *
 * Read-only: every call here is a GET, or one of the POST …/filter list reads Zuper offers in place of a GET.
 * Nothing in this file writes to either system.
 */

import { config } from "../config.js";
import { tuper as db } from "../tuper-client.js";
import { zuperFilterPages, zuperGet, type SyncConfig } from "./migration/zuper-sync.js";

export interface Kind {
  name: string;
  /** Tuper's table, for telling a record flagged deleted from a live one. */
  table: string;
  /** Zuper's whole list, a page at a time. */
  pages: (cfg: SyncConfig) => AsyncGenerator<any[]>;
  uid: (row: any) => string | undefined;
  /** An event whose route says how this kind is re-synced (its detail read, and any later passes). */
  event: string;
  /** Records Zuper lists that are left out of Tuper on purpose. */
  excluded?: (row: any) => boolean;
  /** No Zuper event re-syncs this kind, so --apply must not try. Compared, never written. */
  compareOnly?: boolean;
}

/** GET list paging, as the importer pages /api/organization, /api/customers and /api/user/all. */
export async function* getPages(cfg: SyncConfig, path: string): AsyncGenerator<any[]> {
  let last = "", seen = 0;
  for (let page = 1; page <= 2000; page++) {
    const j = await zuperGet(cfg, `${path}${path.includes("?") ? "&" : "?"}page=${page}&count=100`);
    const rows: any[] = j?.data ?? [];
    const sig = JSON.stringify(rows[0] ?? null);
    if (!rows.length || sig === last) return;   // Zuper repeats the last page past the end
    last = sig;
    yield rows;
    // Some lists cap a page below `count` (users: 10), so a short page is not the end: the total is, or an empty or
    // repeated page. The first run stopped users after one page of ten and called 42 of them "only in Tuper".
    seen += rows.length;
    const total = Number(j?.total_records);
    if (Number.isFinite(total) && total > 0 && seen >= total) return;
  }
}

export const DAY = 86_400_000;
const isoSeconds = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Every job, a month of updated_at at a time, newest first. Deep in Zuper's whole job list its answers fail ("error
 * while multiplanner was selecting best plan", 500) and are retried with backoff: a first run reached page 403 of ~470
 * after four hours. By month every page is near the start of its list, where Zuper answers at once. The GET with a full
 * ISO timestamp is the one the sweep uses (sweep.ts: the POST filter ignores its filter keys).
 */
async function* jobsByMonth(cfg: SyncConfig): AsyncGenerator<any[]> {
  const start = Date.parse("2015-01-01T00:00:00Z");
  for (let to = Date.now() + 60_000; to > start; to -= 30 * DAY) {
    const q = `filter.updated_at_from=${encodeURIComponent(isoSeconds(to - 30 * DAY))}&filter.updated_at_to=${encodeURIComponent(isoSeconds(to))}`;
    for (let page = 1; page <= 200; page++) {
      const j = await zuperGet(cfg, `/api/jobs?page=${page}&count=100&${q}`);
      const rows: any[] = j?.data ?? [];
      if (rows.length) yield rows;
      const pages = Number(j?.total_pages ?? 0);
      if (rows.length < 100 || (Number.isFinite(pages) && pages > 0 && page >= pages)) break;
    }
  }
}

/** Job statuses are per category: Zuper has no account-wide list, so walk the categories. */
async function* statusesByCategory(cfg: SyncConfig): AsyncGenerator<any[]> {
  for await (const cats of getPages(cfg, "/api/jobs/category")) {
    for (const c of cats) {
      const uid = c?.category_uid;
      if (!uid) continue;
      const j = await zuperGet(cfg, `/api/jobs/status/${uid}`);
      const rows: any[] = j?.data?.job_statuses ?? j?.data ?? [];
      if (Array.isArray(rows) && rows.length) yield rows;
    }
  }
}

export const KINDS: Kind[] = [
  { name: "jobs", table: "jobs", event: "job.update", uid: (r) => r.job_uid, pages: jobsByMonth,
    // The importer refuses a job with neither ("no customer or organization"): nine such, from 2023-2025, on 2026-09-18.
    excluded: (r) => !r.customer?.customer_uid && !r.organization?.organization_uid },
  { name: "customers", table: "customers", event: "customer.update", uid: (r) => r.customer_uid, pages: (c) => getPages(c, "/api/customers") },
  { name: "organizations", table: "organizations", event: "organization.update", uid: (r) => r.organization_uid, pages: (c) => getPages(c, "/api/organization") },
  { name: "users", table: "users", event: "user.update", uid: (r) => r.user_uid, pages: (c) => getPages(c, "/api/user/all"),
    // Owner decision 2026-09-11: only active users get an account in Tuper.
    excluded: (r) => r.is_active === false },
  { name: "assets", table: "assets", event: "asset.update", uid: (r) => r.asset_uid, pages: (c) => zuperFilterPages(c, "/api/assets/filter") },
  { name: "products", table: "products", event: "product.update", uid: (r) => r.product_uid, pages: (c) => zuperFilterPages(c, "/api/product/filter") },
  { name: "contracts", table: "service_contracts", event: "service_contract.update", uid: (r) => r.contract_uid ?? r.service_contract_uid,
    pages: (c) => zuperFilterPages(c, "/api/service_contract/filter") },
  { name: "requests", table: "requests", event: "request.update", uid: (r) => r.request_uid, pages: (c) => zuperFilterPages(c, "/api/request/filter") },
  { name: "estimates", table: "quotes", event: "estimate.update", uid: (r) => r.estimate_uid, pages: (c) => zuperFilterPages(c, "/api/estimate/filter") },
  { name: "invoices", table: "invoices", event: "invoice.update", uid: (r) => r.invoice_uid, pages: (c) => zuperFilterPages(c, "/api/invoice/filter") },

  // ── The entities the sweep cannot reach ───────────────────────────────────────────────────────────────────
  // These five were absent from this comparison until 2026-11-05, which is why their drift went unseen. Three of
  // them have NO Zuper webhook and are in no sweep, so nothing else would ever notice: a renamed job category or
  // status never arrives, and the AMC Engine matches both BY NAME. recurring_jobs was last written by a one-off
  // CLI on 2026-09-22 — Zuper listed 1,398 series on 2026-11-05 against jms's 1,325.
  //
  // teams carries no updated_at in Zuper's list, so "behind" cannot be computed for it — presence only, as for
  // customers. compareOnly marks the three with no event: they are compared and reported, never auto-written.
  { name: "teams", table: "teams", event: "team.update", uid: (r) => r.team_uid, pages: (c) => getPages(c, "/api/team") },
  { name: "properties", table: "properties", event: "property.update", uid: (r) => r.property_uid, pages: (c) => getPages(c, "/api/property") },
  { name: "job_categories", table: "job_categories", event: "", compareOnly: true, uid: (r) => r.category_uid, pages: (c) => getPages(c, "/api/jobs/category") },
  { name: "job_statuses", table: "job_statuses", event: "", compareOnly: true, uid: (r) => r.status_uid, pages: statusesByCategory },
  { name: "recurring_jobs", table: "recurring_jobs", event: "", compareOnly: true, uid: (r) => r.recurring_job_uid, pages: (c) => getPages(c, "/api/recurring_jobs") },
];

/** A crude but honest pacer, as the sweep's: Zuper allows 150 requests a minute here, and live webhooks share it. */
export function pacer(perMinute: number) {
  const gap = Math.floor(60_000 / Math.max(1, perMinute));
  let last = 0;
  return async () => {
    const wait = gap - (Date.now() - last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
  };
}

/** Every Tuper record mapped to a Zuper uid of this kind. */
export async function tuperSide(entity: string): Promise<Map<string, { jms_id: string; synced_at: string }>> {
  const out = new Map<string, { jms_id: string; synced_at: string }>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db().schema("jms").from("zuper_sync_map").select("zuper_uid, jms_id, synced_at")
      .eq("tenant_id", config.tenantId).eq("entity", entity).order("zuper_uid").range(from, from + 999);
    if (error) throw error;
    for (const m of (data ?? []) as { zuper_uid: string; jms_id: string; synced_at: string }[]) out.set(m.zuper_uid, m);
    if (!data || data.length < 1000) return out;
  }
}

/** Which of these Tuper records are flagged deleted. */
async function flaggedDeleted(table: string, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await db().schema("jms").from(table).select("id, is_deleted").eq("tenant_id", config.tenantId).in("id", ids.slice(i, i + 150));
    if (error) throw error;
    for (const r of (data ?? []) as { id: string; is_deleted: boolean | null }[]) if (r.is_deleted) out.add(r.id);
  }
  return out;
}

export interface Result {
  kind: string; inZuper: number; excluded: number; inTuper: number;
  missing: string[]; behind: string[]; onlyInTuperDeleted: string[]; onlyInTuperLive: string[];
  error?: string;
}

export async function compare(cfg: SyncConfig, k: Kind, pace: () => Promise<void>): Promise<Result> {
  const r: Result = { kind: k.name, inZuper: 0, excluded: 0, inTuper: 0, missing: [], behind: [], onlyInTuperDeleted: [], onlyInTuperLive: [] };
  const zuper = new Map<string, string>();
  const excluded = new Set<string>();
  for await (const rows of k.pages(cfg)) {
    for (const row of rows) {
      const uid = k.uid(row);
      if (!uid) continue;
      if (k.excluded?.(row)) { excluded.add(uid); continue; }
      zuper.set(uid, String(row.updated_at ?? ""));
    }
    await pace();
  }
  r.inZuper = zuper.size;
  r.excluded = excluded.size;
  const tuper = await tuperSide(k.name);
  r.inTuper = tuper.size;
  for (const [uid, updatedAt] of zuper) {
    const t = tuper.get(uid);
    if (!t) r.missing.push(uid);
    // Both are ISO-8601 UTC, so they compare as strings. A list without updated_at (customers) cannot say "behind".
    else if (updatedAt && updatedAt > String(t.synced_at)) r.behind.push(uid);
  }
  const only = [...tuper.entries()].filter(([uid]) => !zuper.has(uid) && !excluded.has(uid));
  const deleted = await flaggedDeleted(k.table, only.map(([, t]) => t.jms_id));
  for (const [uid, t] of only) (deleted.has(t.jms_id) ? r.onlyInTuperDeleted : r.onlyInTuperLive).push(uid);
  return r;
}
