/**
 * Zuper and Tuper, record by record.
 *
 *   npm run compare                        # read-only: every kind, both sides, the differences
 *   npm run compare -- --kinds jobs,customers
 *   npm run compare -- --apply             # re-sync what is missing or behind, the way a webhook does
 *   npm run compare -- --apply --max 200   # at most 200 records this run
 *   npm run compare -- --out report.json   # the full lists, not just the counts
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
 * To Tuper page shows each). "Only in Tuper" is only ever reported: Zuper's lists leave some records out (inactive
 * users, for one), so absence from a list is not proof of deletion, and nothing is flagged deleted on that alone.
 *
 * Read-only unless --apply. The sweep does the same for a window every 30 minutes; this does it for everything.
 */

import { writeFileSync } from "node:fs";
import { config, errorText } from "../config.js";
import { flush, withCause } from "../api-log.js";
import { tuper as db } from "../tuper-client.js";
import { getSyncConfig, zuperFilterPages, zuperGet, type SyncConfig } from "../lib/migration/zuper-sync.js";
import { syncRecord } from "../processor.js";
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
  let last = "";
  for (let page = 1; page <= 2000; page++) {
    const j = await zuperGet(cfg, `${path}${path.includes("?") ? "&" : "?"}page=${page}&count=100`);
    const rows: any[] = j?.data ?? [];
    const sig = JSON.stringify(rows[0] ?? null);
    if (!rows.length || sig === last) return;   // Zuper repeats the last page past the end
    last = sig;
    yield rows;
    const total = Number(j?.total_records);
    if (rows.length < 100) return;
    if (Number.isFinite(total) && page * 100 >= total) return;
  }
}

const KINDS: Kind[] = [
  { name: "jobs", table: "jobs", event: "job.update", uid: (r) => r.job_uid,
    pages: (c) => zuperFilterPages(c, "/api/jobs/filter", 100, { sort: "ASC", sort_by: "created_at" }) },
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
  const max = Number(opt("max") ?? 1000);
  const wanted = opt("kinds")?.split(",").map((s) => s.trim());
  const kinds = wanted ? KINDS.filter((k) => wanted.includes(k.name)) : KINDS;
  const cfg = await getSyncConfig(db(), config.tenantId);
  if (!cfg.api_key) throw new Error("no Zuper API key configured");
  const pace = pacer(Number(opt("rate") ?? 60));

  const results: Result[] = [];
  const pad = (v: unknown, n: number) => String(v).padStart(n);
  console.log(`${"kind".padEnd(14)}${pad("in Zuper", 9)}${pad("in Tuper", 9)}${pad("missing", 9)}${pad("behind", 8)}${pad("only in Tuper", 15)}`);
  for (const k of kinds) {
    const started = Date.now();
    let r: Result;
    try {
      r = await compare(cfg, k, pace);
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
  if (!apply) {
    console.log(`\nREAD-ONLY. ${todo.length} record(s) missing or behind; --apply re-syncs them (at most --max, default 1000).`);
    return;
  }

  console.log(`\nRe-syncing ${Math.min(todo.length, max)} of ${todo.length} record(s)…`);
  let ok = 0, failed = 0;
  const errors = new Map<string, number>();
  await withCause({ origin: "admin" }, async () => {
    for (const item of todo.slice(0, max)) {
      const kind = KINDS.find((k) => k.name === item.kind)!;
      const route = resolveRoute("", kind.event);
      await pace();
      try {
        await syncRecord(item.kind, item.uid, { enrich: route?.enrich });
        ok++;
      } catch (err) {
        failed++;
        const e = errorText(err).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<uid>").slice(0, 120);
        errors.set(`${item.kind}: ${e}`, (errors.get(`${item.kind}: ${e}`) ?? 0) + 1);
      }
      if ((ok + failed) % 25 === 0) console.log(`  ${ok + failed} done: ${ok} written, ${failed} failed`);
    }
  });
  await flush();
  console.log(`\n${ok} written, ${failed} failed.`);
  for (const [e, n] of errors) console.log(`  ${n}× ${e}`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => { console.error(errorText(err)); process.exit(1); });
