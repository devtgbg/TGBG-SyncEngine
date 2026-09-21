/**
 * Records Zuper only lists as a whole — timesheet punches, time off, time off types,
 * timesheet locations, timesheet approvals, time off balances and stock movements.
 *
 * A timesheet or stock movement event does not name a record we could fetch (Zuper
 * publishes no read-by-uid for either), so an event (or the sweep) re-reads the list
 * and writes what is new or may have changed:
 *
 *   timesheets        POST /api/timesheets/filter for the last few days (Dubai
 *                     calendar), punches by Tuper users only. A handful a day.
 *   timeoff_requests  GET /api/timesheets/request/timeoff — the whole list in one
 *                     reply (639 rows, ~1 s). Rows carry no updated_at, so every
 *                     request that is new, still current (ends within the last 30
 *                     days or later) or was requested/decided in the last 14 days
 *                     is written again.
 *   timeoff_types     GET /api/timesheet/request/timeoff_type — five rows.
 *   timesheet_locations
 *                     GET /api/timesheet/location, every page (a short list; GBG
 *                     holds none yet). Each location's people come with it.
 *   timesheet_approvals
 *                     GET /api/timesheet/approval, every page, each approval then
 *                     read in full for its history and punches. GBG holds one.
 *   timeoff_availability
 *                     GET /api/timesheets/request/timeoff_availability — the whole
 *                     list in one reply (55 rows).
 *   product_transactions
 *                     GET /api/product/transaction, oldest first, so the newest
 *                     movements are on the last page (773 rows, 8 pages).
 *
 * Deletions: punches, time off requests and time off types have no deleted flag,
 * and removing a row Tuper's approvals may point at is not something a sync should
 * do on its own. The three lists read whole DO mirror a removal, because reading
 * them whole is the only way to see one — see `goneFromList`, which refuses to act
 * on an empty or improbable answer.
 *
 * Bursts coalesce. A bulk check-in fires one event per person; while one pass is
 * running, every further request for the same list shares the single pass queued
 * behind it, which starts after and so reads the newest state.
 */

import { config, errorText } from "./config.js";
import { tuper as db } from "./tuper-client.js";
import {
  getSyncConfig, zuperFilterPages, zuperGet, zuperTimesheetApprovals, zuperTimesheetLocations,
} from "./lib/migration/zuper-sync.js";
import { syncOne } from "./processor.js";
import { trackWrite } from "./tuper-writes.js";
import type { Collection } from "./routes.js";

export type { Collection };

export interface CollectionResult {
  entity: Collection;
  listed: number;
  written: number;
  failed: number;
  errors: string[];
  /** Rows the list holds that this sync cannot write, and why — not a failure, a fact about Zuper's own data. */
  unwritable?: number;
  unwritableNote?: string;
}

const DAY = 86_400_000;
/** A calendar date in Dubai, which is what Zuper's timesheet filter takes. */
const dubaiDate = (t: number) => new Date(t + 4 * 3_600_000).toISOString().slice(0, 10);

async function mappedUids(entity: string, uids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < uids.length; i += 150) {
    const { data, error } = await db().schema("jms").from("zuper_sync_map").select("zuper_uid")
      .eq("tenant_id", config.tenantId).eq("entity", entity).in("zuper_uid", uids.slice(i, i + 150));
    if (error) throw error;
    for (const m of (data ?? []) as { zuper_uid: string }[]) out.add(m.zuper_uid);
  }
  return out;
}

async function writeAll(entity: Collection, rows: { uid: string; raw: any }[], listed: number): Promise<CollectionResult> {
  const result: CollectionResult = { entity, listed, written: 0, failed: 0, errors: [] };
  for (const { uid, raw } of rows) {
    try {
      await syncOne(entity, uid, { raw });
      result.written++;
    } catch (err) {
      result.failed++;
      if (result.errors.length < 5) result.errors.push(errorText(err).slice(0, 160));
    }
  }
  return result;
}

async function timesheets(days: number): Promise<CollectionResult> {
  const cfg = await getSyncConfig(db(), config.tenantId);
  const window = {
    count: 100, preferred_timezone: "Asia/Dubai", filter_rule_operator: "AND",
    "filter.from_date": dubaiDate(Date.now() - (days - 1) * DAY), "filter.to_date": dubaiDate(Date.now()),
  };
  const punches: any[] = [];
  for await (const page of zuperFilterPages(cfg, "/api/timesheets/filter", 100, window)) punches.push(...page);

  // Punches by people Tuper has; the transform refuses anyone else.
  const userUid = (p: any): string | undefined => p?.users?.user_uid ?? (Array.isArray(p?.users) ? p.users[0]?.user_uid : undefined);
  const users = await mappedUids("users", [...new Set(punches.map(userUid).filter(Boolean) as string[])]);
  const ours = punches.filter((p) => p?.employee_timesheet_uid && users.has(String(userUid(p))));
  // Few rows, and a punch can be edited: write every one in the window.
  return writeAll("timesheets", ours.map((p) => ({ uid: String(p.employee_timesheet_uid), raw: p })), punches.length);
}

async function timeoffRequests(): Promise<CollectionResult> {
  const cfg = await getSyncConfig(db(), config.tenantId);
  const rows: any[] = (await zuperGet(cfg, "/api/timesheets/request/timeoff"))?.data ?? [];
  const mapped = await mappedUids("timeoff_requests", rows.map((r) => String(r.request_uid)).filter(Boolean));
  const current = Date.now() - 30 * DAY;
  const recent = Date.now() - 14 * DAY;
  const at = (v: unknown) => (v ? Date.parse(String(v)) : NaN);
  const todo = rows.filter((r) => r?.request_uid && (
    !mapped.has(String(r.request_uid))
    || at(r.request_to ?? r.request_from) >= current
    || [r.requested_at, r.approved_at, r.created_at].some((v) => at(v) >= recent)
  ));
  return writeAll("timeoff_requests", todo.map((r) => ({ uid: String(r.request_uid), raw: r })), rows.length);
}

async function timeoffTypes(): Promise<CollectionResult> {
  const cfg = await getSyncConfig(db(), config.tenantId);
  const rows: any[] = (await zuperGet(cfg, "/api/timesheet/request/timeoff_type"))?.data ?? [];
  return writeAll("timeoff_types", rows.filter((r) => r?.timeoff_request_type_uid)
    .map((r) => ({ uid: String(r.timeoff_request_type_uid), raw: r })), rows.length);
}

/**
 * The rows this sync brought over that Zuper's list no longer holds.
 *
 * Only safe for a list read whole, and only ever for rows in the map — a record made in Tuper is not Zuper's to
 * remove. Two refusals guard it: an empty answer is a short answer, not "they were all deleted"; and more than a
 * quarter of them missing at once is reported instead of acted on, because that is what a half-read list looks
 * like. Whatever it returns, it is one pass behind at worst — the next one sees the same thing.
 */
async function goneFromList(entity: string, seen: Set<string>, listed: number): Promise<{ ids: string[]; note: string | null }> {
  if (!listed) return { ids: [], note: "Zuper listed none — nothing removed" };
  const mapped: { zuper_uid: string; jms_id: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db().schema("jms").from("zuper_sync_map").select("zuper_uid, jms_id")
      // Ordered, because a paged read without one may return a row twice and another not at all — and a map that
      // comes back short makes a record Tuper already holds look new.
      .eq("tenant_id", config.tenantId).eq("entity", entity).order("zuper_uid").range(from, from + 999);
    if (error) throw error;
    mapped.push(...((data ?? []) as { zuper_uid: string; jms_id: string }[]));
    if (!data || data.length < 1000) break;
  }
  const gone = mapped.filter((m) => !seen.has(m.zuper_uid));
  if (!gone.length) return { ids: [], note: null };
  if (gone.length > Math.max(1, Math.ceil(mapped.length / 4))) {
    return { ids: [], note: `${gone.length} of ${mapped.length} missing from Zuper's list — too many to act on` };
  }
  return { ids: gone.map((g) => g.jms_id), note: `${gone.length} gone from Zuper` };
}

/** Timesheet locations, with the people on each (the transform and afterWrite do both). A location Zuper no longer
 *  lists is marked deleted, which is what its own is_deleted flag means. */
async function timesheetLocations(): Promise<CollectionResult> {
  const cfg = await getSyncConfig(db(), config.tenantId);
  const rows: any[] = [];
  for await (const page of zuperTimesheetLocations(cfg)) rows.push(...page);
  const live = rows.filter((r) => (r?.location ?? r)?.location_uid);
  const result = await writeAll("timesheet_locations", live.map((r) => ({ uid: String((r.location ?? r).location_uid), raw: r })), rows.length);
  const { ids, note } = await goneFromList("timesheet_locations", new Set(live.map((r) => String((r.location ?? r).location_uid))), rows.length);
  if (ids.length) {
    const { error } = await db().schema("jms").from("timesheet_locations").update({ is_deleted: true })
      .eq("tenant_id", config.tenantId).in("id", ids);
    if (error) throw error;
    result.written += ids.length;
  }
  if (note && process.env.ZUPER_SYNC_LOG) console.log(`  timesheet_locations: ${note}`);
  return result;
}

/** Timesheet approvals, each read in full for its history and the punches it covers. */
async function timesheetApprovals(): Promise<CollectionResult> {
  const cfg = await getSyncConfig(db(), config.tenantId);
  const rows: any[] = [];
  for await (const page of zuperTimesheetApprovals(cfg)) rows.push(...page);
  const uidOf = (r: any) => (r?.timesheet_approval ?? r)?.timesheet_approval_uid;
  const live = rows.filter((r) => uidOf(r));
  const result = await writeAll("timesheet_approvals", live.map((r) => ({ uid: String(uidOf(r)), raw: r })), rows.length);
  const { ids, note } = await goneFromList("timesheet_approvals", new Set(live.map((r) => String(uidOf(r)))), rows.length);
  if (ids.length) {
    const { error } = await db().schema("jms").from("timesheet_approvals").update({ is_deleted: true })
      .eq("tenant_id", config.tenantId).in("id", ids);
    if (error) throw error;
    result.written += ids.length;
  }
  if (note && process.env.ZUPER_SYNC_LOG) console.log(`  timesheet_approvals: ${note}`);
  return result;
}

/** Each person's remaining days of a time off type in a year. The table keeps no deleted flag and nothing points at
 *  a balance, so a balance Zuper no longer holds is removed outright — with its map row, so the uid can come back. */
async function timeoffAvailability(): Promise<CollectionResult> {
  const cfg = await getSyncConfig(db(), config.tenantId);
  const rows: any[] = (await zuperGet(cfg, "/api/timesheets/request/timeoff_availability"))?.data ?? [];
  const live = rows.filter((r) => r?.timeoff_availability_uid);
  const result = await writeAll("timeoff_availability", live.map((r) => ({ uid: String(r.timeoff_availability_uid), raw: r })), rows.length);
  const { ids, note } = await goneFromList("timeoff_availability", new Set(live.map((r) => String(r.timeoff_availability_uid))), rows.length);
  if (ids.length) {
    const { error } = await db().schema("jms").from("timeoff_availability").delete().eq("tenant_id", config.tenantId).in("id", ids);
    if (error) throw error;
    const { error: unmap } = await db().schema("jms").from("zuper_sync_map").delete()
      .eq("tenant_id", config.tenantId).eq("entity", "timeoff_availability").in("jms_id", ids);
    if (unmap) throw unmap;
    result.written += ids.length;
  }
  if (note && process.env.ZUPER_SYNC_LOG) console.log(`  timeoff_availability: ${note}`);
  return result;
}

/**
 * Stock movements — a part taken in, moved between locations, adjusted, or consumed by a document.
 *
 * Zuper's four transaction events said "Zuper has no GET by transaction uid", which is true, and left them unsynced:
 * 464 of GBG's 773 movements had never arrived. But Zuper does list them — `GET /api/product/transaction` — so this is
 * the case this file exists for: the event re-reads the recent part of the list.
 *
 * THE LIST IS OLDEST FIRST (checked read-only 2026-09-21: page 1 begins 2023-08-30, the last page ends 2024-02-16), so
 * the newest movements are on the LAST page, and `total_pages` from the first read says where that is. An event reads
 * the last two pages, a `full` pass every page — eight today, so a catch-up is eight reads.
 *
 * A movement is never edited in Zuper; it is voided, which sets is_deleted on the row the list keeps returning. So only
 * movements Tuper does not have, plus the newest handful (where a void would land), are written again — a pass costs a
 * few writes rather than several hundred. Nothing is ever removed: a voided movement stays, as the audit trail 00145
 * describes, and its is_deleted comes across on the next pass that touches it.
 */
const TRANSACTION_PAGES = 2;      // an event reads this many pages from the end of the list
const TRANSACTIONS_REWRITTEN = 25;  // and rewrites this many of the newest, where a void would show up
async function productTransactions(full: boolean): Promise<CollectionResult> {
  const cfg = await getSyncConfig(db(), config.tenantId);
  const path = (p: number) => `/api/product/transaction?page=${p}&count=100`;
  const first = await zuperGet(cfg, path(1));
  const pages = Math.max(1, Number(first?.total_pages) || 1);
  const from = full ? 1 : Math.max(1, pages - (TRANSACTION_PAGES - 1));
  const rows: any[] = [];
  for (let p = from; p <= pages; p++) {
    const j = p === 1 ? first : await zuperGet(cfg, path(p));
    rows.push(...((j?.data ?? []) as any[]));
  }
  const listed = rows.filter((t) => t?.transaction_uid);

  // A movement has to hang off a part (jms.product_transactions.product_id is NOT NULL), and Zuper keeps movements of
  // parts it has since deleted: its own product list leaves them out and `GET /api/product/{uid}` answers "Invalid
  // Product UID". Those are counted and named, not retried as failures — there is nothing in Zuper left to import.
  const parts = await mappedUids("products", [...new Set(listed.map((t) => String(t.product?.product_uid ?? "")).filter(Boolean))]);
  const live = listed.filter((t) => parts.has(String(t.product?.product_uid ?? "")));

  const mapped = await mappedUids("product_transactions", live.map((t) => String(t.transaction_uid)));
  const newest = new Set(live.slice(-TRANSACTIONS_REWRITTEN).map((t) => String(t.transaction_uid)));
  const todo = live.filter((t) => !mapped.has(String(t.transaction_uid)) || newest.has(String(t.transaction_uid)));
  const result = await writeAll("product_transactions", todo.map((t) => ({ uid: String(t.transaction_uid), raw: t })), rows.length);
  if (listed.length > live.length) {
    result.unwritable = listed.length - live.length;
    result.unwritableNote = "of parts Zuper has deleted";
  }
  return result;
}

const running = new Map<string, Promise<CollectionResult>>();
const queued = new Map<string, Promise<CollectionResult>>();

/** One pass at a time per list; requests that arrive meanwhile share the next pass. */
function coalesce(key: string, run: () => Promise<CollectionResult>): Promise<CollectionResult> {
  const already = queued.get(key);
  if (already) return already;
  const current = running.get(key);
  const start = (): Promise<CollectionResult> => {
    const p = run().finally(() => { if (running.get(key) === p) running.delete(key); });
    running.set(key, p);
    return p;
  };
  if (!current) return start();
  const next = current.catch(() => undefined).then(() => { queued.delete(key); return start(); });
  queued.set(key, next);
  return next;
}

/**
 * Bring one list in line with Zuper. `days` widens the timesheet window (a
 * catch-up); events use the default, which covers a punch edited a day late.
 * `full` reads a whole list rather than its recent end — the sweep's catch-up.
 */
export function syncCollection(name: Collection, opts: { days?: number; full?: boolean } = {}): Promise<CollectionResult> {
  const days = Math.max(1, opts.days ?? 3);
  const full = opts.full === true;
  switch (name) {
    case "product_transactions": return coalesce(`${name}:${full}`, tracked(name, full ? "stock movements, every page" : "stock movements, newest pages", () => productTransactions(full)));
    case "timesheets": return coalesce(`timesheets:${days}`, tracked(name, `punches, last ${days} days`, () => timesheets(days)));
    case "timeoff_requests": return coalesce(name, tracked(name, "time off requests", timeoffRequests));
    case "timeoff_types": return coalesce(name, tracked(name, "time off types", timeoffTypes));
    case "timesheet_locations": return coalesce(name, tracked(name, "timesheet locations", timesheetLocations));
    case "timesheet_approvals": return coalesce(name, tracked(name, "timesheet approvals", timesheetApprovals));
    case "timeoff_availability": return coalesce(name, tracked(name, "time off balances", timeoffAvailability));
  }
}

/** A pass is one row in sync.tuper_writes, however many records it rewrote; a burst sharing it is one pass. */
const tracked = (entity: Collection, label: string, run: () => Promise<CollectionResult>) => () =>
  trackWrite({ entity, label }, run, (r) => ({
    action: r.written ? "updated" : "unchanged",
    detail: `${r.written} written of ${r.listed} listed`
      + `${r.unwritable ? `, ${r.unwritable} ${r.unwritableNote ?? "cannot be written"}` : ""}`
      + `${r.failed ? `, ${r.failed} failed` : ""}`,
    ok: !r.failed, error: r.failed ? r.errors[0] ?? null : null,
  }));
