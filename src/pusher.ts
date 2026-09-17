/**
 * Pushing application-made job changes to Zuper — the other half of two-way sync.
 *
 *   Tuper ──write──▶ Tuper webhook ──receiver──▶ sync.outbox ──pusher──▶ Zuper
 *
 * A change made in Tuper arrives here as one of Tuper's webhooks and is queued in this service's own database. This
 * module turns queued changes into Zuper API calls. (Until Tuper had webhooks this came from a database trigger; the
 * queue row looks the same either way.) A change this service itself wrote into Tuper fires no webhook, which is what
 * keeps the two systems from echoing each other.
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

import type { TuperClient as SupabaseClient } from "./tuper-client.js";
import { config, errorText } from "./config.js";
import { tuper as db } from "./tuper-client.js";
import { sql } from "./store.js";
import { getSyncConfig, zuperGet, type SyncConfig } from "./lib/migration/zuper-sync.js";
import { JOB_CREATE_LOCK, oneAtATime, setBeforeInbound } from "./processor.js";
// The two modules import each other; both only define functions, so neither needs the other while loading.
import { planCustomer, verifyCustomer } from "./pusher-customers.js";

export type PushMode = "off" | "dry-run" | "live";

interface OutboxRow {
  id: string;
  entity: string;
  jms_id: string;
  zuper_uid: string | null;
  operation: "create" | "update";
  changed: Record<string, unknown>;
  previous: Record<string, unknown>;
  status: string;
  attempts: number;
  queued_at: string;
}

/**
 * What someone did to one column, across all of a record's pending rows: the
 * value it held BEFORE their first edit, and the value they LAST set.
 *
 * The row alone cannot say this. Every inbound webhook for the record rewrites
 * the whole row from Zuper, so an edit made in Tuper can be reverted in jms.*
 * before it is pushed. A planner that compared only the row with Zuper then saw
 * "Zuper already has this value" and dropped the edit without a trace. With
 * both ends of the edit the planner can tell the three cases apart:
 *
 *   Zuper holds the new value      nothing to do
 *   Zuper holds the old value      nobody touched it there: push the edit
 *   Zuper holds something else     changed on both sides: a conflict
 *
 * A marker row ({_assignees: true}, a follow-up) carries no values and is
 * planned from the tables as they stand, as before.
 */
export type Edits = Record<string, { previous: unknown; value: unknown }>;

export function editsOf(rows: { operation: string; changed: Record<string, unknown>; previous?: Record<string, unknown>; queued_at: string }[]): Edits {
  const edits: Edits = {};
  for (const r of [...rows].sort((a, b) => a.queued_at.localeCompare(b.queued_at))) {
    if (r.operation === "create") continue;
    for (const [k, v] of Object.entries(r.changed ?? {})) {
      if (k in edits) edits[k].value = v;                                  // the last edit wins
      else edits[k] = { previous: (r.previous ?? {})[k], value: v };        // the first one remembers where it started
    }
  }
  return edits;
}

/**
 * True for a real value someone set; false for a marker such as {_assignees: true}
 * or a follow-up row. A marker is told by having NO "before" — the trigger records
 * one for every real column, null included — and not by its value: `true` is also
 * what has_sla, do_not_service and is_deleted are set to.
 */
export const isValue = (e: { previous: unknown; value: unknown } | undefined): e is { previous: unknown; value: unknown } =>
  !!e && e.previous !== undefined;

/** One Zuper call the pusher would make. */
export interface PlannedRequest {
  method: "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  /** Why this request exists, in words. */
  why: string;
}

export interface Plan {
  /** Sync entity: jobs, customers, … Absent on plans stored before other entities were pushed. */
  entity?: string;
  /** What a person would call the record: a work order number, a customer's name. */
  label?: string | null;
  /** The record's jms id. Named for the first entity pushed; it is any record's id now. */
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
export const uidFor = async (client: SupabaseClient, entity: string, jmsId: string | null | undefined) =>
  (await uidsFor(client, entity, jmsId))[0]?.uid ?? null;

/** jms.addresses-style JSON → Zuper's address object (the reverse of zAddress). */
export function zuperAddress(a: any): Record<string, unknown> | null {
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
export function sameAddress(ours: Record<string, unknown> | null, theirs: any): boolean {
  const norm = (a: any) => ADDRESS_KEYS.map((k) => String(a?.[k] ?? "").trim().toLowerCase()).join("|");
  return norm(ours) === norm(theirs);
}

// ── planning ─────────────────────────────────────────────────────────────────

const PRIORITIES = new Set(["LOW", "MEDIUM", "HIGH", "URGENT"]);
const trimmed = (v: unknown): string | null => { const t = v == null ? "" : String(v).trim(); return t || null; };

/**
 * Zuper's value for a column, put the way the inbound sync stores it
 * (lib/migration/zuper-sync.ts, `jobs.transform`). A conflict check compares it
 * with what jms.* held BEFORE an edit, and that was written by the inbound sync —
 * so "  Title " in Zuper and "Title" here are the same value, not a conflict.
 * `undefined` means the inbound value cannot be reproduced, so no conflict is claimed.
 */
function zuperAsStored(column: string, zj: any): unknown {
  switch (column) {
    case "title": return trimmed(zj.job_title) ?? "Job";
    case "prefix": return trimmed(zj.prefix);
    case "priority": { const p = String(zj.job_priority ?? "").toUpperCase(); return PRIORITIES.has(p) ? p : "LOW"; }
    case "job_type": return zj.job_type === "REVISIT" ? "REVISIT" : "NEW";
    // With no due date in Zuper the inbound sync derives one, which cannot be reproduced here.
    case "due_date": return zj.due_date ? zj.due_date : undefined;
    case "job_tags": return Array.isArray(zj.job_tags) ? zj.job_tags : [];
    default: return undefined;
  }
}

const sameInstant = (a: unknown, b: unknown) =>
  (!a || !b) ? !a && !b : new Date(String(a)).getTime() === new Date(String(b)).getTime();

const CONFLICT = (now: unknown) =>
  `changed in Zuper too, which now has ${JSON.stringify(now ?? null).slice(0, 80)}: left as Zuper has it (PUSH_ON_CONFLICT=zuper-wins)`;

/**
 * Work out the Zuper requests for one job's pending changes.
 *
 * Reads only. `columns` is the union of what changed across the job's queued
 * rows; `forceCreate` is set when the job has never been in Zuper; `edits` says
 * what each column was changed from and to (see Edits).
 */
export async function planJob(
  client: SupabaseClient, cfg: SyncConfig, jobId: string, columns: string[], forceCreate: boolean, edits: Edits = {},
): Promise<Plan> {
  const { data: job, error } = await client.schema("jms").from("jobs").select("*")
    .eq("tenant_id", config.tenantId).eq("id", jobId).maybeSingle();
  if (error) throw error;
  const zuperUid = await uidFor(client, "jobs", jobId);
  const plan: Plan = {
    entity: "jobs", label: (job as any)?.work_order_number ? `WO ${(job as any).work_order_number}` : null,
    jobId, workOrder: (job as any)?.work_order_number ?? null, zuperUid,
    operation: zuperUid ? "update" : "create", columns, requests: [], notPushed: [],
  };
  if (!job) { plan.blocked = "the job no longer exists in Tuper"; return plan; }
  // Plan from what people SET, not from what the row holds this second: an inbound
  // sync may have put Zuper's value back over an edit that has not been pushed yet.
  const j = { ...(job as Record<string, any>) };
  for (const [c, e] of Object.entries(edits)) if (isValue(e) && c in j) j[c] = e.value;

  if (!zuperUid) return planCreate(client, j, plan, forceCreate);

  const zj = await zuperJob(cfg, zuperUid);
  if (!zj) { plan.blocked = "Zuper no longer has this job (404)"; return plan; }
  const cols = new Set(columns);

  /**
   * Changed on both sides? Only asked once Zuper is known NOT to hold the new
   * value. `zuperStillHas(previous)` says whether Zuper holds what the edit
   * started from; if it holds neither, someone changed it there as well.
   */
  const conflict = (c: string, zuperStillHas: (previous: unknown) => boolean): boolean => {
    const e = edits[c];
    return config.push.onConflict === "zuper-wins" && isValue(e) && !zuperStillHas(e.previous);
  };

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
    if (sameValue(c, ours, zj[zf])) { plan.notPushed.push({ column: c, reason: "Zuper already has this value" }); continue; }
    const stored = zuperAsStored(c, zj);
    if (stored !== undefined && conflict(c, (previous) => sameValue(c, previous ?? (c === "job_tags" ? [] : null), stored))) {
      plan.notPushed.push({ column: c, reason: CONFLICT(zj[zf]) });
      continue;
    }
    fields[zf] = ours;
  }
  if ([...cols].some((c) => DESCRIPTION.has(c))) fields.job_description = j.description_html ?? j.description ?? "";
  for (const [c, zf] of [["service_address", "customer_address"], ["billing_address", "customer_billing_address"]] as const) {
    if (!cols.has(c)) continue;
    const ours = zuperAddress(j[c]);
    if (sameAddress(ours, zj[zf])) plan.notPushed.push({ column: c, reason: "Zuper already has this address" });
    else if (conflict(c, (previous) => sameAddress(zuperAddress(previous), zj[zf]))) plan.notPushed.push({ column: c, reason: CONFLICT(zj[zf]?.street ?? zj[zf]) });
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
      // Rescheduled in Zuper as well (a dispatcher there, or the AMC booking flow)?
      const movedInZuper =
        conflict("scheduled_start_time", (previous) => sameInstant(previous, zj.scheduled_start_time)) ||
        conflict("scheduled_end_time", (previous) => sameInstant(previous, zj.scheduled_end_time));
      if (same) plan.notPushed.push({ column: "schedule", reason: "Zuper already has this schedule" });
      else if (movedInZuper) plan.notPushed.push({ column: "schedule", reason: CONFLICT(zj.scheduled_start_time) });
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
    } else if (await statusMovedInZuper(client, edits.current_status_id, zj)) {
      // The likeliest conflict there is: a technician moved the job on from the mobile
      // app while someone set a status at a desk. The technician's is the later fact.
      plan.notPushed.push({ column: "current_status_id", reason: CONFLICT(zj.current_job_status?.status_name) });
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

/**
 * Did Zuper's status move while a status set in Tuper was waiting to be pushed?
 * True when Zuper shows a status that is not the one the edit started from. Several
 * Zuper statuses can share one Tuper status (one per category), hence the list.
 */
async function statusMovedInZuper(client: SupabaseClient, edit: Edits[string] | undefined, zj: any): Promise<boolean> {
  if (config.push.onConflict !== "zuper-wins" || !isValue(edit) || typeof edit.previous !== "string") return false;
  const current = zj.current_job_status?.status_uid;
  if (!current) return false;
  const before = await uidsFor(client, "job_statuses", edit.previous);
  // A previous status Zuper has no counterpart for proves nothing either way.
  return before.length > 0 && !before.some((c) => c.uid === current);
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

/** The requests that make a new record in Zuper, and where each answers with its uid. */
const CREATES: Record<string, { entity: string; uidOf: (body: any) => string | null }> = {
  "/api/jobs": { entity: "jobs", uidOf: (b) => b?.job_uid ?? b?.data?.job_uid ?? null },
  "/api/customers_new": { entity: "customers", uidOf: (b) => b?.customer_uid ?? b?.data?.customer_uid ?? b?.data?.customer?.customer_uid ?? null },
};

interface Outcome {
  ok: boolean;
  responses: unknown[];
  error?: string;
  /** Do not try again by itself: whether the record was created is not known. */
  needsAPerson?: boolean;
}

async function execute(client: SupabaseClient, cfg: SyncConfig, plan: Plan): Promise<Outcome> {
  const responses: unknown[] = [];
  let uid = plan.zuperUid;
  const entity = plan.entity ?? "jobs";
  for (const r of plan.requests) {
    const create = r.method === "POST" ? CREATES[r.path] : undefined;
    if (create) {
      // Create and map atomically as far as this process is concerned.
      let out: { res: Awaited<ReturnType<typeof send>>; newUid: string | null };
      try {
        out = await oneAtATime(create.entity === "jobs" ? JOB_CREATE_LOCK : `push:create:${create.entity}`, async () => {
          const res = await send(cfg, r);
          const newUid = create.uidOf(res.body);
          if (res.ok && newUid) {
            const { error } = await client.schema("jms").from("zuper_sync_map").upsert(
              { tenant_id: config.tenantId, entity: create.entity, zuper_uid: newUid, jms_id: plan.jobId, synced_at: new Date(0).toISOString() },
              { onConflict: "tenant_id,entity,zuper_uid" },
            );
            if (error) throw error;
          }
          return { res, newUid };
        });
      } catch (err) {
        // A timeout or a dropped connection: Zuper may or may not have made the
        // record. A second POST would make a second one, so this stops here.
        return { ok: false, responses, needsAPerson: true, error: `create: no answer (${errorText(err).slice(0, 160)}). It may exist in Zuper already: check before replaying` };
      }
      responses.push({ status: out.res.status, type: out.res.body?.type, uid: out.newUid, message: out.res.body?.message });
      if (!out.res.ok) return { ok: false, responses, error: `create failed: HTTP ${out.res.status} ${out.res.body?.message ?? ""}`.trim() };
      if (!out.newUid) return { ok: false, responses, needsAPerson: true, error: "created, but Zuper's answer carried no uid, so the record is not linked: link it by hand before replaying" };
      uid = out.newUid;
      if (create.entity === "jobs") {
        // A new Zuper job starts in its category's first status, and assignments
        // may have been rejected on create. Queue a follow-up that compares both
        // with Tuper once Zuper has settled.
        await sql(
          `INSERT INTO sync.outbox (tenant_id, entity, jms_id, zuper_uid, operation, changed, origin, next_try_at)
           VALUES ($1, 'jobs', $2, $3, 'update', $4, 'zupersync-followup', now() + interval '60 seconds')`,
          [config.tenantId, plan.jobId, uid, JSON.stringify({ current_status_id: true, _assignees: true })],
        );
      }
      continue;
    }
    const res = await send(cfg, r);
    responses.push({ path: r.path, status: res.status, type: res.body?.type, message: res.body?.message });
    if (!res.ok) return { ok: false, responses, error: `${r.method} ${r.path}: HTTP ${res.status} ${res.body?.message ?? ""}`.trim() };
  }
  if (uid && plan.operation === "update") {
    const problem = entity === "customers" ? await verifyCustomer(cfg, plan, uid) : await verify(cfg, plan, uid);
    if (problem) return { ok: false, responses, error: `sent, but ${problem}` };
  }
  return { ok: true, responses };
}

// ── the loop ─────────────────────────────────────────────────────────────────

export interface PushResult { jobs: number; planned: number; sent: number; skipped: number; failed: number; waiting: number }

const backoffMinutes = (attempts: number) => Math.min(240, 2 ** attempts);

type Planner = (client: SupabaseClient, cfg: SyncConfig, id: string, columns: string[], forceCreate: boolean, edits: Edits) => Promise<Plan>;

/** Which kinds of record can be pushed. A change to anything else is queued, shown, and marked not built. */
const PLANNERS: Record<string, Planner> = { jobs: planJob, customers: planCustomer };

/**
 * `live` reaches only the entities named in PUSH_ENTITIES. Every other one is
 * planned and never sent, so a kind of record goes live on its own, after its
 * requests have been watched against the real account.
 */
export const modeFor = (mode: PushMode, entity: string): PushMode =>
  mode === "live" && !config.push.entities.includes(entity) ? "dry-run" : mode;

/** For /health and the start-up log: what is sent, what is only planned, and how a conflict is settled. */
export function pushState(): { mode: PushMode; sentToZuper: string[]; plannedOnly: string[]; onConflict: string; deletes: boolean } {
  const mode = config.push.mode;
  const known = Object.keys(PLANNERS);
  const sentToZuper = mode === "off" ? [] : known.filter((e) => modeFor(mode, e) === "live");
  return { mode, sentToZuper, plannedOnly: mode === "off" ? [] : known.filter((e) => !sentToZuper.includes(e)), onConflict: config.push.onConflict, deletes: config.push.deletes };
}

/** How long a claimed row is this runner's. Longer than any push; short enough that a crash frees it soon. */
const LEASE_MS = 120_000;

/**
 * Take due outbox rows, group them by record, plan (and for a live entity, send).
 * `only` narrows the run to one record: the inbound sync uses it to push a
 * record's pending edits before it overwrites the row with Zuper's values.
 */
export async function pushPending(
  mode: PushMode = config.push.mode, limit = config.push.batch, only?: { entity: string; jmsId: string },
): Promise<PushResult> {
  const result: PushResult = { jobs: 0, planned: 0, sent: 0, skipped: 0, failed: 0, waiting: 0 };
  if (mode === "off") return result;
  const client = db();
  const cfg = await getSyncConfig(client, config.tenantId);
  if (!cfg.api_key) throw new Error("no Zuper API key configured");

  // Dry run plans only fresh rows; live also takes rows a dry run already planned.
  const statuses = mode === "live" ? ["queued", "planned", "failed"] : ["queued"];
  const data = await sql<OutboxRow>(
    `SELECT id, entity, jms_id, zuper_uid, operation, changed, previous, status, attempts, queued_at
       FROM sync.outbox
      WHERE tenant_id = $1 AND status = ANY($2) AND next_try_at <= now() AND attempts < $3
        AND ($4::text IS NULL OR (entity = $4 AND jms_id = $5::uuid))
      ORDER BY queued_at ASC
      LIMIT $6`,
    [config.tenantId, statuses, config.push.maxAttempts, only?.entity ?? null, only?.jmsId ?? null, limit * 10],
  );

  const groups = new Map<string, OutboxRow[]>();
  for (const row of (data ?? []) as OutboxRow[]) {
    const key = `${row.entity}:${row.jms_id}`;
    const g = groups.get(key) ?? [];
    g.push(row);
    groups.set(key, g);
  }

  const now = Date.now();
  for (const [key, all] of [...groups].slice(0, limit)) {
    const entity = all[0].entity, recordId = all[0].jms_id;
    const effective = modeFor(mode, entity);
    // An entity that is not live is planned once; its planned rows are not planned again every tick.
    let rows = effective === "live" ? all : all.filter((r) => r.status === "queued");
    if (!rows.length) continue;

    const markRows = async (ids: string[], patch: Record<string, unknown>) => {
      if (!ids.length) return;
      const columns = Object.keys(patch);
      const sets = columns.map((c, i) => `${c} = $${i + 2}`).join(", ");
      await sql(
        `UPDATE sync.outbox SET ${sets} WHERE id = ANY($1)`,
        [ids, ...columns.map((c) => {
          const v = patch[c];
          return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
        })],
      );
    };

    const planner = PLANNERS[entity];
    if (!planner) {
      // Queued by a trigger, so it is on the dashboard — but said plainly, not dropped.
      const blocked = `pushing ${entity} to Zuper is not built yet: this change stays in Tuper, and Zuper's value returns on its next sync`;
      await markRows(rows.map((r) => r.id), { status: "skipped", last_error: blocked,
        planned: { entity, label: null, jobId: recordId, workOrder: null, zuperUid: rows[0].zuper_uid, operation: rows[0].operation, columns: [], requests: [], notPushed: [], blocked } satisfies Plan });
      result.skipped++;
      continue;
    }

    const isCreate = rows.some((r) => r.operation === "create");
    // A new record arrives in several requests (the row, then its assignees,
    // teams, addresses, line items). Give them time to land before planning it.
    const newest = Math.max(...rows.map((r) => new Date(r.queued_at).getTime()));
    if (isCreate && now - newest < config.push.createDelaySeconds * 1000) { result.waiting++; continue; }

    // Too old to send — see PUSH_MAX_AGE_MINUTES. Only a live send is refused; a plan harms nobody.
    if (effective === "live") {
      const stale = rows.filter((r) => now - new Date(r.queued_at).getTime() > config.push.maxAgeMinutes * 60_000 && r.status !== "failed");
      if (stale.length) {
        const hours = Math.round((now - new Date(stale[0].queued_at).getTime()) / 3_600_000);
        await markRows(stale.map((r) => r.id), { status: "skipped",
          last_error: `not sent: queued about ${hours}h ago, before pushing ${entity} was live (PUSH_MAX_AGE_MINUTES=${config.push.maxAgeMinutes}). Make the change again if it is still wanted` });
        result.skipped++;
        rows = rows.filter((r) => !stale.includes(r));
        if (!rows.length) continue;
      }
    }

    // Claim the rows in the database. Two runners can be alive at once — the tick and
    // the inbound sync's flush here, or two containers during a deploy — and a
    // status sent twice is two history entries in Zuper.
    const claimed = await sql<{ id: string }>(
      `UPDATE sync.outbox SET next_try_at = $1
        WHERE id = ANY($2) AND status = ANY($3) AND next_try_at <= $4
        RETURNING id`,
      [new Date(now + LEASE_MS).toISOString(), rows.map((r) => r.id), statuses, new Date(now).toISOString()],
    );
    const mine = new Set(claimed.map((r) => r.id));
    rows = rows.filter((r) => mine.has(r.id));
    if (!rows.length) continue;

    result.jobs++;
    const ids = rows.map((r) => r.id);
    const mark = (patch: Record<string, unknown>) => markRows(ids, patch);
    const columns = [...new Set(rows.flatMap((r) => (r.operation === "create" ? [] : Object.keys(r.changed ?? {}))))];
    const attemptsNow = Math.max(...rows.map((r) => r.attempts)) + 1;
    const failed = (patch: Record<string, unknown>, stop = false) => mark({
      ...patch, status: "failed", attempts: stop ? config.push.maxAttempts : attemptsNow,
      next_try_at: new Date(Date.now() + backoffMinutes(attemptsNow) * 60_000).toISOString(),
    });

    try {
      const plan = await oneAtATime(`push:${key}`, () => planner(client, cfg, recordId, columns, isCreate, editsOf(rows)));
      if (plan.blocked || !plan.requests.length) {
        await mark({ status: "skipped", planned: plan, last_error: plan.blocked ?? null });
        result.skipped++;
        continue;
      }
      if (effective === "dry-run") {
        await mark({ status: "planned", planned: plan });
        result.planned++;
        continue;
      }
      const out = await oneAtATime(`push:${key}`, () => execute(client, cfg, plan));
      if (out.ok) {
        await mark({ status: "sent", planned: plan, response: out.responses, sent_at: new Date().toISOString(), last_error: null });
        result.sent++;
      } else {
        await failed({ planned: plan, response: out.responses, last_error: out.error ?? "failed" }, out.needsAPerson);
        result.failed++;
      }
    } catch (err) {
      await failed({ last_error: errorText(err).slice(0, 400) }).catch(() => undefined);
      result.failed++;
    }
  }
  return result;
}

/**
 * Push one record's pending edits NOW, because the inbound sync is about to
 * rewrite its row from Zuper (processor.syncRecord calls this first).
 *
 * Without it a job's people are the casualty: assigning someone in Tuper leaves
 * only a marker in the outbox, the inbound sync rebuilds the assignment rows from
 * Zuper, and by the next tick there is nothing left to say who was wanted. Field
 * edits survive that (see Edits), but Tuper would show the old value until the
 * push and its echo had both happened.
 */
export async function pushRecordNow(entity: string, zuperUid: string): Promise<void> {
  if (modeFor(config.push.mode, entity) !== "live" || !PLANNERS[entity]) return;
  const client = db();
  const { data, error } = await client.schema("jms").from("zuper_sync_map").select("jms_id")
    .eq("tenant_id", config.tenantId).eq("entity", entity).eq("zuper_uid", zuperUid).limit(1);
  if (error) throw error;
  const jmsId = (data as { jms_id: string }[] | null)?.[0]?.jms_id;
  if (!jmsId) return;
  const r = await pushPending("live", 1, { entity, jmsId });
  if (r.jobs) console.log(`[zupersync] push before inbound sync (${entity} ${zuperUid}): ${r.sent} sent, ${r.skipped} skipped, ${r.failed} failed`);
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
      if (r.jobs) console.log(`[zupersync] push (${mode}): ${r.jobs} record(s) — ${r.planned} planned, ${r.sent} sent, ${r.skipped} skipped, ${r.failed} failed${r.waiting ? `, ${r.waiting} waiting` : ""}`);
    } catch (err) {
      const msg = errorText(err);
      // Before migrations/0002 is applied the table does not exist; say so once.
      if (/sync\.outbox|zuper_outbox|42P01/.test(msg)) {
        if (!missingTableWarned) console.warn("[zupersync] push: sync.outbox is missing — the store migrations have not run");
        missingTableWarned = true;
      } else {
        console.warn("[zupersync] push failed:", msg);
      }
    } finally {
      running = false;
    }
  }, config.push.everySeconds * 1000);
  timer.unref?.();
  const live = Object.keys(PLANNERS).filter((e) => modeFor(mode, e) === "live");
  const planOnly = Object.keys(PLANNERS).filter((e) => !live.includes(e));
  if (live.length) {
    // An inbound sync rewrites the row from Zuper: push the record's pending edits first.
    setBeforeInbound((entity, uid) => pushRecordNow(entity, uid));
  }
  console.log(`[zupersync] push to Zuper every ${config.push.everySeconds}s — ` +
    (live.length ? `LIVE for ${live.join(", ")}` : "nothing is sent") +
    (planOnly.length ? `; planned only (never sent): ${planOnly.join(", ")}` : "") +
    `; on a conflict ${config.push.onConflict}`);
}

export function stopPusher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
