/**
 * Settings: which way the engine syncs, and how.
 *
 * The form saves a new version of the settings; the engine reads it within 5 seconds and reports back the version it
 * has applied. The status line says which: saved and applied, saved and waiting, or the engine not reporting at all.
 */

import { engine, getSettings, liveness, settingsHistory } from "@/lib/control";
import { changes, DIRECTION, directionOf } from "@/lib/engine";
import { dubaiTime } from "@/lib/describe";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  let error: string | null = null;
  let row: Awaited<ReturnType<typeof getSettings>> = null;
  let eng: Awaited<ReturnType<typeof engine>> = null;
  let history: Awaited<ReturnType<typeof settingsHistory>> = [];
  try {
    [row, eng, history] = await Promise.all([getSettings(), engine(), settingsHistory()]);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    error = e?.code === "42P01" ? null : e?.message ?? String(err);
  }
  const live = liveness(eng);
  const applied = row && eng?.applied_version === row.version;

  return (
    <main>
      <header className="head">
        <h1>Settings</h1>
        <p>How the sync engine runs. Changes apply to the running engine within seconds — no redeploy.</p>
      </header>

      {error ? <p className="error">Could not read the settings: {error}</p> : !row ? (
        <p className="pinned">The engine creates its settings the first time it starts with this version, from the deployment&apos;s environment. It has not done that yet.</p>
      ) : (
        <>
          <div className={`applied-line ${applied ? "ok" : live.state === "online" ? "warn" : "bad"}`} role="status">
            <span className={`dot ${applied ? "ok" : live.state === "online" ? "warn" : "bad"}`} aria-hidden="true" />
            <span>
              <strong>{DIRECTION[directionOf(row.data)].label}</strong>
              {" · "}version {row.version}, saved {dubaiTime(row.updated_at)}{row.updated_by ? ` by ${row.updated_by}` : ""}
              {" · "}
              {applied ? <>applied by the engine {eng?.applied_at ? dubaiTime(eng.applied_at) : ""}</>
                : live.state === "online" ? <>waiting for the engine to apply it (it is on version {eng?.applied_version ?? "—"})</>
                : <>{live.label.toLowerCase()} — it applies this when it is back</>}
            </span>
          </div>

          <SettingsForm initial={row.data} version={row.version} />

          <section className="card">
            <header className="card-head"><h2>Changes</h2></header>
            {history.length ? (
              <ol className="history">
                {history.map((h) => (
                  <li key={h.version}>
                    <span className="mono dim">v{h.version}</span>
                    <span>{changes(h.before, h.after).join(" · ")}</span>
                    <span className="dim">{dubaiTime(h.at)}{h.by ? ` · ${h.by}` : ""}</span>
                  </li>
                ))}
              </ol>
            ) : <p className="dim">No changes yet.</p>}
          </section>
        </>
      )}
    </main>
  );
}
