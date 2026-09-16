/**
 * The shared Supabase client.
 *
 * One database, one set of tables: this service writes jms.* directly, which is
 * what JMS, the AMC engine and the portals read. Nothing here creates a
 * parallel copy of the data.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.js";

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!client) {
    client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      // The sync engine addresses schemas explicitly (.schema("jms")), so the
      // default schema here is only a fallback.
      db: { schema: "public" },
    });
  }
  return client;
}

/** A quick connectivity probe for /health — cheap, and proves the key works. */
export async function dbReachable(): Promise<{ ok: boolean; detail?: string }> {
  try {
    const { error } = await db().schema("jms").from("zuper_sync_config").select("tenant_id").limit(1);
    if (error) return { ok: false, detail: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "unreachable" };
  }
}
