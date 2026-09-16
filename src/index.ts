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

const app = express();

// Keep the raw body: a future signing scheme (or a payload we need to prove we
// received verbatim) can't be reconstructed from the parsed object.
app.use(express.json({
  limit: "2mb",
  verify: (req, _res, buf) => { (req as express.Request & { rawBody?: Buffer }).rawBody = buf; },
}));

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
    console.warn("[zupersync] ZUPER_WEBHOOK_SECRET is not set — deliveries will be captured but marked unverified");
  }
});
