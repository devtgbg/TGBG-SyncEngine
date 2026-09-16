/**
 * Zuper webhook receiver — store, acknowledge, then process.
 *
 * The ACK must never depend on downstream work. A slow or failing upsert must
 * not make Zuper record the delivery as failed, so the request is persisted and
 * answered 200 immediately; processing happens afterwards and can take as long
 * as it needs.
 *
 * Authentication: Zuper has no "secret" field. Each webhook carries ONE custom
 * header defined when the webhook is created (its form fields are literally
 * `key` and `value`). We compare that header in constant time.
 *
 * Deliberate divergence from this codebase's other unauthenticated route
 * (JMS's reports cron, which refuses outright when no secret is set): a webhook
 * that is refused is a webhook that is LOST, because the event won't be resent
 * on our schedule. So an unconfigured secret degrades to capture-but-don't-
 * trust rather than rejection, and a mismatch is stored for forensics without
 * being processed.
 */

import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { config, secretConfigured } from "./config.js";
import { db } from "./supabase.js";

export const receiver = Router();

type Verdict = { verified: boolean; reason: string };

function verify(req: Request): Verdict {
  if (!secretConfigured()) return { verified: false, reason: "no_secret_configured" };
  const given = req.get(config.webhook.header);
  if (!given) return { verified: false, reason: "header_missing" };
  const a = Buffer.from(given);
  const b = Buffer.from(config.webhook.secret);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  return ok ? { verified: true, reason: "header_match" } : { verified: false, reason: "header_mismatch" };
}

/**
 * Zuper doesn't publish its payload schema, and it differs by module, so read
 * defensively. We only need enough to identify WHAT changed — the record itself
 * is always re-fetched from Zuper, which stays the system of record.
 */
export function identify(body: unknown): {
  module: string | null; event: string | null; uid: string | null; workOrder: string | null;
} {
  const b = (body ?? {}) as Record<string, any>;
  const d = (b.data ?? b.payload ?? b.job ?? b) as Record<string, any>;
  const pick = (...vals: unknown[]) =>
    (vals.find((v) => typeof v === "string" && v.length > 0) as string | undefined) ?? null;
  return {
    module: pick(b.webhook_module, b.module, b.entity, b.object_type, b.type),
    event: pick(b.webhook_event, b.event, b.event_type, b.action, b.trigger),
    // Every uid Zuper's nine live webhook modules can carry. Missing one only
    // costs the stored row its zuper_uid (processEvent re-scans the body against
    // the route's own uidFields), but that column is what the log is read by.
    uid: pick(
      d.job_uid, b.job_uid, d.customer_uid, b.customer_uid, d.asset_uid, b.asset_uid,
      d.request_uid, b.request_uid, d.user_uid, b.user_uid,
      // Zuper calls organizations "PROPERTY" on the wire, so both spellings appear.
      d.organization_uid, b.organization_uid, d.property_uid, b.property_uid,
      d.estimate_uid, b.estimate_uid, d.invoice_uid, b.invoice_uid,
      // Service contracts identify by contract_uid in Zuper's own API.
      d.service_contract_uid, b.service_contract_uid, d.contract_uid, b.contract_uid,
      d.product_uid, b.product_uid, d.note_uid, b.note_uid,
      d.timesheet_uid, b.timesheet_uid, d.uid, b.uid,
    ),
    workOrder: d.work_order_number != null ? String(d.work_order_number) : null,
  };
}

/** Persist the delivery. Never throws — a logging failure must not cost us the ACK. */
async function capture(
  req: Request, v: Verdict, ids: ReturnType<typeof identify>,
): Promise<string | null> {
  try {
    const { data, error } = await db().schema("jms").from("zuper_webhook_events").insert({
      tenant_id: config.tenantId,
      received_at: new Date().toISOString(),
      verified: v.verified,
      verify_reason: v.reason,
      module: ids.module,
      event: ids.event,
      zuper_uid: ids.uid,
      work_order_number: ids.workOrder,
      headers: req.headers,
      body: req.body ?? {},
    }).select("id").single();
    if (error) throw error;
    return (data as { id: string }).id;
  } catch (err) {
    // Includes "table does not exist" before the migration is applied — the
    // service still works, it just can't replay.
    console.warn("[zupersync] could not persist delivery:", err instanceof Error ? err.message : err);
    return null;
  }
}

receiver.post("/", async (req: Request, res: Response) => {
  const v = verify(req);
  const ids = identify(req.body);
  const eventId = await capture(req, v, ids);

  console.log("[zupersync] webhook", JSON.stringify({
    id: eventId, verified: v.verified, reason: v.reason,
    module: ids.module, event: ids.event, uid: ids.uid, wo: ids.workOrder,
  }));

  // A mismatched secret is recorded but never acted on. Still a 200: arguing
  // with the sender achieves nothing and invites retries we don't want.
  if (!v.verified && secretConfigured()) {
    res.status(200).json({ ok: true, stored: eventId, processed: false });
    return;
  }

  res.status(200).json({ ok: true, stored: eventId });

  // ── after the ACK ──
  setImmediate(async () => {
    try {
      const { processEvent } = await import("./processor.js");
      await processEvent({ id: eventId, ...ids, body: req.body });
    } catch (err) {
      console.warn("[zupersync] post-ack processing failed:", err instanceof Error ? err.message : err);
    }
  });
});

/** Liveness — Zuper's "test URL" check and our own monitoring both use this. */
receiver.get("/", (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    receiver: "zuper",
    secretConfigured: secretConfigured(),
    header: config.webhook.header,
    at: new Date().toISOString(),
  });
});
