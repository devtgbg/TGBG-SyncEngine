"use client";

/**
 * A button that asks the engine to do something, and says what became of the last time it was asked.
 *
 * The button only writes a request (src/app/actions.ts); the engine carries it out within seconds and records the
 * outcome, which reaches this component through the page's live refresh. So the outcome shown is the engine's own
 * word, not the button's guess.
 */

import { useActionState } from "react";
import { commandAction, type ActionResult } from "./actions";
import type { Command } from "@/lib/control";

const time = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function CommandButton({ command, label, confirm, disabled, latest, hint, tone }: {
  command: string;
  label: string;
  /** Asked before sending: for anything that changes or removes something. */
  confirm?: string;
  disabled?: boolean;
  latest?: Command;
  hint?: string;
  tone?: "primary" | "danger";
}) {
  const [state, act, pending] = useActionState<ActionResult | null, FormData>(commandAction, null);
  const waiting = latest && !latest.finished_at;
  return (
    <form
      action={act}
      className="command"
      onSubmit={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }}
    >
      <input type="hidden" name="command" value={command} />
      <button type="submit" className={`btn ${tone ?? ""}`} disabled={disabled || pending || !!waiting}>
        {pending ? "Asking…" : waiting ? (latest!.started_at ? "Running…" : "Waiting for the engine…") : label}
      </button>
      {hint ? <span className="note">{hint}</span> : null}
      {state && !state.ok ? <span className="outcome bad">{state.message}</span> : null}
      {latest?.finished_at ? (
        <span className={`outcome ${latest.ok ? "ok" : "bad"}`} title={latest.result ?? undefined}>
          {latest.ok ? "✓" : "✗"} {latest.result} <span className="dim">· {time(latest.finished_at)}{latest.requested_by ? ` · ${latest.requested_by}` : ""}</span>
        </span>
      ) : null}
    </form>
  );
}
