/**
 * One API call, as the dashboard shows it wherever it appears: a line in a list, and — when opened — what was sent and
 * what came back. Server components: a body is read and rendered only for the one call asked for, behind the sign-in.
 */

import Link from "next/link";
import type { ApiCall, ApiCallDetail } from "@/lib/db";
import { CopyButton } from "./row";

export const SYSTEM = { zuper: "Zuper", tuper: "Tuper" } as const;

export const ORIGIN: Record<string, string> = {
  webhook: "Zuper webhook",
  "tuper-webhook": "Tuper webhook",
  replay: "replay",
  sweep: "sweep",
  push: "push to Zuper",
  admin: "admin re-sync",
};

/** What the call was for: Tuper's writes all go to one endpoint, so its action says more than its path. */
export const what = (c: ApiCall) => (c.system === "tuper" && c.action ? c.action : `${c.method} ${c.path}`);

export const statusText = (c: ApiCall) => (c.status === null ? "no answer" : String(c.status));

export const kb = (n: number | null) =>
  n === null ? "—" : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Seconds after a moment, for a call listed under the delivery that caused it. */
export const after = (from: string, at: string) => {
  const s = Math.max(0, (new Date(at).getTime() - new Date(from).getTime()) / 1000);
  return s < 60 ? `+${s.toFixed(1)}s` : `+${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
};

/** A call in a list: where it went, what for, how it answered, how long it took. */
export function CallLine({ c, href, open, lead }: { c: ApiCall; href: string; open: boolean; lead: string }) {
  return (
    <Link href={href} scroll={false} className={`call-line${open ? " open" : ""}${c.ok ? "" : " failed"}`} aria-expanded={open}>
      <span className="dim mono">{lead}</span>
      <span className={`src ${c.system}`}>{SYSTEM[c.system]}</span>
      <span className="mono what" title={`${c.method} ${c.path}`}>{what(c)}</span>
      <span className={`pill ${c.ok ? "ok" : "bad"}`}>{statusText(c)}</span>
      <span className="num dim mono">{c.ms} ms</span>
    </Link>
  );
}

/** Pretty JSON, or the text as it came when it was not JSON (or was too long to keep whole). */
function show(v: unknown): { text: string; note: string | null } {
  if (v === null || v === undefined) return { text: "", note: null };
  const o = v as { _text?: unknown; _cut?: unknown };
  if (typeof v === "object" && typeof o._text === "string") {
    return { text: o._text, note: o._cut ? "Longer than the log keeps: only the start is shown." : "Not JSON: shown as it came." };
  }
  return { text: JSON.stringify(v, null, 2), note: null };
}

/** What was sent and what came back. */
export function CallBodies({ c }: { c: ApiCallDetail }) {
  const req = show(c.request);
  const res = show(c.response);
  const gone = c.request === null && c.response === null && ((c.request_bytes ?? 0) > 0 || (c.response_bytes ?? 0) > 0);
  return (
    <div className="call-bodies">
      <dl className="facts">
        <dt>Request</dt><dd className="mono wrapany">{c.method} {c.path}</dd>
        {c.action && c.system === "tuper" ? (<><dt>Does</dt><dd className="mono">{c.action}</dd></>) : null}
        <dt>Answer</dt><dd>{c.status === null ? "none — the request never got an answer" : `HTTP ${c.status}`}{c.ok ? "" : " (failed)"}</dd>
        {c.error ? (<><dt>Error</dt><dd className="mono wrapany">{c.error}</dd></>) : null}
        <dt>Took</dt><dd>{c.ms} ms{c.attempt > 1 ? ` · attempt ${c.attempt}` : ""}</dd>
        <dt>Sizes</dt><dd>sent {kb(c.request_bytes)} · received {kb(c.response_bytes)}</dd>
      </dl>
      {gone ? <p className="note">The bodies of this call are no longer kept (the log keeps them for 48 hours).</p> : null}
      {req.text ? (
        <section>
          <div className="raw-head"><h3>Sent</h3><CopyButton text={req.text} label="Copy" /></div>
          <pre className="raw">{req.text}</pre>
          {req.note ? <p className="note">{req.note}</p> : null}
        </section>
      ) : null}
      {res.text ? (
        <section>
          <div className="raw-head"><h3>Received</h3><CopyButton text={res.text} label="Copy" /></div>
          <pre className="raw">{res.text}</pre>
          {res.note ? <p className="note">{res.note}</p> : null}
        </section>
      ) : null}
      <p className="note">Headers are never recorded: both API keys travel in them. Fields named like a credential show as (hidden).</p>
    </div>
  );
}
