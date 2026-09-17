/**
 * Run the rolling-window sweep by hand.
 *
 *   npm run sweep                          # dry run — reports, writes nothing
 *   npm run sweep -- --minutes 180
 *   npm run sweep -- --apply               # actually re-sync the drifted jobs
 *   npm run sweep -- --apply --max 50      # bounded first run
 *   npm run sweep -- --apply --force       # every job in the window, drifted or not
 *   npm run sweep -- --records             # everything but jobs: which records are behind (dry run)
 *   npm run sweep -- --records --full --apply   # incl. customers, organizations, assets, products
 *
 * DRY RUN IS THE DEFAULT, as with simulate: there is no local database, so a
 * sweep writes the live jms.* rows four applications read.
 *
 * Measured 2026-09-16 over a 7-day window: 1,319 jobs changed — 458 drifted,
 * 706 already current, 155 never imported. So a first catch-up is ~613
 * re-fetches, roughly 14 minutes at 45 req/min. The per-run cap exists so that
 * work is spread across several runs instead of saturating Zuper's 150/min in
 * one burst while live webhooks are competing for it.
 */

import { sweepJobs, sweepOtherRecords } from "../sweep.js";
import { config } from "../config.js";

const argv = process.argv.slice(2);
const has = (n: string) => argv.includes(`--${n}`);
const num = (n: string, d: number) => {
  const i = argv.indexOf(`--${n}`);
  const v = i >= 0 ? Number(argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : d;
};

async function main() {
  const dryRun = !has("apply");
  if (has("records")) {
    const started = Date.now();
    const kinds = await sweepOtherRecords({ full: has("full"), dryRun, maxResyncs: num("max", config.sweep.maxResyncs) });
    for (const k of kinds) {
      console.log(`${k.kind.padEnd(17)} listed ${String(k.listed).padStart(5)}  missing ${String(k.missing).padStart(3)}  behind ${String(k.behind).padStart(3)}` +
        (dryRun ? "" : `  synced ${String(k.resynced).padStart(3)}  failed ${k.failed}${k.errors.length ? `  (${k.errors.join(" | ")})` : ""}`));
    }
    console.log(`${dryRun ? "DRY RUN — nothing written. " : ""}${Math.round((Date.now() - started) / 1000)}s`);
    return;
  }
  const minutesBack = num("minutes", config.sweep.minutesBack);
  const maxResyncs = num("max", config.sweep.maxResyncs);
  const perMinute = num("rate", config.sweep.perMinute);
  const force = has("force");

  console.log(`window     : last ${minutesBack} minute(s)`);
  console.log(`pace       : ${perMinute} req/min (Zuper allows 150 on this account)`);
  console.log(`cap        : ${maxResyncs} re-sync(es) per run`);
  console.log(`mode       : ${dryRun ? "DRY RUN — nothing will be written" : "APPLY — writes live jms.* rows"}${force ? " (FORCE: every job in the window)" : ""}`);
  console.log("");

  const started = Date.now();
  const r = await sweepJobs({ minutesBack, maxResyncs, perMinute, dryRun, force });
  const secs = Math.round((Date.now() - started) / 1000);

  console.log(`from       : ${r.window.from}`);
  console.log(`to         : ${r.window.to}`);
  console.log(`in window  : ${r.inWindow}`);
  console.log(`examined   : ${r.examined}`);
  console.log(`drifted    : ${r.drifted}   (${force ? "mapped — forced" : "Zuper newer than our synced_at"})`);
  console.log(`unmapped   : ${r.unmapped}   (never imported)`);
  if (!dryRun) {
    console.log(`re-synced  : ${r.resynced}`);
    console.log(`failed     : ${r.failed}`);
    if (r.stoppedEarly) console.log(`capped     : yes — ${r.drifted + r.unmapped - r.resynced - r.failed} left for the next run`);
  }
  console.log(`page reqs  : ${r.pagedRequests} in ${secs}s  (each re-sync makes further Zuper calls, not counted here)`);

  if (dryRun && (r.drifted || r.unmapped)) {
    console.log("");
    console.log(`${r.drifted + r.unmapped} job(s) would be re-fetched. Re-run with --apply to do it.`);
  }
  if (!dryRun && r.failed) process.exit(1);
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
