/**
 * The delivery log: what Zuper sent, and what Zupersync did about it.
 *
 * Every row answers the question someone actually has when a record looks wrong
 * in one of the four applications: did Zuper tell us, did we accept it, did we
 * apply it, and if not, why not.
 */

import { deliveriesPage, totals, type Delivery } from "@/lib/db";
import { Ago } from "./live";
import { Pager, Pinned, readPaging } from "./pager";

export const dynamic = "force-dynamic";

const FILTERS = [
  { key: "", label: "All" },
  { key: "failed", label: "Failed" },
  { key: "skipped", label: "Not synced" },
  { key: "unprocessed", label: "Waiting" },
  { key: "refused", label: "Refused" },
] as const;

function outcome(d: Delivery): { label: string; tone: "ok" | "warn" | "bad" | "muted" } {
  if (!d.verified) return { label: d.verify_reason ?? "refused", tone: "bad" };
  if (d.process_error) {
    // A deliberate skip is recorded as an error string but is not a failure.
    if (d.process_error.startsWith("skipped:")) return { label: "not synced", tone: "muted" };
    return { label: d.process_error, tone: "bad" };
  }
  if (d.processed_at) return { label: d.sync_entity ?? "applied", tone: "ok" };
  return { label: "waiting", tone: "warn" };
}

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/** Arrived in the last few seconds — highlighted once, so a row appearing live catches the eye. */
const isFresh = (iso: string) => Date.now() - new Date(iso).getTime() < 15_000;

export default async function Page({ searchParams }: { searchParams: Promise<{ filter?: string; page?: string; size?: string; upto?: string }> }) {
  const sp = await searchParams;
  const filter = sp.filter ?? "";
  const paging = readPaging(sp);

  let rows: Delivery[] = [];
  let matching = 0;
  let counts = { total: 0, refused: 0, processed: 0, skipped: 0, failed: 0, waiting: 0 };
  let error: string | null = null;
  try {
    const [list, all] = await Promise.all([
      deliveriesPage({ limit: paging.size, offset: paging.offset, upto: paging.upto, filter }),
      totals(),
    ]);
    rows = list.rows; matching = list.total; counts = all;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // Older pages are pinned to the newest row on show here; an older page keeps the pin it came with.
  const pager = (
    <Pager base="/" keep={{ filter }} paging={paging} total={matching} shown={rows.length}
      anchor={paging.upto ?? (paging.page === 1 ? rows[0]?.received_at : undefined)} />
  );

  return (
    <main>
      <header className="head">
        <h1>Zupersync</h1>
        <p>Every webhook Zuper has sent, and what became of it. Zuper stays the system of record; each delivery re-reads the record and writes <code>jms.*</code>.</p>
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

          <nav className="filters">
            {FILTERS.map((f) => (
              <a key={f.key} href={f.key ? `/?filter=${f.key}` : "/"} className={filter === f.key ? "on" : ""}>{f.label}</a>
            ))}
          </nav>

          <Pinned upto={paging.upto} base="/" keep={{ filter }} size={paging.size} />
          {pager}

          {rows.length === 0 ? (
            <p className="empty">{paging.page > 1 ? "No rows on this page." : `No deliveries${filter ? " matching that filter" : " yet"}.`}</p>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr><th>When</th><th>Module</th><th>Event</th><th>Record</th><th>By</th><th>Role</th><th>Staff ID</th><th>Outcome</th><th className="num">Tries</th></tr>
                </thead>
                <tbody>
                  {rows.map((d) => {
                    const o = outcome(d);
                    return (
                      <tr key={d.id} className={isFresh(d.received_at) ? "fresh" : undefined}>
                        <td className="dim" title={d.received_at}><Ago iso={d.received_at} initial={ago(d.received_at)} /></td>
                        <td>{d.module ?? "—"}</td>
                        <td className="mono">{d.event ?? "—"}</td>
                        <td className="mono dim">{d.work_order_number ?? d.zuper_uid?.slice(0, 8) ?? "—"}</td>
                        <td><Pair top={personName(d)} under={d.by_email} /></td>
                        <td><Pair top={d.by_role} under={d.by_designation} /></td>
                        <td><Pair top={d.by_emp_code} under={d.by_uid} mono /></td>
                        <td><span className={`pill ${o.tone}`}>{o.label}</span></td>
                        <td className="num dim">{d.attempts}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {rows.length > 15 ? pager : null}
        </>
      )}
    </main>
  );
}

const clean = (v: string | null) => v?.trim() || null;
const personName = (d: Delivery) => [clean(d.by_first), clean(d.by_last)].filter(Boolean).join(" ") || null;

/**
 * Two short lines in one cell: who over their email, role over designation,
 * employee code over Zuper user uid. All seven come from the delivery's
 * `triggered_by`, the person whose action in Zuper fired it.
 */
function Pair({ top, under, mono }: { top: string | null; under: string | null; mono?: boolean }) {
  const a = clean(top), b = clean(under);
  if (!a && !b) return <span className="dim">—</span>;
  return (
    <span className="pair">
      <span>{a ?? "—"}</span>
      {b ? <span className={mono ? "note mono" : "note"}>{b}</span> : null}
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
