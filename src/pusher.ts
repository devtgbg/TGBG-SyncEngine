/**
 * Pushing application-made job changes to Zuper — the other half of two-way sync.
 *
 *   Tuper ──write──▶ jms.jobs ──trigger──▶ jms.zuper_outbox ──pusher──▶ Zuper
 *
 * The trigger (migrations/0002) queues every change that did not come from
 * Zupersync. This module turns queued changes into Zuper API calls.
 *
 * MODES (PUSH_MODE):
 *   off      nothing is read or written.
 *   dry-run  the default. Each change is turned into the exact requests it would
 *            send, stored on the outbox row as `planned`, and NOTHING is sent. Zuper
 *            is only read (the job's current state, to plan status and assignee
 *            changes correctly). This is how the pusher is watched before it is
 *            trusted with the system of record.
 *   live     the planned requests are sent, and the job is read back to confirm.
 *
 * DESIGN RULES
 *
 *  • The outbox says WHICH columns changed; the VALUES come from the row as it is
 *    now. Several quick edits then collapse into one push of the latest state,
 *    and a push never resurrects a value someone has since overwritten.
 *
 *  • Nothing that writes is retried automatically. Zuper adds a status-history
 *    entry on every status call, even for the job's current status, so a blind
 *    retry after a timeout can record a transition twice. A failed row waits for
 *    its backoff, and the next attempt first re-reads the job and skips what
 *    Zuper already has.
 *
 *  • A 200 is not proof. Zuper answers 200 with {type:"error"}, and silently
 *    ignores fields it does not apply (assigned_to on PUT /jobs, is_deleted). Live
 *    pushes read the job back and fail the row if the change did not land.
 *
 *  • After a push Zuper sends its own webhook, and Zupersync re-reads the job and
 *    writes it back. That write carries x-sync-origin and is not queued again, so
 *    the loop closes after one round. Zuper is the system of record: if it did not
 *    take a change, the re-read puts Zuper's value back in Tuper, and the failed
 *    outbox row says why.
 *
 * Request shapes are the ones the AMC engine and the client portal use in
 * production against this account (see the header of each builder).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { config, errorText } from "./config.js";
import { db } from "./supabase.js";
import { getSyncConfig, zuperGet, type SyncConfig } from "./lib/migration/zuper-sync.js";
import { JOB_CREATE_LOCK, oneAtATime } from "./processor.js";

export type PushMode = "off" | "dry-run" | "live";

interface OutboxRow {
  id: string;
  entity: string;
  jms_id: string;
  zuper_uid: string | null;
  operation: "create" | "update";
  changed: Record<string, unknown>;
  status: string;
  attempts: number;
  queued_at: string;
}

/** One Zuper call the pusher would make. */
export interface PlannedRequest {
  method: "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  /** Why this request exists, in words. */
  why: string;
}

export interface Plan {
  jobId: string;
  workOrder: string | null;
  zuperUid: string | null;
  operation: "create" | "update";
  columns: string[];
  requests: PlannedRequest[];
  /** Changes that will not reach Zuper, and why. */
  notPushed: { column: string; reason: string }[];
  /** Planning stopped: the change cannot be pushed as things stand. */
  blocked?: string;
}

// ── what each column means to Zuper ──────────────────────────────────────────

/** Columns sent with PUT /api/jobs, and the Zuper field each becomes. */
const JOB_FIELDS: Record<string, string> = {
  title: "job_title",
  priority: "job_priority",
  job_type: "job_type",
  due_date: "due_date",
  prefix: "prefix",
  job_tags: "job_tags",
};
const DESCRIPTION = new Set(["description", "description_html", "plain_text_description", "markdown_description"]);
const SCHEDULE = new Set(["scheduled_start_time", "scheduled_end_time"]);

/** Columns that change in Tuper but have no Zuper counterpart to push to. */
const NOT_ZUPER: Record<string, string> = {
  is_delayed: "Zuper works out delays itself",
  actual_start_time: "set by Zuper from timelogs",
  actual_end_time: "set by Zuper from timelogs",
  work_order_number: "Zuper numbers its own jobs",
  created_by: "fixed when the job is created",
  request_id: "the request link is Tuper's",
  contract_id: "contract links are not pushed yet",
  project_id: "Zuper has no projects",
  recurrence_rule: "recurring series are not pushed yet",
  recurring_parent_id: "recurring series are not pushed yet",
  service_territory_id: "Zuper derives the territory from the address",
  job_skills: "skills are not pushed yet",
  all_day_schedule: "not pushed yet",
  category_id: "Zuper does not move a job to another category",
  feedback_rating: "customer feedback is recorded in Zuper, not pushed to it",
  feedback_comment: "customer feedback is recorded in Zuper, not pushed to it",
  job_source: "Tuper's own bookkeeping",
  property_id: "properties are not synced",
  deleted_at: "follows is_deleted",
  parent_job_id: "changing a parent job is not pushed yet",
};

// ── lookups: our ids → Zuper uids ────────────────────────────────────────────

async function uidsFor(client: SupabaseClient, entity: string, jmsId: string | null | undefined): Promise<{ uid: string; synced_at: string }[]> {
  if (!jmsId) return [];
  const { data, error } = await client.schema("jms").from("zuper_sync_map")
    .select("zuper_uid, synced_at").eq("tenant_id", config.tenantId).eq("entity", entity).eq("jms_id", jmsId)
    .order("synced_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as { zuper_uid: string; synced_at: string }[]).map((r) => ({ uid: r.zuper_uid, synced_at: r.synced_at }));
}
const uidFor = async (client: SupabaseClient, entity: string, jmsId: string | null | undefined) =>
  (await uidsFor(client, entity, jmsId))[0]?.uid ?? null;

/** jms.addresses-style JSON → Zuper's address object (the reverse of zAddress). */
function zuperAddress(a: any): Record<string, unknown> | null {
  if (!a || typeof a !== "object") return null;
  const out: Record<string, unknown> = {
    street: a.street ?? "", city: a.city ?? "", state: a.state ?? "", country: a.country ?? "",
    zip_code: a.zip_code ?? "", landmark: a.landmark ?? "",
    first_name: a.contact_first_name ?? "", last_name: a.contact_last_name ?? "",
    email: a.contact_email ?? "", phone_number: a.contact_phone ?? "",
  };
  if (Number.isFinite(Number(a.latitude)) && Number.isFinite(Number(a.longitude)) && a.latitude != null && a.longitude != null) {
    out.geo_cordinates = [Number(a.latitude), Number(a.longitude)];   // Zuper's spelling
  }
  return out;
}

/** Zuper's own view of the job — what a push has to be planned against. */
async function zuperJob(cfg: SyncConfig, uid: string): Promise<any | null> {
  try {
    return (await zuperGet(cfg, `/api/jobs/${uid}`))?.data ?? null;
  } catch (err) {
    if (/→ 404/.test(String(err))) return null;
    throw err;
  }
}

/**
 * Which team a user is assigned under. Zuper rejects an assignment without one
 * ("Invalid Team UIDs"). Prefer a team the job itself has, then any team the user
 * belongs to.
 */
async function teamUidFor(client: SupabaseClient, userId: string, jobTeamIds: string[]): Promise<string | null> {
  const { data, error } = await client.schema("jms").from("team_members")
    .select("team_id").eq("tenant_id", config.tenantId).eq("user_id", userId);
  if (error) throw error;
  const teams = ((data ?? []) as { team_id: string }[]).map((t) => t.team_id);
  const ordered = [...teams.filter((t) => jobTeamIds.includes(t)), ...teams.filter((t) => !jobTeamIds.includes(t))];
  for (const t of ordered) {
    const uid = await uidFor(client, "teams", t);
    if (uid) return uid;
  }
  return null;
}

/** Whether Zuper already holds our value, so pushing it would change nothing. */
function sameValue(column: string, ours: unknown, theirs: unknown): boolean {
  if (column === "due_date") {
    if (!ours || !theirs) return !ours && !theirs;
    return new Date(String(ours)).getTime() === new Date(String(theirs)).getTime();
  }
  if (column === "job_tags") {
    const a = [...((ours as string[]) ?? [])].sort().join("\u0000");
    const b = [...((theirs as string[]) ?? [])].sort().join("\u0000");
    return a === b;
  }
  return String(ours ?? "") === String(theirs ?? "");
}

const ADDRESS_KEYS = ["street", "city", "state", "country", "zip_code", "landmark"];
function sameAddress(ours: Record<string, unknown> | null, theirs: any): boolean {
  const norm = (a: any) => ADDRESS_KEYS.map((k) => String(a?.[k] ?? "").trim().toLowerCase()).join("|");
  return norm(ours) === norm(theirs);
}

// ── planning ─────────────────────────────────────────────────────────────────

/**
 * Work out the Zuper requests for one job's pending changes.
 *
 * Reads only. `columns` is the union of what changed across the job's queued
 * rows; `forceCreate` is set when the job has never been in Zuper.
 */
export async function planJob(
  client: SupabaseClient, cfg: SyncConfig, jobId: string, columns: string[], forceCreate: boolean,
): Promise<Plan> {
  const { data: job, error } = await client.schema("jms").from("jobs").select("*")
    .eq("tenant_id", config.tenantId).eq("id", jobId).maybeSingle();
  if (error) throw error;
  const zuperUid = await uidFor(client, "jobs", jobId);
  const plan: Plan = {
    jobId, workOrder: (job as any)?.work_order_number ?? null, zuperUid,
    operation: zuperUid ? "update" : "create", columns, requests: [], notPushed: [],
  };
  if (!job) { plan.blocked = "the job no longer exists in Tuper"; return plan; }
  const j = job as Record<string, any>;

  if (!zuperUid) return planCreate(client, j, plan, forceCreate);

  const zj = await zuperJob(cfg, zuperUid);
  if (!zj) { plan.blocked = "Zuper no longer has this job (404)"; return plan; }
  const cols = new Set(columns);

  // Deletion first: nothing else matters for a job that is going away.
  if (cols.has("is_deleted")) {
    if (j.is_deleted) {
      if (config.push.deletes) {
        plan.requests.push({ method: "DELETE", path: `/api/jobs/${zuperUid}/delete`, why: "deleted in Tuper" });
      } else {
        plan.notPushed.push({ column: "is_deleted", reason: "deleting in Zuper is switched off (PUSH_DELETES=false)" });
      }
      return plan;
    }
    plan.notPushed.push({ column: "is_deleted", reason: "Zuper cannot restore a deleted job" });
  }
  if (j.is_deleted) { plan.blocked = "the job is deleted in Tuper"; return plan; }

  // Plain fields → one PUT /api/jobs. [AMC engine / command-center scripts: { job: { job_uid, … } }]
  const fields: Record<string, unknown> = {};
  for (const c of cols) {
    const zf = JOB_FIELDS[c];
    if (!zf) continue;
    const ours = j[c] ?? (c === "job_tags" ? [] : null);
    if (sameValue(c, ours, zj[zf])) plan.notPushed.push({ column: c, reason: "Zuper already has this value" });
    else fields[zf] = ours;
  }
  if ([...cols].some((c) => DESCRIPTION.has(c))) fields.job_description = j.description_html ?? j.description ?? "";
  for (const [c, zf] of [["service_address", "customer_address"], ["billing_address", "customer_billing_address"]] as const) {
    if (!cols.has(c)) continue;
    const ours = zuperAddress(j[c]);
    if (sameAddress(ours, zj[zf])) plan.notPushed.push({ column: c, reason: "Zuper already has this address" });
    else fields[zf] = ours;
  }
  if (cols.has("customer_id")) {
    const uid = await uidFor(client, "customers", j.customer_id);
    if (uid) fields.customer_uid = uid;
    else plan.notPushed.push({ column: "customer_id", reason: "that customer is not in Zuper" });
  }
  if (cols.has("organization_id")) {
    const uid = await uidFor(client, "organizations", j.organization_id);
    if (uid) fields.organization = uid;
    else plan.notPushed.push({ column: "organization_id", reason: "that organization is not in Zuper" });
  }
  if (cols.has("asset_id")) {
    const uid = await uidFor(client, "assets", j.asset_id);
    if (uid) fields.assets = [{ asset: uid }];
    else plan.notPushed.push({ column: "asset_id", reason: j.asset_id ? "that asset is not in Zuper" : "removing an asset is not pushed yet" });
  }
  if (Object.keys(fields).length) {
    plan.requests.push({ method: "PUT", path: "/api/jobs", body: { job: { job_uid: zuperUid, ...fields } }, why: `changed ${Object.keys(fields).join(", ")}` });
  }

  // Schedule → PUT /api/jobs/schedule. [AMC engine zuper-write.js:32-56, production]
  if ([...cols].some((c) => SCHEDULE.has(c))) {
    if (j.scheduled_start_time && j.scheduled_end_time) {
      const same = zj.scheduled_start_time && zj.scheduled_end_time
        && new Date(zj.scheduled_start_time).getTime() === new Date(j.scheduled_start_time).getTime()
        && new Date(zj.scheduled_end_time).getTime() === new Date(j.scheduled_end_time).getTime();
      if (same) plan.notPushed.push({ column: "schedule", reason: "Zuper already has this schedule" });
      else plan.requests.push({
        method: "PUT", path: "/api/jobs/schedule", why: "rescheduled",
        body: {
          job_uid: zuperUid,
          from_date: new Date(j.scheduled_start_time).toISOString(),
          to_date: new Date(j.scheduled_end_time).toISOString(),
          remove_from_route: false,
          job_timezone: config.push.timeZone,
        },
      });
    } else {
      plan.notPushed.push({ column: "schedule", reason: "clearing a schedule is not pushed yet" });
    }
  }

  // Status → PUT /api/jobs/{uid}/status. [client portal jobStatusWrite.ts:290-334, AMC zuper-write.js:59-72]
  if (cols.has("current_status_id") && j.current_status_id) {
    const candidates = await uidsFor(client, "job_statuses", j.current_status_id);
    const used = new Set(((zj.job_status ?? []) as any[]).map((s) => s?.status_uid).filter(Boolean));
    const chosen = candidates.find((c) => used.has(c.uid)) ?? candidates[0];
    if (!chosen) {
      plan.notPushed.push({ column: "current_status_id", reason: "that status is not in Zuper" });
    } else if (zj.current_job_status?.status_uid && candidates.some((c) => c.uid === zj.current_job_status.status_uid)) {
      // Every status call adds a history entry — never send one Zuper already shows.
      plan.notPushed.push({ column: "current_status_id", reason: "Zuper already shows this status" });
    } else {
      const { data: hist } = await client.schema("jms").from("job_status_history")
        .select("remarks, remarks_free_text, created_at").eq("tenant_id", config.tenantId)
        .eq("job_id", jobId).eq("to_status_id", j.current_status_id).is("deleted_at", null)
        .order("created_at", { ascending: false }).limit(1);
      const h = ((hist ?? []) as any[])[0];
      const { data: st } = await client.schema("jms").from("job_statuses").select("name").eq("id", j.current_status_id).maybeSingle();
      plan.requests.push({
        method: "PUT", path: `/api/jobs/${zuperUid}/status`, why: `status changed to ${(st as any)?.name ?? "?"}`,
        body: {
          job_uid: zuperUid, status_uid: chosen.uid, status_name: (st as any)?.name ?? undefined,
          ...(h?.remarks ? { remarks: h.remarks } : {}),
          ...(h?.remarks_free_text ? { remarks_free_text: h.remarks_free_text } : {}),
        },
      });
      if (candidates.length > 1 && !used.has(chosen.uid)) {
        plan.notPushed.push({ column: "current_status_id", reason: `note: ${candidates.length} Zuper statuses share this name; picked the newest` });
      }
    }
  }

  // People → POST /api/jobs/assign, the difference only. [AMC zuper-write.js:130-225]
  if (cols.has("_assignees") || cols.has("_teams")) {
    await planAssignees(client, j, zj, zuperUid, plan);
  }

  for (const c of cols) {
    if (NOT_ZUPER[c]) plan.notPushed.push({ column: c, reason: NOT_ZUPER[c] });
  }
  return plan;
}

async function jobTeamIds(client: SupabaseClient, jobId: string): Promise<string[]> {
  const { data, error } = await client.schema("jms").from("job_team_assignments").select("team_id")
    .eq("tenant_id", config.tenantId).eq("job_id", jobId);
  if (error) throw error;
  return ((data ?? []) as { team_id: string }[]).map((t) => t.team_id);
}

async function wantedAssignees(client: SupabaseClient, jobId: string, teamIds: string[], plan: Plan) {
  const { data, error } = await client.schema("jms").from("job_assignments").select("user_id")
    .eq("tenant_id", config.tenantId).eq("job_id", jobId);
  if (error) throw error;
  const out: { user_uid: string; team_uid: string }[] = [];
  for (const { user_id } of (data ?? []) as { user_id: string }[]) {
    const user_uid = await uidFor(client, "users", user_id);
    if (!user_uid) { plan.notPushed.push({ column: "_assignees", reason: `user ${user_id} is not in Zuper` }); continue; }
    const team_uid = await teamUidFor(client, user_id, teamIds);
    if (!team_uid) { plan.notPushed.push({ column: "_assignees", reason: `user ${user_id} belongs to no Zuper team, which Zuper requires` }); continue; }
    out.push({ user_uid, team_uid });
  }
  return out;
}

async function planAssignees(client: SupabaseClient, j: Record<string, any>, zj: any, zuperUid: string, plan: Plan) {
  const teamIds = await jobTeamIds(client, j.id);
  const wanted = await wantedAssignees(client, j.id, teamIds, plan);
  const wantedUids = new Set(wanted.map((w) => w.user_uid));
  const current = ((zj.assigned_to ?? []) as any[])
    .map((a) => ({ user_uid: a?.user?.user_uid as string, team_uid: a?.team?.team_uid as string }))
    .filter((a) => a.user_uid);
  const currentUids = new Set(current.map((c) => c.user_uid));

  const add = wanted.filter((w) => !currentUids.has(w.user_uid));
  // Unassign with the team the user is ACTUALLY under in Zuper, or it silently does nothing.
  const remove = current.filter((c) => !wantedUids.has(c.user_uid) && c.team_uid);
  if (add.length) plan.requests.push({ method: "POST", path: "/api/jobs/assign", why: `assign ${add.length}`, body: { job_uid: zuperUid, type: "ASSIGN", users: add } });
  if (remove.length) plan.requests.push({ method: "POST", path: "/api/jobs/assign", why: `unassign ${remove.length}`, body: { job_uid: zuperUid, type: "UNASSIGN", users: remove } });
  if (!add.length && !remove.length) plan.notPushed.push({ column: "_assignees", reason: "Zuper already has these people" });
  if (plan.columns.includes("_teams")) plan.notPushed.push({ column: "_teams", reason: "teams follow the assigned people; a team with nobody on it is not pushed yet" });
}

/** A job Zuper has never seen → POST /api/jobs. [AMC engine zuper-write.js:323-398, production] */
async function planCreate(client: SupabaseClient, j: Record<string, any>, plan: Plan, forceCreate: boolean): Promise<Plan> {
  plan.operation = "create";
  if (j.is_deleted) { plan.blocked = "deleted in Tuper before it ever reached Zuper"; return plan; }
  if (!forceCreate && !plan.columns.length) { plan.blocked = "nothing to create"; return plan; }

  const category = await uidFor(client, "job_categories", j.category_id);
  if (!category) { plan.blocked = "the job's category is not in Zuper"; return plan; }
  const customer = await uidFor(client, "customers", j.customer_id);
  const organization = await uidFor(client, "organizations", j.organization_id);
  if (!customer && !organization) { plan.blocked = "the job's customer is not in Zuper (customers are not pushed yet)"; return plan; }
  if (!j.scheduled_end_time && !j.due_date) { plan.blocked = "Zuper needs an end time or a due date"; return plan; }

  const teamIds = await jobTeamIds(client, j.id);
  const assigned = await wantedAssignees(client, j.id, teamIds, plan);
  const asset = await uidFor(client, "assets", j.asset_id);
  const parent = await uidFor(client, "jobs", j.parent_job_id);

  const job: Record<string, unknown> = {
    job_title: j.title,
    job_category: category,
    ...(customer ? { customer_uid: customer } : {}),
    ...(organization ? { organization } : {}),
    job_priority: j.priority ?? "LOW",
    job_type: j.job_type ?? "NEW",
    ...(j.description_html || j.description ? { job_description: j.description_html ?? j.description } : {}),
    ...(j.scheduled_start_time ? { scheduled_start_time: new Date(j.scheduled_start_time).toISOString() } : {}),
    ...(j.scheduled_end_time ? { scheduled_end_time: new Date(j.scheduled_end_time).toISOString() } : {}),
    ...(j.due_date ? { due_date: new Date(j.due_date).toISOString() } : {}),
    ...(Array.isArray(j.job_tags) && j.job_tags.length ? { job_tags: j.job_tags } : {}),
    ...(j.service_address ? { customer_address: zuperAddress(j.service_address) } : {}),
    ...(j.billing_address ? { customer_billing_address: zuperAddress(j.billing_address) } : {}),
    ...(asset ? { assets: [{ asset }] } : {}),
    ...(parent ? { parent_job: parent } : {}),
    ...(assigned.length ? { assigned_to: assigned } : {}),
  };
  plan.requests.push({ method: "POST", path: "/api/jobs", body: { job }, why: "made in Tuper, not yet in Zuper" });
  plan.notPushed.push({ column: "work_order_number", reason: `Zuper assigns its own number; Tuper's ${j.work_order_number} will change to it` });
  plan.notPushed.push({ column: "current_status_id", reason: "a new Zuper job starts in its category's first status; Tuper's status and people are checked in a follow-up push" });
  plan.notPushed.push({ column: "line_items/custom_fields", reason: "not pushed yet" });
  return plan;
}

// ── sending ──────────────────────────────────────────────────────────────────

/** One write to Zuper. Never retried here — see the header. */
async function send(cfg: SyncConfig, r: PlannedRequest): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(cfg.api_base + r.path, {
    method: r.method,
    headers: { "x-api-key": cfg.api_key ?? "", "content-type": "application/json", accept: "application/json" },
    body: r.body === undefined ? undefined : JSON.stringify(r.body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  // A 200 can carry {type:"error"}.
  const ok = res.ok && body?.type !== "error";
  return { ok, status: res.status, body };
}

/** After a live push: did Zuper actually take it? */
async function verify(cfg: SyncConfig, plan: Plan, uid: string): Promise<string | null> {
  const zj = await zuperJob(cfg, uid);
  if (!zj) return plan.requests.some((r) => r.method === "DELETE") ? null : "Zuper no longer has the job";
  for (const r of plan.requests) {
    const b = r.body as any;
    if (r.path === "/api/jobs/schedule" && new Date(zj.scheduled_start_time).getTime() !== new Date(b.from_date).getTime()) {
      return "Zuper kept its old schedule";
    }
    if (r.path.endsWith("/status") && zj.current_job_status?.status_uid !== b.status_uid) return "Zuper kept its old status";
    if (r.path === "/api/jobs" && r.method === "PUT" && b.job.job_title !== undefined && zj.job_title !== b.job.job_title) {
      return "Zuper kept its old title";
    }
    if (r.path === "/api/jobs/assign") {
      const have = new Set(((zj.assigned_to ?? []) as any[]).map((a) => a?.user?.user_uid));
      const bad = (b.users as any[]).filter((u) => (b.type === "ASSIGN") !== have.has(u.user_uid));
      if (bad.length) return `Zuper did not ${b.type === "ASSIGN" ? "assign" : "unassign"} ${bad.length} user(s)`;
    }
  }
  return null;
}

async function execute(client: SupabaseClient, cfg: SyncConfig, plan: Plan): Promise<{ ok: boolean; responses: unknown[]; error?: string }> {
  const responses: unknown[] = [];
  let uid = plan.zuperUid;
  for (const r of plan.requests) {
    if (r.method === "POST" && r.path === "/api/jobs") {
      // Create and map atomically as far as this process is concerned.
      const out = await oneAtATime(JOB_CREATE_LOCK, async () => {
        const res = await send(cfg, r);
        const newUid = res.body?.job_uid ?? res.body?.data?.job_uid ?? null;
        if (res.ok && newUid) {
          const { error } = await client.schema("jms").from("zuper_sync_map").upsert(
            { tenant_id: config.tenantId, entity: "jobs", zuper_uid: newUid, jms_id: plan.jobId, synced_at: new Date(0).toISOString() },
            { onConflict: "tenant_id,entity,zuper_uid" },
          );
          if (error) throw error;
        }
        return { res, newUid };
      });
      responses.push({ status: out.res.status, type: out.res.body?.type, job_uid: out.newUid, message: out.res.body?.message });
      if (!out.res.ok || !out.newUid) return { ok: false, responses, error: `create failed: HTTP ${out.res.status} ${out.res.body?.message ?? ""}`.trim() };
      uid = out.newUid;
      // A new Zuper job starts in its category's first status, and assignments
      // may have been rejected on create. Queue a follow-up that compares both
      // with Tuper once Zuper has settled.
      await client.schema("jms").from("zuper_outbox").insert({
        tenant_id: config.tenantId, entity: "jobs", jms_id: plan.jobId, zuper_uid: uid, operation: "update",
        changed: { current_status_id: true, _assignees: true }, origin: "zupersync-followup",
        next_try_at: new Date(Date.now() + 60_000).toISOString(),
      });
      continue;
    }
    const res = await send(cfg, r);
    responses.push({ path: r.path, status: res.status, type: res.body?.type, message: res.body?.message });
    if (!res.ok) return { ok: false, responses, error: `${r.method} ${r.path}: HTTP ${res.status} ${res.body?.message ?? ""}`.trim() };
  }
  if (uid && plan.operation === "update") {
    const problem = await verify(cfg, plan, uid);
    if (problem) return { ok: false, responses, error: `sent, but ${problem}` };
  }
  return { ok: true, responses };
}

// ── the loop ─────────────────────────────────────────────────────────────────

export interface PushResult { jobs: number; planned: number; sent: number; skipped: number; failed: number; waiting: number }

const backoffMinutes = (attempts: number) => Math.min(240, 2 ** attempts);

/** Take due outbox rows, group them by job, plan (and in live mode, send). */
export async function pushPending(mode: PushMode = config.push.mode, limit = config.push.batch): Promise<PushResult> {
  const result: PushResult = { jobs: 0, planned: 0, sent: 0, skipped: 0, failed: 0, waiting: 0 };
  if (mode === "off") return result;
  const client = db();
  const cfg = await getSyncConfig(client, config.tenantId);
  if (!cfg.api_key) throw new Error("no Zuper API key configured");

  // Dry run plans only fresh rows; live also takes rows a dry run already planned.
  const statuses = mode === "live" ? ["queued", "planned", "failed"] : ["queued"];
  const { data, error } = await client.schema("jms").from("zuper_outbox")
    .select("id, entity, jms_id, zuper_uid, operation, changed, status, attempts, queued_at")
    .eq("tenant_id", config.tenantId).eq("entity", "jobs").in("status", statuses)
    .lte("next_try_at", new Date().toISOString()).lt("attempts", config.push.maxAttempts)
    .order("queued_at", { ascending: true }).limit(limit * 10);
  if (error) throw error;

  const groups = new Map<string, OutboxRow[]>();
  for (const row of (data ?? []) as OutboxRow[]) {
    const g = groups.get(row.jms_id) ?? [];
    g.push(row);
    groups.set(row.jms_id, g);
  }

  const now = Date.now();
  for (const [jobId, rows] of [...groups].slice(0, limit)) {
    const ids = rows.map((r) => r.id);
    const isCreate = rows.some((r) => r.operation === "create");
    // A new job arrives in several requests (row, then assignees, teams, line
    // items). Give them time to land before planning the create.
    const newest = Math.max(...rows.map((r) => new Date(r.queued_at).getTime()));
    if (isCreate && now - newest < config.push.createDelaySeconds * 1000) { result.waiting++; continue; }

    result.jobs++;
    const columns = [...new Set(rows.flatMap((r) => (r.operation === "create" ? [] : Object.keys(r.changed ?? {}))))];
    const mark = async (patch: Record<string, unknown>) => {
      const { error: upErr } = await client.schema("jms").from("zuper_outbox")
        .update({ ...patch, updated_at: new Date().toISOString() }).in("id", ids);
      if (upErr) throw upErr;
    };

    try {
      const plan = await oneAtATime(`push:${jobId}`, () => planJob(client, cfg, jobId, columns, isCreate));
      if (plan.blocked || !plan.requests.length) {
        await mark({ status: "skipped", planned: plan, last_error: plan.blocked ?? null });
        result.skipped++;
        continue;
      }
      if (mode === "dry-run") {
        await mark({ status: "planned", planned: plan });
        result.planned++;
        continue;
      }
      const out = await oneAtATime(`push:${jobId}`, () => execute(client, cfg, plan));
      if (out.ok) {
        await mark({ status: "sent", planned: plan, response: out.responses, sent_at: new Date().toISOString(), last_error: null });
        result.sent++;
      } else {
        const attempts = Math.max(...rows.map((r) => r.attempts)) + 1;
        await mark({
          status: "failed", planned: plan, response: out.responses, last_error: out.error ?? "failed", attempts,
          next_try_at: new Date(Date.now() + backoffMinutes(attempts) * 60_000).toISOString(),
        });
        result.failed++;
      }
    } catch (err) {
      const attempts = Math.max(...rows.map((r) => r.attempts)) + 1;
      await mark({
        status: "failed", last_error: errorText(err).slice(0, 400), attempts,
        next_try_at: new Date(Date.now() + backoffMinutes(attempts) * 60_000).toISOString(),
      }).catch(() => undefined);
      result.failed++;
    }
  }
  return result;
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let missingTableWarned = false;

export function startPusher(): void {
  const mode = config.push.mode;
  if (mode === "off") {
    console.log("[zupersync] push to Zuper is OFF (PUSH_MODE=off) — changes made in Tuper stay in Tuper");
    return;
  }
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const r = await pushPending(mode);
      if (r.jobs) console.log(`[zupersync] push (${mode}): ${r.jobs} job(s) — ${r.planned} planned, ${r.sent} sent, ${r.skipped} skipped, ${r.failed} failed${r.waiting ? `, ${r.waiting} waiting` : ""}`);
    } catch (err) {
      const msg = errorText(err);
      // Before migrations/0002 is applied the table does not exist; say so once.
      if (/zuper_outbox|PGRST205|42P01/.test(msg)) {
        if (!missingTableWarned) console.warn("[zupersync] push: jms.zuper_outbox is missing — apply migrations/0002");
        missingTableWarned = true;
      } else {
        console.warn("[zupersync] push failed:", msg);
      }
    } finally {
      running = false;
    }
  }, config.push.everySeconds * 1000);
  timer.unref?.();
  console.log(`[zupersync] push to Zuper: ${mode.toUpperCase()} every ${config.push.everySeconds}s${mode === "dry-run" ? " — requests are planned and stored, nothing is sent" : ""}`);
}

export function stopPusher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
