/**
 * Give an imported job back its description's formatting.
 *
 *   npx tsx src/cli/backfill-job-description.ts [--apply] [--limit 500]
 *
 * Zuper writes a job's description as rich text and sends a plain copy beside it; only the plain copy was kept, so
 * every imported job reads as one unbroken block. This fills `description_html` and nothing else, and only where it
 * is empty — no other column is touched, and a job that already has one is left alone. Zuper is read.
 */
import { tuper as db } from "../tuper-client.js";
import { config } from "../config.js";

const apply = process.argv.includes("--apply");
const limitAt = process.argv.indexOf("--limit");
const LIMIT = limitAt > 0 ? Number(process.argv[limitAt + 1]) || 200 : 200;
const client = db();
const tenantId = config.tenantId;

async function zuperJob(uid: string): Promise<any | null> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${config.zuper.apiUrl}/api/jobs/${uid}`, {
        headers: { "x-api-key": config.zuper.apiKey, "content-type": "application/json" },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(String(res.status));
      return ((await res.json()) as { data?: any })?.data ?? null;
    } catch (e) {
      if (attempt === 4) { console.error("  giving up on", uid, e instanceof Error ? e.message : e); return null; }
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  return null;
}

// the jobs still without one, oldest first so a run picks up where the last left off
const { data: rows, error } = await client.schema("jms").from("jobs")
  .select("id, title").eq("tenant_id", tenantId).is("deleted_at", null).is("description_html", null)
  .not("description", "is", null).order("created_at", { ascending: true }).limit(LIMIT);
if (error) throw error;
const jobs = (rows ?? []) as { id: string; title: string }[];
console.log(`${jobs.length} jobs to look at${apply ? "" : " (dry run — pass --apply to write)"}`);

// The map, 60 ids at a time: a single `in` of a thousand ids makes a URL the server won't take, and the rows come
// back empty — which read as "nothing to take" for every job rather than as the failure it was.
const uidOf = new Map<string, string>();
for (let i = 0; i < jobs.length; i += 60) {
  const part = jobs.slice(i, i + 60).map((j) => j.id);
  const { data: mapRows, error: mErr } = await client.schema("jms").from("zuper_sync_map")
    .select("zuper_uid, jms_id").eq("tenant_id", tenantId).eq("entity", "jobs").in("jms_id", part);
  if (mErr) throw mErr;
  for (const r of (mapRows ?? []) as any[]) uidOf.set(r.jms_id, r.zuper_uid);
}
if (!uidOf.size) throw new Error("no job is mapped to a Zuper uid — refusing to report every job as having nothing to take");

let filled = 0, plain = 0, missing = 0;
for (const j of jobs) {
  const uid = uidOf.get(j.id);
  if (!uid) { missing++; continue; }
  const d = await zuperJob(uid);
  const html = typeof d?.job_description === "string" ? d.job_description.trim() : "";
  if (!html) { missing++; continue; }
  if (!/[<&]/.test(html)) { plain++; continue; }          // nothing to keep: it was plain text in Zuper too
  if (apply) {
    const { error: uErr } = await client.schema("jms").from("jobs")
      .update({ description_html: html }).eq("id", j.id).eq("tenant_id", tenantId);
    if (uErr) throw uErr;
  }
  filled++;
  if (filled % 25 === 0) console.log(`  ${filled} filled in so far`);
}
console.log(`\n${filled} given their formatting back, ${plain} were plain in Zuper too, ${missing} had nothing to take`);
