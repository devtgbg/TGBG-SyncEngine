/**
 * Records Zuper only lists as a whole — timesheet punches, time off, time off types.
 *
 * None of them has a read-by-uid, and a timesheet event does not name a record we
 * could fetch anyway. So an event (or the sweep) re-reads the recent part of the
 * list and writes what is new or may have changed:
 *
 *   timesheets        POST /api/timesheets/filter for the last few days (Dubai
 *                     calendar), punches by Tuper users only. A handful a day.
 *   timeoff_requests  GET /api/timesheets/request/timeoff — the whole list in one
 *                     reply (639 rows, ~1 s). Rows carry no updated_at, so every
 *                     request that is new, still current (ends within the last 30
 *                     days or later) or was requested/decided in the last 14 days
 *                     is written again.
 *   timeoff_types     GET /api/timesheet/request/timeoff_type — five rows.
 *
 * Deletions are not mirrored: neither table has a deleted flag, and removing a row
 * Tuper's approvals may point at is not something a sync should do on its own.
 *
 * Bursts coalesce. A bulk check-in fires one event per person; while one pass is
 * running, every further request for the same list shares the single pass queued
 * behind it, which starts after and so reads the newest state.
 */

import { config, errorText } from "./config.js";
import { tuper as db } from "./tuper-client.js";
import { getSyncConfig, zuperFilterPages, zuperGet } from "./lib/migration/zuper-sync.js";
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
 */
export function syncCollection(name: Collection, opts: { days?: number } = {}): Promise<CollectionResult> {
  const days = Math.max(1, opts.days ?? 3);
  switch (name) {
    case "timesheets": return coalesce(`timesheets:${days}`, tracked(name, `punches, last ${days} days`, () => timesheets(days)));
    case "timeoff_requests": return coalesce(name, tracked(name, "time off requests", timeoffRequests));
    case "timeoff_types": return coalesce(name, tracked(name, "time off types", timeoffTypes));
  }
}

/** A pass is one row in sync.tuper_writes, however many records it rewrote; a burst sharing it is one pass. */
const tracked = (entity: Collection, label: string, run: () => Promise<CollectionResult>) => () =>
  trackWrite({ entity, label }, run, (r) => ({
    action: r.written ? "updated" : "unchanged",
    detail: `${r.written} written of ${r.listed} listed${r.failed ? `, ${r.failed} failed` : ""}`,
    ok: !r.failed, error: r.failed ? r.errors[0] ?? null : null,
  }));
