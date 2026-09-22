"use server";

/**
 * The dashboard's two writes, as server actions: saving the engine's settings, and asking the engine for a command.
 * Both run behind the same sign-in as every page (src/middleware.ts); the signed-in name is recorded against each.
 */

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requestCommand, saveSettings } from "@/lib/control";
import { normalise, PUSHABLE, type Settings } from "@/lib/engine";

/** Who is signed in: the name in the Basic credentials, or "local" under next dev, where sign-in is off. */
async function who(): Promise<string> {
  const auth = (await headers()).get("authorization") ?? "";
  const [scheme, encoded] = auth.split(" ");
  if (scheme === "Basic" && encoded) {
    try { const d = atob(encoded); return d.slice(0, d.indexOf(":")) || "dashboard"; } catch { /* fall through */ }
  }
  return process.env.NODE_ENV === "production" ? "dashboard" : "local";
}

export interface ActionResult { ok: boolean; message: string; at: number }

/** The settings form, read field by field: a missing checkbox is `false`, as an HTML form sends nothing for one. */
function fromForm(f: FormData): Settings {
  const on = (k: string) => f.get(k) === "on";
  return normalise({
    inbound: on("inbound"),
    push: {
      mode: on("push") ? (f.get("pushMode") === "live" ? "live" : "dry-run") : "off",
      entities: PUSHABLE.map((p) => p.key).filter((k) => on(`entity:${k}`)),
      deletes: on("deletes"),
      onConflict: f.get("onConflict"),
      maxAgeMinutes: Number(f.get("maxAgeMinutes")),
    },
    replay: on("replay"),
    sweep: { enabled: on("sweep"), everyMinutes: Number(f.get("sweepEvery")) },
    apiLog: { enabled: on("apiLog"), bodyHours: Number(f.get("bodyHours")), days: Number(f.get("days")) },
  });
}

export async function saveSettingsAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const expected = Number(f.get("version"));
  const data = fromForm(f);
  // Sending to Zuper with no kind of record chosen would read as "live" and send nothing: refused, with the reason.
  if (data.push.mode === "live" && !data.push.entities.length) {
    return { ok: false, message: "Choose at least one kind of record to send to Zuper, or set Tuper → Zuper to Plan only.", at: Date.now() };
  }
  try {
    const r = await saveSettings(data, expected, await who());
    revalidatePath("/", "layout");
    return r.ok
      ? { ok: true, message: `Saved as version ${r.version}. The engine applies it within 5 seconds.`, at: Date.now() }
      : { ok: false, message: r.error, at: Date.now() };
  } catch (err) {
    return { ok: false, message: `Could not save: ${err instanceof Error ? err.message : String(err)}`, at: Date.now() };
  }
}

export async function commandAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const command = String(f.get("command") ?? "");
  try {
    const r = await requestCommand(command, await who());
    revalidatePath("/", "layout");
    return r.ok ? { ok: true, message: "Asked. The engine picks it up within 5 seconds.", at: Date.now() } : { ok: false, message: r.error ?? "Not asked.", at: Date.now() };
  } catch (err) {
    return { ok: false, message: `Could not ask: ${err instanceof Error ? err.message : String(err)}`, at: Date.now() };
  }
}
