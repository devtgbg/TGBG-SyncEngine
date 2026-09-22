import type { Metadata } from "next";
import "./globals.css";
import "./engine.css";
import { engine, getSettings, liveness } from "@/lib/control";
import { DIRECTION, directionOf } from "@/lib/engine";
import { LiveRefresh } from "./live";
import { NavLinks } from "./nav";

export const metadata: Metadata = {
  title: "Zupersync",
  description: "The Zuper ⇄ Tuper sync engine: its settings, its connections, and everything it received, wrote and sent.",
};

/** The engine's state on every page: online or not, and which way it syncs. Never fails the page. */
async function EngineBadge() {
  try {
    const [eng, row] = await Promise.all([engine(), getSettings().catch(() => null)]);
    const live = liveness(eng);
    const s = eng?.applied ?? row?.data ?? null;
    return (
      <a href="/settings" className={`engine-badge ${live.state}`} title={`${live.label}${s ? ` · ${DIRECTION[directionOf(s)].label}` : ""}`}>
        <span className={`dot ${live.state === "online" ? "ok" : live.state === "late" ? "warn" : "bad"}`} aria-hidden="true" />
        {s ? DIRECTION[directionOf(s)].short : live.label}
      </a>
    );
  } catch {
    return null;
  }
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="topbar-inner">
            <a href="/" className="brand"><span className="brand-mark" aria-hidden="true">⇄</span>Zupersync</a>
            <NavLinks />
            <span className="topbar-end">
              <EngineBadge />
              <LiveRefresh />
            </span>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
