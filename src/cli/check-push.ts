/**
 * Does the pusher decide correctly? READ-ONLY: it plans, and never sends.
 *
 *   npm run check-push
 *
 * Plans are made for a real, freshly synced job and customer, with edits that
 * are simulated in memory: nothing is written to jms.*, to the outbox or to
 * Zuper. Zuper is only read (GET the record), as any dry run does.
 *
 * What it pins down is the one decision the pusher can get silently wrong. An
 * inbound webhook rewrites the whole row from Zuper, so an edit made in Tuper can
 * be reverted in jms.* before it is pushed. Judged from the row alone, that edit
 * reads as "Zuper already has this value" and disappears. The planner is given
 * both ends of the edit instead, and must tell apart:
 *
 *   Zuper holds the new value      nothing to send
 *   Zuper holds the old value      send the edit, even though the row no longer shows it
 *   Zuper holds something else     changed on both sides: leave Zuper alone and say so
 */

import { config } from "../config.js";
import { tuper as db } from "../tuper-client.js";
import { getSyncConfig } from "../lib/migration/zuper-sync.js";
import { editsOf, isValue, modeFor, planJob, type Edits, type Plan } from "../pusher.js";
import { planCustomer } from "../pusher-customers.js";

let passed = 0, failedCount = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  if (cond) passed++; else failedCount++;
  console.log(`  ${cond ? "pass" : "FAIL"}  ${name}${!cond && extra ? `\n        ${extra}` : ""}`);
};
const put = (p: Plan, path: string) => p.requests.find((r) => r.path === path || r.path.startsWith(path));
const why = (p: Plan, column: string) => p.notPushed.filter((n) => n.column === column).map((n) => n.reason).join(" | ");
const brief = (p: Plan) => JSON.stringify({ requests: p.requests.map((r) => `${r.method} ${r.path}`), notPushed: p.notPushed, blocked: p.blocked }).slice(0, 400);

async function main() {
  console.log("pure rules");
  const rows = [
    { operation: "update", queued_at: "2026-01-01T00:00:02Z", changed: { title: "C" }, previous: { title: "B" } },
    { operation: "update", queued_at: "2026-01-01T00:00:01Z", changed: { title: "B", priority: "HIGH" }, previous: { title: "A", priority: "LOW" } },
    { operation: "update", queued_at: "2026-01-01T00:00:03Z", changed: { _assignees: true }, previous: {} },
  ];
  const e = editsOf(rows);
  ok("several edits to one column: starts from the first, ends at the last", e.title.previous === "A" && e.title.value === "C");
  ok("a column edited once keeps both of its ends", e.priority.previous === "LOW" && e.priority.value === "HIGH");
  ok("a marker row carries no value to compare", !isValue(e._assignees) && isValue(e.title));
  ok("live reaches only the entities listed in PUSH_ENTITIES", modeFor("live", config.push.entities[0] ?? "jobs") === "live" && modeFor("live", "no-such-entity") === "dry-run");
  ok("dry-run and off are never upgraded", modeFor("dry-run", "jobs") === "dry-run" && modeFor("off", "jobs") === "off");

  const client = db();
  const cfg = await getSyncConfig(client, config.tenantId);

  // ── a job, as Zuper has it right now ───────────────────────────────────────
  console.log("\na real job (read only)");
  const { data: maps, error: mapErr } = await client.schema("jms").from("zuper_sync_map").select("jms_id")
    .eq("tenant_id", config.tenantId).eq("entity", "jobs").order("synced_at", { ascending: false }).limit(25);
  if (mapErr) throw mapErr;
  let job: Record<string, any> | null = null;
  for (const m of (maps ?? []) as { jms_id: string }[]) {
    const { data } = await client.schema("jms").from("jobs").select("*").eq("id", m.jms_id).maybeSingle();
    const j = data as Record<string, any> | null;
    if (j && !j.is_deleted && j.scheduled_start_time && j.scheduled_end_time && j.current_status_id && j.title) { job = j; break; }
  }
  if (!job) { ok("found a synced, scheduled job to plan against", false); return finish(); }
  const plan = (columns: string[], edits: Edits) => planJob(client, cfg, job!.id, columns, false, edits);

  const unchanged = await plan(["title"], {});
  ok("the job is in step with Zuper, so planning from the row alone sends nothing", !unchanged.requests.length && /already has/.test(why(unchanged, "title")), brief(unchanged));

  const wanted = `${job.title} (edited)`;
  const raced = await plan(["title"], { title: { previous: job.title, value: wanted } });
  ok("THE RACE: the row was put back by an inbound sync, and the edit is still sent", (put(raced, "/api/jobs")?.body as any)?.job?.job_title === wanted, brief(raced));

  const both = await plan(["title"], { title: { previous: "a title neither side has now", value: wanted } });
  ok("changed on both sides: Zuper is left alone, and the row says why", !both.requests.length && /changed in Zuper too/.test(why(both, "title")), brief(both));

  const there = await plan(["title"], { title: { previous: "an older title", value: job.title } });
  ok("Zuper already holds the new value: nothing is sent, and it is not called a conflict", !there.requests.length && /already has/.test(why(there, "title")), brief(there));

  const hour = (iso: string, n: number) => new Date(new Date(iso).getTime() + n * 3_600_000).toISOString();
  const moved = await plan(["scheduled_start_time", "scheduled_end_time"], {
    scheduled_start_time: { previous: job.scheduled_start_time, value: hour(job.scheduled_start_time, 1) },
    scheduled_end_time: { previous: job.scheduled_end_time, value: hour(job.scheduled_end_time, 1) },
  });
  const sched = put(moved, "/api/jobs/schedule")?.body as any;
  ok("a reschedule is sent with the times that were set, in the company's zone",
    !!sched && new Date(sched.from_date).getTime() === new Date(hour(job.scheduled_start_time, 1)).getTime() && sched.job_timezone === config.push.timeZone, brief(moved));

  const movedBoth = await plan(["scheduled_start_time", "scheduled_end_time"], {
    scheduled_start_time: { previous: hour(job.scheduled_start_time, -24), value: hour(job.scheduled_start_time, 1) },
    scheduled_end_time: { previous: hour(job.scheduled_end_time, -24), value: hour(job.scheduled_end_time, 1) },
  });
  ok("rescheduled in Zuper as well: Zuper's times stand", !movedBoth.requests.length && /changed in Zuper too/.test(why(movedBoth, "schedule")), brief(movedBoth));

  // Statuses: one the job is not in, and another, both known to Zuper.
  const { data: sts } = await client.schema("jms").from("zuper_sync_map").select("jms_id").eq("tenant_id", config.tenantId).eq("entity", "job_statuses").limit(400);
  const others = [...new Set(((sts ?? []) as { jms_id: string }[]).map((s) => s.jms_id))].filter((id) => id !== job!.current_status_id);
  if (others.length >= 2) {
    const set = await plan(["current_status_id"], { current_status_id: { previous: job.current_status_id, value: others[0] } });
    ok("a status set in Tuper is sent when Zuper still shows the one it was changed from", !!put(set, `/api/jobs/${set.zuperUid}/status`), brief(set));
    const overtaken = await plan(["current_status_id"], { current_status_id: { previous: others[1], value: others[0] } });
    ok("a technician moved the job on meanwhile: the desk's status is NOT sent over theirs",
      !put(overtaken, `/api/jobs/${overtaken.zuperUid}/status`) && /changed in Zuper too/.test(why(overtaken, "current_status_id")), brief(overtaken));
  } else {
    ok("found two other statuses known to Zuper", false);
  }
  ok("every plan names its entity and a label a person can read", raced.entity === "jobs" && /^WO /.test(raced.label ?? ""));

  // ── a customer ─────────────────────────────────────────────────────────────
  console.log("\na real customer (read only)");
  const { data: cmaps } = await client.schema("jms").from("zuper_sync_map").select("jms_id")
    .eq("tenant_id", config.tenantId).eq("entity", "customers").order("synced_at", { ascending: false }).limit(40);
  let customer: Record<string, any> | null = null;
  for (const m of (cmaps ?? []) as { jms_id: string }[]) {
    const { data } = await client.schema("jms").from("customers").select("*").eq("id", m.jms_id).maybeSingle();
    const c = data as Record<string, any> | null;
    if (c && !c.is_deleted && c.first_name && c.email) { customer = c; break; }
  }
  if (!customer) { ok("found a synced customer with a name and an email", false); return finish(); }
  const cplan = (columns: string[], edits: Edits) => planCustomer(client, cfg, customer!.id, columns, false, edits);

  const renamed = await cplan(["first_name"], { first_name: { previous: customer.first_name, value: `${customer.first_name}x` } });
  const body = (put(renamed, "/api/customers/")?.body as any)?.customer ?? {};
  ok("a renamed customer is sent as PUT /api/customers/{uid}", body.customer_first_name === `${customer.first_name}x`, brief(renamed));
  ok("the unchanged email is left OUT, so Zuper does not re-check it against archived customers", !("customer_email" in body), JSON.stringify(Object.keys(body)));

  const last = await cplan(["last_name"], { last_name: { previous: customer.last_name, value: "Edited" } });
  const lastBody = (put(last, "/api/customers/")?.body as any)?.customer ?? {};
  ok("the first name goes with every PUT, which Zuper requires, even when it is not what changed", lastBody.customer_last_name === "Edited" && !!lastBody.customer_first_name, JSON.stringify(lastBody));

  const cboth = await cplan(["first_name"], { first_name: { previous: "a name neither side has", value: "New" } });
  ok("a customer renamed on both sides: Zuper's name stands", !cboth.requests.length && /changed in Zuper too/.test(why(cboth, "first_name")), brief(cboth));

  const mobile = await cplan(["contact_no"], { contact_no: { previous: customer.contact_no, value: { ...(customer.contact_no ?? {}), mobile: "+971500000001" } } });
  const numbers = (put(mobile, "/api/customers/")?.body as any)?.customer?.customer_contact_no ?? {};
  ok("only the number that changed is sent", numbers.mobile === "+971500000001" && Object.keys(numbers).length === 1, JSON.stringify(numbers));

  const gone = await cplan(["is_deleted"], { is_deleted: { previous: false, value: true } });
  ok("a customer deleted in Tuper is NEVER deleted in Zuper", !gone.requests.length && /never deleted/.test(why(gone, "is_deleted")), brief(gone));

  const counter = await cplan(["no_of_jobs"], {});
  ok("Tuper's job counter is not a change to push", !counter.requests.length && /counts/.test(why(counter, "no_of_jobs")), brief(counter));

  finish();
}

function finish() {
  console.log(`\n${passed} passed, ${failedCount} failed — nothing was written anywhere`);
  process.exit(failedCount ? 1 : 0);
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
