/**
 * Zuper and Tuper, record by record.
 *
 *   npm run compare                        # read-only: every kind, both sides, the differences
 *   npm run compare -- --kinds jobs,customers
 *   npm run compare -- --apply             # re-sync what is missing or behind, the way a webhook does
 *   npm run compare -- --apply --max 200   # at most 200 records this run
 *   npm run compare -- --out report.json   # the full lists, not just the counts
 *   npm run compare -- --from report.json --kinds jobs --apply --deletions   # act on a saved report
 *   npm run compare:fields                 # read-only: the same record from each API, field by field
 *
 * Two questions, two modes. Without --fields it asks WHICH RECORDS each system has. With --fields it asks, for a
 * sample of records both hold, WHETHER THE TWO APIS ANSWER THE SAME THING about them — see "Field parity" below.
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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config, errorText } from "../config.js";
import { flush, withCause } from "../api-log.js";
import { tuper as db } from "../tuper-client.js";
import { getSyncConfig, zuperFilterPages, zuperGet, type SyncConfig } from "../lib/migration/zuper-sync.js";
import { markDeleted, syncRecord } from "../processor.js";
import { resolveRoute } from "../routes.js";
import { diffRecords, CERTAIN, UNCERTAIN, type Diff, type DiffClass } from "../lib/field-diff.js";

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

// ── Field parity (--fields) ─────────────────────────────────────────────────────────────────────────────────
//
// The other mode answers "does Tuper have this record?". This one answers "do the two APIs say the same thing
// about it?" — which is the question the parity checks in Tuper cannot answer, because they assert Zuper's
// DOCUMENTED envelope rather than the owner's actual account.
//
// It is read-only on both sides, and can only be read-only: every call it makes is a GET, or one of the POST
// …/filter list reads Zuper offers instead of a GET (they take a page and a filter and return records; they
// create nothing). Nothing here calls syncRecord, markDeleted or any other write path.
//
// How a record is chosen. Two halves, because they catch different things:
//   • the first page of Zuper's own list, in whatever order Zuper returns it — records picked by Zuper rather than
//     by us, including ones Tuper may never have been given. A uid from here that Tuper answers 404 for is recorded
//     as a record Tuper does not have, not as a field difference.
//   • a random draw from jms.zuper_sync_map, ordered by zuper_uid (uuids, so the order carries no meaning and the
//     draw is even) — records both systems certainly hold, across the whole history rather than this week's.
//
// What it will not claim. Where the comparison itself cannot settle a difference — an id each system is entitled
// to answer differently, a date against a timestamp, records of an array with no uid to pair them by — the
// difference is reported under `uncertain` with the reason, never counted as a field that disagrees.

interface Answer { ok: boolean; status: number; record?: unknown; error?: string }

/** Tuper's public API — the same paths Zuper serves, on Tuper's host, with the sync key. GET only. */
async function tuperRead(path: string, body?: unknown): Promise<Answer> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${config.tuper.url}${path}`, {
        method: body ? "POST" : "GET",
        headers: { "x-api-key": config.tuper.apiKey, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      // An HTML page means the request never reached the API (a proxy's 502 mid-deploy) — ask again rather than
      // record a difference that is really a deploy.
      if (/^\s*<(!doctype|html)/i.test(text) && attempt < 4) { await new Promise((r) => setTimeout(r, 2000 * attempt)); continue; }
      let parsed: any = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* not json */ }
      if (!res.ok) return { ok: false, status: res.status, error: parsed?.message ?? text.slice(0, 160) };
      return { ok: true, status: res.status, record: parsed?.data ?? parsed };
    } catch (err) {
      if (attempt >= 3) return { ok: false, status: 0, error: errorText(err) };
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

/** Zuper, through the engine's own retrying client. The status is dug out of its message so a 404 reads as one. */
async function zuperRead(cfg: SyncConfig, path: string): Promise<Answer> {
  try {
    const body = await zuperGet(cfg, path);
    return { ok: true, status: 200, record: body?.data ?? body };
  } catch (err) {
    const text = errorText(err);
    return { ok: false, status: Number(/→ (\d{3})/.exec(text)?.[1] ?? 0), error: text };
  }
}

interface FieldKind {
  name: string;
  /** What the records are called, for the readable summary. */
  label: string;
  /** The entity in jms.zuper_sync_map, for the random half of the sample. */
  entity?: string;
  /** The path both systems answer for one record. */
  path?: (uid: string) => string;
  /** Zuper's path, when it is not Tuper's (products: Zuper serves /api/product/{uid}, not /api/products/{uid}). */
  zuperPath?: (uid: string) => string;
  /** The first page of Zuper's own list, for the newest few. */
  list?: (cfg: SyncConfig) => Promise<any[]>;
  uid?: (row: any) => string | undefined;
  /** Kinds Zuper serves only as a list: both sides are read whole and the rows paired by uid. */
  pair?: (cfg: SyncConfig) => Promise<{ zuper: any[]; tuper: any[]; uid: (row: any) => string | undefined; how: string }>;
  /** Anything a reader of the report needs to know about this kind. */
  note?: string;
}

const firstPage = async (cfg: SyncConfig, path: string) => (await zuperGet(cfg, `${path}${path.includes("?") ? "&" : "?"}page=1&count=50`))?.data ?? [];
const firstFilterPage = async (cfg: SyncConfig, path: string) => { for await (const rows of zuperFilterPages(cfg, path, 50)) return rows; return []; };

const FIELD_KINDS: FieldKind[] = [
  { name: "jobs", label: "jobs", entity: "jobs", path: (u) => `/api/jobs/${u}`, uid: (r) => r.job_uid, list: (c) => firstPage(c, "/api/jobs") },
  { name: "customers", label: "customers", entity: "customers", path: (u) => `/api/customers/${u}`, uid: (r) => r.customer_uid, list: (c) => firstPage(c, "/api/customers") },
  { name: "organizations", label: "organizations", entity: "organizations", path: (u) => `/api/organization/${u}`, uid: (r) => r.organization_uid, list: (c) => firstPage(c, "/api/organization") },
  { name: "users", label: "users", entity: "users", path: (u) => `/api/user/${u}`, uid: (r) => r.user_uid, list: (c) => firstPage(c, "/api/user/all"),
    note: "only active users are given a Tuper account (owner decision 2026-09-11), so an inactive user from Zuper's list is recorded as not found rather than as a difference" },
  { name: "teams", label: "teams", entity: "teams", path: (u) => `/api/team/${u}`, uid: (r) => r.team_uid, list: (c) => firstPage(c, "/api/team"),
    note: "the record is the whole { team, users } envelope Zuper answers for a team, both sides compared as sent" },
  { name: "assets", label: "assets", entity: "assets", path: (u) => `/api/assets/${u}`, uid: (r) => r.asset_uid, list: (c) => firstFilterPage(c, "/api/assets/filter") },
  { name: "products", label: "parts and services", entity: "products", path: (u) => `/api/products/${u}`, zuperPath: (u) => `/api/product/${u}`,
    uid: (r) => r.product_uid, list: (c) => firstFilterPage(c, "/api/product/filter"),
    note: "Zuper serves a product at /api/product/{uid} (singular) and answers 404 at /api/products/{uid}; Tuper answers both" },
  { name: "requests", label: "requests", entity: "requests", path: (u) => `/api/request/${u}`, uid: (r) => r.request_uid, list: (c) => firstFilterPage(c, "/api/request/filter") },
  { name: "estimates", label: "quotes", entity: "estimates", path: (u) => `/api/estimate/${u}`, uid: (r) => r.estimate_uid, list: (c) => firstFilterPage(c, "/api/estimate/filter") },
  { name: "invoices", label: "invoices", entity: "invoices", path: (u) => `/api/invoice/${u}`, uid: (r) => r.invoice_uid, list: (c) => firstFilterPage(c, "/api/invoice/filter") },
  { name: "contracts", label: "service contracts", entity: "contracts", path: (u) => `/api/service_contract/${u}`,
    uid: (r) => r.contract_uid ?? r.service_contract_uid, list: (c) => firstFilterPage(c, "/api/service_contract/filter") },

  // Zuper publishes no read-by-uid for these three, so the lists are read whole and the rows paired by their uid.
  { name: "timesheets", label: "timesheet punches", note: "Zuper lists punches at POST /api/timesheets/filter; Tuper's equivalent list is GET /api/timesheets, whose rows arrive under data.timesheets. The window is the last 30 days on both sides.",
    pair: async (cfg) => {
      const DAYS = 30;
      const dubaiDate = (t: number) => new Date(t + 4 * 3_600_000).toISOString().slice(0, 10);
      const from = dubaiDate(Date.now() - DAYS * DAY), to = dubaiDate(Date.now());
      const window = { count: 100, preferred_timezone: "Asia/Dubai", filter_rule_operator: "AND", "filter.from_date": from, "filter.to_date": to };
      const zuper: any[] = [];
      for await (const rows of zuperFilterPages(cfg, "/api/timesheets/filter", 100, window)) { zuper.push(...rows); if (zuper.length >= 500) break; }
      const tuper: any[] = [];
      for (let page = 1; page <= 10; page++) {
        const a = await tuperRead(`/api/timesheets?page=${page}&count=100&filter.from_date=${from}&filter.to_date=${to}`);
        const rows: any[] = (a.record as any)?.timesheets ?? (Array.isArray(a.record) ? a.record : []);
        tuper.push(...rows);
        if (rows.length < 100) break;
      }
      return { zuper, tuper, uid: (r) => r.employee_timesheet_uid, how: `punches between ${from} and ${to}` };
    } },
  { name: "timeoff_requests", label: "time off requests",
    pair: async (cfg) => ({
      zuper: (await zuperGet(cfg, "/api/timesheets/request/timeoff"))?.data ?? [],
      tuper: ((await tuperRead("/api/timesheets/request/timeoff")).record as any[]) ?? [],
      uid: (r) => r.request_uid, how: "the whole list from each side (GET /api/timesheets/request/timeoff)",
    }) },
  { name: "timeoff_types", label: "time off types",
    pair: async (cfg) => ({
      zuper: (await zuperGet(cfg, "/api/timesheet/request/timeoff_type"))?.data ?? [],
      tuper: ((await tuperRead("/api/timesheet/request/timeoff_type")).record as any[]) ?? [],
      uid: (r) => r.timeoff_request_type_uid, how: "the whole list from each side (GET /api/timesheet/request/timeoff_type)",
    }) },
];

/**
 * The instrument measured against known answers, with no network at all: `npm run compare:fields -- --self-test`.
 *
 * Every case below is a pair a real run meets. The ones that must come back clean are the ways two systems write the
 * same fact; the ones that must be found are the ways they disagree. If this does not pass, no run's output means
 * anything, so it runs before every comparison as well as on its own.
 */
function selfTest(): { passed: number; failed: string[] } {
  const failed: string[] = [];
  let passed = 0;
  const only = (z: unknown, t: unknown) => diffRecords(z, t).map((d) => `${d.path}:${d.class}`).sort();
  const check = (what: string, z: unknown, t: unknown, want: string[]) => {
    const got = only(z, t);
    if (got.join(",") === want.join(",")) passed++;
    else failed.push(`${what}: expected [${want.join(", ")}], got [${got.join(", ")}]`);
  };

  // Said the same, written differently — nothing to report.
  check("the same record", { a: 1, b: [{ uid: "u1", n: "x" }] }, { a: 1, b: [{ uid: "u1", n: "x" }] }, []);
  check("money as a string", { total: 0 }, { total: "0.00" }, ["total:same_number"]);
  check("the same instant", { at: "2026-09-18T06:00:00.000Z" }, { at: "2026-09-18T06:00:00Z" }, ["at:same_instant"]);
  check("a flag as a string", { on: true }, { on: "true" }, ["on:same_boolean"]);
  check("an array re-ordered", { xs: [{ uid: "b" }, { uid: "a" }] }, { xs: [{ uid: "a" }, { uid: "b" }] }, []);
  check("scalars re-ordered", { tags: ["b", "a"] }, { tags: ["a", "b"] }, []);
  check("an array paired by a uid one level down",
    { xs: [{ user: { user_uid: "a" }, n: 1 }, { user: { user_uid: "b" }, n: 2 }] },
    { xs: [{ user: { user_uid: "b" }, n: 2 }, { user: { user_uid: "a" }, n: 1 }] }, []);
  check("empty written two ways", { note: null }, { note: "" }, ["note:empty_shape"]);
  check("spacing", { name: "  Ada  Lovelace " }, { name: "Ada Lovelace" }, ["name:whitespace"]);

  // Disagreed — must be found, and named for what it is.
  check("a value", { city: "Dubai" }, { city: "Abu Dhabi" }, ["city:value"]);
  check("a number", { total: 10 }, { total: "10.5" }, ["total:value"]);
  check("Tuper leaves a field out", { business_unit: { name: "GBG" } }, {}, ["business_unit:missing_in_tuper"]);
  check("Tuper adds a field", {}, { recurring_job: { uid: "r1" } }, ["recurring_job:extra_in_tuper"]);
  check("an array record Tuper has not", { xs: [{ uid: "a" }, { uid: "b" }] }, { xs: [{ uid: "a" }] }, ["xs[]:element_missing"]);
  check("arrays of different length, nothing to pair by", { xs: [{ n: 1 }, { n: 2 }] }, { xs: [{ n: 9 }] }, ["xs[]:array_length"]);
  check("a flag flipped", { active: true }, { active: false }, ["active:value"]);
  check("one side blank", { email: "a@b.c" }, { email: "" }, ["email:value"]);

  // Found, but not to be trusted as a plain difference.
  check("each system's own id", { line: { _id: "61090ab91049a1576b034496" } }, { line: { _id: "12fcf392-ddab-4736-9842-04d3a43c6d49" } }, ["line._id:id"]);
  check("each system's own host", { url: "https://a.zuperpro.com/j/1" }, { url: "https://b.tuper.golfbuggyguy.com/j/1" }, ["url:url_host"]);
  check("a date against a timestamp", { due: "2026-09-18" }, { due: "2026-09-18T09:30:00.000Z" }, ["due:date_precision"]);
  check("the same words, different markup", { d: "<p>Hello</p>" }, { d: "<div>Hello</div>" }, ["d:markup"]);
  check("one side sends it empty", { xs: [] }, {}, ["xs:empty_field"]);
  check("no key to pair array records by", { xs: [{ n: 1, v: "a" }] }, { xs: [{ n: 1, v: "b" }] }, ["xs[].v:positional"]);

  // A uid in a field that is not an id is a real difference, not an id the systems may differ on.
  check("a uid where a name belongs", { owner: "11111111-1111-1111-1111-111111111111" }, { owner: "22222222-2222-2222-2222-222222222222" }, ["owner:value"]);
  return { passed, failed };
}

/** A random, even draw of uids both systems hold — zuper_sync_map ordered by uuid, so the order carries no meaning. */
async function sampleMapped(entity: string, want: number): Promise<{ uids: string[]; held: number }> {
  const at = async (offset: number): Promise<string | null> => {
    const { data, error } = await db().schema("jms").from("zuper_sync_map").select("zuper_uid")
      .eq("tenant_id", config.tenantId).eq("entity", entity).order("zuper_uid").range(offset, offset);
    if (error) throw error;
    return ((data ?? []) as { zuper_uid: string }[])[0]?.zuper_uid ?? null;
  };
  if (!(await at(0))) return { uids: [], held: 0 };
  // How many rows there are. Doubling finds an offset past the end; the search between the last offset that answered
  // and the first that did not gives the count, so every draw afterwards lands on a record rather than past the end.
  let hi = 1;
  while (hi < 2 ** 20 && (await at(hi))) hi *= 2;
  let lo = Math.floor(hi / 2);
  while (lo + 1 < hi) { const mid = Math.floor((lo + hi) / 2); if (await at(mid)) lo = mid; else hi = mid; }
  const count = lo + 1;
  const out = new Set<string>();
  for (let tries = 0; tries < want * 6 && out.size < Math.min(want, count); tries++) {
    const uid = await at(Math.floor(Math.random() * count));
    if (uid) out.add(uid);
  }
  return { uids: [...out], held: count };
}

/**
 * Differences whose cause is already understood. The class is not changed — the field really does answer differently
 * — but the report says why, so a reader does not go looking for a bug that is a design decision.
 */
const KNOWN_CAUSE: { kind?: string; path: RegExp; why: string }[] = [
  { path: /^updated_at$/, why: "Tuper answers when its own row last changed — which is when the sync wrote it, not when Zuper's record changed. Inherent to a mirror; but a client that watches updated_at to detect a change is watching Tuper's clock, not Zuper's." },
  { path: /^(customer|organization|job|asset|property|request_source|customer_organization|customer\.customer_organization)\.updated_at$/,
    why: "an embedded copy of another record, and its updated_at is that record's row in Tuper — which is when the sync last wrote it, not when Zuper's changed. The same cause as the record's own updated_at." },
  { path: /(^|\.)(user|users\[\]|created_by|created_by_user|created_user|requested_by|approved_by_user|done_by|sold_by_user|await_approval_by)\.(created_at|updated_at|last_login_at|profile_picture)$/,
    why: "an embedded copy of a user record. Tuper answers its own row's timestamps — the users were created when Zuper's were imported — and has no login history or Zuper-hosted profile picture. Who the user IS is compared as normal, and does disagree where it says so." },
  { kind: "users", path: /^(created_at|last_login_at|profile_picture)$/,
    why: "Tuper's users were created at the import (2026-09-11) with no password and no invite (owner decision), so their created_at is the import, they have never signed in, and their picture is not Zuper's S3 copy." },
  { path: /(^|\.|\])_id$|^line_items\[\]\.location$/,
    why: "Zuper's internal id for a sub-record (MongoDB's ObjectId: a tax line, an address, a preferred window, a line's stock location as `location`). It names nothing a client can look up — the record's uid does that — and Tuper answers its own row id where it keeps the sub-record as a row, and none where it does not." },
  { path: /(^|\.)__v$/,
    why: "Zuper's own revision counter for the record (MongoDB's version key: 0 on 92 of the newest 150 assets, up to 6 on the rest). It counts Zuper's saves; Tuper keeps no revision count, so it answers 0." },
  { path: /(^|\.)(geo_cordinates\[\]|point_coordinates)$/,
    why: "an address's map point. Zuper writes [0, 0] (and a Point at 0,0) for an address it never located; the sync keeps no point for those rather than one in the Gulf of Guinea. The other way round, Tuper's own geocoder has placed a few addresses Zuper left unplaced." },
  { path: /^asset\.custom_fields\[\]\.type$/, why: "an asset's field kind, which Zuper names per record — see the asset entry below." },
  { kind: "assets", path: /^custom_fields\[\]\.type$/,
    why: "Zuper names a field's kind per record, and older assets keep the older name: 'JGE Registration Expiry' is DATETIME on today's assets and SINGLE_LINE on older ones. Tuper keeps one per field, the newest record's (zuper_seen_at)." },
  { kind: "assets", path: /^custom_field_internal_object\./,
    why: "Zuper keeps this object per record, not per field: measured 2026-09-21, the same field is keyed 'asset_battery_serial_no._1' on some assets and 'asset_battery_serial_no__1' on others, and assets made before a field existed carry no key for it even once it is filled ('Community Registration Number' = 'JGE 9999' on a 2021 asset, absent from its object). Tuper keeps one key per field, taken from the first record the sync saw." },
  { kind: "estimates", path: /^(is_proposal|total_markup|waiting_on_mr|waiting_on_mr_uids|waiting_on_po|waiting_on_po_uids|tax_exempt|cpq_status|pending_option_selection|profit_breakdown|sub_total|total_discount)$|^line_items\[\]\.(line_item_type|line_item_uid|tax|taxes|plain_text_description|total_purchase_price)$|^custom_fields\[\]\.(hide_field|read_only)$/,
    why: "Zuper's quote has gained keys over time and each quote keeps the set it was saved with — measured on all 35 of GBG's quotes, 2026-09-21: is_proposal, waiting_on_mr/po and profit_breakdown appear only on quotes from 2026, total_markup from May 2025, cpq_status from July 2022; the oldest three answer null for sub_total and total_discount; lines gained line_item_type/uid and tax the same way. Tuper answers the complete quote for every quote. The same cause as a job's growing profitability block." },
  { kind: "estimates", path: /^line_items\[\]\.(product_uid|product_ref_id)$/,
    why: "the line names a part Zuper has since deleted — 13 distinct parts on 31 of GBG's 43 quote lines, each answering is_deleted: true inside the line. Owner decision 2026-09-21: deleted parts are not imported (the same decision as the 464 stock movements), so Tuper's line keeps the part's name and number but no link. product_ref_id is the part record itself, which Zuper embeds and Tuper does not." },
  { kind: "requests", path: /^request_priority$/,
    why: "Tuper's own field: its request list, filters and detail card are built on jms.requests.priority, so every request carries one (LOW by default). Zuper's request record has no priority at all." },
  { kind: "requests", path: /^(markdown_description|plain_text_description)$/,
    why: "Zuper's request gained these two over time: the older requests answer only request_description. Tuper answers all three for every request." },
  { path: /(^|\.)custom_fields\[\]\.module_name$/,
    why: "Zuper puts module_name on about half of the records and not on the other half for the same field, and says PRODUCT on an asset's and on a person's alike (measured over 300 assets); it describes no field, so Tuper does not answer it (load.ts loadZuperCustomFields)." },
  { kind: "estimates", path: /^is_expired$/,
    why: "Zuper stores this flag when its own expiry pass runs; it is not a rule over the status and the date. Measured on GBG's 35 quotes: two archived quotes past their expiry say false, a third says true, and a 2021 quote still awaiting a response says false. Tuper works it out (past expiry while sent or archived)." },
  { path: /^job\.(current_job_status\.status_name|job_status\[\]\.status_name)$/,
    why: "Zuper keeps each job's own copy of a status's name from when the job entered it: GBG's status deb6531b was 'Invoiced' in 2021 and is 'Closed' today, and a 2021 job still answers 'Invoiced'. Tuper links the status and answers its name as it is now (the colour it does keep per job, 00100)." },
  { kind: "estimates", path: /^public_url$/,
    why: "Zuper's link to the quote on its own customer portal. Tuper's customer-facing quote page belongs to the portal, which is outside this work, so Tuper answers no link rather than one not known to open." },
  { kind: "jobs", path: /^profitability\.(price|cost)\./,
    why: "Zuper's profitability block has gained categories over time and each job keeps the set it was computed with — measured 2026-09-21: a job from Nov 2025 carries 6 cost keys, Apr 2026 8, Jun 2026 10, and one made today 16. Tuper answers the complete block for every job. Matching Zuper would mean storing each job's historical key set." },
  { kind: "timeoff_requests", path: /^timeoff_request_type\.updated_at$/,
    why: "the time-off type embedded in the request. Zuper's own type list (GET /api/timesheet/request/timeoff_type, the only place the types are imported from) does not answer updated_at, so there is nothing to mirror and Tuper answers when its own type row last changed — the sync's clock, not Zuper's." },
];
const knownCause = (kind: string, path: string): string | undefined =>
  KNOWN_CAUSE.find((k) => (!k.kind || k.kind === kind) && k.path.test(path))?.why;

interface FieldFinding { path: string; class: DiffClass; count: number; note?: string; why?: string; examples: { uid: string; zuper?: unknown; tuper?: unknown }[] }
interface KindReport {
  kind: string; label: string; note?: string;
  compared: number; sampled: { newest: string[]; random: string[] };
  /** How many records of this kind Tuper holds against a Zuper uid, which is the population the random half is drawn from. */
  mapped?: number;
  /** A record Zuper has that Tuper does not answer for — a gap in what was synced, not a field difference. */
  notInTuper: { uid: string; status: number; error?: string }[];
  notInZuper: { uid: string; status: number; error?: string }[];
  failed: { uid: string; side: "zuper" | "tuper"; error: string }[];
  /** diffRecords(record, record) must find nothing. If it ever does, nothing else in this kind can be believed. */
  selfCheck: "passed" | "failed" | "not run";
  certain: FieldFinding[]; uncertain: FieldFinding[]; agreements: Record<string, number>;
  how: string;
}

function collect(findings: Map<string, FieldFinding>, agreements: Record<string, number>, uid: string, diffs: Diff[]) {
  for (const d of diffs) {
    if (!CERTAIN.includes(d.class) && !UNCERTAIN.includes(d.class)) {
      agreements[d.class] = (agreements[d.class] ?? 0) + 1;
      continue;
    }
    const key = `${d.path}\u0000${d.class}`;
    const found = findings.get(key) ?? { path: d.path, class: d.class, count: 0, note: d.note, examples: [] };
    found.count++;
    if (!found.note && d.note) found.note = d.note;
    if (found.examples.length < 3) found.examples.push({ uid, ...(d.zuper !== undefined ? { zuper: d.zuper } : {}), ...(d.tuper !== undefined ? { tuper: d.tuper } : {}) });
    findings.set(key, found);
  }
}

const rank = (findings: Map<string, FieldFinding>, classes: DiffClass[], kind: string): FieldFinding[] =>
  [...findings.values()].filter((f) => classes.includes(f.class))
    .map((f) => ({ ...f, why: knownCause(kind, f.path) }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));

async function compareFields(cfg: SyncConfig, k: FieldKind, sample: number, pace: () => Promise<void>): Promise<KindReport> {
  const r: KindReport = {
    kind: k.name, label: k.label, note: k.note, compared: 0, sampled: { newest: [], random: [] },
    notInTuper: [], notInZuper: [], failed: [], selfCheck: "not run", certain: [], uncertain: [], agreements: {}, how: "",
  };
  const findings = new Map<string, FieldFinding>();

  if (k.pair) {
    const { zuper, tuper, uid, how } = await k.pair(cfg);
    r.how = how;
    const tMap = new Map(tuper.map((row) => [String(uid(row)), row]));
    const zMap = new Map(zuper.map((row) => [String(uid(row)), row]));
    for (const [id] of tMap) if (!zMap.has(id)) r.notInZuper.push({ uid: id, status: 200 });
    let first = true;
    for (const [id, zRow] of zMap) {
      const tRow = tMap.get(id);
      if (!tRow) { r.notInTuper.push({ uid: id, status: 404 }); continue; }
      if (first) { r.selfCheck = diffRecords(zRow, JSON.parse(JSON.stringify(zRow))).length === 0 ? "passed" : "failed"; first = false; }
      if (r.compared >= sample) continue;
      r.sampled.random.push(id);
      collect(findings, r.agreements, id, diffRecords(zRow, tRow));
      r.compared++;
    }
    r.certain = rank(findings, CERTAIN, k.name); r.uncertain = rank(findings, UNCERTAIN, k.name);
    return r;
  }

  if (!k.path || !k.uid || !k.list) throw new Error(`field kind ${k.name} has no way to read a record`);
  const newestWanted = Math.min(3, Math.max(1, Math.floor(sample / 3)));
  let listed: any[] = [];
  try { listed = await k.list(cfg); } catch (err) { r.failed.push({ uid: "(list)", side: "zuper", error: errorText(err) }); }
  const newest = listed.map(k.uid).filter(Boolean).slice(0, newestWanted) as string[];
  const draw = k.entity ? await sampleMapped(k.entity, sample - newest.length) : { uids: [], held: 0 };
  const random = draw.uids.filter((u) => !newest.includes(u));
  r.sampled = { newest, random };
  r.mapped = draw.held;
  r.how = `${newest.length} from the first page of Zuper's list, and ${random.length} drawn at random from the ${draw.held} ${k.entity} record(s) Tuper has mapped to a Zuper uid`;

  for (const uid of [...newest, ...random]) {
    await pace();
    const z = await zuperRead(cfg, (k.zuperPath ?? k.path)(uid));
    if (!z.ok) {
      if (z.status === 404) r.notInZuper.push({ uid, status: 404, error: z.error });
      else r.failed.push({ uid, side: "zuper", error: z.error ?? "unknown" });
      continue;
    }
    const t = await tuperRead(k.path(uid));
    if (!t.ok) {
      if (t.status === 404) r.notInTuper.push({ uid, status: 404, error: t.error });
      else r.failed.push({ uid, side: "tuper", error: `${t.status}: ${t.error ?? "unknown"}` });
      continue;
    }
    if (r.selfCheck === "not run") r.selfCheck = diffRecords(z.record, JSON.parse(JSON.stringify(z.record))).length === 0 ? "passed" : "failed";
    collect(findings, r.agreements, uid, diffRecords(z.record, t.record));
    r.compared++;
  }
  r.certain = rank(findings, CERTAIN, k.name); r.uncertain = rank(findings, UNCERTAIN, k.name);
  return r;
}

/** The readable half of the result. The JSON beside it holds every finding; this holds what to do about them. */
function summary(reports: KindReport[], at: string, sample: number): string {
  const L: string[] = [];
  const pct = (f: FieldFinding, n: number) => (n ? ` ${Math.round((f.count / n) * 100)}% of records` : "");
  L.push("# Field parity — Zuper's answer against Tuper's, on the owner's account", "");
  L.push(`Run ${at} by \`npm run compare:fields\` (src/cli/compare.ts \`--fields\`, sample ${sample} per kind).`, "");
  L.push("Read-only on both systems: every call is a GET, or one of the POST …/filter list reads Zuper offers in place of one.", "");
  L.push("The example columns hold real values from the account — customer names, addresses and email addresses among them.",
    "Run with `--no-examples` for a copy that names the fields and not their contents.", "");
  L.push("For a sample of real records, each system was asked for the same record by the same Zuper uid and the two answers", "compared field by field. Ordering, the formatting of the same instant or number, and empty written two ways are not",
    "differences. Where the comparison cannot settle a difference — an id each system may legitimately answer differently, a",
    "date against a timestamp, array records with no uid to pair them by — it is listed under **Cannot be settled from here**",
    "rather than counted as a field that disagrees.", "");

  L.push("## What was compared", "", "| records | compared | not in Tuper | not in Zuper | failed | fields that disagree | unsettled | self-check |", "|---|---|---|---|---|---|---|---|");
  for (const r of reports) {
    L.push(`| ${r.label} | ${r.compared} | ${r.notInTuper.length} | ${r.notInZuper.length} | ${r.failed.length} | ${r.certain.length} | ${r.uncertain.length} | ${r.selfCheck} |`);
  }
  L.push("");
  const totalCertain = reports.reduce((n, r) => n + r.certain.length, 0);
  L.push(`**${totalCertain} field${totalCertain === 1 ? "" : "s"} across ${reports.filter((r) => r.certain.length).length} record kind${reports.filter((r) => r.certain.length).length === 1 ? "" : "s"} answer differently.**`, "");
  L.push("`self-check` is the instrument checking itself: each kind's first Zuper record is compared with a copy of itself, which must", "produce nothing. A kind whose self-check failed cannot be believed. `npm run compare:fields -- --self-test` runs the", "engine against a page of known answers without touching either system.", "");

  // The findings worth reading first: a field that disagreed on at least half the records of its kind, and whose cause
  // is not already understood. Everything else is under its own kind below.
  const headline = reports.flatMap((r) => r.certain.filter((f) => !f.why && r.compared >= 1 && f.count / r.compared >= 0.5).map((f) => ({ r, f })))
    .sort((a, b) => b.f.count / b.r.compared - a.f.count / a.r.compared || b.f.count - a.f.count);
  if (headline.length) {
    L.push("## The differences that matter most", "", `${headline.length} of the fields below disagreed on at least half the records of their kind, with no cause already known. The first 30:`, "",
      "| records | field | what | how often | Zuper | Tuper |", "|---|---|---|---|---|---|");
    for (const { r, f } of headline.slice(0, 30)) {
      const ex = f.examples[0] ?? {};
      L.push(`| ${r.label} | \`${f.path}\` | ${f.class} | ${f.count}/${r.compared} | ${md(ex.zuper)} | ${md(ex.tuper)} |`);
    }
    L.push("");
  }

  for (const r of reports) {
    L.push(`## ${r.label}`, "");
    L.push(`${r.compared} record${r.compared === 1 ? "" : "s"} compared — ${r.how || "—"}.`);
    if (r.note) L.push("", `_${r.note}_`);
    L.push("");
    if (r.failed.length) {
      L.push(`Not compared: ${r.failed.length} record${r.failed.length === 1 ? "" : "s"} could not be read — ${[...new Set(r.failed.map((f) => `${f.side} ${f.error.slice(0, 80)}`))].slice(0, 3).join("; ")}`, "");
    }
    if (r.notInTuper.length) L.push(`Zuper has ${r.notInTuper.length} of the sampled record${r.notInTuper.length === 1 ? "" : "s"} that Tuper answers 404 for: ${r.notInTuper.slice(0, 5).map((x) => x.uid).join(", ")}${r.notInTuper.length > 5 ? " …" : ""}. That is a record that was never synced, not a field difference — \`npm run compare\` is the tool for it.`, "");
    if (r.notInZuper.length) L.push(`Tuper holds ${r.notInZuper.length} sampled record${r.notInZuper.length === 1 ? "" : "s"} Zuper does not answer for: ${r.notInZuper.slice(0, 5).map((x) => x.uid).join(", ")}${r.notInZuper.length > 5 ? " …" : ""}.`, "");
    if (!r.compared) { L.push("_Nothing was compared._", ""); continue; }

    if (!r.certain.length) L.push("Every field both systems send agrees.", "");
    else {
      L.push("### Fields that disagree", "", "| field | what | how often | Zuper | Tuper |", "|---|---|---|---|---|");
      for (const f of r.certain.slice(0, 40)) {
        const ex = f.examples[0] ?? {};
        L.push(`| \`${f.path}\` | ${f.class}${f.why ? " (known cause)" : ""} | ${f.count}/${r.compared}${pct(f, r.compared)} | ${md(ex.zuper)} | ${md(ex.tuper)} |`);
      }
      if (r.certain.length > 40) L.push(`| … | | ${r.certain.length - 40} more, in the JSON | | |`);
      L.push("");
      // The same explanation covers a run of fields; say it once and name them all.
      const causes = new Map<string, string[]>();
      for (const f of r.certain) if (f.why) causes.set(f.why, [...(causes.get(f.why) ?? []), f.path]);
      for (const [why, paths] of causes) L.push(`- ${paths.map((x) => `\`${x}\``).join(", ")} — ${why}`);
      if (causes.size) L.push("");
    }
    // One side sends a field empty and the other leaves it out. Nothing is lost either way and there are dozens of
    // them, so they are named once rather than given a row each.
    const empties = r.uncertain.filter((f) => f.class === "empty_field");
    const rest = r.uncertain.filter((f) => f.class !== "empty_field");
    if (rest.length) {
      L.push("### Cannot be settled from here", "", "| field | why | how often |", "|---|---|---|");
      for (const f of rest.slice(0, 25)) L.push(`| \`${f.path}\` | ${f.class}${f.note ? ` — ${f.note.replace(/\|/g, "/")}` : ""} | ${f.count}/${r.compared} |`);
      if (rest.length > 25) L.push(`| … | ${rest.length - 25} more, in the JSON | |`);
      L.push("");
    }
    if (empties.length) {
      const tuperSends = empties.filter((f) => f.examples.some((e) => "tuper" in e));
      const zuperSends = empties.filter((f) => !f.examples.some((e) => "tuper" in e));
      L.push(`${empties.length} field${empties.length === 1 ? "" : "s"} one side sends empty and the other leaves out — nothing is lost, but a client reading the key sees \`undefined\` on one of the two:`);
      if (tuperSends.length) L.push(`- Tuper sends empty, Zuper omits (${tuperSends.length}): ${tuperSends.slice(0, 25).map((f) => `\`${f.path}\``).join(", ")}${tuperSends.length > 25 ? " …" : ""}`);
      if (zuperSends.length) L.push(`- Zuper sends empty, Tuper omits (${zuperSends.length}): ${zuperSends.slice(0, 25).map((f) => `\`${f.path}\``).join(", ")}${zuperSends.length > 25 ? " …" : ""}`);
      L.push("");
    }
    const agree = Object.entries(r.agreements).sort((a, b) => b[1] - a[1]);
    if (agree.length) L.push(`Agreed although written differently: ${agree.map(([c, n]) => `${c} ×${n}`).join(", ")}.`, "");
  }
  L.push("## What this does not cover", "");
  L.push("- Only the record kinds above, and only the read-by-uid (or whole-list) endpoint for each. The other endpoints of", "  Tuper's 437 — sub-resources, searches, writes — are not compared here, and writes never will be: Zuper is read-only.");
  L.push("- A field both systems leave out is not checked, because neither sends it.");
  L.push("- Counts are per sampled record, not per record in the account: a field that disagrees on 3 of 8 sampled jobs is not", "  a claim that it disagrees on 37% of 47,000 jobs.");
  L.push("- `not in Tuper` and `not in Zuper` are presence, which `npm run compare` measures properly over the whole account.");
  return L.join("\n") + "\n";
}

const md = (v: unknown): string => {
  if (v === undefined) return "_absent_";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return "`" + String(s).replace(/\|/g, "/").replace(/`/g, "'").replace(/\n/g, " ").slice(0, 70) + "`";
};

async function fieldsMode(cfg: SyncConfig, kinds: FieldKind[], sample: number, pace: () => Promise<void>, out: string) {
  const at = new Date().toISOString();
  const reports: KindReport[] = [];
  const pad = (v: unknown, n: number) => String(v).padStart(n);
  console.log(`${"records".padEnd(20)}${pad("compared", 9)}${pad("disagree", 9)}${pad("unsettled", 10)}${pad("404s", 6)}  self-check`);
  for (const k of kinds) {
    const started = Date.now();
    let r: KindReport;
    try { r = await compareFields(cfg, k, sample, pace); }
    catch (err) {
      r = { kind: k.name, label: k.label, note: k.note, compared: 0, sampled: { newest: [], random: [] }, notInTuper: [], notInZuper: [],
        failed: [{ uid: "(kind)", side: "zuper", error: errorText(err) }], selfCheck: "not run", certain: [], uncertain: [], agreements: {}, how: "" };
    }
    reports.push(r);
    console.log(`${k.label.padEnd(20)}${pad(r.compared, 9)}${pad(r.certain.length, 9)}${pad(r.uncertain.length, 10)}${pad(r.notInTuper.length + r.notInZuper.length, 6)}  ${r.selfCheck}` +
      `${r.failed.length ? `  ${r.failed.length} unreadable: ${r.failed[0].side} ${r.failed[0].error.slice(0, 60)}` : ""}  ${Math.round((Date.now() - started) / 1000)}s`);
  }
  // --no-examples: the same findings with the values taken out, for a copy that can travel further than the account can.
  if (has("no-examples")) {
    for (const r of reports) for (const f of [...r.certain, ...r.uncertain]) f.examples = f.examples.map((e) => ({ uid: e.uid }));
  }
  const jsonPath = out;
  const mdPath = out.replace(/\.json$/i, "").replace(/([^/\\]+)$/, (m) => m.toUpperCase()) + ".md";
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify({ at, mode: "fields", sample, readOnly: true, reports }, null, 2));
  writeFileSync(mdPath, summary(reports, at, sample));
  const bad = reports.filter((r) => r.selfCheck === "failed").map((r) => r.kind);
  console.log(`\n${reports.reduce((n, r) => n + r.certain.length, 0)} field(s) disagree, ${reports.reduce((n, r) => n + r.uncertain.length, 0)} cannot be settled from here.`);
  if (bad.length) console.log(`SELF-CHECK FAILED for ${bad.join(", ")} — those results cannot be believed.`);
  console.log(`${jsonPath}\n${mdPath}`);
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

  // --fields answers a different question and writes a different report. It never re-syncs anything, so --apply is
  // refused rather than quietly ignored.
  if (has("fields") || has("self-test")) {
    if (apply) throw new Error("--fields is a read-only comparison; it has nothing to apply");
    const st = selfTest();
    console.log(`self-test: ${st.passed} of ${st.passed + st.failed.length} known answers correct`);
    for (const f of st.failed) console.log(`  WRONG  ${f}`);
    if (st.failed.length) { process.exitCode = 1; return; }
    if (has("self-test") && !has("fields")) return;
    const chosen = wanted ? FIELD_KINDS.filter((k) => wanted.includes(k.name)) : FIELD_KINDS;
    if (!chosen.length) throw new Error(`no field kinds match --kinds; known: ${FIELD_KINDS.map((k) => k.name).join(", ")}`);
    await fieldsMode(cfg, chosen, Math.max(1, Number(opt("sample") ?? 8)), pace, opt("out") ?? "docs/field-parity.json");
    await flush();
    return;
  }

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
