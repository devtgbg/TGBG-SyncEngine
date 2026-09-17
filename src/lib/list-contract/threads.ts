// ── Polymorphic Comments + Activity ("threads") for any entity ──
// One engine behind every module's Comments/Notes + Activity tabs (requests, jobs, …). Rows are
// keyed by (entity_type, entity_id); tenant isolation is enforced in code. Activity is append-only;
// comments are soft-deletable by their author (or an admin). Supersedes request-specific threads.
import type { TuperClient as SupabaseClient } from "../../tuper-client.js";
import { FilterValidationError } from "./operators";

// 'job_chat' is the Job Internal Chat channel — a distinct entity_type so job chat messages never
// mix with 'job' Notes, while sharing the same entity_comments table (no schema change; entity_type
// is free-text TEXT). Zuper keeps Internal Chat separate from customer-visible Notes.
// 'team_chat' is the standalone Team Chat module's single "General" channel — one tenant-wide
// conversation on the same engine, keyed by a fixed entity_id constant (see the chat page). v1 is a
// single channel; multi-channel/DMs/presence/realtime-push are the documented follow-up.
export type ThreadEntity = "request" | "job" | "job_chat" | "team_chat" | "quote" | "invoice" | "customer" | "organization" | "contract" | "asset";

// entity_type → the read/collaborate permission that gates its comments & activity.
// organizations share the customer.view permission (same as the search/list contract).
// team_chat is gated on 'job.view': it's a broadly-held internal read (granted to every default
// access role — Administrator, Team Leader AND Field Executive — see _seed_rbac.ts READS/FE_GRANTS),
// so the whole team can use chat, and it mirrors how the Job Internal Chat ('job_chat') is gated.
export const THREAD_PERM: Record<string, string> = {
  request: "request.view", job: "job.view", job_chat: "job.view", team_chat: "job.view", quote: "estimate.view", invoice: "invoice.view", customer: "customer.view", organization: "customer.view", contract: "service_contract.view", asset: "asset.view",
};

/**
 * Thread type → list-contract entity, for row-scoping a thread/attachment by its PARENT.
 * The two namespaces differ (singular thread types vs plural descriptor keys), and holding a
 * read permission is not the same as being allowed to see a given parent row.
 *
 * Typed `Record<ThreadEntity, …>` on purpose: the compiler then forces a decision for every
 * thread type, so a new one cannot silently fall through a scope check as an allow.
 * `null` = nothing to scope against (team_chat is a tenant-wide channel, not a row).
 */
export const THREAD_SCOPE_ENTITY: Record<ThreadEntity, string | null> = {
  request: "requests",
  job: "jobs",
  job_chat: "jobs",      // a chat lives on its job — scope by the job
  team_chat: null,       // tenant-wide channel, no parent row
  quote: "quotes",
  invoice: "invoices",
  customer: "customers",
  organization: "organizations",
  contract: "contracts",
  asset: "assets",
};

export interface ThreadComment {
  id: string;
  body: string;
  created_at: string;
  updated_at: string;
  author_id: string | null;
  author_name: string | null;
}

export interface ThreadActivity {
  id: string;
  verb: string;
  meta: Record<string, unknown>;
  created_at: string;
  actor_name: string | null;
  /** Who did it; null when the system did. */
  actor_id?: string | null;
  /** The record it happened on: the page's own, or with Show related activities one related to it. */
  entity_type?: string;
  entity_id?: string;
  /** For an entry on a related record (a job's quote, invoice or child job): which one. */
  on?: { type: string; id: string; label: string } | null;
}

/** Zuper's activity types (Job › Activity › All activity types) and the entries each one covers. Everything else — the
 *  job being created, edits, reschedules, assignments, files, line items — shows whatever types are ticked. */
export const ACTIVITY_GROUPS = {
  // zuper_*: entries imported from Zuper's own activity feed (2026-09-15), in Zuper's words.
  NOTES: ["commented", "replied", "note_edited", "note_pinned", "note_unpinned", "note_privacy", "note_deleted", "zuper_note"],
  STATUS: ["status_changed", "status_entry_deleted", "zuper_status"],
  TIMELOG: ["timelog_added", "timelog_updated", "timelog_deleted", "zuper_timelog"],
  WORKFLOW: ["workflow_ran", "workflow_failed"],
} as const;
export type ActivityGroup = keyof typeof ACTIVITY_GROUPS;
export const isActivityGroup = (v: string): v is ActivityGroup => Object.prototype.hasOwnProperty.call(ACTIVITY_GROUPS, v);

export interface ActivityQuery {
  /** The types left out (unticked in Zuper's menu). */
  hide?: ActivityGroup[];
  /** One person's entries, or "system" for changes made on the system's behalf. */
  actor?: string | null;
  /** From this instant (inclusive) up to that one (exclusive). */
  from?: string | null;
  to?: string | null;
  /** Where the previous page ended (its `next`). */
  cursor?: string | null;
  limit?: number;
  /** Related records whose entries join the list (Show related activities). */
  related?: { type: ThreadEntity; ids: string[] }[];
}

// Entry details the pages never show and that could hold something private: a token, a storage path, an email or phone.
const PRIVATE_KEY = /(token|secret|password|api_key|storage_path|signature_path|email|phone)/i;
/** An entry's details as sent to a page: nothing private-looking, at the top level or among an edit's old/new values. */
export function publicMeta(meta: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (PRIVATE_KEY.test(k)) continue;
    out[k] = k === "changes" && v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([f]) => !PRIVATE_KEY.test(f)))
      : v;
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const quoted = (v: string) => `"${v.replace(/"/g, "")}"`;
const encodeCursor = (row: { created_at: string; id: string }) => Buffer.from(`${row.created_at}|${row.id}`).toString("base64url");
function decodeCursor(c: string): { at: string; id: string } | null {
  try {
    const [at, id] = Buffer.from(c, "base64url").toString("utf8").split("|");
    return at && id && !isNaN(Date.parse(at)) && UUID_RE.test(id) ? { at, id } : null;
  } catch { return null; }
}

/** One page of a record's Activity, newest first — ties broken by id, so paging never repeats or skips an entry — with
 *  Zuper's filters applied. `next` is null on the last page. */
export async function listActivityPage(
  client: SupabaseClient, tenantId: string, type: ThreadEntity, entityId: string, q: ActivityQuery = {},
): Promise<{ items: ThreadActivity[]; next: string | null }> {
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? 20), 1), 100);
  const targets = [`and(entity_type.eq.${type},entity_id.eq.${entityId})`];
  for (const r of q.related ?? []) {
    const ids = r.ids.filter((x) => UUID_RE.test(x));
    if (ids.length) targets.push(`and(entity_type.eq.${r.type},entity_id.in.(${ids.join(",")}))`);
  }
  const parts = [targets.length > 1 ? `or(${targets.join(",")})` : targets[0]];
  const cur = q.cursor ? decodeCursor(q.cursor) : null;
  if (q.cursor && !cur) throw new FilterValidationError("That page of the activity has expired; reload it.");
  if (cur) parts.push(`or(created_at.lt.${quoted(cur.at)},and(created_at.eq.${quoted(cur.at)},id.lt.${cur.id}))`);
  let qb = client.schema("jms").from("entity_activity")
    .select("id, verb, meta, created_at, actor_id, entity_type, entity_id, actor:actor_id(first_name,last_name)")
    .eq("tenant_id", tenantId)
    .or(`and(${parts.join(",")})`);
  const hidden = (q.hide ?? []).flatMap((g) => [...ACTIVITY_GROUPS[g]]);
  if (hidden.length) qb = qb.not("verb", "in", `(${hidden.join(",")})`);
  if (q.actor === "system") qb = qb.is("actor_id", null);
  else if (q.actor) qb = qb.eq("actor_id", q.actor);
  if (q.from) qb = qb.gte("created_at", q.from);
  if (q.to) qb = qb.lt("created_at", q.to);
  const { data, error } = await qb.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (error) throw error;
  const rows = (data ?? []) as any[];
  const page = rows.slice(0, limit);
  return {
    items: page.map((a) => ({
      id: a.id, verb: a.verb, meta: a.meta ?? {}, created_at: a.created_at, actor_name: nameOf(a.actor),
      actor_id: a.actor_id ?? null, entity_type: a.entity_type, entity_id: a.entity_id,
    })),
    next: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
  };
}

type UserRef = { first_name?: string | null; last_name?: string | null } | null;
const nameOf = (u: UserRef): string | null => {
  if (!u) return null;
  const n = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return n || null;
};

export async function listComments(client: SupabaseClient, tenantId: string, type: ThreadEntity, entityId: string): Promise<ThreadComment[]> {
  const { data, error } = await client
    .schema("jms").from("entity_comments")
    .select("id, body, created_at, updated_at, author_id, author:author_id(first_name,last_name)")
    .eq("tenant_id", tenantId).eq("entity_type", type).eq("entity_id", entityId).eq("is_deleted", false)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((c: any) => ({
    id: c.id, body: c.body, created_at: c.created_at, updated_at: c.updated_at,
    author_id: c.author_id, author_name: nameOf(c.author),
  }));
}

export async function createComment(
  client: SupabaseClient, tenantId: string, type: ThreadEntity, entityId: string, authorId: string, body: string,
): Promise<{ id: string }> {
  const { data, error } = await client
    .schema("jms").from("entity_comments")
    .insert({ tenant_id: tenantId, entity_type: type, entity_id: entityId, author_id: authorId, body })
    .select("id").single();
  if (error) throw error;
  await logActivity(client, tenantId, type, entityId, authorId, "commented", {});
  return { id: (data as any).id };
}

/** The comment's author_id if it exists in this tenant+entity, else null. */
export async function getCommentAuthor(
  client: SupabaseClient, tenantId: string, type: ThreadEntity, entityId: string, commentId: string,
): Promise<string | null> {
  const { data } = await client
    .schema("jms").from("entity_comments")
    .select("author_id")
    .eq("id", commentId).eq("tenant_id", tenantId).eq("entity_type", type).eq("entity_id", entityId).eq("is_deleted", false)
    .maybeSingle();
  return data ? ((data as any).author_id ?? null) : null;
}

export async function softDeleteComment(
  client: SupabaseClient, tenantId: string, type: ThreadEntity, entityId: string, commentId: string,
): Promise<void> {
  const { error } = await client
    .schema("jms").from("entity_comments")
    .update({ is_deleted: true, updated_at: new Date().toISOString() })
    .eq("id", commentId).eq("tenant_id", tenantId).eq("entity_type", type).eq("entity_id", entityId);
  if (error) throw error;
}

export async function listActivity(client: SupabaseClient, tenantId: string, type: ThreadEntity, entityId: string): Promise<ThreadActivity[]> {
  const { data, error } = await client
    .schema("jms").from("entity_activity")
    .select("id, verb, meta, created_at, actor:actor_id(first_name,last_name)")
    .eq("tenant_id", tenantId).eq("entity_type", type).eq("entity_id", entityId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((a: any) => ({
    id: a.id, verb: a.verb, meta: a.meta ?? {}, created_at: a.created_at, actor_name: nameOf(a.actor),
  }));
}

/** Append an audit entry. Best-effort — never throws (auditing must not fail the mutation). */
export async function logActivity(
  client: SupabaseClient, tenantId: string, type: ThreadEntity, entityId: string,
  actorId: string | null, verb: string, meta: Record<string, unknown>,
): Promise<void> {
  const { error } = await client
    .schema("jms").from("entity_activity")
    .insert({ tenant_id: tenantId, entity_type: type, entity_id: entityId, actor_id: actorId, verb, meta });
  if (error) console.error("[entity_activity] log failed", type, verb, error.message);
}
