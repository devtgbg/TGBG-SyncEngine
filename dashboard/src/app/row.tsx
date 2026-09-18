"use client";

/**
 * The small interactive pieces around the delivery detail.
 *
 * The detail itself is a server component, opened by `?open=<id>` in the URL, so
 * it is rendered behind the sign-in with everything else, survives the live
 * refresh, and can be linked to. These only move the URL.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/** A table row that opens its delivery. Keyboard: Tab to the row, Enter to open. */
export function Row({ href, className, label = "Open this delivery", children }: { href: string; className?: string; label?: string; children: React.ReactNode }) {
  const router = useRouter();
  const open = () => {
    // Dragging across a row to copy a uid is not a click on it.
    if (window.getSelection()?.toString()) return;
    router.push(href, { scroll: false });
  };
  return (
    <tr
      className={className}
      tabIndex={0}
      role="link"
      aria-label={label}
      onClick={open}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); open(); } }}
    >
      {children}
    </tr>
  );
}

/** Escape closes the detail, as anyone would expect of a panel laid over a page. */
export function EscapeTo({ href }: { href: string }) {
  const router = useRouter();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") router.push(href, { scroll: false }); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [href, router]);
  return null;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch { /* clipboard blocked: the text is on the page and can be selected */ }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}
