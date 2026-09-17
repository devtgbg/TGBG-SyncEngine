import type { Delivery } from "./db";

export type Tone = "ok" | "warn" | "bad" | "muted";

/** What became of a delivery, in the words the log uses everywhere. */
export function outcome(d: Delivery): { label: string; tone: Tone } {
  if (!d.verified) return { label: d.verify_reason ?? "refused", tone: "bad" };
  if (d.process_error) {
    // A deliberate skip is recorded as an error string but is not a failure.
    if (d.process_error.startsWith("skipped:")) return { label: "not synced", tone: "muted" };
    return { label: d.process_error, tone: "bad" };
  }
  if (d.processed_at) return { label: d.sync_entity ?? "applied", tone: "ok" };
  return { label: "waiting", tone: "warn" };
}
