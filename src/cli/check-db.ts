/**
 * Connectivity probe: prove this service can reach both of the things it now depends on, and actually read and write
 * through them — not merely open a connection.
 *
 *   npm run check-db
 *
 * There are two, since the service stopped holding a database key:
 *   • Tuper's API, for the records. Checked per table, because a key can be valid while a table is not one a sync
 *     key may use — a distinction that otherwise only shows up when a real delivery fails at 3am.
 *   • This service's own database, for its log, its queue, its config and its runs.
 *
 * The write probe is deliberately a no-op: a row's own value written back, so nothing is created or changed.
 */

import { config } from "../config.js";
import { tuper as db } from "../tuper-client.js";
import { one, sql, storeReachable } from "../store.js";

/** Tables read through Tuper's API. */
const TABLES = [
  "zuper_sync_map",
  "jobs", "customers", "organizations", "users", "assets",
  "job_statuses", "job_categories", "requests", "quotes", "invoices",
  "job_status_history", "entity_comments", "attachments",
];

/** Tables in this service's own database. */
const OWN = ["webhook_events", "outbox", "config", "runs"];

async function main() {
  console.log(`Tuper API : ${config.tuper.url}`);
  console.log(`Tenant    : ${config.tenantId}`);
  console.log(`Zuper     : ${config.zuper.apiUrl}`);
  console.log("");

  let readable = 0;
  const failures: string[] = [];

  console.log("Through Tuper's API:");
  for (const table of TABLES) {
    const { data, error } = await db().schema("jms").from(table).select("id").limit(1);
    if (error) {
      failures.push(`${table}: ${error.message}`);
      console.log(`  ✗ ${table.padEnd(22)} ${error.message}`);
    } else {
      readable++;
      console.log(`  ✓ ${table.padEnd(22)} readable${Array.isArray(data) && data.length === 0 ? " (empty)" : ""}`);
    }
  }

  console.log("");
  console.log("This service's own database:");
  const store = await storeReachable();
  if (!store.ok) {
    failures.push(`store: ${store.detail ?? "unreachable"}`);
    console.log(`  ✗ connection            ${store.detail}`);
  } else {
    for (const table of OWN) {
      try {
        const row = await one<{ n: string }>(`SELECT count(*)::text AS n FROM sync.${table}`);
        console.log(`  ✓ sync.${table.padEnd(16)} ${Number(row?.n ?? 0).toLocaleString()} rows`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`sync.${table}: ${message}`);
        console.log(`  ✗ sync.${table.padEnd(16)} ${message}`);
      }
    }
    // Write probe — a row's own value written back proves UPDATE is permitted without changing anything.
    try {
      const cfg = await one<{ enabled: boolean; is_syncing: boolean }>(
        "SELECT enabled, is_syncing FROM sync.config WHERE tenant_id = $1", [config.tenantId]);
      if (!cfg) {
        console.log("  · write probe skipped — no config row yet");
      } else {
        await sql("UPDATE sync.config SET enabled = $2 WHERE tenant_id = $1", [config.tenantId, cfg.enabled]);
        console.log("  ✓ write probe: UPDATE permitted (no data changed)");
        console.log(`     enabled=${cfg.enabled} is_syncing=${cfg.is_syncing}`);
      }
    } catch (err) {
      failures.push(`write probe: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`  ✗ write probe: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("");
  console.log(`${readable}/${TABLES.length} tables readable through the API`);
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
