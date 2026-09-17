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
import { dbReachable } from "./supabase.js";
import { receiver } from "./receiver.js";
import { startReplay } from "./reconcile.js";
import { startPusher } from "./pusher.js";
import { startSweep } from "./sweep.js";

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
  const database = await dbReachable();
  res.status(database.ok ? 200 : 503).json({
    ok: database.ok,
    service: "zupersync",
    database,
    webhookSecretConfigured: secretConfigured(),
    at: new Date().toISOString(),
  });
});

app.use("/webhooks/zuper", receiver);

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
});
