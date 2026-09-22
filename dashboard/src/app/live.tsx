"use client";

/**
 * Keeps an open page current without a reload.
 *
 * The pages are server components, so "live" is: ask /api/pulse every few
 * seconds whether the newest rows changed, and only then router.refresh(), which
 * re-runs the server queries and patches the result into the page in place. The
 * filter, the scroll position and any opened request body stay as they were.
 *
 * Supabase Realtime would push instead of poll, but it needs a key in the
 * browser and row-level policies on tables that hold customer data. Here every
 * read stays on the server, behind the sign-in.
 */

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

const POLL_MS = 3_000;
const RETRY_MS = 10_000;
/** A change outside the newest 100 rows does not move the pulse; this picks it up. */
const FULL_REFRESH_MS = 60_000;

type State = "live" | "offline";

export function LiveRefresh() {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<State>("live");
  const [blip, setBlip] = useState(0);
  const seen = useRef<string | null>(null);

  useEffect(() => {
    // Each page asks about what it shows.
    const view = pathname.startsWith("/pushes") ? "pushes" : pathname.startsWith("/calls") ? "calls" : pathname.startsWith("/tuper") ? "writes"
      : pathname.startsWith("/webhooks") ? "deliveries" : pathname.startsWith("/settings") ? "settings"
      : pathname.startsWith("/connections") ? "connections" : "overview";
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastFull = Date.now();
    seen.current = null;

    const check = async () => {
      if (stopped) return;
      let delay = POLL_MS;
      if (document.visibilityState === "visible") {
        const ctl = new AbortController();
        const giveUp = setTimeout(() => ctl.abort(), 8_000);
        try {
          const res = await fetch(`/api/pulse?view=${view}`, { cache: "no-store", signal: ctl.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const { v } = (await res.json()) as { v: string };
          const changed = seen.current !== null && seen.current !== v;
          seen.current = v;
          if (changed || Date.now() - lastFull >= FULL_REFRESH_MS) {
            lastFull = Date.now();
            router.refresh();
            if (changed) setBlip((n) => n + 1);
          }
          setState("live");
        } catch {
          setState("offline");
          delay = RETRY_MS;
        } finally {
          clearTimeout(giveUp);
        }
      }
      if (!stopped) timer = setTimeout(check, delay);
    };

    // A tab left in the background does not poll; coming back to it checks at once.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      void check();
    };

    timer = setTimeout(check, POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pathname, router]);

  return (
    <span
      className={`live ${state}`}
      role="status"
      title={state === "live" ? "Updates on its own: checks for changes every 3 seconds." : "Cannot reach the server. Retrying every 10 seconds."}
    >
      {/* Re-keyed on each applied change, so the dot's animation restarts. */}
      <i key={blip} className={blip ? "blip" : ""} />
      {state === "live" ? "Live" : "Reconnecting…"}
    </span>
  );
}

// ── Relative times that keep counting ────────────────────────────────────────

const format = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/** One timer for every <Ago> on the page, however many rows there are. */
const listeners = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;
function onTick(fn: () => void): () => void {
  listeners.add(fn);
  if (!ticker) ticker = setInterval(() => listeners.forEach((f) => f()), 1_000);
  return () => {
    listeners.delete(fn);
    if (!listeners.size && ticker) { clearInterval(ticker); ticker = null; }
  };
}

/**
 * `initial` is the label the server rendered, so the first client render matches
 * the HTML exactly; after that the label is computed here, once a second.
 */
export function Ago({ iso, initial }: { iso: string; initial: string }) {
  const [label, setLabel] = useState(initial);
  useEffect(() => {
    setLabel(format(iso));
    return onTick(() => setLabel(format(iso)));
  }, [iso]);
  return <>{label}</>;
}
