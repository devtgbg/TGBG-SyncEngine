"use client";

/**
 * The pages, in two groups: running the engine, then what it did. A rule separates them, and the group is named for a
 * screen reader only — the names used to be printed, and a grey word beside the links read as a link that was dead.
 * The page you are on is marked.
 */

import { usePathname } from "next/navigation";

// Three groups, left to right: where you land, then the journey a change makes — it arrives as a webhook, is written
// into Tuper, waits for Zuper, and every call underneath it is logged — then how the engine is set up. Setup sits at
// the end because it is the rarest visit, and the activity pages read in the order the data actually moves.
const GROUPS: { label: string; links: { href: string; label: string }[] }[] = [
  { label: "Home", links: [{ href: "/", label: "Overview" }] },
  { label: "Activity", links: [{ href: "/webhooks", label: "Webhooks" }, { href: "/tuper", label: "To Tuper" }, { href: "/pushes", label: "To Zuper" }, { href: "/calls", label: "API calls" }] },
  { label: "Setup", links: [{ href: "/connections", label: "Connections" }, { href: "/settings", label: "Settings" }] },
];

export function NavLinks() {
  const path = usePathname();
  const on = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <nav className="site" aria-label="Pages">
      {GROUPS.map((g) => (
        <span key={g.label} className="nav-group" role="group" aria-label={g.label}>
          {g.links.map((l) => (
            <a key={l.href} href={l.href} aria-current={on(l.href) ? "page" : undefined} className={on(l.href) ? "on" : ""}>{l.label}</a>
          ))}
        </span>
      ))}
    </nav>
  );
}
