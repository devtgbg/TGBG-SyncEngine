/**
 * What connects Zuper and Tuper through this engine: the webhooks registered on each side, and which API calls on one
 * side lead to which on the other.
 *
 * Registrations and traffic are measured by the engine (it holds the API keys; this dashboard does not) and left in
 * its store every 30 minutes or when asked; deliveries are counted here from the webhook log. So every "registered"
 * is what Zuper or Tuper answered when asked, and every link between two calls is one that actually happened.
 */

import Link from "next/link";
import {
  connectionSummary, engine, eventStats, getSettings, latestBy, recentCommands, snapshot,
  type Catalogue, type EventStat, type Registrations, type Traffic,
} from "@/lib/control";
import { dubaiTime } from "@/lib/describe";
import { PUSH_MODE } from "@/lib/engine";
import { CommandButton } from "../controls";

export const dynamic = "force-dynamic";

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/** A record type as a person would say it. */
const KIND: Record<string, string> = {
  jobs: "Jobs", job_details: "Job details", job_activity: "Job activity", customers: "Customers", organizations: "Organizations",
  users: "Users", assets: "Assets", products: "Parts & services", estimates: "Quotes", invoices: "Invoices", contracts: "Contracts",
  requests: "Requests", notes: "Notes", timesheets: "Punches", timeoff_requests: "Time off", properties: "Properties",
  projects: "Projects", purchase_orders: "Purchase orders", teams: "Teams", product_transactions: "Stock movements",
  timesheet_locations: "Timesheet locations", timesheet_approvals: "Timesheet approvals", timeoff_availability: "Time-off balances",
};
const kind = (e: string) => KIND[e] ?? e.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export default async function Connections() {
  const [catS, regS, trafS, stats, row, eng, cmds] = await Promise.all([
    snapshot<Catalogue>("catalogue"), snapshot<Registrations>("registrations"), snapshot<Traffic>("traffic"),
    eventStats(), getSettings().catch(() => null), engine(), recentCommands(20),
  ]);
  const cat = catS?.data ?? null, regs = regS?.data ?? null, traffic = trafS?.data ?? null;
  const latest = latestBy(cmds);
  const conn = connectionSummary(cat, regs);
  const settings = eng?.applied ?? row?.data ?? null;
  const stat = (source: "zuper" | "tuper", event: string): EventStat | undefined => stats.find((x) => x.source === source && x.event === event);

  if (!cat) {
    return (
      <main>
        <header className="head"><h1>Connections</h1></header>
        <p className="pinned">The engine has not measured its connections yet. It does within a minute of starting with this version, then every 30 minutes.</p>
        <CommandButton command="refresh-connections" label="Check now" latest={latest["refresh-connections"]} />
      </main>
    );
  }

  const zHooks = regs && !("error" in regs.zuper) ? regs.zuper.ours : [];
  const zKey = new Set(zHooks.map((h) => `${h.module}|${h.event}`));
  const modules = [...new Set(cat.zuperEvents.map((e) => e.module))];
  const tHooks = regs && !("error" in regs.tuper) ? regs.tuper.ours : [];

  // Kinds of record: those Zuper's events write, with the calls their writes were seen making in the last 24 hours.
  const byEntity = new Map<string, { events: string[]; read: Set<string> }>();
  for (const e of cat.zuperEvents) {
    if (!e.entity) continue;
    const x = byEntity.get(e.entity) ?? { events: [], read: new Set<string>() };
    x.events.push(e.event);
    if (e.read) x.read.add(e.read);
    byEntity.set(e.entity, x);
  }
  const written = new Map((traffic?.writes ?? []).map((w) => [w.entity, w]));
  const entityOrder = [...new Set([...(traffic?.writes ?? []).map((w) => w.entity), ...byEntity.keys()])];
  const table = (name: string) => cat.entities.find((e) => e.name === name)?.table ?? null;
  // Kinds written in the last day get a card each; the rest, one line each in a table folded away, so the map stays
  // readable with fifty kinds of record.
  const active = entityOrder.filter((e) => written.has(e));
  const quiet = entityOrder.filter((e) => !written.has(e));

  return (
    <main>
      <header className="head">
        <h1>Connections</h1>
        <p>The webhooks each system sends here, and the API calls that carry a change from one to the other.</p>
      </header>

      <div className="connect-bar">
        <span className="note">Registrations checked {regS ? `${dubaiTime(regS.taken_at)} (${ago(regS.taken_at)})` : "never"}; traffic over the 24 hours before {trafS ? dubaiTime(trafS.taken_at) : "—"}.</span>
        <CommandButton command="refresh-connections" label="Check now" latest={latest["refresh-connections"]} />
      </div>

      <section className="tiles">
        <div className={`tile ${conn.zuper?.missing.length ? "warn" : "ok"}`}>
          <strong>{conn.zuper ? `${conn.zuper.registered} / ${conn.zuper.wanted}` : "—"}</strong><span>Zuper webhooks registered</span>
        </div>
        <div className={`tile ${conn.tuper?.wrongModule.length || conn.tuper?.missing.length ? "warn" : "ok"}`}>
          <strong>{conn.tuper ? `${conn.tuper.registered - conn.tuper.wrongModule.length} / ${conn.tuper.wanted}` : "—"}</strong><span>Tuper webhooks working</span>
        </div>
        <div className="tile"><strong>{(traffic?.endpoints ?? []).filter((e) => e.system === "zuper").length}</strong><span>Zuper endpoints used · 24h</span></div>
        <div className="tile"><strong>{new Set((traffic?.links ?? []).filter((l) => l.system === "tuper").map((l) => l.call.split(" ").pop())).size}</strong><span>Tuper tables written · 24h</span></div>
      </section>

      {/* ── Zuper's webhooks ── */}
      <section className="card">
        <header className="card-head">
          <h2><span className="src zuper">Zuper</span> webhooks → Zupersync</h2>
          <p className="note">Zuper sends each event to <span className="mono">{cat.zuperEndpoint}</span> with the shared secret header. {conn.zuper?.error ? `Zuper's list could not be read: ${conn.zuper.error}` : `${conn.zuper?.registered} of the ${conn.zuper?.wanted} events the engine acts on are registered${conn.zuper?.skippedButRegistered ? `; ${conn.zuper.skippedButRegistered} more are registered for events it stores and skips` : ""}.`}</p>
        </header>
        {conn.zuper?.missing.length ? (
          <div className="callout warn">
            <p><strong>{conn.zuper.missing.length} events have no webhook in Zuper,</strong> so they never arrive: {[...new Set(conn.zuper.missing.map((m) => m.module))].map((m) => `${m} ${conn.zuper!.missing.filter((x) => x.module === m).length}`).join(", ")}. Registering creates one webhook in Zuper per event, pointing here with the secret header; nothing else in Zuper changes.</p>
            <CommandButton command="register-zuper-webhooks" label={`Register ${conn.zuper.missing.length} in Zuper`} tone="primary" latest={latest["register-zuper-webhooks"]}
              confirm={`Create ${conn.zuper.missing.length} webhook(s) in Zuper, one per event, each pointing at ${cat.zuperEndpoint}? Zuper then sends those events here as they happen.`} />
          </div>
        ) : null}
        <div className="modules">
          {modules.map((m) => {
            const evs = cat.zuperEvents.filter((e) => e.module === m);
            const acted = evs.filter((e) => e.entity);
            const reg = acted.filter((e) => zKey.has(`${m}|${e.event}`)).length;
            const n7 = evs.reduce((n, e) => n + (stat("zuper", e.event)?.n ?? 0), 0);
            const f7 = evs.reduce((n, e) => n + (stat("zuper", e.event)?.failed ?? 0), 0);
            return (
              <details key={m} open={reg < acted.length} className="module">
                <summary>
                  <strong>{m}</strong>
                  <span className={`pill ${reg === acted.length ? "ok" : "warn"}`}>{reg}/{acted.length} registered</span>
                  <span className="dim">{evs.length - acted.length ? `${evs.length - acted.length} skipped by design · ` : ""}{n7.toLocaleString()} received in 7 days{f7 ? ` · ${f7} failed` : ""}</span>
                </summary>
                <table className="conn">
                  <thead><tr><th>Event</th><th>Webhook</th><th>Writes to Tuper</th><th>Reads from Zuper</th><th className="num">7 days</th><th>Last</th></tr></thead>
                  <tbody>
                    {evs.map((e) => {
                      const st = stat("zuper", e.event);
                      const registered = zKey.has(`${m}|${e.event}`);
                      return (
                        <tr key={e.event} className={e.entity ? "" : "skipped"}>
                          <td className="mono">{e.event}</td>
                          <td>{e.entity ? (registered ? <span className="pill ok">registered</span> : <span className="pill warn">missing</span>) : <span className="pill muted" title={e.skip ?? undefined}>{registered ? "registered · skipped" : "skipped"}</span>}</td>
                          <td>{e.entity ? <>{kind(e.entity)}{e.then.length ? <span className="note"> + {e.then.map(kind).join(", ")}</span> : null}</> : <span className="note">{e.skip}</span>}</td>
                          <td className="mono dim">{e.read ?? "—"}</td>
                          <td className="num">{st ? <>{st.n}{st.failed ? <span className="bad-text"> · {st.failed}✗</span> : null}</> : <span className="dim">0</span>}</td>
                          <td className="dim">{ago(st?.last ?? null)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </details>
            );
          })}
        </div>
      </section>

      {/* ── Tuper's webhooks ── */}
      <section className="card">
        <header className="card-head">
          <h2><span className="src tuper">Tuper</span> webhooks → Zupersync</h2>
          <p className="note">Tuper sends each change to <span className="mono">{cat.tuperEndpoint}</span>, signed with its secret. Tuper builds the body from the webhook&apos;s module, so the module has to be the one Tuper&apos;s catalogue names, or the body carries no record id.
            {tHooks.length > cat.tuperEvents.length ? <> Tuper has <strong>{tHooks.length}</strong> webhooks pointed here; the {cat.tuperEvents.length} below are the ones this engine acts on — the rest are recorded and skipped.</> : null}</p>
        </header>
        {conn.tuper?.error ? <p className="error">Tuper&apos;s webhook list could not be read: {conn.tuper.error}</p> : null}
        {conn.tuper?.wrongModule.length ? (
          <div className="callout warn">
            <p><strong>{conn.tuper.wrongModule.length} of {conn.tuper.wanted} are registered under the wrong module</strong> ({[...new Set(conn.tuper.wrongModule.map((w) => `${w.registeredAs} → ${w.needs}`))].join(", ")}). Their deliveries arrive without the record&apos;s id, so nothing can be queued from them. Fix it in Tuper: edit each webhook&apos;s module.</p>
          </div>
        ) : null}
        <table className="conn">
          <thead><tr><th>Event</th><th>Registered as</th><th>Needs</th><th>Active</th><th>Queues for Zuper</th><th className="num">7 days</th><th className="num">Carried id</th><th>Last</th></tr></thead>
          <tbody>
            {cat.tuperEvents.map((e) => {
              const h = tHooks.find((x) => x.event === e.event);
              const st = stat("tuper", e.event);
              const ok = h && h.module === e.module;
              return (
                <tr key={e.event}>
                  <td className="mono">{e.event}</td>
                  <td>{h ? <span className={`pill ${ok ? "ok" : "bad"}`}>{h.module}</span> : <span className="pill warn">not registered</span>}</td>
                  <td className="mono dim">{e.module}</td>
                  <td>{h ? (h.active ? "yes" : <span className="warn-text">no</span>) : "—"}{h?.signed === false ? <span className="warn-text"> · unsigned</span> : null}</td>
                  <td>{kind(e.entity)} <span className="note">{e.operation}</span></td>
                  <td className="num">{st?.n ?? 0}</td>
                  <td className={`num ${st && st.carried_id < st.n ? "warn-text" : ""}`}>{st ? `${st.carried_id}/${st.n}` : "—"}</td>
                  <td className="dim">{ago(st?.last ?? null)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* ── The API map ── */}
      <section className="card">
        <header className="card-head">
          <h2>API map · <span className="src zuper">Zuper</span> → <span className="src tuper">Tuper</span></h2>
          <p className="note">For each kind of record: the Zuper events that trigger it, the Zuper API calls its writes made and the Tuper tables they wrote, as seen over the last 24 hours. A kind with no traffic shows the read its events are routed to.</p>
        </header>
        <div className="api-map">
          {active.length ? null : <p className="dim">Nothing was written to Tuper in the 24 hours measured.</p>}
          {active.map((ent) => {
            const x = byEntity.get(ent);
            const w = written.get(ent);
            const zCalls = (traffic?.links ?? []).filter((l) => l.entity === ent && l.system === "zuper");
            const tCalls = (traffic?.links ?? []).filter((l) => l.entity === ent && l.system === "tuper");
            return (
              <article key={ent} className="map-row">
                <header>
                  <strong>{kind(ent)}</strong>
                  <span className="mono dim">{table(ent) ?? ""}</span>
                  {w ? <span className="note">{w.writes.toLocaleString()} written · 24h{w.failed ? <span className="bad-text"> · {w.failed} failed</span> : null} · median {(w.median_ms / 1000).toFixed(1)}s</span> : <span className="note">no writes in 24h</span>}
                </header>
                <div className="map-cols">
                  <div>
                    <h4>Triggered by</h4>
                    {x ? <p className="mono small">{x.events.slice(0, 6).join(", ")}{x.events.length > 6 ? ` +${x.events.length - 6}` : ""}</p> : <p className="note">the sweep, replays and re-syncs</p>}
                  </div>
                  <div>
                    <h4><span className="src zuper">Zuper</span> reads</h4>
                    {zCalls.length ? <ul className="calls-list">{zCalls.slice(0, 6).map((c) => <li key={c.call}><span className="mono">{c.call}</span> <span className="dim">{c.calls.toLocaleString()}{c.failed ? <span className="bad-text"> · {c.failed}✗</span> : null}</span></li>)}</ul>
                      : <p className="mono small dim">{x ? [...x.read].join(", ") || "—" : "—"}</p>}
                  </div>
                  <div>
                    <h4><span className="src tuper">Tuper</span> writes</h4>
                    {tCalls.length ? <ul className="calls-list">{tCalls.slice(0, 8).map((c) => <li key={c.call}><span className="mono">{c.call}</span> <span className="dim">{c.calls.toLocaleString()}{c.failed ? <span className="bad-text"> · {c.failed}✗</span> : null}</span></li>)}{tCalls.length > 8 ? <li className="dim">+{tCalls.length - 8} more</li> : null}</ul>
                      : <p className="mono small dim">{table(ent) ? `POST /api/sync/mutate · ${table(ent)}` : "—"}</p>}
                  </div>
                </div>
              </article>
            );
          })}
          {quiet.length ? (
            <details className="module">
              <summary><strong>{quiet.length} more kinds of record</strong><span className="dim">no writes in the 24 hours measured — what their events are routed to</span></summary>
              <table className="conn">
                <thead><tr><th>Record</th><th>Tuper table</th><th>Triggered by</th><th>Reads from Zuper</th></tr></thead>
                <tbody>
                  {quiet.map((ent) => {
                    const x = byEntity.get(ent);
                    return (
                      <tr key={ent}>
                        <td><strong>{kind(ent)}</strong></td>
                        <td className="mono dim">{table(ent) ?? "—"}</td>
                        <td className="mono small">{x ? `${x.events.slice(0, 3).join(", ")}${x.events.length > 3 ? ` +${x.events.length - 3}` : ""}` : "the sweep and re-syncs"}</td>
                        <td className="mono small dim">{x ? [...x.read].join(", ") || "—" : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </details>
          ) : null}
        </div>
      </section>

      <section className="card">
        <header className="card-head">
          <h2>API map · <span className="src tuper">Tuper</span> → <span className="src zuper">Zuper</span></h2>
          <p className="note">What a change made in Tuper becomes in Zuper when pushing is live. Now: <strong>{settings ? PUSH_MODE[settings.push.mode] : "—"}</strong>{settings?.push.mode === "live" ? ` for ${settings.push.entities.join(", ")}` : ""}. <Link href="/settings">Change</Link></p>
        </header>
        <div className="api-map">
          {Object.entries(cat.pushWrites).map(([ent, writes]) => {
            const live = settings?.push.mode === "live" && settings.push.entities.includes(ent);
            return (
              <article key={ent} className="map-row">
                <header>
                  <strong>{kind(ent)}</strong>
                  <span className={`pill ${live ? "ok" : settings?.push.mode === "off" ? "muted" : "warn"}`}>{live ? "sent live" : settings?.push.mode === "off" ? "off" : "planned only"}</span>
                </header>
                <div className="map-cols">
                  <div><h4><span className="src tuper">Tuper</span> events</h4><p className="mono small">{cat.tuperEvents.filter((e) => e.entity === ent).map((e) => e.event).join(", ")}</p></div>
                  <div className="span-2">
                    <h4><span className="src zuper">Zuper</span> writes</h4>
                    <ul className="calls-list">{writes.map((w) => <li key={w.request}><span className="mono">{w.request}</span> <span className="note">{w.when}</span></li>)}</ul>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="card">
        <header className="card-head">
          <h2>Endpoint health</h2>
          <p className="note">The engine&apos;s own calls over the 24 hours to {trafS ? dubaiTime(trafS.taken_at) : "—"} (command-line imports left out). <Link href="/calls">Every call</Link></p>
        </header>
        <div className="grid-2">
          {(["zuper", "tuper"] as const).map((sys) => (
            <table key={sys} className="conn">
              <thead><tr><th><span className={`src ${sys}`}>{sys === "zuper" ? "Zuper" : "Tuper"}</span> endpoint</th><th className="num">Calls</th><th className="num">Failed</th><th className="num">Median</th></tr></thead>
              <tbody>
                {(traffic?.endpoints ?? []).filter((e) => e.system === sys).map((e) => (
                  <tr key={e.endpoint}>
                    <td className="mono small">{e.endpoint}</td>
                    <td className="num">{e.calls.toLocaleString()}</td>
                    <td className={`num ${e.failed ? "bad-text" : "dim"}`}>{e.failed}</td>
                    <td className="num dim">{e.median_ms} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </div>
      </section>
    </main>
  );
}
