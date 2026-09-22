/**
 * Link Zuper's file records to Tuper's files — the company's file list (the Gallery API).
 *
 *   npx tsx src/cli/import-company-files.ts [--apply] [--from-page 1] [--pages 12200] [--window 4]
 *
 * Zuper's file list (GET /api/attachments/group, oldest first, ten a page) holds its file records: files on notes,
 * files added on their own, and the checklist photos taken since it began keeping them as records — 121,670 at GBG
 * (2026-09-22). Tuper made a file of every link it imported, and also of every older checklist answer's photo link,
 * which Zuper keeps on the answer alone; those are left off Tuper's file list (Tuper 00223). This pass finds each of
 * Zuper's records among Tuper's files — by its uid where the import already linked it, else by its link — puts it on
 * the file list under Zuper's uid, and keeps Zuper's own fields for it (its number, kind, record, size, place,
 * created time). A record Tuper holds no file for is written to scratch/company_files_unmatched.tsv, not made. Zuper
 * is only read; without --apply nothing is written to Tuper either.
 */
import { appendFileSync } from "node:fs";
import { tuper as db } from "../tuper-client.js";
import { config } from "../config.js";

const arg = (name: string, dflt: number) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) || dflt : dflt; };
const apply = process.argv.includes("--apply");
const FROM = arg("--from-page", 1), PAGES = arg("--pages", 100000), WINDOW = arg("--window", 4);
const UNMATCHED = "scratch/company_files_unmatched.tsv";
const client = db();
const tenantId = config.tenantId;

async function zuper(path: string): Promise<any> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(config.zuper.apiUrl + path, { headers: { "x-api-key": config.zuper.apiKey }, signal: AbortSignal.timeout(90_000) });
      if (!res.ok) throw new Error(`Zuper ${path} → ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === 5) throw e;
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
}

/** What Tuper keeps of Zuper's own fields for a file (jms.attachments.extra, 00223). */
const KEEP = ["attachment_id", "type_of_attachment", "module", "module_uid", "attachment_size", "attachment_visibility", "geo_cords"];
const extraOf = (f: any) => Object.fromEntries(KEEP.filter((k) => k in f).map((k) => [k, f[k]]));

let matchedByUid = 0, matchedByLink = 0, unmatched = 0, written = 0, failed = 0;

async function onePage(page: number): Promise<{ last: boolean }> {
  const j = await zuper(`/api/attachments/group?sort=ASC&page=${page}&count=10`);
  const files: any[] = (j?.data ?? []).flatMap((g: any) => g.attachments ?? []).filter((f: any) => f?.attachment_uid);
  const last = !files.length || page >= Number(j?.total_pages ?? page);
  if (!files.length) return { last };
  const uids = files.map((f) => String(f.attachment_uid));
  const { data: mapped, error: mapErr } = await client.schema("jms").from("zuper_sync_map").select("zuper_uid, jms_id")
    .eq("tenant_id", tenantId).eq("entity", "files").in("zuper_uid", uids);
  if (mapErr) throw mapErr;
  const byUid = new Map(((mapped ?? []) as any[]).map((m) => [m.zuper_uid as string, m.jms_id as string]));
  const links = [...new Set(files.filter((f) => !byUid.has(String(f.attachment_uid))).map((f) => String(f.attachment_path ?? "")).filter((u) => u.startsWith("https://")))];
  const byLink = new Map<string, string>();
  if (links.length) {
    const { data: held, error } = await client.schema("jms").from("attachments").select("id, source_url").eq("tenant_id", tenantId).in("source_url", links);
    if (error) throw error;
    for (const a of (held ?? []) as any[]) if (!byLink.has(a.source_url)) byLink.set(a.source_url, a.id);
  }
  const newMap: Record<string, unknown>[] = [];
  for (const f of files) {
    const uid = String(f.attachment_uid);
    const id = byUid.get(uid) ?? byLink.get(String(f.attachment_path ?? ""));
    if (!id) {
      unmatched++;
      appendFileSync(UNMATCHED, [uid, f.type_of_attachment ?? "", f.module ?? "", f.module_uid ?? "", f.created_at ?? "", f.attachment_path ?? ""].join("\t") + "\n");
      continue;
    }
    if (byUid.has(uid)) matchedByUid++; else { matchedByLink++; newMap.push({ tenant_id: tenantId, entity: "files", zuper_uid: uid, jms_id: id, synced_at: new Date().toISOString() }); }
    if (!apply) continue;
    try {
      const { error } = await client.schema("jms").from("attachments")
        .update({ in_file_list: true, extra: extraOf(f), ...(f.created_at ? { created_at: String(f.created_at) } : {}) })
        .eq("tenant_id", tenantId).eq("id", id);
      if (error) throw error;
      written++;
    } catch (e) {
      failed++;
      console.log(`  page ${page} file ${uid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (apply && newMap.length) {
    const { error } = await client.schema("jms").from("zuper_sync_map").upsert(newMap, { onConflict: "tenant_id,entity,zuper_uid" });
    if (error) throw error;
  }
  return { last };
}

let page = FROM;
const end = FROM + PAGES - 1;
let done = false;
while (!done && page <= end) {
  const batch = Array.from({ length: Math.min(WINDOW, end - page + 1) }, (_, i) => page + i);
  const results = await Promise.all(batch.map((p) => onePage(p).catch((e) => { console.log(`  page ${p} failed: ${e instanceof Error ? e.message : String(e)}`); failed++; return { last: false }; })));
  done = results.some((r) => r.last);
  page += batch.length;
  if ((page - FROM) % 100 < WINDOW) console.log(`page ${page - 1}: by uid ${matchedByUid}, by link ${matchedByLink}, unmatched ${unmatched}, written ${written}, failed ${failed}`);
}
console.log(`company_files ${JSON.stringify({ apply, pages: `${FROM}-${page - 1}`, matchedByUid, matchedByLink, unmatched, written, failed })}`);
process.exit(0);
