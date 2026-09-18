/**
 * One delivery, opened from the log: what Zupersync did with it, who caused it, what it says changed, the API calls it
 * took, and the webhook exactly as it was stored.
 *
 * A server component, so the body (customer names, addresses, job details) is read and rendered behind the sign-in and
 * only for the one delivery asked for. A call's bodies are read only for the one call opened under it.
 */

import Link from "next/link";
import type { ApiCall, ApiCallDetail, DeliveryDetail } from "@/lib/db";
import { describe, dubaiTime } from "@/lib/describe";
import { outcome } from "@/lib/outcome";
import { CallBodies, CallLine, after } from "./call-view";
import { CopyButton, EscapeTo } from "./row";

export function Detail({ d, names, closeHref, calls, call, callHref }: {
  d: DeliveryDetail;
  names: Record<string, string>;
  closeHref: string;
  /** Null when the call log does not exist yet. */
  calls: { rows: ApiCall[]; total: number } | null;
  call: ApiCallDetail | null;
  callHref: (id?: string) => string;
}) {
  const o = outcome(d);
  const fromTuper = d.source === "tuper";
  const said = describe(d.event, d.body, names);
  const body = JSON.stringify(d.body ?? null, null, 2);
  // Masked in lib/db.ts before it ever reaches a component: props are serialised into the page.
  const shown = d.headers;
  const hidden = d.hiddenHeaders;
  const headerText = JSON.stringify(shown, null, 2);
  const anyBefore = said.changes.some((c) => c.before !== undefined);
  const person = [d.by_first, d.by_last].map((s) => s?.trim()).filter(Boolean).join(" ");
  const failed = o.tone === "bad" && d.verified;
  const from = fromTuper ? "Tuper" : "Zuper";

  return (
    <>
      <Link className="backdrop" href={closeHref} scroll={false} aria-label="Close the delivery" tabIndex={-1} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Delivery detail">
        <EscapeTo href={closeHref} />

        <header className="drawer-head">
          <div>
            <p className="mono dim"><span className={`src ${d.source}`}>{from}</span> {d.event ?? "no event"}</p>
            <h2>{said.headline}</h2>
            <p className="dim">
              {dubaiTime(d.received_at)} (Dubai)
              {d.work_order_number ? <> · job {d.work_order_number}</> : null}
            </p>
          </div>
          <Link className="close" href={closeHref} scroll={false}>Close</Link>
        </header>

        <section>
          <h3>What Zupersync did</h3>
          <dl className="facts">
            <dt>Outcome</dt>
            <dd><span className={`pill ${o.tone}`}>{failed ? "failed" : o.label}</span></dd>
            {failed ? (<><dt>Error</dt><dd className="mono wrapany">{d.process_error}</dd></>) : null}
            {d.process_error?.startsWith("skipped:") ? (<><dt>Why not synced</dt><dd>{d.process_error.slice("skipped:".length).trim()}</dd></>) : null}
            <dt>{fromTuper ? "Signature" : "Secret header"}</dt>
            <dd>{d.verified ? "matched" : `did not match (${d.verify_reason ?? "refused"}), so it was stored and never processed`}</dd>
            {d.sync_entity ? (<><dt>Synced as</dt><dd className="mono">{d.sync_entity}</dd></>) : null}
            {d.processed_at ? (<><dt>Processed</dt><dd>{dubaiTime(d.processed_at)} (Dubai)</dd></>) : null}
            {/* A Tuper delivery is queued once and never replayed, so it has no tries to count. */}
            {fromTuper ? null : (<><dt>Tries</dt><dd>{d.attempts}</dd></>)}
            {d.zuper_uid ? (<><dt>Zuper record</dt><dd className="mono wrapany">{d.zuper_uid}</dd></>) : null}
          </dl>
          {fromTuper && d.processed_at && !d.process_error ? (
            <p className="note">Queued for Zuper. <a href="/pushes">To Zuper</a> shows what became of it.</p>
          ) : null}
        </section>

        <section>
          <h3>Who</h3>
          {person || d.by_email ? (
            <dl className="facts">
              <dt>Name</dt><dd>{person || "—"}</dd>
              <dt>Email</dt><dd className="wrapany">{d.by_email ?? "—"}</dd>
              <dt>Role</dt><dd>{d.by_role ?? "—"}</dd>
              <dt>Designation</dt><dd>{d.by_designation ?? "—"}</dd>
              <dt>Employee code</dt><dd>{d.by_emp_code ?? "—"}</dd>
              <dt>{from} user uid</dt><dd className="mono wrapany">{d.by_uid ?? "—"}</dd>
            </dl>
          ) : (
            <p className="dim">This delivery names nobody.</p>
          )}
        </section>

        <section>
          <h3>What changed</h3>
          {said.changes.length ? (
            <table className="changes-table">
              <thead>
                <tr><th>Field</th>{anyBefore ? <th>Before</th> : null}<th>{anyBefore ? "After" : "Value sent"}</th></tr>
              </thead>
              <tbody>
                {said.changes.map((c, i) => (
                  <tr key={i}>
                    <td>{c.label}</td>
                    {anyBefore ? <td className="was">{c.before ?? ""}</td> : null}
                    <td>{c.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="dim">The webhook carries no field values for this event.</p>
          )}
          {said.notes.map((n, i) => <p key={i} className="note">{n}</p>)}
          <p className="note">
            {fromTuper
              ? "This is what Tuper's webhook says. Zupersync queues the change; pushing it plans against Zuper's record as it stands then."
              : "This is what the webhook says. Zupersync does not copy these values: it re-reads the record from Zuper and writes that through Tuper's API."}
          </p>
        </section>

        <section>
          <h3>API calls</h3>
          <Calls d={d} calls={calls} call={call} callHref={callHref} />
        </section>

        <section>
          <div className="raw-head">
            <h3>Exact webhook</h3>
            <CopyButton text={body} label="Copy body" />
          </div>
          <pre className="raw">{body}</pre>

          <details className="raw-headers">
            <summary>Request headers ({Object.keys(shown).length})</summary>
            <pre className="raw">{headerText}</pre>
          </details>
          <p className="note">
            The body is as stored: every value exactly as {from} sent it, with the keys in the order the database keeps them.
            {hidden.length ? ` ${hidden.join(", ")} ${hidden.length === 1 ? "is" : "are"} hidden: ${hidden.length === 1 ? "it authenticates" : "they authenticate"} deliveries.` : ""}
          </p>
        </section>
      </aside>
    </>
  );
}

function Calls({ d, calls, call, callHref }: {
  d: DeliveryDetail; calls: { rows: ApiCall[]; total: number } | null; call: ApiCallDetail | null; callHref: (id?: string) => string;
}) {
  if (!calls) return <p className="dim">The API call log starts with the service version that records it; it is not deployed yet.</p>;
  if (!calls.rows.length) {
    return (
      <p className="dim">
        {!d.verified || d.process_error?.startsWith("skipped:")
          ? "None: this delivery was never acted on."
          : "None recorded. Calls are recorded from the service version that logs them; a delivery handled before it has none."}
      </p>
    );
  }
  const zuper = calls.rows.filter((c) => c.system === "zuper").length;
  const bad = calls.rows.filter((c) => !c.ok).length;
  return (
    <>
      <p className="note calls-summary">
        {calls.total.toLocaleString()} call{calls.total === 1 ? "" : "s"}: {zuper} to Zuper, {calls.rows.length - zuper} to Tuper
        {bad ? `, ${bad} failed` : ""}{calls.total > calls.rows.length ? ` (the first ${calls.rows.length} are listed)` : ""}. Open one to see what was sent and received.
      </p>
      <div className="call-list">
        {calls.rows.map((c) => {
          const open = call?.id === c.id;
          return (
            <div key={c.id}>
              <CallLine c={c} open={open} lead={after(d.received_at, c.at)} href={open ? callHref() : callHref(c.id)} />
              {open && call ? <CallBodies c={call} /> : null}
            </div>
          );
        })}
      </div>
    </>
  );
}
