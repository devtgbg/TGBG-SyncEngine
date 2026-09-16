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
    apiUrl: optional("ZUPER_API_URL", "https://eks-ap-south-1.zuperpro.com").replace(/\/+$/, ""),
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

  reconcile: {
    enabled: optional("RECONCILE_ENABLED", "true") !== "false",
    nearDaysBack: Number(optional("RECONCILE_NEAR_DAYS_BACK", "1")),
    nearDaysAhead: Number(optional("RECONCILE_NEAR_DAYS_AHEAD", "21")),
  },
} as const;

/** True once an inbound secret is configured; until then deliveries are captured but not trusted. */
export const secretConfigured = (): boolean => config.webhook.secret.length > 0;
