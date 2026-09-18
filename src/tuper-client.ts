/**
 * Tuper's API, shaped like the database client this service used to hold.
 *
 * The goal is a sync service with no database credentials: it talks to Zuper's API and to Tuper's, and nothing else.
 * But the knowledge of how a Zuper record becomes Tuper rows — which columns, which child tables, in which order —
 * is two thousand tested lines, and rewriting them to reach for a different kind of call would put all of that at
 * risk for no gain.
 *
 * So this is a client with the same surface as the one it replaces: `.schema("jms").from("jobs").select(…).eq(…)`
 * works as before, and returns `{ data, error }` as before, including PostgreSQL's own error codes (the importer
 * retries a 23505 by dropping the field that collided). What changes is where the call goes: Tuper's sync endpoints,
 * with an API key that carries the `sync` scope, over the same HTTPS as everything else.
 *
 * What it does NOT do, on purpose:
 *   • reach any table outside the ones Tuper allows a sync key (its own log and queue live in its own database);
 *   • set the tenant — Tuper takes that from the key;
 *   • subscribe to anything. Changes made in Tuper arrive as webhooks, like Zuper's.
 */
import { config } from "./config.js";
import { logCall } from "./api-log.js";

export interface DbError { code: string | null; message: string; details: string | null; hint: string | null }
export interface DbResult<T = any> { data: T; error: DbError | null }

type Filter = [op: string, column: string, value: unknown];
type Schema = "jms" | "core";

const TIMEOUT_MS = 60_000;

/** core.users is the one table outside jms the sync service touches; Tuper names it core_users. */
const tableName = (schema: Schema, table: string) => (schema === "core" ? `core_${table}` : table);

/** What a call to the sync endpoints does, in the words the API log is read by: "update jobs", "rpc renumber_job". */
function actionOf(path: string, body: any): string | null {
  if (path === "/api/sync/query") return `select ${body?.table ?? "?"}`;
  if (path === "/api/sync/mutate") return `${body?.op ?? "?"} ${body?.table ?? "?"}`;
  if (path === "/api/sync/rpc") return `rpc ${body?.name ?? "?"}`;
  if (path === "/api/sync/auth-user") return "create login";
  return null;
}

/** `quiet` keeps a call out of the API log: the health check runs every 30 seconds and says nothing about the sync. */
async function post(path: string, body: unknown, opts: { quiet?: boolean } = {}): Promise<DbResult> {
  const started = Date.now();
  const log = (status: number | null, ok: boolean, response: string | null, error?: string) => {
    if (!opts.quiet) logCall({ system: "tuper", method: "POST", path, action: actionOf(path, body), status, ok, started, error, request: body, response });
  };
  try {
    const res = await fetch(`${config.tuper.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": config.tuper.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* not json */ }
    // A select that finds nothing answers 404. For a `maybe` query that is the expected answer, not a failure, and the
    // log must not count every "is this record new?" lookup as one.
    const found = res.ok && parsed?.type === "success";
    const emptyMaybe = res.status === 404 && (body as { single?: string } | null)?.single === "maybe";
    log(res.status, found || emptyMaybe, text, found || emptyMaybe ? undefined : parsed?.message ?? `HTTP ${res.status}`);

    if (res.ok && parsed?.type === "success") return { data: parsed.data ?? null, error: null };
    // Tuper hands the database's own error back under `data` — the caller's retries depend on the code.
    const detail = parsed?.data ?? {};
    return {
      data: null,
      error: {
        code: detail.code ?? (res.status === 404 ? "PGRST116" : String(res.status)),
        message: parsed?.message ?? text.slice(0, 300) ?? `HTTP ${res.status}`,
        details: detail.details ?? null,
        hint: detail.hint ?? null,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? (err.name === "TimeoutError" ? `no answer from Tuper within ${TIMEOUT_MS / 1000}s` : err.message) : "request failed";
    log(null, false, null, message);
    return { data: null, error: { code: "NETWORK", message, details: null, hint: null } };
  }
}

/**
 * One query, built up the way the database client builds one and sent when it is awaited.
 * Only the parts this service uses are here; anything else throws rather than quietly doing the wrong thing.
 */
class Query implements PromiseLike<DbResult> {
  private filters: Filter[] = [];
  private orderBy: [string, { ascending: boolean }][] = [];
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private columns = "*";
  private rows: unknown[] = [];
  private values: Record<string, unknown> = {};
  private onConflict?: string;
  private takeOne?: "one" | "maybe";
  private limitRows?: number;
  private rangeRows?: [number, number];
  private selected = false;

  constructor(private schema: Schema, private table: string) {}

  select(columns = "*") { this.columns = columns; this.selected = true; return this; }
  insert(rows: unknown) { this.op = "insert"; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
  upsert(rows: unknown, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.op = "upsert"; this.rows = Array.isArray(rows) ? rows : [rows]; this.onConflict = opts?.onConflict; return this;
  }
  update(values: Record<string, unknown>) { this.op = "update"; this.values = values; return this; }
  delete() { this.op = "delete"; return this; }

  eq(column: string, value: unknown) { return this.where("eq", column, value); }
  neq(column: string, value: unknown) { return this.where("neq", column, value); }
  gt(column: string, value: unknown) { return this.where("gt", column, value); }
  gte(column: string, value: unknown) { return this.where("gte", column, value); }
  lt(column: string, value: unknown) { return this.where("lt", column, value); }
  lte(column: string, value: unknown) { return this.where("lte", column, value); }
  like(column: string, value: unknown) { return this.where("like", column, value); }
  ilike(column: string, value: unknown) { return this.where("ilike", column, value); }
  is(column: string, value: unknown) { return this.where("is", column, value); }
  in(column: string, values: unknown[]) { return this.where("in", column, values); }
  contains(column: string, value: unknown) { return this.where("contains", column, value); }
  overlaps(column: string, value: unknown) { return this.where("overlaps", column, value); }
  not(column: string, op: string, value: unknown) { return this.where("not", column, [op, value]); }
  /** Only the paged activity list uses PostgREST's `or`, and this service never lists activity — so say so plainly
   *  rather than send a query that would quietly ignore it. */
  or(_expression: string): this {
    throw new Error("or() is not available through Tuper's API — the sync service does not list activity by page");
  }
  match(values: Record<string, unknown>) {
    for (const [column, value] of Object.entries(values)) this.where("eq", column, value);
    return this;
  }

  order(column: string, opts?: { ascending?: boolean }) { this.orderBy.push([column, { ascending: opts?.ascending !== false }]); return this; }
  limit(n: number) { this.limitRows = n; return this; }
  range(from: number, to: number) { this.rangeRows = [from, to]; return this; }
  single() { this.takeOne = "one"; return this; }
  maybeSingle() { this.takeOne = "maybe"; return this; }

  private where(op: string, column: string, value: unknown) { this.filters.push([op, column, value]); return this; }

  private body() {
    const table = tableName(this.schema, this.table);
    if (this.op === "select") {
      return {
        path: "/api/sync/query",
        body: {
          table, select: this.columns, filters: this.filters, order: this.orderBy,
          ...(this.limitRows !== undefined ? { limit: this.limitRows } : {}),
          ...(this.rangeRows ? { range: this.rangeRows } : {}),
          ...(this.takeOne ? { single: this.takeOne } : {}),
        },
      };
    }
    return {
      path: "/api/sync/mutate",
      body: {
        table, op: this.op,
        ...(this.op === "insert" || this.op === "upsert" ? { rows: this.rows } : {}),
        ...(this.op === "update" ? { values: this.values } : {}),
        ...(this.op === "update" || this.op === "delete" ? { filters: this.filters } : {}),
        ...(this.onConflict ? { on_conflict: this.onConflict } : {}),
        ...(this.selected ? { select: this.columns } : {}),
        ...(this.selected && this.takeOne ? { single: this.takeOne } : {}),
      },
    };
  }

  then<R1 = DbResult, R2 = never>(
    onfulfilled?: ((value: DbResult) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    const { path, body } = this.body();
    return post(path, body).then((res) => {
      // A "maybe" that found nothing reads as null, not an error — as the database client does.
      if (res.error?.code === "PGRST116" && this.takeOne === "maybe") return { data: null, error: null };
      return res;
    }).then(onfulfilled, onrejected);
  }
}

class SchemaClient {
  constructor(private schema: Schema) {}

  from(table: string) { return new Query(this.schema, table); }
  async rpc(name: string, args: Record<string, unknown> = {}): Promise<DbResult> {
    return post("/api/sync/rpc", { name, args });
  }
}

/** The pieces of the auth admin API the user import uses, over Tuper's endpoints. */
const auth = {
  admin: {
    async createUser(input: { email: string; password?: string; email_confirm?: boolean; id?: string; user_metadata?: Record<string, unknown> }) {
      const res = await post("/api/sync/auth-user", { email: input.email, confirm: input.email_confirm !== false, id: input.id, user_metadata: input.user_metadata });
      if (res.error) return { data: null, error: { message: res.error.message } };
      return { data: { user: { id: (res.data as { id: string }).id, email: input.email } }, error: null };
    },
    async deleteUser(id: string) {
      const path = `/api/sync/auth-user/${encodeURIComponent(id)}`;
      const started = Date.now();
      const res = await fetch(`${config.tuper.url}${path}`, {
        method: "DELETE",
        headers: { "x-api-key": config.tuper.apiKey },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch(() => null);
      const text = res ? await res.text().catch(() => null) : null;
      logCall({ system: "tuper", method: "DELETE", path, action: "remove login", status: res?.status ?? null, ok: !!res?.ok, started, response: text, error: res ? undefined : "no answer" });
      return { data: null, error: res?.ok ? null : { message: "could not remove the login" } };
    },
  },
};

export interface TuperClient {
  schema(name: string): SchemaClient;
  from(table: string): Query;
  rpc(name: string, args?: Record<string, unknown>): Promise<DbResult>;
  auth: typeof auth;
}

let client: TuperClient | null = null;

/** The client every part of the service uses in place of the database. */
export function tuper(): TuperClient {
  if (!client) {
    client = {
      schema: (name: string) => new SchemaClient(name === "core" ? "core" : "jms"),
      from: (table: string) => new Query("jms", table),
      rpc: (name: string, args: Record<string, unknown> = {}) => post("/api/sync/rpc", { name, args }),
      auth,
    };
  }
  return client;
}

/** A cheap call that proves the key works, for /health. */
export async function tuperReachable(): Promise<{ ok: boolean; detail?: string }> {
  const res = await post("/api/sync/query", { table: "job_categories", select: "id", limit: 1 }, { quiet: true });
  return res.error ? { ok: false, detail: res.error.message } : { ok: true };
}
