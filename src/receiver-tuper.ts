/**
 * Tuper's webhooks — the other direction.
 *
 * A change made in Tuper used to reach this service through a database trigger that wrote a row into an outbox table
 * inside Tuper's own database. That is why the service needed a database key, and it is the last thing standing
 * between it and talking to both systems purely over their APIs.
 *
 * Now Tuper delivers the change here, in the same shape Zuper delivers one (its payloads are Zuper's, field for
 * field), and this module turns it into a queued push in this service's own store. The pusher takes it from there.
 *
 * The echo guard is Tuper's side: a write this service makes through Tuper's sync endpoints fires no webhook, so a
 * change that came from Zuper is never sent back to Zuper. Nothing here has to recognise its own handiwork.
 */

import { Router, type Request, type Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config, errorText } from "./config.js";
import { one, sql } from "./store.js";
import { tuper } from "./tuper-client.js";
import { withCause } from "./api-log.js";

export const tuperReceiver = Router();

/** Tuper's event → what it means for the record, and which fields changed. */
interface Queued { entity: string; operation: "create" | "update" | "delete"; changed: Record<string, true> }

const EVENTS: Record<string, (body: Record<string, any>) => Queued | null> = {
  "job.new": () => ({ entity: "jobs", operation: "create", changed: {} }),
  "job.update": (b) => ({
    entity: "jobs", operation: "update",
    changed: Object.fromEntries((Array.isArray(b.updated_fields) ? b.updated_fields : []).map((f: string) => [f, true as const])),
  }),
  "job.delete": () => ({ entity: "jobs", operation: "delete", changed: {} }),
  "job.update_schedule": () => ({ entity: "jobs", operation: "update", changed: { scheduled_start_time: true, scheduled_end_time: true } }),
  "job.status_update": () => ({ entity: "jobs", operation: "update", changed: { current_status_id: true } }),
  "job.assign_users": () => ({ entity: "jobs", operation: "update", changed: { _assignees: true } }),
  "job.unassign_users": () => ({ entity: "jobs", operation: "update", changed: { _assignees: true } }),
  "customer.create": () => ({ entity: "customers", operation: "create", changed: {} }),
  "customer.update": (b) => ({
    entity: "customers", operation: "update",
    changed: Object.fromEntries((Array.isArray(b.updated_fields) ? b.updated_fields : []).map((f: string) => [f, true as const])),
  }),
  "customer.delete": () => ({ entity: "customers", operation: "delete", changed: {} }),
};

/**
 * The events this receiver acts on, for the dashboard's Connections page: what each queues, and the module the webhook
 * has to be registered under in Tuper for its body to carry the record's uid.
 */
export function tuperEventCatalogue(): { event: string; entity: string; operation: string; module: string }[] {
  return Object.entries(EVENTS).map(([event, rule]) => {
    const q = rule({});
    return { event, entity: q?.entity ?? "", operation: q?.operation ?? "", module: event.startsWith("job.") ? "JOB" : "CUSTOMER" };
  });
}

/** The record a delivery is about, as Tuper names it. */
function uidOf(event: string, body: Record<string, any>): string | null {
  const key = event.startsWith("job.") ? "job_uid" : event.startsWith("customer.") ? "customer_uid" : null;
  const value = key ? body[key] : null;
  return typeof value === "string" && value ? value : null;
}

/**
 * Tuper signs a delivery with the webhook's secret, as Zuper signs with its header. Same rule as the Zuper receiver:
 * a delivery that cannot be verified is stored and refused rather than dropped, because a refused delivery is a lost
 * one — nothing resends it on our schedule.
 */
function verify(req: Request): { verified: boolean; reason: string } {
  const secret = config.tuperWebhook.secret;
  if (!secret) return { verified: false, reason: "no_secret_configured" };
  const given = req.get("x-tuper-signature");
  if (!given) return { verified: false, reason: "signature_missing" };
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!raw) return { verified: false, reason: "raw_body_missing" };
  const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(given), b = Buffer.from(expected);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  return ok ? { verified: true, reason: "signature_match" } : { verified: false, reason: "signature_mismatch" };
}

/** Both names for the record: the Tuper id the outbox needs, and the Zuper uid the push needs. */
async function identify(uid: string, entity: string): Promise<{ jmsId: string; zuperUid: string | null }> {
  const mapEntity = entity === "jobs" ? "jobs" : entity === "customers" ? "customers" : entity;
  const { data } = await tuper().schema("jms").from("zuper_sync_map")
    .select("jms_id, zuper_uid").eq("entity", mapEntity).eq("zuper_uid", uid).maybeSingle();
  const row = data as { jms_id: string; zuper_uid: string } | null;
  // Mapped: the delivery named the Zuper uid. Unmapped: Tuper made this record, so the uid is its own id and Zuper
  // has never seen it — the pusher will create it there.
  return row ? { jmsId: row.jms_id, zuperUid: row.zuper_uid } : { jmsId: uid, zuperUid: null };
}

tuperReceiver.post("/", async (req: Request, res: Response) => {
  const v = verify(req);
  const body = (req.body ?? {}) as Record<string, any>;
  const event = typeof body.event === "string" ? body.event : null;
  const uid = event ? uidOf(event, body) : null;

  let stored: string | null = null;
  try {
    const row = await one<{ id: string }>(
      `INSERT INTO sync.webhook_events
         (tenant_id, source, verified, verify_reason, module, event, zuper_uid, headers, body)
       VALUES ($1, 'tuper', $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [config.tenantId, v.verified, v.reason, event ? event.split(".")[0].toUpperCase() : null, event, uid,
       JSON.stringify(req.headers), JSON.stringify(body)],
    );
    stored = row?.id ?? null;
  } catch (err) {
    console.warn("[zupersync] could not persist a Tuper delivery:", errorText(err));
  }

  // Acknowledge first: queuing must never make Tuper record the delivery as failed.
  res.status(200).json({ ok: true, stored });

  // Refused: stored for the record and never acted on, as with Zuper's.
  if (!v.verified) return;
  // Every verified delivery ends with an outcome. One left open would read as "waiting" for ever, and nothing
  // replays a Tuper delivery.
  if (!event) { await finish(stored, "the delivery names no event"); return; }
  const rule = EVENTS[event];
  if (!rule) { await finish(stored, `skipped: Zupersync does not push ${event} to Zuper`); return; }
  // Pushing to Zuper switched off on the dashboard: nothing would ever send the change, so it is not queued. (Queued
  // while off, 69 changes piled up in three days and had to be discarded by hand on 2026-09-22.)
  if (config.push.mode === "off") { await finish(stored, "skipped: pushing to Zuper is off, so the change is not queued"); return; }
  if (!uid) {
    // Seen on 2026-09-17: Tuper builds job.new, job.update, job.delete and customer.* bodies from the webhook's
    // module, and leaves the uid out when that module is not one it knows (registered as JOBS instead of JOB).
    const key = event.startsWith("job.") ? "job_uid" : "customer_uid";
    await finish(stored, `Tuper sent ${event} without ${key}, so there is no record to queue. ` +
      `Tuper leaves it out when the webhook's module is not one it knows: it must be ${key === "job_uid" ? "JOB" : "CUSTOMER"}.`);
    return;
  }
  try {
    const queued = rule(body);
    if (!queued) { await finish(stored, `skipped: nothing to queue for ${event}`); return; }
    await withCause({ origin: "tuper-webhook", eventId: stored }, async () => {
      const { jmsId, zuperUid } = await identify(uid, queued.entity);
      await sql(
        `INSERT INTO sync.outbox (tenant_id, entity, jms_id, zuper_uid, operation, changed, origin, actor_id, event_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'app', $7, $8)`,
        [config.tenantId, queued.entity, jmsId, zuperUid, queued.operation, JSON.stringify(queued.changed),
         body.triggered_by?.user_uid ?? null, stored],
      );
    });
    await finish(stored, null);
  } catch (err) {
    await finish(stored, errorText(err));
  }
});

async function finish(id: string | null, error: string | null): Promise<void> {
  if (!id) return;
  try {
    await sql("UPDATE sync.webhook_events SET processed_at = now(), process_error = $2 WHERE id = $1",
      [id, error ? error.slice(0, 400) : null]);
  } catch (err) {
    console.warn("[zupersync] could not record a Tuper delivery's outcome:", errorText(err));
  }
}
