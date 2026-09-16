// Rich-text descriptions (Zuper's job description editor). Zuper keeps two forms of a description: the editor's HTML
// (job_description) and plain text (plain_text_description). Tuper stores the HTML in description_html and the plain
// text in description, which notifications, job cards and the customer portal read.
//
// sanitizeRichText is an allowlist: only the editor's own tags survive, and with no attributes at all, so pasted or
// hand-written markup can't carry scripts, event handlers or styles. Two exceptions: a link's address, kept only when
// it's a web or email one (http, https, mailto) and always opening in a new tab — any other link is just its text; and
// a highlight (Zuper's Background color), a span keeping only a background-color that is a plain #hex or rgb() colour,
// written as TinyMCE writes it ("background-color: #BFEDD2;") — any other span is just its text. Tables keep their
// rows and cells but none of their attributes (the view draws Zuper's 1px #ccc lines). Everything that isn't an allowed
// tag comes out as escaped text. No DOM needed, so the server and the browser clean the same way.

const ALLOWED = new Set(["p", "br", "b", "strong", "i", "em", "u", "s", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "table", "thead", "tbody", "tr", "th", "td", "a", "span"]);
// Elements dropped together with everything inside them.
const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|noscript|template|textarea|title|head|svg|math|select)\b[\s\S]*?<\/\1\s*>/gi;
const TAG = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;

const escapeText = (s: string) => s.replace(/&(?!(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapePlain = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => escapePlain(s).replace(/"/g, "&quot;");

const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
/** A link's address when it's a web or email one — never javascript:, data: or the like, however it's disguised with
 *  entities, spaces or control characters. */
function safeHref(tag: string): string | null {
  const m = HREF.exec(tag);
  if (!m) return null;
  const bare = decode(m[1] ?? m[2] ?? m[3] ?? "").replace(/[\t\n\r]+/g, "").replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "");
  return /^(https?:\/\/|mailto:)/i.test(bare) ? bare : null;
}
const linkOpen = (href: string) => `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">`;

const STYLE = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0|1|0?\.\d+|1\.0+)\s*)?\)$/i;
/** A highlight's colour as "#RRGGBB" — only a plain hex or opaque rgb() background-color; nothing else of the style. */
function safeBackground(tag: string): string | null {
  const m = STYLE.exec(tag);
  if (!m) return null;
  let colour: string | null = null;
  for (const decl of decode(m[1] ?? m[2] ?? "").split(";")) {
    const at = decl.indexOf(":");
    if (at > 0 && decl.slice(0, at).trim().toLowerCase() === "background-color") colour = decl.slice(at + 1).trim();
  }
  if (!colour) return null;
  if (HEX.test(colour)) {
    const h = colour.slice(1);
    return `#${(h.length === 3 ? h.split("").map((c) => c + c).join("") : h).toUpperCase()}`;
  }
  const rgb = RGB.exec(colour);
  if (!rgb || (rgb[4] !== undefined && Number(rgb[4]) < 1)) return null; // see-through is no highlight
  const parts = [rgb[1], rgb[2], rgb[3]].map(Number);
  if (parts.some((n) => n > 255)) return null;
  return `#${parts.map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

export function sanitizeRichText(input: unknown): string {
  const html = String(input ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(DROP_WITH_CONTENT, "");
  const out: string[] = [];
  // Open tags; "~span" is a span that was left out (its text kept), so its closing tag closes nothing else.
  const open: string[] = [];
  const close = (name: string) => (name.startsWith("~") ? "" : `</${name}>`);
  let last = 0;
  for (const m of html.matchAll(TAG)) {
    out.push(escapeText(html.slice(last, m.index)));
    last = (m.index ?? 0) + m[0].length;
    const name = m[1].toLowerCase();
    if (!ALLOWED.has(name)) continue;
    if (name === "br") { out.push("<br>"); continue; }
    const opening = m[0][1] !== "/";
    if (name === "a" && opening) {
      // A link keeps only a web or email address and opens in a new tab; any other link is just its text.
      const href = safeHref(m[0]);
      if (href) { out.push(linkOpen(href)); open.push("a"); }
      continue;
    }
    if (name === "span" && opening) {
      // A highlight keeps only its colour; any other span is just its text.
      const bg = safeBackground(m[0]);
      if (bg) { out.push(`<span style="background-color: ${bg};">`); open.push("span"); } else open.push("~span");
      continue;
    }
    if (opening) { out.push(`<${name}>`); open.push(name); continue; }
    // A closing tag closes back to its opener; one with no opener is dropped.
    const at = name === "span" ? Math.max(open.lastIndexOf("span"), open.lastIndexOf("~span")) : open.lastIndexOf(name);
    if (at === -1) continue;
    while (open.length > at) out.push(close(open.pop()!));
  }
  out.push(escapeText(html.slice(last)));
  while (open.length) out.push(close(open.pop()!));
  return out.join("").trim();
}

const NAMED: Record<string, string> = { nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
const decode = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
  .replace(/&(nbsp|lt|gt|quot|apos|amp);/g, (_, e: string) => NAMED[e]);

/** The plain text of a rich description: paragraphs and line breaks as new lines, list items as bullets. */
export function richTextToPlain(html: unknown): string {
  return decode(String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|ul|ol|table)>/gi, "\n")
    .replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Whether a stored description is the editor's HTML rather than plain text (every imported one is plain). */
export const looksLikeRichText = (s: unknown) => /<\/?(p|br|strong|b|em|i|u|s|ul|ol|li|h[1-6]|blockquote|table|a|span)\b/i.test(String(s ?? ""));

const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
/** Pasted plain text as editor HTML: a web address becomes a link, as Zuper's editor makes it, and a new line a break.
 *  Punctuation right after an address isn't part of it; a bare www. address links to https. */
export function plainPasteToRichText(text: unknown): string {
  return String(text ?? "").split(/(\r?\n)/).map((part) => {
    if (/^\r?\n$/.test(part)) return "<br>";
    let out = "", last = 0;
    for (const m of part.matchAll(URL_IN_TEXT)) {
      const url = m[0].replace(/[.,;:!?)\]]+$/, "");
      out += escapePlain(part.slice(last, m.index)) + linkOpen(/^www\./i.test(url) ? `https://${url}` : url) + escapePlain(url) + "</a>";
      last = (m.index ?? 0) + url.length;
    }
    return out + escapePlain(part.slice(last));
  }).join("");
}

/** Plain text as editor HTML: one paragraph per line. */
export function plainToRichText(text: unknown): string {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  if (lines.length === 1 && !lines[0]) return "";
  return lines.map((l) => `<p>${escapeText(l) || "<br>"}</p>`).join("");
}
