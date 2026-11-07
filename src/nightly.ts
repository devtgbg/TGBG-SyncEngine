/**
 * The nightly reconciliation — "does everything match?", asked once a day.
 *
 * WHY THIS EXISTS BESIDE THE SWEEP, because the two look alike and are not:
 *
 *   sweep.ts asks Zuper what changed in the last `minutesBack` minutes (180). Its input is a time window, so
 *   a record whose updated_at has not moved in that window is never examined — not examined and passed, never
 *   examined at all. It catches a missed delivery within the hour, cheaply, 48 times a day.
 *
 *   This asks for Zuper's WHOLE list of every kind and compares it against every record Tuper has mapped to a
 *   Zuper uid. That is the only question that can see a deletion, a merge, or an entity no sweep covers.
 *
 * The difference is not academic. While the sweep ran clean every 30 minutes: 650 customers deleted in Zuper
 * stayed live here (it compares the rows Zuper LISTS, and an absent row is not in the comparison set); 1,925
 * jobs sat on a customer Zuper had merged away since May 2026 (the merge moved them without touching each
 * job's updated_at); recurring_jobs was frozen from 2026-09-22; asset_history held nothing. Every one was
 * invisible by construction, so "the sweep found nothing" has never been evidence that the copy is complete.
 *
 * READ-ONLY for now, by decision (2026-11-05): a week of nightly reports first, so the normal noise floor is
 * known before anything is fixed automatically. An auto-fixer tuned against a misunderstood baseline makes
 * things worse faster. The buckets it will eventually act on, and the ones it must not, are in
 * docs/NIGHTLY-RECONCILIATION.md §5 — in particular "only in Tuper, still live in Zuper" is usually a MERGE,
 * where deleting would turn a wrong link into a missing record.
 */

import { randomUUID } from "node:crypto";
import { config, errorText } from "./config.js";
import { withCause } from "./api-log.js";
import { sql } from "./store.js";
import { tuper as db } from "./tuper-client.js";
import { getSyncConfig } from "./lib/migration/zuper-sync.js";
import { compare, KINDS, pacer, type Result } from "./lib/reconcile-core.js";

/** Uids kept per bucket on the stored row. Enough to chase a cause; not a dump of a bad night. */
const SAMPLE = 25;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export const nightlyRunning = (): boolean => timer !== null;

/** Milliseconds until the next local `hour`, so the pass lands at the same wall-clock time each night. */
function untilNext(hour: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * WHY each difference exists, from our own delivery log rather than from guesswork.
 *
 * A count is not actionable: "80 missing" could be eighty dropped webhooks or an entity Zuper has no webhook
 * for at all, and those want opposite fixes. Every uid is looked up in sync.webhook_events and sorted into
 * the causes we have actually seen in production:
 *
 *   never-delivered   no event for this uid has EVER arrived. For job_categories, job_statuses and
 *                     recurring_jobs this is every row, because Zuper publishes no event for them.
 *   capped            a delivery arrived, failed, and reached the 5-attempt cap. These NEVER retry — nothing
 *                     in the engine picks them up again, so they sit until a person resets them.
 *   failed            a delivery arrived and failed, still under the cap, so replay may yet fix it.
 *   skipped           deliberately not applied, with its reason recorded on the delivery.
 *   applied-yet-differs  the worst case: we received it, reported success, and the record still disagrees.
 *                     That is a mapping fault or a change Zuper made without an event (a customer merge
 *                     moves jobs without touching each job's updated_at).
 */
async function causesFor(uids: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!uids.length) return out;
  const bump = (k: string, n = 1) => { out[k] = (out[k] ?? 0) + n; };
  const seen = new Set<string>();
  for (let i = 0; i < uids.length; i += 500) {
    const part = uids.slice(i, i + 500);
    const rows = await sql<{ zuper_uid: string; processed_at: string | null; attempts: number; process_error: string | null }>(
      `SELECT zuper_uid, processed_at, attempts, process_error
         FROM sync.webhook_events
        WHERE tenant_id = $1 AND source = 'zuper' AND zuper_uid = ANY($2)`,
      [config.tenantId, part],
    );
    const byUid = new Map<string, typeof rows>();
    for (const r of rows) { const l = byUid.get(r.zuper_uid) ?? []; l.push(r); byUid.set(r.zuper_uid, l); }
    for (const uid of part) {
      seen.add(uid);
      const mine = byUid.get(uid);
      if (!mine?.length) { bump("never-delivered"); continue; }
      const err = mine.filter((d) => d.process_error && !d.process_error.startsWith("skipped:"));
      const stranded = mine.filter((d) => !d.processed_at && d.attempts >= config.reconcile.replayMaxAttempts);
      if (stranded.length) bump("capped");
      else if (err.length) bump("failed");
      else if (mine.every((d) => d.process_error?.startsWith("skipped:"))) bump("skipped");
      else bump("applied-yet-differs");
    }
  }
  return out;
}

async function record(runId: string, startedAt: string, r: Result, ms: number): Promise<void> {
  const cut = (xs: string[]) => xs.slice(0, SAMPLE);
  // Why, not just how many. Only for the buckets a cause can be read for: a record Tuper holds that Zuper no
  // longer lists has no delivery to explain it.
  const why = {
    missing: await causesFor(r.missing),
    behind: await causesFor(r.behind),
  };
  await sql(
    `INSERT INTO sync.reconciliations
       (tenant_id, run_id, started_at, finished_at, kind, in_zuper, in_tuper, excluded,
        missing, behind, only_deleted, only_live, sample, error, ms)
     VALUES ($1,$2,$3,now(),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      config.tenantId, runId, startedAt, r.kind, r.inZuper, r.inTuper, r.excluded,
      r.missing.length, r.behind.length, r.onlyInTuperDeleted.length, r.onlyInTuperLive.length,
      JSON.stringify({
        missing: cut(r.missing), behind: cut(r.behind),
        onlyInTuperLive: cut(r.onlyInTuperLive), onlyInTuperDeleted: cut(r.onlyInTuperDeleted),
        why,
      }),
      r.error ?? null, ms,
    ],
  );
}

/** One pass: every kind, read-only, paced to the sweep's budget so live re-fetches are not starved. */
export async function reconcilePass(): Promise<{ runId: string; kinds: number; differences: number }> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const cfg = await getSyncConfig(db(), config.tenantId);
  if (!cfg.api_key) throw new Error("no Zuper API key configured");
  const pace = pacer(config.sweep.perMinute);

  let differences = 0;
  for (const kind of KINDS) {
    const began = Date.now();
    let result: Result;
    try {
      result = await compare(cfg, kind, pace);
    } catch (err) {
      result = {
        kind: kind.name, inZuper: 0, inTuper: 0, excluded: 0,
        missing: [], behind: [], onlyInTuperDeleted: [], onlyInTuperLive: [], error: errorText(err),
      };
    }
    differences += result.missing.length + result.behind.length + result.onlyInTuperLive.length;
    try {
      await record(runId, startedAt, result, Date.now() - began);
    } catch (err) {
      // A failure to WRITE the report must not lose the rest of the pass.
      console.warn(`[zupersync] reconciliation: could not record ${kind.name}: ${errorText(err)}`);
    }
  }
  console.log(`[zupersync] reconciliation ${runId}: ${KINDS.length} kinds, ${differences} difference(s) — read-only`);
  return { runId, kinds: KINDS.length, differences };
}

/** Start the nightly loop. Safe to call again: a running loop is left as it is. */
export function startNightly(): void {
  if (timer) return;
  const hour = config.nightly.hour;
  const tick = async () => {
    if (running || !config.inbound || !config.nightly.enabled) return;
    running = true;
    try {
      // Every call the pass makes is recorded as the reconciliation's (src/api-log.ts).
      await withCause({ origin: "reconciliation" }, reconcilePass);
    } catch (err) {
      console.warn("[zupersync] reconciliation failed:", errorText(err));
    } finally {
      running = false;
    }
  };
  // Line up with the hour, then every 24h from there.
  const first = setTimeout(() => {
    void tick();
    timer = setInterval(() => void tick(), 24 * 60 * 60_000);
    timer.unref?.();
  }, untilNext(hour));
  first.unref?.();
  timer = timer ?? (first as unknown as ReturnType<typeof setInterval>);
  console.log(`[zupersync] nightly reconciliation at ${String(hour).padStart(2, "0")}:00 local, read-only (≤${config.sweep.perMinute} req/min)`);
}

export function stopNightly(): void {
  if (timer) { clearInterval(timer); clearTimeout(timer as unknown as ReturnType<typeof setTimeout>); timer = null; }
}
