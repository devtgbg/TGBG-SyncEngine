/**
 * Zupersync — the Zuper ↔ Supabase sync service.
 *
 * Zuper stays the system of record. This service keeps the shared database
 * live: it receives Zuper webhooks, re-fetches the changed record from Zuper's
 * API, and upserts it into the jms.* tables every other application already
 * reads. There is no mirror schema and no second copy of the data.
 *
 *   Zuper ──webhook──▶ Zupersync ──upsert──▶ Supabase (jms.*)
 *                          ▲                      │
 *                          └──── push back ───────┘  (app-side changes)
 */

import express from "express";
import { config, secretConfigured } from "./config.js";
import { tuperReachable } from "./tuper-client.js";
import { migrate, storeReachable } from "./store.js";
import { tuperReceiver } from "./receiver-tuper.js";
import { admin } from "./admin.js";
import { receiver } from "./receiver.js";
import { startReplay } from "./reconcile.js";
import { pushState, startPusher } from "./pusher.js";
import { startSweep } from "./sweep.js";
import { flush as flushApiLog, startApiLogPurge } from "./api-log.js";

const app = express();

// Keep the raw body: a future signing scheme (or a payload we need to prove we
// received verbatim) can't be reconstructed from the parsed object.
app.use(express.json({
  limit: "2mb",
  verify: (req, _res, buf) => { (req as express.Request & { rawBody?: Buffer }).rawBody = buf; },
}));

/**
 * A body express.json() could not parse must not become a 400.
 *
 * Zuper retries a non-2XX three times with exponential backoff and then gives
 * up. A malformed or wrongly-typed body fails identically every time, so a 400
 * spends all three retries and loses the delivery — and because the failure
 * happens in the parser, the receiver never runs and nothing is stored, leaving
 * no forensic record and nothing to replay.
 *
 * Store it and answer 200 instead. Only on the webhook path: elsewhere a 400 for
 * malformed input is the right answer.
 */
app.use(async (err: Error & { type?: string; status?: number }, req: express.Request, res: express.Response, next: express.NextFunction) => {
  const isBodyError = err?.type === "entity.parse.failed" || err?.type === "entity.too.large" || err?.type === "encoding.unsupported";
  if (!isBodyError || !req.path.startsWith("/webhooks/")) return next(err);

  console.warn(`[zupersync] unparseable delivery (${err.type}): ${err.message}`);

  // Awaited, exactly like the normal path: storing is the whole point of not
  // returning 400, and the ACK carrying the id is what makes the delivery
  // findable in the log afterwards. capture never throws, but the import might,
  // and a failure here must still not cost us the 200.
  let stored: string | null = null;
  try {
    const { captureUnparseable } = await import("./receiver.js");
    stored = await captureUnparseable(req, err);
  } catch (e) {
    console.warn("[zupersync] could not store unparseable delivery:", e instanceof Error ? e.message : e);
  }
  res.status(200).json({ ok: true, stored, processed: false, reason: err.type });
});

app.get("/health", async (_req, res) => {
  // Two things this service depends on now: Tuper's API for the records, and its own database for its log and queue.
  const [tuper, own] = await Promise.all([tuperReachable(), storeReachable()]);
  const ok = tuper.ok && own.ok;
  res.status(ok ? 200 : 503).json({
    ok,
    service: "zupersync",
    tuper,
    store: own,
    webhookSecretConfigured: secretConfigured(),
    // Whether changes made in Tuper reach Zuper, and for which kinds of record. Names only,
    // no secrets: this is the one fact about a deployment nobody should have to guess.
    push: pushState(),
    at: new Date().toISOString(),
  });
});

app.use("/webhooks/zuper", receiver);
// Changes made in Tuper arrive the same way Zuper's do, and are queued for Zuper (src/receiver-tuper.ts).
app.use("/webhooks/tuper", tuperReceiver);
// The service's own controls: re-run an entity, see what it is holding (src/admin.ts). Same secret as the receiver.
app.use("/admin", admin);

// The store is brought up to date before anything is served: nothing works without its log, queue and config.
const booted = migrate()
  .then(({ applied }) => { if (applied.length) console.log(`[zupersync] store ready (${applied.length} applied)`); })
  .catch((err) => {
    console.error("[zupersync] the store could not be prepared:", err instanceof Error ? err.message : err);
    process.exit(1);
  });

await booted;

app.listen(config.port, () => {
  console.log(`[zupersync] listening on :${config.port} (${config.nodeEnv})`);
  if (!secretConfigured()) {
    console.warn(
      config.isProduction
        ? "[zupersync] ZUPER_WEBHOOK_SECRET is NOT SET — this endpoint is public and every delivery will be stored but REFUSED. Set it."
        : "[zupersync] ZUPER_WEBHOOK_SECRET is not set — deliveries will be captured but marked unverified",
    );
  }
  // Retry what was received but never finished. Without this a delivery that
  // failed once is simply lost, and the tables quietly drift from Zuper.
  startReplay();
  // Re-read jobs Zuper changed recently whose webhook never arrived (Zuper gives
  // up after its retries). Each run is capped, and ticks never overlap.
  startSweep();
  // Changes made in Tuper, towards Zuper. Dry run unless PUSH_MODE=live.
  startPusher();
  // Old API call bodies and rows go on a timer (src/api-log.ts).
  startApiLogPurge();
});

// A deploy stops the container with SIGTERM. The API calls recorded in the last second are still in memory: write them
// before going, but never hold the stop up for long.
process.once("SIGTERM", () => {
  const exit = () => process.exit(0);
  setTimeout(exit, 5_000).unref();
  void flushApiLog().finally(exit);
});
