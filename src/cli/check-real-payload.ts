/**
 * Routing against Zuper's REAL delivery shape.
 *
 *   npm run check-real-payload
 *
 * This guard exists because of a bug that was completely silent.
 *
 * Everything was tested against synthetic bodies shaped {module, event, data},
 * because Zuper documents no payload schema. A genuine delivery, pulled from
 * Zuper's webhook history on 2026-09-16, turns out to be FLAT and to carry no
 * module field at all:
 *
 *   { job_uid, event, work_order_number, scheduled_start_time, triggered_by,
 *     updated_by, company_uid, job_title, all_day_schedule, max_retries,
 *     prev_scheduled_start_time, prev_scheduled_end_time, reason,
 *     triggered_at, workflow_builder }
 *
 * `type` — which identify() probed for a module — belongs to the history ROW,
 * not the body. So module resolved to null, resolveRoute returned null, and every
 * real delivery would have been stored and never processed. Nothing would have
 * errored; it would simply have looked like the sync not working.
 *
 * Routing therefore works from the event key alone. Every catalogued key is
 * looked up exactly (check-wire-routes covers all 203); these assertions pin the
 * no-module case down for one key per syncing module.
 *
 * Pure: routes.ts needs no environment, so this runs anywhere. Identifiers below
 * are placeholders — no customer data belongs in the repository.
 */

import { resolveRoute } from "../routes.js";
import { punchTime } from "../lib/migration/zuper-sync.js";

/** The real delivery, with identifying values replaced. Shape is verbatim. */
const REAL_JOB_PAYLOAD: Record<string, unknown> = {
  job_uid: "00000000-0000-4000-8000-00000000job",
  event: "job.update_schedule",
  work_order_number: "54401",
  job_title: "<redacted>",
  company_uid: "00000000-0000-4000-8000-0000000comp",
  scheduled_start_time: "2026-09-17T06:00:00Z",
  scheduled_end_time: "2026-09-17T07:00:00Z",
  prev_scheduled_start_time: "2026-09-16T06:00:00Z",
  prev_scheduled_end_time: "2026-09-16T07:00:00Z",
  // Zuper sends scalars as strings, and workflow_builder as a PYTHON repr, not
  // JSON — another reason the body is a trigger and never a source of truth.
  all_day_schedule: "False",
  max_retries: "4",
  reason: "",
  workflow_builder: "{'workflow_uid': None, 'from_workflow_builder': False}",
  triggered_at: "2026-09-16T15:51:50.106Z",
  triggered_by: "<redacted>",
  updated_by: "<redacted>",
};

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => (cond ? (pass++, console.log(`  pass  ${name}`)) : (fail++, console.log(`  FAIL  ${name}`)));

// The fact that caused the bug, asserted so it cannot quietly change.
ok("a real Zuper body carries NO module field",
  !("module" in REAL_JOB_PAYLOAD) && !("webhook_module" in REAL_JOB_PAYLOAD) && !("type" in REAL_JOB_PAYLOAD));

// The load-bearing case: no module, only an event.
const r = resolveRoute("", String(REAL_JOB_PAYLOAD.event));
ok("routes with an EMPTY module, from the event prefix alone", r !== null);
// jobs writes the schedule; job_details alone never did (69 of 73 reschedules lost).
ok("…to the full job import, then its details and its activity", r?.entity === "jobs" && (r?.enrich ?? []).join() === "job_details,job_activity");
ok("…and looks for job_uid", (r?.uidFields ?? []).includes("job_uid"));
ok("…and is not treated as a deletion", r?.deletion === false);

// One key per syncing module must resolve with no module supplied.
const PREFIXES: [string, string][] = [
  ["job.update", "jobs"],
  ["customer.create", "customers"],
  ["organization.new", "organizations"],
  ["estimate.delete", "estimates"],       // quotes are ESTIMATES on the wire
  ["product.update", "products"],
  ["invoice.payment", "invoices"],
  ["asset.activate", "assets"],
  ["user.update", "users"],
  ["request.new", "requests"],
  ["service_contract.renew", "contracts"],
];
for (const [event, entity] of PREFIXES) {
  const got = resolveRoute("", event);
  ok(`"${event}" with no module -> ${entity}`, got?.entity === entity);
}

// A module that is present must still win, and nonsense must still be refused.
ok("an explicit module gives the same answer", resolveRoute("JOB", "job.update")?.entity === "jobs");
// Properties are their own Zuper module, not organizations — and have no importer.
const prop = resolveRoute("", "property.new");
ok('"property.new" is skipped, not sent to organizations', prop?.entity !== "organizations" && !!prop?.skip);
ok("an unknown event with no module is still refused", resolveRoute("", "nonsense.thing") === null);
ok("an empty event with no module is refused", resolveRoute("", "") === null);

// Punch times from phones set to the Buddhist calendar come 543 years ahead.
ok("a Buddhist-calendar punch (2569) is read as 2026", punchTime("2569-07-17T10:08:29Z") === "2026-07-17T10:08:29.000Z");
ok("an ordinary punch is left alone", punchTime("2026-09-17T10:15:35Z") === "2026-09-17T10:15:35.000Z");
console.log("");
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
