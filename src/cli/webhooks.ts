/**
 * Registering Zupersync's webhooks in Zuper.
 *
 *   npm run webhooks                      # list what Zuper already has
 *   npm run webhooks -- plan              # what WOULD be created (default, no writes)
 *   npm run webhooks -- apply --only JOB/job.update
 *   npm run webhooks -- apply             # create everything still missing
 *
 * PLAN IS THE DEFAULT. Creating webhooks is a write to Zuper, and dozens of them
 * is not something a command should do because you forgot a flag.
 *
 * Scope: every event in Zuper's catalogue (routes.ts) that Zupersync acts on.
 * Events it would only store and skip are not subscribed — timesheet check-ins
 * and GPS locations alone would flood the log. Webhooks already registered for a
 * now-skipped event are listed but left alone. Other subscribers' webhooks (the
 * client portal, DataHouse) are never touched.
 *
 * The header is the whole game. Production refuses a delivery whose
 * x-zupersync-key does not match, so a webhook created without it — or with it
 * stored under a field name Zuper does not read — yields an endpoint that
 * refuses everything. Hence `apply --only` first, read back, confirm, then bulk.
 *
 * Zuper's secret_key is returned inline by its list endpoint and is NEVER printed
 * here; nor is ours.
 */

import { config } from "../config.js";
import { EVENT_CATALOGUE, resolveRoute } from "../routes.js";

const argv = process.argv.slice(2);
const cmd = (argv.find((a) => !a.startsWith("--")) ?? "plan").toLowerCase();
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

const BASE = config.zuper.apiUrl.replace(/\/+$/, "");
const ENDPOINT = opt("url") ?? "https://zupersync.golfbuggyguy.com/webhooks/zuper";

const zuper = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "x-api-key": config.zuper.apiKey, "content-type": "application/json", accept: "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* Zuper answers HTML on a wrong path */ }
  return { ok: res.ok, status: res.status, json, text };
};

interface Existing { webhook_uid: string; webhook_module: string; webhook_event: string; webhook_url: string }

/** Everything Zuper currently has. secret_key is dropped on the way in. */
async function existing(): Promise<Existing[]> {
  const out: Existing[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await zuper(`/service/notifications/webhook?page=${page}&count=100`);
    if (!r.ok) throw new Error(`listing webhooks failed: HTTP ${r.status}`);
    const rows = (r.json?.data ?? []) as any[];
    if (!rows.length) break;
    for (const w of rows) {
      out.push({
        webhook_uid: w.webhook_uid, webhook_module: w.webhook_module,
        webhook_event: w.webhook_event, webhook_url: String(w.webhook_url ?? ""),
      });
    }
    if (rows.length < 100) break;
  }
  return out;
}

/**
 * The events to subscribe to: every catalogued event that routes to real work.
 * The catalogue holds Zuper's wire keys and module names, exactly as
 * GET /api/misc/{MODULE}/events returns them, so a webhook made from it fires.
 */
function wanted(): { module: string; event: string }[] {
  const out: { module: string; event: string }[] = [];
  for (const [module, events] of Object.entries(EVENT_CATALOGUE)) {
    for (const event of events) {
      const r = resolveRoute(module, event);
      if (r && !r.skip) out.push({ module, event });
    }
  }
  return out;
}

async function create(module: string, event: string): Promise<{ ok: boolean; detail: string }> {
  const body = {
    web_hook: {
      webhook_name: `Zupersync - ${event}`,
      webhook_module: module,
      webhook_event: event,
      webhook_url: ENDPOINT,
      request_method: "POST",
      content_type: "application/json",
      // An OBJECT, not a pre-stringified string. Zuper stringifies it once itself
      // for storage, exactly as its UI does.
      //
      // Sending JSON.stringify(...) here produces a double-encoded value: the
      // string is serialised again with the body, and Zuper stores the literal
      // `"{\"x-zupersync-key\":\"…\"}"` — which needs two json.loads to reach a
      // dict, where a webhook created through the UI needs one. Compared against
      // a working webhook byte for byte: theirs begins `{"x-tgbg-webhook-token":`
      // (70 chars), the double-encoded one begins `"{\"…` (92). A double-encoded
      // value is not sent as a header at all, so every delivery would arrive
      // unverified and be refused.
      headers: { [config.webhook.header]: config.webhook.secret },
    },
  };
  // Create shares the /service/notifications/ prefix with list. Zuper's docs show
  // a shortened `POST /webhook`, which answers 503 with an HTML body — the same
  // contradiction between their curl samples and their OpenAPI paths that the
  // list endpoint has. Probed with an empty body: only this path answered JSON
  // ({"message":"Webhook details are mandatory"}), i.e. a real endpoint.
  const r = await zuper("/service/notifications/webhook", { method: "POST", body: JSON.stringify(body) });
  return { ok: r.ok, detail: r.ok ? (r.json?.data?.webhook_uid ?? "created") : `HTTP ${r.status} ${r.text.slice(0, 160)}` };
}

async function main() {
  console.log(`Zuper    : ${BASE}`);
  console.log(`Endpoint : ${ENDPOINT}`);
  console.log(`Header   : ${config.webhook.header} (value not shown, ${config.webhook.secret.length} chars)`);
  console.log("");

  const rows = await existing();
  const ours = rows.filter((w) => w.webhook_url === ENDPOINT);
  const others = rows.length - ours.length;
  console.log(`Zuper has ${rows.length} webhook(s): ${ours.length} ours, ${others} belonging to other subscribers (untouched).`);
  console.log("");

  if (cmd === "list") {
    const byHost = new Map<string, number>();
    for (const w of rows) {
      const h = w.webhook_url.split("/")[2] ?? "?";
      byHost.set(h, (byHost.get(h) ?? 0) + 1);
    }
    for (const [h, n] of [...byHost].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${h}`);
    return;
  }

  const have = new Set(ours.map((w) => `${w.webhook_module}|${w.webhook_event}`));
  const only = opt("only");
  let targets = wanted();
  if (only) {
    const [m, e] = only.split("/");
    targets = targets.filter((t) => t.module === m && t.event === e);
    if (!targets.length) { console.log(`${only} is not a synced event in the catalogue (routes.ts).`); process.exit(1); }
  }

  // Registered earlier for events that are now skipped: harmless (stored with the
  // reason), kept so they start working when that sync is built.
  const inScope = new Set(wanted().map((t) => `${t.module}|${t.event}`));
  const idle = ours.filter((w) => !inScope.has(`${w.webhook_module}|${w.webhook_event}`));
  if (idle.length && !only) {
    console.log(`${idle.length} of ours are for events Zupersync stores but skips:`);
    for (const w of idle) console.log(`  ${w.webhook_module.padEnd(18)} ${w.webhook_event.padEnd(34)} ${resolveRoute(w.webhook_module, w.webhook_event)?.skip?.slice(0, 48) ?? "NO ROUTE"}`);
    console.log("");
  }

  const missing = targets.filter((t) => !have.has(`${t.module}|${t.event}`));
  console.log(`${targets.length} event(s) in scope, ${targets.length - missing.length} already registered, ${missing.length} missing.`);
  console.log("");

  // Show how each would route, so a webhook is never created for something that
  // would only be stored and skipped.
  for (const t of missing) {
    const r = resolveRoute(t.module, t.event);
    const note = !r ? "NO ROUTE" : r.deletion ? `-> ${r.entity} (mark deleted)` : `-> ${r.entity}${r.enrich ? ` + ${r.enrich}` : ""}`;
    console.log(`  ${t.module.padEnd(18)} ${t.event.padEnd(34)} ${note}`);
  }
  console.log("");

  if (cmd !== "apply") {
    console.log("PLAN ONLY — nothing was created. Re-run with `apply` to create them.");
    console.log("Create one first and confirm a real delivery verifies before doing all of them:");
    console.log("  npm run webhooks -- apply --only ORGANIZATION/organization.update");
    return;
  }

  if (!config.webhook.secret) {
    console.log("REFUSING: ZUPER_WEBHOOK_SECRET is empty. Every delivery would be refused by the receiver.");
    process.exit(1);
  }

  let made = 0, failed = 0;
  for (const t of missing) {
    const r = await create(t.module, t.event);
    console.log(`  ${r.ok ? "created" : "FAILED "} ${t.module}/${t.event}  ${r.ok ? "" : r.detail}`);
    r.ok ? made++ : failed++;
    await new Promise((s) => setTimeout(s, 250)); // stay well inside Zuper's rate limit
  }
  console.log("");
  console.log(`${made} created, ${failed} failed.`);

  // Read back what Zuper stored. The header value itself is checked by a real
  // delivery arriving verified; the list only proves the rows exist.
  const after = (await existing()).filter((w) => w.webhook_url === ENDPOINT);
  const nowHave = new Set(after.map((w) => `${w.webhook_module}|${w.webhook_event}`));
  const absent = missing.filter((t) => !nowHave.has(`${t.module}|${t.event}`));
  console.log(`${after.length} webhook(s) now point at ${ENDPOINT}; ${absent.length} requested but not listed.`);
  for (const t of absent) console.log(`  not listed: ${t.module}/${t.event}`);
  if (failed || absent.length) process.exit(1);
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
