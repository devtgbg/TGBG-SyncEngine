/**
 * The webhook log: what Zuper and Tuper sent, and what Zupersync did about it.
 *
 * Every row answers the question someone has when a record looks wrong on one side: did the other side tell us, did
 * we accept it, did we act on it, and if not, why not. The Calls column says how many API calls acting on it took;
 * opening the row lists them.
 */

import {
  callById, callCounts, callsFor, deliveriesPage, deliveryById, missingTable, sourceCounts, totals, userNames,
  type ApiCall, type ApiCallDetail, type CallCount, type Delivery, type DeliveryDetail, type Source,
} from "@/lib/db";
import { userUidsIn } from "@/lib/describe";
import { outcome } from "@/lib/outcome";
import { Detail } from "./detail";
import { Ago } from "./live";
import { DEFAULT_SIZE, Pager, Pinned, readPaging } from "./pager";
import { Row } from "./row";

export const dynamic = "force-dynamic";

const FILTERS = [
  { key: "", label: "All" },
  { key: "failed", label: "Failed" },
  { key: "skipped", label: "Not synced" },
  { key: "unprocessed", label: "Waiting" },
  { key: "refused", label: "Refused" },
] as const;

const SOURCES = [
  { key: "", label: "Both" },
  { key: "zuper", label: "From Zuper" },
  { key: "tuper", label: "From Tuper" },
] as const;

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/** Arrived in the last few seconds — highlighted once, so a row appearing live catches the eye. */
const isFresh = (iso: string) => Date.now() - new Date(iso).getTime() < 15_000;

type SP = { filter?: string; source?: string; page?: string; size?: string; upto?: string; open?: string; call?: string };

export default async function Page({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const filter = sp.filter ?? "";
  const source = sp.source === "zuper" || sp.source === "tuper" ? sp.source : "";
  const paging = readPaging(sp);

  let rows: Delivery[] = [];
  let matching = 0;
  let counts = { total: 0, refused: 0, processed: 0, skipped: 0, failed: 0, waiting: 0 };
  let bySource: Record<Source, number> = { zuper: 0, tuper: 0 };
  let calls: Record<string, CallCount> = {};
  let opened: DeliveryDetail | null = null;
  let openedCalls: { rows: ApiCall[]; total: number } | null = null;
  let openedCall: ApiCallDetail | null = null;
  let names: Record<string, string> = {};
  let error: string | null = null;
  try {
    const [list, all, src, one] = await Promise.all([
      deliveriesPage({ limit: paging.size, offset: paging.offset, upto: paging.upto, filter, source }),
      totals(source),
      sourceCounts(),
      sp.open ? deliveryById(sp.open) : Promise.resolve(null),
    ]);
    rows = list.rows; matching = list.total; counts = all; bySource = src; opened = one;
    calls = await callCounts(rows.map((r) => r.id));
    if (opened) {
      // An assignment names people by uid only; a name that cannot be found is no reason to fail the page.
      names = await userNames(userUidsIn(opened.body)).catch(() => ({}));
      try {
        openedCalls = await callsFor(opened.id);
        if (sp.call) {
          const c = await callById(sp.call);
          openedCall = c && c.event_id === opened.id ? c : null;
        }
      } catch (err) {
        if (!missingTable(err)) throw err;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  /** This view's own URL: same filters, page size, page and pin, with or without a delivery (and one of its calls) open. */
  const here = (open?: string, call?: string) => {
    const q = new URLSearchParams();
    if (source) q.set("source", source);
    if (filter) q.set("filter", filter);
    if (paging.size !== DEFAULT_SIZE) q.set("size", String(paging.size));
    if (paging.page > 1) q.set("page", String(paging.page));
    if (paging.upto) q.set("upto", paging.upto);
    if (open) q.set("open", open);
    if (open && call) q.set("call", call);
    const qs = q.toString();
    return qs ? `/?${qs}` : "/";
  };
  const link = (next: { source?: string; filter?: string }) => {
    const q = new URLSearchParams();
    const s = next.source ?? source, f = next.filter ?? filter;
    if (s) q.set("source", s);
    if (f) q.set("filter", f);
    const qs = q.toString();
    return qs ? `/?${qs}` : "/";
  };

  // Older pages are pinned to the newest row on show here; an older page keeps the pin it came with.
  const pager = (
    <Pager base="/" keep={{ source, filter }} paging={paging} total={matching} shown={rows.length}
      anchor={paging.upto ?? (paging.page === 1 ? rows[0]?.received_at : undefined)} />
  );

  return (
    <main>
      <header className="head">
        <h1>Webhooks</h1>
        <p>
          Every webhook Zuper and Tuper have sent, and what became of it. A change in Zuper is re-read from Zuper&apos;s API
          and written through Tuper&apos;s; a change in Tuper is queued for Zuper. Open a row to see the API calls it took.
        </p>
      </header>

      {error ? (
        <p className="error">Could not read the log: {error}</p>
      ) : (
        <>
          <section className="tiles">
            <Tile n={counts.total} label="received" />
            <Tile n={counts.processed} label="applied" tone="ok" />
            <Tile n={counts.skipped} label="not synced" />
            <Tile n={counts.waiting} label="waiting" tone={counts.waiting ? "warn" : undefined} />
            <Tile n={counts.failed} label="failed" tone={counts.failed ? "bad" : undefined} />
            <Tile n={counts.refused} label="refused" tone={counts.refused ? "bad" : undefined} />
          </section>

          <div className="filter-rows">
            <nav className="filters" aria-label="Source">
              {SOURCES.map((s) => (
                <a key={s.key} href={link({ source: s.key })} className={source === s.key ? "on" : ""}>
                  {s.label}{s.key ? <span className="count">{bySource[s.key as Source].toLocaleString()}</span> : null}
                </a>
              ))}
            </nav>
            <nav className="filters" aria-label="Outcome">
              {FILTERS.map((f) => (
                <a key={f.key} href={link({ filter: f.key })} className={filter === f.key ? "on" : ""}>{f.label}</a>
              ))}
            </nav>
          </div>

          <Pinned upto={paging.upto} base="/" keep={{ source, filter }} size={paging.size} />
          {pager}

          {rows.length === 0 ? (
            <p className="empty">{paging.page > 1 ? "No rows on this page." : `No deliveries${filter || source ? " matching that filter" : " yet"}.`}</p>
          ) : (
            <div className="scroll">
              <table className="log">
                {/* Fixed shares, so the table is always exactly as wide as its box: a long
                    value is cut with an ellipsis (full text on hover), never a scrollbar. */}
                <colgroup>
                  <col style={{ width: "6.5%" }} /><col style={{ width: "7%" }} /><col style={{ width: "13%" }} />
                  <col style={{ width: "6.5%" }} /><col style={{ width: "15%" }} /><col style={{ width: "11%" }} />
                  <col style={{ width: "13%" }} /><col style={{ width: "8%" }} /><col style={{ width: "15.5%" }} />
                  <col style={{ width: "4.5%" }} />
                </colgroup>
                <thead>
                  <tr><th>When</th><th>From</th><th>Event</th><th>Record</th><th>By</th><th>Role</th><th>Staff ID</th><th>API calls</th><th>Outcome</th><th className="num">Tries</th></tr>
                </thead>
                <tbody>
                  {rows.map((d) => {
                    const o = outcome(d);
                    const c = calls[d.id];
                    return (
                      <Row key={d.id} href={here(d.id)}
                        className={[isFresh(d.received_at) ? "fresh" : "", opened?.id === d.id ? "opened" : ""].filter(Boolean).join(" ") || undefined}>
                        <td className="dim" title={d.received_at}><Ago iso={d.received_at} initial={ago(d.received_at)} /></td>
                        <td><Pair top={<span className={`src ${d.source}`}>{d.source === "tuper" ? "Tuper" : "Zuper"}</span>} under={d.module} /></td>
                        <td className="mono" title={d.event ?? undefined}>{d.event ?? "—"}</td>
                        <td className="mono dim" title={d.work_order_number ?? d.zuper_uid ?? undefined}>{d.work_order_number ?? d.zuper_uid?.slice(0, 8) ?? "—"}</td>
                        <td><Pair top={personName(d)} under={d.by_email} /></td>
                        <td><Pair top={d.by_role} under={d.by_designation} /></td>
                        <td><Pair top={d.by_emp_code} under={d.by_uid} mono /></td>
                        <td className="mono" title={c ? `${c.zuper} to Zuper, ${c.tuper} to Tuper${c.failed ? `, ${c.failed} failed` : ""}` : "No calls recorded"}>
                          {c ? <CallTally c={c} /> : <span className="dim">—</span>}
                        </td>
                        <td><span className={`pill ${o.tone}`} title={o.label}>{o.label}</span></td>
                        <td className="num dim">{d.source === "tuper" ? "" : d.attempts}</td>
                      </Row>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {rows.length > 15 ? pager : null}
        </>
      )}

      {opened ? (
        <Detail d={opened} names={names} closeHref={here()} calls={openedCalls} call={openedCall}
          callHref={(id) => here(opened!.id, id)} />
      ) : null}
    </main>
  );
}

const clean = (v: string | null) => v?.trim() || null;
const personName = (d: Delivery) => [clean(d.by_first), clean(d.by_last)].filter(Boolean).join(" ") || null;

/** Z 3 · T 41, and how many of them failed. */
function CallTally({ c }: { c: CallCount }) {
  return (
    <span className="tally">
      {c.zuper ? <span>Z {c.zuper}</span> : null}
      {c.tuper ? <span>T {c.tuper}</span> : null}
      {c.failed ? <span className="bad">{c.failed} ✗</span> : null}
    </span>
  );
}

/**
 * Two short lines in one cell: who over their email, role over designation, employee code over user uid. All come
 * from the delivery's `triggered_by`, the person whose action fired it.
 */
function Pair({ top, under, mono }: { top: React.ReactNode | string | null; under: string | null; mono?: boolean }) {
  const a = typeof top === "string" ? clean(top) : top, b = clean(under);
  if (!a && !b) return <span className="dim">—</span>;
  return (
    <span className="pair">
      <span title={typeof a === "string" ? a : undefined}>{a ?? "—"}</span>
      {b ? <span className={mono ? "note mono" : "note"} title={b}>{b}</span> : null}
    </span>
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
