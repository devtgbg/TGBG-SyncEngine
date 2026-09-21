// ── Zuper → Tuper sync engine ── pulls real Golf Buggy Guy data from the Zuper API (x-api-key) and
// upserts it straight into jms.* (no mirror). Idempotent via jms.zuper_sync_map (zuper_uid ↔ jms id),
// so re-runs update in place and cross-entity FKs resolve. Records are written through Tuper's API (src/tuper-client.ts),
// never a database connection. This service's own settings (key / base / enabled / interval) and its run log live in
// its own database, sync.config and sync.runs (src/store.ts). Server-only.
//
// History import (owner decisions 2026-09-11): customers are imported fresh with their Zuper ids and
// the legacy mirror customers retired (retireLegacyCustomers); only active users get accounts, with no
// password and no invite; every job comes across. Run order so links resolve:
//   organizations → customers → users → assets → contracts → requests → jobs → estimates → invoices
import type { TuperClient as SupabaseClient } from "../../tuper-client.js";
import { saveChecklistFields, checklistFieldConfig, type ChecklistFieldInput } from "../list-contract/checklists";
import { setEntityTags } from "../list-contract/entity-tags";
// Zupersync: the three pure helpers this engine used from tenant-dates.ts and
// list-contract/attachments.ts live in ../helpers here — importing those modules
// would drag in virus scanning, EXIF parsing and the timezone tables, none of
// which a sync service runs.
import { addDays as addDaysYmd, cleanFileName, kindOf } from "../helpers";
import { sanitizeRichText, richTextToPlain } from "../rich-text";
import { one as storeOne, sql as storeSql } from "../../store.js";
import { logCall } from "../../api-log.js";

export interface SyncConfig { api_key: string | null; api_base: string; company: string | null; enabled: boolean; interval_hours: number; last_run_at: string | null; next_run_at: string | null; is_syncing: boolean }

// ── Config ──
export async function getSyncConfig(_client: SupabaseClient, tenantId: string): Promise<SyncConfig> {
  // This service's own settings, in its own database (src/store.ts). The row is made on first use.
  const row = await storeOne<SyncConfig>(
    `INSERT INTO sync.config (tenant_id) VALUES ($1)
     ON CONFLICT (tenant_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
     RETURNING api_key, api_base, company, enabled, interval_hours, last_run_at, next_run_at, is_syncing`,
    [tenantId],
  );
  if (!row) throw new Error("could not read the sync configuration");
  return row;
}
export async function saveSyncConfig(client: SupabaseClient, tenantId: string, patch: Partial<SyncConfig>): Promise<void> {
  await getSyncConfig(client, tenantId);
  const fields: Record<string, unknown> = {};
  if (patch.api_key !== undefined && patch.api_key !== "") fields.api_key = patch.api_key;   // blank = keep existing
  if (patch.api_base !== undefined) fields.api_base = patch.api_base;
  if (patch.company !== undefined) fields.company = patch.company;
  if (patch.enabled !== undefined) fields.enabled = patch.enabled;
  if (patch.interval_hours !== undefined) fields.interval_hours = patch.interval_hours;
  if (Object.keys(fields).length === 0) return;
  const columns = Object.keys(fields);
  const sets = columns.map((c, i) => `${c} = $${i + 2}`).join(", ");
  await storeSql(`UPDATE sync.config SET ${sets} WHERE tenant_id = $1`, [tenantId, ...columns.map((c) => fields[c])]);
}

// ── Zuper API client ──
const zHeaders = (cfg: SyncConfig) => ({ "x-api-key": cfg.api_key ?? "", "content-type": "application/json" });
/** One Zuper call, retried with backoff (2s … 30s, six tries) on 429/5xx. Zuper's list endpoints
 *  fail intermittently at deep offsets (jobs past ~27,000: 500, then 200 on a later try). */
async function zuperJson(cfg: SyncConfig, path: string, init: RequestInit, what: string): Promise<any> {
  const method = (init.method ?? "GET").toUpperCase();
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    let res: Response;
    try {
      // A reset or timed-out connection is as transient as a 5xx: retried the same way. Callers only use
      // this for reads and for the idempotent list filters, so a repeat is safe.
      res = await fetch(cfg.api_base + path, { ...init, headers: zHeaders(cfg), signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      const reason = err instanceof Error ? (err.cause as Error | undefined)?.message ?? err.message : String(err);
      logCall({ system: "zuper", method, path, status: null, ok: false, started, attempt, error: reason, request: init.body });
      if (attempt >= 6) throw new Error(`Zuper ${what} → network error: ${reason}`);
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)));
      continue;
    }
    const text = await res.text().catch(() => "");
    logCall({ system: "zuper", method, path, status: res.status, ok: res.ok, started, attempt, request: init.body, response: text });
    if (res.ok) return JSON.parse(text);
    if (attempt >= 6 || (res.status < 500 && res.status !== 429)) throw new Error(`Zuper ${what} → ${res.status}`);
    await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)));
  }
}
export const zuperGet = (cfg: SyncConfig, path: string) => zuperJson(cfg, path, {}, `GET ${path}`);
const filterPage = async (cfg: SyncConfig, path: string, page: number, limit: number, extra: Record<string, unknown> = {}): Promise<any[]> =>
  (await zuperJson(cfg, path, { method: "POST", body: JSON.stringify({ page, limit, filter_rules: [], ...extra }) }, `POST ${path} p${page}×${limit}`)).data ?? [];
/** Page through a POST …/filter list a page at a time, so big lists (46k jobs) never sit in memory.
 *  Zuper fails a whole page when it can't serialize one record in it (seen: jobs p271 → 500), so a
 *  page that keeps failing is refetched a record at a time and only the records that still fail
 *  are skipped (and logged) — one bad record no longer stops the import.
 *
 *  But when the records of the page fail as the page did, the fault is the list, not a record: a
 *  wrong path, a key without access, Zuper refusing it. Skipping on then never ends — each page fails,
 *  each record in it fails, and the next page is asked for (a mock without the timesheet list ran to
 *  349,000 calls). So once the first five records in a row fail with nothing come back — which one bad
 *  record cannot cause — the page's error is thrown instead. */
export async function* zuperFilterPages(cfg: SyncConfig, path: string, pageSize = 100, extra: Record<string, unknown> = {}): AsyncGenerator<any[]> {
  for (let page = 1; ; page++) {
    let rows: any[], more: boolean;
    try {
      rows = await filterPage(cfg, path, page, pageSize, extra);
      more = rows.length === pageSize;
    } catch (pageErr) {
      rows = []; more = true;
      let failedToo = 0;
      const offset = (page - 1) * pageSize; // with limit 1, page n is record n
      for (let i = 1; i <= pageSize; i++) {
        try {
          const one = await filterPage(cfg, path, offset + i, 1, extra);
          if (!one.length) { more = false; break; } // past the end of the list
          rows.push(...one);
        } catch (recErr) {
          failedToo++;
          if (!rows.length && failedToo >= 5) throw pageErr;
          console.log(`  Zuper ${path}: skipped record #${offset + i} (${recErr instanceof Error ? recErr.message : recErr}) after page ${page} failed (${pageErr instanceof Error ? pageErr.message : pageErr})`);
        }
      }
    }
    if (rows.length) yield rows;
    if (!more) return;
  }
}
async function zuperFilterAll(cfg: SyncConfig, path: string, pageSize = 100, cap = 100000): Promise<any[]> {
  const out: any[] = [];
  for await (const rows of zuperFilterPages(cfg, path, pageSize)) { out.push(...rows); if (out.length >= cap) break; }
  return out;
}
/** Page through a GET list (`?page=&count=`). Some lists cap the page below `count` (users: 10), so
 *  stop on total_records, an empty page, or a page that repeats the previous one. */
async function* zuperListPages(cfg: SyncConfig, path: string, pageSize = 100): AsyncGenerator<any[]> {
  let got = 0, last = "";
  for (let page = 1; page <= 5000; page++) {
    const j = await zuperGet(cfg, `${path}${path.includes("?") ? "&" : "?"}page=${page}&count=${pageSize}`);
    const rows: any[] = j.data ?? [];
    const sig = JSON.stringify(rows[0] ?? null);
    if (!rows.length || sig === last) return;
    last = sig; got += rows.length;
    yield rows;
    const total = Number(j.total_records);
    if (Number.isFinite(total) && got >= total) return;
  }
}

// ── Map + run helpers ──
export type Ctx = { client: SupabaseClient; tenantId: string; cfg: SyncConfig; maps: Record<string, Map<string, string>>; extra: Record<string, any> };
/**
 * Every uid this sync has mapped for an entity.
 *
 * ORDERED, because the pages are LIMIT/OFFSET and Postgres promises nothing about the order of an unordered read: two
 * pages of one query can return the same row and miss another. Without the order this returned 2,265 assets on two
 * runs and 1,712 on the next four — 553 records read as "not imported" when every one of them was (2026-09-21). The
 * map is what the importer uses to decide whether a record is new, so a short map means writing a second copy of a
 * record Tuper already has.
 *
 * An error is not silently a short map either: the caller gets the failure rather than a map missing whatever the
 * failed page held.
 */
export async function loadMap(client: SupabaseClient, tenantId: string, entity: string): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client.schema("jms").from("zuper_sync_map").select("zuper_uid, jms_id")
      .eq("tenant_id", tenantId).eq("entity", entity).order("zuper_uid", { ascending: true }).range(from, from + 999);
    if (error) throw error;
    for (const r of (data ?? []) as any[]) m.set(r.zuper_uid, r.jms_id);
    if (!data || data.length < 1000) break;
  }
  return m;
}
async function ctxMap(ctx: Ctx, entity: string): Promise<Map<string, string>> {
  if (!ctx.maps[entity]) ctx.maps[entity] = await loadMap(ctx.client, ctx.tenantId, entity);
  return ctx.maps[entity];
}
async function setMap(ctx: Ctx, entity: string, uid: string, jmsId: string): Promise<void> {
  (await ctxMap(ctx, entity)).set(uid, jmsId);
  await ctx.client.schema("jms").from("zuper_sync_map").upsert({ tenant_id: ctx.tenantId, entity, zuper_uid: uid, jms_id: jmsId, synced_at: new Date().toISOString() }, { onConflict: "tenant_id,entity,zuper_uid" });
}
const mapGet = (m: Map<string, string>, key: unknown): string | null => (key ? m.get(String(key)) ?? null : null);
/** The map rows for just these uids - complete for them, so an absent uid really is unmapped. */
async function mapForUids(ctx: Ctx, entity: string, uids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const list = [...new Set(uids.filter((u): u is string => Boolean(u)))];
  for (let i = 0; i < list.length; i += 100) {
    const { data, error } = await ctx.client.schema("jms").from("zuper_sync_map").select("zuper_uid, jms_id")
      .eq("tenant_id", ctx.tenantId).eq("entity", entity).in("zuper_uid", list.slice(i, i + 100));
    if (error) throw error;
    for (const m of (data ?? []) as { zuper_uid: string; jms_id: string }[]) out.set(m.zuper_uid, m.jms_id);
  }
  return out;
}
/** One in-flight create per key, so rows processed side by side never create the same record twice. */
function once(ctx: Ctx, key: string, make: () => Promise<string | null>): Promise<string | null> {
  const inflight: Map<string, Promise<string | null>> = (ctx.extra.inflight ??= new Map());
  let p = inflight.get(key);
  if (!p) { p = make(); inflight.set(key, p); }
  return p;
}
async function inChunks<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += n) await Promise.all(items.slice(i, i + n).map(fn));
}

// ── Entity registry ──
interface Entity {
  name: string; schema: string; table: string;
  /** Maps loaded before any row, so rows processed side by side never race to load them. */
  deps?: string[];
  /** Rows processed at once (default 1). */
  concurrency?: number;
  /** Use (and extend) another entity's map — a second pass over the same records. */
  mapEntity?: string;
  /** Only update rows already in the map; never insert (enrichment passes). */
  enrichOnly?: boolean;
  fetch?(ctx: Ctx): Promise<any[]>;
  /** Paged alternative to fetch — rows arrive a page at a time and afterAll gets none. */
  pages?(ctx: Ctx): AsyncGenerator<any[]>;
  uid(r: any): string; transform(r: any, ctx: Ctx): Promise<Record<string, unknown> | null>;
  /** Replaces the plain insert (users need an auth account first); returns the new jms id. */
  insert?(ctx: Ctx, payload: Record<string, unknown>, r: any): Promise<string>;
  /** Child rows of one upserted record: addresses, assignments, status history, line items. */
  afterWrite?(ctx: Ctx, id: string, r: any, isNew: boolean): Promise<void>;
  /** Runs once every row has been upserted — for links between rows of the same entity. */
  afterAll?(ctx: Ctx, rows: any[]): Promise<void>;
}

const N = (v: any) => (v == null || v === "" ? null : Number(v));
const S = (v: any) => (v == null ? null : String(v));
/** Trimmed text, or null when empty. */
const T = (v: any): string | null => { const t = v == null ? "" : String(v).trim(); return t || null; };
const num0 = (v: any) => Number(v) || 0;
const r2 = (n: number) => Math.round(n * 100) / 100;
const ts = (v: any): string | null => (v ? String(v) : null);
/** An instant's calendar date in the tenant's zone — Zuper keeps dates as local-midnight instants. */
const dubaiDate = (v: any): string | null => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toLocaleDateString("en-CA", { timeZone: "Asia/Dubai" });
};
const stripHtml = (v: any): string | null => T(String(v ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " "));
const createdAt = (r: any) => (r?.created_at ? { created_at: String(r.created_at) } : {});

// ── Job statuses + their checklists ──
const JOB_STATUS_TYPES = new Set(["NEW", "SCHEDULED", "ON_MY_WAY", "STARTED", "ON_HOLD", "COMPLETED", "CANNOT_COMPLETE", "CANCELED", "FAILED", "PAID", "CLOSED", "FOLLOW_UP", "FOLLOW_UP_SAME_JOB", "OTHER"]);
// Zuper checklist field types → jms.form_field_type.
const CHECKLIST_FIELD_TYPES: Record<string, string> = {
  RADIO: "SINGLE_SELECTION", SINGLE_ITEM: "DROPDOWN", MULTI_ITEM: "MULTI_SELECTION",
  SINGLE_LINE: "SINGLE_LINE_TEXT", MULTI_LINE: "MULTI_LINE_TEXT", HEADER: "SECTION_HEADER",
  DATE: "DATE", DATETIME: "DATE_TIME", TIME: "TIME", SIGNATURE: "SIGNATURE", BARCODE: "BARCODE_SCAN",
  IMAGE: "SINGLE_IMAGE", MULTI_IMAGE: "MULTI_IMAGE", FILE: "UPLOAD", VIDEO: "VIDEO",
};
const OPTION_TYPES = new Set(["SINGLE_SELECTION", "MULTI_SELECTION", "DROPDOWN"]);
/** Zuper's Validation on a text question → Tuper's (checklist-validation.ts). */
const ZUPER_VALIDATIONS: Record<string, string> = { number: "number", email: "email", phonenumber: "phone", address: "address", regex: "regex" };
const slugKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
/** Zuper fills an unused description/placeholder with the template's literal filler — treat that as empty. */
const realText = (v: unknown, filler: RegExp) => { const t = String(v ?? "").trim(); return !t || filler.test(t) ? null : t; };
/** Stable JSON (object keys sorted) — jsonb hands keys back in its own order. */
const canon = (v: unknown) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/** One Zuper status's checklist items → checklist fields, conditions resolved to field keys. */
export function checklistFields(items: any[]): ChecklistFieldInput[] {
  const names = items.map((f) => String(f.field_name ?? "").trim());
  const used = new Set<string>();
  const keys = names.map((n, i) => {
    const base = slugKey(n) || `q${i + 1}`;
    let k = base;
    for (let x = 2; used.has(k); x++) k = `${base}_${x}`;
    used.add(k);
    return k;
  });
  const keySet = new Set(keys);
  return items.map((f, i) => {
    const field_type = CHECKLIST_FIELD_TYPES[String(f.field_type)] ?? "SINGLE_LINE_TEXT";
    const config: Record<string, unknown> = {};
    if (f.is_dependent && f.dependent_on) {
      // Zuper names the parent question by its label, and labels repeat — take the nearest earlier one.
      const on = String(f.dependent_on).trim();
      let p = -1;
      for (let j = i - 1; j >= 0 && p < 0; j--) if (names[j] === on) p = j;
      if (p < 0) p = names.findIndex((n, j) => j !== i && n === on);
      if (p >= 0) { config.depends_on = keys[p]; config.show_when = (f.dependent_options ?? []).map((o: unknown) => String(o).trim()).filter(Boolean); }
    }
    // The question's other settings in Zuper, kept where its builder offers them on the type (checklist-field-settings.ts):
    // Mark as Read Only / hidden field / Hide to FE, Choose first option by default, Time Interval, Restrict to Camera,
    // Restricted Status Update, Validation, and a picture's Stamp Date & Time and Stamp GPS Coordinates. Associate Tags and
    // Albums (tag_uids, company_default_folder) aren't carried: GBG has no Gallery tags or albums in Zuper.
    const meta = f.meta_options ?? {};
    if (f.read_only === true) config.read_only = true;
    if (f.hide_field === true) config.hidden = true;
    if (f.hide_to_fe === true) config.hide_to_fe = true;
    if (f.default_option === true) config.default_option = true;
    if (f.field_meta?.time_interval != null) config.time_interval = Number(f.field_meta.time_interval);
    if (meta.restrict_to_camera === true) config.restrict_to_camera = true;
    if (meta.watermark_timestamp === true) config.stamp_date_time = true;
    if (meta.watermark_geo_cords === true) config.stamp_gps = true;
    if (meta.restrict_status_update?.is_enabled === true) {
      const r = meta.restrict_status_update;
      config.restrict_status_update = { is_enabled: true, restricted_options: r.restricted_options ?? [], message: r.message ?? null };
    }
    const validation = ZUPER_VALIDATIONS[String(f.field_validation ?? "")];
    if (validation) {
      config.validation = validation;
      if (validation === "regex") config.regex_value = f.regex_value;
      if (validation === "number") {
        if (typeof f.min_value === "number") config.min_value = f.min_value;
        if (typeof f.max_value === "number") config.max_value = f.max_value;
      }
    }
    const options: { label: string; value: string }[] = [];
    if (OPTION_TYPES.has(field_type)) {
      const seen = new Set<string>();
      for (const raw of f.field_options ?? []) {
        const o = String(raw).trim();
        if (o && !seen.has(o)) { seen.add(o); options.push({ label: o, value: o }); }
      }
    }
    return {
      field_key: keys[i], label: names[i] || `Question ${i + 1}`, field_type,
      // A header is a section title, not a question — nothing to answer, so never required.
      is_required: field_type !== "SECTION_HEADER" && f.is_required === true,
      help_text: realText(f.field_description, /^description$/i),
      placeholder: realText(f.field_placeholder, /^placeholder$/i),
      options, config: checklistFieldConfig(config, field_type, keySet, keys[i]),
    };
  });
}

/** Whether the checklist already holds exactly these questions (so a re-sync leaves answers alone). */
async function fieldsUnchanged(ctx: Ctx, formId: string, fields: ChecklistFieldInput[]): Promise<boolean> {
  const { data, error } = await ctx.client.schema("jms").from("form_fields")
    .select("field_key, label, field_type, is_required, help_text, config, form_field_options(value, display_order)")
    .eq("tenant_id", ctx.tenantId).eq("form_id", formId).order("display_order", { ascending: true });
  if (error) throw error;
  const sig = (f: { field_key?: string; label: string; field_type: string; is_required?: boolean; help_text?: string | null; config?: unknown }, values: string[]) =>
    canon([f.field_key, f.label, f.field_type, Boolean(f.is_required), f.help_text ?? null, f.config ?? {}, values]);
  const have = ((data ?? []) as any[]).map((f) => sig(f, [...(f.form_field_options ?? [])].sort((a: any, b: any) => a.display_order - b.display_order).map((o: any) => o.value)));
  const want = fields.map((f) => sig(f, (f.options ?? []).map((o) => o.value)));
  return have.length === want.length && have.every((h, i) => h === want[i]);
}

/** Create/refresh the checklist behind one Zuper status; returns the jms.forms id to bind (or null). */
async function syncStatusChecklist(ctx: Ctx, r: any): Promise<string | null> {
  const items: any[] = (r.checklist ?? []).filter((f: any) => !f.is_deleted);
  if (items.length === 0) return null; // no checklist in Zuper → unbound (a form imported earlier stays in the builder)
  const fields = checklistFields(items);
  const forms = () => ctx.client.schema("jms").from("forms");
  const name = `${r._category_name} – ${String(r.status_name ?? "").trim()}`;
  let formId = (await ctxMap(ctx, "job_status_checklists")).get(r.status_uid) ?? null;
  if (formId) {
    const { error } = await forms().update({ name, is_deleted: false, deleted_at: null }).eq("id", formId).eq("tenant_id", ctx.tenantId);
    if (error) throw error;
  } else {
    const { data, error } = await forms().insert({ tenant_id: ctx.tenantId, form_kind: "CHECKLIST", name, description: "Imported from Zuper" }).select("id").single();
    if (error) throw error;
    formId = (data as { id: string }).id;
    await setMap(ctx, "job_status_checklists", r.status_uid, formId);
  }
  if (!(await fieldsUnchanged(ctx, formId, fields))) await saveChecklistFields(ctx.client, ctx.tenantId, formId, fields);
  return formId;
}

// ── Shared history-import pieces ──

/** Zuper address → the jms address shape (jobs keep it as JSON; other parents get jms.addresses rows). */
function zAddress(a: any): Record<string, unknown> | null {
  if (!a || typeof a !== "object") return null;
  const g: number[] = Array.isArray(a.geo_cordinates) ? a.geo_cordinates.map(Number) : [];
  const geo = g.length === 2 && g.every((x) => Number.isFinite(x)) && (g[0] !== 0 || g[1] !== 0); // [lat, lng]; 0,0 = unset
  const out = {
    street: T(a.street), landmark: T(a.landmark), city: T(a.city), state: T(a.state), country: T(a.country), zip_code: T(a.zip_code),
    latitude: geo ? g[0] : null, longitude: geo ? g[1] : null,
    contact_first_name: T(a.first_name), contact_last_name: T(a.last_name), contact_email: T(a.email), contact_phone: T(a.phone_number),
  };
  return [out.street, out.landmark, out.city, out.state, out.country, out.zip_code].some(Boolean) ? out : null;
}
/** Replace a parent's SERVICE/BILLING rows in jms.addresses. */
/**
 * Who is on a team. Zuper sends the whole membership on every team row, so the list is replaced rather than merged —
 * that is what makes someone leaving a team reach Tuper at all. A member Tuper has never heard of is skipped, not
 * invented: only staff the users sync brought over can be on a team.
 */
async function writeTeamMembers(ctx: Ctx, teamId: string, row: any): Promise<void> {
  const r = row?.team ?? row;                       // flat from the list, wrapped from the by-uid read
  const members = Array.isArray(r?.users) ? r.users : [];
  const users = await ctxMap(ctx, "users");
  const seen = new Set<string>();
  const rows: { tenant_id: string; team_id: string; user_id: string }[] = [];
  for (const u of members) {
    const id = mapGet(users, u?.user_uid);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({ tenant_id: ctx.tenantId, team_id: teamId, user_id: id });
  }
  const table = () => ctx.client.schema("jms").from("team_members");
  const { error: gone } = await table().delete().eq("tenant_id", ctx.tenantId).eq("team_id", teamId);
  if (gone) throw gone;
  if (rows.length) { const { error } = await table().insert(rows); if (error) throw error; }
}

async function writeAddresses(ctx: Ctx, parentType: string, parentId: string, isNew: boolean, service: any, billing: any): Promise<void> {
  const addresses = () => ctx.client.schema("jms").from("addresses");
  if (!isNew) {
    const { error } = await addresses().delete().eq("tenant_id", ctx.tenantId).eq("parent_type", parentType).eq("parent_id", parentId);
    if (error) throw error;
  }
  const rows = ([["SERVICE", zAddress(service)], ["BILLING", zAddress(billing)]] as const)
    .filter(([, a]) => a).map(([kind, a]) => ({ tenant_id: ctx.tenantId, parent_type: parentType, parent_id: parentId, address_kind: kind, ...(a as Record<string, unknown>) }));
  if (rows.length) { const { error } = await addresses().insert(rows); if (error) throw error; }
}

// ── Properties ──
// Zuper sends a property's customers, its assignees and its tags WHOLE on the record, so each list is replaced
// rather than merged — that is what makes `property.unassign_users`, a customer taken off a property, or a tag
// removed reach Tuper at all. Only a key the record actually carries is replaced: the list at /api/property leaves
// several of them out, and an absent key means "not told", not "empty".

/** The customer uids on a property. Zuper wraps each one (`property_customers: [{ customer: {…} }]`). */
function propertyCustomerUids(r: any): string[] {
  const list: any[] = Array.isArray(r?.property_customers) ? r.property_customers : [];
  const uids = list.map((c) => T(c?.customer?.customer_uid ?? c?.customer_uid)).filter((u): u is string => Boolean(u));
  return [...new Set(uids)];
}

/** A property's customers → jms.property_customers. properties.customer_id keeps the first (migration 00125). */
async function writePropertyCustomers(ctx: Ctx, propertyId: string, r: any): Promise<void> {
  const customers = await ctxMap(ctx, "customers");
  const ids = [...new Set(propertyCustomerUids(r).map((u) => mapGet(customers, u)).filter((id): id is string => Boolean(id)))];
  const tbl = () => ctx.client.schema("jms").from("property_customers");
  const { error: gone } = await tbl().delete().eq("tenant_id", ctx.tenantId).eq("property_id", propertyId);
  if (gone) throw gone;
  if (ids.length) {
    const { error } = await tbl().insert(ids.map((customer_id) => ({ tenant_id: ctx.tenantId, property_id: propertyId, customer_id })));
    if (error) throw error;
  }
}

/** Who a property is assigned to → jms.property_assignees ({user, team} pairs; a pair naming neither is dropped,
 *  and a person or team Tuper has never heard of is skipped rather than invented). */
async function writePropertyAssignees(ctx: Ctx, propertyId: string, r: any): Promise<void> {
  const users = await ctxMap(ctx, "users"), teams = await ctxMap(ctx, "teams");
  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  for (const a of (Array.isArray(r?.assigned_to) ? r.assigned_to : []) as any[]) {
    const user_id = mapGet(users, a?.user?.user_uid ?? a?.user_uid);
    const team_id = mapGet(teams, a?.team?.team_uid ?? a?.team_uid);
    if (!user_id && !team_id) continue;                       // property_assignees_someone_ck
    const key = `${user_id ?? ""}|${team_id ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ tenant_id: ctx.tenantId, property_id: propertyId, user_id, team_id });
  }
  const tbl = () => ctx.client.schema("jms").from("property_assignees");
  const { error: gone } = await tbl().delete().eq("tenant_id", ctx.tenantId).eq("property_id", propertyId);
  if (gone) throw gone;
  if (rows.length) { const { error } = await tbl().insert(rows); if (error) throw error; }
}

/** Everything that hangs off one property: its address, its customers, its assignees, its tags, its custom-field
 *  values and its files. The address goes to jms.addresses, which the property screens read first. */
async function writePropertyParts(ctx: Ctx, id: string, r: any, isNew: boolean): Promise<void> {
  await writeAddresses(ctx, "PROPERTY", id, isNew, r.property_address, null);
  if ("property_customers" in r) await writePropertyCustomers(ctx, id, r);
  if ("assigned_to" in r) await writePropertyAssignees(ctx, id, r);
  if ("property_tags" in r) {
    const names = (Array.isArray(r.property_tags) ? r.property_tags : [])
      .map((t: any) => T(typeof t === "string" ? t : t?.tag_name ?? t?.name))
      .filter((n: string | null): n is string => Boolean(n));
    await setEntityTags(ctx.client, ctx.tenantId, "PROPERTY", id, names);
  }
  if (Array.isArray(r.custom_fields) && r.custom_fields.length) {
    await ensureCustomFieldDefinitions(ctx, "PROPERTY", r.custom_fields.map((f: any) => String(f?.label ?? "")));
    await writeCustomFieldValues(ctx, "PROPERTY", id, r.custom_fields);
  }
  // Only when Zuper sent some: the files map is the big one (361k rows), and there is nothing to match without them.
  if (Array.isArray(r.attachments) && r.attachments.length) await writeZuperFiles(ctx, { type: "property", id }, r.attachments);
}

/** A property whose parent was imported after it — resolved once every property of the run has an id. */
async function linkParentProperties(ctx: Ctx, rows: any[]): Promise<void> {
  const map = await ctxMap(ctx, "properties");
  for (const r of rows) {
    const parentUid = T(r?.parent_property?.property_uid);
    const id = mapGet(map, r?.property_uid), parentId = parentUid ? mapGet(map, parentUid) : null;
    if (!id || !parentId) continue;
    const { error } = await ctx.client.schema("jms").from("properties")
      .update({ parent_property_id: parentId }).eq("id", id).eq("tenant_id", ctx.tenantId).is("parent_property_id", null);
    if (error) throw error;
  }
}

export function customerFields(r: any): Record<string, unknown> {
  const first = T(r.customer_first_name), company = T(r.customer_company_name), email = T(r.customer_email);
  const cn = r.customer_contact_no ?? {}, acc = r.accounts ?? {};
  return {
    first_name: first ?? company ?? email ?? "Customer", last_name: T(r.customer_last_name), company_name: company, email,
    additional_emails: ((r.additional_emails ?? []) as unknown[]).map((e) => T(e)).filter(Boolean),
    contact_no: { mobile: T(cn.mobile), home: T(cn.home), work: T(cn.work) },
    accounts: { tax: null, ltv: num0(acc.ltv), receivables: num0(acc.receivables), credits: num0(acc.credits) },
    is_portal_enabled: r.is_portal_enabled === true, has_card_on_file: r.has_card_on_file === true, tax_exempt: r.tax?.tax_exempt === true,
    has_sla: r.has_sla === true, do_not_service: r.do_not_service === true,
    is_active: r.is_active !== false, is_deleted: r.is_deleted === true, ...createdAt(r),
  };
}
function organizationFields(r: any): Record<string, unknown> {
  return {
    name: T(r.organization_name) ?? "Organization", email: T(r.organization_email),
    description: T(r.plain_text_description) ?? stripHtml(r.organization_description), plain_text_description: T(r.plain_text_description),
    tax_exempt: r.tax?.tax_exempt === true, is_active: r.is_active !== false, is_deleted: r.is_deleted === true, ...createdAt(r),
  };
}
/** The jms customer for an embedded Zuper customer — created on the spot when the customer list lacks
 *  it (Zuper leaves deleted customers out of the list, but old jobs still point at them). */
async function customerId(ctx: Ctx, c: any): Promise<string | null> {
  const uid = c?.customer_uid;
  if (!uid) return null;
  const have = (await ctxMap(ctx, "customers")).get(uid);
  if (have) return have;
  return once(ctx, `customers:${uid}`, async () => {
    const { data, error } = await ctx.client.schema("jms").from("customers").insert({ tenant_id: ctx.tenantId, ...customerFields(c) }).select("id").single();
    if (error) throw error;
    await setMap(ctx, "customers", uid, (data as { id: string }).id);
    return (data as { id: string }).id;
  });
}
async function organizationId(ctx: Ctx, o: any): Promise<string | null> {
  const uid = o?.organization_uid;
  if (!uid) return null;
  const have = (await ctxMap(ctx, "organizations")).get(uid);
  if (have) return have;
  return once(ctx, `organizations:${uid}`, async () => {
    const { data, error } = await ctx.client.schema("jms").from("organizations").insert({ tenant_id: ctx.tenantId, ...organizationFields(o) }).select("id").single();
    if (error) throw error;
    await setMap(ctx, "organizations", uid, (data as { id: string }).id);
    return (data as { id: string }).id;
  });
}
/** The jms category for a job's embedded Zuper category. Zuper's category list only returns current
 *  categories, but old jobs sit in retired ones (Repairs, Flat Tyre, AMC Silver, Bodyshop …), so a
 *  missing one is created on the spot — inactive, since Zuper no longer offers it. */
async function jobCategoryId(ctx: Ctx, c: any): Promise<string | null> {
  const uid = c?.category_uid;
  if (!uid) return null;
  const have = (await ctxMap(ctx, "job_categories")).get(uid);
  if (have) return have;
  return once(ctx, `job_categories:${uid}`, async () => {
    const d = c.estimated_duration ?? {};
    const mins = (Number(d.days) || 0) * 1440 + (Number(d.hours) || 0) * 60 + (Number(d.minutes) || 0);
    const name = (T(c.category_name) ?? "Category").slice(0, 26); // job_categories_name_len
    const cats = () => ctx.client.schema("jms").from("job_categories");
    let res = await cats()
      .insert({ tenant_id: ctx.tenantId, name, color: T(c.category_color), display_order: 999, estimated_duration_minutes: mins || null, is_active: false })
      .select("id").single();
    // Names are unique per tenant: a retired category named like a current one is that category.
    if (res.error?.code === "23505") res = await cats().select("id").eq("tenant_id", ctx.tenantId).eq("name", name).single();
    if (res.error) throw res.error;
    await setMap(ctx, "job_categories", uid, (res.data as { id: string }).id);
    return (res.data as { id: string }).id;
  });
}
/** The jms status for an embedded Zuper status (a job's current status or a history entry) — created
 *  on the spot in the job's category when the status workflow import didn't include it. Such a status is one Zuper
 *  has taken out of the category: it's kept for the jobs and history that use it but not offered as a next status
 *  (inactive), until a workflow import finds it in the category again. */
async function jobStatusId(ctx: Ctx, s: any, categoryId: string | null): Promise<string | null> {
  const uid = s?.status_uid;
  if (!uid) return null;
  const have = (await ctxMap(ctx, "job_statuses")).get(uid);
  if (have) return have;
  if (!categoryId) return null;
  return once(ctx, `job_statuses:${uid}`, async () => {
    const type = String(s.status_type ?? "");
    const name = T(s.status_name) ?? "Status";
    const statuses = () => ctx.client.schema("jms").from("job_statuses");
    let res = await statuses()
      .insert({ tenant_id: ctx.tenantId, category_id: categoryId, name, status_type: JOB_STATUS_TYPES.has(type) ? type : "OTHER", color: T(s.status_color), display_order: 999, is_active: false })
      .select("id").single();
    // A same-named status already in the category (an older Zuper status id) is that status.
    if (res.error?.code === "23505") res = await statuses().select("id").eq("tenant_id", ctx.tenantId).eq("category_id", categoryId).eq("name", name).limit(1).single();
    if (res.error) throw res.error;
    await setMap(ctx, "job_statuses", uid, (res.data as { id: string }).id);
    return (res.data as { id: string }).id;
  });
}
/** A Zuper team embedded on a job → jms.teams, created on the spot (a same-named team is that team). */
async function teamId(ctx: Ctx, t: any): Promise<string | null> {
  const uid = t?.team_uid, name = T(t?.team_name);
  if (!uid || !name) return null;
  const have = (await ctxMap(ctx, "teams")).get(uid);
  if (have) return have;
  return once(ctx, `teams:${uid}`, async () => {
    const teams = () => ctx.client.schema("jms").from("teams");
    let res = await teams().insert({ tenant_id: ctx.tenantId, name, color: T(t.team_color), is_active: t.is_active !== false, is_deleted: t.is_deleted === true }).select("id").single();
    if (res.error?.code === "23505") res = await teams().select("id").eq("tenant_id", ctx.tenantId).eq("name", name).limit(1).single();
    if (res.error) throw res.error;
    await setMap(ctx, "teams", uid, (res.data as { id: string }).id);
    return (res.data as { id: string }).id;
  });
}
/** A Zuper service territory → jms.service_territories (names are unique per tenant). */
async function territoryId(ctx: Ctx, st: any): Promise<string | null> {
  const t = st?.territory, uid = t?.territory_uid, name = T(t?.territory_name);
  if (!uid || !name) return null;
  const have = (await ctxMap(ctx, "service_territories")).get(uid);
  if (have) return have;
  return once(ctx, `service_territories:${uid}`, async () => {
    const rows = () => ctx.client.schema("jms").from("service_territories");
    let res = await rows().insert({ tenant_id: ctx.tenantId, name, is_active: t.is_active !== false && t.is_deleted !== true }).select("id").single();
    if (res.error?.code === "23505") res = await rows().select("id").eq("tenant_id", ctx.tenantId).eq("name", name).single();
    if (res.error) throw res.error;
    await setMap(ctx, "service_territories", uid, (res.data as { id: string }).id);
    return (res.data as { id: string }).id;
  });
}
/** The job's teams (jms.job_team_assignments) and each assignee's team membership (jms.team_members) —
 *  Zuper assigns a user through a team, which is how its report prints "Name (Team)". */
async function writeJobTeams(ctx: Ctx, jobId: string, r: any, isNew: boolean): Promise<void> {
  const teamIds = new Set<string>();
  for (const a of r.assigned_to_team ?? []) { const id = await teamId(ctx, a.team); if (id) teamIds.add(id); }
  const tbl = () => ctx.client.schema("jms").from("job_team_assignments");
  if (!isNew) { const { error } = await tbl().delete().eq("tenant_id", ctx.tenantId).eq("job_id", jobId); if (error) throw error; }
  if (teamIds.size) { const { error } = await tbl().insert([...teamIds].map((team_id) => ({ tenant_id: ctx.tenantId, job_id: jobId, team_id }))); if (error) throw error; }
  const members: Set<string> = await (ctx.extra.memberships ??= (async () => {
    const { data, error } = await ctx.client.schema("jms").from("team_members").select("team_id, user_id").eq("tenant_id", ctx.tenantId);
    if (error) throw error;
    return new Set(((data ?? []) as { team_id: string; user_id: string }[]).map((m) => `${m.team_id}:${m.user_id}`));
  })());
  const users = await ctxMap(ctx, "users");
  for (const a of r.assigned_to ?? []) {
    const userId = mapGet(users, a.user?.user_uid), tId = await teamId(ctx, a.team);
    if (!userId || !tId || members.has(`${tId}:${userId}`)) continue;
    members.add(`${tId}:${userId}`);
    const { error } = await ctx.client.schema("jms").from("team_members").insert({ tenant_id: ctx.tenantId, team_id: tId, user_id: userId });
    if (error && error.code !== "23505") throw error;
  }
}
/** Zuper job tags → jms.taggables (only when Zuper has some, so tags added in Tuper aren't wiped). */
async function writeJobTags(ctx: Ctx, jobId: string, tags: unknown): Promise<void> {
  const names = Array.isArray(tags) ? tags.map((t) => T(t)).filter((t): t is string => Boolean(t)) : [];
  if (names.length) await setEntityTags(ctx.client, ctx.tenantId, "JOB", jobId, names);
}
async function assetCategoryId(ctx: Ctx, c: any): Promise<string | null> {
  const uid = c?.category_uid, name = T(c?.category_name);
  if (!uid || !name) return null;
  const have = (await ctxMap(ctx, "asset_categories")).get(uid);
  if (have) return have;
  return once(ctx, `asset_categories:${uid}`, async () => {
    const { data, error } = await ctx.client.schema("jms").from("asset_categories").insert({ tenant_id: ctx.tenantId, name, is_active: c.is_deleted !== true }).select("id").single();
    if (error) throw error;
    await setMap(ctx, "asset_categories", uid, (data as { id: string }).id);
    return (data as { id: string }).id;
  });
}

/** A Zuper user → auth + core + jms rows sharing one id (the provisionUser chain), but with no password
 *  and no invite: the account exists so history links to it, and nobody signs in until invited. A user
 *  already in Tuper with the same email is linked, not duplicated. */
/** `inactive` (Zuper's inactive staff, imported 2026-09-15 so their records keep their names): the sign-in is blocked,
 *  core.users is inactive, and jms.users is marked removed, so no picker or list offers them. */
async function provisionImportedUser(ctx: Ctx, payload: Record<string, unknown>, r: any, opts: { inactive?: boolean } = {}): Promise<string> {
  const email = String(r.email).trim().toLowerCase();
  if (!ctx.extra.coreUsers) {
    const { data, error } = await ctx.client.schema("core").from("users").select("id, email").eq("tenant_id", ctx.tenantId);
    if (error) throw error;
    ctx.extra.coreUsers = new Map(((data ?? []) as { id: string; email: string }[]).map((u) => [String(u.email).toLowerCase(), u.id]));
  }
  const fullName = [payload.first_name, payload.last_name].filter(Boolean).join(" ") || email;
  let id: string | null = (ctx.extra.coreUsers as Map<string, string>).get(email) ?? null;
  const linked = Boolean(id);
  if (id) {
    await ctx.client.schema("core").from("users").update({ zuper_user_id: r.user_uid }).eq("id", id);
    const { data: profile } = await ctx.client.schema("jms").from("users").select("id").eq("id", id).maybeSingle();
    if (profile) return id; // keep their existing Tuper profile
  } else {
    const { data: created, error } = await ctx.client.auth.admin.createUser({
      email, email_confirm: true, user_metadata: { full_name: fullName, imported_from: "zuper" }, ...(opts.inactive ? { ban_duration: "876000h" } : {}),
    });
    if (error || !created?.user) throw new Error(`login for ${email}: ${error?.message ?? "not created"}`);
    id = created.user.id;
    const { error: coreErr } = await ctx.client.schema("core").from("users").insert({ id, tenant_id: ctx.tenantId, full_name: fullName, email, phone: payload.mobile_phone ?? null, is_active: !opts.inactive, zuper_user_id: r.user_uid });
    if (coreErr) { await ctx.client.auth.admin.deleteUser(id).catch(() => {}); throw coreErr; }
  }
  const users = () => ctx.client.schema("jms").from("users");
  const gone = opts.inactive ? { is_deleted: true, deleted_at: new Date().toISOString() } : {};
  let ins = await users().insert({ ...payload, ...gone, id, tenant_id: ctx.tenantId });
  if (ins.error?.code === "23505" && payload.emp_code) ins = await users().insert({ ...payload, ...gone, emp_code: null, id, tenant_id: ctx.tenantId }); // emp code taken
  if (ins.error) {
    if (!linked) {
      try { await ctx.client.schema("core").from("users").delete().eq("id", id); } catch { /* best effort */ }
      await ctx.client.auth.admin.deleteUser(id).catch(() => {});
    }
    throw ins.error;
  }
  return id;
}

/** Assigned users (those Tuper has; inactive staff are imported too since 2026-09-15) → jms.job_assignments. */
async function writeJobAssignments(ctx: Ctx, jobId: string, r: any, isNew: boolean): Promise<void> {
  const users = await ctxMap(ctx, "users");
  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  for (const a of r.assigned_to ?? []) {
    const userId = mapGet(users, a.user?.user_uid);
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    rows.push({ tenant_id: ctx.tenantId, job_id: jobId, user_id: userId, is_primary: a.is_primary === true, accepted_at: a.is_accepted ? ts(a.assigned_at) : null });
  }
  const tbl = () => ctx.client.schema("jms").from("job_assignments");
  if (!isNew) { const { error } = await tbl().delete().eq("tenant_id", ctx.tenantId).eq("job_id", jobId); if (error) throw error; }
  if (rows.length) { const { error } = await tbl().insert(rows); if (error) throw error; }
}
/** "#AA7942" as Zuper sends it, or null when it isn't a six-digit colour (the status's own colour is used then). */
export const hexColor = (v: unknown): string | null => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim().toLowerCase() : null);
/** Zuper's status timeline → jms.job_status_history, oldest first, each row's from = the previous to. */
async function writeJobHistory(ctx: Ctx, jobId: string, r: any, isNew: boolean): Promise<void> {
  const entries = [...(r.job_status ?? [])].sort((a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at)));
  const rows: Record<string, unknown>[] = [];
  let prev: string | null = null;
  for (const s of entries) {
    const to = await jobStatusId(ctx, s, s.category?.category_uid ? await jobCategoryId(ctx, s.category) : r._category_id ?? null);
    if (!to) continue;
    // Zuper keeps the preset remark and the free text apart (migration 00065); done_by is who moved it.
    const by = s.done_by?.user_uid ?? (typeof s.done_by === "string" ? s.done_by : null);
    // The checklist answered on this change, when it has one (writeChecklistResponse, below).
    const response = (s.checklist ?? []).length ? await writeChecklistResponse(ctx, jobId, to, s) : null;
    rows.push({
      tenant_id: ctx.tenantId, job_id: jobId, from_status_id: prev, to_status_id: to, status_color: hexColor(s.status_color),
      remarks: T(s.remarks), remarks_free_text: T(s.remarks_free_text), changed_by: mapGet(await ctxMap(ctx, "users"), by), ...createdAt(s),
      // The customer's signature taken at this change (Zuper's link to the picture) and who signed. Job cards print it
      // from the status: 13 of GBG's 19 read {{customer_signature}} inside "Completed".
      signature_path: T(s.customer_signature), signer_name: T(s.customer_signature_name),
      ...(response ? { form_response_id: response } : {}),
    });
    prev = to;
  }
  const tbl = () => ctx.client.schema("jms").from("job_status_history");
  if (!isNew) { const { error } = await tbl().delete().eq("tenant_id", ctx.tenantId).eq("job_id", jobId); if (error) throw error; }
  if (rows.length) { const { error } = await tbl().insert(rows); if (error) throw error; }
}
/** A document's Zuper line items → jms.line_items (products linked through the products map). */
async function writeLineItems(ctx: Ctx, parentType: "QUOTE" | "INVOICE" | "CONTRACT", parentId: string, items: any[] | undefined, isNew: boolean): Promise<void> {
  const products = await ctxMap(ctx, "products");
  const locations = await ctxMap(ctx, "stock_locations");
  const tbl = () => ctx.client.schema("jms").from("line_items");
  if (!isNew) { const { error } = await tbl().delete().eq("tenant_id", ctx.tenantId).eq("parent_type", parentType).eq("parent_id", parentId); if (error) throw error; }
  const rows = (items ?? []).map((l: any, i: number) => {
    const qty = num0(l.quantity), price = num0(l.unit_price);
    const discount = String(l.discount_type).toUpperCase() === "PERCENTAGE" ? r2((qty * price * num0(l.discount)) / 100) : num0(l.discount);
    const type = String(l.line_item_type ?? "ITEM").toUpperCase();
    return {
      tenant_id: ctx.tenantId, parent_type: parentType, parent_id: parentId, product_id: mapGet(products, l.product_uid),
      description: T(l.name) ?? "Item", quantity: qty, unit_price: price, discount_amount: discount, tax_amount: 0,
      total: num0(l.total) || r2(qty * price - discount), display_order: i + 1,
      // The line's own copy of the item, as Zuper's quote and invoice tables show it (00083).
      item_type: type === "SECTION" || type === "HEADER" ? "HEADER" : type === "BUNDLE" ? "BUNDLE" : type.startsWith("CUSTOM") ? "CUSTOM" : "ITEM",
      item_code: T(l.product_id), product_type: T(l.product_type), brand: T(l.brand), specification: T(l.specification),
      uom: T(l.uom), details: T(l.plain_text_description) ?? T(l.description),
      unit_cost: l.purchase_price == null ? null : num0(l.purchase_price), location_id: mapGet(locations, l.location_uid),
    };
  });
  if (rows.length) { const { error } = await tbl().insert(rows); if (error) throw error; }
}
/** Zuper custom field values → jms.custom_field_values, matched to Tuper's definitions by label.
 *  Definitions load once per run; a label Tuper has no definition for is left out. */
async function writeCustomFieldValues(ctx: Ctx, entityType: string, entityId: string, fields: any[] | undefined): Promise<void> {
  if (!fields?.length) return;
  const key = `customFieldDefs:${entityType}`;
  if (!ctx.extra[key]) {
    const { data, error } = await ctx.client.schema("jms").from("custom_field_definitions").select("id, label, field_type").eq("tenant_id", ctx.tenantId).eq("entity_type", entityType).eq("is_active", true);
    if (error) throw error;
    ctx.extra[key] = new Map(((data ?? []) as { id: string; label: string; field_type: string }[]).map((d) => [d.label.trim().toLowerCase(), d]));
  }
  const defs: Map<string, { id: string; field_type: string }> = ctx.extra[key];
  const rows: Record<string, unknown>[] = [];
  for (const f of fields) {
    const def = defs.get(String(f.label ?? "").trim().toLowerCase());
    const value = T(f.value);
    if (!def || !value) continue;
    // Same typed columns as custom-fields.ts valueColumn().
    const column = def.field_type === "DATE" || def.field_type === "DATE_TIME" ? { value_date: value }
      : def.field_type === "MULTI_SELECTION" || def.field_type === "DATA_TABLE" ? { value_json: [value] } : { value_text: value };
    rows.push({ tenant_id: ctx.tenantId, definition_id: def.id, entity_type: entityType, entity_id: entityId, ...column });
  }
  if (rows.length) {
    const { error } = await ctx.client.schema("jms").from("custom_field_values").upsert(rows, { onConflict: "definition_id,entity_id" });
    if (error) throw error;
  }
}
// ── Zuper's custom fields, as Zuper answers them ── FIELD-PARITY (2026-09-20): Tuper answered `custom_fields: []`
// for every customer, organization, user, asset and invoice, because nothing imported them — the Zoho CRM / Zoho Books
// ids GBG's integration writes among them. These helpers are what the importers of those kinds use.

/** Zuper's name for a kind of custom field → Tuper's jms.form_field_type. The inverse of the web app's
 *  ZUPER_FIELD_TYPE (lib/api/shape.ts); a kind Zuper does not name is single-line text, as before. */
const ZUPER_CUSTOM_FIELD_TYPES: Record<string, string> = {
  SINGLE_LINE: "SINGLE_LINE_TEXT", MULTI_LINE: "MULTI_LINE_TEXT", NUMBER: "SINGLE_LINE_TEXT",
  RADIO: "SINGLE_SELECTION", MULTI_ITEM: "MULTI_SELECTION", SINGLE_ITEM: "DROPDOWN",
  IMAGE: "SINGLE_IMAGE", MULTI_IMAGE: "MULTI_IMAGE", HEADER: "SECTION_HEADER", SIGNATURE: "SIGNATURE",
  DATE: "DATE", DATETIME: "DATE_TIME", TIME: "TIME", BARCODE: "BARCODE_SCAN", FILE: "UPLOAD", VIDEO: "VIDEO",
};
const jmsFieldType = (zuperType: unknown) => ZUPER_CUSTOM_FIELD_TYPES[String(zuperType ?? "").trim().toUpperCase()] ?? "SINGLE_LINE_TEXT";

/**
 * The key a field has inside Zuper's `custom_field_internal_object` — "asset_rental_number_1",
 * "EMPLOYEE_Nickname_1", "INVOICE_Zoho_Books_Invoice_ID_1".
 *
 * A module prefix, the label as a key, and an occurrence number, written in three different cases depending on the
 * module. Only the label part can be matched, and the number cannot be derived at all, so the key is paired to the
 * field by its label and then kept exactly as Zuper sent it (on the definition, config.zuper_key).
 */
function zuperInternalKey(label: string, internal: Record<string, unknown> | undefined | null): string | null {
  if (!internal || typeof internal !== "object") return null;
  const want = snakeKey(label);
  let best: string | null = null;
  for (const key of Object.keys(internal)) {
    const tail = snakeKey(key.replace(/_\d+$/, ""));
    if (tail === want) return key;
    if (tail.endsWith(`_${want}`) && (!best || key.length < best.length)) best = key;
  }
  return best;
}

/** Definitions for the labels Zuper uses on an entity: in Zuper's own kind, and carrying what Zuper says about the
 *  field that Tuper's own columns cannot hold — the name it gives the kind, and its key inside
 *  custom_field_internal_object. A definition that already exists keeps its kind and only gains those two. */
async function ensureZuperFieldDefinitions(ctx: Ctx, entityType: string, fields: any[], internal?: Record<string, unknown> | null): Promise<void> {
  const known: Set<string> = (ctx.extra[`zuperFieldLabels:${entityType}`] ??= new Set<string>());
  const fresh = fields.filter((f) => !known.has(String(f.label).trim().toLowerCase()));
  if (!fresh.length) return;
  await once(ctx, `zuperFieldDefinitions:${entityType}:${fresh.map((f) => String(f.label).trim().toLowerCase()).sort().join("|")}`, async () => {
    const { data: existing, error } = await ctx.client.schema("jms").from("custom_field_definitions")
      .select("id, label, display_order, config").eq("tenant_id", ctx.tenantId).eq("entity_type", entityType);
    if (error) throw error;
    const defs = (existing ?? []) as { id: string; label: string; display_order: number | null; config: Record<string, unknown> | null }[];
    const have = new Map(defs.map((d) => [d.label.trim().toLowerCase(), d]));
    let order = Math.max(0, ...defs.map((d) => d.display_order ?? 0));
    const added: Record<string, unknown>[] = [];
    for (const f of fresh) {
      const label = String(f.label).trim();
      // Zuper's own key for the field inside custom_field_internal_object, and the name it gives the field's kind
      // ("SINGLE_LINE", "FILE"), or null where it names none — which is a property of the field, not of the module:
      // an asset's own 36 fields carry a type and the six that came from its customer carry none.
      //
      // Its `module_name` is NOT kept: measured over 300 assets, the same field carries module_name on about half
      // the records and not on the other half (and the value is "PRODUCT" on an asset's and on a person's alike), so
      // it says nothing about the field. Answering it from the definition would invent it for the records Zuper
      // leaves it off, which is a difference of its own.
      const kept: Record<string, unknown> = { zuper_type: T(f.type) };
      const zuperKey = zuperInternalKey(label, internal);
      if (zuperKey) kept.zuper_key = zuperKey;
      const mine = have.get(label.toLowerCase());
      if (!mine) {
        added.push({
          tenant_id: ctx.tenantId, entity_type: entityType, field_key: snakeKey(label), label,
          field_type: jmsFieldType(f.type), display_order: ++order,
          // Always present, even empty: one insert carries several definitions and they must all name the same
          // columns, or the ones that left `config` out are sent as NULL and the whole write fails on NOT NULL.
          config: kept,
        });
      } else if (Object.entries(kept).some(([k, v]) => (mine.config as Record<string, unknown> | null)?.[k] !== v)) {
        const { error: keyErr } = await ctx.client.schema("jms").from("custom_field_definitions")
          .update({ config: { ...(mine.config ?? {}), ...kept } }).eq("id", mine.id).eq("tenant_id", ctx.tenantId);
        if (keyErr) throw keyErr;
      }
    }
    if (added.length) {
      const { error: insertError } = await ctx.client.schema("jms").from("custom_field_definitions")
        .upsert(added, { onConflict: "tenant_id,entity_type,field_key", ignoreDuplicates: true });
      if (insertError) throw insertError;
      delete ctx.extra[`customFieldDefs:${entityType}`]; // writeCustomFieldValues reloads them
    }
    return null;
  });
  for (const f of fresh) known.add(String(f.label).trim().toLowerCase());
}

/** A record's custom fields as Zuper answers them → Tuper's definitions and values. A date Zuper sends as something
 *  that is not a date is left out rather than failing the whole record on a typed column. */
async function writeZuperCustomFields(ctx: Ctx, entityType: string, entityId: string, fields: unknown, internal?: unknown): Promise<void> {
  const list = (Array.isArray(fields) ? fields : []).filter((f) => T(f?.label));
  if (!list.length) return;
  const asObject = internal && typeof internal === "object" ? internal as Record<string, unknown> : null;
  await ensureZuperFieldDefinitions(ctx, entityType, list, asObject);
  const key = `customFieldDefs:${entityType}`;
  if (!ctx.extra[key]) {
    const { data, error } = await ctx.client.schema("jms").from("custom_field_definitions").select("id, label, field_type")
      .eq("tenant_id", ctx.tenantId).eq("entity_type", entityType).eq("is_active", true);
    if (error) throw error;
    ctx.extra[key] = new Map(((data ?? []) as { id: string; label: string; field_type: string }[]).map((d) => [d.label.trim().toLowerCase(), d]));
  }
  const defs: Map<string, { id: string; field_type: string }> = ctx.extra[key];
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const f of list) {
    const def = defs.get(String(f.label).trim().toLowerCase());
    if (!def || seen.has(def.id)) continue;
    seen.add(def.id);
    const value = T(f.value);
    // A date Zuper sends as something that is not a date keeps its text rather than failing the record on a typed column.
    const dated = (def.field_type === "DATE" || def.field_type === "DATE_TIME") && value && !Number.isNaN(Date.parse(value));
    // Every value column on every row, so the write is one uniform upsert and a value that changed kind is cleared.
    rows.push({
      tenant_id: ctx.tenantId, definition_id: def.id, entity_type: entityType, entity_id: entityId,
      value_text: dated ? null : def.field_type === "MULTI_SELECTION" || def.field_type === "DATA_TABLE" ? null : value ?? "",
      value_number: null, value_date: dated ? value : null, value_bool: null,
      value_json: def.field_type === "MULTI_SELECTION" || def.field_type === "DATA_TABLE" ? (value ? [value] : []) : null,
    });
  }
  // Zuper lists the fields the RECORD has, empty ones among them (a customer with one Zoho id answers one field, not
  // the module's three), so an empty value is kept as "" — that is what says the record has the field at all.
  if (rows.length) {
    const { error } = await ctx.client.schema("jms").from("custom_field_values").upsert(rows, { onConflict: "definition_id,entity_id" });
    if (error) throw error;
  }
}

/** Who made the record, when the answer we were given carries one. Zuper's customer and user LISTS do not send
 *  `created_by` at all (its detail reads do), so a list pass must never blank what a detail read filled. */
async function createdByField(ctx: Ctx, r: any): Promise<Record<string, unknown>> {
  const uid = T(r?.created_by?.user_uid);
  if (!uid) return {};
  const id = mapGet(await ctxMap(ctx, "users"), uid);
  return id ? { created_by: id } : {};
}

/** A quote's or invoice's own billing and service contact and address → jms.addresses (parent QUOTE / INVOICE). */
async function writeDocumentAddresses(ctx: Ctx, parentType: "QUOTE" | "INVOICE", parentId: string, r: any): Promise<void> {
  const rows = ([["BILLING", r.customer_billing_address], ["SERVICE", r.customer_service_address]] as const)
    // Zuper sends {} for an address a document does not have. Writing that as a row of nulls would make Tuper
    // answer an address-shaped object where Zuper answers nothing, so an object with no values is not written.
    .filter(([, a]) => a && typeof a === "object" && Object.values(a).some((v) => T(v as any) !== null))
    .map(([kind, a]: readonly [string, any]) => ({
      tenant_id: ctx.tenantId, parent_type: parentType, parent_id: parentId, address_kind: kind,
      street: T(a.street), landmark: T(a.landmark), city: T(a.city), state: T(a.state), country: T(a.country), zip_code: T(a.zip_code),
      contact_first_name: T(a.first_name), contact_last_name: T(a.last_name), contact_email: T(a.email), contact_phone: T(a.phone_number),
    }));
  if (!rows.length) return;
  const { error } = await ctx.client.schema("jms").from("addresses").upsert(rows, { onConflict: "parent_type,parent_id,address_kind" });
  if (error) throw error;
}
/** A quote's Zuper status_history → jms.quote_status_history (00107), replacing the imported rows and keeping any
 *  Tuper made after the import. Nothing is touched when Zuper returned no history. */
async function writeQuoteStatusHistory(ctx: Ctx, quoteId: string, history: any[] | undefined): Promise<void> {
  if (!Array.isArray(history) || !history.length) return;
  const users = await ctxMap(ctx, "users");
  const tbl = () => ctx.client.schema("jms").from("quote_status_history");
  const { error: delErr } = await tbl().delete().eq("tenant_id", ctx.tenantId).eq("quote_id", quoteId).eq("source", "zuper");
  if (delErr) throw delErr;
  const rows = history
    .map((h: any) => ({ h, status: QUOTE_STATUSES[String(h?.status_name ?? "").toUpperCase()] }))
    .filter(({ h, status }) => status && h?.created_at)
    .map(({ h, status }) => ({
      tenant_id: ctx.tenantId, quote_id: quoteId, status, remarks: T(h.remarks),
      changed_by: String(h.done_by_type ?? "EMPLOYEE").toUpperCase() === "EMPLOYEE" ? mapGet(users, h.done_by?.user_uid) : null,
      changed_at: String(h.created_at), source: "zuper",
    }));
  if (rows.length) { const { error } = await tbl().insert(rows); if (error) throw error; }
}
/** Tuper's copy of a Zuper document template (00082 imported them, keyed by source_uid). */
async function documentTemplateId(ctx: Ctx, templateUid: unknown): Promise<string | null> {
  const uid = T(templateUid);
  if (!uid) return null;
  const cache: Map<string, string | null> = (ctx.extra.templateIds ??= new Map());
  if (!cache.has(uid)) {
    const { data, error } = await ctx.client.schema("jms").from("document_templates")
      .select("id").eq("tenant_id", ctx.tenantId).eq("source_uid", uid).eq("is_deleted", false).maybeSingle();
    if (error) throw error;
    cache.set(uid, (data as { id: string } | null)?.id ?? null);
  }
  return cache.get(uid) ?? null;
}
/** Tuper's copy of a Zuper payment term. Terms are not imported as records of their own, so they are matched by the
 *  name Zuper answers ("Immediatly", "Monthly"), which is the name Tuper's seeded terms carry. */
async function paymentTermId(ctx: Ctx, term: unknown): Promise<string | null> {
  const name = T((term as { payment_term_name?: unknown } | null)?.payment_term_name);
  if (!name) return null;
  const cache: Map<string, string | null> = (ctx.extra.paymentTermIds ??= new Map());
  const key = name.trim().toLowerCase();
  if (!cache.has(key)) {
    const { data, error } = await ctx.client.schema("jms").from("payment_terms")
      .select("id, name").eq("tenant_id", ctx.tenantId).eq("is_deleted", false);
    if (error) throw error;
    for (const row of (data ?? []) as { id: string; name: string }[]) {
      cache.set(String(row.name ?? "").trim().toLowerCase(), row.id);
    }
    if (!cache.has(key)) cache.set(key, null);
  }
  return cache.get(key) ?? null;
}
/** Zuper's customer list has no organization, but jobs name it — fill it in on a customer that has none. */
async function linkCustomerOrganization(ctx: Ctx, customer: any): Promise<void> {
  const customerJmsId = mapGet(await ctxMap(ctx, "customers"), customer?.customer_uid);
  const orgJmsId = mapGet(await ctxMap(ctx, "organizations"), customer?.customer_organization?.organization_uid);
  if (!customerJmsId || !orgJmsId) return;
  const done: Set<string> = (ctx.extra.linkedCustomerOrgs ??= new Set());
  if (done.has(customerJmsId)) return;
  done.add(customerJmsId);
  const { error } = await ctx.client.schema("jms").from("customers").update({ organization_id: orgJmsId })
    .eq("id", customerJmsId).eq("tenant_id", ctx.tenantId).is("organization_id", null);
  if (error) throw error;
}
/** List rows + each row's detail (only the detail carries line items) — for the small document lists. */
async function withDetails(cfg: SyncConfig, listPath: string, detailPath: (r: any) => string): Promise<any[]> {
  const out: any[] = [];
  for (const r of await zuperFilterAll(cfg, listPath)) out.push({ ...r, ...((await zuperGet(cfg, detailPath(r))).data ?? {}) });
  return out;
}

const JOB_PRIORITIES = new Set(["LOW", "MEDIUM", "HIGH", "URGENT"]);
// Zuper's customer feedback ratings — the same five as jms.feedback_rating.
const FEEDBACK_RATINGS = new Set(["VERY_HAPPY", "HAPPY", "NEUTRAL", "UNHAPPY", "VERY_UNHAPPY"]);
// Zuper request status types → jms.request_statuses.status_type (Tuper has no "Canceled" request status).
const REQUEST_STATUS_TYPES: Record<string, string> = { OPEN: "NEW", NEW: "NEW", ON_HOLD: "ON_HOLD", CONVERTED: "COMPLETED", COMPLETED: "COMPLETED", CLOSED: "CLOSED", CANCELED: "CLOSED" };
const QUOTE_STATUSES: Record<string, string> = { DRAFT: "DRAFT", AWAIT_RESPONSE: "SENT", SENT: "SENT", APPROVED: "ACCEPTED", ACCEPTED: "ACCEPTED", DECLINED: "DECLINED", REJECTED: "DECLINED", EXPIRED: "EXPIRED", ARCHIVED: "ARCHIVED", CANCELED: "CANCELED", CONVERTED: "CONVERTED" };
const INVOICE_STATUSES: Record<string, string> = { DRAFT: "DRAFT", AWAIT_PAYMENT: "SENT", SENT: "SENT", PARTIALLY_PAID: "PARTIALLY_PAID", PAID: "PAID", OVERDUE: "OVERDUE", ARCHIVED: "ARCHIVED", CANCELED: "CANCELED", VOID: "CANCELED" };

export const ENTITIES: Record<string, Entity> = {
  job_categories: {
    name: "job_categories", schema: "jms", table: "job_categories",
    fetch: (ctx) => zuperGet(ctx.cfg, "/api/jobs/category").then((j) => j.data ?? []),
    uid: (r) => r.category_uid,
    async transform(r) {
      const d = r.estimated_duration ?? {};
      const mins = (Number(d.days) || 0) * 1440 + (Number(d.hours) || 0) * 60 + (Number(d.minutes) || 0);
      return { name: S(r.category_name) ?? "Category", color: S(r.category_color), display_order: N(r.display_order) ?? 0, estimated_duration_minutes: mins || null, is_active: r.is_active !== false };
    },
  },
  // Each synced category's status workflow (GET /api/jobs/status/{category_uid}), in Zuper's order,
  // with its checklists — jms.forms bound through job_statuses.form_id (map entity
  // job_status_checklists). Parent links are resolved in afterAll, once every status has an id.
  job_statuses: {
    name: "job_statuses", schema: "jms", table: "job_statuses",
    async fetch(ctx) {
      const catMap = await ctxMap(ctx, "job_categories");
      const { data: cats, error } = await ctx.client.schema("jms").from("job_categories").select("id, name").eq("tenant_id", ctx.tenantId);
      if (error) throw error;
      const nameOf = new Map(((cats ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
      const out: any[] = [];
      for (const [categoryUid, categoryId] of catMap) {
        const j = await zuperGet(ctx.cfg, `/api/jobs/status/${categoryUid}`);
        const list: any[] = j?.data?.job_statuses ?? [];
        list.forEach((s, i) => out.push({ ...s, _category_id: categoryId, _category_name: nameOf.get(categoryId) ?? "Category", _order: i + 1 }));
      }
      return out;
    },
    uid: (r) => r.status_uid,
    async transform(r, ctx) {
      const remarks: string[] = (r.remarks_values ?? []).map((v: unknown) => String(v).trim()).filter(Boolean);
      const allowRemarks = r.allow_remarks === true;
      return {
        category_id: r._category_id,
        name: String(r.status_name ?? "").trim() || "Status",
        status_type: JOB_STATUS_TYPES.has(String(r.status_type)) ? r.status_type : "OTHER",
        color: S(r.status_color),
        // What the status is for, in the words Zuper's own workflow shows ("Appointment date/time needs to be
        // confirmed with the customer"). It was dropped, so Tuper's statuses read as bare names.
        description: S(r.status_description),
        display_order: r._order,
        require_customer_signature: r.require_customer_signature === true,
        require_customer_feedback: r.require_customer_feedback === true,
        require_facial_authentication: r.require_facial_authentication === true,
        require_preview: r.require_preview === true,
        // Zuper's geo-fence radius isn't on this payload and no GBG status fences; "capture location" is what they use.
        capture_geo_coordinates: r.capture_geo_cords === true,
        enabled_for_field_executive: r.enabled_for_field_executive !== false,
        enabled_for_manager: r.enabled_for_manager !== false,
        allow_remarks: allowRemarks,
        // Zuper's own choice where it made one — it has PREDEFINED too, which guessing from the values misses.
        remarks_type: S(r.remarks_type) ?? (allowRemarks ? (remarks.length ? "BOTH" : "FREE_TEXT") : null),
        remarks_values: remarks,
        prefill_checklist: r.prefill_checklist === true,
        checklist_view_type: r.checklist_view_type === "MULTI_PAGE" ? "MULTI_PAGE" : "SINGLE_PAGE",
        form_id: await syncStatusChecklist(ctx, r),
        is_active: true,
      };
    },
    // A status arriving under a name a live status of the same category already has (one made on the spot for an
    // imported job's status, or Tuper's own) takes that row over: Zuper's workflow never repeats a name within a
    // category, and job_statuses_live_name_key allows one live status per name there.
    async insert(ctx, payload) {
      const tbl = () => ctx.client.schema("jms").from("job_statuses");
      const { data, error } = await tbl().insert({ ...payload, tenant_id: ctx.tenantId }).select("id").single();
      if (!error) return (data as { id: string }).id;
      if (error.code !== "23505") throw error;
      const { data: same } = await tbl().select("id").eq("tenant_id", ctx.tenantId).eq("category_id", String(payload.category_id))
        .eq("name", String(payload.name)).eq("is_deleted", false).maybeSingle();
      const id = (same as { id: string } | null)?.id;
      if (!id) throw error;
      const { error: upErr } = await tbl().update(payload).eq("id", id).eq("tenant_id", ctx.tenantId);
      if (upErr) throw upErr;
      return id;
    },
    async afterAll(ctx, rows) {
      const ids = await ctxMap(ctx, "job_statuses");
      for (const r of rows) {
        const id = ids.get(r.status_uid);
        if (!id) continue;
        // Zuper allows several parents, and a job moves into the status from any of them: all go in parent_status_ids
        // (00103), and the database keeps parent_status_id as the one parent when there's exactly one.
        const parents: string[] = r.has_parent === true
          ? (r.parent_status ?? []).map((p: string) => ids.get(p)).filter((x: string | undefined): x is string => !!x)
          : [];
        const { error } = await ctx.client.schema("jms").from("job_statuses").update({ parent_status_ids: [...new Set(parents)] }).eq("id", id).eq("tenant_id", ctx.tenantId);
        if (error) throw error;
      }
    },
  },
  // Job cards (Settings → Job Cards): the printed report a job's Print/Share offers. The list carries only names, so
  // each is read again for its `template` — the Handlebars a card is written in, which Tuper renders with the same
  // helpers. `associated_to` names every category whose jobs may print it (00109).
  job_card_templates: {
    name: "job_card_templates", schema: "jms", table: "job_card_templates",
    deps: ["job_categories"],
    // One plain GET returns every card (there is no paging on this list), then each is read for its template body.
    async fetch(ctx) {
      const list: any[] = (await zuperGet(ctx.cfg, "/api/jobs/template")).data ?? [];
      const out: any[] = [];
      for (const r of list) out.push({ ...r, ...((await zuperGet(ctx.cfg, `/api/jobs/template/${r.template_uid}`)).data ?? {}) });
      return out;
    },
    uid: (r) => r.template_uid,
    async transform(r, ctx) {
      if (r.is_deleted === true) return null;
      const cats = await ctxMap(ctx, "job_categories");
      const catUid = (v: any) => (v && typeof v === "object" ? T(v.category_uid) : T(v));
      const associated = [...new Set(((r.associated_to ?? []) as any[]).map(catUid).filter(Boolean) as string[])]
        .map((uid) => mapGet(cats, uid)).filter((id): id is string => !!id);
      const primary = mapGet(cats, catUid(r.job_category));
      const opts = r.template_options ?? {};
      const border = opts.border ?? {};
      const side = (v: unknown) => String(v ?? "0");
      return {
        name: S(r.template_name) ?? "Job Card",
        description: S(r.template_description),
        is_active: true,                                   // Zuper has no on/off for a card: a deleted one is gone
        job_category_id: primary ?? associated[0] ?? null,
        associated_category_ids: associated.length ? associated : primary ? [primary] : [],
        content: {
          html: String(r.template ?? ""),
          format: String(opts.format ?? "A4"),
          orientation: String(opts.orientation ?? "portrait"),
          borders: { top: side(border.top), right: side(border.right), bottom: side(border.bottom), left: side(border.left) },
        },
      };
    },
  },
  // Job Notifications (Job Settings → Job Notifications): reminders, delay alerts and status alerts for staff, and
  // the customer/contact status alerts — kept active or not exactly as they are in Zuper.
  job_notification_rules: {
    name: "job_notification_rules", schema: "jms", table: "job_notification_rules",
    deps: ["job_categories", "job_statuses", "users", "teams"],
    async fetch(ctx) {
      const [rem, delay, status, cust] = await Promise.all([
        zuperGet(ctx.cfg, "/api/jobs/reminder"), zuperGet(ctx.cfg, "/api/jobs/delay_alert"),
        zuperGet(ctx.cfg, "/api/jobs/status_alert"), zuperGet(ctx.cfg, "/api/customer_notification?count=100&page=1"),
      ]);
      // _order keeps Zuper's own list order (its settings tables show each list as the API returns it).
      const tag = (rows: any[] | undefined, kind: string, uid: string) => (rows ?? []).map((r: any, i: number) => ({ ...r, _kind: kind, _uid: r[uid], _order: i + 1 }));
      return [
        ...tag(rem.data, "REMINDER", "job_reminder_uid"),
        ...tag(delay.data, "DELAY", "job_delay_alert_uid"),
        ...tag(status.data, "STATUS", "job_status_alert_uid"),
        ...tag(cust.data, "CUSTOMER", "customer_notification_uid"),
      ].filter((r) => r._uid && r.is_deleted !== true);
    },
    uid: (r) => r._uid,
    async transform(r, ctx) {
      const [users, teams, cats, statuses] = await Promise.all([ctxMap(ctx, "users"), ctxMap(ctx, "teams"), ctxMap(ctx, "job_categories"), ctxMap(ctx, "job_statuses")]);
      const channel = (t: unknown) => (t === "EMAIL" || t === "SMS" ? t : "PUSH");
      // Zuper's recipient choices: ALL (All Assigned Users), ONLY_ASSIGNED_EMPLOYEES (Only Assigned FE's),
      // SELECTED_USERS / SELECTED_TEAMS, and the team-leader options.
      const sendTo = (t: unknown) => {
        const v = String(t ?? "").toUpperCase();
        if (v.includes("LEADER")) return "TEAM_LEADERS";
        if (v === "ONLY_ASSIGNED_EMPLOYEES" || v.includes("FIELD_EXECUTIVE") || /_FES?$/.test(v)) return "ASSIGNED_FE";
        if (v.startsWith("SELECTED")) return "SELECTED";
        return "ASSIGNED";
      };
      const minutes = (n: unknown, unit: unknown) => {
        const u = String(unit ?? "").toUpperCase();
        return Math.round((Number(n) || 0) * (u.startsWith("HOUR") ? 60 : u.startsWith("DAY") ? 1440 : 1)) || null;
      };
      // A category Zuper has since deleted (its alerts keep the old name — "AMC Gold") gives way to the category the
      // rule's status belongs to, so the rule can still be switched on as it is.
      const categoryFor = async (uid: unknown, statusId: string | null): Promise<string | null> => {
        const id = mapGet(cats, uid);
        if (id || !statusId) return id;
        const { data } = await ctx.client.schema("jms").from("job_statuses").select("category_id").eq("id", statusId).maybeSingle();
        return (data as { category_id: string } | null)?.category_id ?? null;
      };
      // Selected people — users Tuper didn't import (inactive in Zuper) drop out.
      const people = (to: string) => (to !== "SELECTED" ? {} : {
        user_ids: ((r.send_to_users ?? []) as any[]).map((u) => mapGet(users, u?.user_uid)).filter(Boolean),
        team_ids: ((r.send_to_teams ?? []) as any[]).map((t) => mapGet(teams, t?.team_uid ?? t)).filter(Boolean),
      });
      const base = {
        extra_emails: ((r.additional_email_recipients ?? []) as any[]).map((x) => T(typeof x === "string" ? x : x?.email)).filter(Boolean),
        subject: T(r.email_subject), is_active: r.is_active === true, display_order: r._order ?? null, zuper_uid: r._uid, ...createdAt(r),
      };
      // A rule on a status Zuper has since deleted comes over with no status, as Zuper lists it — it never fires.
      if (r._kind === "REMINDER") {
        const to = sendTo(r.reminder_to);
        return { ...base, ...people(to), audience: "INTERNAL", kind: "REMINDER", name: T(r.reminder_name) ?? "Job Reminder", channel: channel(r.reminder_type), send_to: to,
          offset_minutes: minutes(r.remind_before, r.remind_before_type) ?? 10, body: String(r.reminder_template ?? ""), notify_unassigned: r.notify_unassigned === true };
      }
      if (r._kind === "DELAY") {
        const to = sendTo(r.delay_alert_to);
        const fromStatus = mapGet(statuses, r.from_status_uid);
        return { ...base, ...people(to), audience: "INTERNAL", kind: "DELAY", name: T(r.delay_alert_name) ?? "Delay Alert", channel: channel(r.delay_alert_type), send_to: to,
          category_id: await categoryFor(r.job_category?.category_uid, fromStatus), delay_for: ["JOB", "JOB_END_TIME", "STATUS"].includes(r.delay_alert_for) ? r.delay_alert_for : "JOB",
          from_status_id: fromStatus, to_status_id: mapGet(statuses, r.to_status_uid), flag_job_as_delayed: r.flag_job_as_delayed === true,
          offset_minutes: minutes(r.alert_delayed_by, r.alert_delayed_by_type) ?? 10, body: String(r.delay_alert_template ?? "") };
      }
      if (r._kind === "STATUS") {
        const to = sendTo(r.status_alert_to);
        const statusId = mapGet(statuses, r.status_alert_status);
        return { ...base, ...people(to), audience: "INTERNAL", kind: "STATUS", name: T(r.status_alert_name) ?? "Status Alert", channel: channel(r.status_alert_type), send_to: to,
          category_id: await categoryFor(r.status_alert_category?.category_uid, statusId), status_id: statusId, body: String(r.status_alert_template ?? "") };
      }
      const ch = r.notification_type === "EMAIL" ? "EMAIL" : "SMS";
      const statusId = mapGet(statuses, r.job_status_uid);
      return { ...base, audience: "CUSTOMER", kind: "STATUS", name: T(r.notification_name) ?? "Customer Notification", channel: ch, send_to: "CUSTOMER",
        category_id: await categoryFor(r.job_category?.category_uid, statusId), status_id: statusId, body: String((ch === "EMAIL" ? r.email_body : r.sms_body) ?? "") };
    },
  },
  // Each product with its stock at every location (product_locations) and its custom fields (Zoho item ids,
  // vendor, manufacturer …). Zuper's "Part / Service No" is product_id; product_no is the number its list shows as ID.
  products: {
    name: "products", schema: "jms", table: "products", deps: ["product_categories", "users", "stock_locations"],
    fetch: (ctx) => zuperFilterAll(ctx.cfg, "/api/product/filter"),
    uid: (r) => r.product_uid,
    async transform(r, ctx) {
      const catMap = await ctxMap(ctx, "product_categories");
      const rawType = String(r.product_type ?? "").toUpperCase();
      const product_type = ["PRODUCT", "SERVICE", "PARTS", "BUNDLE"].includes(rawType) ? rawType : (r.service_type ? "SERVICE" : "PRODUCT");
      const custom = (label: string) => T((r.custom_fields ?? []).find((f: any) => String(f?.label ?? "").trim().toLowerCase() === label)?.value);
      return {
        // The list's "Part / Service No" is the prefix and the part number together ("AMCJGE SERAMCJGE1").
        name: S(r.product_name) ?? "Product", sku: [T(r.prefix), T(r.product_id)].filter(Boolean).join(" ") || null, product_no: N(r.product_no),
        description: S(r.plain_text_description ?? r.product_description),
        product_type, service_type: r.service_type ? String(r.service_type).toUpperCase() === "HOURLY" ? "HOURLY" : "FIXED" : null,
        unit_price: N(r.price) ?? 0, unit_cost: N(r.purchase_price), is_available: r.is_available !== false, is_billable: r.is_billable !== false,
        category_id: r.product_category?.category_uid ? catMap.get(r.product_category.category_uid) ?? null : null,
        brand: T(r.brand), specification: T(r.specification), uom: custom("unit"), reorder_level: N(custom("reorder level")),
        track_quantity: r.track_quantity !== false, quantity: num0(r.quantity), min_quantity: num0(r.min_quantity),
        barcode: T(r.product_barcode), image_url: T(r.product_image), is_tax_exempt: r.tax?.tax_exempt === true,
        created_by: mapGet(await ctxMap(ctx, "users"), r.created_by?.user_uid), ...createdAt(r),
      };
    },
    afterWrite: (ctx, id, r) => writeProductStockAndFields(ctx, id, r),
  },

  // A team as its own record. Until now a team reached Tuper only when a job mentioned one (teamId above), which
  // created it from the three fields a job carries; its time zone, whether it is dispatchable, who made it and who
  // is on it never arrived, and a team.create in Zuper reached nothing at all.
  teams: {
    name: "teams", schema: "jms", table: "teams", deps: ["users"],
    pages: (ctx) => zuperListPages(ctx.cfg, "/api/team"),
    // The list sends the team flat; GET /api/team/{uid} wraps it in `team`. Both arrive here.
    uid: (row) => (row.team ?? row).team_uid,
    async transform(row, ctx) {
      const r = row.team ?? row;
      return {
        name: S(r.team_name) ?? "Team",
        description: T(r.team_description),
        color: T(r.team_color),
        // Zuper sends "" for a team on the company's own zone; Tuper reads null as the same thing.
        timezone: T(r.team_timezone),
        is_dispatchable: r.is_dispatchable === true,
        is_active: r.is_active !== false,
        is_deleted: r.is_deleted === true,
        created_by: mapGet(await ctxMap(ctx, "users"), r.created_by?.user_uid),
        ...createdAt(r),
      };
    },
    afterWrite: (ctx, id, r) => writeTeamMembers(ctx, id, r),
  },

  // Projects and purchase orders. GBG's Zuper holds none of either today, so these map the record Zuper documents
  // rather than one we have watched arrive: the fields below are the ones its own create and read bodies name. The
  // first record made in Zuper is what confirms them — and because only mapped fields are written, a surprise shows
  // up as a failed sync in the log instead of a row filled with nulls.
  projects: {
    name: "projects", schema: "jms", table: "projects", deps: ["users", "customers", "organizations"],
    pages: (ctx) => zuperListPages(ctx.cfg, "/api/projects"),
    uid: (row) => (row.project ?? row).project_uid,
    async transform(row, ctx) {
      const r = row.project ?? row;
      const users = await ctxMap(ctx, "users");
      return {
        name: S(r.project_name ?? r.title) ?? "Project",
        description: S(r.project_description ?? r.description),
        prefix: T(r.prefix),
        project_no: N(r.project_number),
        status: T(r.project_status?.status_name ?? r.current_status?.status_name ?? r.status),
        priority: T(r.priority)?.toUpperCase() ?? null,
        completion_percentage: N(r.completion_percentage),
        start_date: dubaiDate(r.start_date ?? r.project_start_date),
        end_date: dubaiDate(r.end_date ?? r.project_end_date),
        due_date: dubaiDate(r.due_date),
        actual_start_date: dubaiDate(r.actual_start_date),
        actual_end_date: dubaiDate(r.actual_end_date),
        customer_id: mapGet(await ctxMap(ctx, "customers"), r.customer?.customer_uid),
        organization_id: mapGet(await ctxMap(ctx, "organizations"), r.organization?.organization_uid),
        project_manager_id: mapGet(users, r.project_manager?.user_uid),
        is_active: r.is_active !== false,
        is_deleted: r.is_deleted === true,
        created_by: mapGet(users, r.created_by?.user_uid),
        ...createdAt(r),
      };
    },
  },
  purchase_orders: {
    name: "purchase_orders", schema: "jms", table: "purchase_orders", deps: ["users", "jobs"],
    pages: (ctx) => zuperListPages(ctx.cfg, "/api/purchase_orders"),
    uid: (row) => (row.purchase_order ?? row).purchase_order_uid,
    async transform(row, ctx) {
      const r = row.purchase_order ?? row;
      return {
        purchase_order_number: T(r.purchase_order_number),
        prefix: T(r.prefix),
        purchase_order_type: T(r.purchase_order_type)?.toUpperCase() ?? "PURCHASE_ORDER",
        title: S(r.title ?? r.purchase_order_title),
        status: T(r.status ?? r.purchase_order_status)?.toUpperCase() ?? "DRAFTED",
        job_id: mapGet(await ctxMap(ctx, "jobs"), r.job?.job_uid),
        purchase_order_date: dubaiDate(r.purchase_order_date),
        due_date: dubaiDate(r.due_date),
        reference_number: T(r.reference_number),
        remarks: S(r.remarks),
        total_price: N(r.total_price),
        is_deleted: r.is_deleted === true,
        created_by: mapGet(await ctxMap(ctx, "users"), r.created_by?.user_uid),
        ...createdAt(r),
      };
    },
  },

  // A property as its own Zuper record. PROPERTY is a module of its own — `GET /api/organization/{uid}` answers 404
  // for a property uid — and until now none of its eleven events reached Tuper at all: GBG's one property had never
  // arrived. Zuper serves a property at `GET /api/property/{uid}` (an unknown uid earns its own "No Property found
  // for given UID", where `/api/properties/{uid}` earns Express's HTML 404, so the singular is the real path).
  //
  // The LIST leaves out the description, the price list and the files — only the by-uid read carries them — so each
  // listed property is read in full rather than written from the list row.
  properties: {
    name: "properties", schema: "jms", table: "properties", deps: ["users", "customers", "organizations", "teams"],
    async fetch(ctx) {
      const out: any[] = [];
      for await (const page of zuperListPages(ctx.cfg, "/api/property")) {
        for (const p of page) {
          const uid = T(p?.property_uid);
          out.push(uid ? { ...p, ...((await zuperGet(ctx.cfg, `/api/property/${uid}`)).data ?? {}) } : p);
        }
      }
      return out;
    },
    uid: (r) => r.property_uid,
    async transform(r, ctx) {
      // A parent Zuper names but Tuper has not imported yet leaves the link as it is rather than clearing it;
      // afterAll ties up what a full run could not resolve in order.
      const parentUid = T(r.parent_property?.property_uid);
      const parentId = parentUid ? mapGet(await ctxMap(ctx, "properties"), parentUid) : null;
      return {
        name: T(r.property_name) ?? "Property",
        description: T(r.property_description),
        plain_text_description: T(r.plain_text_description) ?? stripHtml(r.property_description),
        markdown_description: T(r.markdown_description),
        image_url: T(r.property_image),
        // jms.addresses holds the address; this is the copy the list screens read (org-property.ts syncPropertyAddress).
        property_address: zAddress(r.property_address),
        time_zone: T(r.property_timezone),
        customer_id: mapGet(await ctxMap(ctx, "customers"), propertyCustomerUids(r)[0]),
        organization_id: mapGet(await ctxMap(ctx, "organizations"), r.property_organization?.organization_uid),
        ...(parentUid && !parentId ? {} : { parent_property_id: parentId }),
        // Zuper's tax.tax_group names a tax group of its own, and nothing maps those to jms.tax_groups (a wrong id
        // would break the foreign key), so only the exemption itself comes over.
        tax_exempt: r.tax?.tax_exempt === true,
        pricelist_uid: T(r.pricelist && typeof r.pricelist === "object" ? r.pricelist.pricelist_uid : r.pricelist),
        is_active: r.is_active !== false,
        is_deleted: r.is_deleted === true,
        created_by: mapGet(await ctxMap(ctx, "users"), r.created_by?.user_uid),
        ...createdAt(r),
      };
    },
    afterWrite: (ctx, id, r, isNew) => writePropertyParts(ctx, id, r, isNew),
    afterAll: (ctx, rows) => linkParentProperties(ctx, rows),
  },

  // ── History ──
  organizations: {
    name: "organizations", schema: "jms", table: "organizations", concurrency: 8,
    pages: (ctx) => zuperListPages(ctx.cfg, "/api/organization"),
    uid: (r) => r.organization_uid,
    transform: async (r, ctx) => ({ ...organizationFields(r), ...(await createdByField(ctx, r)) }),
    async afterWrite(ctx, id, r, isNew) {
      await writeAddresses(ctx, "ORGANIZATION", id, isNew, r.organization_address, r.organization_billing_address);
      // The organization's Zoho CRM account id and its siblings, when this is a by-uid read: the list rows carry none.
      await writeZuperCustomFields(ctx, "ORGANIZATION", id, r.custom_fields, r.custom_field_internal_object);
      // The organization's own files, when this is a by-uid read: the list rows the import pages through carry none.
      await writeRecordFiles(ctx, "organization", id, r);
    },
  },
  customers: {
    name: "customers", schema: "jms", table: "customers", concurrency: 8,
    pages: (ctx) => zuperListPages(ctx.cfg, "/api/customers"),
    uid: (r) => r.customer_uid,
    transform: async (r, ctx) => ({ ...customerFields(r), no_of_jobs: num0(r.no_of_jobs), ...(await createdByField(ctx, r)) }),
    async afterWrite(ctx, id, r, isNew) {
      await writeAddresses(ctx, "CUSTOMER", id, isNew, r.customer_address, r.customer_billing_address);
      // The customer's Zoho CRM / Zoho Books contact ids and its siblings — the list rows carry these.
      await writeZuperCustomFields(ctx, "CUSTOMER", id, r.custom_fields, r.custom_field_internal_object);
      // The customer's own files, when this is a by-uid read: the list rows the import pages through carry none.
      await writeRecordFiles(ctx, "customer", id, r);
    },
  },
  // Active staff only (owner decision) — accounts with no password and no invite.
  users: {
    name: "users", schema: "jms", table: "users",
    async *pages(ctx) {
      for await (const page of zuperListPages(ctx.cfg, "/api/user/all")) {
        const active = page.filter((u) => u.is_active !== false && u.is_deleted !== true && T(u.email));
        if (active.length) yield active;
      }
    },
    uid: (r) => r.user_uid,
    async transform(r, ctx) {
      if (!ctx.extra.roles) {
        const { data, error } = await ctx.client.schema("jms").from("roles").select("id, role_key").eq("tenant_id", ctx.tenantId);
        if (error) throw error;
        ctx.extra.roles = new Map(((data ?? []) as { id: string; role_key: string }[]).map((x) => [x.role_key, x.id]));
      }
      // Zuper lets people share an employee code ("CS", "Cleaner"); Tuper's are unique, so a code someone else here
      // already has is left off, as the first import did.
      let empCode = T(r.emp_code);
      if (empCode) {
        const me = mapGet(await ctxMap(ctx, "users"), r.user_uid);
        const { data: holders } = await ctx.client.schema("jms").from("users").select("id").eq("tenant_id", ctx.tenantId).eq("emp_code", empCode).limit(2);
        if (((holders ?? []) as { id: string }[]).some((u) => u.id !== me)) empCode = null;
      }
      return {
        emp_code: empCode, first_name: T(r.first_name) ?? "User", last_name: T(r.last_name), designation: T(r.designation),
        role_id: mapGet(ctx.extra.roles, r.role?.role_key), home_phone: T(r.home_phone_number), mobile_phone: T(r.mobile_phone_number),
        work_phone: T(r.work_phone_number), external_login_id: T(r.external_login_id), hourly_labor_charge: N(r.hourly_labor_charge),
        licence_type: T(r.license_type), is_billable: r.is_billable !== false,
        // Who added the person. Zuper's /api/user/all list leaves created_by out; its by-uid read carries it.
        ...(await createdByField(ctx, r)),
      };
    },
    insert: provisionImportedUser,
    // The person's own custom fields (GBG uses one, "Nickname") — again only on a by-uid read.
    afterWrite: (ctx, id, r) => writeZuperCustomFields(ctx, "USER", id, r.custom_fields, r.custom_field_internal_object),
  },
  assets: {
    name: "assets", schema: "jms", table: "assets", deps: ["customers", "asset_categories"], concurrency: 8,
    pages: (ctx) => zuperFilterPages(ctx.cfg, "/api/assets/filter"),
    uid: (r) => r.asset_uid,
    async transform(r, ctx) {
      const field = (label: string) => T((r.custom_fields ?? []).find((f: any) => f.label === label)?.value);
      return {
        name: T(r.asset_name) ?? "Asset", asset_code: T(r.asset_code), serial_number: T(r.asset_serial_number), model: field("Model"), manufacturer: field("Make"),
        // Zuper's own description, status, quantity and location — Tuper had nowhere for these until 00108.
        description: T(r.asset_description), plain_text_description: T(r.plain_text_description) ?? stripHtml(r.asset_description),
        status: T(r.asset_status?.status_name ?? r.asset_status),
        quantity: num0(r.asset_quantity) || 1,
        asset_location: r.asset_location && typeof r.asset_location === "object" ? r.asset_location : null,
        placed_in_service: dubaiDate(r.placed_in_service),
        purchase_date: dubaiDate(r.purchase_date), warranty_expiry: dubaiDate(r.warranty_expiry_date),
        category_id: await assetCategoryId(ctx, r.asset_category), customer_id: await customerId(ctx, r.customer),
        organization_id: await organizationId(ctx, r.organization),
        parent_asset_id: mapGet(await ctxMap(ctx, "assets"), r.parent_asset?.asset_uid),
        created_by: mapGet(await ctxMap(ctx, "users"), r.created_by?.user_uid),
        is_active: r.is_active !== false, is_deleted: r.is_deleted === true, ...createdAt(r),
      };
    },
    async afterWrite(ctx, id, r) {
      // The asset's 36 custom fields (Rental Number, battery and motor serial numbers, AMC …) — the filter list carries them.
      await writeZuperCustomFields(ctx, "ASSET", id, r.custom_fields, r.custom_field_internal_object);
      // The asset's own files (asset_attachments), when this is a by-uid read: the filter list rows carry none.
      await writeRecordFiles(ctx, "asset", id, r);
    },
  },
  contracts: {
    name: "contracts", schema: "jms", table: "service_contracts", deps: ["customers", "organizations", "products", "stock_locations"],
    // Read in full: only GET /api/service_contract/{uid} carries the description, the two addresses and the line
    // items. GBG has one contract, so this is one extra call.
    fetch: (ctx) => withDetails(ctx.cfg, "/api/service_contract/filter", (r) => `/api/service_contract/${r.contract_uid}`),
    uid: (r) => r.contract_uid,
    async transform(r, ctx) {
      const start = dubaiDate(r.start_date) ?? dubaiDate(r.created_at) ?? new Date().toISOString().slice(0, 10);
      const end = dubaiDate(r.end_date);
      return {
        contract_number: [T(r.prefix), T(r.contract_number)].filter(Boolean).join("-") || String(r.contract_uid).slice(0, 8),
        name: T(r.contract_name) ?? "Contract",
        // Zuper keeps the prefix, reference, term and sub-total apart from the number and the total (00108).
        prefix: T(r.prefix), reference_no: T(r.ref_no), term_months: num0(r.term_months) || null,
        sub_total: num0(r.contract_subtotal),
        // Zuper's contract calls this `description` (with plain_text_description and markdown_description beside it);
        // reading `contract_description` — which no contract answer has — left every imported contract with none.
        description: T(r.plain_text_description) ?? T(r.description) ?? stripHtml(r.markdown_description),
        customer_id: await customerId(ctx, r.customer), organization_id: await organizationId(ctx, r.organization),
        start_date: start, end_date: end && end >= start ? end : null,
        approval_status: T(r.approval_status), await_approval_by: mapGet(await ctxMap(ctx, "users"), r.await_approval_by?.user_uid),
        assigned_to: mapGet(await ctxMap(ctx, "users"), r.assigned_to?.[0]?.user?.user_uid ?? r.assigned_to?.user_uid),
        created_by: mapGet(await ctxMap(ctx, "users"), r.created_by?.user_uid),
        total: num0(r.contract_total),
        is_active: r.is_active !== false && r.is_expired !== true, is_deleted: r.is_deleted === true, ...createdAt(r),
      };
    },
    async afterWrite(ctx, id, r, isNew) {
      // The contract is served at one address and billed at another, and covers a list of items — all three only on
      // the by-uid read. Zuper calls the service one `customer_address`.
      await writeAddresses(ctx, "CONTRACT", id, isNew, r.customer_address, r.billing_address);
      if (Array.isArray(r.line_items)) await writeLineItems(ctx, "CONTRACT", id, r.line_items, isNew);
      // The contract's own files, when this is a by-uid read: the filter list rows carry none. Zuper's catalogue has no
      // service_contract attachment event, so these arrive on any other contract change or on the backfill.
      await writeRecordFiles(ctx, "service_contract", id, r);
    },
  },
  requests: {
    name: "requests", schema: "jms", table: "requests", deps: ["customers", "organizations", "users", "assets"],
    // Read in full: only GET /api/request/{uid} carries the asset the request is about. GBG has eight requests.
    fetch: (ctx) => withDetails(ctx.cfg, "/api/request/filter", (r) => `/api/request/${r.request_uid}`),
    uid: (r) => r.request_uid,
    async transform(r, ctx) {
      if (!ctx.extra.requestStatuses) {
        const { data, error } = await ctx.client.schema("jms").from("request_statuses").select("id, status_type").eq("tenant_id", ctx.tenantId).order("display_order", { ascending: false });
        if (error) throw error;
        ctx.extra.requestStatuses = new Map(((data ?? []) as { id: string; status_type: string }[]).map((x) => [x.status_type, x.id])); // lowest display_order wins
      }
      const priority = String(r.request_priority ?? "").toUpperCase();
      return {
        request_number: String(r.request_id ?? r.request_uid),
        title: T(r.request_title) ?? "Request",
        description: T(r.plain_text_description) ?? stripHtml(r.request_description),
        // Zuper's own rich description, so Tuper answers the request_description it answers rather than a rebuild of
        // it from the plain text (00093 added the column; nothing filled it).
        description_html: T(r.request_description),
        asset_id: mapGet(await ctxMap(ctx, "assets"), r.asset?.asset_uid),
        customer_id: await customerId(ctx, r.customer), organization_id: await organizationId(ctx, r.organization),
        status_id: mapGet(ctx.extra.requestStatuses, REQUEST_STATUS_TYPES[String(r.request_status?.status_type ?? "")] ?? "NEW"),
        priority: JOB_PRIORITIES.has(priority) ? priority : "LOW",
        assigned_to: mapGet(await ctxMap(ctx, "users"), r.assigned_to?.[0]?.user?.user_uid),
        due_date: ts(r.request_due_date), preferred_date_1: ts(r.request_preferred_date1?.start_time), preferred_date_2: ts(r.request_preferred_date2?.start_time),
        request_source: T(r.request_source?.request_source_name),
        is_deleted: r.is_deleted === true, ...createdAt(r),
      };
    },
    afterWrite: (ctx, id, r, isNew) => writeAddresses(ctx, "REQUEST", id, isNew, r.service_address, r.billing_address),
  },
  // Every job (owner decision), a page at a time. The list payload carries no description — only
  // GET /api/jobs/{uid} does — so descriptions are left untouched here (and not blanked on re-runs).
  jobs: {
    name: "jobs", schema: "jms", table: "jobs", deps: ["job_categories", "job_statuses", "customers", "organizations", "users", "teams", "service_territories"], concurrency: 8,
    pages: (ctx) => zuperFilterPages(ctx.cfg, "/api/jobs/filter"),
    uid: (r) => r.job_uid,
    async transform(r, ctx) {
      const label = `job ${r.work_order_number ?? r.job_uid}`;
      const category_id = await jobCategoryId(ctx, r.job_category);
      if (!category_id) throw new Error(`${label}: no category`);
      r._category_id = category_id; // for the status history in afterWrite
      const customer_id = await customerId(ctx, r.customer);
      const organization_id = await organizationId(ctx, r.organization);
      if (!customer_id && !organization_id) throw new Error(`${label}: no customer or organization`);
      if (r.parent_job) (ctx.extra.jobParents ??= []).push([r.job_uid, r.parent_job]);
      const custOrg = r.customer?.customer_organization?.organization_uid;
      if (r.customer?.customer_uid && custOrg) (ctx.extra.customerOrgs ??= new Map()).set(r.customer.customer_uid, custOrg);
      const priority = String(r.job_priority ?? "").toUpperCase();
      const end = ts(r.scheduled_end_time), due = ts(r.due_date);
      const description = T(r.plain_text_description) ?? stripHtml(r.job_description);
      return {
        work_order_number: String(r.work_order_number ?? r.job_uid), prefix: T(r.prefix), title: T(r.job_title) ?? "Job",
        // Zuper writes a job's description as rich text and keeps a plain copy beside it. Only the plain copy was
        // kept, so every imported job lost its formatting — the detail page and the job card both print the rich one.
        ...(description
          ? { description, plain_text_description: description, description_html: T(r.job_description), markdown_description: T(r.markdown_description) }
          : {}),
        category_id, current_status_id: await jobStatusId(ctx, r.current_job_status, category_id),
        // The colour the status had when it was set, which Zuper keeps with the job (migration 00100).
        current_status_color: hexColor(r.current_job_status?.status_color),
        priority: JOB_PRIORITIES.has(priority) ? priority : "LOW", job_type: r.job_type === "REVISIT" ? "REVISIT" : "NEW",
        customer_id, organization_id,
        scheduled_start_time: ts(r.scheduled_start_time), scheduled_end_time: end,
        // jobs_end_or_due_ck: a job needs an end or a due date.
        due_date: due ?? (end ? null : ts(r.scheduled_start_time) ?? ts(r.created_at) ?? new Date().toISOString()),
        actual_start_time: ts(r.actual_start_time), actual_end_time: ts(r.actual_end_time),
        all_day_schedule: r.all_day_schedule === true, is_delayed: r.delayed_job === true,
        is_recurring: r.is_recurrence === true,
        job_skills: ((r.skills ?? []) as any[]).map((s) => T(s?.skill_name)).filter(Boolean),
        service_territory_id: await territoryId(ctx, r.service_territory),
        service_address: zAddress(r.customer_address), billing_address: zAddress(r.customer_billing_address),
        created_by: mapGet(await ctxMap(ctx, "users"), r.created_by?.user_uid),
        is_deleted: r.is_deleted === true, ...createdAt(r),
      };
    },
    async afterWrite(ctx, id, r, isNew) {
      await writeJobAssignments(ctx, id, r, isNew);
      await writeJobHistory(ctx, id, r, isNew);
      await writeCustomFieldValues(ctx, "JOB", id, r.custom_fields);
      await writeJobTeams(ctx, id, r, isNew);
      await writeJobTags(ctx, id, r.job_tags);
      // Files attached to the job itself (not to a note or a checklist). Only a full job read carries them - the
      // list the bulk import pages through does not - and linking is additive: a file removed in Zuper stays.
      if (Array.isArray(r.attachments) && r.attachments.length) await writeZuperFiles(ctx, { type: "job", id }, r.attachments, {});
    },
    async afterAll(ctx) {
      const jobs = await ctxMap(ctx, "jobs");
      await inChunks((ctx.extra.jobParents ?? []) as [string, string][], 10, async ([child, parent]) => {
        const c = jobs.get(child), p = jobs.get(parent);
        if (c && p && c !== p) await ctx.client.schema("jms").from("jobs").update({ parent_job_id: p }).eq("id", c).eq("tenant_id", ctx.tenantId);
      });
      // The customer list has no organization; jobs name it — fill customers that have none.
      const customers = await ctxMap(ctx, "customers"), orgs = await ctxMap(ctx, "organizations");
      await inChunks([...((ctx.extra.customerOrgs ?? new Map()) as Map<string, string>)], 10, async ([cu, org]) => {
        const c = customers.get(cu), o = orgs.get(org);
        if (c && o) await ctx.client.schema("jms").from("customers").update({ organization_id: o }).eq("id", c).eq("tenant_id", ctx.tenantId).is("organization_id", null);
      });
    },
  },
  // Enrichment pass over every imported job: GET /api/jobs/{uid} for what the list leaves out — the
  // description — plus the job's custom field values (Workshop Location, PO Number), its parent job,
  // its customer's organization, its current category/status and its full status timeline (statuses
  // the workflow import lacks are created on the spot). It covers jobs from every import pass, so
  // none of this depends on one uninterrupted run of `jobs`.
  job_details: {
    name: "job_details", schema: "jms", table: "jobs", mapEntity: "jobs", enrichOnly: true,
    deps: ["customers", "organizations", "users", "assets", "teams", "service_territories"], concurrency: 6,
    async *pages(ctx) {
      const uids = [...(await ctxMap(ctx, "jobs")).keys()];
      for (let i = 0; i < uids.length; i += 100) yield uids.slice(i, i + 100).map((job_uid) => ({ job_uid }));
    },
    uid: (r) => r.job_uid,
    async transform(r, ctx) {
      const d = (await zuperGet(ctx.cfg, `/api/jobs/${r.job_uid}`)).data ?? {};
      r.custom_fields = d.custom_fields;
      r.customer = d.customer;
      r.job_status = d.job_status;
      r.assigned_to = d.assigned_to;
      r.assigned_to_team = d.assigned_to_team;
      r.job_tags = d.job_tags;
      const description = T(d.plain_text_description) ?? stripHtml(d.job_description);
      const parent = d.parent_job && d.parent_job !== r.job_uid ? mapGet(await ctxMap(ctx, "jobs"), d.parent_job) : null;
      // Category + current status as Zuper has them now — also fills jobs whose status wasn't known.
      const category = await jobCategoryId(ctx, d.job_category);
      const status = await jobStatusId(ctx, d.current_job_status, category);
      r._category_id = category;
      return {
        ...(description ? { description, plain_text_description: description, markdown_description: T(d.markdown_description) } : {}),
        ...(parent ? { parent_job_id: parent } : {}),
        ...(category ? { category_id: category } : {}),
        ...(status ? { current_status_id: status, current_status_color: hexColor(d.current_job_status?.status_color) } : {}),
        is_recurring: d.is_recurrence === true,
        job_skills: ((d.skills ?? []) as any[]).map((s) => T(s?.skill_name)).filter(Boolean),
        service_territory_id: await territoryId(ctx, d.service_territory),
        // jms.jobs holds one asset; Zuper can link several — the first is the one its lists show.
        asset_id: mapGet(await ctxMap(ctx, "assets"), (d.assets ?? [])[0]?.asset?.asset_uid),
        // The customer's feedback on the job, when they gave it (2026-09-15).
        ...(FEEDBACK_RATINGS.has(String(d.job_feedback?.rating)) ? { feedback_rating: String(d.job_feedback.rating), feedback_comment: T(d.job_feedback?.message) } : {}),
      };
    },
    async afterWrite(ctx, id, r) {
      // Rebuild the timeline only from a timeline Zuper actually returned — never blank an existing one.
      if (Array.isArray(r.job_status) && r.job_status.length) await writeJobHistory(ctx, id, r, false);
      // Its people as the detail has them — the list pass may have run before inactive staff were imported.
      if (Array.isArray(r.assigned_to)) await writeJobAssignments(ctx, id, r, false);
      await writeCustomFieldValues(ctx, "JOB", id, r.custom_fields);
      await linkCustomerOrganization(ctx, r.customer);
      await writeJobTeams(ctx, id, r, false);
      await writeJobTags(ctx, id, r.job_tags);
    },
  },
  estimates: {
    name: "estimates", schema: "jms", table: "quotes", deps: ["customers", "organizations", "jobs", "users", "products"],
    fetch: (ctx) => withDetails(ctx.cfg, "/api/estimate/filter", (r) => `/api/estimate/${r.estimate_uid}`),
    uid: (r) => r.estimate_uid,
    async transform(r, ctx) {
      const quote_date = T(r.estimate_date_dt) ?? dubaiDate(r.estimate_date) ?? dubaiDate(r.created_at) ?? new Date().toISOString().slice(0, 10);
      const expiry = T(r.expiry_date_dt) ?? dubaiDate(r.expiry_date);
      const sub = num0(r.sub_total), discount = num0(r.total_discount), total = num0(r.total);
      return {
        quote_number: String(r.estimate_no ?? r.estimate_uid),
        customer_id: await customerId(ctx, r.customer), organization_id: await organizationId(ctx, r.organization),
        job_id: mapGet(await ctxMap(ctx, "jobs"), r.job?.job_uid),
        status: r.is_converted ? "CONVERTED" : QUOTE_STATUSES[String(r.estimate_status)] ?? "DRAFT",
        quote_date, expiry_date: expiry && expiry >= quote_date ? expiry : quote_date,
        description: T(r.plain_text_description),
        sub_total: sub, total_discount: discount, total_tax: Math.max(0, r2(total - sub + discount)), total,
        tax_exempt: r.tax_exempt === true, is_converted: r.is_converted === true, accepted_date: ts(r.accepted_date),
        converted_date: ts(r.converted_date),
        created_by: mapGet(await ctxMap(ctx, "users"), r.created_by?.user_uid),
        // Zuper's Quote Details: prefix + number ("JGE33"), title, reference, sold by, tags, template, rich description.
        prefix: T(r.prefix), title: T(r.proposal_title), reference_no: T(r.reference_no),
        sold_by: mapGet(await ctxMap(ctx, "users"), (r.sold_by_user ?? r.sold_by)?.user_uid),
        tags: Array.isArray(r.tags) ? r.tags.map((t: any) => T(typeof t === "string" ? t : t?.tag_name ?? t?.name)).filter(Boolean) : [],
        template_id: await documentTemplateId(ctx, r.template?.template_uid),
        description_html: T(r.estimate_description),
        deposit_amount: r.deposit?.total == null ? null : num0(r.deposit.total), deposit_status: T(r.deposit?.status),
        is_deleted: r.is_deleted === true, ...createdAt(r),
      };
    },
    async afterWrite(ctx, id, r, isNew) {
      await writeLineItems(ctx, "QUOTE", id, r.line_items, isNew);
      await writeDocumentAddresses(ctx, "QUOTE", id, r);
      await writeQuoteStatusHistory(ctx, id, r.status_history);
      await ensureCustomFieldDefinitions(ctx, "QUOTE", (r.custom_fields ?? []).map((f: any) => String(f?.label ?? "")));
      await writeCustomFieldValues(ctx, "QUOTE", id, r.custom_fields);
      // The quote's own files. `fetch` reads every quote in full, so these come over on an import as well as on an event.
      await writeRecordFiles(ctx, "quote", id, r);
    },
  },
  invoices: {
    name: "invoices", schema: "jms", table: "invoices", deps: ["customers", "organizations", "jobs", "users", "products", "estimates"],
    fetch: (ctx) => withDetails(ctx.cfg, "/api/invoice/filter", (r) => `/api/invoice/${r.invoice_uid}`),
    uid: (r) => r.invoice_uid,
    async transform(r, ctx) {
      const invoice_date = T(r.invoice_date_dt) ?? dubaiDate(r.invoice_date) ?? dubaiDate(r.created_at) ?? new Date().toISOString().slice(0, 10);
      const due = T(r.due_date_dt) ?? dubaiDate(r.due_date);
      const sub = num0(r.sub_total), discount = num0(r.total_discount), total = num0(r.total);
      const status = r.is_paid ? "PAID" : INVOICE_STATUSES[String(r.invoice_status)] ?? "DRAFT";
      const paidAt = ((r.payment_history ?? []) as any[]).map((p) => ts(p.payment_date ?? p.paid_at ?? p.created_at)).filter(Boolean).sort();
      return {
        invoice_number: String(r.invoice_no ?? r.invoice_uid),
        customer_id: await customerId(ctx, r.customer), organization_id: await organizationId(ctx, r.organization),
        job_id: mapGet(await ctxMap(ctx, "jobs"), r.job?.job_uid), quote_id: mapGet(await ctxMap(ctx, "estimates"), r.estimate?.estimate_uid),
        status, invoice_date, due_date: due && due >= invoice_date ? due : invoice_date,
        sub_total: sub, total_discount: discount, total_tax: Math.max(0, r2(total - sub + discount)), total, amount_paid: num0(r.amount_paid),
        paid_date: status === "PAID" ? paidAt[paidAt.length - 1] ?? ts(r.updated_at) : null,
        tax_exempt: r.tax_exempt === true, created_by: mapGet(await ctxMap(ctx, "users"), r.created_by?.user_uid),
        // Zuper's Invoice Details: its own title (which is not the description), prefix, reference, tags, the
        // template it prints with and the payment term it is due on. None of these were being read, so every
        // imported invoice answered null for them.
        title: T(r.invoice_title), prefix: T(r.prefix), reference_no: T(r.reference_no),
        description: T(r.plain_text_description) ?? T(r.description),
        tags: Array.isArray(r.tags) ? r.tags.map((t: any) => T(typeof t === "string" ? t : t?.tag_name ?? t?.name)).filter(Boolean) : [],
        template_id: await documentTemplateId(ctx, r.template?.template_uid),
        payment_term_id: await paymentTermId(ctx, r.payment_term),
        is_deleted: r.is_deleted === true, ...createdAt(r),
      };
    },
    async afterWrite(ctx, id, r, isNew) {
      await writeLineItems(ctx, "INVOICE", id, r.line_items, isNew);
      // The invoice's own addresses — a snapshot of where the work was and who was billed when it was raised, not
      // the customer's address of today. writeDocumentAddresses has taken "INVOICE" since it was written; it was
      // only ever called for quotes, so every invoice answered an empty address (FIELD-PARITY 2026-09-21).
      await writeDocumentAddresses(ctx, "INVOICE", id, r);
      await writeDocumentAddresses(ctx, "INVOICE", id, r);
      // The invoice's Zoho Books invoice id and its siblings, with Zuper's own key for each (custom_field_internal_object).
      await writeZuperCustomFields(ctx, "INVOICE", id, r.custom_fields, r.custom_field_internal_object);
      // The invoice's own files. `fetch` reads every invoice in full, so these come over on an import as well as on an event.
      await writeRecordFiles(ctx, "invoice", id, r);
    },
  },
};

// Second pass over the job list, oldest first, bringing in only jobs not yet imported. Zuper's offset
// paging fails intermittently past ~27,000 records, so `jobs` (newest first) and this pass each stay
// at shallow offsets. It stops on reaching `jobs`' territory: the first page made up entirely of jobs
// mapped before this pass ever ran (so re-runs still sweep the gaps an earlier run left).
ENTITIES.jobs_oldest = {
  ...ENTITIES.jobs, name: "jobs_oldest", mapEntity: "jobs",
  async *pages(ctx) {
    const imported = await ctxMap(ctx, "jobs");
    const firstRun = await storeOne<{ started_at: string }>(
      `SELECT started_at FROM sync.runs WHERE tenant_id = $1 AND entity = 'jobs_oldest'
        ORDER BY started_at ASC LIMIT 1`, [ctx.tenantId]);
    const cutoff = firstRun?.started_at ?? new Date().toISOString();
    const newestFirst = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await ctx.client.schema("jms").from("zuper_sync_map").select("zuper_uid")
        // Ordered: an unordered paged read can skip rows, which here would re-sync jobs that were already done.
        .eq("tenant_id", ctx.tenantId).eq("entity", "jobs").lt("synced_at", cutoff).order("zuper_uid").range(from, from + 999);
      if (error) throw error;
      for (const m of (data ?? []) as { zuper_uid: string }[]) newestFirst.add(m.zuper_uid);
      if (!data || data.length < 1000) break;
    }
    for await (const rows of zuperFilterPages(ctx.cfg, "/api/jobs/filter", 100, { sort: "ASC", sort_by: "created_at" })) {
      if (rows.every((r) => newestFirst.has(r.job_uid))) return;
      const missing = rows.filter((r) => !imported.has(r.job_uid));
      if (missing.length) yield missing;
    }
  },
};

// ── Who made a record, and its custom fields ─────────────────────────────────────────────────────────────────
// FIELD-PARITY (2026-09-20): Zuper answered `created_by` and the Zoho integration's custom fields on every sampled
// customer, organization, user, asset and invoice, and Tuper answered null / []. Two causes, both fixed above — the
// importers did not map them, and Zuper's LISTS carry only some of them (the customer and user lists carry neither
// created_by nor custom fields; the organization list carries created_by but no custom fields; the asset and invoice
// filter lists carry both). These passes fill what the import already behind us never saw. They only update records
// already imported (enrichOnly) and write nothing but those two things, so re-running one is cheap and safe.
const zuperFieldPass = (
  name: string, table: string, mapEntity: string, entityType: string,
  source: { pages: (ctx: Ctx) => AsyncGenerator<any[]>; uid: (r: any) => string; detail?: (uid: string) => string },
): Entity => ({
  name, schema: "jms", table, mapEntity, enrichOnly: true, deps: ["users"], concurrency: source.detail ? 6 : 8,
  pages: source.pages,
  uid: source.uid,
  async transform(r, ctx) {
    // A kind whose list carries neither is read one record at a time; one whose list carries them is not read twice.
    if (source.detail) r._fields = (await zuperGet(ctx.cfg, source.detail(source.uid(r)))).data ?? {};
    return createdByField(ctx, r._fields ?? r);
  },
  afterWrite(ctx, id, r) {
    const d = r._fields ?? r;
    return writeZuperCustomFields(ctx, entityType, id, d.custom_fields, d.custom_field_internal_object);
  },
});
/** Every record of a kind Tuper has mapped to a Zuper uid, a hundred uids at a time. */
const mappedUids = (entity: string, key: string) => async function* (ctx: Ctx): AsyncGenerator<any[]> {
  const uids = [...(await ctxMap(ctx, entity)).keys()];
  for (let i = 0; i < uids.length; i += 100) yield uids.slice(i, i + 100).map((uid) => ({ [key]: uid }));
};
ENTITIES.customer_fields = zuperFieldPass("customer_fields", "customers", "customers", "CUSTOMER", {
  pages: mappedUids("customers", "customer_uid"), uid: (r) => r.customer_uid, detail: (u) => `/api/customers/${u}`,
});
ENTITIES.organization_fields = zuperFieldPass("organization_fields", "organizations", "organizations", "ORGANIZATION", {
  pages: mappedUids("organizations", "organization_uid"), uid: (r) => r.organization_uid, detail: (u) => `/api/organization/${u}`,
});
ENTITIES.user_fields = zuperFieldPass("user_fields", "users", "users", "USER", {
  pages: mappedUids("users", "user_uid"), uid: (r) => r.user_uid, detail: (u) => `/api/user/${u}`,
});
ENTITIES.asset_fields = zuperFieldPass("asset_fields", "assets", "assets", "ASSET", {
  pages: (ctx) => zuperFilterPages(ctx.cfg, "/api/assets/filter"), uid: (r) => r.asset_uid,
});
ENTITIES.invoice_fields = zuperFieldPass("invoice_fields", "invoices", "invoices", "INVOICE", {
  pages: (ctx) => zuperFilterPages(ctx.cfg, "/api/invoice/filter"), uid: (r) => r.invoice_uid,
});

// ── What only a record's own read carries ──
// POST /api/assets/filter and GET /api/customers page quickly but answer a SHORTER record than the by-uid read does.
// The import was built on those lists, so the columns below were never written at all — not stale, never filled:
//   · an asset's billing address, useful life, purchase and residual price, picture, barcode, additional info,
//     whether the customer owns it, its parts, who it is assigned to and its secondary customers;
//   · a customer's notification preferences (call / sms / email).
// Each pass re-reads every record Tuper has mapped and writes only those columns, so it can be re-run at any time and
// never touches what the list pass is responsible for.

ENTITIES.asset_details = {
  name: "asset_details", schema: "jms", table: "assets", mapEntity: "assets", enrichOnly: true,
  deps: ["customers", "users", "teams", "products", "stock_locations"], concurrency: 6,
  pages: mappedUids("assets", "asset_uid"),
  uid: (r) => r.asset_uid,
  async transform(r, ctx) {
    const d = (await zuperGet(ctx.cfg, `/api/assets/${r.asset_uid}`)).data ?? {};
    r._detail = d;
    const [customers, users, teams, products, locations] = await Promise.all([
      ctxMap(ctx, "customers"), ctxMap(ctx, "users"), ctxMap(ctx, "teams"), ctxMap(ctx, "products"), ctxMap(ctx, "stock_locations"),
    ]);
    const life = d.useful_life && typeof d.useful_life === "object" ? d.useful_life : null;
    const lifeType = T(life?.type)?.toUpperCase();
    // Zuper's asset_location is on the list too; the detail is the newer copy, so it is refreshed here as well.
    const location = d.asset_location && typeof d.asset_location === "object" ? d.asset_location : null;
    const billing = d.billing_address && typeof d.billing_address === "object" ? d.billing_address : null;
    return {
      ...(location ? { asset_location: location } : {}),
      billing_address: billing,
      useful_life_type: lifeType === "MONTHS" || lifeType === "YEARS" || lifeType === "DAYS" ? lifeType : null,
      useful_life_value: life?.value == null ? null : num0(life.value),
      purchase_price: N(d.purchase_price), residual_price: N(d.residual_price),
      asset_image: T(d.asset_image), asset_barcode: T(d.asset_barcode), additional_info: T(d.additional_info),
      // Null until now, which made the record answer whatever its customer link implied rather than what Zuper says.
      owned_by_customer: d.owned_by_customer === true,
      product_id: mapGet(products, d.asset_product?.product_uid),
      location_id: mapGet(locations, d.location?.location_uid),
      asset_parts: ((d.asset_parts ?? []) as any[]).map((p) => ({
        product_id: mapGet(products, p?.product_id?.product_uid ?? p?.product_uid),
        quantity: num0(p?.quantity) || 1,
        serial_nos: ((p?.serial_nos ?? []) as unknown[]).map((s) => String(s)).filter(Boolean),
      })).filter((p) => p.product_id),
      assignees: ((d.assigned_to ?? []) as any[]).map((a) => ({
        user_id: mapGet(users, a?.user?.user_uid), team_id: mapGet(teams, a?.team?.team_uid),
      })).filter((a) => a.user_id || a.team_id),
      secondary_customer_ids: [...new Set(((d.secondary_customers ?? []) as any[])
        .map((c) => mapGet(customers, c?.customer_uid)).filter((x): x is string => Boolean(x)))],
    };
  },
  // The detail read is the only one that carries the asset's files; the filter list rows carry none.
  afterWrite: (ctx, id, r) => writeRecordFiles(ctx, "asset", id, r._detail ?? r).then(() => undefined),
};

ENTITIES.customer_details = {
  name: "customer_details", schema: "jms", table: "customers", mapEntity: "customers", enrichOnly: true,
  concurrency: 6,
  pages: mappedUids("customers", "customer_uid"),
  uid: (r) => r.customer_uid,
  async transform(r, ctx) {
    const d = (await zuperGet(ctx.cfg, `/api/customers/${r.customer_uid}`)).data ?? {};
    const n = d.customer_notifications;
    // Only what the list cannot say. A customer whose detail carries no preferences is left as it is.
    if (!n || typeof n !== "object") return {};
    return { notifications: { email: n.email !== false, sms: n.sms === true, call: n.call === true } };
  },
};

// ── Shift Management ── master shifts (Settings › Timesheets › Master Shifts) and the user shifts planned
// from them: GET /api/timesheet/user_shifts, one person's shift on one day (~17k for GBG from 2025 on).
const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
/** Zuper's "08:30 AM" → "08:30" (a 24-hour "17:30" passes through). */
function clock24(v: any): string | null {
  const m = String(v ?? "").trim().match(/^(\d{1,2}):(\d{2})\s*([AP]M)?$/i);
  if (!m) return null;
  const h = m[3] ? (Number(m[1]) % 12) + (m[3].toUpperCase() === "PM" ? 12 : 0) : Number(m[1]);
  return h < 24 ? `${String(h).padStart(2, "0")}:${m[2]}` : null;
}
ENTITIES.master_shifts = {
  name: "master_shifts", schema: "jms", table: "shifts", deps: ["users"],
  fetch: (ctx) => zuperGet(ctx.cfg, "/api/timesheet/master_shifts?page=1&count=200").then((j) => j.data ?? []),
  uid: (r) => r.master_shift_uid,
  async transform(r, ctx) {
    // A weekly rule's BYDAY; a daily one (or none) repeats every day.
    const byday = /BYDAY=([A-Z,]+)/.exec(String(r.rrule ?? ""))?.[1].split(",").filter((d) => BYDAY.includes(d)) ?? [];
    return {
      name: T(r.master_shift_name) ?? "Shift",
      start_time: clock24(r.shift_from) ?? "09:00", end_time: clock24(r.shift_to) ?? "18:00",
      days: byday.length ? byday : BYDAY,
      is_active: r.is_deleted !== true,
      created_by: mapGet(await ctxMap(ctx, "users"), r.created_by_user?.user_uid),
    };
  },
};
// A week at a time: Zuper's list has no stable order, so paging one big window repeats some records and skips
// others (seen: 640 of 13,914). A week is one page of 500. Zuper's list needs both ends of a date window; it
// starts at the oldest shift and runs to a year ahead. Shifts of people who are not Tuper users (only active
// staff were imported) are left out.
ENTITIES.user_shifts = {
  name: "user_shifts", schema: "jms", table: "user_shifts", deps: ["users", "teams"], concurrency: 8,
  async *pages(ctx) {
    const users = await ctxMap(ctx, "users");
    const until = new Date(Date.now() + 366 * 86_400_000).toISOString().slice(0, 10);
    const oldest = (await zuperGet(ctx.cfg, `/api/timesheet/user_shifts?filter.start_date=2019-01-01&filter.end_date=${until}&page=1&count=1`)).data?.[0];
    const first = dubaiDate(oldest?.start_date_time);
    if (!first) return;
    let leftOut = 0;
    for (let from = first; from <= until; from = addDaysYmd(from, 7)) {
      const to = addDaysYmd(from, 6);
      for await (const page of zuperListPages(ctx.cfg, `/api/timesheet/user_shifts?filter.start_date=${from}&filter.end_date=${to}`, 500)) {
        const ours = page.filter((s) => users.has(String(s.user_details?.user_uid ?? "")));
        leftOut += page.length - ours.length;
        if (ours.length) yield ours;
      }
    }
    if (leftOut && process.env.ZUPER_SYNC_LOG) console.log(`  user_shifts: ${leftOut} left out — not a Tuper user`);
  },
  uid: (r) => r.shift_uid,
  async transform(r, ctx) {
    const users = await ctxMap(ctx, "users");
    const userId = mapGet(users, r.user_details?.user_uid);
    if (!userId || !r.start_date_time || !r.end_date_time) return null;
    // The master shift it was made from, by name — older labels ("Morning Shift 1 Excl Sun") have none now.
    if (!ctx.extra.masterShiftByName) {
      const { data, error } = await ctx.client.schema("jms").from("shifts").select("id, name").eq("tenant_id", ctx.tenantId);
      if (error) throw error;
      ctx.extra.masterShiftByName = new Map(((data ?? []) as { id: string; name: string }[]).map((s) => [s.name.trim().toLowerCase(), s.id]));
    }
    const label = T(r.shift_label) ?? "Shift";
    return {
      user_id: userId,
      shift_id: ctx.extra.masterShiftByName.get(label.toLowerCase()) ?? null,
      team_id: mapGet(await ctxMap(ctx, "teams"), r.team?.team_uid),
      label, starts_at: String(r.start_date_time), ends_at: String(r.end_date_time),
      remarks: T(r.shift_remarks), is_approved: r.is_approved !== false, approval_remarks: T(r.approval_remarks),
      approved_by: mapGet(users, r.approval_by_user?.user_uid), approved_at: ts(r.approved_at),
      is_active: r.is_active !== false, is_deleted: r.is_deleted === true,
      created_by: mapGet(users, r.created_by_user?.user_uid), ...createdAt(r),
    };
  },
};

// ── Timesheets ── punches, from the list the web app reads (POST /api/timesheets/filter), a year at a time
// (0 repeats that way). Zuper's Break / Resume Work are Tuper's BREAK_START / BREAK_END. Punches of people who
// are not Tuper users are left out (as of 2026-09-12: 1,973 punches, 538 of them by Tuper users).
const PUNCH_TYPES: Record<string, string> = { CHECK_IN: "CHECK_IN", CHECK_OUT: "CHECK_OUT", BREAK: "BREAK_START", RESUME_WORK: "BREAK_END" };
const punchUserUid = (p: any): string | undefined => p?.users?.user_uid ?? (Array.isArray(p?.users) ? p.users[0]?.user_uid : undefined);
ENTITIES.timesheets = {
  name: "timesheets", schema: "jms", table: "timesheets", deps: ["users"], concurrency: 8,
  async *pages(ctx) {
    const users = await ctxMap(ctx, "users");
    let leftOut = 0;
    for (let year = 2019; year <= new Date().getUTCFullYear(); year++) {
      const window = { count: 100, preferred_timezone: "Asia/Dubai", "filter.from_date": `${year}-01-01`, "filter.to_date": `${year}-12-31`, filter_rule_operator: "AND" };
      for await (const rows of zuperFilterPages(ctx.cfg, "/api/timesheets/filter", 100, window)) {
        const ours = rows.filter((p) => users.has(String(punchUserUid(p) ?? "")));
        leftOut += rows.length - ours.length;
        if (ours.length) yield ours;
      }
    }
    if (leftOut && process.env.ZUPER_SYNC_LOG) console.log(`  timesheets: ${leftOut} left out — not a Tuper user`);
  },
  uid: (r) => r.employee_timesheet_uid,
  async transform(r, ctx) {
    const userId = mapGet(await ctxMap(ctx, "users"), punchUserUid(r));
    const checkType = PUNCH_TYPES[String(r.type_of_check)];
    if (!userId || !checkType || !r.checked_time) return null;
    return {
      user_id: userId, check_type: checkType, checked_time: punchTime(r.checked_time),
      latitude: N(r.latitude), longitude: N(r.longitude), auth_photo_url: T(r.auth_pic), remarks: T(r.remarks), ...createdAt(r),
    };
  },
};

// ── Parts & Services stock ── Zuper's product locations (its warehouses), each product's stock at them, and the
// stock movements between them (GET /api/product/transaction).
const snakeKey = (label: string) => label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field";

/** Tuper definitions (single-line text) for the custom-field labels Zuper uses on an entity and Tuper hasn't got yet,
 *  so writeCustomFieldValues has somewhere to put their values. */
async function ensureCustomFieldDefinitions(ctx: Ctx, entityType: string, labels: string[]): Promise<void> {
  const known: Set<string> = (ctx.extra[`customFieldLabels:${entityType}`] ??= new Set<string>());
  const fresh = [...new Set(labels.map((l) => l.trim()).filter(Boolean))].filter((l) => !known.has(l.toLowerCase()));
  if (!fresh.length) return;
  await once(ctx, `customFieldDefinitions:${entityType}:${fresh.join("|").toLowerCase()}`, async () => {
    const { data: existing, error } = await ctx.client.schema("jms").from("custom_field_definitions").select("label, display_order").eq("tenant_id", ctx.tenantId).eq("entity_type", entityType);
    if (error) throw error;
    const defs = (existing ?? []) as { label: string; display_order: number | null }[];
    const have = new Set(defs.map((d) => d.label.trim().toLowerCase()));
    let order = Math.max(0, ...defs.map((d) => d.display_order ?? 0));
    const rows = fresh.filter((l) => !have.has(l.toLowerCase()))
      .map((label) => ({ tenant_id: ctx.tenantId, entity_type: entityType, field_key: snakeKey(label), label, field_type: "SINGLE_LINE_TEXT", display_order: ++order }));
    if (rows.length) {
      const { error: insertError } = await ctx.client.schema("jms").from("custom_field_definitions").upsert(rows, { onConflict: "tenant_id,entity_type,field_key", ignoreDuplicates: true });
      if (insertError) throw insertError;
      delete ctx.extra[`customFieldDefs:${entityType}`]; // writeCustomFieldValues reloads them
    }
    return null;
  });
  for (const l of fresh) known.add(l.toLowerCase());
}

/** Tuper's location for a Zuper product location. One Zuper has since deleted (a movement still names it) is found
 *  by name, or added — inactive when `active` is false. */
async function stockLocationId(ctx: Ctx, loc: any, active = true): Promise<string | null> {
  const uid = T(loc?.location_uid), name = T(loc?.location_name);
  const map = await ctxMap(ctx, "stock_locations");
  if (uid && map.has(uid)) return map.get(uid)!;
  if (!name) return null;
  return once(ctx, `stock_location:${uid ?? name}`, async () => {
    const { data: found, error } = await ctx.client.schema("jms").from("locations").select("id").eq("tenant_id", ctx.tenantId).eq("name", name).maybeSingle();
    if (error) throw error;
    let id = (found as { id: string } | null)?.id;
    if (!id) {
      const made = await ctx.client.schema("jms").from("locations").insert({ tenant_id: ctx.tenantId, name, location_type: "WAREHOUSE", is_active: active }).select("id").single();
      if (made.error) throw made.error;
      id = (made.data as { id: string }).id;
    }
    if (uid) await setMap(ctx, "stock_locations", uid, id);
    return id;
  });
}

/** A product's stock at each location (Zuper's location_availability) and its custom fields. */
async function writeProductStockAndFields(ctx: Ctx, productId: string, r: any): Promise<void> {
  const stock = new Map<string, Record<string, unknown>>();
  for (const a of (r.location_availability ?? []) as any[]) {
    const locationId = await stockLocationId(ctx, a.location, a.location?.is_deleted !== true);
    if (!locationId) continue;
    stock.set(locationId, { tenant_id: ctx.tenantId, product_id: productId, location_id: locationId, quantity: num0(a.quantity), min_quantity: num0(a.min_quantity), serial_nos: ((a.serial_nos ?? []) as unknown[]).map(String) });
  }
  if (stock.size) {
    const { error } = await ctx.client.schema("jms").from("product_locations").upsert([...stock.values()], { onConflict: "product_id,location_id" });
    if (error) throw error;
  }
  const fields = (r.custom_fields ?? []) as any[];
  if (fields.length) {
    await ensureCustomFieldDefinitions(ctx, "PRODUCT", fields.map((f) => String(f?.label ?? "")));
    await writeCustomFieldValues(ctx, "PRODUCT", productId, fields);
    // Zuper lists a product's own fields, empty ones too ("Reorder Level ---"), so an empty one is kept as "".
    const defs: Map<string, { id: string }> | undefined = ctx.extra["customFieldDefs:PRODUCT"];
    const empty = [...new Set(fields.filter((f) => !T(f?.value)).map((f) => defs?.get(String(f?.label ?? "").trim().toLowerCase())?.id).filter((id): id is string => Boolean(id)))];
    if (empty.length) {
      const { error } = await ctx.client.schema("jms").from("custom_field_values")
        .upsert(empty.map((definition_id) => ({ tenant_id: ctx.tenantId, definition_id, entity_type: "PRODUCT", entity_id: productId, value_text: "" })), { onConflict: "definition_id,entity_id" });
      if (error) throw error;
    }
  }
}

// Zuper's product categories ("goods", "service" …) — run before products, which file each part under one.
ENTITIES.product_categories = {
  name: "product_categories", schema: "jms", table: "product_categories",
  fetch: (ctx) => zuperGet(ctx.cfg, "/api/products/category?page=1&count=500").then((j) => j.data ?? []),
  uid: (r) => r.category_uid,
  async transform(r) { return { name: T(r.category_name) ?? "Category" }; },
};
ENTITIES.stock_locations = {
  name: "stock_locations", schema: "jms", table: "locations",
  fetch: (ctx) => zuperGet(ctx.cfg, "/api/products/location?page=1&count=500").then((j) => j.data ?? []),
  uid: (r) => r.location_uid,
  async transform(r) {
    return { name: T(r.location_name) ?? "Location", location_type: T(r.location_type) ?? "WAREHOUSE", is_active: r.is_deleted !== true };
  },
};
// INWARD, TRANSFER, CONSUMED … with where from and to, the quantity before, remarks and the document behind them.
// Most of GBG's are 2023 transfers Zuper made when locations were deleted.

/** The movements Tuper keeps (lib/list-contract/inventory.ts STOCK_ACTIONS). */
const STOCK_ACTIONS = new Set(["INWARD", "OUTWARD", "TRANSFER", "ADJUSTMENT", "CONSUMED"]);
/**
 * Which movement this is.
 *
 * Zuper sends two fields and only one of them is the movement: `type` is INWARD / TRANSFER / CONSUMED, while
 * `transaction_type` is the family — TRANSACTION for the first two, CONSUMPTION for the last. Falling back to the
 * family wrote "TRANSACTION" or "CONSUMPTION" into txn_type, which is not a movement Tuper knows. A movement that
 * names a document (module_name INVOICE, JOB …) is a consumption, and inventory.ts reads it that way.
 */
const stockAction = (r: any): string => {
  const t = String(r?.type ?? "").trim().toUpperCase();
  if (STOCK_ACTIONS.has(t)) return t;
  if (/CONSUM/.test(String(r?.transaction_type ?? "").toUpperCase()) || T(r?.module_name)) return "CONSUMED";
  return "TRANSFER";   // what every movement of GBG's is, and what this wrote before there was anything else to say
};

ENTITIES.product_transactions = {
  name: "product_transactions", schema: "jms", table: "product_transactions", deps: ["products", "users", "stock_locations"], concurrency: 8,
  pages: (ctx) => zuperListPages(ctx.cfg, "/api/product/transaction", 100),
  uid: (r) => r.transaction_uid,
  async transform(r, ctx) {
    const productUid = T(r.product?.product_uid);
    const productId = mapGet(await ctxMap(ctx, "products"), productUid);
    // jms.product_transactions.product_id is NOT NULL: a movement has to hang off a part. Zuper keeps movements of
    // parts it has since deleted — `GET /api/product/{uid}` answers "Invalid Product UID" for them and its own product
    // list leaves them out — so those cannot come over. Said plainly, because it is the reason a run reports failures.
    if (!productId) throw new Error(`stock movement ${r.transaction_uid}: its part ${productUid ?? "(none named)"} (${T(r.product?.product_name) ?? "unnamed"}) is not in Zuper's product list`);
    return {
      product_id: productId,
      location_id: r.from_location ? await stockLocationId(ctx, r.from_location, false) : null,
      to_location_id: r.to_location ? await stockLocationId(ctx, r.to_location, false) : null,
      txn_type: stockAction(r),
      quantity: num0(r.quantity), old_quantity: N(r.old_quantity), unit_cost: N(r.purchase_price),
      remarks: T(r.remarks), serial_nos: ((r.serial_nos ?? []) as unknown[]).map(String),
      module_name: T(r.module_name), module_ref: T(r.module_uid),
      // A voided movement stays for the audit trail and drops out of the API's list (00145).
      is_deleted: r.is_deleted === true,
      created_by: mapGet(await ctxMap(ctx, "users"), r.created_by?.user_uid), ...createdAt(r),
    };
  },
};

// ── Run one entity ──
// ── Everything else from Zuper (owner, 2026-09-15: "migrate all data from zuper") ──

// Zuper's inactive staff, so their notes, time off and job history keep their names (see provisionImportedUser). Zuper's
// own test user (TUPER…) is left out.
ENTITIES.inactive_users = {
  ...ENTITIES.users, name: "inactive_users", mapEntity: "users",
  async *pages(ctx) {
    for await (const page of zuperListPages(ctx.cfg, "/api/user/all")) {
      const gone = page.filter((u) => (u.is_active === false || u.is_deleted === true) && T(u.email) && !/TUPER/i.test(`${u.first_name ?? ""} ${u.last_name ?? ""} ${u.emp_code ?? ""}`));
      if (gone.length) yield gone;
    }
  },
  insert: (ctx, payload, r) => provisionImportedUser(ctx, payload, r, { inactive: true }),
};

// Time off: Zuper's types and every request (GET /api/timesheet/request/timeoff_type, /api/timesheets/request/timeoff —
// the whole list in one reply). start_date / end_date are the company's calendar days, so a part-day request keeps its
// day; Zuper's own two instants are kept beside them (00141), so a request answers the window it was actually asked
// for rather than the whole day. Zuper attributes a request to TWO people — `requested_by` is whose leave it is and
// `created_by_user` is whoever raised it (at GBG a manager, on 646 of 651 requests) — and Tuper keeps both:
// user_id and created_by. Nothing is sent for approval: each keeps Zuper's outcome and its approver's remarks.
/** Zuper's allowed reasons (00141's check constraint); anything else is left unset rather than refused. */
const TIMEOFF_REASONS = new Set(["OFF", "VACATION", "SICK", "PARENTAL LEAVE", "UNPAID", "OTHERS", "CUSTOM"]);
/** An exempt day, as Zuper writes it: the last second of that day in UTC with no zone marker ("2026-08-25 19:59:59"). */
const exemptDay = (v: any): string | null => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return dubaiDate(/([zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
};
ENTITIES.timeoff_types = {
  name: "timeoff_types", schema: "jms", table: "timeoff_types", deps: ["users"],
  fetch: (ctx) => zuperGet(ctx.cfg, "/api/timesheet/request/timeoff_type").then((j) => j.data ?? []),
  uid: (r) => r.timeoff_request_type_uid,
  async transform(r, ctx) {
    return {
      name: T(r.name) ?? "Time Off", is_paid: !/UNPAID/i.test(String(r.type ?? "")), is_active: r.is_deleted !== true,
      no_of_days_per_year: Math.max(0, Math.round(num0(r.no_of_days_per_year))),
      display_order: r.display_order == null || r.display_order === "" ? null : Math.round(Number(r.display_order)),
      created_by: mapGet(await ctxMap(ctx, "users"), r.created_by_user?.user_uid),
      ...createdAt(r),
    };
  },
};
ENTITIES.timeoff_requests = {
  name: "timeoff_requests", schema: "jms", table: "timeoff_requests", deps: ["users", "teams", "timeoff_types"], concurrency: 8,
  fetch: (ctx) => zuperGet(ctx.cfg, "/api/timesheets/request/timeoff").then((j) => j.data ?? []),
  uid: (r) => r.request_uid,
  async transform(r, ctx) {
    const users = await ctxMap(ctx, "users");
    const userId = mapGet(users, r.requested_by?.user_uid);
    if (!userId) throw new Error(`time off ${r.request_uid}: ${r.requested_by ? "the person isn't imported" : "no person"}`);
    const start = dubaiDate(r.request_from);
    if (!start) throw new Error(`time off ${r.request_uid}: no start date`);
    const end = dubaiDate(r.request_to);
    const status = String(r.approval_status ?? "").toUpperCase();
    const typeUid = r.timeoff_request_type?.timeoff_request_type_uid ?? r.timeoff_request_type_uid;
    const reason = T(r.request_reason)?.toUpperCase().replace(/_/g, " ");
    const remarks = T(r.request_remarks);
    // Zuper's two instants, kept only when they run the right way round (00141's check).
    const from = ts(r.request_from), to = ts(r.request_to);
    const ordered = from && to && Date.parse(to) >= Date.parse(from);
    return {
      user_id: userId, type_id: mapGet(await ctxMap(ctx, "timeoff_types"), typeUid),
      start_date: start, end_date: end && end >= start ? end : start,
      request_from: ordered ? from : null, request_to: ordered ? to : null,
      all_day: r.all_day !== false,
      request_reason: reason && TIMEOFF_REASONS.has(reason) ? reason : null,
      request_remarks: remarks, reason: remarks,
      approval_status: status === "APPROVED" ? "APPROVED" : /REJECT|DECLIN/.test(status) ? "REJECTED" : "PENDING",
      approval_remarks: T(r.approval_remarks),
      no_of_days: Number.isFinite(Number(r.no_of_days)) ? Number(r.no_of_days) : null,
      exempt_dates: [...new Set(((Array.isArray(r.exempt_dates) ? r.exempt_dates : []) as any[]).map(exemptDay).filter((d): d is string => Boolean(d)))],
      team_id: mapGet(await ctxMap(ctx, "teams"), r.requested_by_team?.team_uid),
      created_by: mapGet(users, r.created_by_user?.user_uid),
      approved_by: mapGet(users, r.approved_by_user?.user_uid), approved_at: ts(r.approved_at), ...createdAt(r),
    };
  },
};

// ── Timesheet locations ── Zuper's named places with a geofence (a point and a radius in metres) and the people
// assigned to each. GET /api/timesheet/location is the paged list; GET /api/timesheet/location/{uid} answers that
// location's people ("employee locations"), which the list row does not always carry. GBG's Zuper holds none today
// (read-only, 2026-09-21: total_records 0), so the fields below are the ones Zuper's own location object names —
// the same ones Tuper answers with (apps/JMS/web/src/lib/api/timesheets-shape.ts, shapeLocation). The first
// location made in Zuper is what proves them; because only mapped fields are written, a surprise shows up as a
// failed sync in the log rather than a row full of nulls.
/** Zuper's timesheet locations, page by page. `maxPages` bounds a catch-up; it is a short list. */
export async function* zuperTimesheetLocations(cfg: SyncConfig, maxPages = 20): AsyncGenerator<any[]> {
  let seen = 0;
  for (let page = 1; page <= maxPages; page++) {
    const j = await zuperGet(cfg, `/api/timesheet/location?page=${page}&count=100`);
    const rows: any[] = j?.data ?? [];
    if (!rows.length) return;
    seen += rows.length;
    yield rows;
    const total = Number(j?.total_records);
    if (Number.isFinite(total) && seen >= total) return;
    if (rows.length < 100) return;
  }
}
/** The people assigned to a location. Replaced, not merged, so someone taken off in Zuper is taken off here —
 *  but only when Zuper actually said who they are; silence leaves the assignments alone. */
async function writeLocationUsers(ctx: Ctx, locationId: string, row: any): Promise<void> {
  const r = row?.location ?? row;
  const named = (v: any) => (Array.isArray(v) ? v : null);
  let people = named(r?.users) ?? named(r?.user_uids) ?? named(r?.employees) ?? named(r?.assigned_users) ?? named(r?.employee_locations);
  if (!people && r?.location_uid) {
    const d = (await zuperGet(ctx.cfg, `/api/timesheet/location/${r.location_uid}`))?.data;
    people = named(d) ?? named(d?.users) ?? named(d?.employees) ?? named(d?.employee_locations);
  }
  if (!people) return;
  const users = await ctxMap(ctx, "users");
  const seen = new Set<string>();
  const rows: { tenant_id: string; location_id: string; user_id: string }[] = [];
  for (const p of people) {
    const id = mapGet(users, typeof p === "string" ? p : p?.user_uid ?? p?.user?.user_uid);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({ tenant_id: ctx.tenantId, location_id: locationId, user_id: id });
  }
  const table = () => ctx.client.schema("jms").from("timesheet_location_users");
  const { error: gone } = await table().delete().eq("tenant_id", ctx.tenantId).eq("location_id", locationId);
  if (gone) throw gone;
  if (rows.length) { const { error } = await table().insert(rows); if (error) throw error; }
}
ENTITIES.timesheet_locations = {
  name: "timesheet_locations", schema: "jms", table: "timesheet_locations", deps: ["users"],
  pages: (ctx) => zuperTimesheetLocations(ctx.cfg),
  uid: (row) => (row.location ?? row).location_uid,
  async transform(row, ctx) {
    const r = row.location ?? row;
    // Zuper writes a point either as latitude/longitude or as geo_cordinates [lat, lng] (its spelling); 0,0 is unset,
    // and the table takes both halves or neither.
    const geo: any[] = Array.isArray(r.geo_cordinates) ? r.geo_cordinates : Array.isArray(r.geo_coordinates) ? r.geo_coordinates : [];
    const lat = N(geo.length === 2 ? geo[0] : r.latitude), lng = N(geo.length === 2 ? geo[1] : r.longitude);
    const point = lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0);
    const radius = Math.round(Number(r.radius));
    return {
      location_name: T(r.location_name) ?? T(r.name) ?? "Location",
      latitude: point ? lat : null, longitude: point ? lng : null,
      address: r.address == null ? null : typeof r.address === "object" ? JSON.stringify(r.address) : T(r.address),
      radius: Number.isFinite(radius) && radius > 0 ? radius : 100,   // the table's own default
      is_deleted: r.is_deleted === true || r.is_deleted === 1,
      created_by: mapGet(await ctxMap(ctx, "users"), r.created_by_user?.user_uid ?? r.created_by?.user_uid),
      ...createdAt(r),
    };
  },
  afterWrite: (ctx, id, r) => writeLocationUsers(ctx, id, r),
};

// ── Timesheet approvals ── a person's timesheets over a period sent for approval. GET /api/timesheet/approval
// (page + count required, newest first) lists them under data.approvals; GET /api/timesheet/approval/{uid} wraps the
// same record under data.timesheet_approval and adds what only it carries: approval_history, the punches the period
// covers (timesheets) and approval_hierarchy. So the list is paged for the uids and each one is then read in full —
// both shapes reach the same transform. GBG's Zuper holds one (AWAIT_APPROVAL, one history line, no punches).
/** Every approval, each already read in full. */
export async function* zuperTimesheetApprovals(cfg: SyncConfig, maxPages = 20): AsyncGenerator<any[]> {
  for (let page = 1; page <= maxPages; page++) {
    const j = await zuperGet(cfg, `/api/timesheet/approval?page=${page}&count=100`);
    const list: any[] = j?.data?.approvals ?? [];
    if (!list.length) return;
    const full: any[] = [];
    await inChunks(list, 4, async (a) => {
      const uid = a?.timesheet_approval_uid;
      // The list row alone is still the record; only its history and punches are missing. A detail that fails must
      // not lose the approval, so the row stands in for it.
      const detail = uid ? await zuperGet(cfg, `/api/timesheet/approval/${uid}`).then((d) => d?.data ?? null).catch(() => null) : null;
      full.push(detail?.timesheet_approval ? detail : a);
    });
    yield full;
    const total = Number(j?.data?.total_pages);
    if (Number.isFinite(total) && page >= total) return;
    if (list.length < 100) return;
  }
}
/** The approval's history, as Zuper holds it. Matched on status + instant, so re-reading an approval does not churn
 *  the ids Tuper answers with; a line Zuper no longer has goes. Only the by-uid read carries history at all. */
async function writeApprovalHistory(ctx: Ctx, approvalId: string, row: any): Promise<void> {
  const lines: any[] | null = Array.isArray(row?.approval_history) ? row.approval_history : null;
  if (!lines) return;
  const users = await ctxMap(ctx, "users");
  const key = (status: string, at: unknown) => `${status}|${at ? Date.parse(String(at)) : ""}`;
  const want = new Map<string, Record<string, unknown>>();
  for (const h of lines) {
    const status = T(h?.status);
    if (!status) continue;
    const at = ts(h.created_at);
    want.set(key(status, at), {
      tenant_id: ctx.tenantId, approval_id: approvalId, status,
      remarks: T(h.remarks), approval_by: mapGet(users, h.approval_by_user?.user_uid),
      ...(at ? { created_at: at } : {}),
    });
  }
  const table = () => ctx.client.schema("jms").from("timesheet_approval_history");
  const { data, error } = await table().select("id, status, remarks, approval_by, created_at")
    .eq("tenant_id", ctx.tenantId).eq("approval_id", approvalId);
  if (error) throw error;
  const gone: string[] = [];
  for (const h of (data ?? []) as any[]) {
    const k = key(String(h.status), h.created_at);
    const w = want.get(k);
    if (!w) { gone.push(h.id); continue; }
    want.delete(k);
    if (h.remarks !== w.remarks || h.approval_by !== w.approval_by) {
      const { error: up } = await table().update({ remarks: w.remarks, approval_by: w.approval_by }).eq("id", h.id).eq("tenant_id", ctx.tenantId);
      if (up) throw up;
    }
  }
  if (gone.length) { const { error: rm } = await table().delete().eq("tenant_id", ctx.tenantId).in("id", gone); if (rm) throw rm; }
  if (want.size) { const { error: add } = await table().insert([...want.values()]); if (add) throw add; }
}
/** The punches the approval covers (jms.timesheets.approval_id). Only punches already imported can be linked. */
async function writeApprovalPunches(ctx: Ctx, approvalId: string, row: any): Promise<void> {
  const punches: any[] | null = Array.isArray(row?.timesheets) ? row.timesheets : null;
  if (!punches) return;
  const ids: string[] = [];
  if (punches.length) {
    const map = await ctxMap(ctx, "timesheets");
    for (const p of punches) {
      const id = mapGet(map, p?.employee_timesheet_uid);
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  const table = () => ctx.client.schema("jms").from("timesheets");
  const { data, error } = await table().select("id").eq("tenant_id", ctx.tenantId).eq("approval_id", approvalId);
  if (error) throw error;
  const keep = new Set(ids);
  const drop = ((data ?? []) as { id: string }[]).map((p) => p.id).filter((id) => !keep.has(id));
  if (drop.length) { const { error: off } = await table().update({ approval_id: null }).eq("tenant_id", ctx.tenantId).in("id", drop); if (off) throw off; }
  if (ids.length) { const { error: on } = await table().update({ approval_id: approvalId }).eq("tenant_id", ctx.tenantId).in("id", ids); if (on) throw on; }
}
ENTITIES.timesheet_approvals = {
  name: "timesheet_approvals", schema: "jms", table: "timesheet_approvals", deps: ["users", "teams"], concurrency: 4,
  pages: (ctx) => zuperTimesheetApprovals(ctx.cfg),
  uid: (row) => (row.timesheet_approval ?? row).timesheet_approval_uid,
  async transform(row, ctx) {
    const a = row.timesheet_approval ?? row;          // flat from the list, wrapped from the by-uid read
    const users = await ctxMap(ctx, "users");
    const userId = mapGet(users, a.user_details?.user_uid);
    if (!userId) throw new Error(`timesheet approval ${a.timesheet_approval_uid}: ${a.user_details ? "the person isn't imported" : "no person"}`);
    const from = ts(a.from_date), to = ts(a.to_date);
    if (!from) throw new Error(`timesheet approval ${a.timesheet_approval_uid}: no period`);
    const status = String(a.current_status ?? "").toUpperCase();
    // Zuper's approval object carries no approved_at; its history line does, so a decided approval takes the instant
    // of its last decision. A list row has no history, and then the column is left as it is.
    const decided = (Array.isArray(row?.approval_history) ? row.approval_history : [])
      .filter((h: any) => /^(APPROVED|REJECTED)$/.test(String(h?.status ?? "").toUpperCase()))
      .map((h: any) => ts(h.created_at)).filter(Boolean).sort();
    const decidedAt = ts(a.approved_at) ?? decided[decided.length - 1] ?? null;
    return {
      user_id: userId, team_id: mapGet(await ctxMap(ctx, "teams"), a.team?.team_uid),
      from_date: from, to_date: to && Date.parse(to) >= Date.parse(from) ? to : from,
      total_shift_mins: Math.round(num0(a.total_shift_mins)), total_break_mins: Math.round(num0(a.total_break_mins)),
      total_logged_mins: Math.round(num0(a.total_logged_mins)), total_timeoff_mins: Math.round(num0(a.total_timeoff_mins)),
      total_overtime_mins: Math.round(num0(a.total_overtime_mins)), total_distance: r2(num0(a.total_distance)),
      remarks: T(a.remarks),
      current_status: status === "APPROVED" ? "APPROVED" : /REJECT|DECLIN/.test(status) ? "REJECTED" : "AWAIT_APPROVAL",
      await_approval_by: mapGet(users, a.await_approval_by_user?.user_uid),
      approved_by: mapGet(users, a.approved_by_user?.user_uid),
      ...(decidedAt ? { approved_at: decidedAt } : {}),
      is_deleted: a.is_deleted === true, created_by: mapGet(users, a.created_by_user?.user_uid), ...createdAt(a),
    };
  },
  async afterWrite(ctx, id, r) {
    await writeApprovalHistory(ctx, id, r);
    await writeApprovalPunches(ctx, id, r);
  },
};

// ── Time off availability ── each person's remaining days of one type in one year. GET
// /api/timesheets/request/timeoff_availability answers the whole list in one reply (GBG: 55 rows, all 2026, 30
// people, 4 types; Zuper lets a balance go below zero and one is -3). No read-by-uid and no paging.
ENTITIES.timeoff_availability = {
  name: "timeoff_availability", schema: "jms", table: "timeoff_availability", deps: ["users", "timeoff_types"], concurrency: 8,
  fetch: (ctx) => zuperGet(ctx.cfg, "/api/timesheets/request/timeoff_availability").then((j) => j.data ?? []),
  uid: (r) => r.timeoff_availability_uid,
  async transform(r, ctx) {
    const userId = mapGet(await ctxMap(ctx, "users"), r.user?.user_uid);
    if (!userId) throw new Error(`time off balance ${r.timeoff_availability_uid}: ${r.user ? "the person isn't imported" : "no person"}`);
    const typeUid = r.timeoff_request_type?.timeoff_request_type_uid ?? r.timeoff_request_type_uid;
    const typeId = mapGet(await ctxMap(ctx, "timeoff_types"), typeUid);
    if (!typeId) throw new Error(`time off balance ${r.timeoff_availability_uid}: ${typeUid ? "the time off type isn't imported" : "no time off type"}`);
    const year = Number(r.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error(`time off balance ${r.timeoff_availability_uid}: no year`);
    return { user_id: userId, type_id: typeId, year, remaining_days: r2(num0(r.remaining_days)), ...createdAt(r) };
  },
};

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic", heif: "image/heif", bmp: "image/bmp",
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", "3gp": "video/3gpp", webm: "video/webm", avi: "video/x-msvideo",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg",
  pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", csv: "text/csv", txt: "text/plain", zip: "application/zip",
};
/** A Zuper file's type, from its name (else its link) and Zuper's broad kind (IMAGE, VIDEO, AUDIO, DOCUMENT). */
function zuperMime(name: string | null, url: string, kind: unknown): string {
  const ext = (/\.([a-z0-9]{2,5})$/i.exec(name ?? "") ?? /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(url))?.[1]?.toLowerCase();
  if (ext && MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  const k = String(kind ?? "").toUpperCase();
  // Some of Zuper's file lists send the type itself ("image/png") rather than its broad kind; take it as it comes.
  if (/^[a-z]+\/[a-z0-9.+-]+$/i.test(String(kind ?? ""))) return String(kind).toLowerCase();
  return k === "IMAGE" ? "image/jpeg" : k === "VIDEO" ? "video/mp4" : k === "AUDIO" ? "audio/mpeg" : "application/octet-stream";
}
/** Zuper files (a note's, a job's) → jms.attachments rows that keep Zuper's public link (00105) until the bytes are
 *  copied. Zuper gives sizes in kB (293 for a 293,042-byte photo). Each file's uid (else its link) goes in the map
 *  (entity `files`). A file already brought over is left as it is (Zuper's files don't change), so a re-run only adds
 *  new ones; new ones go in one insert and one map write per call. Returns the rows' ids in the files' order. */
async function writeZuperFiles(ctx: Ctx, host: { type: string; id: string }, files: any[] | undefined, extra: { note_id?: string; uploaded_by?: string | null; created_at?: string | null } = {}): Promise<string[]> {
  const map = await ctxMap(ctx, "files");
  const slots: ({ id: string } | { uid: string; url: string; row: Record<string, unknown> })[] = [];
  const seen = new Set<string>();
  for (const a of files ?? []) {
    const url = T(a?.attachment ?? a?.attachment_path ?? a?.url);
    if (!url || !/^https:\/\//.test(url) || a?.is_deleted === true || seen.has(url)) continue;
    seen.add(url);
    const uid = String(a.attachment_uid ?? a._id ?? url);
    const known = map.get(uid);
    if (known) { slots.push({ id: known }); continue; }
    const name = cleanFileName(T(a.attachment_name) ?? decodeURIComponent(url.split("?")[0].split("/").pop() ?? "file"));
    const mime = zuperMime(name, url, a.attachment_type ?? a.type_of_attachment);
    const kb = Number(a.attachment_size);
    slots.push({ uid, url, row: {
      tenant_id: ctx.tenantId, entity_type: host.type, entity_id: host.id, file_name: name, mime_type: mime, kind: kindOf(mime), source_url: url,
      size_bytes: Number.isFinite(kb) && kb > 0 ? Math.round(kb * 1000) : null, caption: T(a.attachment_description),
      uploaded_by: extra.uploaded_by ?? null, ...(extra.note_id ? { note_id: extra.note_id } : {}), ...(extra.created_at ? { created_at: extra.created_at } : {}),
    } });
  }
  const fresh = slots.filter((s): s is { uid: string; url: string; row: Record<string, unknown> } => "row" in s);
  // The new rows are matched back by their link (one per call), not by the order they come back in.
  const idByUrl = new Map<string, string>();
  if (fresh.length) {
    // Rows an earlier run wrote but didn't get to map (it was stopped in between) are taken up, not added twice. The
    // same picture can hang off two of a record's notes (seen on GBG's jobs); each note keeps its own row.
    let hadQ = ctx.client.schema("jms").from("attachments").select("id, source_url")
      .eq("tenant_id", ctx.tenantId).eq("entity_type", host.type).eq("entity_id", host.id).in("source_url", fresh.map((f) => f.url));
    hadQ = extra.note_id ? hadQ.eq("note_id", extra.note_id) : hadQ.is("note_id", null);
    const { data: had, error: hadErr } = await hadQ;
    if (hadErr) throw hadErr;
    for (const r of (had ?? []) as { id: string; source_url: string }[]) idByUrl.set(r.source_url, r.id);
    const toInsert = fresh.filter((f) => !idByUrl.has(f.url));
    if (toInsert.length) {
      const { data, error } = await ctx.client.schema("jms").from("attachments").insert(toInsert.map((f) => f.row)).select("id, source_url");
      if (error) throw error;
      for (const r of (data ?? []) as { id: string; source_url: string }[]) idByUrl.set(r.source_url, r.id);
    }
    const now = new Date().toISOString();
    const links = fresh.filter((f) => idByUrl.has(f.url)).map((f) => ({ tenant_id: ctx.tenantId, entity: "files", zuper_uid: f.uid, jms_id: idByUrl.get(f.url)!, synced_at: now }));
    const { error: mapErr } = await ctx.client.schema("jms").from("zuper_sync_map").upsert(links, { onConflict: "tenant_id,entity,zuper_uid" });
    if (mapErr) throw mapErr;
    for (const l of links) map.set(l.zuper_uid, l.jms_id);
  }
  return slots.map((s) => ("id" in s ? s.id : idByUrl.get(s.url))).filter((x): x is string => !!x);
}

// ── Files on records other than jobs (2026-09-21) ──
//
// Zuper's thirteen attachment events on customers, organizations, assets, quotes and invoices reached nothing: a file
// added to any of them never came over. There is no read-by-uid for a file and no list that names a file's record —
// `GET /api/attachments` pages every file in the account with no parent on it — but every one of these records carries
// its own files in its by-uid read, exactly as a job does. So an attachment event is what every other event here is:
// re-read the record, and link what it carries.
//
// LINK, DON'T COPY (owner, 2026-09-18): the row keeps Zuper's own S3 link in source_url and Tuper serves from it. That
// is writeZuperFiles' behaviour and nothing here changes it — no bytes are fetched.
//
// Zuper spells a file two ways, and both were seen on this account: a job's and `GET /api/attachments` use
// attachment / attachment_path + attachment_name, while a quote's and an asset's use url + file_name. Both carry
// attachment_uid. They are normalised to the first shape so one writer serves all of them, and so a file's own
// uploader and date reach the row (each file is written on its own — one record holds a handful).
//
// A REMOVAL IS MIRRORED, which a job's is not. The by-uid read is the record's whole file list in one answer, so a
// file we hold from Zuper that the list no longer has was removed there. Only rows this sync brought over can go:
// entity_type/entity_id of this record, a source_url (Tuper's own uploads have none, they have a storage path),
// and no note_id (a note's files belong to the note). The delete is soft — Tuper's Gallery can restore it — and an
// improbable number at once is reported rather than acted on, the same refusal collections.ts makes.

/** The records whose files Tuper keeps, by the entity_type jms.attachments files them under
 *  (lib/list-contract/attachments.ts): where the record is read, and where that read puts its files. */
export const FILE_RECORDS = {
  customer: { entity: "customers", uidField: "customer_uid", detail: (u: string) => `/api/customers/${u}`, files: (r: any) => r.attachments },
  organization: { entity: "organizations", uidField: "organization_uid", detail: (u: string) => `/api/organization/${u}`, files: (r: any) => r.attachments },
  asset: { entity: "assets", uidField: "asset_uid", detail: (u: string) => `/api/assets/${u}`, files: (r: any) => r.asset_attachments ?? r.attachments },
  quote: { entity: "estimates", uidField: "estimate_uid", detail: (u: string) => `/api/estimate/${u}`, files: (r: any) => r.attachments },
  invoice: { entity: "invoices", uidField: "invoice_uid", detail: (u: string) => `/api/invoice/${u}`, files: (r: any) => r.attachments },
  service_contract: { entity: "contracts", uidField: "contract_uid", detail: (u: string) => `/api/service_contract/${u}`, files: (r: any) => r.attachments },
} as const;
export type FileRecord = keyof typeof FILE_RECORDS;

/** More files gone from one record's list than this means the answer is wrong, not the record: say so, remove none. */
const MAX_FILES_REMOVED_AT_ONCE = 20;

/** Zuper's two file shapes → the one writeZuperFiles reads. */
const zuperFile = (a: any) => ({
  attachment: T(a?.attachment ?? a?.attachment_path ?? a?.url),
  attachment_uid: a?.attachment_uid ?? a?._id,
  attachment_name: T(a?.attachment_name ?? a?.file_name),
  attachment_size: a?.attachment_size,
  attachment_description: a?.attachment_description,
  attachment_type: a?.attachment_type ?? a?.type_of_attachment ?? a?.mime_type,
  is_deleted: a?.is_deleted === true,
});

/**
 * One record's own files → jms.attachments, and the ones Zuper no longer lists marked deleted.
 *
 * `r` is the record as its by-uid read returns it. A LIST row carries no files array at all, so this does nothing for
 * one — which is what keeps the bulk imports (customers, organizations, assets and contracts are written from list
 * rows) from reading an absent list as "every file was removed".
 */
export async function writeRecordFiles(ctx: Ctx, kind: FileRecord, id: string, r: any): Promise<{ linked: number; removed: number; note: string | null }> {
  const listed = FILE_RECORDS[kind].files(r ?? {});
  if (!Array.isArray(listed)) return { linked: 0, removed: 0, note: null };   // not a by-uid read — say nothing about this record's files
  // Each file is written on its own, so it keeps its own uploader and date — which means Zuper's record travels
  // beside the normalised one. writeZuperFiles only drops a repeated link within a single call, so the same link
  // twice on one record is dropped here instead.
  const seen = new Set<string>();
  const files: { url: string; file: ReturnType<typeof zuperFile>; from: any }[] = [];
  for (const from of listed) {
    const file = zuperFile(from);
    if (!file.attachment || !/^https:\/\//.test(file.attachment) || seen.has(file.attachment)) continue;
    seen.add(file.attachment);
    files.push({ url: file.attachment, file, from: from ?? {} });
  }

  let linked = 0;
  for (const { file, from } of files) {
    if (file.is_deleted) continue;
    const ids = await writeZuperFiles(ctx, { type: kind, id }, [file], {
      uploaded_by: mapGet(await ctxMap(ctx, "users"), from.created_by?.user_uid),
      created_at: ts(from.created_at),
    });
    linked += ids.length;
  }

  const current = new Set(files.filter((f) => !f.file.is_deleted).map((f) => f.url));
  const { data: held, error } = await ctx.client.schema("jms").from("attachments").select("id, source_url")
    .eq("tenant_id", ctx.tenantId).eq("entity_type", kind).eq("entity_id", id)
    .eq("is_deleted", false).is("note_id", null).not("source_url", "is", null);
  if (error) throw error;
  const gone = ((held ?? []) as { id: string; source_url: string }[]).filter((h) => !current.has(h.source_url));
  if (!gone.length) return { linked, removed: 0, note: null };
  if (gone.length > MAX_FILES_REMOVED_AT_ONCE) {
    // Said out loud, not only returned: an event's afterWrite has nowhere to put the answer, and a refusal to remove
    // files is exactly the thing someone should see in the log.
    const note = `${gone.length} files of ${kind} ${id} are missing from Zuper's answer — too many to act on, none removed`;
    console.warn(`[zupersync] ${note}`);
    return { linked, removed: 0, note };
  }
  const { error: delErr } = await ctx.client.schema("jms").from("attachments")
    .update({ is_deleted: true, deleted_at: new Date().toISOString() })
    .eq("tenant_id", ctx.tenantId).eq("is_deleted", false).in("id", gone.map((g) => g.id));
  if (delErr) throw delErr;
  return { linked, removed: gone.length, note: null };
}

// ── Checklist answers (2026-09-15) ── each status change in a job's Zuper timeline carries the answers to that status's
// checklist (question, answer, type). They become a jms.form_responses row on the job — map entity checklist_responses,
// keyed by the timeline entry — with jms.form_answers matched to the checklist's questions by their wording, in order
// (a wording can repeat). Pictures and signatures become the job's files (writeZuperFiles), as Zuper shows them in the
// job's gallery. The status history row points at the response (job_status_history.form_response_id).

/** The checklist bound to a status (job_statuses.form_id), looked up once per run. */
async function statusFormId(ctx: Ctx, statusId: string): Promise<string | null> {
  const cache: Map<string, string | null> = (ctx.extra.statusForms ??= new Map());
  if (!cache.has(statusId)) {
    const { data, error } = await ctx.client.schema("jms").from("job_statuses").select("form_id").eq("id", statusId).eq("tenant_id", ctx.tenantId).maybeSingle();
    if (error) throw error;
    cache.set(statusId, (data as { form_id: string | null } | null)?.form_id ?? null);
  }
  return cache.get(statusId) ?? null;
}
type AnswerField = { id: string; field_type: string; options: { label: string; value: string }[] };
/** A checklist's live questions by wording (lower case), each wording's questions in the checklist's order. */
async function formFieldsByLabel(ctx: Ctx, formId: string): Promise<Map<string, AnswerField[]>> {
  const key = `formFields:${formId}`;
  if (!ctx.extra[key]) {
    ctx.extra[key] = (async () => {
      const { data, error } = await ctx.client.schema("jms").from("form_fields").select("id, label, field_type, display_order, form_field_options(label, value)")
        .eq("tenant_id", ctx.tenantId).eq("form_id", formId).eq("is_deleted", false).order("display_order", { ascending: true });
      if (error) throw error;
      const byLabel = new Map<string, AnswerField[]>();
      for (const f of (data ?? []) as any[]) {
        const k = String(f.label ?? "").trim().toLowerCase();
        byLabel.set(k, [...(byLabel.get(k) ?? []), { id: f.id, field_type: f.field_type, options: (f.form_field_options ?? []).map((o: any) => ({ label: String(o.label), value: String(o.value) })) }]);
      }
      return byLabel;
    })();
  }
  return ctx.extra[key];
}
/** A Zuper checklist date: "2026-09-13" stays a date; "2026-09-13 12:52:00" is Dubai time; an ISO instant as it is. */
const zuperWhen = (raw: string): string | null => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(raw)) return `${raw.replace(" ", "T")}+04:00`;
  return Number.isNaN(Date.parse(raw)) ? null : new Date(raw).toISOString();
};
/** One answer → the typed column Tuper's checklist keeps it in (forms.ts valueColumn); null to leave it out. */
async function answerColumn(ctx: Ctx, jobId: string, f: AnswerField, raw: string, by: string | null, at: string | null): Promise<Record<string, unknown> | null> {
  const option = (p: string) => f.options.find((o) => o.label.trim().toLowerCase() === p.trim().toLowerCase())?.value ?? p.trim();
  switch (f.field_type) {
    case "SINGLE_IMAGE": case "MULTI_IMAGE": case "SIGNATURE": case "UPLOAD": case "VIDEO": {
      const urls = raw.split(",").map((u) => u.trim()).filter((u) => /^https:\/\//.test(u));
      const ids = urls.length ? await writeZuperFiles(ctx, { type: "job", id: jobId }, urls.map((u) => ({ attachment: u })), { uploaded_by: by, created_at: at }) : [];
      if (!ids.length) return null;
      return { file_url: f.field_type === "MULTI_IMAGE" || ids.length > 1 ? JSON.stringify(ids) : ids[0] };
    }
    case "DATE": case "DATE_TIME": {
      const when = zuperWhen(raw);
      return when ? { value_date: when } : { value_text: raw };
    }
    case "NUMBER": {
      const n = Number(raw);
      return Number.isFinite(n) ? { value_number: n } : { value_text: raw };
    }
    case "MULTI_SELECTION": {
      const whole = f.options.some((o) => o.label.trim().toLowerCase() === raw.toLowerCase());
      return { value_json: (whole ? [raw] : raw.split(",")).map((p) => p.trim()).filter(Boolean).map(option) };
    }
    case "SINGLE_SELECTION": case "DROPDOWN":
      return { value_text: option(raw) };
    default:
      return { value_text: raw };
  }
}
/** A timeline entry's checklist answers → its form response on the job; null when there's nothing to keep. */
async function writeChecklistResponse(ctx: Ctx, jobId: string, statusId: string, s: any): Promise<string | null> {
  const given: any[] = (s.checklist ?? []).filter((c: any) => c && c.type !== "HEADER");
  const entryUid = T(s.status_history_uid) ?? T(s._id);
  if (!given.length || !entryUid) return null;
  const formId = await statusFormId(ctx, statusId);
  if (!formId) return null;
  const fields = await formFieldsByLabel(ctx, formId);
  const by = mapGet(await ctxMap(ctx, "users"), s.done_by?.user_uid ?? (typeof s.done_by === "string" ? s.done_by : null));
  const at = ts(s.created_at);
  const taken = new Set<string>();
  const answers: Record<string, unknown>[] = [];
  for (const c of given) {
    const f = (fields.get(String(c.question ?? "").trim().toLowerCase()) ?? []).find((x) => !taken.has(x.id));
    const raw = c.answer == null ? "" : typeof c.answer === "string" ? c.answer.trim() : JSON.stringify(c.answer);
    if (!f || !raw) continue;
    taken.add(f.id);
    const col = await answerColumn(ctx, jobId, f, raw, by, at);
    if (col) answers.push({ tenant_id: ctx.tenantId, form_field_id: f.id, ...col });
  }
  if (!answers.length) return null;
  const head = { form_id: formId, job_id: jobId, status_id: statusId, submitted_by: by, submitted_at: at };
  const responses = () => ctx.client.schema("jms").from("form_responses");
  const answersTbl = () => ctx.client.schema("jms").from("form_answers");
  let id = (await ctxMap(ctx, "checklist_responses")).get(entryUid) ?? null;
  if (id) {
    const { error } = await responses().update(head).eq("id", id).eq("tenant_id", ctx.tenantId);
    if (error) throw error;
    const { error: delErr } = await answersTbl().delete().eq("tenant_id", ctx.tenantId).eq("response_id", id);
    if (delErr) throw delErr;
  } else {
    const { data, error } = await responses().insert({ ...head, tenant_id: ctx.tenantId, ...(at ? { created_at: at } : {}) }).select("id").single();
    if (error) throw error;
    id = (data as { id: string }).id;
    await setMap(ctx, "checklist_responses", entryUid, id);
  }
  const { error: insErr } = await answersTbl().insert(answers.map((a) => ({ ...a, response_id: id })));
  if (insErr) throw insErr;
  return id;
}

// Notes: Zuper's notes on jobs, requests (a request's comments), assets and customers — GET /api/notes, 100 a page — →
// jms.entity_comments, each with its files (writeZuperFiles). The text is cleaned as Tuper's own notes are. Zuper's
// audiences map onto Tuper's four: private → Only Me, hidden from field staff → Back office only, else Public or
// Internal. Nobody is notified. A note by someone Tuper doesn't have (a customer, say) has no author.
ENTITIES.notes = {
  name: "notes", schema: "jms", table: "entity_comments", deps: ["jobs", "requests", "assets", "customers", "projects", "purchase_orders", "users", "files"], concurrency: 16,
  pages: (ctx) => zuperListPages(ctx.cfg, "/api/notes", 100),
  uid: (r) => r.note_uid,
  async transform(r, ctx) {
    const hosts: [string, string, unknown][] = [["job", "jobs", r.job?.job_uid], ["request", "requests", r.request?.request_uid], ["asset", "assets", r.asset?.asset_uid], ["customer", "customers", r.customer?.customer_uid], ["project", "projects", r.project?.project_uid], ["purchase_order", "purchase_orders", r.purchase_order?.purchase_order_uid]];
    // A note event names the record the note is on, and the reader (processor.ts syncHostNotes) passes that record
    // through with the note: one read back from a record's own list belongs to that record whatever field Zuper puts
    // inside the note. Only the whole-list pass has to read the host out of the note itself.
    const named = r._note_host ? hosts.find(([type]) => type === r._note_host.type) : undefined;
    const hit: [string, string, unknown] | undefined = named ? [named[0], named[1], r._note_host.uid] : hosts.find(([, , uid]) => uid);
    if (!hit) throw new Error(`note ${r.note_uid}: no job, request, asset, customer, project or purchase order`);
    const hostId = mapGet(await ctxMap(ctx, hit[1]), hit[2]);
    if (!hostId) throw new Error(`note ${r.note_uid}: its ${hit[0]} ${String(hit[2])} isn't imported`);
    const raw = String(r.note ?? "");
    const html = /<[a-z][\s\S]*>/i.test(raw) ? sanitizeRichText(raw) : "";
    const author = mapGet(await ctxMap(ctx, "users"), r.created_by?.user_uid);
    r._host = { type: hit[0], id: hostId };
    r._author = author;
    return {
      entity_type: hit[0], entity_id: hostId, author_id: author,
      body: (html ? T(richTextToPlain(html)) : T(raw)) ?? "", body_html: html || null,
      visibility: r.is_private === true ? "ONLY_ME" : r.visible_to_fe === false ? "BACKOFFICE_ONLY" : r.visibility === "PUBLIC" || r.visible_to_customer === true ? "PUBLIC" : "INTERNAL",
      is_pinned: r.is_pinned === true, notify: false,
      is_deleted: r.is_deleted === true, deleted_at: r.is_deleted === true ? ts(r.updated_at) : null,
      edited_at: r.is_edited === true ? ts(r.updated_at) : null,
      zuper_uid: r.note_uid, ...createdAt(r), ...(r.updated_at ? { updated_at: String(r.updated_at) } : {}),
    };
  },
  // A note an earlier run wrote but didn't get to map (it was stopped in between) is taken up again, not added twice.
  async insert(ctx, payload) {
    const tbl = () => ctx.client.schema("jms").from("entity_comments");
    const { data: had, error: hadErr } = await tbl().select("id").eq("tenant_id", ctx.tenantId).eq("zuper_uid", String(payload.zuper_uid)).limit(1);
    if (hadErr) throw hadErr;
    const found = ((had ?? []) as { id: string }[])[0]?.id;
    if (found) {
      const { error } = await tbl().update(payload).eq("id", found).eq("tenant_id", ctx.tenantId);
      if (error) throw error;
      return found;
    }
    const { data, error } = await tbl().insert({ ...payload, tenant_id: ctx.tenantId }).select("id").single();
    if (error) throw error;
    return (data as { id: string }).id;
  },
  async afterWrite(ctx, id, r) {
    if (r.is_deleted === true) return;
    await writeZuperFiles(ctx, r._host, r.attachments, { note_id: id, uploaded_by: r._author, created_at: ts(r.created_at) });
  },
};

// ── Activity and time logs ── a record's Zuper activity feed (GET /api/activities/recent?filter.activity_module=…&
// filter.activity_action_uid=…, 100 a page) → jms.entity_activity in Zuper's words: the person, then Zuper's message
// ("updated status to Started for Job …", "assigned … to job …", "punched in at …"). Status moves, notes and punches
// get their own verbs (zuper_status, zuper_note, zuper_timelog), so the Activity tab's type filter covers them; the rest
// are zuper_activity. A re-run replaces the record's imported entries and leaves Tuper's own alone.

/** Every entry of one record's Zuper activity feed. */
async function zuperActivity(ctx: Ctx, module: string, uid: string): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= 50; page++) {
    const j = await zuperGet(ctx.cfg, `/api/activities/recent?filter.activity_module=${module}&filter.activity_action_uid=${uid}&count=100&page=${page}`);
    const rows: any[] = j.data ?? [];
    out.push(...rows);
    const total = Number(j.total_records);
    if (rows.length < 100 || (Number.isFinite(total) && out.length >= total)) break;
  }
  return out;
}
async function writeZuperActivity(ctx: Ctx, entityType: string, entityId: string, rows: any[]): Promise<void> {
  const users = await ctxMap(ctx, "users");
  const tbl = () => ctx.client.schema("jms").from("entity_activity");
  const { error: delErr } = await tbl().delete().eq("tenant_id", ctx.tenantId).eq("entity_type", entityType).eq("entity_id", entityId).like("verb", "zuper_%");
  if (delErr) throw delErr;
  const list = rows.filter((a) => T(a.activity_message)).map((a) => {
    const action = String(a.activity_action ?? "").toUpperCase();
    const message = T(a.activity_message) as string;
    const verb = action === "JOB_STATUS" || (["REQUEST", "ESTIMATE", "INVOICE"].includes(action) && /\bstatus\b/i.test(message)) ? "zuper_status"
      : action.includes("NOTE") ? "zuper_note" : action === "TIMELOG" ? "zuper_timelog" : "zuper_activity";
    const remarks = T(a.metadata?.remarks);
    // Zuper's own Activity tab reads none of the sentence above: it renders metadata.fields_updated — each field's
    // label with its old and new value, and for a status move the status's name and colour. Tuper's tab renders the
    // same, so the list is kept as Zuper sends it. The rest of metadata (the client that made the call) is dropped.
    const fields = Array.isArray(a.metadata?.fields_updated) && a.metadata.fields_updated.length ? a.metadata.fields_updated : null;
    return {
      tenant_id: ctx.tenantId, entity_type: entityType, entity_id: entityId, actor_id: mapGet(users, a.users?.user_uid), verb,
      meta: { message, zuper_type: T(a.activity_type), zuper_action: T(action), ...(remarks ? { remarks } : {}), ...(fields ? { metadata: { fields_updated: fields } } : {}), zuper_uid: T(a.user_activity_uid) },
      ...(a.created_at ? { created_at: String(a.created_at) } : {}),
    };
  });
  if (list.length) { const { error } = await tbl().insert(list); if (error) throw error; }
}
/** A job's Zuper punches (CLOCK_IN / CLOCK_OUT events) → jms.job_timelogs, each punch in with the person's next punch
 *  out (none yet: still open). Map entity `timelogs`, keyed by the punch in, so a re-run updates its row. */
/** Some technicians' phones report punches in the Thai Buddhist calendar: the same day and time, 543 years
 *  ahead (2026 → 2569). Five imported logs carried it (WO 41203, 42147, 44191, 45004, 47301), each on the day the
 *  job was scheduled. A year that far out can only be that, so it is brought back. */
export function punchTime(v: unknown): string {
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  if (d.getUTCFullYear() - new Date().getUTCFullYear() > 400) d.setUTCFullYear(d.getUTCFullYear() - 543);
  return d.toISOString();
}

async function writeJobTimelogs(ctx: Ctx, jobId: string, punches: any[]): Promise<void> {
  punches = punches.map((p) => (p?.checked_time ? { ...p, checked_time: punchTime(p.checked_time) } : p));
  const users = await ctxMap(ctx, "users");
  const map = await ctxMap(ctx, "timelogs");
  const tbl = () => ctx.client.schema("jms").from("job_timelogs");
  const byUser = new Map<string, any[]>();
  for (const p of [...punches].sort((a, b) => String(a.checked_time).localeCompare(String(b.checked_time)))) {
    const u = p?.user?.user_uid;
    if (u && p.checked_time) byUser.set(u, [...(byUser.get(u) ?? []), p]);
  }
  for (const [u, list] of byUser) {
    const userId = mapGet(users, u);
    if (!userId) continue;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!/IN$/i.test(String(p.type)) || !T(p.timelog_uid)) continue;
      const next = list.slice(i + 1).find((q) => /(IN|OUT)$/i.test(String(q.type)));
      const out = next && /OUT$/i.test(String(next.type)) ? next : null;
      const started = String(p.checked_time), ended = out ? String(out.checked_time) : null;
      const valid = ended && Date.parse(ended) >= Date.parse(started) ? ended : null;
      const row = {
        job_id: jobId, user_id: userId, log_type: T(p.timelog_type) ?? "JOB", started_at: started, ended_at: valid,
        duration_minutes: valid ? Math.round((Date.parse(valid) - Date.parse(started)) / 60000) : null,
      };
      const id = map.get(String(p.timelog_uid));
      if (id) {
        const { error } = await tbl().update(row).eq("id", id).eq("tenant_id", ctx.tenantId);
        if (error) throw error;
      } else {
        const { data, error } = await tbl().insert({ ...row, tenant_id: ctx.tenantId }).select("id").single();
        if (error) throw error;
        await setMap(ctx, "timelogs", String(p.timelog_uid), (data as { id: string }).id);
      }
    }
  }
}

// Every imported job's activity, and — when its feed shows punches — its time logs (GET /api/jobs/{uid}/timelog).
ENTITIES.job_activity = {
  name: "job_activity", schema: "jms", table: "jobs", mapEntity: "jobs", enrichOnly: true, deps: ["users", "timelogs"], concurrency: 10,
  async *pages(ctx) {
    const uids = [...(await ctxMap(ctx, "jobs")).keys()];
    for (let i = 0; i < uids.length; i += 100) yield uids.slice(i, i + 100).map((job_uid) => ({ job_uid }));
  },
  uid: (r) => r.job_uid,
  async transform(r, ctx) {
    r._activity = await zuperActivity(ctx, "JOB", r.job_uid);
    if ((r._activity as any[]).some((a) => String(a.activity_action).toUpperCase() === "TIMELOG")) {
      r._timelog = (await zuperGet(ctx.cfg, `/api/jobs/${r.job_uid}/timelog`)).data ?? [];
    }
    return {};
  },
  async afterWrite(ctx, id, r) {
    await writeZuperActivity(ctx, "job", id, r._activity ?? []);
    if (Array.isArray(r._timelog)) {
      // One job's punches, not the whole timelog map: the bulk run loads that up front (a dependency), a
      // single-record sync does not, and ctxMap would otherwise page through every timelog to find a few.
      if (!ctx.maps.timelogs) ctx.maps.timelogs = await mapForUids(ctx, "timelogs", r._timelog.map((p: any) => T(p?.timelog_uid)));
      await writeJobTimelogs(ctx, id, r._timelog);
    }
  },
};
// Every imported request's activity.
ENTITIES.request_activity = {
  name: "request_activity", schema: "jms", table: "requests", mapEntity: "requests", enrichOnly: true, deps: ["users"], concurrency: 4,
  async *pages(ctx) {
    const uids = [...(await ctxMap(ctx, "requests")).keys()];
    if (uids.length) yield uids.map((request_uid) => ({ request_uid }));
  },
  uid: (r) => r.request_uid,
  async transform(r, ctx) { r._activity = await zuperActivity(ctx, "REQUEST", r.request_uid); return {}; },
  async afterWrite(ctx, id, r) { await writeZuperActivity(ctx, "request", id, r._activity ?? []); },
};
// Every imported quote's activity (Zuper's Quote Activity panel: created, printed, totals, status, custom fields).
ENTITIES.estimate_activity = {
  name: "estimate_activity", schema: "jms", table: "quotes", mapEntity: "estimates", enrichOnly: true, deps: ["users"], concurrency: 4,
  async *pages(ctx) {
    const uids = [...(await ctxMap(ctx, "estimates")).keys()];
    if (uids.length) yield uids.map((estimate_uid) => ({ estimate_uid }));
  },
  uid: (r) => r.estimate_uid,
  async transform(r, ctx) { r._activity = await zuperActivity(ctx, "ESTIMATE", r.estimate_uid); return {}; },
  async afterWrite(ctx, id, r) { await writeZuperActivity(ctx, "quote", id, r._activity ?? []); },
};

export async function syncEntity(ctx: Ctx, name: string): Promise<{ fetched: number; upserted: number; failed: number }> {
  const e = ENTITIES[name]; if (!e) throw new Error(`unknown entity ${name}`);
  const run = { data: await storeOne<{ id: string }>(
    "INSERT INTO sync.runs (tenant_id, entity) VALUES ($1, $2) RETURNING id", [ctx.tenantId, name]), error: null };
  const runId = (run.data as any)?.id;
  const log = process.env.ZUPER_SYNC_LOG ? (msg: string) => console.log(`  ${name}: ${msg}`) : () => {};
  let fetched = 0, upserted = 0, failed = 0, detail: string | null = null;
  const reasons = new Set<string>();
  try {
    const map = await ctxMap(ctx, e.mapEntity ?? name);
    for (const dep of e.deps ?? []) await ctxMap(ctx, dep);
    const one = async (r: any) => {
      try {
        const uid = e.uid(r); if (!uid) { failed++; return; }
        const payload = await e.transform(r, ctx); if (!payload) { failed++; return; }
        let id = map.get(uid);
        const isNew = !id;
        const write = async () => {
          if (id) {
            if (Object.keys(payload).length) { // an enrichment pass may have nothing to change but child rows
              const { error } = await ctx.client.schema(e.schema).from(e.table).update(payload).eq("id", id).eq("tenant_id", ctx.tenantId);
              if (error) throw error;
            }
          } else if (e.enrichOnly) {
            throw new Error(`${uid} is not imported yet`);
          } else if (e.insert) {
            id = await e.insert(ctx, payload, r);
            await setMap(ctx, e.mapEntity ?? name, uid, id);
          } else {
            const { data, error } = await ctx.client.schema(e.schema).from(e.table).insert({ ...payload, tenant_id: ctx.tenantId }).select("id").single();
            if (error) throw error;
            id = (data as any).id as string;
            await setMap(ctx, e.mapEntity ?? name, uid, id);
          }
        };
        try {
          await write();
        } catch (writeErr) {
          // A Zuper job, contract, part or request whose number a record made in Tuper already took (Tuper hands out the
          // next available number too — migrations 00076, 00094): that record moves to the next number, and the import
          // goes through.
          const NUMBERED: Record<string, { kind: "job" | "contract" | "product" | "request"; column: string }> = {
            jobs: { kind: "job", column: "work_order_number" }, contracts: { kind: "contract", column: "contract_number" }, products: { kind: "product", column: "product_no" },
            requests: { kind: "request", column: "request_number" },
          };
          const n = NUMBERED[name];
          const value = n ? payload[n.column] : undefined;
          if ((writeErr as { code?: string })?.code !== "23505" || !n || value == null || value === "") throw writeErr;
          const { releaseNumber } = await import("../list-contract/record-numbers");
          const moved = await releaseNumber(ctx.client, ctx.tenantId, n.kind, value as string | number, id);
          if (!moved) throw writeErr;
          log(`${n.kind} ${moved.from} was taken by a record made in Tuper — that record is now ${moved.to}`);
          await write();
        }
        if (e.afterWrite) await e.afterWrite(ctx, id!, r, isNew);
        upserted++;
      } catch (rowErr) {
        failed++;
        const msg = rowErr instanceof Error ? rowErr.message : (rowErr as any)?.message ?? "row error";
        if (!detail) detail = String(msg).slice(0, 200);
        if (reasons.size < 10 && !reasons.has(msg)) { reasons.add(msg); log(`failed — ${String(msg).slice(0, 200)}`); }
      }
    };
    const n = e.concurrency ?? 1;
    let rows: any[] = [];
    if (e.pages) {
      let page = 0;
      for await (const batch of e.pages(ctx)) {
        fetched += batch.length;
        await inChunks(batch, n, one);
        if (++page % 10 === 0) log(`${fetched} fetched, ${upserted} upserted, ${failed} failed`);
      }
    } else {
      rows = await e.fetch!(ctx); fetched = rows.length;
      await inChunks(rows, n, one);
    }
    if (e.afterAll) await e.afterAll(ctx, rows);
    await storeSql(
      `UPDATE sync.runs SET finished_at = now(), fetched = $2, upserted = $3, failed = $4, status = $5, detail = $6
        WHERE id = $1`,
      [runId, fetched, upserted, failed, failed && !upserted ? "FAILED" : "OK", detail],
    );
  } catch (err) {
    detail = err instanceof Error ? err.message.slice(0, 200) : "sync error";
    await storeSql(
      `UPDATE sync.runs SET finished_at = now(), fetched = $2, upserted = $3, failed = $4, status = $5, detail = $6
        WHERE id = $1`,
      [runId, fetched, upserted, failed, "FAILED", detail],
    );
    throw err;
  }
  return { fetched, upserted, failed };
}

/** Run a full sync (given entity order) — sets is_syncing + last_run_at/next_run_at. */
export async function runSync(client: SupabaseClient, tenantId: string, order: string[] = ["job_categories", "job_statuses", "products"]): Promise<Record<string, any>> {
  const cfg = await getSyncConfig(client, tenantId);
  if (!cfg.api_key) throw new Error("no Zuper API key configured");
  await storeSql("UPDATE sync.config SET is_syncing = true WHERE tenant_id = $1", [tenantId]);
  const ctx: Ctx = { client, tenantId, cfg, maps: {}, extra: {} };
  const results: Record<string, any> = {};
  try {
    for (const name of order) results[name] = await syncEntity(ctx, name);
  } finally {
    const next = new Date(Date.now() + cfg.interval_hours * 3600_000).toISOString();
    await storeSql(
      "UPDATE sync.config SET is_syncing = false, last_run_at = now(), next_run_at = $2 WHERE tenant_id = $1",
      [tenantId, next],
    );
  }
  return results;
}

/** Owner decision 2026-09-11: once Zuper customers are imported with their ids, soft-delete the legacy
 *  customers (old mirror migration — no Zuper id, no creator, heavily duplicated). Customers created in
 *  Tuper, and any legacy customer a live record still points at, are kept. */
export async function retireLegacyCustomers(client: SupabaseClient, tenantId: string): Promise<{ legacy: number; retired: number; keptInUse: number }> {
  const imported = new Set((await loadMap(client, tenantId, "customers")).values());
  if (imported.size === 0) throw new Error("import Zuper customers before retiring the legacy ones");
  // Every scan below is ordered. A paged read without an order may return one row twice and another not at all, and
  // this set decides which customers are still referenced: a page that comes back short makes a customer that IS in
  // use look unused, and this function retires it.
  const inUse = new Set<string>();
  for (const table of ["jobs", "requests", "quotes", "invoices", "assets", "service_contracts"]) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await client.schema("jms").from(table).select("customer_id").eq("tenant_id", tenantId).eq("is_deleted", false).not("customer_id", "is", null).order("customer_id").range(from, from + 999);
      if (error) throw error;
      for (const r of (data ?? []) as { customer_id: string }[]) inUse.add(r.customer_id);
      if (!data || data.length < 1000) break;
    }
  }
  const legacy: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client.schema("jms").from("customers").select("id").eq("tenant_id", tenantId).eq("is_deleted", false).is("created_by", null).order("id").range(from, from + 999);
    if (error) throw error;
    for (const r of (data ?? []) as { id: string }[]) if (!imported.has(r.id)) legacy.push(r.id);
    if (!data || data.length < 1000) break;
  }
  const retire = legacy.filter((id) => !inUse.has(id));
  const deletedAt = new Date().toISOString();
  for (let i = 0; i < retire.length; i += 200) {
    const { error } = await client.schema("jms").from("customers").update({ is_deleted: true, deleted_at: deletedAt }).eq("tenant_id", tenantId).in("id", retire.slice(i, i + 200));
    if (error) throw error;
  }
  return { legacy: legacy.length, retired: retire.length, keptInUse: legacy.length - retire.length };
}

export async function recentRuns(client: SupabaseClient, tenantId: string, limit = 20) {
  const data = await storeSql(
    `SELECT entity, started_at, finished_at, fetched, upserted, failed, status, detail
       FROM sync.runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT $2`,
    [tenantId, limit],
  );
  return data ?? [];
}
