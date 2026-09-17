// ── Checklists (forms) admin ── the Settings builders over jms.forms + form_fields (+ options): Zuper's checklist builder
// for one job status (Settings › Jobs › Job Category Hub › a category › a status's Checklist) and the list builder
// Inspection Forms reuse. A checklist bound to a (category, status) via job_statuses.form_id gates that transition.
// Questions are saved in place (jms.save_checklist_fields, 00102): each keeps its id and field_key, so the answers given
// to it stay with it, and a removed question someone answered is kept, marked removed (00101).
import type { TuperClient as SupabaseClient } from "../../tuper-client.js";
import { FilterValidationError } from "./operators";
import { StaleWriteError } from "./write";
import { VALIDATION_KEYS } from "./checklist-validation";
import { COPY_DEFAULTS, COPYABLE_TYPES } from "./checklist-copy-targets";
import { hasSetting, TIME_INTERVALS, DEFAULT_TIME_INTERVAL, type ChecklistSetting } from "./checklist-field-settings";

export const FORM_KINDS = [{ label: "Checklist", value: "CHECKLIST" }, { label: "Inspection Form", value: "INSPECTION_FORM" }];
export const FIELD_TYPES = [
  "SECTION_HEADER", "SINGLE_LINE_TEXT", "MULTI_LINE_TEXT", "DATE", "TIME", "DATE_TIME",
  "SINGLE_SELECTION", "MULTI_SELECTION", "DROPDOWN", "UPLOAD", "SINGLE_IMAGE", "MULTI_IMAGE",
  "VIDEO", "BARCODE_SCAN", "SIGNATURE",
].map((v) => ({ label: v.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), value: v }));
const TYPE_VALUES = new Set(FIELD_TYPES.map((t) => t.value));
export const OPTION_TYPES = new Set(["SINGLE_SELECTION", "MULTI_SELECTION", "DROPDOWN"]);
/** Zuper's Checklist View Type: every question on one page, or one question a page. */
export const VIEW_TYPES = ["SINGLE_PAGE", "MULTI_PAGE"] as const;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "field";
const KEY_RE = /^[a-z0-9_]{1,60}$/;

export interface ChecklistFieldInput {
  /** The question's id when it's already saved; a new one has none. */
  id?: string;
  field_key?: string; label: string; field_type: string; is_required?: boolean;
  help_text?: string | null; placeholder?: string | null; options?: { label: string; value: string }[];
  /** Conditions, visibility, read-only, restricted status update and the rest — see cleanConfig. */
  config?: Record<string, unknown> | null;
}

export async function listChecklists(client: SupabaseClient, tenantId: string) {
  const { data } = await client.schema("jms").from("forms")
    .select("id, name, description, form_kind, is_active, form_fields(count)")
    .eq("tenant_id", tenantId).eq("is_deleted", false).eq("form_fields.is_deleted", false).order("name", { ascending: true });
  return (data ?? []).map((f: any) => ({ id: f.id, name: f.name, description: f.description, form_kind: f.form_kind, is_active: f.is_active, field_count: f.form_fields?.[0]?.count ?? 0 }));
}

export async function createChecklist(client: SupabaseClient, tenantId: string, createdBy: string, input: { name: string; form_kind?: string; description?: string }): Promise<{ id: string }> {
  if (!input.name?.trim()) throw new FilterValidationError("a checklist name is required");
  const { data, error } = await client.schema("jms").from("forms").insert({
    tenant_id: tenantId, name: input.name.trim(), form_kind: input.form_kind ?? "CHECKLIST",
    description: input.description ?? null, created_by: createdBy,
  }).select("id").single();
  if (error) throw error;
  return { id: (data as any).id };
}

export async function updateChecklist(client: SupabaseClient, tenantId: string, id: string, patch: { name?: string; description?: string; is_active?: boolean }): Promise<void> {
  const fields: Record<string, unknown> = {};
  if (patch.name != null) { if (!patch.name.trim()) throw new FilterValidationError("name is required"); fields.name = patch.name.trim(); }
  if (patch.description !== undefined) fields.description = patch.description;
  if (patch.is_active != null) fields.is_active = patch.is_active;
  if (Object.keys(fields).length === 0) return;
  const { error } = await client.schema("jms").from("forms").update(fields).eq("id", id).eq("tenant_id", tenantId);
  if (error) throw error;
}

export async function deleteChecklist(client: SupabaseClient, tenantId: string, id: string): Promise<void> {
  const { error } = await client.schema("jms").from("forms").update({ is_deleted: true, deleted_at: new Date().toISOString() }).eq("id", id).eq("tenant_id", tenantId);
  if (error) throw error;
}

/** A question's settings as the builder saves them. Only what the builder knows, and what Zuper's builder offers on this
 *  type of question (checklist-field-settings.ts), is kept; a condition may only name another question of the same
 *  checklist (a new question's key is renamed if the one the page chose was taken). */
function cleanConfig(c: Record<string, unknown> | null | undefined, fieldType: string, rename: ReadonlyMap<string, string>, keys: ReadonlySet<string>, own: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!c || typeof c !== "object") return out;
  const may = (s: ChecklistSetting) => hasSetting(fieldType, s);
  const key = (k: unknown) => { const s = String(k ?? "").trim(); return rename.get(s) ?? s; };
  const strs = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => String(x ?? "").trim()).filter(Boolean);
  const named = (k: string) => k !== own && keys.has(k);
  // Zuper's dependent fields: all conditions (or any, with OR); an imported question keeps its single depends_on.
  const conditions = (Array.isArray(c.conditions) ? c.conditions : [])
    .map((x: any) => ({ field_key: key(x?.field_key), operator: x?.operator === "EQUAL_TO" ? "EQUAL_TO" : "CONTAINS", values: strs(x?.values) }))
    .filter((x) => named(x.field_key));
  if (conditions.length) {
    out.conditions = conditions;
    if (c.condition_type === "OR" && conditions.length > 1) out.condition_type = "OR";
  } else if (typeof c.depends_on === "string" && named(key(c.depends_on))) {
    out.depends_on = key(c.depends_on);
    out.show_when = strs(c.show_when);
  }
  // Mark as hidden field, Hide to FE / Technician, Mark as Read Only, Restrict to Camera, Choose first option by default,
  // and a picture's Stamp Date & Time and Stamp GPS Coordinates.
  const FLAGS = [
    ["hidden", "HIDDEN"], ["hide_to_fe", "HIDE_TO"], ["read_only", "READ_ONLY"], ["restrict_to_camera", "RESTRICT_CAMERA"],
    ["default_option", "DEFAULT_OPTION"], ["stamp_date_time", "STAMP_DATE_TIME"], ["stamp_gps", "STAMP_GPS"],
  ] as const;
  for (const [flag, setting] of FLAGS) if (c[flag] === true && may(setting)) out[flag] = true;
  // Associate Tags and Associate Albums: the Gallery tags and job albums a picture question's photos are filed under.
  const ids = (v: unknown) => [...new Set(strs(v).filter((x) => /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 50);
  if (may("ASSOCIATE_TAGS") && ids(c.tag_ids).length) out.tag_ids = ids(c.tag_ids);
  if (may("AUTO_ALBUM") && ids(c.album_ids).length) out.album_ids = ids(c.album_ids);
  // Time Interval: the time picker's minute step. Zuper's pickers use 30 when none is set, so only another step is kept.
  const step = Number(c.time_interval);
  if (may("TIME_INTERVAL") && TIME_INTERVALS.includes(step) && step !== DEFAULT_TIME_INTERVAL) out.time_interval = step;
  // Zuper's Validation (checklist-validation.ts): the kind, a Regex's pattern, a Number's limits.
  if (may("VALIDATION") && typeof c.validation === "string" && VALIDATION_KEYS.has(c.validation)) {
    out.validation = c.validation;
    if (c.validation === "regex") {
      const re = typeof c.regex_value === "string" ? c.regex_value.trim().slice(0, 200) : "";
      if (!re) delete out.validation;
      else {
        try { new RegExp(re); } catch { throw new FilterValidationError(`the pattern “${re}” isn't a valid regular expression`); }
        out.regex_value = re;
      }
    }
    if (c.validation === "number") {
      const num = (x: unknown) => (x === null || x === undefined || x === "" || !Number.isFinite(Number(x)) ? undefined : Number(x));
      const min = num(c.min_value), max = num(c.max_value);
      if (min !== undefined && max !== undefined && min > max) throw new FilterValidationError("the smallest number allowed is larger than the largest");
      if (min !== undefined) out.min_value = min;
      if (max !== undefined) out.max_value = max;
    }
  }
  // Restricted Status Update: one of these answers stops the status change (Zuper's meta_options.restrict_status_update).
  const r = c.restrict_status_update as { is_enabled?: unknown; restricted_options?: unknown; message?: unknown } | undefined;
  if (may("RESTRICT_STATUS") && r?.is_enabled === true && strs(r.restricted_options).length) {
    out.restrict_status_update = {
      is_enabled: true, restricted_options: strs(r.restricted_options),
      message: typeof r.message === "string" && r.message.trim() ? r.message.trim().slice(0, 300) : null,
    };
  }
  // Update Field: the answer is copied to a job's or its customer's default or custom field (Zuper's copy_to_field,
  // checklist-copy.ts). A default field must be one Tuper can copy to; a custom field is named by its definition id. Only
  // a text, date or choice answer copies (COPYABLE_TYPES): Zuper's pictures, files and signatures can too, Tuper's not yet.
  const copy = c.copy_to_field as { module?: unknown; type?: unknown; field_key?: unknown; prefill_value?: unknown } | null | undefined;
  if (COPYABLE_TYPES.has(fieldType) && copy && typeof copy.field_key === "string" && copy.field_key.trim()) {
    const module = copy.module === "CUSTOMER" ? "CUSTOMER" : "JOB";
    const type = copy.type === "CUSTOM_FIELD" ? "CUSTOM_FIELD" : "DEFAULT";
    const key = copy.field_key.trim();
    const known = type === "DEFAULT" ? COPY_DEFAULTS[module].some((d) => d.key === key) : /^[0-9a-f-]{36}$/i.test(key);
    if (known) out.copy_to_field = { module, type, field_key: key, prefill_value: copy.prefill_value === true };
  }
  return out;
}

/** Settings from the Zuper import, cleaned as a save cleans them, so the sync can tell when a checklist is unchanged. */
export function checklistFieldConfig(config: Record<string, unknown>, fieldType: string, keys: ReadonlySet<string>, own: string): Record<string, unknown> {
  return cleanConfig(config, fieldType, new Map(), keys, own);
}

/**
 * Save a checklist's questions, in this order, in place (one step — jms.save_checklist_fields). A question sent with its
 * id (or, from the Zuper sync, its field_key) updates that question; a new one gets an id and a key of its own. A question
 * left out is removed: kept, marked removed, if someone answered it; deleted otherwise. `expectedVersion` (the checklist's
 * updated_at as the page loaded it) refuses a save over someone else's. `strict` (the builder) also asks every selection
 * question for an option, and a new or renamed question for a name no other question has (Zuper's "Field Name should be
 * unique"); imported checklists can repeat names, so the sync doesn't ask.
 */
export async function saveChecklistFields(
  client: SupabaseClient, tenantId: string, formId: string, fields: ChecklistFieldInput[],
  opts: { expectedVersion?: string | null; strict?: boolean } = {},
): Promise<{ version: string; fields: { id: string; field_key: string }[] }> {
  const { data: existing, error } = await client.schema("jms").from("form_fields").select("id, field_key, label, is_deleted").eq("tenant_id", tenantId).eq("form_id", formId);
  if (error) throw error;
  const rows = (existing ?? []) as { id: string; field_key: string; label: string; is_deleted: boolean }[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const liveByKey = new Map(rows.filter((r) => !r.is_deleted).map((r) => [r.field_key, r]));
  const used = new Set(rows.map((r) => r.field_key));
  const claimed = new Set<string>();
  const rename = new Map<string, string>();
  const placed = fields.map((f, i) => {
    const label = String(f.label ?? "").trim();
    if (!label) throw new FilterValidationError(`question ${i + 1} needs a name`);
    if (label.length > 500) throw new FilterValidationError(`question ${i + 1}'s name is longer than 500 characters`);
    if (!TYPE_VALUES.has(f.field_type)) throw new FilterValidationError(`“${label}” has a type the checklist doesn't have`);
    let row = (f.id ? byId.get(f.id) : undefined) ?? (f.field_key ? liveByKey.get(f.field_key) : undefined);
    if (row && claimed.has(row.id)) row = undefined;
    if (row) { claimed.add(row.id); return { f, label, id: row.id, key: row.field_key, was: row.label as string | null }; }
    const want = f.field_key && KEY_RE.test(f.field_key) ? f.field_key : slug(label);
    let key = want;
    for (let n = 2; used.has(key); n++) key = `${want}_${n}`;
    used.add(key);
    if (f.field_key && f.field_key !== key) rename.set(f.field_key, key);
    return { f, label, id: crypto.randomUUID(), key, was: null as string | null };
  });
  if (opts.strict) {
    const names = new Map<string, number>();
    for (const p of placed) names.set(p.label.toLowerCase(), (names.get(p.label.toLowerCase()) ?? 0) + 1);
    const clash = placed.find((p) => p.was?.toLowerCase() !== p.label.toLowerCase() && (names.get(p.label.toLowerCase()) ?? 0) > 1);
    if (clash) throw new FilterValidationError(`Field Name should be unique: “${clash.label}” is used twice`);
  }
  const keys = new Set(placed.map((p) => p.key));
  const payload = placed.map(({ f, label, id, key }) => {
    const options: { label: string; value: string }[] = [];
    if (OPTION_TYPES.has(f.field_type)) {
      const seen = new Set<string>(); // UNIQUE (form_field_id, value)
      for (const o of f.options ?? []) {
        const l = String(o?.label ?? "").trim();
        if (!l) continue;
        const v = String(o?.value ?? "").trim() || l;
        if (!seen.has(v)) { seen.add(v); options.push({ label: l, value: v }); }
      }
      if (opts.strict && !options.length) throw new FilterValidationError(`“${label}” needs at least one option`);
    }
    return {
      id, field_key: key, label, field_type: f.field_type,
      // A header is a section title, not a question — nothing to answer, so never required.
      is_required: f.field_type !== "SECTION_HEADER" && Boolean(f.is_required),
      help_text: String(f.help_text ?? "").trim() || null, placeholder: String(f.placeholder ?? "").trim() || null,
      config: cleanConfig(f.config, f.field_type, rename, keys, key), options,
    };
  });
  const { data, error: rpcErr } = await client.schema("jms").rpc("save_checklist_fields", {
    p_tenant_id: tenantId, p_form_id: formId, p_fields: payload, p_expected_version: opts.expectedVersion ?? null,
  });
  if (rpcErr) {
    if (/STALE/.test(rpcErr.message)) throw new StaleWriteError();
    if (/checklist not found/.test(rpcErr.message)) throw new FilterValidationError("checklist not found");
    throw rpcErr;
  }
  return { version: String(data), fields: placed.map((p) => ({ id: p.id, field_key: p.key })) };
}

// ── One status's checklist (Zuper's builder) ──

export interface StatusChecklistField {
  id: string; field_key: string; label: string; field_type: string; is_required: boolean;
  help_text: string | null; placeholder: string | null; config: Record<string, unknown>; options: { label: string; value: string }[];
}
export interface StatusChecklist {
  status: { id: string; name: string; status_type: string; category_id: string; checklist_view_type: string; prefill_checklist: boolean };
  category: { id: string; name: string };
  /** null until the first question is saved; `version` is what a save must match. */
  form: { id: string; name: string; version: string } | null;
  fields: StatusChecklistField[];
}

async function statusRow(client: SupabaseClient, tenantId: string, statusId: string) {
  const { data, error } = await client.schema("jms").from("job_statuses")
    .select("id, name, status_type, category_id, form_id, checklist_view_type, prefill_checklist, category:category_id(id, name)")
    .eq("id", statusId).eq("tenant_id", tenantId).eq("is_deleted", false).maybeSingle();
  if (error) throw error;
  return data as null | {
    id: string; name: string; status_type: string; category_id: string; form_id: string | null;
    checklist_view_type: string | null; prefill_checklist: boolean | null; category: { id: string; name: string } | null;
  };
}

export async function getStatusChecklist(client: SupabaseClient, tenantId: string, statusId: string): Promise<StatusChecklist | null> {
  const s = await statusRow(client, tenantId, statusId);
  if (!s) return null;
  let form: StatusChecklist["form"] = null;
  let fields: StatusChecklistField[] = [];
  if (s.form_id) {
    const { data: f } = await client.schema("jms").from("forms").select("id, name, updated_at").eq("id", s.form_id).eq("tenant_id", tenantId).eq("is_deleted", false).maybeSingle();
    if (f) {
      form = { id: (f as any).id, name: (f as any).name, version: (f as any).updated_at };
      const { data: rows, error } = await client.schema("jms").from("form_fields")
        .select("id, field_key, label, field_type, is_required, help_text, placeholder, config, form_field_options(label, value, display_order)")
        .eq("tenant_id", tenantId).eq("form_id", form.id).eq("is_deleted", false).order("display_order", { ascending: true });
      if (error) throw error;
      fields = ((rows ?? []) as any[]).map((r) => ({
        id: r.id, field_key: r.field_key, label: r.label, field_type: r.field_type, is_required: r.is_required,
        help_text: r.help_text ?? null, placeholder: r.placeholder ?? null, config: r.config ?? {},
        options: [...(r.form_field_options ?? [])].sort((a: any, b: any) => a.display_order - b.display_order).map((o: any) => ({ label: o.label, value: o.value })),
      }));
    }
  }
  return {
    status: { id: s.id, name: s.name, status_type: s.status_type, category_id: s.category_id, checklist_view_type: s.checklist_view_type ?? "SINGLE_PAGE", prefill_checklist: s.prefill_checklist === true },
    category: { id: s.category?.id ?? s.category_id, name: s.category?.name ?? "" },
    form, fields,
  };
}

/** The status's checklist — made (named as the Zuper import names them, "<category> – <status>") and bound when it has
 *  none. If someone binds one at the same moment, theirs is used. */
export async function ensureStatusChecklist(client: SupabaseClient, tenantId: string, statusId: string, userId: string, depth = 0): Promise<{ formId: string; version: string; created: boolean }> {
  const s = await statusRow(client, tenantId, statusId);
  if (!s) throw new FilterValidationError("status not found");
  if (s.form_id) {
    const { data: f } = await client.schema("jms").from("forms").select("id, updated_at").eq("id", s.form_id).eq("tenant_id", tenantId).eq("is_deleted", false).maybeSingle();
    if (f) return { formId: (f as any).id, version: (f as any).updated_at, created: false };
  }
  if (depth > 1) throw new FilterValidationError("the checklist couldn't be made; try again");
  const { data: made, error } = await client.schema("jms").from("forms")
    .insert({ tenant_id: tenantId, form_kind: "CHECKLIST", name: `${s.category?.name ?? "Checklist"} – ${s.name}`, created_by: userId })
    .select("id, updated_at").single();
  if (error) throw error;
  const bind = client.schema("jms").from("job_statuses").update({ form_id: (made as any).id }).eq("id", statusId).eq("tenant_id", tenantId);
  const { data: bound, error: bindErr } = await (s.form_id ? bind.eq("form_id", s.form_id) : bind.is("form_id", null)).select("id");
  if (bindErr) throw bindErr;
  if (!bound?.length) {
    await client.schema("jms").from("forms").delete().eq("id", (made as any).id).eq("tenant_id", tenantId);
    return ensureStatusChecklist(client, tenantId, statusId, userId, depth + 1);
  }
  return { formId: (made as any).id, version: (made as any).updated_at, created: true };
}

/**
 * Save the status's questions (making its checklist on the first save). `expectedVersion` is the version the page loaded:
 * null when the status had no checklist then — so a checklist someone else made meanwhile is refused as stale.
 */
export async function saveStatusChecklist(
  client: SupabaseClient, tenantId: string, statusId: string, userId: string, fields: ChecklistFieldInput[],
  expectedVersion: string | null | undefined, opts: { strict?: boolean } = {},
): Promise<{ version: string; formId: string }> {
  const { formId, created } = await ensureStatusChecklist(client, tenantId, statusId, userId);
  if (!created && expectedVersion === null) throw new StaleWriteError();
  const r = await saveChecklistFields(client, tenantId, formId, fields, { expectedVersion: created ? null : expectedVersion, strict: opts.strict });
  return { version: r.version, formId };
}

/** Zuper's "Update Checklist Form": the view type and whether answers may be prefilled. */
export async function updateStatusChecklistSettings(client: SupabaseClient, tenantId: string, statusId: string, patch: { checklist_view_type?: string; prefill_checklist?: boolean }): Promise<void> {
  const fields: Record<string, unknown> = {};
  if (patch.checklist_view_type !== undefined) {
    if (!(VIEW_TYPES as readonly string[]).includes(patch.checklist_view_type)) throw new FilterValidationError("the view type is Single Page or Multi Page");
    fields.checklist_view_type = patch.checklist_view_type;
  }
  if (patch.prefill_checklist !== undefined) fields.prefill_checklist = patch.prefill_checklist === true;
  if (!Object.keys(fields).length) return;
  const { data, error } = await client.schema("jms").from("job_statuses").update(fields).eq("id", statusId).eq("tenant_id", tenantId).eq("is_deleted", false).select("id");
  if (error) throw error;
  if (!data?.length) throw new FilterValidationError("status not found");
}

/** How many live questions each checklist has. */
async function questionCounts(client: SupabaseClient, tenantId: string, formIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (let i = 0; i < formIds.length; i += 100) {
    const { data, error } = await client.schema("jms").from("forms").select("id, form_fields(count)")
      .eq("tenant_id", tenantId).in("id", formIds.slice(i, i + 100)).eq("form_fields.is_deleted", false);
    if (error) throw error;
    for (const f of (data ?? []) as any[]) counts.set(f.id, f.form_fields?.[0]?.count ?? 0);
  }
  return counts;
}

/** Zuper's Clone Checklist list: each category with its statuses that have questions. */
export async function listChecklistSources(client: SupabaseClient, tenantId: string) {
  const { data, error } = await client.schema("jms").from("job_statuses")
    .select("id, name, display_order, form_id, category:category_id(id, name, is_deleted)")
    .eq("tenant_id", tenantId).eq("is_deleted", false).not("form_id", "is", null).order("display_order", { ascending: true });
  if (error) throw error;
  const rows = ((data ?? []) as any[]).filter((r) => r.category && !r.category.is_deleted);
  const counts = await questionCounts(client, tenantId, [...new Set(rows.map((r) => r.form_id as string))]);
  const byCat = new Map<string, { category: { id: string; name: string }; statuses: { id: string; name: string; field_count: number }[] }>();
  for (const r of rows) {
    const n = counts.get(r.form_id) ?? 0;
    if (!n) continue;
    let entry = byCat.get(r.category.id);
    if (!entry) { entry = { category: { id: r.category.id, name: r.category.name }, statuses: [] }; byCat.set(r.category.id, entry); }
    entry.statuses.push({ id: r.id, name: r.name, field_count: n });
  }
  return [...byCat.values()].sort((a, b) => a.category.name.localeCompare(b.category.name));
}

/** Zuper's Clone Checklist: the chosen questions of another status's checklist replace this one's. Keys stay the source's,
 *  so the copied conditions still point at the copied questions; a condition on a question left behind is dropped. */
export async function cloneStatusChecklist(
  client: SupabaseClient, tenantId: string, targetStatusId: string, sourceStatusId: string, userId: string,
  opts: { fieldKeys?: string[]; expectedVersion?: string | null } = {},
): Promise<{ version: string; formId: string }> {
  if (targetStatusId === sourceStatusId) throw new FilterValidationError("choose another status to clone from");
  const src = await getStatusChecklist(client, tenantId, sourceStatusId);
  if (!src?.form || !src.fields.length) throw new FilterValidationError("that status has no checklist to clone");
  const pick = opts.fieldKeys?.length ? new Set(opts.fieldKeys) : null;
  const chosen = src.fields.filter((f) => !pick || pick.has(f.field_key));
  if (!chosen.length) throw new FilterValidationError("choose at least one question to clone");
  return saveStatusChecklist(client, tenantId, targetStatusId, userId, chosen.map((f) => ({
    field_key: f.field_key, label: f.label, field_type: f.field_type, is_required: f.is_required,
    help_text: f.help_text, placeholder: f.placeholder, config: f.config, options: f.options,
  })), opts.expectedVersion);
}

/** Zuper's category page: the category and its statuses in order, each with its checklist (name and question count). */
export async function listCategoryStatuses(client: SupabaseClient, tenantId: string, categoryId: string) {
  const { data: cat, error: catErr } = await client.schema("jms").from("job_categories")
    .select("id, name, color, estimated_duration_minutes").eq("id", categoryId).eq("tenant_id", tenantId).eq("is_deleted", false).maybeSingle();
  if (catErr) throw catErr;
  if (!cat) return null;
  const { data, error } = await client.schema("jms").from("job_statuses")
    .select("id, name, status_type, color, display_order, form_id, parent_status_id, parent_status_ids")
    .eq("tenant_id", tenantId).eq("category_id", categoryId).eq("is_deleted", false).eq("is_active", true)
    .order("display_order", { ascending: true });
  if (error) throw error;
  const statuses = (data ?? []) as { id: string; name: string; status_type: string; color: string | null; display_order: number; form_id: string | null; parent_status_id: string | null; parent_status_ids: string[] }[];
  const formIds = [...new Set(statuses.map((s) => s.form_id).filter(Boolean) as string[])];
  const counts = await questionCounts(client, tenantId, formIds);
  return {
    category: cat as { id: string; name: string; color: string | null; estimated_duration_minutes: number | null },
    statuses: statuses.map((s) => ({ ...s, field_count: s.form_id ? counts.get(s.form_id) ?? 0 : 0 })),
  };
}
