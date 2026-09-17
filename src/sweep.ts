/**
 * The rolling-window sweep — catching what the webhooks missed.
 *
 * Replay (reconcile.ts) retries deliveries we RECEIVED. This is the other half:
 * deliveries that never arrived at all. Zuper gives up after `max_retries` (the
 * real payload says 4), so an outage, a bad deploy or a DNS blip loses those
 * changes permanently. Nothing else recovers them.
 *
 * How it works: ask Zuper which jobs changed in a window, compare each against
 * when we last wrote it, and re-fetch only the ones that have actually drifted.
 *
 * Four things here were established empirically, and each is a trap:
 *
 *  1. USE THE GET, NOT THE POST. `POST /api/jobs/filter` accepts filter keys and
 *     silently ignores them — filtered and unfiltered both return all 46,807
 *     jobs. It does not error. Sweeping through it would page the entire job
 *     table every run.
 *
 *  2. updated_at NEEDS A FULL ISO TIMESTAMP. `filter.updated_at_from=2026-09-09`
 *     returns 400 "Invalid Updated Date"; `...T00:00:00Z` works. The scheduled
 *     date filters (`filter.from_date`) take a bare date, so the two differ.
 *
 *  3. NEVER TRANSFORM A LIST ROW. The list omits `organization`, `skills`,
 *     `parent_job` and the descriptions, and jobs.transform writes `job_skills`
 *     and `organization_id` unconditionally — so transforming a list row blanks
 *     real skills and unsets the organisation. Drifted jobs are re-fetched by
 *     uid (GET /api/jobs/{uid}, the full record) and then enriched.
 *
 *  4. job_details ALONE IS NOT A RE-SYNC. It never writes the schedule, title,
 *     priority or addresses — only `jobs` does. This sweep once ran job_details
 *     alone and refreshed synced_at, so a rescheduled job read as current while
 *     keeping its old times. Every job goes through `jobs` then `job_details`,
 *     the same chain processEvent uses, which also imports an unmapped one
 *     (Zuper reports 46,807 jobs; zuper_sync_map held 46,756).
 *
 * Rate limit on this account is 150/min (x-rate-limit), well under the 200-700
 * the docs advertise, and live webhook re-fetches are competing for it. The
 * sweep therefore paces itself at a fraction of that and caps how much it will
 * do in one run: it is a safety net, and a safety net that throttles real-time
 * sync to fix hypothetical gaps is worse than the gap.
 *
 * WHAT ACTUALLY CONSTRAINS THIS, measured rather than assumed.
 *
 * Not Zuper's rate limit. A capped run of 25 re-syncs took 1,192s — about 48s
 * each — while making only ~53 counted requests (measured with job_details
 * alone; each job now also runs `jobs`). At 45 req/min the pacer would
 * have allowed roughly 900 in that time, so it never bound. The cost is per-job
 * processing: job_details' afterWrite rebuilds assignments, status history,
 * custom fields, teams and tags, which is many Supabase round-trips per job.
 *
 * So `perMinute` is a safety belt against bursts, not the throttle that matters,
 * and a backlog should be budgeted in minutes-per-job (~48s) rather than in API
 * calls: 238 outstanding jobs is roughly 3 hours, not a few minutes.
 *
 * `pagedRequests` counts only this module's own calls. Each re-sync makes further
 * uncounted Zuper fetches inside syncOne, and an unmapped job costs two syncOne
 * calls (jobs, then job_details) — 25 re-syncs produced 53 counted requests. Read
 * it as a lower bound on API usage, never as total consumption.
 */

import { config, errorText } from "./config.js";
import { db } from "./supabase.js";
import { getSyncConfig, zuperGet } from "./lib/migration/zuper-sync.js";
import { syncRecord } from "./processor.js";

export interface SweepResult {
  window: { from: string; to: string };
  inWindow: number;
  examined: number;
  drifted: number;
  unmapped: number;
  resynced: number;
  failed: number;
  stoppedEarly: boolean;
  /** Requests THIS module makes. syncOne's own fetches are extra — see the note. */
  pagedRequests: number;
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** A crude but honest pacer: keeps the sweep under a requests-per-minute ceiling. */
function pacer(perMinute: number) {
  const gap = Math.max(0, Math.floor(60_000 / Math.max(1, perMinute)));
  let last = 0;
  return async () => {
    const wait = gap - (Date.now() - last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
  };
}

/**
 * Sweep jobs changed in the last `minutesBack` minutes.
 *
 * `dryRun` reports what it would do without writing anything — the same default
 * stance as the simulate CLI, because this writes rows four applications read.
 *
 * `force` re-syncs every job in the window, drifted or not. It exists for when
 * synced_at itself cannot be trusted: jobs synced by job_details alone had it
 * refreshed without their schedule being written, so they read as current.
 */
export async function sweepJobs(opts: {
  minutesBack?: number;
  maxResyncs?: number;
  perMinute?: number;
  dryRun?: boolean;
  force?: boolean;
} = {}): Promise<SweepResult> {
  const minutesBack = opts.minutesBack ?? config.sweep.minutesBack;
  const maxResyncs = opts.maxResyncs ?? config.sweep.maxResyncs;
  const perMinute = opts.perMinute ?? config.sweep.perMinute;
  const dryRun = opts.dryRun ?? false;

  const to = new Date();
  const from = new Date(to.getTime() - minutesBack * 60_000);
  const win = { from: iso(from), to: iso(to) };

  const client = db();
  const cfg = await getSyncConfig(client, config.tenantId);
  if (!cfg.api_key) throw new Error("no Zuper API key configured");

  const wait = pacer(perMinute);
  const result: SweepResult = {
    window: win, inWindow: 0, examined: 0, drifted: 0, unmapped: 0,
    resynced: 0, failed: 0, stoppedEarly: false, pagedRequests: 0,
  };

  // The filter lives in the query string; count=100 is Zuper's practical page size.
  const q = `filter.updated_at_from=${encodeURIComponent(win.from)}&filter.updated_at_to=${encodeURIComponent(win.to)}`;
  const todo: { uid: string; mapped: boolean }[] = [];

  for (let page = 1; page <= 200; page++) {
    await wait();
    const j = await zuperGet(cfg, `/api/jobs?page=${page}&count=100&${q}`);
    result.pagedRequests++;
    const rows: any[] = j?.data ?? [];
    if (page === 1) result.inWindow = Number(j?.total_records ?? 0);
    if (!rows.length) break;
    result.examined += rows.length;

    // One map lookup per page, not per job.
    const uids = rows.map((r) => r?.job_uid).filter(Boolean) as string[];
    const { data: mapRows, error } = await client.schema("jms").from("zuper_sync_map")
      .select("zuper_uid, synced_at").eq("tenant_id", config.tenantId).eq("entity", "jobs").in("zuper_uid", uids);
    if (error) throw error;
    const seen = new Map((mapRows ?? []).map((m: any) => [m.zuper_uid as string, m.synced_at as string]));

    for (const r of rows) {
      const uid = r?.job_uid as string | undefined;
      if (!uid) continue;
      const syncedAt = seen.get(uid);
      if (syncedAt === undefined) { result.unmapped++; todo.push({ uid, mapped: false }); }
      // String comparison is valid: both are ISO-8601 UTC.
      else if (opts.force || String(r.updated_at ?? "") > String(syncedAt)) { result.drifted++; todo.push({ uid, mapped: true }); }
    }

    const totalPages = Number(j?.total_pages ?? 0);
    if (Number.isFinite(totalPages) && totalPages > 0 && page >= totalPages) break;
    if (rows.length < 100) break;
  }

  if (dryRun) return result;

  for (const item of todo) {
    if (result.resynced + result.failed >= maxResyncs) { result.stoppedEarly = true; break; }
    try {
      await wait();
      result.pagedRequests++;
      // Both passes, whether or not the job is mapped — see note 4.
      await syncRecord("jobs", item.uid, { enrich: "job_details" });
      result.resynced++;
    } catch (err) {
      result.failed++;
      console.warn(`[zupersync] sweep failed for job ${item.uid}: ${errorText(err)}`);
    }
  }

  return result;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startSweep(): void {
  if (!config.sweep.enabled) {
    console.log("[zupersync] window sweep disabled — a delivery Zuper abandons after its retries will be lost");
    return;
  }
  const everyMs = config.sweep.everyMinutes * 60_000;
  timer = setInterval(async () => {
    if (running) return; // never overlap; a slow sweep must not stack
    running = true;
    try {
      const r = await sweepJobs();
      if (r.drifted || r.unmapped || r.failed) {
        console.log(`[zupersync] sweep: ${r.inWindow} in window, ${r.drifted} drifted, ${r.unmapped} unmapped, ${r.resynced} resynced, ${r.failed} failed${r.stoppedEarly ? " (capped)" : ""}`);
      }
    } catch (err) {
      console.warn("[zupersync] sweep failed:", errorText(err));
    } finally {
      running = false;
    }
  }, everyMs);
  timer.unref?.();
  console.log(`[zupersync] window sweep every ${config.sweep.everyMinutes}m over the last ${config.sweep.minutesBack}m (≤${config.sweep.perMinute} req/min)`);
}

export function stopSweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
