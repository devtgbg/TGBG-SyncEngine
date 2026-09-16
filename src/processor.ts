/**
 * Turning a stored webhook delivery into a row in the live tables.
 *
 * A webhook is a trigger, not a payload: we take the record's uid and re-fetch it
 * from Zuper, which is the system of record. That survives payload shapes Zuper
 * has never documented, deliveries that arrive out of order, and the ones that
 * arrive twice.
 *
 * `syncOne` reproduces the per-row body of `syncEntity` (zuper-sync.ts:1734-1785)
 * rather than calling it, because that logic is an inlined closure — there is no
 * single-record entry point. Keep the two in step: map lookup → transform →
 * insert/update → 23505 number-collision recovery → afterWrite.
 *
 * The one thing it deliberately does NOT reproduce is line 1732. `syncEntity`
 * loads the whole zuper_sync_map for the entity and every dependency before it
 * starts; jms.zuper_sync_map holds 513,336 rows, which is correct for a migration
 * and impossible for a webhook. Instead we pre-seed ctx.maps with just the uids
 * that appear in this one record (`seedMaps`), which `ctxMap` then returns
 * untouched because it is memoised on ctx.maps.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { db } from "./supabase.js";
import { config } from "./config.js";
import { ENTITIES, getSyncConfig, zuperGet, type SyncConfig } from "./lib/migration/zuper-sync.js";
import { detailPathFor, isSelfFetching, resolveRoute } from "./routes.js";

/** Structurally identical to zuper-sync.ts's Ctx, which is not exported. */
type Ctx = {
  client: SupabaseClient;
  tenantId: string;
  cfg: SyncConfig;
  maps: Record<string, Map<string, string>>;
  extra: Record<string, any>;
};

const UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every uid-shaped string anywhere in the record, however deeply nested. */
function collectUids(value: unknown, found = new Set<string>(), depth = 0): Set<string> {
  if (depth > 8 || found.size > 400) return found;
  if (typeof value === "string") { if (UID_RE.test(value)) found.add(value); return found; }
  if (Array.isArray(value)) { for (const v of value) collectUids(v, found, depth + 1); return found; }
  if (value && typeof value === "object") { for (const v of Object.values(value)) collectUids(v, found, depth + 1); }
  return found;
}

/**
 * Pre-seed ctx.maps so ctxMap never loads a full entity map.
 *
 * Only uids actually present in the record are looked up. That matters: a map
 * seeded empty means "not imported", and the entity helpers respond to that by
 * CREATING the missing record. Seeding a map we haven't queried would therefore
 * manufacture duplicate customers and organizations. Querying first means an
 * empty result is the truth.
 */
async function seedMaps(ctx: Ctx, record: unknown, extraUids: string[] = []): Promise<void> {
  const uids = [...collectUids(record)];
  for (const u of extraUids) if (u) uids.push(u);
  if (!uids.length) return;

  const { data, error } = await ctx.client
    .schema("jms").from("zuper_sync_map")
    .select("entity, zuper_uid, jms_id")
    .eq("tenant_id", ctx.tenantId)
    .in("zuper_uid", [...new Set(uids)]);
  if (error) throw error;

  for (const row of (data ?? []) as { entity: string; zuper_uid: string; jms_id: string }[]) {
    (ctx.maps[row.entity] ??= new Map()).set(row.zuper_uid, row.jms_id);
  }
}

/** zuper-sync.ts:120 — same upsert, so the two write the map identically. */
async function setMap(ctx: Ctx, entity: string, uid: string, jmsId: string): Promise<void> {
  (ctx.maps[entity] ??= new Map()).set(uid, jmsId);
  await ctx.client.schema("jms").from("zuper_sync_map").upsert(
    { tenant_id: ctx.tenantId, entity, zuper_uid: uid, jms_id: jmsId, synced_at: new Date().toISOString() },
    { onConflict: "tenant_id,entity,zuper_uid" },
  );
}

/** zuper-sync.ts:1764 — records whose number a Tuper-made record may already hold. */
const NUMBERED: Record<string, { kind: "job" | "contract" | "product" | "request"; column: string }> = {
  jobs: { kind: "job", column: "work_order_number" },
  contracts: { kind: "contract", column: "contract_number" },
  products: { kind: "product", column: "product_no" },
  requests: { kind: "request", column: "request_number" },
};

export interface SyncOneResult {
  entity: string;
  uid: string;
  action: "created" | "updated" | "deleted" | "skipped";
  id: string | null;
}

/**
 * Sync exactly one record.
 *
 * `raw` is the record as Zuper returns it. Pass it when you already have it;
 * otherwise give a `detail` path and it is fetched.
 */
export async function syncOne(
  entityName: string,
  uid: string,
  opts: { raw?: any; detail?: ((uid: string) => string) | null; selfFetching?: boolean; client?: SupabaseClient; tenantId?: string } = {},
): Promise<SyncOneResult> {
  const e = ENTITIES[entityName];
  if (!e) throw new Error(`unknown entity ${entityName}`);

  const client = opts.client ?? db();
  const tenantId = opts.tenantId ?? config.tenantId;
  const cfg = await getSyncConfig(client, tenantId);
  if (!cfg.api_key) throw new Error("no Zuper API key configured");

  const ctx: Ctx = { client, tenantId, cfg, maps: {}, extra: {} };

  // The record.
  //
  // A uid stub is valid ONLY for an entity whose transform fetches its own detail
  // (job_details). For every other entity, transform expects the full record, and
  // handing it a stub produces a near-empty payload that would then be written
  // OVER the live row — blanking real data. Refuse instead.
  let r: any = opts.raw;
  if (!r) {
    if (opts.detail) {
      r = (await zuperGet(cfg, opts.detail(uid)))?.data ?? null;
      if (!r) throw new Error(`Zuper returned no record for ${entityName} ${uid}`);
    } else if (opts.selfFetching) {
      r = {};
    } else {
      throw new Error(`${entityName} has no by-uid fetch — refusing to transform a stub, which would overwrite the row with an empty payload`);
    }
  }
  // Ensure the uid is present however the entity reads it.
  const uidKey = Object.keys(r).find((k) => k.endsWith("_uid") && r[k] === uid);
  if (!uidKey) r = { ...r, ...stubUidFields(entityName, uid) };

  await seedMaps(ctx, r, [uid]);

  const mapName = (e as any).mapEntity ?? entityName;
  const map = (ctx.maps[mapName] ??= new Map());

  // ── zuper-sync.ts:1734-1785, for one row ────────────────────────────────────
  const rowUid = e.uid(r) || uid;
  const payload = await e.transform(r, ctx);
  if (!payload) throw new Error(`${entityName} ${uid}: transform produced nothing`);

  let id = map.get(rowUid) ?? null;
  const isNew = !id;

  const write = async () => {
    if (id) {
      if (Object.keys(payload).length) {
        const { error } = await client.schema(e.schema).from(e.table).update(payload).eq("id", id).eq("tenant_id", tenantId);
        if (error) throw error;
      }
    } else if ((e as any).enrichOnly) {
      throw new Error(`${uid} is not imported yet`);
    } else if ((e as any).insert) {
      id = await (e as any).insert(ctx, payload, r);
      await setMap(ctx, mapName, rowUid, id!);
    } else {
      const { data, error } = await client.schema(e.schema).from(e.table).insert({ ...payload, tenant_id: tenantId }).select("id").single();
      if (error) throw error;
      id = (data as any).id as string;
      await setMap(ctx, mapName, rowUid, id);
    }
  };

  try {
    await write();
  } catch (writeErr) {
    // A number a record made in Tuper already took (migrations 00076, 00094):
    // that record moves up, and this write goes through.
    const n = NUMBERED[entityName];
    const value = n ? (payload as any)[n.column] : undefined;
    if ((writeErr as { code?: string })?.code !== "23505" || !n || value == null || value === "") throw writeErr;
    const { releaseNumber } = await import("./lib/list-contract/record-numbers.js");
    const moved = await releaseNumber(client, tenantId, n.kind, value as string | number, id ?? undefined);
    if (!moved) throw writeErr;
    console.log(`[zupersync] ${n.kind} ${moved.from} was taken by a record made in Tuper — that record is now ${moved.to}`);
    await write();
  }

  if ((e as any).afterWrite) await (e as any).afterWrite(ctx, id!, r, isNew);
  return { entity: entityName, uid: rowUid, action: isNew ? "created" : "updated", id };
}

/** Give a stub record the uid field its entity reads. */
function stubUidFields(entityName: string, uid: string): Record<string, string> {
  const byEntity: Record<string, string> = {
    jobs: "job_uid", job_details: "job_uid", job_activity: "job_uid",
    customers: "customer_uid", organizations: "organization_uid", users: "user_uid",
    assets: "asset_uid", estimates: "estimate_uid", invoices: "invoice_uid",
    contracts: "service_contract_uid", products: "product_uid", requests: "request_uid",
  };
  const k = byEntity[entityName];
  return k ? { [k]: uid } : { uid };
}

/** Mark a record deleted rather than re-fetching what Zuper has already removed. */
async function markDeleted(entityName: string, uid: string): Promise<SyncOneResult> {
  const e = ENTITIES[entityName];
  const client = db();
  const tenantId = config.tenantId;
  const mapName = (e as any)?.mapEntity ?? entityName;

  const { data } = await client.schema("jms").from("zuper_sync_map")
    .select("jms_id").eq("tenant_id", tenantId).eq("entity", mapName).eq("zuper_uid", uid).maybeSingle();
  const id = (data as any)?.jms_id as string | undefined;
  if (!id) return { entity: entityName, uid, action: "skipped", id: null };

  const { error } = await client.schema(e.schema).from(e.table)
    .update({ is_deleted: true }).eq("id", id).eq("tenant_id", tenantId);
  if (error) throw error;
  return { entity: entityName, uid, action: "deleted", id };
}

export interface Delivery {
  id: string | null;
  module?: string | null;
  event?: string | null;
  uid?: string | null;
  workOrder?: string | null;
  body?: any;
}

/**
 * Process one stored delivery. Called after the 200 has already gone out, so it
 * must never throw into the request — it records its outcome on the row instead.
 */
export async function processEvent(delivery: Delivery): Promise<SyncOneResult | { action: "skipped"; reason: string }> {
  // Count the attempt, so a delivery that keeps failing reads as "tried 4 times"
  // in the log rather than just "unprocessed" — and keep updated_at current,
  // which nothing else was doing.
  let attempt = 0;
  if (delivery.id) {
    const { data } = await db().schema("jms").from("zuper_webhook_events")
      .select("attempts").eq("id", delivery.id).maybeSingle();
    attempt = (((data as { attempts?: number } | null)?.attempts) ?? 0) + 1;
  }

  const finish = async (patch: Record<string, unknown>) => {
    if (!delivery.id) return;
    try {
      await db().schema("jms").from("zuper_webhook_events")
        .update({ ...patch, attempts: attempt, updated_at: new Date().toISOString() })
        .eq("id", delivery.id);
    } catch (err) {
      console.warn("[zupersync] could not record processing outcome:", err instanceof Error ? err.message : err);
    }
  };

  try {
    const route = resolveRoute(delivery.module ?? "", delivery.event ?? "");
    if (!route) {
      const reason = `no route for module "${delivery.module}" event "${delivery.event}"`;
      await finish({ processed_at: new Date().toISOString(), process_error: reason });
      return { action: "skipped", reason };
    }
    if (route.skip) {
      await finish({ processed_at: new Date().toISOString(), sync_entity: route.entity, process_error: `skipped: ${route.skip}` });
      return { action: "skipped", reason: route.skip };
    }

    const uid = delivery.uid || route.uidFields.map((f) => findUid(delivery.body, f)).find(Boolean) || null;
    if (!uid) {
      const reason = `none of ${route.uidFields.join(", ")} found in the delivered body`;
      await finish({ processed_at: new Date().toISOString(), sync_entity: route.entity, process_error: reason });
      return { action: "skipped", reason };
    }

    let result: SyncOneResult;
    if (route.deletion) {
      result = await markDeleted(route.entity, uid);
    } else {
      try {
        result = await syncOne(route.entity, uid, { detail: route.detail, selfFetching: route.fetch === "self" });
      } catch (err) {
        // enrichOnly entities refuse a record they have never imported — that is
        // exactly what a "New …" webhook is, so fall back to the create entity.
        const msg = err instanceof Error ? err.message : String(err);
        if (route.createEntity && /is not imported yet/.test(msg)) {
          const detail = detailPathFor(route.createEntity);
          await syncOne(route.createEntity, uid, { detail, selfFetching: isSelfFetching(route.createEntity) });
          result = await syncOne(route.entity, uid, { detail: route.detail, selfFetching: route.fetch === "self" });
        } else throw err;
      }
    }

    await finish({ processed_at: new Date().toISOString(), process_error: null, sync_entity: result.entity });
    console.log(`[zupersync] ${delivery.module}/${delivery.event} → ${result.entity} ${result.action} ${result.id ?? ""}`.trim());
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[zupersync] processing failed for ${delivery.module}/${delivery.event}: ${msg}`);
    await finish({ process_error: msg.slice(0, 400) });
    throw err;
  }
}

/**
 * Replay stored deliveries that never completed — the interval in reconcile.ts,
 * and manual retries.
 *
 * Capped by attempts on purpose: a delivery that can never succeed (its record
 * was deleted in Zuper, or it names an entity we cannot fetch by uid) would
 * otherwise be retried on every pass forever, against a rate-limited API. Past
 * the cap it stays in the log with its error, visible in the dashboard, and stops
 * consuming budget.
 */
export async function processPending(limit = 50): Promise<{ attempted: number; ok: number; failed: number }> {
  const { data, error } = await db().schema("jms").from("zuper_webhook_events")
    .select("id, module, event, zuper_uid, work_order_number, body")
    .eq("tenant_id", config.tenantId)
    // Only ever replay deliveries that PASSED verification.
    //
    // Without this the two halves combine into a hole: the receiver correctly
    // refuses a delivery whose secret header did not match, storing it with
    // verified = false and processed_at = null — and those are exactly the rows
    // this query would otherwise select, so the replay loop would process a
    // forged request minutes after the door was shut on it.
    .eq("verified", true)
    .is("processed_at", null)
    .lt("attempts", config.reconcile.replayMaxAttempts)
    .order("received_at", { ascending: true })
    .limit(limit);
  if (error) throw error;

  let ok = 0, failed = 0;
  for (const row of (data ?? []) as any[]) {
    try {
      await processEvent({ id: row.id, module: row.module, event: row.event, uid: row.zuper_uid, workOrder: row.work_order_number, body: row.body });
      ok++;
    } catch { failed++; }
  }
  return { attempted: (data ?? []).length, ok, failed };
}

/** Find a uid in a body whose shape Zuper does not document. */
function findUid(body: any, field: string, depth = 0): string | null {
  if (!body || typeof body !== "object" || depth > 6) return null;
  const direct = body[field];
  if (typeof direct === "string" && direct) return direct;
  for (const v of Object.values(body)) {
    if (v && typeof v === "object") { const hit = findUid(v, field, depth + 1); if (hit) return hit; }
  }
  return null;
}
