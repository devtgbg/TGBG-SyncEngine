/**
 * Two answers to the same question, field by field.
 *
 * `npm run compare -- --fields` reads one record from Zuper and the same record from Tuper and asks what is
 * different. This file is the part that decides — pure, no I/O, so it can be reasoned about and tested on its own.
 *
 * It is a measuring instrument, so its first duty is not to lie. Two systems can write the same fact differently
 * without disagreeing about it: `"0.00"` and `0`, `"2026-09-18T06:00:00.000Z"` and `"2026-09-18T06:00:00Z"`,
 * `null` and `""`, the same five assignees in a different order. None of those is a difference, and reporting them
 * as one would bury the handful that are. Equally, where a difference COULD be an artefact — two records of an
 * array that carry no key to pair them by, an id that each system is entitled to answer differently, a date with
 * no time against a timestamp — the difference is still reported, but marked `uncertain` with the reason, so a
 * reader knows which findings to trust without re-checking them all.
 *
 * Every difference carries a `class`:
 *
 *   certain
 *     value               both sides have the field, the values disagree
 *     missing_in_tuper    Zuper sends it with something in it, Tuper does not send it
 *     extra_in_tuper      Tuper sends it with something in it, Zuper does not send it
 *     array_length        an array both sides send has a different number of records, and they cannot be paired
 *     element_missing     an array record Zuper has (matched by its uid) is not in Tuper's array
 *     element_extra       the other way round
 *
 *   uncertain — reported, but flagged, because the comparison itself cannot settle it
 *     id                  both are opaque identifiers and they differ; Tuper answers its own where Zuper has none
 *     url_host            the same path on a different host (zuperpro.com vs tuper.golfbuggyguy.com)
 *     markup              the same words, different HTML
 *     date_precision      a date against a timestamp of that date — the time of day is unknown, not wrong
 *     positional          inside an array whose records carry no key, so the pairing is by order
 *     empty_field         one side omits a field the other sends empty (null, "", [], {})
 *
 *   noted, not a difference (counted, never listed as a finding)
 *     same_instant        the same moment, written differently
 *     same_number         the same number, written differently
 *     same_boolean        the same flag, one as a string or 0/1
 *     empty_shape         both empty, differently (null vs "")
 *     whitespace          the same text, different spacing or case
 */

export type DiffClass =
  | "value" | "missing_in_tuper" | "extra_in_tuper" | "array_length" | "element_missing" | "element_extra"
  | "id" | "url_host" | "markup" | "date_precision" | "positional" | "empty_field"
  | "same_instant" | "same_number" | "same_boolean" | "empty_shape" | "whitespace";

/** The classes a reader should act on. Everything else is either expected or unprovable from here. */
export const CERTAIN: DiffClass[] = ["value", "missing_in_tuper", "extra_in_tuper", "array_length", "element_missing", "element_extra"];
/** Real disagreements the comparison cannot settle on its own. */
export const UNCERTAIN: DiffClass[] = ["id", "url_host", "markup", "date_precision", "positional", "empty_field"];
/** The same fact, written differently. Counted so a run can show its own work; never a finding. */
export const AGREEMENT: DiffClass[] = ["same_instant", "same_number", "same_boolean", "empty_shape", "whitespace"];

export interface Diff {
  /** Where, with array indexes collapsed: `assigned_to[].user.user_uid`. */
  path: string;
  class: DiffClass;
  zuper?: unknown;
  tuper?: unknown;
  /** Why this one cannot be trusted as a plain difference, when it cannot. */
  note?: string;
}

/** A uid, or the 24-character Mongo id Zuper answers for the records it keeps there (`_id`). */
const OPAQUE_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24})$/i;
const ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const NUMERIC = /^-?\d+(\.\d+)?$/;
const HAS_TAGS = /<[a-z!/][^>]*>/i;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Nothing there: the four ways two systems write "no value". */
const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (isObject(v) && Object.keys(v).length === 0);

/** `null`, `""` and `[]` are the same absence; this is how they are told apart when both sides are empty. */
const emptyShape = (v: unknown): string =>
  v === undefined ? "absent" : v === null ? "null" : v === "" ? '""' : Array.isArray(v) ? "[]" : "{}";

const cut = (v: unknown, n = 120): unknown => {
  if (typeof v === "string") return v.length > n ? `${v.slice(0, n)}…` : v;
  if (v === null || typeof v !== "object") return v;
  const json = JSON.stringify(v) ?? "";
  return json.length > n ? `${json.slice(0, n)}…` : JSON.parse(json);
};

const stripTags = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** A name that holds a machine identifier rather than a fact about the record. */
const idPath = (path: string): boolean => /(^|[.[\]])(uid|id|_uid|_id)$/i.test(path) || /_(uid|id)$/i.test(path.split(".").pop() ?? "");

/**
 * The name of the field an array's records can be paired by, so a re-ordered array is not a difference.
 * It must identify a record on BOTH sides — unique within each array, and present in every record of each —
 * or two arrays holding the same records would be reported as one array missing them and the other inventing them.
 */
const ELEMENT_KEYS = ["uid", "id", "key", "name", "field_name", "label", "email", "type"];
/** `user.user_uid` as well as `user_uid`: an assignee's identity is one level down, not on the record itself. */
const at = (row: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (isObject(o) ? o[k] : undefined), row);
function uniqueIn(rows: Record<string, unknown>[], path: string): boolean {
  if (!rows.length) return true;
  const values = rows.map((r) => at(r, path));
  if (values.some((v) => v === null || v === undefined || v === "" || typeof v === "object")) return false;
  return new Set(values.map((v) => String(v))).size === rows.length;
}
function elementKey(zRows: Record<string, unknown>[], tRows: Record<string, unknown>[]): string | null {
  const sample = (zRows[0] ?? tRows[0]) as Record<string, unknown> | undefined;
  if (!sample) return null;
  const names = Object.keys(sample);
  const nested = names.filter((n) => isObject(sample[n]))
    .flatMap((n) => Object.keys(sample[n] as Record<string, unknown>).filter((m) => /_uid$/i.test(m)).map((m) => `${n}.${m}`));
  // A `*_uid` first: it is the one thing both systems are asked to answer the same.
  const candidates = [...names.filter((n) => /_uid$/i.test(n)), ...nested, ...names.filter((n) => ELEMENT_KEYS.includes(n.toLowerCase()))];
  for (const name of candidates) if (uniqueIn(zRows, name) && uniqueIn(tRows, name)) return name;
  return null;
}

const canonical = (v: unknown): string => {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    if (isObject(x)) return Object.fromEntries(Object.keys(x).sort().map((k) => [k, walk(x[k])]));
    return x;
  };
  return JSON.stringify(walk(v)) ?? "";
};

/**
 * Two scalars. Returns null when they say the same thing outright, or the class of what separates them.
 * The order of the tests is the argument: cheapest and most certain first, guesswork last.
 */
function compareScalar(path: string, z: unknown, t: unknown): { class: DiffClass; note?: string } | null {
  if (z === t) return null;

  if (isEmpty(z) && isEmpty(t)) {
    return emptyShape(z) === emptyShape(t) ? null : { class: "empty_shape", note: `${emptyShape(z)} vs ${emptyShape(t)}` };
  }
  if (isEmpty(z) || isEmpty(t)) return { class: "value", note: isEmpty(z) ? "Zuper sends nothing here, Tuper sends a value" : "Zuper sends a value, Tuper sends nothing here" };

  // Numbers written as strings: money and quantities arrive as "0.00" from one side and 0 from the other.
  const zNum = typeof z === "number" ? z : typeof z === "string" && NUMERIC.test(z.trim()) ? Number(z) : NaN;
  const tNum = typeof t === "number" ? t : typeof t === "string" && NUMERIC.test(t.trim()) ? Number(t) : NaN;
  if (Number.isFinite(zNum) && Number.isFinite(tNum)) {
    if (Math.abs(zNum - tNum) < 1e-9) return { class: "same_number", note: `${JSON.stringify(z)} / ${JSON.stringify(t)}` };
    return { class: "value" };
  }

  // Flags: true against "true", or against 1.
  const asBool = (v: unknown): boolean | null =>
    typeof v === "boolean" ? v : v === "true" || v === 1 ? true : v === "false" || v === 0 ? false : null;
  if (typeof z === "boolean" || typeof t === "boolean") {
    const zb = asBool(z), tb = asBool(t);
    if (zb !== null && tb !== null) return zb === tb ? { class: "same_boolean" } : { class: "value" };
  }

  if (typeof z !== "string" || typeof t !== "string") return { class: "value" };
  const zs = z.trim(), ts = t.trim();
  if (zs === ts) return { class: "whitespace" };

  // The same moment written two ways is not a difference. A date with no time against a timestamp of that date is
  // not provably one either: the time of day was never in the first answer.
  if (ISO.test(zs) && ISO.test(ts)) {
    const zd = Date.parse(DATE_ONLY.test(zs) ? `${zs}T00:00:00Z` : zs);
    const td = Date.parse(DATE_ONLY.test(ts) ? `${ts}T00:00:00Z` : ts);
    if (Number.isFinite(zd) && Number.isFinite(td)) {
      if (zd === td) return { class: "same_instant" };
      if (DATE_ONLY.test(zs) !== DATE_ONLY.test(ts) && zs.slice(0, 10) === ts.slice(0, 10)) {
        return { class: "date_precision", note: "one side answers a date, the other a timestamp on that date — the time of day cannot be checked from here" };
      }
      return { class: "value" };
    }
  }

  if (/^https?:\/\//i.test(zs) && /^https?:\/\//i.test(ts)) {
    try {
      const zu = new URL(zs), tu = new URL(ts);
      if (zu.host !== tu.host) {
        return zu.pathname === tu.pathname
          ? { class: "url_host", note: `${zu.host} vs ${tu.host} — the same path on each system's own host` }
          : { class: "url_host", note: `different host AND path: ${zu.host}${zu.pathname} vs ${tu.host}${tu.pathname}` };
      }
    } catch { /* not a URL after all */ }
  }

  // Two opaque identifiers in a field named as one. Tuper answers its own uid where a record has no Zuper one, and
  // its own row id where Zuper answers a Mongo id it never shared — neither is provably wrong from out here.
  if (OPAQUE_ID.test(zs) && OPAQUE_ID.test(ts)) {
    return idPath(path)
      ? { class: "id", note: "both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct" }
      : { class: "value", note: "two different identifiers in a field that is not named as an id" };
  }

  if (HAS_TAGS.test(zs) || HAS_TAGS.test(ts)) {
    if (stripTags(zs) === stripTags(ts)) return { class: "markup", note: "the same words, different HTML" };
  }
  if (squash(zs).toLowerCase() === squash(ts).toLowerCase()) return { class: "whitespace", note: "same text, different spacing or case" };

  return { class: "value" };
}

interface WalkCtx { out: Diff[]; positional: boolean; seen: Set<string>; depth: number }

/** One difference per path per class per record, so a 40-line array cannot drown the report in one field. */
function emit(ctx: WalkCtx, d: Diff) {
  const key = `${d.path}\u0000${d.class}`;
  if (ctx.seen.has(key)) return;
  ctx.seen.add(key);
  if (ctx.positional && CERTAIN.includes(d.class)) {
    ctx.out.push({ ...d, class: "positional", note: `${d.class}${d.note ? `: ${d.note}` : ""} — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact` });
    return;
  }
  ctx.out.push(d);
}

/** Zuper's answer against Tuper's, one path at a time. */
function walk(path: string, z: unknown, t: unknown, ctx: WalkCtx) {
  if (ctx.depth > 12) return;
  const zHas = z !== undefined, tHas = t !== undefined;

  if (zHas && !tHas) {
    return emit(ctx, isEmpty(z)
      ? { path, class: "empty_field", zuper: cut(z), note: "Zuper sends this field empty; Tuper leaves it out — nothing is lost, but a client reading the key sees undefined" }
      : { path, class: "missing_in_tuper", zuper: cut(z) });
  }
  if (!zHas && tHas) {
    return emit(ctx, isEmpty(t)
      ? { path, class: "empty_field", tuper: cut(t), note: "Tuper sends this field empty; Zuper leaves it out. Zuper drops empty keys in places, so this is usually Tuper being the more complete of the two" }
      : { path, class: "extra_in_tuper", tuper: cut(t) });
  }
  if (!zHas && !tHas) return;

  if (Array.isArray(z) && Array.isArray(t)) return walkArray(path, z, t, ctx);
  if (isObject(z) && isObject(t)) {
    for (const key of new Set([...Object.keys(z), ...Object.keys(t)])) {
      walk(path ? `${path}.${key}` : key, z[key], t[key], { ...ctx, depth: ctx.depth + 1 });
    }
    return;
  }
  // One side an object or array, the other a scalar: a real shape difference unless both are empty.
  if (isObject(z) !== isObject(t) || Array.isArray(z) !== Array.isArray(t)) {
    if (isEmpty(z) && isEmpty(t)) return emit(ctx, { path, class: "empty_shape", note: `${emptyShape(z)} vs ${emptyShape(t)}` });
    return emit(ctx, { path, class: "value", zuper: cut(z), tuper: cut(t), note: "one side answers a value, the other a structure" });
  }
  const verdict = compareScalar(path, z, t);
  if (verdict) emit(ctx, { path, class: verdict.class, zuper: cut(z), tuper: cut(t), note: verdict.note });
}

function walkArray(path: string, z: unknown[], t: unknown[], ctx: WalkCtx) {
  const p = `${path}[]`;
  if (!z.length && !t.length) return;

  // Scalars: the same set in a different order is the same answer.
  if ([...z, ...t].every((v) => v === null || typeof v !== "object")) {
    const zs = z.map((v) => JSON.stringify(v)).sort(), ts = t.map((v) => JSON.stringify(v)).sort();
    if (zs.join("\u0000") !== ts.join("\u0000")) emit(ctx, { path: p, class: "value", zuper: cut(z), tuper: cut(t) });
    return;
  }

  const zRows = z.filter(isObject), tRows = t.filter(isObject);
  const key = zRows.length === z.length && tRows.length === t.length ? elementKey(zRows, tRows) : null;
  if (key) {
    const zMap = new Map(zRows.map((r) => [String(at(r, key)), r]));
    const tMap = new Map(tRows.map((r) => [String(at(r, key)), r]));
    const zLeft: unknown[] = [], tLeft: unknown[] = [];
    for (const [k, row] of zMap) {
      if (!tMap.has(k)) zLeft.push(row);
      else walk(p, row, tMap.get(k), { ...ctx, depth: ctx.depth + 1 });
    }
    for (const [k, row] of tMap) if (!zMap.has(k)) tLeft.push(row);
    // Left over on both sides and the same number of them: more likely the same records under an identifier each
    // system answers its own (`_id`) than records each system invented. Paired by order and flagged as such, rather
    // than reported as one array missing them and the other adding them.
    if (zLeft.length && zLeft.length === tLeft.length) {
      const inner: WalkCtx = { ...ctx, positional: true, depth: ctx.depth + 1 };
      const byOrder = (rows: unknown[]) => [...rows].sort((a, b) => (canonical(a) < canonical(b) ? -1 : 1));
      const zo = byOrder(zLeft), to = byOrder(tLeft);
      for (let i = 0; i < zo.length; i++) walk(p, zo[i], to[i], inner);
      return;
    }
    for (const row of zLeft) emit(ctx, { path: p, class: "element_missing", zuper: cut(row), note: `a record Zuper's array has, keyed by ${key}, that Tuper's does not` });
    for (const row of tLeft) emit(ctx, { path: p, class: "element_extra", tuper: cut(row), note: `a record Tuper's array has, keyed by ${key}, that Zuper's does not` });
    return;
  }

  // No key to pair by. If the two arrays are the same set of records, they agree; otherwise pair by sorted order
  // and mark whatever comes out of it uncertain — a difference here can be the pairing rather than the data.
  if (canonical(z) === canonical(t)) return;
  const zSorted = [...z].sort((a, b) => (canonical(a) < canonical(b) ? -1 : 1));
  const tSorted = [...t].sort((a, b) => (canonical(a) < canonical(b) ? -1 : 1));
  if (zSorted.length !== tSorted.length) {
    emit(ctx, { path: p, class: "array_length", zuper: zSorted.length, tuper: tSorted.length, note: "these array records carry no uid to pair them by, so only the count can be compared" });
    return;
  }
  const inner: WalkCtx = { ...ctx, positional: true, depth: ctx.depth + 1 };
  for (let i = 0; i < zSorted.length; i++) walk(p, zSorted[i], tSorted[i], inner);
}

/** Zuper's record against Tuper's. `root` names the top of the path, e.g. "" for the record itself. */
export function diffRecords(zuper: unknown, tuper: unknown, root = ""): Diff[] {
  const ctx: WalkCtx = { out: [], positional: false, seen: new Set(), depth: 0 };
  walk(root, zuper, tuper, ctx);
  return ctx.out;
}
