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
 * ONE DELIBERATE DIVERGENCE from that closure: syncOne refreshes
 * zuper_sync_map.synced_at on UPDATE as well as on create; syncEntity only
 * does so on create (zuper-sync.ts:1750, 1755 — both insert branches).
 *
 * That is correct for a bulk migration, where synced_at means "imported at"
 * and zuper-sync.ts:1110 uses `.lt("synced_at", cutoff)` as a resume marker so
 * the job_details enrichment pass can skip what it already did. Refreshing it
 * there would make that pass re-scan everything, every run.
 *
 * But the window sweep decides what has drifted by comparing Zuper's updated_at
 * against synced_at, so for single-record syncs the column has to mean "last
 * synced" or the sweep can never converge. Hence the split.
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
import { config, errorText } from "./config.js";
import { ENTITIES, getSyncConfig, zuperGet, type SyncConfig } from "./lib/migration/zuper-sync.js";
import { detailPathFor, isSelfFetching, resolveRoute, type NoteHost, type Route } from "./routes.js";

/** Structurally identical to zuper-sync.ts's Ctx, which is not exported. */
type Ctx = {
  client: SupabaseClient;
  tenantId: string;
  cfg: SyncConfig;
  maps: Record<string, Map<string, string>>;
  extra: Record<string, any>;
};

const UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Zuper's older records are keyed by 24-hex object ids (checklist entries, attachments). */
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/**
 * Every string anywhere in the record that the sync map could be keyed by:
 * uids, object ids, and attachment links (an attachment with neither id is
 * mapped by its URL).
 */
function collectUids(value: unknown, found = new Set<string>(), depth = 0): Set<string> {
  if (depth > 8 || found.size > 400) return found;
  if (typeof value === "string") {
    if (UID_RE.test(value) || OBJECT_ID_RE.test(value) || (value.startsWith("https://") && value.length <= 1024)) found.add(value);
    return found;
  }
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
async function seedMaps(ctx: Ctx, record: unknown, extraUids: string[] = [], preseedComplete = true): Promise<void> {
  const uids = [...collectUids(record)];
  for (const u of extraUids) if (u) uids.push(u);
  if (!uids.length) return;

  // In chunks bounded by length as well as count: links are long, and the list
  // travels in the request URL.
  const keys = [...new Set(uids)];
  for (let i = 0; i < keys.length;) {
    const chunk: string[] = [];
    let len = 0;
    while (i < keys.length && chunk.length < 100 && len + keys[i].length < 3500) { len += keys[i].length + 3; chunk.push(keys[i++]); }
    if (!chunk.length) { i++; continue; }   // a single key too long to send is simply not pre-seeded
    const { data, error } = await ctx.client
      .schema("jms").from("zuper_sync_map")
      .select("entity, zuper_uid, jms_id")
      .eq("tenant_id", ctx.tenantId)
      .in("zuper_uid", chunk);
    if (error) throw error;
    for (const row of (data ?? []) as { entity: string; zuper_uid: string; jms_id: string }[]) {
      (ctx.maps[row.entity] ??= new Map()).set(row.zuper_uid, row.jms_id);
    }
  }

  // Two maps are too big to load whole — files (361k rows) and checklist
  // responses (36k) — and loading them is what made one note or one job take
  // most of a minute. Their keys are always ids or links carried in the record
  // itself, all of which were looked up above, so an absent key really is new.
  // (Attachments are also matched by link before insert, so a miss cannot
  // duplicate a file.) Every other map stays lazy, per the note above.
  if (preseedComplete) {
    for (const entity of ["files", "checklist_responses"]) ctx.maps[entity] ??= new Map();
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
  opts: {
    raw?: any; detail?: ((uid: string) => string) | null; selfFetching?: boolean; client?: SupabaseClient; tenantId?: string;
    /** For a self-fetching entity: the full record, so the maps are seeded from it rather than from a uid stub. */
    seed?: any;
  } = {},
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

  // A self-fetching entity only has a uid stub here; the record it will fetch
  // names other ids (parent job, assets, statuses), so seed from the full record
  // when the caller has it. Without one, the big maps stay lazy: the stub cannot
  // vouch for the keys the transform will look up.
  if (opts.seed) await seedMaps(ctx, opts.seed, [uid]);
  await seedMaps(ctx, r, [uid], !opts.selfFetching || !!opts.seed);

  const mapName = (e as any).mapEntity ?? entityName;
  const map = (ctx.maps[mapName] ??= new Map());

  // ── zuper-sync.ts:1734-1785, for one row ────────────────────────────────────
  const rowUid = e.uid(r) || uid;
  const payload = await e.transform(r, ctx);
  if (!payload) throw new Error(`${entityName} ${uid}: transform produced nothing`);

  // Transforms write is_deleted but not deleted_at, while markDeleted stamps both.
  // Without this a recovered record (estimate.recover, asset.recover, user.recover)
  // would come back live yet still carry the date it was deleted. Only when the
  // transform itself wrote is_deleted: every table that has it has deleted_at too.
  if ((payload as any).is_deleted === false && !("deleted_at" in payload)) (payload as any).deleted_at = null;

  let id = map.get(rowUid) ?? null;
  const isNew = !id;

  const write = async () => {
    if (id) {
      if (Object.keys(payload).length) {
        const { error } = await client.schema(e.schema).from(e.table).update(payload).eq("id", id).eq("tenant_id", tenantId);
        if (error) throw error;
      }
      // Refresh synced_at on UPDATE too, not only on create.
      //
      // Without this, synced_at means "when we first imported this record" and
      // never moves again — so the window sweep, which decides what has drifted by
      // comparing Zuper's updated_at against synced_at, can never converge. It
      // re-fetches the same jobs every run, for ever, against a rate limit shared
      // with live webhook traffic — while looking like it works, because the rows
      // really are updated correctly. There is simply no progress.
      //
      // Verified: six jobs the sweep had just re-synced still carried synced_at
      // from 11-15 September, and all six read as drifted on the very next pass.
      //
      // setMap upserts on (tenant_id, entity, zuper_uid), so this is idempotent:
      // it rewrites the same jms_id and moves the timestamp.
      await setMap(ctx, mapName, rowUid, id);
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

/**
 * One record at a time.
 *
 * Deliveries are processed as soon as they are acknowledged, and Zuper sends
 * several for one change (a job completed fires a status update, a checklist
 * update and a timelog within a second). The job writers clear a job's
 * assignments, teams and status history and insert them again, so two rebuilds
 * of the same job running at once can interleave. Chaining per uid makes the
 * later delivery wait for the earlier one; it then re-reads Zuper and writes the
 * newer state. One process serves the webhooks, so an in-memory chain suffices.
 */
const chains = new Map<string, Promise<unknown>>();
export function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = chains.get(key) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  chains.set(key, tail);
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}

/** Resolves once nothing is queued under `key`. */
export async function whenIdle(key: string): Promise<void> {
  await (chains.get(key) ?? Promise.resolve()).catch(() => undefined);
}

/**
 * Held by the pusher while it creates a job in Zuper and maps the new uid to the
 * Tuper row. Job events wait for it, so the webhook Zuper fires for that new job
 * finds it mapped instead of importing it a second time.
 */
export const JOB_CREATE_LOCK = "push:job-create";

/**
 * Write a record, then run its later passes if it has any (job_details and job_activity, for jobs).
 * The result names the first entity, whose create/update is what happened.
 */
export async function syncRecord(
  entity: string, uid: string, opts: { enrich?: string[]; detail?: ((uid: string) => string) | null; selfFetching?: boolean } = {},
): Promise<SyncOneResult> {
  return oneAtATime(uid, async () => {
    const selfFetching = opts.selfFetching ?? isSelfFetching(entity);
    const detail = opts.detail ?? detailPathFor(entity);
    // Read the record once: the first pass writes from it, and the second pass
    // (which fetches for itself) seeds its id maps from it.
    let raw: any;
    if (detail && !selfFetching) {
      const cfg = await getSyncConfig(db(), config.tenantId);
      raw = (await zuperGet(cfg, detail(uid)))?.data ?? null;
      if (!raw) throw new Error(`Zuper returned no record for ${entity} ${uid}`);
    }
    const result = await syncOne(entity, uid, raw ? { raw } : { detail, selfFetching });
    for (const next of opts.enrich ?? []) {
      await syncOne(next, uid, { detail: detailPathFor(next), selfFetching: isSelfFetching(next), seed: raw });
    }
    return result;
  });
}

/** Where each note host's notes are listed, and how the host is mapped. */
const NOTE_HOSTS: Record<NoteHost, { mapEntity: string }> = {
  job: { mapEntity: "jobs" },
  customer: { mapEntity: "customers" },
  request: { mapEntity: "requests" },
  asset: { mapEntity: "assets" },
};

export interface NoteSyncResult extends SyncOneResult {
  notes: { listed: number; written: number; deleted: number };
}

/**
 * Bring one record's notes in line with Zuper.
 *
 * Zuper has no read-by-uid for a note, but lists a record's notes, and every note
 * event names the record. So: list them (pinned ones come back separately, in
 * `pinned_notes`), write those that are new or changed since we last synced
 * them, and — for a deletion — flag the note that went away. A delivery that
 * carries the note's uid is flagged by it; otherwise a note we hold that Zuper no
 * longer lists is the deleted one (the list omits deleted notes; verified
 * against a job whose five imported notes matched Zuper's five exactly).
 */
export async function syncHostNotes(
  host: NoteHost, hostUid: string, opts: { deletion?: boolean; noteUid?: string | null } = {},
): Promise<NoteSyncResult> {
  return oneAtATime(`notes:${hostUid}`, async () => {
    const client = db();
    const tenantId = config.tenantId;
    const cfg = await getSyncConfig(client, tenantId);
    if (!cfg.api_key) throw new Error("no Zuper API key configured");

    const { data: hostRow, error: hostErr } = await client.schema("jms").from("zuper_sync_map")
      .select("jms_id").eq("tenant_id", tenantId).eq("entity", NOTE_HOSTS[host].mapEntity).eq("zuper_uid", hostUid).maybeSingle();
    if (hostErr) throw hostErr;
    const hostId = (hostRow as { jms_id?: string } | null)?.jms_id;
    // Replay retries this, by which time the record's own event has imported it.
    if (!hostId) throw new Error(`${host} ${hostUid} is not imported yet`);

    // Every page, pinned notes included. A partial list must never drive deletions,
    // so any failure here throws before anything is flagged.
    const listed = new Map<string, any>();
    for (let page = 1; page <= 50; page++) {
      const j = await zuperGet(cfg, `/api/notes?filter.${host}=${encodeURIComponent(hostUid)}&page=${page}&count=100`);
      for (const n of [...(j?.data ?? []), ...(page === 1 ? j?.pinned_notes ?? [] : [])]) {
        if (n?.note_uid) listed.set(String(n.note_uid), n);
      }
      const pages = Number(j?.total_pages ?? 1);
      if (!Number.isFinite(pages) || page >= pages || !(j?.data ?? []).length) break;
    }

    // What we already hold for this record, and when each was last synced.
    const uids = [...listed.keys()];
    const synced = new Map<string, string>();
    for (let i = 0; i < uids.length; i += 200) {
      const { data, error } = await client.schema("jms").from("zuper_sync_map").select("zuper_uid, synced_at")
        .eq("tenant_id", tenantId).eq("entity", "notes").in("zuper_uid", uids.slice(i, i + 200));
      if (error) throw error;
      for (const m of (data ?? []) as { zuper_uid: string; synced_at: string }[]) synced.set(m.zuper_uid, m.synced_at);
    }

    let written = 0;
    for (const [uid, note] of listed) {
      const last = synced.get(uid);
      const changed = !last || (note.updated_at && new Date(note.updated_at).getTime() > new Date(last).getTime());
      if (!changed && uid !== opts.noteUid) continue;
      await syncOne("notes", uid, { raw: note, client, tenantId });
      written++;
    }

    let deleted = 0;
    if (opts.deletion) {
      if (opts.noteUid && !listed.has(opts.noteUid)) {
        if ((await markDeleted("notes", opts.noteUid)).action === "deleted") deleted++;
      } else if (!opts.noteUid) {
        const { data: held, error } = await client.schema("jms").from("entity_comments")
          .select("id, zuper_uid").eq("tenant_id", tenantId).eq("entity_type", host).eq("entity_id", hostId)
          .eq("is_deleted", false).not("zuper_uid", "is", null);
        if (error) throw error;
        const gone = ((held ?? []) as { id: string; zuper_uid: string }[]).filter((h) => !listed.has(h.zuper_uid));
        for (const g of gone) {
          const { error: upErr } = await client.schema("jms").from("entity_comments")
            .update({ is_deleted: true, deleted_at: new Date().toISOString() })
            .eq("id", g.id).eq("tenant_id", tenantId).eq("is_deleted", false);
          if (upErr) throw upErr;
          deleted++;
        }
      }
    }

    return {
      entity: "notes", uid: hostUid, id: hostId,
      action: deleted ? "deleted" : written ? "updated" : "skipped",
      notes: { listed: listed.size, written, deleted },
    };
  });
}

/** Give a stub record the uid field its entity reads. */
function stubUidFields(entityName: string, uid: string): Record<string, string> {
  const byEntity: Record<string, string> = {
    jobs: "job_uid", job_details: "job_uid", job_activity: "job_uid",
    customers: "customer_uid", organizations: "organization_uid", users: "user_uid",
    assets: "asset_uid", estimates: "estimate_uid", estimate_activity: "estimate_uid", invoices: "invoice_uid",
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
    // Only a live row is stamped, so a repeated delivery keeps the first deletion time.
    .update({ is_deleted: true, deleted_at: new Date().toISOString() })
    .eq("id", id).eq("tenant_id", tenantId).eq("is_deleted", false);
  if (error) throw error;
  return { entity: entityName, uid, action: "deleted", id };
}

/** Whether our copy of a record exists and is already flagged deleted. */
async function heldAsDeleted(entityName: string, uid: string): Promise<boolean> {
  const e = ENTITIES[entityName];
  if (!e) return false;
  try {
    const client = db();
    const mapName = (e as any)?.mapEntity ?? entityName;
    const { data } = await client.schema("jms").from("zuper_sync_map")
      .select("jms_id").eq("tenant_id", config.tenantId).eq("entity", mapName).eq("zuper_uid", uid).maybeSingle();
    const id = (data as any)?.jms_id as string | undefined;
    if (!id) return false;
    const { data: row } = await client.schema(e.schema).from(e.table)
      .select("is_deleted").eq("id", id).eq("tenant_id", config.tenantId).maybeSingle();
    return (row as any)?.is_deleted === true;
  } catch {
    return false;
  }
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
      console.warn("[zupersync] could not record processing outcome:", errorText(err));
    }
  };

  // The record this delivery is about, once known — for the 404 check below.
  let target: { route: Route; uid: string } | null = null;
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

    // The route's own fields come first. delivery.uid is the receiver's generic
    // guess, which for a note deletion is the HOST's uid (job_uid), not note_uid —
    // and flagging by that would miss, or worse, hit a different record.
    // A list-only record (punches, time off) needs no uid: its recent list is re-read.
    if (route.collection) {
      const { syncCollection } = await import("./collections.js");
      const r = await syncCollection(route.collection);
      const note = `${r.written} written of ${r.listed} listed${r.failed ? `, ${r.failed} failed: ${r.errors[0] ?? ""}` : ""}`;
      await finish({ processed_at: new Date().toISOString(), process_error: r.failed && !r.written ? note.slice(0, 400) : null, sync_entity: route.entity });
      console.log(`[zupersync] ${route.module}/${delivery.event} → ${route.collection} ${note}`);
      return { entity: route.entity, uid: "", action: r.written ? "updated" : "skipped", id: null };
    }

    const uid = route.uidFields.map((f) => findUid(delivery.body, f)).find(Boolean) || delivery.uid || null;
    if (!uid) {
      const reason = `none of ${route.uidFields.join(", ")} found in the delivered body`;
      await finish({ processed_at: new Date().toISOString(), sync_entity: route.entity, process_error: reason });
      return { action: "skipped", reason };
    }

    target = { route, uid };
    if (route.module === "JOB") await whenIdle(JOB_CREATE_LOCK);
    const result: SyncOneResult = route.noteHost
      ? await syncHostNotes(route.noteHost, uid, { deletion: route.deletion, noteUid: findUid(delivery.body, "note_uid") })
      : route.deletion
        ? await oneAtATime(uid, () => markDeleted(route.entity, uid))
        : await syncRecord(route.entity, uid, { enrich: route.enrich, detail: route.detail, selfFetching: route.fetch === "self" });
    const noteInfo = "notes" in result ? ` (${JSON.stringify((result as NoteSyncResult).notes)})` : "";

    await finish({ processed_at: new Date().toISOString(), process_error: null, sync_entity: result.entity });
    console.log(`[zupersync] ${route.module}/${delivery.event} → ${result.entity} ${result.action} ${result.id ?? ""}${noteInfo}`.trim());
    return result;
  } catch (err) {
    const msg = errorText(err);
    // A late event for a record Zuper has deleted: Zuper sends assign/schedule events
    // after job.delete, and the re-fetch 404s. When we already hold that record as
    // deleted there is nothing left to do, so close the delivery rather than retry it
    // up to the attempt cap. A 404 alone is not proof of deletion (Zuper lists some
    // jobs whose detail 404s), so a record we hold as live keeps the normal path.
    const t = target;
    if (t && !t.route.noteHost && !t.route.deletion && / → 404$/.test(msg) && (await heldAsDeleted(t.route.entity, t.uid))) {
      const reason = "skipped: deleted in Zuper (404) and already deleted here";
      await finish({ processed_at: new Date().toISOString(), sync_entity: t.route.entity, process_error: reason });
      console.log(`[zupersync] ${t.route.module}/${delivery.event} → ${t.route.entity} ${t.uid} ${reason}`);
      return { action: "skipped", reason };
    }
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
