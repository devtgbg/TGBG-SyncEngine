/**
 * The delivery log: what Zuper sent, and what Zupersync did about it.
 *
 * Every row answers the question someone actually has when a record looks wrong
 * in one of the four applications: did Zuper tell us, did we accept it, did we
 * apply it, and if not, why not.
 */

import { recentDeliveries, totals, type Delivery } from "@/lib/db";

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

export default async function Page({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const { filter = "" } = await searchParams;

  let rows: Delivery[] = [];
  let counts = { total: 0, refused: 0, processed: 0, skipped: 0, failed: 0, waiting: 0 };
  let error: string | null = null;
  try {
    [rows, counts] = await Promise.all([recentDeliveries(100, filter), totals()]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

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

          {rows.length === 0 ? (
            <p className="empty">No deliveries{filter ? " matching that filter" : " yet"}.</p>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr><th>When</th><th>Module</th><th>Event</th><th>Record</th><th>Outcome</th><th className="num">Tries</th></tr>
                </thead>
                <tbody>
                  {rows.map((d) => {
                    const o = outcome(d);
                    return (
                      <tr key={d.id}>
                        <td className="dim" title={d.received_at}>{ago(d.received_at)}</td>
                        <td>{d.module ?? "—"}</td>
                        <td className="mono">{d.event ?? "—"}</td>
                        <td className="mono dim">{d.work_order_number ?? d.zuper_uid?.slice(0, 8) ?? "—"}</td>
                        <td><span className={`pill ${o.tone}`}>{o.label}</span></td>
                        <td className="num dim">{d.attempts}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </main>
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
