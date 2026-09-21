// ── Entity tags (jms.tags + jms.taggables) ──
// Tuper already had both tables and a Master Tags settings page, but NOTHING read or wrote
// jms.taggables — so a "Tags" field on a record was decoration. This is the missing half.
//
// Namespacing: `tags.module_key` holds the entity type in upper case (CUSTOMER, JOB, …), which is
// exactly what Settings → Master Tags writes, so tags typed on a record and tags defined in
// settings are the SAME rows rather than two parallel vocabularies. `taggables.entity_type` is the
// jms.custom_field_entity enum, whose values are those same upper-case keys.
import type { TuperClient as SupabaseClient } from "../../tuper-client.js";
import { FilterValidationError } from "./operators";

/** Entity types that can carry tags — MODULE_KEYS in config-admin.ts (Master Tags), less GALLERY, whose tags go on photos. */
export const TAG_ENTITIES = ["JOB", "CUSTOMER", "ORGANIZATION", "ASSET", "REQUEST", "PROPERTY", "PRODUCT"] as const;
export type TagEntity = (typeof TAG_ENTITIES)[number];

export function isTagEntity(v: string): v is TagEntity {
  return (TAG_ENTITIES as readonly string[]).includes(v);
}

/** jms.tags has CHECK (char_length(name) <= 100) since 00200 — trim to it rather than letting the insert fail. It was
 *  25, the most Zuper's screens take as typed; tags written through Zuper's API run longer (GBG's Zoho contact ids are
 *  33), and cutting them at 25 merged thousands of distinct ids into one tag. */
const MAX_TAG = 100;

/** Trim, drop blanks, cap length, and de-duplicate case-insensitively (keeping first spelling). */
export function normalizeTagNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = String(raw ?? "").trim().slice(0, MAX_TAG);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Tag names on one record, alphabetical. */
export async function getEntityTags(
  client: SupabaseClient, tenantId: string, entityType: TagEntity, entityId: string,
): Promise<string[]> {
  const { data, error } = await client.schema("jms").from("taggables")
    .select("tags:tag_id(name)")
    .eq("tenant_id", tenantId).eq("entity_type", entityType).eq("entity_id", entityId);
  if (error) throw error;
  return (data ?? [])
    .map((r: any) => (r as any).tags?.name as string | undefined)
    .filter((n: unknown): n is string => Boolean(n))
    .sort((a: any, b: any) => a.localeCompare(b));
}

/**
 * Tag names for many records at once, keyed by entity id. For list columns — one query instead of
 * one per row (the pattern /api/customers-ar already uses for AR balances).
 */
export async function getEntityTagsBulk(
  client: SupabaseClient, tenantId: string, entityType: TagEntity, entityIds: readonly string[],
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const ids = [...new Set(entityIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const CHUNK = 60; // `.in()` rides in the URL; the gateway answers "URI too long" well before 300 ids
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await client.schema("jms").from("taggables")
      .select("entity_id, tags:tag_id(name)")
      .eq("tenant_id", tenantId).eq("entity_type", entityType)
      .in("entity_id", ids.slice(i, i + CHUNK));
    if (error) throw error;
    for (const r of data ?? []) {
      const id = (r as any).entity_id as string;
      const name = (r as any).tags?.name as string | undefined;
      if (!name) continue;
      (out[id] ??= []).push(name);
    }
  }
  for (const k of Object.keys(out)) out[k].sort((a: any, b: any) => a.localeCompare(b));
  return out;
}

/**
 * Replace a record's tags with exactly `names`, creating any tag that doesn't exist yet.
 * Reconciles rather than delete-all-then-insert, so unchanged links keep their created_at.
 */
export async function setEntityTags(
  client: SupabaseClient, tenantId: string, entityType: TagEntity, entityId: string, names: readonly string[],
): Promise<{ tags: string[] }> {
  if (!isTagEntity(entityType)) throw new FilterValidationError(`'${entityType}' cannot carry tags`);
  const wanted = normalizeTagNames(names);

  // 1. Resolve the wanted names to tag ids within this entity's namespace, creating what's missing.
  const idByLower = new Map<string, string>();
  if (wanted.length > 0) {
    const { data: existing, error: exErr } = await client.schema("jms").from("tags")
      .select("id, name").eq("tenant_id", tenantId).eq("module_key", entityType).in("name", wanted);
    if (exErr) throw exErr;
    for (const t of existing ?? []) idByLower.set(String((t as any).name).toLowerCase(), (t as any).id);

    const missing = wanted.filter((n) => !idByLower.has(n.toLowerCase()));
    if (missing.length > 0) {
      const { data: created, error: cErr } = await client.schema("jms").from("tags")
        .upsert(
          missing.map((name) => ({ tenant_id: tenantId, module_key: entityType, name })),
          { onConflict: "tenant_id,module_key,name", ignoreDuplicates: false },
        )
        .select("id, name");
      if (cErr) throw cErr;
      for (const t of created ?? []) idByLower.set(String((t as any).name).toLowerCase(), (t as any).id);
    }
  }
  const wantedIds = new Set(wanted.map((n: any) => idByLower.get(n.toLowerCase())).filter(Boolean) as string[]);

  // 2. Reconcile the links.
  const { data: links, error: lErr } = await client.schema("jms").from("taggables")
    .select("id, tag_id").eq("tenant_id", tenantId).eq("entity_type", entityType).eq("entity_id", entityId);
  if (lErr) throw lErr;
  const currentIds = new Set((links ?? []).map((l: any) => (l as any).tag_id as string));

  const toRemove = (links ?? []).filter((l: any) => !wantedIds.has((l as any).tag_id as string)).map((l: any) => (l as any).id as string);
  if (toRemove.length > 0) {
    const { error } = await client.schema("jms").from("taggables").delete().in("id", toRemove);
    if (error) throw error;
  }
  const toAdd = [...wantedIds].filter((id) => !currentIds.has(id));
  if (toAdd.length > 0) {
    const { error } = await client.schema("jms").from("taggables").insert(
      toAdd.map((tag_id) => ({ tenant_id: tenantId, tag_id, entity_type: entityType, entity_id: entityId })),
    );
    if (error) throw error;
  }
  return { tags: wanted };
}
