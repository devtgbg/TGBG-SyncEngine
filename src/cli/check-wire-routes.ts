/**
 * Does routing survive Zuper's REAL wire strings?
 *
 *   npm run check-wire-routes
 *
 * check-routes validates the catalogue against itself, which is precisely the
 * blind spot that hid three live bugs: Zuper's webhook form shows display labels
 * ("Quote Delete", module "Quotes") while the wire carries lowercase dotted event
 * names under different module names ("estimate.delete", module "ESTIMATES").
 * Routing matched the labels and would have dropped every real delivery.
 *
 * The fixtures below are the 73 distinct module/event pairs actually configured
 * in this Zuper account, read from GET /service/notifications/webhook on
 * 2026-09-16. Fixtures rather than a live call so this runs without an API key.
 *
 * Note REQUEST: 8 request webhooks are live even though Zuper's New Webhook form
 * never offers that module.
 */

import { resolveRoute } from "../routes.js";

const WIRE: Record<string, string[]> = {
  ASSETS: ["asset.activate", "asset.deactivate", "asset.delete", "asset.new", "asset.recover", "asset.status_update", "asset.update"],
  CUSTOMER: ["customer.accounts_update", "customer.activate", "customer.create", "customer.deactivate", "customer.update"],
  ESTIMATES: ["estimate.bulk_action", "estimate.delete", "estimate.delete_attachment", "estimate.delete_note", "estimate.deposit",
    "estimate.new", "estimate.new_attachment", "estimate.new_note", "estimate.print", "estimate.recover", "estimate.send",
    "estimate.status_update", "estimate.update"],
  INVOICE: ["invoice.delete", "invoice.new", "invoice.payment", "invoice.status_update", "invoice.update"],
  JOB: ["job.assign_users", "job.delete", "job.new", "job.schedule", "job.status_update", "job.unassign_users", "job.update", "job.update_schedule"],
  PROPERTY: ["property.activate", "property.assign_users", "property.bulk_action", "property.deactivate", "property.delete",
    "property.delete_attachment", "property.new", "property.new_attachment", "property.unassign_users", "property.update", "property.update_attachment"],
  REQUEST: ["request.assign_users", "request.delete", "request.new", "request.new_note", "request.status_rollback",
    "request.status_update", "request.unassign_users", "request.update"],
  SERVICE_CONTRACTS: ["service_contract.activate", "service_contract.bulk_action", "service_contract.deactivate", "service_contract.delete",
    "service_contract.delete_note", "service_contract.new", "service_contract.new_note", "service_contract.renew",
    "service_contract.status_update", "service_contract.update", "service_contract.update_note"],
  USER: ["user.activate", "user.deactivate", "user.delete", "user.new", "user.update"],
};

/** Exactly the events that remove the record itself. Nothing else may match. */
const MUST_DELETE = new Set([
  "ASSETS|asset.delete", "ESTIMATES|estimate.delete", "INVOICE|invoice.delete",
  "JOB|job.delete", "PROPERTY|property.delete", "REQUEST|request.delete",
  "SERVICE_CONTRACTS|service_contract.delete", "USER|user.delete",
]);

let routed = 0, skipped = 0, inferred = 0;
const problems: string[] = [];
const perModule: Record<string, { routed: number; skipped: number }> = {};

for (const [mod, events] of Object.entries(WIRE)) {
  perModule[mod] = { routed: 0, skipped: 0 };
  for (const ev of events) {
    const r = resolveRoute(mod, ev);
    if (!r) { problems.push(`${mod}/${ev}: NO ROUTE — the delivery would be stored and never processed`); continue; }

    // Deletion detection must be exact: estimate.delete removes the quote, but
    // estimate.delete_note and estimate.delete_attachment must not.
    const shouldDelete = MUST_DELETE.has(`${mod}|${ev}`);
    if (r.deletion && !shouldDelete) problems.push(`${mod}/${ev}: treated as a DELETION — it would mark a live record deleted`);
    if (!r.deletion && shouldDelete) problems.push(`${mod}/${ev}: NOT treated as a deletion — it would re-fetch a removed record and 404`);

    if (r.skip) { skipped++; perModule[mod].skipped++; } else { routed++; perModule[mod].routed++; }
    if (r.inferred) inferred++;
  }
}

const total = Object.values(WIRE).reduce((n, e) => n + e.length, 0);
console.log(`Zuper's real wire strings — ${total} distinct module/event pairs, 9 modules\n`);
for (const [m, c] of Object.entries(perModule)) {
  console.log(`  ${m.padEnd(19)} ${String(c.routed).padStart(2)} routed${c.skipped ? `, ${c.skipped} skipped` : ""}`);
}
console.log("");
console.log(`  routed   : ${routed}`);
console.log(`  skipped  : ${skipped}`);
console.log(`  inferred : ${inferred} (not in the catalogue by name — fell back to the module default, which re-syncs the record)`);

if (problems.length) {
  console.log(`\n${problems.length} PROBLEM(S):`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`\n✓ every real wire string routes, and all 8 deletions are detected exactly`);
