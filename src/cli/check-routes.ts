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
import { EVENT_CATALOGUE, EVENT_COUNT, MODULE_NAMES, resolveRoute, unroutedEvents } from "../routes.js";

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
    if (r.enrich && !registry.has(r.enrich)) { bad.push(`${module}/${event} → enrich "${r.enrich}" is not in ENTITIES`); continue; }
    routed++;
    byEntity.set(r.entity, (byEntity.get(r.entity) ?? 0) + 1);
  }
}

// An unknown module must NOT fall through to some default entity.
if (resolveRoute("Nonsense", "New Nonsense") !== null) bad.push("an unknown module resolved to a route instead of null");

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
