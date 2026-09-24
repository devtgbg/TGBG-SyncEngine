// What the workflows entity WOULD write, without writing it: fetch Zuper's nine, run the entity's own transform,
// and print the rows. Reads only — nothing is upserted.
import { config } from "../src/config.js";
import { tuper as db } from "../src/tuper-client.js";
import { getSyncConfig, ENTITIES } from "../src/lib/migration/zuper-sync.js";

const client = db();
const cfg = await getSyncConfig(client, config.tenantId);
const ctx: any = { client, tenantId: config.tenantId, cfg, maps: {}, extra: {} };
const e = ENTITIES.workflows;

const rows = await e.fetch!(ctx);
console.log(`fetched ${rows.length}\n`);
let unmapped = 0, notBuilt = 0;
for (const r of rows) {
  const out: any = await e.transform(r, ctx);
  console.log(`### ${out.name}`);
  console.log(`   uid         ${out.zuper_uid}`);
  console.log(`   trigger     ${r.trigger_event}  ->  ${out.trigger_event}   module=${out.trigger_module}  active=${out.is_active} (Zuper: ${r.is_active})`);
  console.log(`   access      ${out.workflow_access}  users=${JSON.stringify(out.allowed_users)} teams=${JSON.stringify(out.allowed_teams)}  chain=${out.allow_workflow_to_trigger}`);
  if (String(out.trigger_event).startsWith("zuper.")) unmapped++;
  for (const c of out.conditions) console.log(`   IF          ${c.field} ${c.op} ${JSON.stringify(c.value)}`);
  for (const a of out.actions) {
    if (a.type === "log" && a.not_built) { notBuilt++; console.log(`   DO          (not built) ${a.display_name}`); continue; }
    const brief = { ...a }; delete brief.type;
    for (const k of Object.keys(brief)) if (typeof brief[k] === "string" && brief[k].length > 90) brief[k] = brief[k].slice(0, 90) + "…";
    console.log(`   DO          ${a.type}  ${JSON.stringify(brief)}`);
  }
  console.log("");
}
console.log(`triggers with no Tuper event: ${unmapped}   actions Tuper can't do: ${notBuilt}`);
process.exit(0);
