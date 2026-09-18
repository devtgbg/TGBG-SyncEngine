/**
 * Records written into Tuper, and why — the other direction from "To Zuper".
 *
 * One row per record Zupersync wrote, whatever caused it: a Zuper webhook, a replay, the sweep catching what a webhook
 * missed, an admin re-sync. What the record is, what happened to it in Tuper, what it cost in API calls, and — when it
 * failed — why. Opening a row lists every call it took, each of which opens to what was sent and what came back.
 */

import Link from "next/link";
import {
  callById, callsForWrite, missingTable, writeById, writeEntities, writeStats, writesPage,
  type ApiCall, type ApiCallDetail, type TuperWrite, type WriteStats,
} from "@/lib/db";
import { dubaiTime } from "@/lib/describe";
import { CallBodies, CallLine, ORIGIN, after } from "../call-view";
import { Ago } from "../live";
import { DEFAULT_SIZE, SIZES } from "../pager";
import { EscapeTo, Row } from "../row";

export const dynamic = "force-dynamic";

const CAUSES = [
  { key: "", label: "Any cause" },
  { key: "webhook", label: "Zuper webhooks" },
  { key: "replay", label: "Replay" },
  { key: "sweep", label: "Sweep" },
  { key: "admin", label: "Admin" },
  { key: "other", label: "Other" },
] as const;

/** The kind of record, as a person would say it. */
const KIND: Record<string, string> = {
  jobs: "job", customers: "customer", organizations: "organization", users: "user", assets: "asset",
  products: "product", estimates: "quote", invoices: "invoice", contracts: "contract", requests: "request",
  notes: "notes", timesheets: "punches", timeoff_requests: "time off", timeoff_types: "time off types",
  job_statuses: "job statuses", job_categories: "job categories",
};
const kind = (e: string) => KIND[e] ?? e.replace(/_/g, " ");

const TONE: Record<string, "ok" | "warn" | "bad" | "muted"> = {
  created: "ok", updated: "ok", deleted: "warn", "re-synced": "ok", skipped: "muted", unchanged: "muted", failed: "bad",
};

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/** What the record is called, falling back to the work order number its webhook carried, then its Zuper uid. */
const name = (w: TuperWrite) =>
  w.label ?? (w.cause_wo ? `job ${w.cause_wo}` : w.zuper_uid ? `${kind(w.entity)} ${w.zuper_uid.slice(0, 8)}` : kind(w.entity));

type SP = { entity?: string; failed?: string; cause?: string; before?: string; size?: string; open?: string; call?: string };

export default async function ToTuper({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const failed = sp.failed === "1";
  const cause = CAUSES.some((c) => c.key === sp.cause) ? sp.cause ?? "" : "";
  const size = (SIZES as readonly number[]).includes(Number(sp.size)) ? Number(sp.size) : DEFAULT_SIZE;
  const before = sp.before && /^\d{1,19}$/.test(sp.before) ? sp.before : undefined;

  let rows: TuperWrite[] = [];
  let older = false;
  let stats: WriteStats | null = null;
  let entities: string[] = [];
  let opened: TuperWrite | null = null;
  let openedCalls: { rows: ApiCall[]; total: number } | null = null;
  let openedCall: ApiCallDetail | null = null;
  let notYet = false;
  let error: string | null = null;
  const entity = sp.entity && /^[a-z_]{1,40}$/.test(sp.entity) ? sp.entity : "";
  try {
    const [page, s, kinds, one] = await Promise.all([
      writesPage({ entity: entity || undefined, failed, origin: cause, before, limit: size }),
      writeStats(),
      writeEntities(),
      sp.open ? writeById(sp.open) : Promise.resolve(null),
    ]);
    rows = page.rows; older = page.older; stats = s; entities = kinds; opened = one;
    if (opened) {
      openedCalls = await callsForWrite(opened.write_id);
      if (sp.call) {
        const c = await callById(sp.call);
        openedCall = c && openedCalls.rows.some((r) => r.id === c.id) ? c : null;
      }
    }
  } catch (err) {
    if (missingTable(err)) notYet = true;
    else error = err instanceof Error ? err.message : String(err);
  }

  /** This view's URL with some of its settings changed. Changing a filter goes back to the newest page. */
  const url = (next: Partial<{ entity: string; failed: boolean; cause: string; before: string | null; size: number; open: string | null; call: string | null }>) => {
    const q = new URLSearchParams();
    const e = next.entity ?? entity, f = next.failed ?? failed, c = next.cause ?? cause, z = next.size ?? size;
    const filterChanged = next.entity !== undefined || next.failed !== undefined || next.cause !== undefined || next.size !== undefined;
    const b = filterChanged ? null : next.before === undefined ? before : next.before;
    if (e) q.set("entity", e);
    if (f) q.set("failed", "1");
    if (c) q.set("cause", c);
    if (b) q.set("before", b);
    if (z !== DEFAULT_SIZE) q.set("size", String(z));
    if (next.open) q.set("open", next.open);
    if (next.open && next.call) q.set("call", next.call);
    const qs = q.toString();
    return qs ? `/tuper?${qs}` : "/tuper";
  };

  const pager = (
    <nav className="pager" aria-label="Pages">
      <span className="range">{before ? "Older records" : "Newest records"} · {rows.length} shown</span>
      <span className="pages">
        {before ? <a href={url({ before: null })}>« Newest</a> : <span className="off">« Newest</span>}
        {older && rows.length ? <a href={url({ before: rows[rows.length - 1].id })} rel="next">Older ›</a> : <span className="off">Older ›</span>}
      </span>
      <span className="sizes">
        Rows
        {SIZES.map((s) => (s === size ? <b key={s}>{s}</b> : <a key={s} href={url({ size: s })}>{s}</a>))}
      </span>
    </nav>
  );

  return (
    <main>
      <header className="head">
        <h1>Changes going to Tuper</h1>
        <p>
          Every record Zupersync wrote into Tuper, one row each, whatever caused it: a Zuper webhook, a replay, the sweep
          catching what a webhook missed, an admin re-sync. Open a row for every API call it took.
        </p>
      </header>

      {error ? (
        <p className="error">Could not read the record of writes: {error}</p>
      ) : notYet ? (
        <p className="pinned">This record starts with the service version that keeps it, which is not deployed yet. Until then, <a href="/?source=zuper">Webhooks › From Zuper</a> shows each change and its outcome.</p>
      ) : (
        <>
          {stats ? (
            <section className="tiles">
              <Tile n={stats.created} label="created · 24h" tone={stats.created ? "ok" : undefined} />
              <Tile n={stats.updated} label="updated · 24h" />
              <Tile n={stats.deleted} label="deleted · 24h" />
              <Tile n={stats.failed} label="failed · 24h" tone={stats.failed ? "bad" : undefined} />
              <Tile n={stats.total} label="records · 24h" />
            </section>
          ) : null}

          <div className="filter-rows">
            <nav className="filters" aria-label="Kind">
              <a href={url({ entity: "" })} className={!entity ? "on" : ""}>Every kind</a>
              {entities.map((e) => <a key={e} href={url({ entity: e })} className={entity === e ? "on" : ""}>{kind(e)}</a>)}
              <a href={url({ failed: !failed })} className={failed ? "on" : ""}>Failed only</a>
            </nav>
            <nav className="filters" aria-label="Cause">
              {CAUSES.map((c) => <a key={c.key} href={url({ cause: c.key })} className={cause === c.key ? "on" : ""}>{c.label}</a>)}
            </nav>
          </div>

          {before ? <p className="pinned">Records before #{before}. Newer ones arrive on the <a href={url({ before: null })}>newest page</a> and do not shift this one.</p> : null}
          {pager}

          {rows.length === 0 ? (
            <p className="empty">{before ? "No older records." : `Nothing written to Tuper${entity || failed || cause ? " matching that filter" : " yet"}.`}</p>
          ) : (
            <div className="scroll">
              <table className="log">
                <colgroup>
                  <col style={{ width: "7%" }} /><col style={{ width: "20%" }} /><col style={{ width: "9%" }} />
                  <col style={{ width: "17%" }} /><col style={{ width: "9%" }} /><col style={{ width: "7%" }} />
                  <col style={{ width: "31%" }} />
                </colgroup>
                <thead>
                  <tr><th>When</th><th>Record</th><th>In Tuper</th><th>Caused by</th><th>API calls</th><th className="num">Took</th><th>Outcome</th></tr>
                </thead>
                <tbody>
                  {rows.map((w) => (
                    <Row key={w.id} href={url({ open: w.id })} label="Open this record's writing"
                      className={[Date.now() - new Date(w.at).getTime() < 15_000 ? "fresh" : "", opened?.id === w.id ? "opened" : ""].filter(Boolean).join(" ") || undefined}>
                      <td className="dim" title={w.at}><Ago iso={w.at} initial={ago(w.at)} /></td>
                      <td>
                        <span className="pair">
                          <span title={name(w)}>{name(w)}</span>
                          <span className="note">{kind(w.entity)}{w.detail ? ` · ${w.detail}` : ""}</span>
                        </span>
                      </td>
                      <td><span className={`pill ${TONE[w.action] ?? "muted"}`}>{w.action}</span></td>
                      <td><Cause w={w} /></td>
                      <td className="mono" title={`${w.zuper_calls} to Zuper, ${w.tuper_calls} to Tuper${w.failed_calls ? `, ${w.failed_calls} failed` : ""}`}>
                        <span className="tally">
                          {w.zuper_calls ? <span>Z {w.zuper_calls}</span> : null}
                          {w.tuper_calls ? <span>T {w.tuper_calls}</span> : null}
                          {w.failed_calls ? <span className="bad">{w.failed_calls} ✗</span> : null}
                        </span>
                      </td>
                      <td className="num dim">{(w.ms / 1000).toFixed(1)}s</td>
                      <td title={w.error ?? undefined}>
                        {w.ok ? <span className="dim">{w.tuper_id ? `Tuper id ${w.tuper_id.slice(0, 8)}` : "written"}</span>
                          : <span className="pill bad">{w.error ?? "failed"}</span>}
                      </td>
                    </Row>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {rows.length > 15 ? pager : null}
        </>
      )}

      {opened ? (
        <WriteDrawer w={opened} calls={openedCalls} call={openedCall} closeHref={url({})}
          callHref={(id) => url({ open: opened!.id, call: id ?? null })} />
      ) : null}
    </main>
  );
}

function Cause({ w }: { w: TuperWrite }) {
  const label = w.origin ? ORIGIN[w.origin] ?? w.origin : "other";
  if (!w.event_id) return <span className="dim">{label}</span>;
  return (
    <span className="pair">
      <span className="dim">{label}</span>
      <span className="note mono" title={w.cause_event ?? undefined}>{w.cause_event ?? "a delivery"}</span>
    </span>
  );
}

function WriteDrawer({ w, calls, call, closeHref, callHref }: {
  w: TuperWrite; calls: { rows: ApiCall[]; total: number } | null; call: ApiCallDetail | null; closeHref: string; callHref: (id?: string) => string;
}) {
  const label = w.origin ? ORIGIN[w.origin] ?? w.origin : "nothing the log names (startup, a command run by hand)";
  const zuper = calls?.rows.filter((c) => c.system === "zuper").length ?? 0;
  return (
    <>
      <Link className="backdrop" href={closeHref} scroll={false} aria-label="Close" tabIndex={-1} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Record written to Tuper">
        <EscapeTo href={closeHref} />
        <header className="drawer-head">
          <div>
            <p className="mono dim"><span className="src tuper">Tuper</span> {kind(w.entity)}</p>
            <h2>{name(w)}</h2>
            <p className="dim">{dubaiTime(w.at)} (Dubai) · took {(w.ms / 1000).toFixed(1)}s</p>
          </div>
          <Link className="close" href={closeHref} scroll={false}>Close</Link>
        </header>

        <section>
          <h3>What happened in Tuper</h3>
          <dl className="facts">
            <dt>Outcome</dt><dd><span className={`pill ${TONE[w.action] ?? "muted"}`}>{w.action}</span></dd>
            {w.error ? (<><dt>Error</dt><dd className="mono wrapany">{w.error}</dd></>) : null}
            {w.detail ? (<><dt>Detail</dt><dd>{w.detail}</dd></>) : null}
            {w.tuper_id ? (<><dt>Tuper id</dt><dd className="mono wrapany">{w.tuper_id}</dd></>) : null}
            {w.zuper_uid ? (<><dt>Zuper uid</dt><dd className="mono wrapany">{w.zuper_uid}</dd></>) : null}
            <dt>Caused by</dt>
            <dd>
              {label}
              {w.event_id ? <> · <a href={`/?open=${w.event_id}`}>{w.cause_event ?? "the delivery"}{w.cause_wo ? ` · job ${w.cause_wo}` : ""}</a></> : null}
            </dd>
          </dl>
        </section>

        <section>
          <h3>API calls</h3>
          {!calls || !calls.rows.length ? (
            <p className="dim">No calls are recorded for this write.</p>
          ) : (
            <>
              <p className="note calls-summary">
                {calls.total.toLocaleString()} call{calls.total === 1 ? "" : "s"}: {zuper} to Zuper, {calls.rows.length - zuper} to Tuper
                {w.failed_calls ? `, ${w.failed_calls} failed` : ""}{calls.total > calls.rows.length ? ` (the first ${calls.rows.length} are listed)` : ""}.
              </p>
              <div className="call-list">
                {calls.rows.map((c) => {
                  const open = call?.id === c.id;
                  return (
                    <div key={c.id}>
                      <CallLine c={c} open={open} lead={after(w.at, c.at)} href={open ? callHref() : callHref(c.id)} />
                      {open && call ? <CallBodies c={call} /> : null}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>
      </aside>
    </>
  );
}

function Tile({ n, label, tone }: { n: number; label: string; tone?: "ok" | "warn" | "bad" }) {
  return (
    <div className={`tile ${tone ?? ""}`}>
      <strong>{n.toLocaleString()}</strong>
      <span>{label}</span>
    </div>
  );
}
