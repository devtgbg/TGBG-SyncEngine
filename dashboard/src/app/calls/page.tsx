/**
 * Every call Zupersync makes to Zuper's API and to Tuper's, newest first, as it happens.
 *
 * The webhook log says what arrived; this says what the service did with the two APIs: which records it read from
 * Zuper, which rows it wrote through Tuper, what each answered and how long it took, and what caused it. Opening a row
 * shows what was sent and what came back.
 */

import Link from "next/link";
import { callById, callStats, callsPage, missingTable, type ApiCall, type ApiCallDetail, type CallStats } from "@/lib/db";
import { dubaiTime } from "@/lib/describe";
import { CallBodies, ORIGIN, SYSTEM, statusText, what } from "../call-view";
import { Ago } from "../live";
import { SIZES, DEFAULT_SIZE } from "../pager";
import { EscapeTo, Row } from "../row";

export const dynamic = "force-dynamic";

const SYSTEMS = [
  { key: "", label: "Both" },
  { key: "zuper", label: "Zuper" },
  { key: "tuper", label: "Tuper" },
] as const;

const CAUSES = [
  { key: "", label: "Any cause" },
  { key: "webhook", label: "Zuper webhooks" },
  { key: "tuper-webhook", label: "Tuper webhooks" },
  { key: "replay", label: "Replay" },
  { key: "sweep", label: "Sweep" },
  { key: "push", label: "Push" },
  { key: "admin", label: "Admin" },
  { key: "other", label: "Other" },
] as const;

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

type SP = { system?: string; failed?: string; cause?: string; before?: string; size?: string; open?: string };

export default async function Calls({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const system = sp.system === "zuper" || sp.system === "tuper" ? sp.system : "";
  const failed = sp.failed === "1";
  const cause = CAUSES.some((c) => c.key === sp.cause) ? sp.cause ?? "" : "";
  const size = (SIZES as readonly number[]).includes(Number(sp.size)) ? Number(sp.size) : DEFAULT_SIZE;
  const before = sp.before && /^\d{1,19}$/.test(sp.before) ? sp.before : undefined;

  let rows: ApiCall[] = [];
  let older = false;
  let stats: CallStats | null = null;
  let opened: ApiCallDetail | null = null;
  let notYet = false;
  let error: string | null = null;
  try {
    const [page, s, one] = await Promise.all([
      callsPage({ system, failed, origin: cause, before, limit: size }),
      callStats(),
      sp.open ? callById(sp.open) : Promise.resolve(null),
    ]);
    rows = page.rows; older = page.older; stats = s; opened = one;
  } catch (err) {
    if (missingTable(err)) notYet = true;
    else error = err instanceof Error ? err.message : String(err);
  }

  /** This view's URL with some of its settings changed. Changing a filter goes back to the newest page. */
  const url = (next: Partial<{ system: string; failed: boolean; cause: string; before: string | null; size: number; open: string | null }>) => {
    const q = new URLSearchParams();
    const s = next.system ?? system, f = next.failed ?? failed, c = next.cause ?? cause;
    const filterChanged = next.system !== undefined || next.failed !== undefined || next.cause !== undefined || next.size !== undefined;
    const b = filterChanged ? null : next.before === undefined ? before : next.before;
    const z = next.size ?? size;
    const o = next.open === undefined ? null : next.open;
    if (s) q.set("system", s);
    if (f) q.set("failed", "1");
    if (c) q.set("cause", c);
    if (b) q.set("before", b);
    if (z !== DEFAULT_SIZE) q.set("size", String(z));
    if (o) q.set("open", o);
    const qs = q.toString();
    return qs ? `/calls?${qs}` : "/calls";
  };

  const pager = (
    <nav className="pager" aria-label="Pages">
      <span className="range">{before ? "Older calls" : "Newest calls"} · {rows.length} shown</span>
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
        <h1>API calls</h1>
        <p>
          Every request Zupersync makes to Zuper&apos;s API and to Tuper&apos;s, newest first, with what caused it. Open one to see
          what was sent and what came back. Bodies are kept for 48 hours, the calls for a week.
        </p>
      </header>

      {error ? (
        <p className="error">Could not read the call log: {error}</p>
      ) : notYet ? (
        <p className="pinned">The call log starts with the service version that records it, which is not deployed yet. The webhooks are on the <a href="/webhooks">Webhooks</a> page.</p>
      ) : (
        <>
          {stats ? (
            <section className="tiles">
              <Tile n={stats.zuper} label="to Zuper · last hour" />
              <Tile n={stats.tuper} label="to Tuper · last hour" />
              <Tile n={stats.failed} label="failed · last hour" tone={stats.failed ? "bad" : undefined} />
              <Tile n={stats.zuper_ms} label="Zuper · median ms" />
              <Tile n={stats.tuper_ms} label="Tuper · median ms" />
            </section>
          ) : null}

          <div className="filter-rows">
            <nav className="filters" aria-label="System">
              {SYSTEMS.map((s) => <a key={s.key} href={url({ system: s.key })} className={system === s.key ? "on" : ""}>{s.label}</a>)}
              <a href={url({ failed: !failed })} className={failed ? "on" : ""}>Failed only</a>
            </nav>
            <nav className="filters" aria-label="Cause">
              {CAUSES.map((c) => <a key={c.key} href={url({ cause: c.key })} className={cause === c.key ? "on" : ""}>{c.label}</a>)}
            </nav>
          </div>

          {before ? <p className="pinned">Calls before #{before}. Newer ones arrive on the <a href={url({ before: null })}>newest page</a> and do not shift this one.</p> : null}
          {pager}

          {rows.length === 0 ? (
            <p className="empty">{before ? "No older calls." : `No calls${system || failed || cause ? " matching that filter" : " yet"}.`}</p>
          ) : (
            <div className="scroll">
              <table className="log">
                <colgroup>
                  <col style={{ width: "7%" }} /><col style={{ width: "6.5%" }} /><col style={{ width: "39%" }} />
                  <col style={{ width: "8.5%" }} /><col style={{ width: "7%" }} /><col style={{ width: "9%" }} />
                  <col style={{ width: "23%" }} />
                </colgroup>
                <thead>
                  <tr><th>When</th><th>API</th><th>Call</th><th>Answer</th><th className="num">Time</th><th className="num">Size</th><th>Caused by</th></tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <Row key={c.id} href={url({ open: c.id })} label="Open this call"
                      className={[Date.now() - new Date(c.at).getTime() < 15_000 ? "fresh" : "", opened?.id === c.id ? "opened" : ""].filter(Boolean).join(" ") || undefined}>
                      <td className="dim" title={c.at}><Ago iso={c.at} initial={ago(c.at)} /></td>
                      <td><span className={`src ${c.system}`}>{SYSTEM[c.system]}</span></td>
                      <td className="mono" title={`${c.method} ${c.path}${c.error ? `\n${c.error}` : ""}`}>
                        {what(c)}{c.attempt > 1 ? <span className="dim"> · try {c.attempt}</span> : null}
                      </td>
                      <td><span className={`pill ${c.ok ? "ok" : "bad"}`} title={c.error ?? undefined}>{statusText(c)}</span></td>
                      <td className="num dim">{c.ms.toLocaleString()} ms</td>
                      <td className="num dim">{size_(c)}</td>
                      <td><Cause c={c} /></td>
                    </Row>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {rows.length > 15 ? pager : null}
        </>
      )}

      {opened ? <CallDrawer c={opened} closeHref={url({})} /> : null}
    </main>
  );
}

/** How much came back: that is what varies, from a few bytes for a write to a page of a hundred records. */
const size_ = (c: ApiCall) => {
  const n = c.response_bytes;
  return n === null ? "—" : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10_240 ? 1 : 0)} kB`;
};

function Cause({ c }: { c: ApiCall }) {
  const label = c.origin ? ORIGIN[c.origin] ?? c.origin : "other";
  if (!c.event_id) return <span className="dim">{label}</span>;
  const record = c.cause_wo ? ` · ${c.cause_wo}` : "";
  return (
    <span className="pair">
      <span className="dim">{label}</span>
      <span className="note mono" title={c.cause_event ?? undefined}>{c.cause_event ?? "a delivery"}{record}</span>
    </span>
  );
}

function CallDrawer({ c, closeHref }: { c: ApiCallDetail; closeHref: string }) {
  const label = c.origin ? ORIGIN[c.origin] ?? c.origin : "nothing the log names (startup, a command run by hand)";
  return (
    <>
      <Link className="backdrop" href={closeHref} scroll={false} aria-label="Close the call" tabIndex={-1} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="API call detail">
        <EscapeTo href={closeHref} />
        <header className="drawer-head">
          <div>
            <p className="mono dim"><span className={`src ${c.system}`}>{SYSTEM[c.system]}</span> call #{c.id}</p>
            <h2 className="mono">{what(c)}</h2>
            <p className="dim">{dubaiTime(c.at)} (Dubai)</p>
          </div>
          <Link className="close" href={closeHref} scroll={false}>Close</Link>
        </header>
        <section>
          <h3>Caused by</h3>
          <dl className="facts">
            <dt>Cause</dt><dd>{label}</dd>
            {c.event_id ? (
              <>
                <dt>Delivery</dt>
                <dd><a href={`/webhooks?open=${c.event_id}&call=${c.id}`}>{c.cause_source === "tuper" ? "Tuper" : "Zuper"} {c.cause_event ?? "webhook"}{c.cause_wo ? ` · job ${c.cause_wo}` : ""}</a></dd>
              </>
            ) : null}
          </dl>
        </section>
        <section>
          <h3>The call</h3>
          <CallBodies c={c} />
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
