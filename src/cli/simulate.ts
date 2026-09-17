/**
 * Replay a webhook delivery locally, without waiting on Zuper.
 *
 *   npm run simulate                                  # dry run — resolve only, no writes
 *   npm run simulate -- --module Jobs --event "Update Job" --uid <job_uid>
 *   npm run simulate -- --send                        # POST to the local receiver (WRITES)
 *   npm run simulate -- --send --bad-secret           # prove a wrong header is refused
 *
 * DRY RUN IS THE DEFAULT, on purpose. There is no local database — every
 * environment points at the shared Supabase — so "processing" a delivery re-reads
 * the record from Zuper and writes the live jms.* row that four applications read.
 * That is correct behaviour, and idempotent, but it is not something a command
 * called "simulate" should do unless asked.
 *
 * A CAVEAT worth keeping in mind: Zuper does not document its webhook payload
 * shape anywhere. The body below is a plausible guess. A local pass proves the
 * pipeline — verify → store → ack → route → upsert — but NOT that identify() will
 * find the module/event/uid in a real delivery. Capture a real one from
 * GET /service/notifications/webhook_history to settle that.
 */

import { config, secretConfigured } from "../config.js";
import { db } from "../supabase.js";
import { resolveRoute } from "../routes.js";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const moduleName = opt("module", "Jobs")!;
const eventName = opt("event", "Update Job")!;
const send = flag("send");
const badSecret = flag("bad-secret");

/** A real uid from the sync map, so the re-fetch has something to find. */
async function sampleUid(entity: string): Promise<string | null> {
  const { data } = await db().schema("jms").from("zuper_sync_map")
    .select("zuper_uid").eq("tenant_id", config.tenantId).eq("entity", entity).limit(1).maybeSingle();
  return (data as { zuper_uid?: string } | null)?.zuper_uid ?? null;
}

async function main() {
  const route = resolveRoute(moduleName, eventName);
  console.log(`module : ${moduleName}`);
  console.log(`event  : ${eventName}`);
  if (!route) { console.log("route  : NONE — this module is not recognised"); process.exit(1); }

  console.log(`route  : ${route.entity}${route.enrich ? ` then ${route.enrich}` : ""}`);
  console.log(`fetch  : ${route.fetch}${route.deletion ? " + deletion" : ""}`);
  console.log(`uid in : ${route.uidFields.join(" or ")}`);
  if (route.skip) console.log(`skip   : ${route.skip}`);

  const mapEntity = route.entity;
  const uid = opt("uid") ?? (await sampleUid(mapEntity));
  if (!uid) { console.log(`\nno uid: pass --uid, or import some ${mapEntity} first`); process.exit(1); }
  console.log(`uid    : ${uid}`);

  // The guessed shape — module/event at the top, the record under `data`.
  const body = { event: eventName, module: moduleName, data: { [route.uidFields[0]]: uid } };

  if (!send) {
    console.log("\nDRY RUN — nothing sent, nothing written.");
    console.log("Re-run with --send to POST this to the local receiver:");
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  if (!secretConfigured()) console.warn("\n! ZUPER_WEBHOOK_SECRET is unset — the receiver cannot verify anything");
  const url = `http://localhost:${config.port}/webhooks/zuper`;
  const secret = badSecret ? "definitely-not-the-secret" : config.webhook.secret;

  console.log(`\nPOST ${url}`);
  console.log(`  header ${config.webhook.header}: ${badSecret ? "(deliberately wrong)" : "(correct)"}`);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", [config.webhook.header]: secret ?? "" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.log(`\ncould not reach the receiver — is it running? (npm run dev)`);
    console.log(`  ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const json = await res.json().catch(() => ({}));
  console.log(`  → HTTP ${res.status} ${JSON.stringify(json)}`);
  if (res.status !== 200) { console.log("\nthe receiver should ALWAYS answer 200 — a non-2XX burns one of Zuper's three retries"); process.exit(1); }

  // Processing happens after the ack, so give it a moment and read the outcome.
  const stored = (json as { stored?: string }).stored;
  if (!stored) { console.log("\nno delivery id came back — nothing was stored"); process.exit(1); }

  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const { data } = await db().schema("jms").from("zuper_webhook_events")
      .select("verified, verify_reason, module, event, zuper_uid, sync_entity, processed_at, process_error")
      .eq("id", stored).maybeSingle();
    const row = data as Record<string, unknown> | null;
    if (!row) continue;
    if (row.processed_at || row.process_error || (badSecret && row.verified === false)) {
      console.log("\nstored delivery:");
      for (const [k, v] of Object.entries(row)) console.log(`  ${k.padEnd(16)} ${v ?? "—"}`);
      if (row.process_error) process.exit(1);
      return;
    }
  }
  console.log("\nstill unprocessed after 12s — check the receiver's log");
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
