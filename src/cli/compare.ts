/**
 * Zuper and Tuper, record by record.
 *
 *   npm run compare                        # read-only: every kind, both sides, the differences
 *   npm run compare -- --kinds jobs,customers
 *   npm run compare -- --apply             # re-sync what is missing or behind, the way a webhook does
 *   npm run compare -- --apply --max 200   # at most 200 records this run
 *   npm run compare -- --out report.json   # the full lists, not just the counts
 *   npm run compare -- --from report.json --kinds jobs --apply --deletions   # act on a saved report
 *
 * For each kind it reads Zuper's whole list (the importer's own endpoints) and every Tuper record mapped to a Zuper uid
 * (zuper_sync_map, through Tuper's API), and says:
 *   in Zuper       what Zuper lists
 *   in Tuper       what Tuper holds for a Zuper uid
 *   missing        listed by Zuper, never written to Tuper
 *   behind         Zuper changed it after Tuper last had it written (updated_at > synced_at)
 *   only in Tuper  held by Tuper, no longer listed by Zuper — split into flagged deleted, and still live
 *
 * --apply re-syncs the missing and the behind, one at a time, paced, and recorded as an admin re-sync (the dashboard's
 * To Tuper page shows each). "Only in Tuper" is left alone unless --deletions is given too, and even then absence from a
 * list is not taken as proof — Zuper's lists leave some records out (inactive users, for one). Zuper is asked for each
 * record: a 404 flags it deleted in Tuper, as the missed delete webhook would have; a record it still has is re-synced.
 *
 * Read-only unless --apply. The sweep does the same for a window every 30 minutes; this does it for everything.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { config, errorText } from "../config.js";
import { flush, withCause } from "../api-log.js";
import { tuper as db } from "../tuper-client.js";
import { getSyncConfig, zuperFilterPages, zuperGet, type SyncConfig } from "../lib/migration/zuper-sync.js";
import { markDeleted, syncRecord } from "../processor.js";
import { resolveRoute } from "../routes.js";

const argv = process.argv.slice(2);
const has = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

interface Kind {
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
}

/** GET list paging, as the importer pages /api/organization, /api/customers and /api/user/all. */
async function* getPages(cfg: SyncConfig, path: string): AsyncGenerator<any[]> {
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

const DAY = 86_400_000;
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

const KINDS: Kind[] = [
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
];

/** A crude but honest pacer, as the sweep's: Zuper allows 150 requests a minute here, and live webhooks share it. */
function pacer(perMinute: number) {
  const gap = Math.floor(60_000 / Math.max(1, perMinute));
  let last = 0;
  return async () => {
    const wait = gap - (Date.now() - last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
  };
}

/** Every Tuper record mapped to a Zuper uid of this kind. */
async function tuperSide(entity: string): Promise<Map<string, { jms_id: string; synced_at: string }>> {
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

interface Result {
  kind: string; inZuper: number; excluded: number; inTuper: number;
  missing: string[]; behind: string[]; onlyInTuperDeleted: string[]; onlyInTuperLive: string[];
  error?: string;
}

async function compare(cfg: SyncConfig, k: Kind, pace: () => Promise<void>): Promise<Result> {
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

async function main() {
  const apply = has("apply");
  const deletions = apply && has("deletions");
  const max = Number(opt("max") ?? 1000);
  const wanted = opt("kinds")?.split(",").map((s) => s.trim());
  const kinds = wanted ? KINDS.filter((k) => wanted.includes(k.name)) : KINDS;
  const cfg = await getSyncConfig(db(), config.tenantId);
  if (!cfg.api_key) throw new Error("no Zuper API key configured");
  const pace = pacer(Number(opt("rate") ?? 60));

  const results: Result[] = [];
  const pad = (v: unknown, n: number) => String(v).padStart(n);
  console.log(`${"kind".padEnd(14)}${pad("in Zuper", 9)}${pad("in Tuper", 9)}${pad("missing", 9)}${pad("behind", 8)}${pad("only in Tuper", 15)}`);
  // --from: act on a report written by an earlier --out, instead of reading both sides again.
  const from = opt("from");
  const saved: Result[] = from ? JSON.parse(readFileSync(from, "utf8")).results : [];
  for (const k of kinds) {
    const started = Date.now();
    let r: Result;
    try {
      const prior = saved.find((x) => x.kind === k.name);
      if (from && !prior) continue;
      r = prior ?? await compare(cfg, k, pace);
    } catch (err) {
      r = { kind: k.name, inZuper: 0, excluded: 0, inTuper: 0, missing: [], behind: [], onlyInTuperDeleted: [], onlyInTuperLive: [], error: errorText(err) };
    }
    results.push(r);
    const only = r.onlyInTuperDeleted.length + r.onlyInTuperLive.length;
    console.log(`${k.name.padEnd(14)}${pad(r.inZuper, 9)}${pad(r.inTuper, 9)}${pad(r.missing.length, 9)}${pad(r.behind.length, 8)}${pad(only, 15)}` +
      `${only ? `  (${r.onlyInTuperLive.length} live, ${r.onlyInTuperDeleted.length} flagged deleted)` : ""}` +
      `${r.excluded ? `  ${r.excluded} excluded on purpose` : ""}${r.error ? `  ERROR ${r.error}` : ""}  ${Math.round((Date.now() - started) / 1000)}s`);
  }

  const out = opt("out");
  if (out) { writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), results }, null, 2)); console.log(`\nfull lists: ${out}`); }

  const todo = results.flatMap((r) => [...r.missing, ...r.behind].map((uid) => ({ kind: r.kind, uid })));
  const gone = deletions ? results.flatMap((r) => r.onlyInTuperLive.map((uid) => ({ kind: r.kind, uid }))) : [];
  if (!apply) {
    const live = results.reduce((n, r) => n + r.onlyInTuperLive.length, 0);
    console.log(`
READ-ONLY. ${todo.length} record(s) missing or behind: --apply re-syncs them (at most --max, default 1000).`);
    if (live) console.log(`${live} live in Tuper but not listed by Zuper: --apply --deletions asks Zuper for each, and flags deleted only those it answers 404 for.`);
    return;
  }

  let written = 0, flagged = 0, stillThere = 0, failed = 0;
  const errors = new Map<string, number>();
  const fail = (kind: string, err: unknown) => {
    failed++;
    const e = `${kind}: ${errorText(err).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<uid>").slice(0, 120)}`;
    errors.set(e, (errors.get(e) ?? 0) + 1);
  };
  await withCause({ origin: "admin" }, async () => {
    console.log(`
Re-syncing ${Math.min(todo.length, max)} of ${todo.length} record(s) missing or behind…`);
    for (const item of todo.slice(0, max)) {
      const route = resolveRoute("", KINDS.find((k) => k.name === item.kind)!.event);
      await pace();
      try { await syncRecord(item.kind, item.uid, { enrich: route?.enrich }); written++; } catch (err) { fail(item.kind, err); }
      if ((written + failed) % 25 === 0) console.log(`  ${written + failed} done: ${written} written, ${failed} failed`);
    }
    if (!gone.length) return;
    // Absent from Zuper's list is not proof on its own; Zuper's own answer for the record is. 404: what a missed delete
    // webhook would have done, the record flagged deleted in Tuper. 200: Zuper has it after all, so it is re-synced.
    console.log(`
Asking Zuper about ${gone.length} record(s) live in Tuper but not in its list…`);
    for (const item of gone) {
      const kind = KINDS.find((k) => k.name === item.kind)!;
      const route = resolveRoute("", kind.event);
      const detail = route?.detail;
      if (!detail) continue;
      await pace();
      let status = 0;
      try { await zuperGet(cfg, detail(item.uid)); status = 200; } catch (err) { status = Number(/→ (\d{3})/.exec(errorText(err))?.[1] ?? 0); }
      try {
        if (status === 404) { if ((await markDeleted(item.kind, item.uid)).action === "deleted") flagged++; }
        else if (status === 200) { await syncRecord(item.kind, item.uid, { enrich: route?.enrich }); stillThere++; }
        else throw new Error(`Zuper answered ${status || "nothing"} — left as it is`);
      } catch (err) { fail(item.kind, err); }
    }
  });
  await flush();
  console.log(`
${written} re-synced, ${flagged} flagged deleted (Zuper 404), ${stillThere} still in Zuper and re-synced, ${failed} failed.`);
  for (const [e, n] of errors) console.log(`  ${n}× ${e}`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => { console.error(errorText(err)); process.exit(1); });
