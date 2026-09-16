/**
 * Connectivity probe: prove this service can actually READ and WRITE the shared
 * tables, not merely open a connection.
 *
 *   npm run check-db
 *
 * Read access is checked per table because the service-role key can be valid
 * while a schema grant is missing — a distinction that only shows up when a
 * real delivery fails at 3am. The write check is deliberately a no-op update
 * against a row that already exists, so nothing is created or changed.
 */

import { config } from "../config.js";
import { db } from "../supabase.js";

const TABLES = [
  "zuper_sync_config", "zuper_sync_map", "zuper_sync_runs",
  "jobs", "customers", "organizations", "users", "assets",
  "job_statuses", "job_categories", "requests", "estimates", "invoices",
  "job_status_history", "entity_comments", "attachments",
];

async function main() {
  console.log(`Supabase : ${config.supabase.url}`);
  console.log(`Tenant   : ${config.tenantId}`);
  console.log(`Zuper    : ${config.zuper.apiUrl}`);
  console.log("");

  let readable = 0;
  const failures: string[] = [];

  for (const table of TABLES) {
    const { count, error } = await db()
      .schema("jms").from(table)
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", config.tenantId);
    if (error) {
      failures.push(`${table}: ${error.message}`);
      console.log(`  ✗ jms.${table.padEnd(20)} ${error.message}`);
    } else {
      readable++;
      console.log(`  ✓ jms.${table.padEnd(20)} ${(count ?? 0).toLocaleString()} rows`);
    }
  }

  // Write probe — touch nothing. Re-writing a row's own value proves UPDATE is
  // permitted without changing data.
  console.log("");
  const { data: cfgRow, error: cfgErr } = await db()
    .schema("jms").from("zuper_sync_config")
    .select("tenant_id, api_base, enabled, is_syncing")
    .eq("tenant_id", config.tenantId).maybeSingle();

  if (cfgErr || !cfgRow) {
    console.log(`  ✗ write probe skipped — no sync config row (${cfgErr?.message ?? "not found"})`);
  } else {
    const row = cfgRow as { enabled: boolean; is_syncing: boolean };
    const { error: wErr } = await db()
      .schema("jms").from("zuper_sync_config")
      .update({ enabled: row.enabled })      // same value in, same value out
      .eq("tenant_id", config.tenantId);
    console.log(wErr ? `  ✗ write probe: ${wErr.message}` : "  ✓ write probe: UPDATE permitted (no data changed)");
    console.log(`     sync config — enabled=${row.enabled} is_syncing=${row.is_syncing}`);
  }

  console.log("");
  console.log(`${readable}/${TABLES.length} tables readable`);
  if (failures.length) {
    console.log("failures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("check-db failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
