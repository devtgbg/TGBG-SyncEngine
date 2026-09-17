/**
 * Pages of rows, for both logs.
 *
 * Page 1 is the live head of the log. Every link to an older page carries `upto`,
 * the timestamp of the newest row when the link was rendered, and the query then
 * ignores anything newer. Without it the offsets slide: each delivery that arrives
 * pushes every row down by one, and someone reading page 3 watches it move under
 * them. With it an older page holds still, while the rows on it still show their
 * current outcome.
 */

export const SIZES = [25, 50, 100] as const;
export const DEFAULT_SIZE = 50;

/** A timestamp exactly as PostgREST prints one. Anything else is ignored, never passed to the query. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

export interface Paging { page: number; size: number; offset: number; upto?: string }

export function readPaging(sp: { page?: string; size?: string; upto?: string }): Paging {
  const size = (SIZES as readonly number[]).includes(Number(sp.size)) ? Number(sp.size) : DEFAULT_SIZE;
  const page = Math.min(100_000, Math.max(1, Math.floor(Number(sp.page)) || 1));
  const upto = page > 1 && sp.upto && TIMESTAMP.test(sp.upto) ? sp.upto : undefined;
  return { page, size, offset: (page - 1) * size, upto };
}

/** 1 … 4 5 [6] 7 8 … 17: the ends, and two either side of where you are. */
function pageList(page: number, last: number): (number | "gap")[] {
  const keep = [...new Set([1, last, page - 2, page - 1, page, page + 1, page + 2])]
    .filter((p) => p >= 1 && p <= last).sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  for (const p of keep) {
    const prev = out[out.length - 1];
    if (typeof prev === "number" && p - prev > 1) out.push("gap");
    out.push(p);
  }
  return out;
}

const query = (keep: Record<string, string | undefined>, size: number) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(keep)) if (v) q.set(k, v);
  if (size !== DEFAULT_SIZE) q.set("size", String(size));
  return q;
};

export function Pager({ base, keep, paging, total, shown, anchor }: {
  /** The page's own path: "/" or "/pushes". */
  base: string;
  /** The filter in force, which every link must keep. */
  keep: Record<string, string | undefined>;
  paging: Paging;
  total: number;
  /** Rows actually on this page. */
  shown: number;
  /** What older pages are pinned to: this page's own `upto`, or on page 1 its newest row. */
  anchor?: string;
}) {
  const { page, size } = paging;
  const last = Math.max(1, Math.ceil(total / size));

  const href = (p: number, s: number = size) => {
    const q = query(keep, s);
    if (p > 1) {
      q.set("page", String(p));
      if (anchor) q.set("upto", anchor);
    }
    const qs = q.toString();
    return qs ? `${base}?${qs}` : base;
  };

  const from = paging.offset + 1;
  const to = paging.offset + shown;

  return (
    <nav className="pager" aria-label="Pages">
      <span className="range">
        {shown ? <>{from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}</> : <>0 of {total.toLocaleString()}</>}
      </span>

      {last > 1 || page > 1 ? (
        <span className="pages">
          {page > 1 ? <a href={href(Math.min(page - 1, last))} rel="prev">‹ Newer</a> : <span className="off">‹ Newer</span>}
          {pageList(Math.min(page, last), last).map((p, i) =>
            p === "gap" ? <span key={`gap-${i}`} className="gap">…</span>
              : p === page ? <b key={p} aria-current="page">{p}</b>
              : <a key={p} href={href(p)}>{p}</a>)}
          {page < last ? <a href={href(page + 1)} rel="next">Older ›</a> : <span className="off">Older ›</span>}
        </span>
      ) : null}

      <span className="sizes">
        Rows
        {SIZES.map((s) => (s === size ? <b key={s}>{s}</b> : <a key={s} href={href(1, s)}>{s}</a>))}
      </span>
    </nav>
  );
}

const dubai = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Says why an older page is not moving, and how to get back to the part that is. */
export function Pinned({ upto, base, keep, size }: { upto?: string; base: string; keep: Record<string, string | undefined>; size: number }) {
  if (!upto) return null;
  const qs = query(keep, size).toString();
  return (
    <p className="pinned">
      Rows up to {dubai(upto)} (Dubai). Anything newer arrives on the <a href={qs ? `${base}?${qs}` : base}>newest page</a> and does not shift this one.
    </p>
  );
}
