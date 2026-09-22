/**
 * The service's own controls.
 *
 * Until now the only way in was a webhook: everything else happened on a timer. That is fine while nothing changes,
 * but a sync that has just learned to carry more fields needs to be told to re-read what it already has, and a person
 * checking the two systems agree needs a way to ask.
 *
 * Authenticated with the same secret the Zuper receiver checks (ZUPER_WEBHOOK_SECRET), in the same header, so there
 * is one secret to keep rather than two. Without it configured these endpoints refuse outright — unlike the webhook
 * receiver, which stores what it cannot verify, because a refused delivery is a lost one. Nothing is lost by
 * refusing a control.
 */
import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { config, errorText, secretConfigured } from "./config.js";
import { one, sql } from "./store.js";
import { tuper } from "./tuper-client.js";
import { withCause } from "./api-log.js";
import { trackWrite } from "./tuper-writes.js";
import { ENTITIES, getSyncConfig, syncEntity, type Ctx } from "./lib/migration/zuper-sync.js";

export const admin = Router();

function authorised(req: Request): boolean {
  if (!secretConfigured()) return false;
  const given = req.get(config.webhook.header);
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(config.webhook.secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

admin.use((req: Request, res: Response, next) => {
  if (!authorised(req)) {
    res.status(403).json({ ok: false, error: secretConfigured() ? "wrong or missing key" : "no secret configured" });
    return;
  }
  next();
});

/** GET /admin/entities — what can be synced, and when each last ran. */
admin.get("/entities", async (_req: Request, res: Response) => {
  const runs = await sql<{ entity: string; started_at: string; finished_at: string | null; fetched: number; upserted: number; failed: number; status: string | null }>(
    `SELECT DISTINCT ON (entity) entity, started_at, finished_at, fetched, upserted, failed, status
       FROM sync.runs WHERE tenant_id = $1 ORDER BY entity, started_at DESC`,
    [config.tenantId],
  );
  const last = new Map(runs.map((r) => [r.entity, r]));
  res.json({
    ok: true,
    entities: Object.keys(ENTITIES).sort().map((name) => ({ name, last: last.get(name) ?? null })),
  });
});

/**
 * POST /admin/sync/:entity — read that entity from Zuper again and write it through Tuper's API.
 *
 * Idempotent: every record is matched by its Zuper uid, so a re-run updates what is already there rather than making
 * copies. That is what makes it safe to run after the importer learns a new field.
 */
admin.post("/sync/:entity", async (req: Request, res: Response) => {
  const name = String(req.params.entity ?? "");
  if (!ENTITIES[name]) {
    res.status(404).json({ ok: false, error: `no such entity '${name}'`, entities: Object.keys(ENTITIES).sort() });
    return;
  }
  // Zuper → Tuper switched off on the dashboard means nothing is written to Tuper, a re-sync asked for by hand included.
  if (!config.inbound) {
    res.status(409).json({ ok: false, error: "Zuper → Tuper is off in the dashboard's Settings" });
    return;
  }
  // Answer before the work: a full entity can take minutes, and the caller should not hold a socket open for it.
  res.status(202).json({ ok: true, started: name });

  try {
    const client = tuper();
    const cfg = await getSyncConfig(client as never, config.tenantId);
    if (!cfg.api_key) throw new Error("no Zuper API key configured");
    const ctx: Ctx = { client: client as never, tenantId: config.tenantId, cfg, maps: {}, extra: {} };
    // The whole re-run is one row in sync.tuper_writes, with every call it made.
    const result = await withCause({ origin: "admin" }, () => trackWrite({ entity: name, label: `every ${name} record` },
      () => syncEntity(ctx, name),
      (r) => ({
        action: "re-synced", detail: `${r.fetched} read from Zuper, ${r.upserted} written, ${r.failed} failed`,
        ok: !r.failed, error: r.failed ? `${r.failed} record(s) failed` : null,
      })));
    console.log(`[zupersync] admin sync ${name}: ${result.fetched} fetched, ${result.upserted} upserted, ${result.failed} failed`);
  } catch (err) {
    console.error(`[zupersync] admin sync ${name} failed:`, errorText(err));
  }
});

/** GET /admin/runs — the last runs, newest first, for checking what a sync did. */
admin.get("/runs", async (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20) || 20));
  const runs = await sql(
    `SELECT entity, started_at, finished_at, fetched, upserted, failed, status, detail
       FROM sync.runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT $2`,
    [config.tenantId, limit],
  );
  res.json({ ok: true, runs });
});

/** GET /admin/state — what the service is holding right now: its queue, its unprocessed deliveries, its cursors. */
admin.get("/state", async (_req: Request, res: Response) => {
  const [queue, deliveries, cfg] = await Promise.all([
    one<{ queued: string; failed: string }>(
      `SELECT count(*) FILTER (WHERE status = 'queued')::text AS queued,
              count(*) FILTER (WHERE status = 'failed')::text AS failed
         FROM sync.outbox WHERE tenant_id = $1`, [config.tenantId]),
    one<{ total: string; unprocessed: string; from_tuper: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE processed_at IS NULL AND verified)::text AS unprocessed,
              count(*) FILTER (WHERE source = 'tuper')::text AS from_tuper
         FROM sync.webhook_events WHERE tenant_id = $1`, [config.tenantId]),
    one<{ is_syncing: boolean; last_run_at: string | null; next_run_at: string | null }>(
      `SELECT is_syncing, last_run_at, next_run_at FROM sync.config WHERE tenant_id = $1`, [config.tenantId]),
  ]);
  res.json({ ok: true, queue, deliveries, sync: cfg });
});
