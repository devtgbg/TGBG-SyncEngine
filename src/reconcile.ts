/**
 * Replaying deliveries that never finished.
 *
 * Zuper tries a webhook three times with exponential backoff and then gives up.
 * Everything after that is ours: a delivery stored during a restart, or one whose
 * processing hit a transient Zuper 500, would otherwise sit in the inbox forever
 * and the change would never reach the tables four applications read.
 *
 * This is the modest half of converging with Zuper — it retries what we DID
 * receive. It cannot help with a delivery that never arrived at all; that needs
 * the rolling-window sweep described in config.ts, which is not built.
 *
 * Two properties matter more than the schedule:
 *   • ticks never overlap — a slow batch must not stack a second one on top of
 *     it, or a backlog turns into concurrent Zuper reads against a rate limit;
 *   • attempts are capped — a row that can never succeed (a record deleted in
 *     Zuper, say) must stop being retried rather than burn API budget forever.
 */

import { config, errorText } from "./config.js";
import { processPending } from "./processor.js";

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return; // a previous batch is still going
  running = true;
  try {
    const r = await processPending(config.reconcile.replayBatch);
    // Silent when there is nothing to do, so the log stays readable.
    if (r.attempted > 0) {
      console.log(`[zupersync] replay: ${r.attempted} attempted, ${r.ok} applied, ${r.failed} still failing`);
    }
  } catch (err) {
    console.warn("[zupersync] replay failed:", errorText(err));
  } finally {
    running = false;
  }
}

export function startReplay(): void {
  if (!config.reconcile.enabled) {
    console.log("[zupersync] replay disabled (RECONCILE_ENABLED=false) — failed deliveries will not be retried");
    return;
  }
  const seconds = config.reconcile.replaySeconds;
  timer = setInterval(tick, seconds * 1000);
  // Don't hold the process open for the sake of the timer.
  timer.unref?.();
  console.log(
    `[zupersync] replaying unfinished deliveries every ${seconds}s ` +
    `(up to ${config.reconcile.replayBatch} per pass, ${config.reconcile.replayMaxAttempts} attempts each)`,
  );
}

export function stopReplay(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
