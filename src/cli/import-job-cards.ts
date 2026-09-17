/**
 * Import Zuper's job cards (Settings → Job Cards) into jms.job_card_templates.
 *
 *   npx tsx src/cli/import-job-cards.ts
 *
 * Zuper is only read. This runs the job_card_templates entity's own fetch and transform, then writes each card
 * through the Tuper API and records its uid in the sync map, so a second run updates the same rows rather than
 * making new ones. It exists because the cards are settings — a handful of records, wanted before the service's next
 * deploy — and it keeps the store (sync.runs) out of it, which a full runSync would need.
 */
import { tuper as db } from "../tuper-client.js";
import { config } from "../config.js";
import { ENTITIES, loadMap } from "../lib/migration/zuper-sync.js";

const entity = ENTITIES.job_card_templates;
const tenantId = config.tenantId;
const client = db();

// The importer's own config shape (api_base/api_key), filled from this service's settings.
const cfg = { api_key: config.zuper.apiKey, api_base: config.zuper.apiUrl, company: null, enabled: true, interval_hours: 24, last_run_at: null, next_run_at: null, is_syncing: false };
const ctx: any = { client, tenantId, cfg, maps: {}, extra: {} };
for (const dep of entity.deps ?? []) ctx.maps[dep] = await loadMap(client, tenantId, dep);

const rows = await entity.fetch!(ctx);
console.log(`fetched ${rows.length} job cards from Zuper`);

const map = await loadMap(client, tenantId, "job_card_templates");
let written = 0, skipped = 0;
for (const r of rows) {
  const uid = entity.uid(r);
  const payload = await entity.transform(r, ctx);
  if (!payload) { skipped++; continue; }
  const known = map.get(uid);
  const table = () => client.schema("jms").from("job_card_templates");
  let id = known ?? null;
  if (id) {
    const { error } = await table().update(payload).eq("id", id).eq("tenant_id", tenantId);
    if (error) throw error;
  } else {
    const { data, error } = await table().insert({ ...payload, tenant_id: tenantId }).select("id").single();
    if (error) throw error;
    id = (data as { id: string }).id;
    const { error: mErr } = await client.schema("jms").from("zuper_sync_map")
      .upsert({ tenant_id: tenantId, entity: "job_card_templates", zuper_uid: uid, jms_id: id, synced_at: new Date().toISOString() },
        { onConflict: "tenant_id,entity,zuper_uid" });
    if (mErr) throw mErr;
  }
  written++;
  console.log(`  ${known ? "updated" : "added  "} ${String(payload.name).slice(0, 44).padEnd(44)} ${(payload.associated_category_ids as string[]).length} categor${(payload.associated_category_ids as string[]).length === 1 ? "y" : "ies"}`);
}
console.log(`done: ${written} written, ${skipped} skipped (deleted in Zuper)`);
