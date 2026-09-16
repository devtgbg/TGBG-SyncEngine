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

  supabase: {
    url: required("SUPABASE_URL"),
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
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
  sweep: {
    enabled: optional("SWEEP_ENABLED", "true") !== "false",
    everyMinutes: Math.max(5, Number(optional("SWEEP_EVERY_MINUTES", "30"))),
    minutesBack: Math.max(5, Number(optional("SWEEP_MINUTES_BACK", "180"))),
    maxResyncs: Math.max(1, Number(optional("SWEEP_MAX_RESYNCS", "200"))),
    perMinute: Math.min(120, Math.max(1, Number(optional("SWEEP_REQUESTS_PER_MINUTE", "45")))),
  },
} as const;

/** True once an inbound secret is configured; until then deliveries are captured but not trusted. */
export const secretConfigured = (): boolean => config.webhook.secret.length > 0;
