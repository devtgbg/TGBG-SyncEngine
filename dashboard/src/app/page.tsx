/**
 * The engine at a glance: which way it syncs, whether it is running, how each direction is doing, what needs a person,
 * and the controls to act on it.
 *
 * Everything here is either measured from the store or reported by the engine itself (sync.engine); nothing is
 * assumed from what was last saved. The page refreshes itself when anything it shows moves.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import {
  connectionSummary, engine, flow, getSettings, hourly, latestBy, liveness, recentCommands, snapshot,
  type Catalogue, type Command, type Registrations,
} from "@/lib/control";
import { COMMANDS, DIRECTION, directionOf, minutes, PUSH_MODE, type Settings } from "@/lib/engine";
import { dubaiTime } from "@/lib/describe";
import { ActivityChart } from "./activity-chart";
import { CommandButton } from "./controls";
import { Ago } from "./live";

export const dynamic = "force-dynamic";

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/** Why a safety net is not running, when the settings say so; the engine reporting it stopped says the rest. */
const offBecause = (s: Settings | null | undefined, on: boolean | undefined) =>
  !s ? "" : !s.inbound ? "Held while Zuper → Tuper is off. " : on === false ? "Turned off in Settings. " : "";

type SP = Record<string, string | undefined>;

export default async function Overview({ searchParams }: { searchParams: Promise<SP> }) {
  // The webhook log lived here until 2026-09-22: its links (?open=, ?source=, …) still arrive and belong there.
  const sp = await searchParams;
  if (["open", "filter", "source", "page", "upto", "call", "size"].some((k) => sp[k])) {
    redirect(`/webhooks?${new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][])}`);
  }

  let error: string | null = null;
  let data: {
    row: Awaited<ReturnType<typeof getSettings>>; eng: Awaited<ReturnType<typeof engine>>; fl: Awaited<ReturnType<typeof flow>>;
    hours: Awaited<ReturnType<typeof hourly>>; cmds: Command[]; cat: Catalogue | null; regs: Registrations | null; regsAt: string | null;
  } | null = null;
  try {
    const [row, eng, fl, hours, cmds, cat, regs] = await Promise.all([
      getSettings().catch(() => null), engine(), flow(), hourly(), recentCommands(8),
      snapshot<Catalogue>("catalogue"), snapshot<Registrations>("registrations"),
    ]);
    data = { row, eng, fl, hours, cmds, cat: cat?.data ?? null, regs: regs?.data ?? null, regsAt: regs?.taken_at ?? null };
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  if (error || !data) return <main><p className="error">Could not read the engine&apos;s state: {error}</p></main>;

  const { row, eng, fl, hours, cmds, cat, regs, regsAt } = data;
  // What runs is what the engine says it applied; before it reports, the saved settings are the best guess.
  const s: Settings | null = eng?.applied ?? row?.data ?? null;
  const live = liveness(eng);
  const latest = latestBy(cmds);
  const conn = connectionSummary(cat, regs);
  const unsent = (fl.queue.queued ?? 0) + (fl.queue.planned ?? 0) + (fl.queue.failed ?? 0);
  const noId = fl.tuper.day - fl.tuper.carriedId;
  const pending = row && eng && eng.applied_version !== row.version;

  // What a person should look at, most serious first. Each says what is wrong, why it matters and what to do.
  const attention: { tone: "bad" | "warn"; title: string; body: React.ReactNode; action?: React.ReactNode }[] = [];
  if (live.state !== "online") {
    attention.push({ tone: "bad", title: live.label, body: eng ? `Last heard from ${dubaiTime(eng.heartbeat_at)} (Dubai). Webhooks are still stored by whatever is serving them, but settings and buttons wait for it.` : "No heartbeat yet: the engine reports once it runs the version with engine controls." });
  }
  if (fl.failedAll) {
    attention.push({ tone: "bad", title: `${fl.failedAll} Zuper deliver${fl.failedAll === 1 ? "y" : "ies"} failed`,
      body: <>Their changes are not in Tuper. <Link href="/webhooks?source=zuper&filter=failed">See why</Link>, fix the cause, then replay them — they are processed again, not relabelled.</>,
      action: <CommandButton command="replay-failed" label="Replay failed" latest={latest["replay-failed"]} /> });
  }
  if (conn.zuper?.missing.length) {
    attention.push({ tone: "warn", title: `${conn.zuper.missing.length} Zuper events have no webhook`,
      body: <>The engine handles them, but Zuper was never told to send them, so they never arrive. <Link href="/connections">See which</Link>.</> });
  }
  if (conn.tuper?.wrongModule.length) {
    attention.push({ tone: "warn", title: `${conn.tuper.wrongModule.length} Tuper webhooks are registered under the wrong module`,
      body: <>Registered as {[...new Set(conn.tuper.wrongModule.map((w) => w.registeredAs))].join(", ")} where Tuper&apos;s catalogue says {[...new Set(conn.tuper.wrongModule.map((w) => w.needs))].join(", ")}, so their deliveries carry no record id{noId ? ` (${noId} in the last 24 hours)` : ""}. <Link href="/connections">Details</Link>.</> });
  }
  if (unsent) {
    attention.push({ tone: "warn", title: `${unsent} change${unsent === 1 ? "" : "s"} from Tuper not sent to Zuper`,
      body: s?.push.mode === "off" ? "Pushing to Zuper is off, so they will never be sent." : <><Link href="/pushes">See them</Link>.</>,
      action: <CommandButton command="discard-unsent" label="Discard them" tone="danger" latest={latest["discard-unsent"]}
        confirm={`Discard ${unsent} change(s) made in Tuper that have not been sent to Zuper? They are removed from the queue and never sent.`} /> });
  }
  if (fl.calls.zuperFailed + fl.calls.tuperFailed > 0) {
    attention.push({ tone: "warn", title: `${fl.calls.zuperFailed + fl.calls.tuperFailed} failed API call${fl.calls.zuperFailed + fl.calls.tuperFailed === 1 ? "" : "s"} in the last hour`,
      body: <>{fl.calls.zuperFailed} to Zuper, {fl.calls.tuperFailed} to Tuper. Some are expected answers (a record Zuper deleted). <Link href="/calls?failed=1">See them</Link>.</> });
  }

  const dir = s ? directionOf(s) : null;
  const pushLabel = s ? (s.push.mode === "live" ? `Live · ${s.push.entities.join(", ") || "nothing chosen"}` : PUSH_MODE[s.push.mode]) : "—";

  return (
    <main>
      <section className={`engine-head ${live.state}`}>
        <div>
          <p className="eyebrow">Sync engine</p>
          <h1>{dir ? DIRECTION[dir].label : "Not configured yet"}</h1>
          <p className="dim">{dir ? DIRECTION[dir].about : "The engine creates its settings the first time it starts with this version."}</p>
          <p className="engine-status" role="status">
            <span className={`dot ${live.state === "online" ? "ok" : live.state === "late" ? "warn" : "bad"}`} aria-hidden="true" />
            <strong>{live.label}</strong>
            {eng ? <> · heartbeat <Ago iso={eng.heartbeat_at} initial={ago(eng.heartbeat_at)} /> · running since {dubaiTime(eng.started_at)}{eng.commit ? <> · <span className="mono">{eng.commit}</span></> : null}</> : null}
            {row ? <> · settings v{row.version} {pending ? <span className="warn-text">(v{eng?.applied_version ?? "—"} applied — waiting)</span> : "applied"}</> : null}
          </p>
        </div>
        <Link href="/settings" className="btn primary">Settings</Link>
      </section>

      <div className="lanes">
        <section className={`lane ${s?.inbound ? "on" : "off"}`}>
          <header>
            <h2><span className="src zuper">Zuper</span> <span className="arrow">→</span> <span className="src tuper">Tuper</span></h2>
            <span className={`state ${s?.inbound ? "on" : "off"}`}>{s?.inbound ? "On" : "Off — held"}</span>
          </header>
          <dl className="metrics">
            <div><dt>Webhooks · last hour</dt><dd>{fl.zuper.hour.toLocaleString()}</dd></div>
            <div><dt>Webhooks · 24h</dt><dd>{fl.zuper.day.toLocaleString()}</dd></div>
            <div><dt>Applied</dt><dd className="ok-text">{fl.zuper.applied.toLocaleString()}</dd></div>
            <div><dt>Failed</dt><dd className={fl.zuper.failed ? "bad-text" : ""}>{fl.zuper.failed.toLocaleString()}</dd></div>
            <div><dt>{s?.inbound ? "Waiting" : "Held"}</dt><dd className={fl.zuper.held ? "warn-text" : ""}>{fl.zuper.held.toLocaleString()}</dd></div>
            <div><dt>Median to Tuper</dt><dd>{fl.zuper.median_s !== null ? `${fl.zuper.median_s}s` : "—"}</dd></div>
          </dl>
          <p className="lane-foot">
            Records written to Tuper in 24h: <strong>{fl.writes.total.toLocaleString()}</strong> — {fl.writes.created} created, {fl.writes.updated} updated, {fl.writes.deleted} deleted
            {fl.writes.failed ? <>, <span className="bad-text">{fl.writes.failed} failed</span></> : null}.
            {fl.zuper.last ? <> Last webhook <Ago iso={fl.zuper.last} initial={ago(fl.zuper.last)} />.</> : null}
          </p>
          <nav className="lane-links"><Link href="/webhooks?source=zuper">Webhooks</Link><Link href="/tuper">To Tuper</Link></nav>
        </section>

        <section className={`lane ${s && s.push.mode !== "off" ? "on" : "off"}`}>
          <header>
            <h2><span className="src tuper">Tuper</span> <span className="arrow">→</span> <span className="src zuper">Zuper</span></h2>
            <span className={`state ${s?.push.mode === "live" ? "live" : s?.push.mode === "dry-run" ? "plan" : "off"}`}>{pushLabel}</span>
          </header>
          <dl className="metrics">
            <div><dt>Tuper webhooks · 24h</dt><dd>{fl.tuper.day.toLocaleString()}</dd></div>
            <div><dt>Carried a record id</dt><dd className={noId ? "warn-text" : ""}>{fl.tuper.carriedId.toLocaleString()}</dd></div>
            <div><dt>Queued</dt><dd>{(fl.queue.queued ?? 0).toLocaleString()}</dd></div>
            <div><dt>Planned</dt><dd>{(fl.queue.planned ?? 0).toLocaleString()}</dd></div>
            <div><dt>Sent</dt><dd className="ok-text">{(fl.queue.sent ?? 0).toLocaleString()}</dd></div>
            <div><dt>Failed</dt><dd className={fl.queue.failed ? "bad-text" : ""}>{(fl.queue.failed ?? 0).toLocaleString()}</dd></div>
          </dl>
          <p className="lane-foot">
            {s?.push.mode === "off" ? "Pushing is off: changes made in Tuper are recorded, not queued, and nothing is sent."
              : s?.push.mode === "dry-run" ? "Plan only: each change is planned against Zuper's record and shown, nothing is sent."
              : `Live: changes to ${s?.push.entities.join(", ")} are sent to Zuper; on a conflict ${s?.push.onConflict === "tuper-wins" ? "Tuper" : "Zuper"} wins.`}
            {fl.tuper.last ? <> Last Tuper webhook <Ago iso={fl.tuper.last} initial={ago(fl.tuper.last)} />.</> : null}
          </p>
          <nav className="lane-links"><Link href="/webhooks?source=tuper">Webhooks</Link><Link href="/pushes">To Zuper</Link></nav>
        </section>
      </div>

      <section className="card">
        <header className="card-head"><h2>Needs attention</h2></header>
        {attention.length ? (
          <ul className="attention">
            {attention.map((a, i) => (
              <li key={i} className={a.tone}>
                <span className={`dot ${a.tone}`} aria-hidden="true" />
                <div><strong>{a.title}</strong><p>{a.body}</p></div>
                {a.action ?? null}
              </li>
            ))}
          </ul>
        ) : <p className="all-clear"><span className="dot ok" aria-hidden="true" /> Nothing needs attention.</p>}
      </section>

      <section className="card">
        <header className="card-head"><h2>Webhooks per hour</h2><p className="note">Last 24 hours, Dubai time.</p></header>
        <ActivityChart buckets={hours} />
      </section>

      <div className="grid-2">
        <section className="card">
          <header className="card-head"><h2>Safety nets</h2></header>
          <ul className="nets">
            <li>
              <div><strong>Replay</strong> <span className={`state ${eng?.state.timers?.replay ? "on" : "off"}`}>{eng?.state.timers?.replay ? "every 2 minutes" : "off"}</span>
                <p className="note">Retries failed Zuper deliveries. {offBecause(s, s?.replay)}{eng?.state.replay ? `Last: ${eng.state.replay.attempted} tried, ${eng.state.replay.ok} applied, ${eng.state.replay.failed} still failing (${dubaiTime(eng.state.replay.at)}).` : "Nothing has needed a retry since the engine started."}</p></div>
            </li>
            <li>
              <div><strong>Sweep</strong> <span className={`state ${eng?.state.timers?.sweep ? "on" : "off"}`}>{eng?.state.timers?.sweep ? `every ${minutes(s?.sweep.everyMinutes ?? 30)}` : "off"}</span>
                <p className="note">Re-reads what Zuper changed recently, for webhooks that never arrived. {offBecause(s, s?.sweep.enabled)}{eng?.state.sweep ? `Last pass ${dubaiTime(eng.state.sweep.at)}: ${eng.state.sweep.jobsInWindow} jobs in the window, ${eng.state.sweep.jobsMissing} missing, ${eng.state.sweep.jobsDrifted} behind; ${eng.state.sweep.resynced} written, ${eng.state.sweep.failed} failed.` : "No pass reported since the engine started."}</p></div>
              <CommandButton command="sweep-now" label="Sweep now" latest={latest["sweep-now"]} disabled={!s?.inbound} />
            </li>
            <li>
              <div><strong>Connections</strong>
                <p className="note">The webhooks registered on each side, checked every 30 minutes. {regsAt ? `Last checked ${dubaiTime(regsAt)}.` : "Not checked yet."}</p></div>
              <CommandButton command="refresh-connections" label="Check now" latest={latest["refresh-connections"]} />
            </li>
            <li>
              <div><strong>API call log</strong> <span className={`state ${s?.apiLog.enabled ? "on" : "off"}`}>{s?.apiLog.enabled ? "recording" : "off"}</span>
                <p className="note">Last hour: {fl.calls.zuper.toLocaleString()} calls to Zuper, {fl.calls.tuper.toLocaleString()} to Tuper. <Link href="/calls">API calls</Link></p></div>
            </li>
          </ul>
        </section>

        <section className="card">
          <header className="card-head"><h2>Recent actions</h2></header>
          {cmds.length ? (
            <ol className="history">
              {cmds.map((c) => (
                <li key={c.id}>
                  <span className={`dot ${c.finished_at ? (c.ok ? "ok" : "bad") : "warn"}`} aria-hidden="true" />
                  <span><strong>{COMMANDS[c.command]?.label ?? c.command}</strong>{c.result ? <span className="note"> — {c.result}</span> : <span className="note"> — {c.started_at ? "running" : "waiting for the engine"}</span>}</span>
                  <span className="dim">{dubaiTime(c.requested_at)}{c.requested_by ? ` · ${c.requested_by}` : ""}</span>
                </li>
              ))}
            </ol>
          ) : <p className="dim">No actions asked for yet. Buttons here and on Connections send them to the engine.</p>}
        </section>
      </div>
    </main>
  );
}
