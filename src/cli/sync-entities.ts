/**
 * Re-run whole entities from Zuper: every record, read in full, written to jms.
 *
 *   npx tsx src/cli/sync-entities.ts estimates estimate_activity
 *
 * Zuper is only read. The jms rows are live — four applications read them — so run it for a
 * reason (an importer change, a gap), and each run is recorded in jms.zuper_sync_runs.
 */

import { db } from "../supabase.js";
import { config } from "../config.js";
import { runSync } from "../lib/migration/zuper-sync.js";

const names = process.argv.slice(2);
if (!names.length) {
  console.error("usage: sync-entities <entity> [entity …]");
  process.exit(2);
}
const results = await runSync(db(), config.tenantId, names);
console.log(JSON.stringify(results, null, 1));
