/**
 * The settings the engine runs by, decided on the dashboard and applied here without a restart.
 *
 * One document per tenant in sync.settings. The environment gives the first one (so a fresh store starts as the
 * deployment was configured); after that the dashboard writes it and this module reads it every few seconds. A new
 * version is checked, written into `config` — which every part of the service already reads at the moment it acts —
 * and the timers that depend on it are started or stopped. What was applied, and when, goes back to sync.engine with
 * a heartbeat, so the dashboard shows "applied" from the engine's own word rather than from its own write.
 *
 * Every value is checked and clamped here, whatever the dashboard sent: a bad document never stops the engine, it is
 * applied as far as it is valid and the rest keeps its previous value.
 */
import { config, errorText } from "./config.js";
import { one, sql } from "./store.js";

export type PushMode = "off" | "dry-run" | "live";

export interface Settings {
  /** Zuper → Tuper. */
  inbound: boolean;
  /** Tuper → Zuper. */
  push: { mode: PushMode; entities: string[]; deletes: boolean; onConflict: "zuper-wins" | "tuper-wins"; maxAgeMinutes: number };
  /** Retry deliveries that failed. */
  replay: boolean;
  /** Re-read what Zuper changed recently, for webhooks that never arrived. */
  sweep: { enabled: boolean; everyMinutes: number };
  /** The record of every API call. */
  apiLog: { enabled: boolean; bodyHours: number; days: number };
}

/** The kinds of record the pusher can plan today. Anything else a setting names is dropped. */
export const PUSHABLE = ["jobs", "customers"];

/** The settings the deployment's environment describes. */
export function fromEnvironment(): Settings {
  return {
    inbound: config.inbound,
    push: {
      mode: config.push.mode, entities: [...config.push.entities], deletes: config.push.deletes,
      onConflict: config.push.onConflict, maxAgeMinutes: config.push.maxAgeMinutes,
    },
    replay: config.reconcile.enabled,
    sweep: { enabled: config.sweep.enabled, everyMinutes: config.sweep.everyMinutes },
    apiLog: { enabled: config.apiLog.enabled, bodyHours: config.apiLog.bodyHours, days: config.apiLog.days },
  };
}

const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const int = (v: unknown, d: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d;
};

/** A document made safe: every field valid, anything missing or wrong taken from `base`. */
export function normalise(raw: unknown, base: Settings): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const p = (r.push && typeof r.push === "object" ? r.push : {}) as Record<string, any>;
  const s = (r.sweep && typeof r.sweep === "object" ? r.sweep : {}) as Record<string, any>;
  const a = (r.apiLog && typeof r.apiLog === "object" ? r.apiLog : {}) as Record<string, any>;
  return {
    inbound: bool(r.inbound, base.inbound),
    push: {
      mode: p.mode === "off" || p.mode === "dry-run" || p.mode === "live" ? p.mode : base.push.mode,
      entities: Array.isArray(p.entities) ? [...new Set(p.entities.map(String).filter((e: string) => PUSHABLE.includes(e)))] : base.push.entities,
      deletes: bool(p.deletes, base.push.deletes),
      onConflict: p.onConflict === "zuper-wins" || p.onConflict === "tuper-wins" ? p.onConflict : base.push.onConflict,
      maxAgeMinutes: int(p.maxAgeMinutes, base.push.maxAgeMinutes, 5, 7 * 24 * 60),
    },
    replay: bool(r.replay, base.replay),
    sweep: { enabled: bool(s.enabled, base.sweep.enabled), everyMinutes: int(s.everyMinutes, base.sweep.everyMinutes, 5, 24 * 60) },
    apiLog: {
      enabled: bool(a.enabled, base.apiLog.enabled),
      bodyHours: int(a.bodyHours, base.apiLog.bodyHours, 1, 24 * 14),
      days: int(a.days, base.apiLog.days, 1, 90),
    },
  };
}

/** The settings in force. */
export function current(): Settings {
  return applied?.settings ?? fromEnvironment();
}

// ── applying ─────────────────────────────────────────────────────────────────

/** Timers that follow the settings. Set by index.ts, so this module imports none of them. */
export interface Hooks { reconcile: (s: Settings, previous: Settings | null) => void }
let hooks: Hooks | null = null;
let applied: { version: number; at: string; settings: Settings } | null = null;

/** Write the settings into `config` and let the timers follow. */
function apply(s: Settings, version: number): void {
  const previous = applied?.settings ?? null;
  const c = config as any;
  c.inbound = s.inbound;
  c.push.mode = s.push.mode;
  c.push.entities = [...s.push.entities];
  c.push.deletes = s.push.deletes;
  c.push.onConflict = s.push.onConflict;
  c.push.maxAgeMinutes = s.push.maxAgeMinutes;
  c.reconcile.enabled = s.replay;
  c.sweep.enabled = s.sweep.enabled;
  c.sweep.everyMinutes = s.sweep.everyMinutes;
  c.apiLog.enabled = s.apiLog.enabled;
  c.apiLog.bodyHours = s.apiLog.bodyHours;
  c.apiLog.days = s.apiLog.days;
  applied = { version, at: new Date().toISOString(), settings: s };
  try { hooks?.reconcile(s, previous); } catch (err) { console.warn("[settings] could not follow the new settings:", errorText(err)); }
  if (previous) console.log(`[settings] applied version ${version}: ${describe(s)}`);
}

/** One line a person can read in the log. */
export function describe(s: Settings): string {
  const push = s.push.mode === "off" ? "off" : s.push.mode === "dry-run" ? "plan only" : `live for ${s.push.entities.join(", ") || "nothing"}`;
  return `Zuper → Tuper ${s.inbound ? "on" : "off"}; Tuper → Zuper ${push}; replay ${s.replay ? "on" : "off"}; ` +
    `sweep ${s.sweep.enabled ? `every ${s.sweep.everyMinutes}m` : "off"}; call log ${s.apiLog.enabled ? "on" : "off"}`;
}

/** Read the document; create it from the environment when there is none. Never throws. */
async function load(): Promise<void> {
  try {
    let row = await one<{ data: unknown; version: number }>("SELECT data, version FROM sync.settings WHERE tenant_id = $1", [config.tenantId]);
    if (!row) {
      const first = fromEnvironment();
      row = await one<{ data: unknown; version: number }>(
        `INSERT INTO sync.settings (tenant_id, data, version, updated_by) VALUES ($1, $2, 1, 'environment')
         ON CONFLICT (tenant_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id RETURNING data, version`,
        [config.tenantId, JSON.stringify(first)],
      );
      await sql(`INSERT INTO sync.settings_history (tenant_id, version, before, after, by) VALUES ($1, 1, NULL, $2, 'environment')`,
        [config.tenantId, JSON.stringify(first)]);
      console.log(`[settings] first settings taken from the environment: ${describe(first)}`);
    }
    if (!row || row.version === applied?.version) return;
    apply(normalise(row.data, applied?.settings ?? fromEnvironment()), row.version);
  } catch (err) {
    console.warn("[settings] could not read the settings:", errorText(err));
  }
}

// ── the engine's report ──────────────────────────────────────────────────────

const startedAt = new Date().toISOString();
/** What each part of the engine last did, for the dashboard: set by them, sent with the heartbeat. */
const state: Record<string, unknown> = {};
export function report(key: string, value: unknown): void { state[key] = { ...(value as object), at: new Date().toISOString() }; }

async function heartbeat(timers: () => Record<string, boolean>): Promise<void> {
  try {
    await sql(
      `INSERT INTO sync.engine (tenant_id, started_at, heartbeat_at, commit, applied_version, applied_at, applied, state)
       VALUES ($1, $2, now(), $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id) DO UPDATE SET started_at = EXCLUDED.started_at, heartbeat_at = now(), commit = EXCLUDED.commit,
         applied_version = EXCLUDED.applied_version, applied_at = EXCLUDED.applied_at, applied = EXCLUDED.applied, state = EXCLUDED.state`,
      [config.tenantId, startedAt, process.env.SOURCE_COMMIT?.slice(0, 7) ?? null, applied?.version ?? null, applied?.at ?? null,
       applied ? JSON.stringify(applied.settings) : null, JSON.stringify({ ...state, timers: timers() })],
    );
  } catch (err) {
    console.warn("[settings] could not write the heartbeat:", errorText(err));
  }
}

let watch: NodeJS.Timeout | null = null;

/**
 * Apply the stored settings, then keep following them: every 5 seconds the document is read and, when its version
 * moved, applied; every 5 seconds the heartbeat goes out with what is running.
 */
export async function startSettings(h: Hooks, timers: () => Record<string, boolean>): Promise<void> {
  hooks = h;
  await load();
  if (applied) console.log(`[settings] version ${applied.version}: ${describe(applied.settings)}`);
  await heartbeat(timers);
  watch = setInterval(async () => { await load(); await heartbeat(timers); }, 5_000);
  watch.unref?.();
}

export function stopSettings(): void {
  if (watch) clearInterval(watch);
  watch = null;
}
