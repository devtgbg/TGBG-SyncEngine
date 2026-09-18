/**
 * Import Zuper's recurring jobs — the repeats themselves, not the jobs they make.
 *
 *   npx tsx src/cli/import-recurring-jobs.ts [--apply] [--limit 100]
 *
 * Tuper kept a repeat as a flag on the first job, so its Recurring Jobs page listed every job that came from one.
 * Zuper lists the repeats: GET /api/recurring_jobs, 1,312 of them, each with its rule, how long it runs, how many
 * jobs it makes, and the customer, category and addresses those jobs carry. They land in jms.recurring_jobs (00110),
 * keyed by Zuper's uid through the sync map, so a second run updates rather than duplicates. Zuper is read.
 */
import { tuper as db } from "../tuper-client.js";
import { config } from "../config.js";

const apply = process.argv.includes("--apply");
const limitAt = process.argv.indexOf("--limit");
const LIMIT = limitAt > 0 ? Number(process.argv[limitAt + 1]) || 100 : 100;
const client = db();
const tenantId = config.tenantId;

async function zuper(path: string): Promise<any> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(config.zuper.apiUrl + path, {
        headers: { "x-api-key": config.zuper.apiKey, "content-type": "application/json" },
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(String(res.status));
      return await res.json();
    } catch (e) {
      if (attempt === 4) throw e;
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
}

/** Zuper uid → Tuper id, for the things a repeat points at. */
async function mapOf(entity: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let page = 0; ; page++) {
    const { data } = await client.schema("jms").from("zuper_sync_map")
      .select("zuper_uid, jms_id").eq("tenant_id", tenantId).eq("entity", entity).range(page * 1000, page * 1000 + 999);
    const rows = (data ?? []) as any[];
    for (const r of rows) out.set(r.zuper_uid, r.jms_id);
    if (rows.length < 1000) break;
  }
  return out;
}

const [categories, customers, organizations, users, mine] = await Promise.all([
  mapOf("job_categories"), mapOf("customers"), mapOf("organizations"), mapOf("users"), mapOf("recurring_jobs"),
]);

const address = (a: any) => (a && typeof a === "object" && Object.keys(a).length ? a : null);
const minutes = (v: unknown) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

let read = 0, written = 0, skipped = 0;
for (let page = 1; ; page++) {
  const answer = await zuper(`/api/recurring_jobs?count=${Math.min(LIMIT, 100)}&page=${page}`);
  const rows: any[] = answer?.data ?? [];
  if (!rows.length) break;

  for (const r of rows) {
    read++;
    const uid = r.recurring_job_uid;
    if (!uid) { skipped++; continue; }
    const payload = {
      tenant_id: tenantId,
      job_title: String(r.job_title ?? "").trim(),
      category_id: categories.get(r.job_category?.category_uid) ?? null,
      customer_id: customers.get(r.customer?.customer_uid) ?? null,
      organization_id: organizations.get(r.customer?.customer_organization?.organization_uid) ?? null,
      service_address: address(r.customer_address),
      billing_address: address(r.customer_billing_address),
      rrule: String(r.rrule ?? ""),
      repeat_frequency: r.repeat_frequency ?? null,
      repeat_every: Number(r.repeat_every) || 1,
      repeat_on: r.repeat_on ?? {},
      duration: r.duration ?? null,
      job_start: r.job_start ?? null,
      job_end: r.job_end ?? null,
      job_duration_minutes: minutes(r.job_duration),
      job_count: Number(r.job_count) || 0,
      time_zone: r.recurring_job_timezone ?? null,
      is_deleted: r.is_deleted === true,
      created_by: users.get(r.created_by?.user_uid) ?? null,
      ...(r.created_at ? { created_at: r.created_at } : {}),
    };
    if (!payload.rrule) { skipped++; continue; }

    if (!apply) { written++; continue; }
    const known = mine.get(uid);
    if (known) {
      const { error } = await client.schema("jms").from("recurring_jobs").update(payload).eq("id", known).eq("tenant_id", tenantId);
      if (error) throw error;
    } else {
      const { data, error } = await client.schema("jms").from("recurring_jobs").insert(payload).select("id").single();
      if (error) throw error;
      const id = (data as { id: string }).id;
      mine.set(uid, id);
      const { error: mErr } = await client.schema("jms").from("zuper_sync_map").upsert(
        { tenant_id: tenantId, entity: "recurring_jobs", zuper_uid: uid, jms_id: id, synced_at: new Date().toISOString() },
        { onConflict: "tenant_id,entity,zuper_uid" });
      if (mErr) throw mErr;
    }
    written++;
    if (written % 50 === 0) console.log(`  ${written} repeats in so far`);
  }

  const total = Number(answer?.total_records);
  if (rows.length < Math.min(LIMIT, 100) || (Number.isFinite(total) && read >= total)) break;
}
console.log(`\n${read} repeats read from Zuper, ${written} ${apply ? "written" : "would be written (dry run)"}, ${skipped} skipped`);
