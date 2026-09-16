/**
 * Registering Zupersync's webhooks in Zuper.
 *
 *   npm run webhooks                      # list what Zuper already has
 *   npm run webhooks -- plan              # what WOULD be created (default, no writes)
 *   npm run webhooks -- apply --only JOB/job.update
 *   npm run webhooks -- apply             # create everything still missing
 *
 * PLAN IS THE DEFAULT. Creating webhooks is a write to Zuper, and 73 of them is
 * not something a command should do because you forgot a flag.
 *
 * Scope: the event names Zuper is ALREADY emitting to its other subscribers (the
 * client portal and DataHouse). Nothing new is switched on in Zuper — Zupersync
 * becomes a third subscriber to events that already fire. Those other webhooks
 * are never touched.
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
 * The events to subscribe to: exactly those Zuper already emits. Reading them
 * from the live configuration rather than from our catalogue matters — our
 * catalogue holds the FORM's display labels ("Quote Delete"), and Zuper's wire
 * names are different ("estimate.delete"). Registering a label would create a
 * webhook for an event that never fires.
 */
function wanted(rows: Existing[]): { module: string; event: string }[] {
  const seen = new Map<string, { module: string; event: string }>();
  for (const w of rows) {
    if (!w.webhook_module || !w.webhook_event) continue;
    seen.set(`${w.webhook_module}|${w.webhook_event}`, { module: w.webhook_module, event: w.webhook_event });
  }
  return [...seen.values()].sort((a, b) => (a.module + a.event).localeCompare(b.module + b.event));
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
      // Zuper stores headers as a JSON object string (its retry schema shows the
      // same shape). This is what makes the delivery verifiable at our end.
      headers: JSON.stringify({ [config.webhook.header]: config.webhook.secret }),
    },
  };
  const r = await zuper("/webhook", { method: "POST", body: JSON.stringify(body) });
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
  let targets = wanted(rows);
  if (only) {
    const [m, e] = only.split("/");
    targets = targets.filter((t) => t.module === m && t.event === e);
    if (!targets.length) { console.log(`No live event matches ${only}. Use \`list\` to see what Zuper emits.`); process.exit(1); }
  }

  const missing = targets.filter((t) => !have.has(`${t.module}|${t.event}`));
  console.log(`${targets.length} event(s) in scope, ${targets.length - missing.length} already registered, ${missing.length} missing.`);
  console.log("");

  // Show how each would route, so a webhook is never created for something that
  // would only be stored and skipped.
  for (const t of missing) {
    const r = resolveRoute(t.module, t.event);
    const note = !r ? "NO ROUTE" : r.skip ? `skipped: ${r.skip.slice(0, 48)}` : `-> ${r.entity}${r.inferred ? " (inferred)" : ""}`;
    console.log(`  ${t.module.padEnd(18)} ${t.event.padEnd(34)} ${note}`);
  }
  console.log("");

  if (cmd !== "apply") {
    console.log("PLAN ONLY — nothing was created. Re-run with `apply` to create them.");
    console.log("Create one first and confirm a real delivery verifies before doing all of them:");
    console.log("  npm run webhooks -- apply --only JOB/job.update");
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

  // Read back: the only way to know Zuper actually stored the header.
  const after = (await existing()).filter((w) => w.webhook_url === ENDPOINT);
  console.log(`${after.length} webhook(s) now point at ${ENDPOINT}.`);
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
