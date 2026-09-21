/**
 * Bring over the files hanging off records that are not jobs.
 *
 *   npm run record-files                                 every kind, write
 *   npx tsx src/cli/record-files.ts                      the same, without npm in the way
 *   npx tsx src/cli/record-files.ts --dry-run            every kind, count only — Zuper reads, nothing written
 *   npx tsx src/cli/record-files.ts asset quote          just those kinds
 *   npx tsx src/cli/record-files.ts --per-minute 90      slower, when live traffic is competing for the rate limit
 *
 * WHY A PASS OF ITS OWN. From now on a file reaches Tuper the moment Zuper says so: the thirteen attachment events on
 * customers, organizations, assets, quotes and invoices re-read their record, and zuper-sync.ts's writeRecordFiles
 * links what that read carries. But that only covers changes from here on. Files already sitting on those records were
 * never brought over, and no list in Zuper names them — `GET /api/attachments` pages every file in the account without
 * saying which record each is on (checked read-only 2026-09-21). The only way to find them is to ask each record.
 *
 * Quotes and invoices are read in full by their own import, so `sync-entities estimates invoices` already picks their
 * files up; customers, organizations, assets and contracts are imported from LIST rows, which carry no files at all.
 * This walks all six the same way so one run says what exists and what arrived.
 *
 * ZUPER IS READ ONLY HERE: list, then GET each record by uid. Nothing is created, changed or removed in Zuper, and no
 * bytes are copied — the row keeps Zuper's own link (owner, 2026-09-18).
 */

import { config, errorText } from "./../config.js";
import { tuper as db } from "./../tuper-client.js";
import {
  FILE_RECORDS, getSyncConfig, loadMap, writeRecordFiles, zuperFilterPages, zuperGet,
  type Ctx, type FileRecord, type SyncConfig,
} from "./../lib/migration/zuper-sync.js";

/** How each kind's records are listed. The by-uid read is FILE_RECORDS[kind].detail. */
const LISTS: Record<FileRecord, (cfg: SyncConfig) => AsyncGenerator<any[]>> = {
  customer: (cfg) => getPages(cfg, "/api/customers"),
  organization: (cfg) => getPages(cfg, "/api/organization"),
  asset: (cfg) => zuperFilterPages(cfg, "/api/assets/filter"),
  quote: (cfg) => zuperFilterPages(cfg, "/api/estimate/filter"),
  invoice: (cfg) => zuperFilterPages(cfg, "/api/invoice/filter"),
  service_contract: (cfg) => zuperFilterPages(cfg, "/api/service_contract/filter"),
};

/** GET list paging, as sweep-records.ts pages /api/customers: Zuper repeats the last page past the end. */
async function* getPages(cfg: SyncConfig, path: string): AsyncGenerator<any[]> {
  let last = "";
  for (let page = 1; page <= 500; page++) {
    const j = await zuperGet(cfg, `${path}?page=${page}&count=100`);
    const rows: any[] = j?.data ?? [];
    const sig = JSON.stringify(rows[0] ?? null);
    if (!rows.length || sig === last) return;
    last = sig;
    yield rows;
    if (rows.length < 100) return;
  }
}

interface KindCount {
  kind: FileRecord;
  listed: number;      // records Zuper lists
  unmapped: number;    // records Tuper has not imported — nothing to hang a file off
  read: number;        // records read by uid
  withFiles: number;   // records that hold at least one file in Zuper
  files: number;       // files Zuper holds on them
  linked: number;      // rows in jms.attachments now pointing at those files
  removed: number;     // rows marked deleted because Zuper no longer lists the file
  failed: number;
  errors: string[];
}

/** A crude but honest pacer, as sweep.ts uses: keeps the walk under a requests-per-minute ceiling. */
function pacer(perMinute: number) {
  const gap = Math.max(0, Math.floor(60_000 / Math.max(1, perMinute)));
  let last = 0;
  return async () => {
    const wait = gap - (Date.now() - last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
  };
}

async function walk(kind: FileRecord, opts: { dryRun: boolean; pace: () => Promise<void> }): Promise<KindCount> {
  const spec = FILE_RECORDS[kind];
  const client = db();
  const cfg = await getSyncConfig(client, config.tenantId);
  const count: KindCount = { kind, listed: 0, unmapped: 0, read: 0, withFiles: 0, files: 0, linked: 0, removed: 0, failed: 0, errors: [] };

  // The record ids, and the people who upload files. The files map is left empty on purpose: writeZuperFiles matches a
  // file by its link before inserting, so an empty map cannot duplicate a row, and jms.zuper_sync_map's 361k file rows
  // never have to be loaded.
  const records = await loadMap(client, config.tenantId, spec.entity);
  const users = await loadMap(client, config.tenantId, "users");
  const ctx: Ctx = { client, tenantId: config.tenantId, cfg, maps: { files: new Map(), users }, extra: {} };

  for await (const page of LISTS[kind](cfg)) {
    await opts.pace();
    for (const row of page) {
      const uid = row?.[spec.uidField] ?? row?.contract_uid ?? row?.service_contract_uid;
      if (!uid) continue;
      count.listed++;
      const id = records.get(String(uid));
      if (!id) { count.unmapped++; continue; }
      try {
        await opts.pace();
        const record = (await zuperGet(cfg, spec.detail(String(uid))))?.data ?? null;
        if (!record) { count.failed++; continue; }
        count.read++;
        const files = (spec.files(record) ?? []).filter((f: any) => f?.is_deleted !== true);
        // A record Zuper holds no files for is left alone rather than reconciled. writeRecordFiles would also mark
        // anything Tuper still holds for it deleted, and asking that of all 8,000 records is 8,000 more queries for a
        // case this pass does not exist to answer — the attachment events do, one record at a time.
        if (!Array.isArray(files) || !files.length) continue;
        count.withFiles++;
        count.files += files.length;
        if (opts.dryRun) continue;
        const wrote = await writeRecordFiles(ctx, kind, id, record);
        count.linked += wrote.linked;
        count.removed += wrote.removed;
        if (wrote.note) console.log(`  ${kind} ${uid}: ${wrote.note}`);
      } catch (err) {
        count.failed++;
        if (count.errors.length < 5) count.errors.push(`${uid}: ${errorText(err).slice(0, 140)}`);
      }
    }
  }
  return count;
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const perMinute = Number(args[args.indexOf("--per-minute") + 1]) || 120;
const asked = args.filter((a) => !a.startsWith("--") && a !== String(perMinute)) as FileRecord[];
const unknown = asked.filter((k) => !(k in FILE_RECORDS));
if (unknown.length) {
  console.error(`unknown record kind(s): ${unknown.join(", ")} — one of ${Object.keys(FILE_RECORDS).join(", ")}`);
  process.exit(2);
}
// Smallest lists first, so a run says something useful early.
const kinds = (asked.length ? asked : ["service_contract", "invoice", "quote", "organization", "asset", "customer"] as FileRecord[]);

const pace = pacer(perMinute);
console.log(`${dryRun ? "Reading" : "Syncing"} the files on ${kinds.join(", ")} — Zuper is read only, ≤${perMinute} requests a minute\n`);
const results: KindCount[] = [];
for (const kind of kinds) {
  const started = Date.now();
  const c = await walk(kind, { dryRun, pace });
  results.push(c);
  console.log(
    `${kind.padEnd(17)} ${c.listed} listed, ${c.read} read, ${c.withFiles} hold ${c.files} files`
    + `${dryRun ? "" : ` → ${c.linked} linked, ${c.removed} removed`}`
    + `${c.unmapped ? `, ${c.unmapped} not imported` : ""}${c.failed ? `, ${c.failed} failed` : ""}`
    + `  (${Math.round((Date.now() - started) / 1000)}s)`,
  );
  for (const e of c.errors) console.log(`    ${e}`);
}
console.log(`\ntotal: ${results.reduce((n, c) => n + c.files, 0)} files in Zuper on ${results.reduce((n, c) => n + c.withFiles, 0)} records`
  + `${dryRun ? " (nothing written)" : `, ${results.reduce((n, c) => n + c.linked, 0)} linked, ${results.reduce((n, c) => n + c.removed, 0)} removed`}`);
