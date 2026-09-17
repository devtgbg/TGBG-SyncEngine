/**
 * Changes made in Tuper, and what Zupersync will do (or did) with them in Zuper.
 *
 * While PUSH_MODE is dry-run this page is the review: each row shows the change,
 * the exact requests that would be sent, and what will not be pushed and why.
 * Nothing on this page sends anything.
 */

import { pushTotals, pushesPage, type Push } from "@/lib/db";
import { Pager, Pinned, readPaging } from "../pager";

export const dynamic = "force-dynamic";

const FILTERS = [
  { key: "", label: "All" },
  { key: "planned", label: "Planned" },
  { key: "sent", label: "Sent" },
  { key: "failed", label: "Failed" },
  { key: "skipped", label: "Not pushed" },
  { key: "queued", label: "Queued" },
] as const;

const STATUS: Record<Push["status"], { label: string; tone: "ok" | "warn" | "bad" | "muted" }> = {
  queued: { label: "queued", tone: "warn" },
  planned: { label: "would send", tone: "warn" },
  sent: { label: "sent", tone: "ok" },
  failed: { label: "failed", tone: "bad" },
  skipped: { label: "not pushed", tone: "muted" },
  superseded: { label: "merged", tone: "muted" },
};

/** Column names as a person would say them. */
const COLUMN: Record<string, string> = {
  title: "Title", priority: "Priority", job_type: "Job type", due_date: "Due date", prefix: "Prefix",
  job_tags: "Tags", description: "Description", description_html: "Description",
  plain_text_description: "Description", markdown_description: "Description",
  scheduled_start_time: "Start", scheduled_end_time: "End", current_status_id: "Status",
  customer_id: "Customer", organization_id: "Organization", asset_id: "Asset",
  service_address: "Service address", billing_address: "Billing address",
  is_deleted: "Deleted", deleted_at: "Deleted at", is_delayed: "Delayed",
  _assignees: "Assigned people", _teams: "Teams", work_order_number: "Work order",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return when(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "object") return Array.isArray(v) ? v.join(", ") || "—" : "…";
  const s = String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

function Changes({ p }: { p: Push }) {
  if (p.operation === "create") return <span>New job</span>;
  const seen = new Set<string>();
  const items = Object.keys(p.changed ?? {}).filter((k) => {
    const label = COLUMN[k] ?? k;
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  });
  return (
    <div className="changes">
      {items.map((k) => (
        <span key={k}>
          {COLUMN[k] ?? k}
          {k.startsWith("_") || k === "current_status_id" || k.endsWith("_id") ? null : (
            <>: <span className="from">{show(p.previous?.[k])}</span> → {show(p.changed[k])}</>
          )}
        </span>
      ))}
    </div>
  );
}

function Requests({ p }: { p: Push }) {
  const plan = p.planned;
  if (!plan) return <span className="note">{p.status === "queued" ? "not planned yet" : "—"}</span>;
  return (
    <div className="requests">
      {plan.requests.map((r, i) => (
        <details key={i}>
          <summary><span className="mono">{r.method} {r.path}</span> <span className="note">— {r.why}</span></summary>
          <pre>{JSON.stringify(r.body ?? null, null, 2)}</pre>
        </details>
      ))}
      {plan.blocked ? <span className="note">Cannot push: {plan.blocked}</span> : null}
      {plan.notPushed.map((n, i) => (
        <span key={`n${i}`} className="note">Not pushed — {COLUMN[n.column] ?? n.column}: {n.reason}</span>
      ))}
    </div>
  );
}

export default async function Pushes({ searchParams }: { searchParams: Promise<{ status?: string; page?: string; size?: string; upto?: string }> }) {
  const sp = await searchParams;
  const status = sp.status ?? "";
  const paging = readPaging(sp);
  let rows: Push[] = [];
  let matching = 0;
  let totals: Record<string, number> = {};
  let error: string | null = null;
  try {
    const [list, all] = await Promise.all([
      pushesPage({ limit: paging.size, offset: paging.offset, upto: paging.upto, status: status || undefined }),
      pushTotals(),
    ]);
    rows = list.rows; matching = list.total; totals = all;
  } catch (err) {
    const e = err as { message?: string };
    error = e?.message ?? String(err);
  }

  const pager = (
    <Pager base="/pushes" keep={{ status }} paging={paging} total={matching} shown={rows.length}
      anchor={paging.upto ?? (paging.page === 1 ? rows[0]?.queued_at : undefined)} />
  );

  return (
    <main>
      <header className="head">
        <h1>Changes going to Zuper</h1>
        <p>
          Every change made to a job in Tuper is queued here. Zupersync works out the Zuper requests from the job as it is now,
          and skips anything Zuper already has. In dry-run mode nothing is sent: &ldquo;would send&rdquo; rows are the review.
        </p>
      </header>

      {error ? (
        <p className="error">Could not read the outbox: {error}</p>
      ) : (
        <>
          <section className="tiles">
            <div className="tile warn"><strong>{(totals.planned ?? 0).toLocaleString()}</strong><span>would send</span></div>
            <div className="tile ok"><strong>{(totals.sent ?? 0).toLocaleString()}</strong><span>sent</span></div>
            <div className={`tile ${totals.failed ? "bad" : ""}`}><strong>{(totals.failed ?? 0).toLocaleString()}</strong><span>failed</span></div>
            <div className="tile"><strong>{(totals.skipped ?? 0).toLocaleString()}</strong><span>not pushed</span></div>
            <div className={`tile ${totals.queued ? "warn" : ""}`}><strong>{(totals.queued ?? 0).toLocaleString()}</strong><span>queued</span></div>
          </section>

          <nav className="filters">
            {FILTERS.map((f) => (
              <a key={f.key} href={f.key ? `/pushes?status=${f.key}` : "/pushes"} className={status === f.key ? "on" : ""}>{f.label}</a>
            ))}
          </nav>

          <Pinned upto={paging.upto} base="/pushes" keep={{ status }} size={paging.size} />
          {pager}

          {rows.length === 0 ? (
            <p className="empty">{paging.page > 1 ? "No rows on this page." : `No changes from Tuper${status ? " with that status" : " yet"}.`}</p>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr><th>When (Dubai)</th><th>Job</th><th>Change in Tuper</th><th>Zuper</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const s = STATUS[p.status] ?? { label: p.status, tone: "muted" as const };
                    return (
                      <tr key={p.id} className={Date.now() - new Date(p.queued_at).getTime() < 15_000 ? "fresh" : undefined}>
                        <td className="dim" title={p.queued_at}>{when(p.queued_at)}</td>
                        <td className="mono">{p.planned?.workOrder ?? "—"}</td>
                        <td className="wrap"><Changes p={p} /></td>
                        <td className="wrap"><Requests p={p} /></td>
                        <td>
                          <span className={`pill ${s.tone}`}>{s.label}</span>
                          {p.last_error && p.status === "failed" ? <div className="note">{p.last_error}</div> : null}
                          {p.attempts ? <div className="note">tried {p.attempts}×</div> : null}
                        </td>
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
