/**
 * Environment for the sync service.
 *
 * Zupersync writes the SAME Supabase that JMS/Tuper and the other apps read —
 * there is no mirror schema. That makes the service-role key mandatory (it
 * writes across jms.* and must bypass RLS) and makes misconfiguration
 * dangerous, so required values are validated at boot rather than failing
 * halfway through a delivery.
 */

import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`${name} is required — see .env.example`);
  return v.trim();
}

/**
 * An error as readable text. supabase-js throws plain objects ({ message, code,
 * details }), which String() renders as "[object Object]" — and that is what the
 * delivery log recorded until this existed.
 */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
    const parts = [e.message, e.code && `(${e.code})`, e.details, e.hint].filter((x) => typeof x === "string" && x);
    if (parts.length) return parts.join(" ");
    try { return JSON.stringify(err); } catch { /* fall through */ }
  }
  return String(err);
}

/** PUSH_MODE, refusing anything unrecognised rather than guessing towards `live`. */
function pushMode(v: string): "off" | "dry-run" | "live" {
  const m = v.trim().toLowerCase();
  if (m === "off" || m === "dry-run" || m === "live") return m;
  console.warn(`[zupersync] PUSH_MODE="${v}" is not off, dry-run or live — using dry-run`);
  return "dry-run";
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

/**
 * The Zuper base URL, without a trailing "/api".
 *
 * The engine concatenates: `fetch(cfg.api_base + path)`, and every path it uses
 * already begins with "/api/" — so a base ending in "/api" builds
 * ".../api/api/jobs/{uid}". Zuper answers that with a 404 carrying an HTML body,
 * which surfaces as a JSON parse error rather than as an obvious misconfiguration,
 * and it is easy to get wrong because Zuper's own docs write the base both ways.
 *
 * A base ending in "/api" is always wrong here, so normalise it and say so.
 */
function zuperBase(raw: string): string {
  const base = raw.trim().replace(/\/+$/, "");
  if (/\/api$/i.test(base)) {
    console.warn(`[zupersync] ZUPER_API_URL ends in "/api" — dropping it; request paths already include it`);
    return base.replace(/\/api$/i, "");
  }
  return base;
}

export const config = {
  port: Number(optional("PORT", "3020")),
  nodeEnv: optional("NODE_ENV", "development"),
  isProduction: optional("NODE_ENV", "development") === "production",

  /**
   * Tuper's API — where records are read and written from now on. The key carries the `sync` scope; without it the
   * sync endpoints refuse every call. There is no database connection here on purpose: this service reaches both
   * systems the same way, over their APIs (docs/API-ONLY.md).
   */
  tuper: {
    url: (optional("TUPER_API_URL", "https://api.tuper.golfbuggyguy.com")).replace(/\/+$/, ""),
    apiKey: required("TUPER_API_KEY"),
  },

  /**
   * This service's own database: the deliveries it has received, the queue of changes waiting to go to Zuper, its
   * configuration and its run history. Its data, in its own place — and it keeps working when Tuper does not.
   */
  store: {
    url: required("DATABASE_URL"),
  },

  tenantId: optional("DEFAULT_TENANT_ID", "00000000-0000-0000-0000-000000000001"),

  zuper: {
    apiUrl: zuperBase(optional("ZUPER_API_URL", "https://eks-ap-south-1.zuperpro.com")),
    apiKey: required("ZUPER_API_KEY"),
  },

  /**
   * Inbound authentication. Zuper's webhook form has no "secret" field — it
   * carries one custom header (its fields are literally `key` and `value`), so
   * we define the pair and check it here.
   */
  webhook: {
    header: optional("ZUPER_WEBHOOK_HEADER", "x-zupersync-key").toLowerCase(),
    secret: process.env.ZUPER_WEBHOOK_SECRET?.trim() || "",
  },

  /**
   * Tuper's webhooks — changes made in Tuper, on their way to Zuper. Tuper signs each delivery with the webhook's
   * own secret (x-tuper-signature: sha256=…), so unlike Zuper there is a real signature to check.
   */
  tuperWebhook: {
    secret: process.env.TUPER_WEBHOOK_SECRET?.trim() || "",
  },

  /**
   * Converging on Zuper when a delivery does not land.
   *
   * REPLAY is built (src/reconcile.ts): stored deliveries that never finished are
   * retried on an interval, up to replayMaxAttempts, so a restart mid-processing
   * or a transient Zuper 500 does not lose the change.
   *
   * The WINDOW SWEEP is built — see `sweep` below and src/sweep.ts. It re-reads
   * what Zuper changed in a rolling window and re-fetches only the records that
   * have actually drifted, which is the only thing that catches a delivery that
   * never arrived at all. Zuper gives up after its retries (the real payload
   * carries max_retries: 4), so without it a long outage loses changes for good.
   */
  reconcile: {
    enabled: optional("RECONCILE_ENABLED", "true") !== "false",
    replaySeconds: Math.max(30, Number(optional("RECONCILE_REPLAY_SECONDS", "120"))),
    replayBatch: Math.max(1, Number(optional("RECONCILE_REPLAY_BATCH", "25"))),
    // A row that can never succeed must stop retrying rather than burn the
    // 200-700 req/min Zuper budget forever.
    replayMaxAttempts: Math.max(1, Number(optional("RECONCILE_MAX_ATTEMPTS", "5"))),
  },

  /**
   * The rolling-window sweep (src/sweep.ts) — the other half of converging.
   *
   * Replay retries deliveries we received; this catches the ones that never
   * arrived, which is what an outage longer than Zuper's retries produces.
   *
   * Windowed on updated_at rather than on scheduled dates: a missed webhook is by
   * definition a record that CHANGED, which is not the same set as the records
   * scheduled soon. (The earlier RECONCILE_NEAR_DAYS_* settings encoded the
   * scheduled-window idea and are gone.)
   *
   * perMinute is deliberately a fraction of Zuper's limit — measured at 150/min
   * on this account via x-rate-limit, not the 200-700 the docs advertise — because
   * live webhook re-fetches compete for the same budget. A safety net that
   * throttles real-time sync to repair hypothetical gaps is worse than the gap.
   */
  /**
   * Pushing changes made in Tuper to Zuper (src/pusher.ts, migrations/0002).
   *
   * dry-run is the default: changes are planned and stored on the outbox row,
   * nothing is sent. `live` sends them. Deleting a job in Zuper is a separate
   * switch because it cannot be undone there.
   */
  push: {
    mode: pushMode(optional("PUSH_MODE", "dry-run")),
    everySeconds: Math.max(10, Number(optional("PUSH_EVERY_SECONDS", "30"))),
    batch: Math.max(1, Number(optional("PUSH_BATCH", "20"))),
    maxAttempts: Math.max(1, Number(optional("PUSH_MAX_ATTEMPTS", "5"))),
    // A new job arrives in several writes (row, assignees, teams, line items).
    createDelaySeconds: Math.max(0, Number(optional("PUSH_CREATE_DELAY_SECONDS", "90"))),
    deletes: optional("PUSH_DELETES", "false") === "true",
    // The company's zone (Tuper: Settings › Company). Zuper applies it to schedules.
    timeZone: optional("PUSH_TIMEZONE", "Asia/Dubai"),
    /**
     * When Zuper holds neither the value someone set in Tuper nor the value they
     * started from, the field was changed on both sides. `zuper-wins` (the default)
     * leaves Zuper alone and says so on the outbox row: Zuper is the system of
     * record, and a technician's status set from the mobile app a moment ago must
     * not be replaced by an older one from a desk. `tuper-wins` pushes regardless.
     */
    onConflict: optional("PUSH_ON_CONFLICT", "zuper-wins") === "tuper-wins" ? "tuper-wins" as const : "zuper-wins" as const,
    /**
     * Which entities `live` applies to. Everything else is planned and never sent,
     * whatever PUSH_MODE says — so a kind of record goes live only after its
     * requests have been checked against the real account, one kind at a time.
     * Jobs are the default: their request shapes ran in production in the AMC
     * engine and the portals for months. Customers: update is DataHouse's
     * production call; add "customers" once a first push has been watched.
     */
    entities: optional("PUSH_ENTITIES", "jobs").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    /**
     * A change older than this is not sent; it is marked skipped, with its age.
     * While pushing is off or dry-run, edits pile up here and the inbound sync puts
     * Zuper's values back over them. Turning `live` on must not then replay a
     * week of edits nobody remembers making over whatever Zuper holds now.
     */
    maxAgeMinutes: Math.max(5, Number(optional("PUSH_MAX_AGE_MINUTES", "120"))),
  },

  sweep: {
    enabled: optional("SWEEP_ENABLED", "true") !== "false",
    everyMinutes: Math.max(5, Number(optional("SWEEP_EVERY_MINUTES", "30"))),
    minutesBack: Math.max(5, Number(optional("SWEEP_MINUTES_BACK", "180"))),
    maxResyncs: Math.max(1, Number(optional("SWEEP_MAX_RESYNCS", "200"))),
    // Organizations, assets, products and customers: ~100 list pages, so less often.
    fullEveryMinutes: Math.max(30, Number(optional("SWEEP_FULL_EVERY_MINUTES", "180"))),
    perMinute: Math.min(120, Math.max(1, Number(optional("SWEEP_REQUESTS_PER_MINUTE", "45")))),
  },

  /**
   * The record of every call made to Zuper's API and Tuper's (src/api-log.ts, sync.api_calls), which the dashboard
   * shows beside the webhooks. Bodies are the bulk of it, so they are cut at bodyMax characters and dropped after
   * bodyHours; the rows themselves go after days.
   */
  apiLog: {
    enabled: optional("API_LOG", "on") !== "off",
    days: Math.max(1, Number(optional("API_LOG_DAYS", "7"))),
    bodyHours: Math.max(1, Number(optional("API_LOG_BODY_HOURS", "48"))),
    bodyMax: Math.max(1_000, Number(optional("API_LOG_BODY_MAX", "64000"))),
  },
} as const;

/** True once an inbound secret is configured; until then deliveries are captured but not trusted. */
export const secretConfigured = (): boolean => config.webhook.secret.length > 0;
