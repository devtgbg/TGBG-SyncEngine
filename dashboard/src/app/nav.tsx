"use client";

/** The pages, grouped: running the engine, then what it did. The page you are on is marked. */

import { usePathname } from "next/navigation";

const GROUPS: { label: string; links: { href: string; label: string }[] }[] = [
  { label: "Engine", links: [{ href: "/", label: "Overview" }, { href: "/connections", label: "Connections" }, { href: "/settings", label: "Settings" }] },
  { label: "Activity", links: [{ href: "/webhooks", label: "Webhooks" }, { href: "/tuper", label: "To Tuper" }, { href: "/pushes", label: "To Zuper" }, { href: "/calls", label: "API calls" }] },
];

export function NavLinks() {
  const path = usePathname();
  const on = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <nav className="site" aria-label="Pages">
      {GROUPS.map((g) => (
        <span key={g.label} className="nav-group">
          <span className="nav-label">{g.label}</span>
          {g.links.map((l) => (
            <a key={l.href} href={l.href} aria-current={on(l.href) ? "page" : undefined} className={on(l.href) ? "on" : ""}>{l.label}</a>
          ))}
        </span>
      ))}
    </nav>
  );
}
