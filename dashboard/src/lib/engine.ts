/**
 * The engine's settings as the dashboard handles them: their shape, how a form becomes one, and how a direction is
 * named. The service (src/settings.ts) checks every value again before applying it; this copy exists so the form can
 * say what is wrong before anything is saved, and so the pages name things the same way.
 */

export type PushMode = "off" | "dry-run" | "live";

export interface Settings {
  inbound: boolean;
  push: { mode: PushMode; entities: string[]; deletes: boolean; onConflict: "zuper-wins" | "tuper-wins"; maxAgeMinutes: number };
  replay: boolean;
  sweep: { enabled: boolean; everyMinutes: number };
  apiLog: { enabled: boolean; bodyHours: number; days: number };
}

/** The kinds of record the engine can push to Zuper today, as a person would say them. */
export const PUSHABLE: { key: string; label: string }[] = [
  { key: "jobs", label: "Jobs" },
  { key: "customers", label: "Customers" },
];

/** Kinds Tuper can change that have no push yet, so the page can say so rather than leave them out. */
export const NOT_PUSHABLE = ["Organizations", "Assets", "Products", "Notes", "Quotes", "Invoices", "Contracts", "Requests", "Timesheets", "Users"];

export const DEFAULTS: Settings = {
  inbound: true,
  push: { mode: "off", entities: ["jobs"], deletes: false, onConflict: "zuper-wins", maxAgeMinutes: 120 },
  replay: true,
  sweep: { enabled: true, everyMinutes: 30 },
  apiLog: { enabled: true, bodyHours: 48, days: 7 },
};

const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const int = (v: unknown, d: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d;
};

/** The same rules as the service's normalise(): valid values kept, anything else from `base`. */
export function normalise(raw: unknown, base: Settings = DEFAULTS): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const p = (r.push ?? {}) as Record<string, any>, s = (r.sweep ?? {}) as Record<string, any>, a = (r.apiLog ?? {}) as Record<string, any>;
  return {
    inbound: bool(r.inbound, base.inbound),
    push: {
      mode: p.mode === "off" || p.mode === "dry-run" || p.mode === "live" ? p.mode : base.push.mode,
      entities: Array.isArray(p.entities) ? [...new Set(p.entities.map(String).filter((e: string) => PUSHABLE.some((x) => x.key === e)))] : base.push.entities,
      deletes: bool(p.deletes, base.push.deletes),
      onConflict: p.onConflict === "zuper-wins" || p.onConflict === "tuper-wins" ? p.onConflict : base.push.onConflict,
      maxAgeMinutes: int(p.maxAgeMinutes, base.push.maxAgeMinutes, 5, 7 * 24 * 60),
    },
    replay: bool(r.replay, base.replay),
    sweep: { enabled: bool(s.enabled, base.sweep.enabled), everyMinutes: int(s.everyMinutes, base.sweep.everyMinutes, 5, 24 * 60) },
    apiLog: { enabled: bool(a.enabled, base.apiLog.enabled), bodyHours: int(a.bodyHours, base.apiLog.bodyHours, 1, 24 * 14), days: int(a.days, base.apiLog.days, 1, 90) },
  };
}

export type Direction = "two-way" | "zuper-to-tuper" | "tuper-to-zuper" | "paused";

/** Which way data moves. Planning pushes without sending them still counts as the Tuper → Zuper side being on. */
export function directionOf(s: Settings): Direction {
  const out = s.push.mode !== "off";
  return s.inbound && out ? "two-way" : s.inbound ? "zuper-to-tuper" : out ? "tuper-to-zuper" : "paused";
}

export const DIRECTION: Record<Direction, { label: string; short: string; hint: string; about: string }> = {
  "two-way": { label: "Two-way sync", short: "Zuper ⇄ Tuper", hint: "Two-way sync", about: "Changes in Zuper are written to Tuper, and changes in Tuper go to Zuper." },
  "zuper-to-tuper": { label: "One-way: Zuper → Tuper", short: "Zuper → Tuper", hint: "One-way", about: "Changes in Zuper are written to Tuper. Changes made in Tuper stay in Tuper." },
  "tuper-to-zuper": { label: "One-way: Tuper → Zuper", short: "Tuper → Zuper", hint: "One-way", about: "Changes made in Tuper go to Zuper. Zuper's webhooks are stored and held, not applied." },
  paused: { label: "Paused", short: "Paused", hint: "Nothing moves either way", about: "Nothing is written either way. Zuper's webhooks are stored and held; Tuper's changes are recorded, not queued." },
};

export const PUSH_MODE: Record<PushMode, string> = { off: "Off", "dry-run": "Plan only", live: "Live" };

/** What changed between two versions, in words, for the history. */
export function changes(before: Settings | null, after: Settings): string[] {
  if (!before) return ["first settings, from the deployment's environment"];
  const out: string[] = [];
  const onOff = (v: boolean) => (v ? "on" : "off");
  if (before.inbound !== after.inbound) out.push(`Zuper → Tuper ${onOff(after.inbound)}`);
  if (before.push.mode !== after.push.mode) out.push(`Tuper → Zuper ${PUSH_MODE[after.push.mode].toLowerCase()}`);
  if (before.push.entities.join() !== after.push.entities.join()) out.push(`pushed kinds: ${after.push.entities.join(", ") || "none"}`);
  if (before.push.deletes !== after.push.deletes) out.push(`deletes to Zuper ${onOff(after.push.deletes)}`);
  if (before.push.onConflict !== after.push.onConflict) out.push(`on a conflict ${after.push.onConflict === "zuper-wins" ? "Zuper wins" : "Tuper wins"}`);
  if (before.push.maxAgeMinutes !== after.push.maxAgeMinutes) out.push(`oldest change sent: ${minutes(after.push.maxAgeMinutes)}`);
  if (before.replay !== after.replay) out.push(`replay ${onOff(after.replay)}`);
  if (before.sweep.enabled !== after.sweep.enabled) out.push(`sweep ${onOff(after.sweep.enabled)}`);
  if (before.sweep.everyMinutes !== after.sweep.everyMinutes) out.push(`sweep every ${minutes(after.sweep.everyMinutes)}`);
  if (before.apiLog.enabled !== after.apiLog.enabled) out.push(`call log ${onOff(after.apiLog.enabled)}`);
  if (before.apiLog.bodyHours !== after.apiLog.bodyHours) out.push(`call bodies kept ${after.apiLog.bodyHours}h`);
  if (before.apiLog.days !== after.apiLog.days) out.push(`calls kept ${after.apiLog.days} days`);
  return out.length ? out : ["no change"];
}

export const minutes = (m: number) => (m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? "" : "s"}` : m % 60 === 0 ? `${m / 60} hour${m === 60 ? "" : "s"}` : `${m} minutes`);

/** The actions the engine carries out when asked (src/commands.ts in the service). */
export const COMMANDS: Record<string, { label: string; done: string }> = {
  "replay-failed": { label: "Replay failed deliveries", done: "Replayed failed deliveries" },
  "discard-unsent": { label: "Discard unsent changes", done: "Discarded unsent changes" },
  "sweep-now": { label: "Run a sweep now", done: "Swept for missed changes" },
  "refresh-connections": { label: "Check connections now", done: "Checked connections" },
  "register-zuper-webhooks": { label: "Register missing Zuper webhooks", done: "Registered Zuper webhooks" },
};
