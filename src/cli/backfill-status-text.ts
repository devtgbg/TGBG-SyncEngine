/**
 * Fill in what a job status was imported without: its description, and Zuper's own remarks kind.
 *
 *   npx tsx src/cli/backfill-status-text.ts [--apply]
 *
 * Additive only. It writes `description` where Tuper has none, and `remarks_type` where Tuper has none — it never
 * overwrites a value already there, and touches no other column, so a status's colour, order, gates and checklist are
 * left exactly as they are. Without --apply it only reports what it would change. Zuper is read.
 */
import { tuper as db } from "../tuper-client.js";
import { config } from "../config.js";

const apply = process.argv.includes("--apply");
const client = db();
const tenantId = config.tenantId;

async function zuper(path: string): Promise<any> {
  const res = await fetch(config.zuper.apiUrl + path, {
    headers: { "x-api-key": config.zuper.apiKey, "content-type": "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Zuper GET ${path} -> ${res.status}`);
  return res.json();
}

const { data: cats, error } = await client.schema("jms").from("job_categories")
  .select("id, name").eq("tenant_id", tenantId).eq("is_deleted", false);
if (error) throw error;

const { data: map } = await client.schema("jms").from("zuper_sync_map")
  .select("zuper_uid, jms_id").eq("tenant_id", tenantId).eq("entity", "job_categories");
const catUidOf = new Map<string, string>(((map ?? []) as any[]).map((r) => [r.jms_id, r.zuper_uid]));

const { data: statusMapRows } = await client.schema("jms").from("zuper_sync_map")
  .select("zuper_uid, jms_id").eq("tenant_id", tenantId).eq("entity", "job_statuses");
const statusIdOf = new Map<string, string>(((statusMapRows ?? []) as any[]).map((r) => [r.zuper_uid, r.jms_id]));

let looked = 0, wouldWrite = 0, wrote = 0;
const skipped: string[] = [];
for (const c of (cats ?? []) as any[]) {
  const uid = catUidOf.get(c.id);
  if (!uid) continue;
  const list: any[] = (await zuper(`/api/jobs/status/${uid}`))?.data?.job_statuses ?? [];
  for (const s of list) {
    const id = statusIdOf.get(s.status_uid);
    if (!id) continue;
    looked++;
    const { data: row } = await client.schema("jms").from("job_statuses")
      .select("id, name, description, remarks_type").eq("tenant_id", tenantId).eq("id", id).maybeSingle();
    if (!row) continue;
    const patch: Record<string, unknown> = {};
    const description = typeof s.status_description === "string" ? s.status_description.trim() : "";
    if (description && !(row as any).description) patch.description = description;
    const remarks = typeof s.remarks_type === "string" ? s.remarks_type.trim() : "";
    // Tuper won't have a status offering a list of remarks with nothing on the list (job_statuses_remarks_ck), and
    // Zuper has a few marked PREDEFINED with no values at all. Those keep no kind rather than an empty promise.
    const values: unknown[] = Array.isArray(s.remarks_values) ? s.remarks_values : [];
    const usable = remarks !== "PREDEFINED" || values.length > 0;
    if (remarks && usable && !(row as any).remarks_type) patch.remarks_type = remarks;
    if (remarks && !usable) skipped.push((row as any).name);
    if (!Object.keys(patch).length) continue;
    wouldWrite++;
    if (apply) {
      const { error: uErr } = await client.schema("jms").from("job_statuses").update(patch).eq("id", id).eq("tenant_id", tenantId);
      if (uErr) throw uErr;
      wrote++;
    }
    console.log(`  ${(row as any).name.padEnd(28)} ${Object.keys(patch).join(", ")}`);
  }
}
console.log(`\n${looked} statuses read, ${wouldWrite} need filling in${apply ? `, ${wrote} written` : " (dry run — pass --apply to write)"}`);
