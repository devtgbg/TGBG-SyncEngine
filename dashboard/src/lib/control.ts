/**
 * The engine, as the dashboard runs it: its settings, what it reports about itself, the commands asked of it, and the
 * measurements behind the Overview and Connections pages.
 *
 * Reads go through the read-only sessions like every other query. The two writes — saving the settings and asking for
 * a command — go through readWrite(), the one place a session is opened for writing.
 */

import { missingTable, query as q, readWrite, tenantId } from "./db";
import { COMMANDS, normalise, type Settings } from "./engine";

// ── settings ─────────────────────────────────────────────────────────────────

export interface SettingsRow { data: Settings; version: number; updated_at: string; updated_by: string | null }

/** The settings document. Null until the engine has run once with the version that creates it. */
export async function getSettings(): Promise<SettingsRow | null> {
  const [r] = await q<{ data: unknown; version: number; updated_at: string; updated_by: string | null }>(
    "SELECT data, version, updated_at, updated_by FROM sync.settings WHERE tenant_id = $1", [tenantId()]);
  return r ? { ...r, data: normalise(r.data) } : null;
}

/**
 * Save a new version. `expected` is the version the form was opened on: if someone saved in between, nothing is
 * written and the caller is told, rather than one person's change silently undoing another's.
 */
export async function saveSettings(data: Settings, expected: number, by: string): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
  return readWrite(async (run) => {
    const [cur] = await run<{ data: unknown; version: number }>("SELECT data, version FROM sync.settings WHERE tenant_id = $1 FOR UPDATE", [tenantId()]);
    if (!cur) return { ok: false as const, error: "The engine has not created its settings yet. It does on its first start with this version." };
    if (cur.version !== expected) return { ok: false as const, error: `Someone saved version ${cur.version} while this page was open. Reload to see it, then make your change again.` };
    const version = cur.version + 1;
    await run("UPDATE sync.settings SET data = $2, version = $3, updated_at = now(), updated_by = $4 WHERE tenant_id = $1",
      [tenantId(), JSON.stringify(data), version, by]);
    await run("INSERT INTO sync.settings_history (tenant_id, version, before, after, by) VALUES ($1, $2, $3, $4, $5)",
      [tenantId(), version, JSON.stringify(cur.data), JSON.stringify(data), by]);
    return { ok: true as const, version };
  });
}

export interface HistoryRow { version: number; before: Settings | null; after: Settings; at: string; by: string | null }

export async function settingsHistory(limit = 12): Promise<HistoryRow[]> {
  const rows = await q<{ version: number; before: unknown; after: unknown; at: string; by: string | null }>(
    `SELECT version, before, after, at, by FROM sync.settings_history WHERE tenant_id = $1 ORDER BY id DESC LIMIT ${Math.trunc(limit)}`, [tenantId()]);
  return rows.map((r) => ({ ...r, before: r.before ? normalise(r.before) : null, after: normalise(r.after) }));
}

// ── the engine's own report ──────────────────────────────────────────────────

export interface Engine {
  started_at: string;
  heartbeat_at: string;
  commit: string | null;
  applied_version: number | null;
  applied_at: string | null;
  applied: Settings | null;
  state: {
    timers?: { replay?: boolean; sweep?: boolean; pusher?: boolean };
    sweep?: { at: string; full: boolean; jobsInWindow: number; jobsDrifted: number; jobsMissing: number; resynced: number; failed: number };
    replay?: { at: string; attempted: number; ok: number; failed: number };
    push?: { at: string; mode: string; jobs: number; sent: number; failed: number };
    connections?: { at: string; summary: string };
  };
  /** Seconds since the last heartbeat. */
  silent: number;
}

export async function engine(): Promise<Engine | null> {
  try {
    const [r] = await q<Omit<Engine, "silent" | "applied"> & { applied: unknown; silent: number }>(
      `SELECT started_at, heartbeat_at, commit, applied_version, applied_at, applied, state,
              extract(epoch FROM now() - heartbeat_at)::int AS silent
         FROM sync.engine WHERE tenant_id = $1`, [tenantId()]);
    return r ? { ...r, applied: r.applied ? normalise(r.applied) : null } : null;
  } catch (err) {
    if (missingTable(err)) return null;
    throw err;
  }
}

/** Online, late or offline, from the heartbeat the engine sends every 5 seconds. */
export function liveness(e: Engine | null): { state: "online" | "late" | "offline"; label: string } {
  if (!e) return { state: "offline", label: "Engine not reporting" };
  if (e.silent < 30) return { state: "online", label: "Engine online" };
  if (e.silent < 180) return { state: "late", label: `Engine quiet for ${e.silent}s` };
  return { state: "offline", label: "Engine offline" };
}

// ── commands ─────────────────────────────────────────────────────────────────

export interface Command { id: string; command: string; requested_at: string; requested_by: string | null; started_at: string | null; finished_at: string | null; ok: boolean | null; result: string | null }

/** Ask the engine for a command. One waiting at a time per command: asking twice does not queue it twice. */
export async function requestCommand(command: string, by: string): Promise<{ ok: boolean; error?: string }> {
  if (!COMMANDS[command]) return { ok: false, error: `no such command '${command}'` };
  return readWrite(async (run) => {
    const [pending] = await run("SELECT 1 FROM sync.commands WHERE tenant_id = $1 AND command = $2 AND finished_at IS NULL LIMIT 1", [tenantId(), command]);
    if (pending) return { ok: false, error: "Already asked — the engine is on it." };
    await run("INSERT INTO sync.commands (tenant_id, command, requested_by) VALUES ($1, $2, $3)", [tenantId(), command, by]);
    return { ok: true };
  });
}

export async function recentCommands(limit = 10): Promise<Command[]> {
  try {
    return await q<Command>(
      `SELECT id::text AS id, command, requested_at, requested_by, started_at, finished_at, ok, result
         FROM sync.commands WHERE tenant_id = $1 ORDER BY id DESC LIMIT ${Math.trunc(limit)}`, [tenantId()]);
  } catch (err) {
    if (missingTable(err)) return [];
    throw err;
  }
}

/** The latest of each command, for showing its outcome beside its button. */
export const latestBy = (cmds: Command[]) => {
  const out: Record<string, Command> = {};
  for (const c of cmds) out[c.command] ??= c;
  return out;
};

// ── snapshots the engine measured ────────────────────────────────────────────

export async function snapshot<T>(kind: string): Promise<{ data: T; taken_at: string } | null> {
  try {
    const [r] = await q<{ data: T; taken_at: string }>("SELECT data, taken_at FROM sync.snapshots WHERE tenant_id = $1 AND kind = $2", [tenantId(), kind]);
    return r ?? null;
  } catch (err) {
    if (missingTable(err)) return null;
    throw err;
  }
}

export interface Catalogue {
  zuperEndpoint: string;
  tuperEndpoint: string;
  zuperEvents: { module: string; event: string; entity: string | null; then: string[]; read: string | null; skip: string | null }[];
  entities: { name: string; table: string; read: string | null }[];
  tuperEvents: { event: string; entity: string; operation: string; module: string }[];
  pushWrites: Record<string, { request: string; when: string }[]>;
}

export interface Hook { uid: string; module: string; event: string; url: string; active: boolean | null; signed: boolean | null }
type Side = { total: number; ours: Hook[]; others: number } | { error: string };
export interface Registrations { zuper: Side; tuper: Side }

export interface Traffic {
  links: { entity: string; system: "zuper" | "tuper"; call: string; calls: number; failed: number }[];
  writes: { entity: string; writes: number; failed: number; median_ms: number }[];
  endpoints: { system: "zuper" | "tuper"; endpoint: string; calls: number; failed: number; median_ms: number; last_at: string }[];
}

export interface ConnectionSummary {
  zuper: { wanted: number; registered: number; missing: { module: string; event: string }[]; skippedButRegistered: number; error?: string } | null;
  tuper: { wanted: number; registered: number; missing: string[]; wrongModule: { event: string; registeredAs: string; needs: string }[]; inactive: number; error?: string } | null;
}

/** What the catalogue needs against what is registered, on each side. Null for a side not measured yet. */
export function connectionSummary(cat: Catalogue | null, regs: Registrations | null): ConnectionSummary {
  if (!cat || !regs) return { zuper: null, tuper: null };
  const key = (m: string, e: string) => `${m}|${e}`;
  let zuper: ConnectionSummary["zuper"] = null;
  if ("error" in regs.zuper) zuper = { wanted: 0, registered: 0, missing: [], skippedButRegistered: 0, error: regs.zuper.error };
  else {
    const have = new Set(regs.zuper.ours.map((h) => key(h.module, h.event)));
    const wanted = cat.zuperEvents.filter((e) => e.entity);
    const skipped = new Set(cat.zuperEvents.filter((e) => !e.entity).map((e) => key(e.module, e.event)));
    zuper = {
      wanted: wanted.length,
      registered: wanted.filter((e) => have.has(key(e.module, e.event))).length,
      missing: wanted.filter((e) => !have.has(key(e.module, e.event))).map(({ module, event }) => ({ module, event })),
      skippedButRegistered: regs.zuper.ours.filter((h) => skipped.has(key(h.module, h.event))).length,
    };
  }
  let tuper: ConnectionSummary["tuper"] = null;
  if ("error" in regs.tuper) tuper = { wanted: 0, registered: 0, missing: [], wrongModule: [], inactive: 0, error: regs.tuper.error };
  else {
    const byEvent = new Map(regs.tuper.ours.map((h) => [h.event, h]));
    tuper = {
      wanted: cat.tuperEvents.length,
      registered: cat.tuperEvents.filter((e) => byEvent.has(e.event)).length,
      missing: cat.tuperEvents.filter((e) => !byEvent.has(e.event)).map((e) => e.event),
      wrongModule: cat.tuperEvents.flatMap((e) => {
        const h = byEvent.get(e.event);
        return h && h.module !== e.module ? [{ event: e.event, registeredAs: h.module, needs: e.module }] : [];
      }),
      inactive: regs.tuper.ours.filter((h) => h.active === false).length,
    };
  }
  return { zuper, tuper };
}

// ── measurements for the Overview ────────────────────────────────────────────

export interface Flow {
  zuper: { hour: number; day: number; applied: number; skipped: number; failed: number; held: number; last: string | null; median_s: number | null };
  tuper: { day: number; carriedId: number; queued: number; skipped: number; failed: number; last: string | null };
  writes: { created: number; updated: number; deleted: number; failed: number; total: number };
  queue: Record<string, number>;
  failedAll: number;
  calls: { zuper: number; tuper: number; zuperFailed: number; tuperFailed: number };
}

export async function flow(): Promise<Flow> {
  const [z] = await q<Flow["zuper"]>(
    `SELECT count(*) FILTER (WHERE received_at > now() - interval '1 hour')::int AS hour,
            count(*)::int AS day,
            count(*) FILTER (WHERE processed_at IS NOT NULL AND process_error IS NULL)::int AS applied,
            count(*) FILTER (WHERE process_error LIKE 'skipped:%')::int AS skipped,
            count(*) FILTER (WHERE verified AND process_error IS NOT NULL AND process_error NOT LIKE 'skipped:%')::int AS failed,
            count(*) FILTER (WHERE verified AND processed_at IS NULL AND process_error IS NULL)::int AS held,
            max(received_at) AS last,
            round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM processed_at - received_at))
                   FILTER (WHERE processed_at IS NOT NULL AND process_error IS NULL))::numeric, 1)::float AS median_s
       FROM sync.webhook_events WHERE tenant_id = $1 AND source = 'zuper' AND received_at > now() - interval '24 hours'`, [tenantId()]);
  const [t] = await q<Flow["tuper"]>(
    `SELECT count(*)::int AS day, count(*) FILTER (WHERE zuper_uid IS NOT NULL)::int AS "carriedId",
            count(*) FILTER (WHERE processed_at IS NOT NULL AND process_error IS NULL)::int AS queued,
            count(*) FILTER (WHERE process_error LIKE 'skipped:%')::int AS skipped,
            count(*) FILTER (WHERE verified AND process_error IS NOT NULL AND process_error NOT LIKE 'skipped:%')::int AS failed,
            max(received_at) AS last
       FROM sync.webhook_events WHERE tenant_id = $1 AND source = 'tuper' AND received_at > now() - interval '24 hours'`, [tenantId()]);
  const queueRows = await q<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM sync.outbox WHERE tenant_id = $1 GROUP BY status", [tenantId()]);
  const [fa] = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM sync.webhook_events WHERE tenant_id = $1 AND source = 'zuper' AND verified
        AND processed_at IS NULL AND process_error IS NOT NULL AND process_error NOT LIKE 'skipped:%'`, [tenantId()]);
  let writes: Flow["writes"] = { created: 0, updated: 0, deleted: 0, failed: 0, total: 0 };
  let calls: Flow["calls"] = { zuper: 0, tuper: 0, zuperFailed: 0, tuperFailed: 0 };
  try {
    [writes] = await q<Flow["writes"]>(
      `SELECT count(*) FILTER (WHERE ok AND action = 'created')::int AS created, count(*) FILTER (WHERE ok AND action = 'updated')::int AS updated,
              count(*) FILTER (WHERE ok AND action = 'deleted')::int AS deleted, count(*) FILTER (WHERE NOT ok)::int AS failed, count(*)::int AS total
         FROM sync.tuper_writes WHERE tenant_id = $1 AND at > now() - interval '24 hours' AND origin IS NOT NULL`, [tenantId()]);
    [calls] = await q<Flow["calls"]>(
      `SELECT count(*) FILTER (WHERE system = 'zuper')::int AS zuper, count(*) FILTER (WHERE system = 'tuper')::int AS tuper,
              count(*) FILTER (WHERE system = 'zuper' AND NOT ok)::int AS "zuperFailed", count(*) FILTER (WHERE system = 'tuper' AND NOT ok)::int AS "tuperFailed"
         FROM sync.api_calls WHERE tenant_id = $1 AND at > now() - interval '1 hour' AND origin IS NOT NULL`, [tenantId()]);
  } catch (err) {
    if (!missingTable(err)) throw err;
  }
  return {
    zuper: z, tuper: t, writes, calls, failedAll: fa?.n ?? 0,
    queue: Object.fromEntries(queueRows.map((r) => [r.status, r.n])),
  };
}

export interface HourBucket { hour: string; zuper: number; tuper: number; failed: number }

/** Deliveries per hour for the last 24 hours, oldest first, every hour present. */
export async function hourly(): Promise<HourBucket[]> {
  const rows = await q<{ hour: string; source: "zuper" | "tuper"; n: number; failed: number }>(
    `SELECT to_char(date_trunc('hour', received_at), 'YYYY-MM-DD"T"HH24:00:00"Z"') AS hour, source, count(*)::int AS n,
            count(*) FILTER (WHERE verified AND process_error IS NOT NULL AND process_error NOT LIKE 'skipped:%')::int AS failed
       FROM sync.webhook_events WHERE tenant_id = $1 AND received_at >= date_trunc('hour', now()) - interval '23 hours'
      GROUP BY 1, 2`, [tenantId()]);
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  const out: HourBucket[] = [];
  for (let i = 23; i >= 0; i--) {
    const hour = new Date(now.getTime() - i * 3_600_000).toISOString().replace(/\.000Z$/, "Z");
    const zr = rows.find((r) => r.hour === hour && r.source === "zuper"), tr = rows.find((r) => r.hour === hour && r.source === "tuper");
    out.push({ hour, zuper: zr?.n ?? 0, tuper: tr?.n ?? 0, failed: (zr?.failed ?? 0) + (tr?.failed ?? 0) });
  }
  return out;
}

// ── measurements for Connections ─────────────────────────────────────────────

export interface EventStat { source: "zuper" | "tuper"; event: string; n: number; ok: number; failed: number; carried_id: number; last: string | null }

/** Deliveries per event over the last 7 days, for both systems. */
export async function eventStats(): Promise<EventStat[]> {
  return q<EventStat>(
    `SELECT source, event, count(*)::int AS n,
            count(*) FILTER (WHERE processed_at IS NOT NULL AND process_error IS NULL)::int AS ok,
            count(*) FILTER (WHERE verified AND process_error IS NOT NULL AND process_error NOT LIKE 'skipped:%')::int AS failed,
            count(*) FILTER (WHERE zuper_uid IS NOT NULL)::int AS carried_id,
            max(received_at) AS last
       FROM sync.webhook_events WHERE tenant_id = $1 AND received_at > now() - interval '7 days' AND event IS NOT NULL
      GROUP BY 1, 2`, [tenantId()]);
}
