/**
 * Import Zuper's recurring jobs — the repeats themselves, not the jobs they make.
 *
 *   npx tsx src/cli/import-recurring-jobs.ts [--apply] [--limit 100]
 *   npx tsx src/cli/import-recurring-jobs.ts --link [--apply]     # point each job at the repeat it came from
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
      // A job Zuper no longer has is not a reason to end the run: it is one of the records the first import counted
      // as gone, and the pass simply has nothing to link for it.
      if (res.status === 404) return null;
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
      .select("zuper_uid, jms_id").eq("tenant_id", tenantId).eq("entity", entity).order("zuper_uid").range(page * 1000, page * 1000 + 999);
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

// ── --link: which repeat each job came from ──
// Zuper says so on the job itself (recurring_job.recurring_job_uid), not on the repeat and not in the job list, so it
// has to be asked job by job. Only a job Zuper marked as recurring can have come from one, which is 9,856 of GBG's
// 46,000 rather than all of them.
//
// A job's `recurring_job` is the repeat itself — rule, how often, how long, addresses, first and last job, how many —
// but not what each job it makes is called or for whom, so those come from the job. Zuper's created_by here is its
// internal number, not a user uid, so it can't be mapped and is left empty.
async function repeatFromJob(job: any): Promise<string | undefined> {
  const r = job?.recurring_job;
  const uid = r?.recurring_job_uid;
  if (!uid || !r.rrule) return undefined;
  const payload = {
    tenant_id: tenantId,
    job_title: String(job.job_title ?? "").trim(),
    category_id: categories.get(job.job_category?.category_uid) ?? null,
    customer_id: customers.get(job.customer?.customer_uid) ?? null,
    organization_id: organizations.get(job.customer?.customer_organization?.organization_uid) ?? null,
    service_address: address(r.customer_address),
    billing_address: address(r.customer_billing_address),
    rrule: String(r.rrule),
    repeat_frequency: r.repeat_frequency ?? null,
    repeat_every: Number(r.repeat_every) || 1,
    repeat_on: r.repeat_on ?? {},
    duration: r.duration ?? null,
    job_start: r.job_start ?? null,
    job_end: r.job_end ?? null,
    job_duration_minutes: null,
    job_count: Number(r.job_count) || 0,
    time_zone: job.job_timezone ?? null,
    is_deleted: r.is_deleted === true,
    created_by: null,
    ...(r.created_at ? { created_at: r.created_at } : {}),
  };
  const { data, error } = await client.schema("jms").from("recurring_jobs").insert(payload).select("id").single();
  if (error) throw error;
  const id = (data as { id: string }).id;
  const { error: mErr } = await client.schema("jms").from("zuper_sync_map").upsert(
    { tenant_id: tenantId, entity: "recurring_jobs", zuper_uid: uid, jms_id: id, synced_at: new Date().toISOString() },
    { onConflict: "tenant_id,entity,zuper_uid" });
  if (mErr) throw mErr;
  mine.set(uid, id);
  madeRepeats++;
  return id;
}
let madeRepeats = 0;

// It walks every unlinked job once, newest first, by a created_at cursor. An earlier version took "the newest 1,000
// unlinked" each run; a job it couldn't link stayed unlinked, so once those 1,000 were all unlinkable every run read
// the same 1,000 again and never reached the rest.
if (process.argv.includes("--link")) {
  const PAGE = 500;
  let cursor: string | null = null;
  let seen = 0, linked = 0, none = 0, unmapped = 0, gone = 0;
  // A repeat Zuper names that Tuper never imported — told apart from a job Tuper can't find in Zuper at all, because
  // the two need different fixes (import the repeat; or accept the job has no Zuper record).
  const missingRepeats = new Map<string, number>();

  for (;;) {
    let q = client.schema("jms").from("jobs")
      .select("id, created_at").eq("tenant_id", tenantId).is("deleted_at", null).eq("is_recurring", true).is("recurring_job_id", null)
      .order("created_at", { ascending: false }).limit(PAGE);
    if (cursor) q = q.lt("created_at", cursor);
    const { data: jobRows, error: jErr } = await q;
    if (jErr) throw jErr;
    const rows = (jobRows ?? []) as any[];
    if (!rows.length) break;
    cursor = rows[rows.length - 1].created_at as string;
    const jobs = rows.map((r) => r.id as string);
    seen += jobs.length;

    const jobUid = new Map<string, string>();
    for (let i = 0; i < jobs.length; i += 60) {
      const { data: m } = await client.schema("jms").from("zuper_sync_map")
        .select("zuper_uid, jms_id").eq("tenant_id", tenantId).eq("entity", "jobs").in("jms_id", jobs.slice(i, i + 60));
      for (const r of (m ?? []) as any[]) jobUid.set(r.jms_id, r.zuper_uid);
    }

    for (const jobId of jobs) {
      const uid = jobUid.get(jobId);
      if (!uid) { unmapped++; continue; }
      const res = await zuper(`/api/jobs/${uid}`);
      if (!res) { gone++; continue; }
      const repeatUid = res.data?.recurring_job?.recurring_job_uid;
      if (!repeatUid) { none++; continue; }
      let repeatId = mine.get(repeatUid);
      // Zuper's repeat list leaves some live repeats out (862 of GBG's, found 2026-09-18), but every job carries its
      // repeat whole, so a missing one is made from the job that names it.
      if (!repeatId && apply) repeatId = await repeatFromJob(res.data);
      if (!repeatId) { missingRepeats.set(repeatUid, (missingRepeats.get(repeatUid) ?? 0) + 1); continue; }
      if (apply) {
        const { error } = await client.schema("jms").from("jobs")
          .update({ recurring_job_id: repeatId }).eq("id", jobId).eq("tenant_id", tenantId);
        if (error) throw error;
      }
      linked++;
    }
    const waiting = Array.from(missingRepeats.values()).reduce((a, b) => a + b, 0);
    console.log(`  ${seen} read: ${linked} linked, ${none} not from a repeat, ${waiting} waiting on a repeat Tuper lacks, ${unmapped} with no Zuper record, ${gone} Zuper no longer has`);
  }

  const waiting = Array.from(missingRepeats.values()).reduce((a, b) => a + b, 0);
  console.log(`\n${seen} unlinked recurring jobs read${apply ? "" : " (dry run)"}`);
  console.log(`  ${linked} pointed at their repeat, ${madeRepeats} of those repeats made from the job because Zuper's list left them out`);
  console.log(`  ${none} turned out not to come from one`);
  console.log(`  ${waiting} come from ${missingRepeats.size} repeats Tuper hasn't imported`);
  console.log(`  ${unmapped} have no Zuper record in the sync map`);
  console.log(`  ${gone} Zuper no longer has`);
  if (missingRepeats.size) {
    const top = Array.from(missingRepeats.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(`  the repeats with the most jobs waiting: ${top.map(([u, n]) => `${u} (${n})`).join(", ")}`);
  }
  process.exit(0);
}

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
      // The repeat's own organization (765 of 1,320 name one), else its customer's.
      organization_id: organizations.get(r.organization?.organization_uid ?? r.customer?.customer_organization?.organization_uid) ?? null,
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
      // Zuper's own last change (Tuper 00217 keeps a written updated_at).
      ...(r.updated_at ? { updated_at: r.updated_at } : {}),
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
