"use client";

/**
 * The engine's settings, edited in place and saved as one new version.
 *
 * Nothing changes until Save: the switches only edit this form. Saving writes the next version; the engine reads it
 * within 5 seconds and says it has applied it, which the page shows beside the Save button (from the engine's
 * heartbeat, not from the save). Sending to Zuper live asks first — a status pushed to Zuper is a real status change
 * on a technician's phone.
 */

import { useActionState, useEffect, useMemo, useState } from "react";
import { saveSettingsAction, type ActionResult } from "../actions";
import { DIRECTION, directionOf, NOT_PUSHABLE, PUSHABLE, minutes, type Direction, type Settings } from "@/lib/engine";

function Switch({ checked, onChange, label, about, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; about?: string; disabled?: boolean;
}) {
  return (
    <label className={`switch${disabled ? " disabled" : ""}`}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" aria-hidden="true"><span className="thumb" /></span>
      <span className="switch-text">
        <strong>{label}</strong>
        {about ? <span className="note">{about}</span> : null}
      </span>
    </label>
  );
}

function Choice({ value, options, onChange, format, disabled }: {
  value: number; disabled?: boolean; options: number[]; onChange: (v: number) => void; format: (v: number) => string;
}) {
  const all = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}>
      {all.map((o) => <option key={o} value={o}>{format(o)}</option>)}
    </select>
  );
}

/**
 * What the form submits: every setting, from the form's state. The visible controls are not named, because a disabled
 * control is not submitted — saving with Zuper → Tuper off would otherwise switch the replay and sweep off too.
 */
function Submitted({ s }: { s: Settings }) {
  const flag = (name: string, v: boolean) => (v ? <input type="hidden" name={name} value="on" /> : null);
  return (
    <>
      {flag("inbound", s.inbound)}
      {flag("push", s.push.mode !== "off")}
      <input type="hidden" name="pushMode" value={s.push.mode === "live" ? "live" : "dry-run"} />
      {PUSHABLE.map((k) => <span key={k.key}>{flag(`entity:${k.key}`, s.push.entities.includes(k.key))}</span>)}
      {flag("deletes", s.push.deletes)}
      <input type="hidden" name="onConflict" value={s.push.onConflict} />
      <input type="hidden" name="maxAgeMinutes" value={s.push.maxAgeMinutes} />
      {flag("replay", s.replay)}
      {flag("sweep", s.sweep.enabled)}
      <input type="hidden" name="sweepEvery" value={s.sweep.everyMinutes} />
      {flag("apiLog", s.apiLog.enabled)}
      <input type="hidden" name="bodyHours" value={s.apiLog.bodyHours} />
      <input type="hidden" name="days" value={s.apiLog.days} />
    </>
  );
}

const PRESETS: Direction[] = ["two-way", "zuper-to-tuper", "tuper-to-zuper", "paused"];

export function SettingsForm({ initial, version }: { initial: Settings; version: number }) {
  // The version the edits started from. The page refreshes itself, and a save elsewhere brings a new version: it is
  // taken in only while there is nothing unsaved here (or when it is exactly what is here, as after this form's own
  // save). With edits in progress the form keeps them and says a newer version exists; saving is then refused by the
  // store, rather than one person's change quietly undoing another's.
  const [base, setBase] = useState({ version, initial });
  const [s, set] = useState<Settings>(initial);
  const [state, act, pending] = useActionState<ActionResult | null, FormData>(saveSettingsAction, null);
  const dirty = useMemo(() => JSON.stringify(s) !== JSON.stringify(base.initial), [s, base]);
  const incoming = JSON.stringify(initial);
  useEffect(() => {
    if (version === base.version) return;
    if (!dirty || incoming === JSON.stringify(s)) { setBase({ version, initial }); set(initial); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, incoming]);
  const stale = version !== base.version;
  const reload = () => { setBase({ version, initial }); set(initial); };
  const direction = directionOf(s);
  const pushOn = s.push.mode !== "off";
  const patch = (p: Partial<Settings>) => set((cur) => ({ ...cur, ...p }));
  const push = (p: Partial<Settings["push"]>) => set((cur) => ({ ...cur, push: { ...cur.push, ...p } }));

  /** A preset flips the two directions. Turning Tuper → Zuper on starts at Plan only: going live is its own choice. */
  const preset = (d: Direction) => {
    const out = d === "two-way" || d === "tuper-to-zuper";
    set((cur) => ({
      ...cur,
      inbound: d === "two-way" || d === "zuper-to-tuper",
      push: { ...cur.push, mode: out ? (cur.push.mode === "off" ? "dry-run" : cur.push.mode) : "off" },
    }));
  };

  const goingLive = s.push.mode === "live" && (initial.push.mode !== "live" || s.push.entities.some((e) => !initial.push.entities.includes(e)));

  return (
    <form
      action={act}
      className="settings"
      onSubmit={(e) => {
        if (goingLive && !window.confirm(
          `Send changes made in Tuper to Zuper, live, for: ${s.push.entities.join(", ")}?\n\n` +
          "Each change is written to Zuper. A status sent is a real status change: it appears on the technician's phone " +
          "and fires Zuper's notifications. Changes queued before now are not sent if they are older than " +
          `${minutes(s.push.maxAgeMinutes)}.`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="version" value={base.version} />
      {stale ? (
        <p className="callout warn" role="alert">
          <span>Version {version} was saved elsewhere while you were editing version {base.version}. Saving now is refused so it is not overwritten.</span>
          <button type="button" className="btn" onClick={reload}>Load version {version}</button>
        </p>
      ) : null}
      <Submitted s={s} />

      <section className="card">
        <header className="card-head">
          <h2>Sync direction</h2>
          <p className="note">{DIRECTION[direction].about}</p>
        </header>
        <div className="presets" role="radiogroup" aria-label="Sync direction">
          {PRESETS.map((d) => (
            <button key={d} type="button" role="radio" aria-checked={direction === d}
              className={`preset${direction === d ? " on" : ""}`} aria-label={DIRECTION[d].label} onClick={() => preset(d)}>
              <span className="preset-arrow">{DIRECTION[d].short}</span>
              <span className="note">{DIRECTION[d].hint}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="grid-2">
        <section className="card">
          <header className="card-head">
            <h2><span className="src zuper">Zuper</span> → <span className="src tuper">Tuper</span></h2>
            <p className="note">Zuper stays the system of record. Each webhook re-reads the record from Zuper&apos;s API and writes it through Tuper&apos;s.</p>
          </header>
          <Switch checked={s.inbound} onChange={(v) => patch({ inbound: v })}
            label="Push to Tuper"
            about={s.inbound ? "Zuper's changes are applied to Tuper as they arrive." : "Off: Zuper's webhooks are stored and held, then applied when this is on again. Nothing is lost."} />
          <div className={`sub${s.inbound ? "" : " muted-block"}`}>
            <Switch checked={s.replay} onChange={(v) => patch({ replay: v })} disabled={!s.inbound}
              label="Retry failed deliveries" about="Every 2 minutes, up to 5 tries each." />
            <Switch checked={s.sweep.enabled} onChange={(v) => patch({ sweep: { ...s.sweep, enabled: v } })} disabled={!s.inbound}
              label="Sweep for missed changes" about="Re-reads what Zuper changed recently, for webhooks that never arrived." />
            <label className="field">
              <span>Sweep every</span>
              <Choice value={s.sweep.everyMinutes} options={[15, 30, 60, 120, 240]}
                onChange={(v) => patch({ sweep: { ...s.sweep, everyMinutes: v } })} format={minutes} />
            </label>
          </div>
        </section>

        <section className="card">
          <header className="card-head">
            <h2><span className="src tuper">Tuper</span> → <span className="src zuper">Zuper</span></h2>
            <p className="note">Changes made in Tuper arrive as Tuper&apos;s webhooks and are queued, then planned against Zuper&apos;s record and sent.</p>
          </header>
          <Switch checked={pushOn} onChange={(v) => push({ mode: v ? "dry-run" : "off" })}
            label="Push to Zuper"
            about={pushOn ? "Tuper's changes are queued and planned." : "Off: Tuper's changes are recorded, not queued, and nothing is sent."} />
          <div className={`sub${pushOn ? "" : " muted-block"}`}>
            <div className="segmented" role="radiogroup" aria-label="What happens to Tuper's changes">
              <label className={s.push.mode !== "live" ? "on" : ""}>
                <input type="radio" name="pushModeUi" value="dry-run" disabled={!pushOn} checked={s.push.mode !== "live"} onChange={() => push({ mode: "dry-run" })} />
                Plan only <span className="note">shown on To Zuper, nothing sent</span>
              </label>
              <label className={s.push.mode === "live" ? "on live" : ""}>
                <input type="radio" name="pushModeUi" value="live" disabled={!pushOn} checked={s.push.mode === "live"} onChange={() => push({ mode: "live" })} />
                Send to Zuper <span className="note">live</span>
              </label>
            </div>
            <fieldset className="kinds" disabled={!pushOn}>
              <legend>Sent when live</legend>
              {PUSHABLE.map((k) => (
                <label key={k.key} className="check">
                  <input type="checkbox" checked={s.push.entities.includes(k.key)}
                    onChange={(e) => push({ entities: e.target.checked ? [...s.push.entities, k.key] : s.push.entities.filter((x) => x !== k.key) })} />
                  {k.label}
                </label>
              ))}
              <p className="note">Not built yet, so never sent: {NOT_PUSHABLE.join(", ")}.</p>
            </fieldset>
            <Switch checked={s.push.deletes} onChange={(v) => push({ deletes: v })} disabled={!pushOn}
              label="Delete in Zuper when deleted in Tuper" about="Jobs only. A deletion in Zuper cannot be undone there." />
            <label className="field">
              <span>When both sides changed the same field</span>
              <select value={s.push.onConflict} disabled={!pushOn} onChange={(e) => push({ onConflict: e.target.value as Settings["push"]["onConflict"] })}>
                <option value="zuper-wins">Zuper wins — leave Zuper as it is</option>
                <option value="tuper-wins">Tuper wins — send it anyway</option>
              </select>
            </label>
            <label className="field">
              <span>Don&apos;t send changes older than</span>
              <Choice value={s.push.maxAgeMinutes} options={[30, 120, 360, 1440]}
                onChange={(v) => push({ maxAgeMinutes: v })} format={minutes} />
            </label>
          </div>
        </section>
      </div>

      <section className="card">
        <header className="card-head">
          <h2>API call log</h2>
          <p className="note">Every call to Zuper&apos;s API and Tuper&apos;s, for the API calls and To Tuper pages. Headers are never kept.</p>
        </header>
        <div className="row-fields">
          <Switch checked={s.apiLog.enabled} onChange={(v) => patch({ apiLog: { ...s.apiLog, enabled: v } })} label="Record API calls" />
          <label className="field">
            <span>Keep request and response bodies</span>
            <Choice value={s.apiLog.bodyHours} options={[24, 48, 168]}
              onChange={(v) => patch({ apiLog: { ...s.apiLog, bodyHours: v } })} format={(h) => minutes(h * 60)} />
          </label>
          <label className="field">
            <span>Keep the calls</span>
            <Choice value={s.apiLog.days} options={[3, 7, 14, 30]}
              onChange={(v) => patch({ apiLog: { ...s.apiLog, days: v } })} format={(d) => minutes(d * 1440)} />
          </label>
        </div>
      </section>

      <div className={`savebar${dirty ? " dirty" : ""}`}>
        <span className="savebar-text">
          {dirty ? "Unsaved changes" : `Version ${base.version} — no changes`}
          {state && !state.ok ? <span className="outcome bad"> {state.message}</span> : null}
        </span>
        <button type="button" className="btn" disabled={!dirty || pending} onClick={reload}>Discard</button>
        <button type="submit" className="btn primary" disabled={!dirty || pending}>{pending ? "Saving…" : "Save and apply"}</button>
      </div>
    </form>
  );
}
