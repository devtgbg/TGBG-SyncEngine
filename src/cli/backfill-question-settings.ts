/**
 * Give GBG's checklist questions the settings they have in Zuper.
 *
 *   npx tsx src/cli/backfill-question-settings.ts [--apply]
 *
 * The import kept each question's conditions but dropped the settings its type offers: Restrict to Camera (881 of
 * GBG's questions), Stamp Date & Time (895), Stamp GPS (8), number validation with its limits (205), Read Only and
 * Hide to FE. A full job-status re-sync would carry them, and would rewrite every status and every question with it;
 * this touches the settings alone, leaving each question's conditions, order, label and type as they are.
 *
 * Zuper is read. Questions are matched to Tuper's by the status they belong to and their label, in order, so a status
 * that asks the same question twice keeps them apart.
 */
import { tuper as db } from "../tuper-client.js";
import { config as appConfig } from "../config.js";

const apply = process.argv.includes("--apply");
const client = db();
const tenantId = appConfig.tenantId;

/** The settings a question carries, as Tuper stores them in form_fields.config. */
const SETTING_KEYS = ["read_only", "hidden", "hide_to_fe", "default_option", "time_interval",
  "restrict_to_camera", "stamp_date_time", "stamp_gps", "restrict_status_update", "validation", "min_value", "max_value"];

async function zuper(path: string): Promise<any> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(appConfig.zuper.apiUrl + path, {
        headers: { "x-api-key": appConfig.zuper.apiKey, "content-type": "application/json" },
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

/** What Zuper's question says its settings are. */
function settingsOf(q: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const meta = q.meta_options ?? {};
  if (q.read_only === true) out.read_only = true;
  if (q.hide_field === true) out.hidden = true;
  if (q.hide_to_fe === true) out.hide_to_fe = true;
  if (q.default_option === true) out.default_option = true;
  if (q.field_meta?.time_interval != null) out.time_interval = Number(q.field_meta.time_interval);
  if (meta.restrict_to_camera === true) out.restrict_to_camera = true;
  if (meta.watermark_timestamp === true) out.stamp_date_time = true;
  if (meta.watermark_geo_cords === true) out.stamp_gps = true;
  if (meta.restrict_status_update?.is_enabled === true) {
    out.restrict_status_update = {
      is_enabled: true,
      restricted_options: meta.restrict_status_update.restricted_options ?? [],
      message: meta.restrict_status_update.message ?? null,
    };
  }
  if (q.field_validation) out.validation = String(q.field_validation).toLowerCase();
  if (q.min_value != null && q.min_value !== "") out.min_value = Number(q.min_value);
  if (q.max_value != null && q.max_value !== "") out.max_value = Number(q.max_value);
  return out;
}

const { data: cats, error } = await client.schema("jms").from("job_categories")
  .select("id, name").eq("tenant_id", tenantId).eq("is_deleted", false);
if (error) throw error;

const { data: catMap } = await client.schema("jms").from("zuper_sync_map")
  .select("zuper_uid, jms_id").eq("tenant_id", tenantId).eq("entity", "job_categories");
const catUid = new Map<string, string>(((catMap ?? []) as any[]).map((r) => [r.jms_id, r.zuper_uid]));

const { data: statusMap } = await client.schema("jms").from("zuper_sync_map")
  .select("zuper_uid, jms_id").eq("tenant_id", tenantId).eq("entity", "job_statuses");
const statusId = new Map<string, string>(((statusMap ?? []) as any[]).map((r) => [r.zuper_uid, r.jms_id]));

let looked = 0, matched = 0, changed = 0, unmatched = 0;
for (const c of (cats ?? []) as any[]) {
  const uid = catUid.get(c.id);
  if (!uid) continue;
  const statuses: any[] = (await zuper(`/api/jobs/status/${uid}`))?.data?.job_statuses ?? [];
  for (const s of statuses) {
    const questions: any[] = s.checklist ?? [];
    if (!questions.length) continue;
    const id = statusId.get(s.status_uid);
    if (!id) continue;
    const { data: statusRow } = await client.schema("jms").from("job_statuses")
      .select("form_id").eq("tenant_id", tenantId).eq("id", id).maybeSingle();
    const formId = (statusRow as any)?.form_id;
    if (!formId) continue;

    const { data: fieldRows } = await client.schema("jms").from("form_fields")
      .select("id, label, config, display_order").eq("tenant_id", tenantId).eq("form_id", formId).eq("is_deleted", false)
      .order("display_order", { ascending: true });
    const fields = ((fieldRows ?? []) as any[]).map((f) => ({ ...f, taken: false }));

    for (const q of questions) {
      looked++;
      const label = String(q.field_name ?? "").trim();
      const field = fields.find((f) => !f.taken && String(f.label ?? "").trim() === label);
      if (!field) { unmatched++; continue; }
      field.taken = true;
      matched++;

      const wanted = settingsOf(q);
      const current = (field.config ?? {}) as Record<string, unknown>;
      // Keep everything that isn't a setting (the conditions), and put Zuper's settings in place of the old ones.
      const kept: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(current)) if (!SETTING_KEYS.includes(k)) kept[k] = v;
      const next = { ...kept, ...wanted };
      if (JSON.stringify(next) === JSON.stringify(current)) continue;

      changed++;
      if (apply) {
        const { error: uErr } = await client.schema("jms").from("form_fields")
          .update({ config: next }).eq("id", field.id).eq("tenant_id", tenantId);
        if (uErr) throw uErr;
      }
    }
  }
}
console.log(`\n${looked} questions read from Zuper, ${matched} matched to Tuper's, ${unmatched} with no match, ` +
  `${changed} ${apply ? "given Zuper's settings" : "would change (dry run — pass --apply)"}`);
