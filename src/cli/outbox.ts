/**
 * What the pusher has queued, planned and sent.
 *
 *   npm run outbox                 # the last 20 rows, newest first
 *   npm run outbox -- --limit 50
 *   npm run outbox -- --plan       # plan everything queued now (dry run, sends nothing)
 *
 * Prints request paths and field names, never field values beyond the record's
 * label (a work order number, a customer's name): the bodies hold addresses and phone numbers.
 */

import { config } from "../config.js";
import { sql } from "../store.js";
import { pushPending, type Plan } from "../pusher.js";

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

async function main() {
  if (argv.includes("--plan")) {
    const r = await pushPending("dry-run", Number(opt("limit") ?? 50));
    console.log(`planned ${r.planned}, skipped ${r.skipped}, failed ${r.failed}, waiting ${r.waiting} (nothing sent)\n`);
  }
  const data = await sql<any>(
    `SELECT queued_at, entity, operation, status, origin, attempts, last_error, changed, planned
       FROM sync.outbox WHERE tenant_id = $1 ORDER BY queued_at DESC LIMIT $2`,
    [config.tenantId, Number(opt("limit") ?? 20)],
  );
  if (!data.length) { console.log("the outbox is empty"); return; }
  for (const r of data) {
    const p = r.planned as Plan | null;
    const cols = r.operation === "create" ? `(new ${r.entity})` : Object.keys(r.changed ?? {}).join(", ");
    console.log(`${String(r.queued_at).slice(0, 19)}  ${r.status.padEnd(10)} ${r.operation.padEnd(6)} ${String(r.entity).padEnd(9)} ${p?.label ?? (p?.workOrder ? `WO ${p.workOrder}` : "?")}  ${cols}`);
    for (const q of p?.requests ?? []) {
      const body = q.body as any;
      const keys = body?.job ? Object.keys(body.job) : body ? Object.keys(body) : [];
      console.log(`      → ${q.method} ${q.path}  {${keys.join(", ")}}  — ${q.why}`);
    }
    for (const n of p?.notPushed ?? []) console.log(`      · not pushed: ${n.column} — ${n.reason}`);
    if (p?.blocked) console.log(`      ✗ blocked: ${p.blocked}`);
    if (r.last_error && !p?.blocked) console.log(`      ✗ ${r.last_error} (attempt ${r.attempts})`);
  }
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
