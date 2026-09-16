/**
 * The three pure helpers the sync engine borrows from JMS.
 *
 * In JMS these live in `list-contract/attachments.ts` and `tenant-dates.ts`,
 * next to code this service has no use for — uploads, virus scanning, EXIF
 * parsing, the tenant timezone tables. Importing those modules dragged ClamAV
 * and an image parser into a service whose only job is to upsert rows, so the
 * three functions actually reached are reproduced here.
 *
 * These are EXTRACTED VERBATIM by script from the JMS sources, not retyped.
 * If JMS changes them, re-extract. Do not "improve" them here: cleanFileName in
 * particular strips bidi-override characters, which is a filename-spoofing
 * defence, and preserves the extension when it truncates.
 */

// ── from list-contract/attachments.ts ──
export const kindOf = (mime: string) => (mime.startsWith("image/") ? "photo" : mime.startsWith("video/") ? "video" : "file");

export function cleanFileName(n: string): string {
  const base = n.split(/[\\/]/).pop() ?? "";
  const tidy = base.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim().replace(/^\.+/, "").trim();
  if (!tidy) return "file";
  if (tidy.length <= 200) return tidy;
  const dot = tidy.lastIndexOf("."), ext = dot > 0 && tidy.length - dot <= 12 ? tidy.slice(dot) : "";
  return tidy.slice(0, 200 - ext.length) + ext;
}

// ── from tenant-dates.ts ──
export const addDays = (ymd: string, n: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
