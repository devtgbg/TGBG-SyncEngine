/**
 * Every call this service makes to Zuper's API and to Tuper's, kept in its own store (sync.api_calls).
 *
 * The delivery log says what arrived. This says what the service then did about it: which record it read from Zuper,
 * which rows it wrote through Tuper, what each answered and how long it took. The dashboard shows both, and a delivery
 * opened there lists the calls it caused.
 *
 * Rules, each for a reason:
 *   • Recording never slows or fails a call. Rows are buffered and written in batches, off the request path; a store
 *     that is down costs log rows, never sync work.
 *   • The cause travels with the work, not through every signature. AsyncLocalStorage carries { origin, eventId } from
 *     the receivers, replay, sweep, pusher and admin into every call made on their behalf.
 *   • Headers are never recorded: both API keys travel in them. A body field whose name looks like a credential is
 *     masked, a body longer than API_LOG_BODY_MAX is cut, bodies go after API_LOG_BODY_HOURS and rows after
 *     API_LOG_DAYS.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { config, errorText } from "./config.js";
import { sql } from "./store.js";

export type System = "zuper" | "tuper";
/** What set the work going. `tuper-webhook` is a change made in Tuper; `webhook` is one made in Zuper. */
export type Origin = "webhook" | "tuper-webhook" | "replay" | "sweep" | "push" | "admin";

/**
 * One record being written to Tuper (src/tuper-writes.ts). Every call made while it is open is tied to it by `id`, and
 * counted here, so its row in sync.tuper_writes can say what it cost.
 */
export interface WriteTally { id: string; label: string | null; tuperId: string | null; zuper: number; tuper: number; failed: number }

interface Cause { origin: Origin | null; eventId?: string | null; write?: WriteTally }
const cause = new AsyncLocalStorage<Cause>();

/** Run `fn` with every API call inside it recorded as caused by `c`. */
export function withCause<T>(c: { origin: Origin; eventId?: string | null }, fn: () => Promise<T>): Promise<T> {
  return cause.run(c, fn);
}

/** The cause in force, and the record being written, if any. */
export const currentCause = (): Cause | undefined => cause.getStore();

/** Run `fn` as the writing of one record, under whatever cause is already in force. */
export function inWrite<T>(w: WriteTally, fn: () => Promise<T>): Promise<T> {
  const c = cause.getStore();
  return cause.run({ origin: c?.origin ?? null, eventId: c?.eventId ?? null, write: w }, fn);
}

export interface Call {
  system: System;
  method: string;
  path: string;
  /** What the call does, where the path alone does not say: "update jobs" for Tuper's one mutate endpoint. */
  action?: string | null;
  /** Null when no answer came back at all. */
  status: number | null;
  ok: boolean;
  started: number;
  attempt?: number;
  error?: string | null;
  /** The body sent: an object, or the JSON text it was sent as. */
  request?: unknown;
  /** The answer exactly as received. */
  response?: string | null;
}

interface Row {
  tenant_id: string; at: string; system: System; method: string; path: string; action: string | null;
  status: number | null; ok: boolean; ms: number; attempt: number; error: string | null;
  origin: Origin | null; event_id: string | null; write_id: string | null;
  request: unknown; response: unknown; request_bytes: number | null; response_bytes: number | null;
}

/** One record written to Tuper: a row of sync.tuper_writes. */
export interface WriteRow {
  write_id: string; at: string; ms: number; entity: string; zuper_uid: string | null; tuper_id: string | null;
  label: string | null; action: string; ok: boolean; error: string | null; detail: string | null;
  origin: Origin | null; event_id: string | null; zuper_calls: number; tuper_calls: number; failed_calls: number;
}

/** A field that holds a credential. Its value is masked wherever it appears in a recorded body. */
const CREDENTIAL = /"([A-Za-z0-9_]*(?:secret|password|api_?key|token|authorization)[A-Za-z0-9_]*)"(\s*:\s*)"(?:[^"\\]|\\.)*"/gi;

/**
 * A body as it is kept: masked, then parsed back when it is JSON and short enough, otherwise its head as text.
 * PostgreSQL's jsonb refuses the NUL character, which Zuper's free-text fields have been seen to carry.
 */
function keep(text: string | null | undefined): { value: unknown; bytes: number | null } {
  if (text === null || text === undefined || text === "") return { value: null, bytes: text === "" ? 0 : null };
  const bytes = Buffer.byteLength(text);
  const masked = text.replace(CREDENTIAL, '"$1"$2"(hidden)"').replace(/\\u0000|\x00/g, "");
  if (masked.length <= config.apiLog.bodyMax) {
    try { return { value: JSON.parse(masked), bytes }; } catch { /* not JSON: kept as text below */ }
  }
  return { value: { _cut: masked.length > config.apiLog.bodyMax, _text: masked.slice(0, config.apiLog.bodyMax) }, bytes };
}

const asText = (v: unknown): string | null =>
  v === undefined || v === null ? null : typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch { return null; } })();

// ── buffering ────────────────────────────────────────────────────────────────

const MAX_BUFFER = 5_000;
const FLUSH_EVERY_MS = 1_000;
const BATCH = 250;

let buffer: Row[] = [];
let dropped = 0;
let flushing = false;
let timer: NodeJS.Timeout | null = null;
let lastWarning = 0;

/** Record one call. Never throws and never waits. */
export function logCall(c: Call): void {
  if (!config.apiLog.enabled) return;
  try {
    const ctx = cause.getStore();
    const req = keep(asText(c.request));
    const res = keep(c.response);
    const w = ctx?.write;
    if (w) {
      if (c.system === "zuper") w.zuper++; else w.tuper++;
      if (!c.ok) w.failed++;
    }
    buffer.push({
      tenant_id: config.tenantId,
      at: new Date(c.started).toISOString(),
      system: c.system,
      method: c.method.toUpperCase(),
      path: c.path.slice(0, 2_000),
      action: c.action ?? null,
      status: c.status,
      ok: c.ok,
      ms: Math.max(0, Date.now() - c.started),
      attempt: c.attempt ?? 1,
      error: c.error ? c.error.slice(0, 500) : null,
      origin: ctx?.origin ?? null,
      event_id: ctx?.eventId ?? null,
      write_id: w?.id ?? null,
      request: req.value, response: res.value, request_bytes: req.bytes, response_bytes: res.bytes,
    });
    // A store that stays down must not grow this without bound: the oldest rows go first.
    if (buffer.length > MAX_BUFFER) { dropped += buffer.length - MAX_BUFFER; buffer = buffer.slice(-MAX_BUFFER); }
    startFlushing();
  } catch (err) {
    warn(`could not record an API call: ${errorText(err)}`);
  }
}

let writes: WriteRow[] = [];

/** Record one record written to Tuper. Never throws and never waits. */
export function logWrite(row: WriteRow): void {
  if (!config.apiLog.enabled) return;
  writes.push(row);
  if (writes.length > MAX_BUFFER) { dropped += writes.length - MAX_BUFFER; writes = writes.slice(-MAX_BUFFER); }
  startFlushing();
}

function startFlushing(): void {
  if (timer) return;
  timer = setInterval(() => { void flush(); }, FLUSH_EVERY_MS);
  timer.unref?.();
}

/** Write what is buffered. Rows that cannot be written are put back, up to the buffer's cap. */
export async function flush(): Promise<void> {
  if (flushing || (!buffer.length && !writes.length)) return;
  flushing = true;
  try {
    while (writes.length) {
      const batch = writes.slice(0, BATCH);
      writes = writes.slice(BATCH);
      try {
        await sql(
          `INSERT INTO sync.tuper_writes
             (tenant_id, write_id, at, ms, entity, zuper_uid, tuper_id, label, action, ok, error, detail, origin, event_id,
              zuper_calls, tuper_calls, failed_calls)
           SELECT $2, write_id, at, ms, entity, zuper_uid, tuper_id, label, action, ok, error, detail, origin, event_id,
                  zuper_calls, tuper_calls, failed_calls
             FROM jsonb_to_recordset($1::jsonb) AS r(
               write_id uuid, at timestamptz, ms integer, entity text, zuper_uid text, tuper_id text, label text,
               action text, ok boolean, error text, detail text, origin text, event_id uuid,
               zuper_calls integer, tuper_calls integer, failed_calls integer)
           ON CONFLICT (write_id) DO NOTHING`,
          [JSON.stringify(batch), config.tenantId],
        );
      } catch (err) {
        writes = [...batch, ...writes].slice(-MAX_BUFFER);
        warn(`could not write ${batch.length} Tuper write record(s) to the store: ${errorText(err)}`);
        break;
      }
    }
    while (buffer.length) {
      const batch = buffer.slice(0, BATCH);
      buffer = buffer.slice(BATCH);
      try {
        await sql(
          `INSERT INTO sync.api_calls
             (tenant_id, at, system, method, path, action, status, ok, ms, attempt, error, origin, event_id, write_id,
              request, response, request_bytes, response_bytes)
           SELECT tenant_id, at, system, method, path, action, status, ok, ms, attempt, error, origin, event_id, write_id,
                  request, response, request_bytes, response_bytes
             FROM jsonb_to_recordset($1::jsonb) AS r(
               tenant_id uuid, at timestamptz, system text, method text, path text, action text, status smallint,
               ok boolean, ms integer, attempt smallint, error text, origin text, event_id uuid, write_id uuid,
               request jsonb, response jsonb, request_bytes integer, response_bytes integer)`,
          [JSON.stringify(batch)],
        );
      } catch (err) {
        buffer = [...batch, ...buffer].slice(-MAX_BUFFER);
        warn(`could not write ${batch.length} API call(s) to the store: ${errorText(err)}`);
        break;
      }
    }
    if (dropped) { warn(`${dropped} API call record(s) dropped while the store was unreachable`); dropped = 0; }
  } finally {
    flushing = false;
  }
}

/** At most one warning a minute: a store outage would otherwise fill the log with this. */
function warn(message: string): void {
  if (Date.now() - lastWarning < 60_000) return;
  lastWarning = Date.now();
  console.warn(`[api-log] ${message}`);
}

// ── retention ────────────────────────────────────────────────────────────────

let purgeTimer: NodeJS.Timeout | null = null;

/** Bodies first (they are the bulk), rows later. In batches, so a large backlog never holds a long lock. */
export async function purgeApiLog(): Promise<{ bodies: number; rows: number }> {
  let bodies = 0, rows = 0;
  for (;;) {
    const r = await sql<{ n: number }>(
      `WITH old AS (
         SELECT id FROM sync.api_calls
          WHERE at < now() - make_interval(hours => $1) AND (request IS NOT NULL OR response IS NOT NULL)
          LIMIT 5000)
       UPDATE sync.api_calls c SET request = NULL, response = NULL FROM old WHERE c.id = old.id
       RETURNING 1 AS n`,
      [config.apiLog.bodyHours],
    );
    bodies += r.length;
    if (r.length < 5000) break;
  }
  for (;;) {
    const r = await sql<{ n: number }>(
      `WITH old AS (SELECT id FROM sync.api_calls WHERE at < now() - make_interval(days => $1) LIMIT 5000)
       DELETE FROM sync.api_calls c USING old WHERE c.id = old.id RETURNING 1 AS n`,
      [config.apiLog.days],
    );
    rows += r.length;
    if (r.length < 5000) break;
  }
  // The record of what reached Tuper is one small row per record, so it is kept longer than the calls behind it.
  for (;;) {
    const r = await sql<{ n: number }>(
      `WITH old AS (SELECT id FROM sync.tuper_writes WHERE at < now() - make_interval(days => $1) LIMIT 5000)
       DELETE FROM sync.tuper_writes w USING old WHERE w.id = old.id RETURNING 1 AS n`,
      [config.apiLog.writesDays],
    );
    rows += r.length;
    if (r.length < 5000) break;
  }
  return { bodies, rows };
}

/**
 * The purge runs whether recording is on or not: the dashboard can switch recording off, and what was recorded
 * before still has to go on time.
 */
export function startApiLogPurge(): void {
  if (!config.apiLog.enabled) console.log("[api-log] recording is off — calls to Zuper and Tuper are not recorded");
  const run = async () => {
    try {
      const r = await purgeApiLog();
      if (r.bodies || r.rows) console.log(`[api-log] purged ${r.bodies} bodies older than ${config.apiLog.bodyHours}h, ${r.rows} rows older than ${config.apiLog.days}d`);
    } catch (err) {
      warn(`purge failed: ${errorText(err)}`);
    }
  };
  purgeTimer = setInterval(run, 15 * 60_000);
  purgeTimer.unref?.();
  void run();
  console.log(`[api-log] recording calls to Zuper and Tuper: bodies kept ${config.apiLog.bodyHours}h, rows ${config.apiLog.days}d`);
}

export function stopApiLog(): void {
  if (purgeTimer) clearInterval(purgeTimer);
  if (timer) clearInterval(timer);
  purgeTimer = timer = null;
}
