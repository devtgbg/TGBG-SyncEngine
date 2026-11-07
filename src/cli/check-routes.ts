/**
 * Guard: every route must point at an entity that actually exists.
 *
 *   npm run check-routes
 *
 * routes.ts names 18 sync entities as plain strings. TypeScript cannot check them
 * — ENTITIES is a Record<string, Entity>, so a typo compiles perfectly and fails
 * only when that particular webhook fires, in production, at whatever hour Zuper
 * chooses. This runs Zuper's whole event catalogue through resolveRoute() and
 * asserts each result resolves.
 *
 * Deliberately imports nothing that needs env vars, so it runs anywhere.
 */

import { ENTITIES } from "../lib/migration/zuper-sync.js";
import { EVENT_CATALOGUE, EVENT_COUNT, MODULE_NAMES, fetchModeFor, resolveRoute, selfFetchingEntities, unroutedEvents } from "../routes.js";
import { UID_FIELD_BY_ENTITY } from "../lib/uid-fields.js";

const registry = new Set(Object.keys(ENTITIES));

let routed = 0, skipped = 0;
const bad: string[] = [];
const byEntity = new Map<string, number>();

for (const module of MODULE_NAMES) {
  for (const event of EVENT_CATALOGUE[module]) {
    const r = resolveRoute(module, event);
    if (!r) { bad.push(`${module}/${event}: resolveRoute returned null for a catalogued event`); continue; }
    if (r.skip) { skipped++; continue; }
    if (!registry.has(r.entity)) { bad.push(`${module}/${event} → "${r.entity}" is not in ENTITIES`); continue; }
    const missing = (r.enrich ?? []).filter((e) => !registry.has(e));
    if (missing.length) { bad.push(`${module}/${event} → enrich ${missing.join(", ")} not in ENTITIES`); continue; }
    // An enrich entity is synced BY UID, so it needs a way to read one record. Absent from ENTITY_FETCH it reads as
    // `unsupported`, and the processor refuses to transform the stub — on every delivery of this event, in production.
    // asset_history_live shipped one review short of exactly this.
    const unreadable = (r.enrich ?? []).filter((e) => fetchModeFor(e) === "unsupported");
    if (unreadable.length) { bad.push(`${module}/${event} → enrich ${unreadable.join(", ")} has no ENTITY_FETCH entry, so the processor will refuse the stub`); continue; }
    routed++;
    byEntity.set(r.entity, (byEntity.get(r.entity) ?? 0) + 1);
  }
}

// An unknown module must NOT fall through to some default entity.
if (resolveRoute("Nonsense", "New Nonsense") !== null) bad.push("an unknown module resolved to a route instead of null");

// A self-fetching entity is handed a uid and nothing else. Its transform reads that uid back under Zuper's own name
// for it, so a missing name builds the path from `undefined` — Zuper answers, the sync reports success, and nothing
// was read. The table is a Record<string, string>; only this says the entity is in it.
for (const e of selfFetchingEntities()) {
  if (!UID_FIELD_BY_ENTITY[e]) bad.push(`"${e}" fetches its own record from a uid stub but has no uid field in UID_FIELD_BY_ENTITY — it would fetch /…/undefined`);
}

console.log(`modules   : ${MODULE_NAMES.length}`);
console.log(`events    : ${EVENT_COUNT} catalogued`);
console.log(`routed    : ${routed}`);
console.log(`skipped   : ${skipped} (deliberate — nothing to sync)`);
console.log("");
console.log("events per entity:");
for (const [e, n] of [...byEntity].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${e}`);
console.log("");
console.log("deliberately not synced:");
for (const u of unroutedEvents()) console.log(`  ${u.module}/${u.event} — ${u.reason}`);

if (bad.length) {
  console.log("");
  console.log(`${bad.length} PROBLEM(S):`);
  for (const b of bad) console.log(`  ✗ ${b}`);
  process.exit(1);
}
console.log("");
console.log(`✓ all ${routed} routed events point at a real entity`);
