/**
 * Does routing agree with Zuper's own event catalogue?
 *
 *   npm run check-wire-routes
 *
 * The fixture is every event Zuper can send — 12 modules, 203 events — as returned
 * by `GET /api/misc/{MODULE}/events`, the endpoint Zuper's New Webhook form calls.
 * It was captured on 2026-09-17 and is kept verbatim in fixtures/zuper-events.json,
 * so this runs without an API key.
 *
 * Why it matters: routing was once keyed by the form's display labels, and a real
 * delivery carries the wire key instead. Most rules never matched live traffic,
 * and nothing reported it. This holds routes.ts to the keys Zuper actually sends,
 * with no module field (a real body has none), and to the exact set of events
 * that remove a record.
 */

import { readFileSync } from "node:fs";
import { EVENT_CATALOGUE, resolveRoute } from "../routes.js";

interface Fixture { _captured: string; modules: Record<string, [string, string][]> }
const fixture = JSON.parse(readFileSync(new URL("./fixtures/zuper-events.json", import.meta.url), "utf8")) as Fixture;

/**
 * Exactly the events that remove something: the record itself, or one of its
 * notes. `estimate.delete` removes the quote; `estimate.delete_attachment` must
 * not, and `job.delete_recurrence` removes a rule, not the job. Notes on quotes,
 * invoices and contracts are not kept, so their deletions are skipped.
 */
const MUST_DELETE: Record<string, string> = {
  "job.delete": "jobs",
  "organization.delete": "organizations",
  "product.delete": "products",
  "estimate.delete": "estimates",
  "invoice.delete": "invoices",
  "service_contract.delete": "contracts",
  "asset.delete": "assets",
  "user.delete": "users",
  "request.delete": "requests",
  "job.delete_note": "notes",
  "customer.delete_note": "notes",
  "asset.delete_note": "notes",
};

/** Note events Tuper keeps, and the record each note is on. */
const NOTE_EVENTS: Record<string, string> = {
  "job.new_note": "job", "job.update_note": "job", "job.delete_note": "job",
  "customer.new_note": "customer", "customer.update_note": "customer", "customer.delete_note": "customer",
  "asset.new_note": "asset", "asset.update_note": "asset", "asset.delete_note": "asset",
  "request.new_note": "request",
};

const problems: string[] = [];
const norm = (s: string) => s.toLowerCase().replace(/[\s_\-/.]+/g, "");
const same = (a: ReturnType<typeof resolveRoute>, b: ReturnType<typeof resolveRoute>) =>
  !!a && !!b && a.module === b.module && a.entity === b.entity && a.deletion === b.deletion && a.skip === b.skip;

// 1. routes.ts carries exactly Zuper's catalogue, module for module.
const fixtureModules = Object.keys(fixture.modules).sort();
const routeModules = Object.keys(EVENT_CATALOGUE).sort();
if (fixtureModules.join() !== routeModules.join()) {
  problems.push(`modules differ — Zuper: ${fixtureModules.join(", ")}; routes.ts: ${routeModules.join(", ")}`);
}
for (const m of fixtureModules) {
  const want = new Set(fixture.modules[m].map(([k]) => k));
  const have = new Set(EVENT_CATALOGUE[m] ?? []);
  for (const k of want) if (!have.has(k)) problems.push(`${m}/${k}: in Zuper's catalogue, missing from routes.ts`);
  for (const k of have) if (!want.has(k)) problems.push(`${m}/${k}: in routes.ts, not in Zuper's catalogue`);
}

// 2. Keys never collide once normalised — routing looks them up globally.
const seenKey = new Map<string, string>();
for (const [m, events] of Object.entries(fixture.modules)) {
  for (const [k] of events) {
    const prior = seenKey.get(norm(k));
    if (prior) problems.push(`${m}/${k} collides with ${prior} after normalising`);
    seenKey.set(norm(k), `${m}/${k}`);
  }
}

// 3. Every event routes as a real delivery would arrive: no module, key only.
let routed = 0, skipped = 0, deletions = 0;
const perModule: Record<string, { routed: number; skipped: number; deletions: number }> = {};
for (const [m, events] of Object.entries(fixture.modules)) {
  const c = (perModule[m] = { routed: 0, skipped: 0, deletions: 0 });
  for (const [key, name] of events) {
    const r = resolveRoute("", key);
    if (!r) { problems.push(`${m}/${key}: NO ROUTE — the delivery would be stored and never processed`); continue; }
    if (r.module !== m) problems.push(`${key}: routed under ${r.module}, but Zuper files it under ${m}`);
    if (r.inferred) problems.push(`${key}: resolved by fallback, not by its own rule`);

    const wantDelete = MUST_DELETE[key];
    if (r.deletion && !wantDelete) problems.push(`${key}: treated as a DELETION — it would mark a live record deleted`);
    if (!r.deletion && wantDelete) problems.push(`${key}: NOT treated as a deletion — it would re-fetch a removed record`);
    if (wantDelete && r.entity !== wantDelete) problems.push(`${key}: deletes from ${r.entity}, expected ${wantDelete}`);
    if (wantDelete && r.skip) problems.push(`${key}: a deletion is skipped (${r.skip})`);
    if (wantDelete && r.enrich?.length) problems.push(`${key}: a deletion must not re-read the record it removed`);
    // Every job change must write the row itself (job_details alone never writes the schedule), and refresh
    // the activity feed and time logs (job_activity).
    const passes = [r.entity, ...(r.enrich ?? [])].join(" > ");
    if (m === "JOB" && !r.skip && !r.deletion && !r.noteHost && passes !== "jobs > job_details > job_activity") {
      problems.push(`${key}: a job change must run jobs > job_details > job_activity, got ${passes}`);
    }

    // A note event re-reads the notes of the record it names, by that record's uid.
    const host = NOTE_EVENTS[key];
    if (host && (r.noteHost !== host || r.entity !== "notes" || r.fetch !== "host" || r.uidFields.join() !== `${host}_uid` || r.skip)) {
      problems.push(`${key}: expected a note sync on its ${host} (${host}_uid), got ${r.entity}/${r.fetch}/${r.noteHost ?? "-"}${r.skip ? ` skipped: ${r.skip}` : ""}`);
    }
    if (!host && r.noteHost) problems.push(`${key}: unexpectedly treated as a note event`);
    if (/_note$/.test(key) && !host && !r.skip) problems.push(`${key}: a note event on a record Tuper keeps no notes for must be skipped`);

    // The same event named by module + display name (the simulator's form) must agree.
    if (!same(resolveRoute(m, name), r)) problems.push(`${m}/"${name}" routes differently from ${key}`);
    // And an explicit module must not change the answer.
    if (!same(resolveRoute(m, key), r)) problems.push(`${m}/${key} routes differently when the module is given`);

    if (r.skip) { skipped++; c.skipped++; } else { routed++; c.routed++; }
    if (r.deletion) { deletions++; c.deletions++; }
  }
}

// 4. The mistake this rewrite fixed: a property is not an organization.
for (const [key] of fixture.modules.PROPERTY ?? []) {
  const r = resolveRoute("", key);
  if (r?.entity === "organizations") problems.push(`${key}: sent to organizations — a property uid 404s there`);
  if (!r?.skip) problems.push(`${key}: properties have no importer, so this must be skipped`);
}

// 5. Events Zuper adds later: a known module re-reads the record; the rest are refused.
// Punches and attachments are job changes now; line items are deliberately not.
for (const key of ["job.timelog", "job.timelog_update", "job.new_attachment", "job.update_attachment"]) {
  const r = resolveRoute("", key);
  if (!r || r.skip || r.entity !== "jobs") problems.push(`${key}: expected a full job re-read, got ${r?.entity ?? "none"}${r?.skip ? ` (skipped: ${r.skip})` : ""}`);
}
for (const key of ["job.product_update", "job.delete_attachment"]) {
  if (!resolveRoute("", key)?.skip) problems.push(`${key}: must stay skipped`);
}

const future: [string, string | null, boolean][] = [
  ["job.some_new_event", "jobs", true],
  ["organization.some_new_event", "organizations", true],
  ["customer.some_new_event", "customers", true],
];
for (const [key, entity, inferred] of future) {
  const r = resolveRoute("", key);
  if (r?.entity !== entity || r?.inferred !== inferred || r?.skip) problems.push(`${key}: expected an inferred re-read of ${entity}`);
}
if (!resolveRoute("", "property.some_new_event")?.skip) problems.push("an unknown property event must be skipped");
if (resolveRoute("", "measurement.some_new_event") !== null) problems.push("an unknown measurement event must not become a job re-sync");
if (resolveRoute("", "nonsense.thing") !== null) problems.push("an unknown prefix must be refused");

const total = Object.values(fixture.modules).reduce((n, e) => n + e.length, 0);
console.log(`Zuper's event catalogue (captured ${fixture._captured}) — ${total} events, ${fixtureModules.length} modules\n`);
for (const [m, c] of Object.entries(perModule)) {
  const parts = [`${String(c.routed).padStart(2)} synced`];
  if (c.skipped) parts.push(`${c.skipped} skipped`);
  if (c.deletions) parts.push(`${c.deletions} deletion${c.deletions === 1 ? "" : "s"}`);
  console.log(`  ${m.padEnd(19)} ${parts.join(", ")}`);
}
console.log("");
console.log(`  synced    : ${routed}  (of which ${deletions} mark a record deleted)`);
console.log(`  skipped   : ${skipped}  (stored with the reason, never synced)`);

if (problems.length) {
  console.log(`\n${problems.length} PROBLEM(S):`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`\n✓ all ${total} events route by their wire key, and all ${Object.keys(MUST_DELETE).length} deletions are exact`);
