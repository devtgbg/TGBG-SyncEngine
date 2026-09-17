/**
 * This service's own database.
 *
 * Its delivery log, its queue of changes waiting to go to Zuper, its configuration and its run history. That is its
 * data, not Tuper's, and keeping it here is what lets the service hold no key to Tuper's database — and keep logging
 * and queueing while Tuper is unreachable.
 *
 * Plain SQL over `pg`: four tables and a handful of statements do not need anything more.
 */
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

let pool: Pool | null = null;

export function store(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config.store.url,
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on("error", (err) => console.error("[store] idle client error", err.message));
  }
  return pool;
}

/** One statement. Returns the rows, typed by the caller. */
export async function sql<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  const res = await store().query<T>(text, values);
  return res.rows;
}

/** The first row, or null. */
export async function one<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<T | null> {
  const rows = await sql<T>(text, values);
  return rows[0] ?? null;
}

/** Several statements that must all happen, or none. */
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await store().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Bring the store up to date at boot. The files in store/ are applied in order, once each; a record of what has been
 * applied lives in the store itself. Running twice is safe.
 */
export async function migrate(): Promise<{ applied: string[] }> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "store");
  await sql(`CREATE TABLE IF NOT EXISTS public.sync_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const done = new Set((await sql<{ name: string }>("SELECT name FROM public.sync_migrations")).map((r) => r.name));
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const text = readFileSync(join(dir, file), "utf8");
    await transaction(async (client) => {
      await client.query(text);
      await client.query("INSERT INTO public.sync_migrations (name) VALUES ($1)", [file]);
    });
    applied.push(file);
    console.log(`[store] applied ${file}`);
  }
  return { applied };
}

/** A cheap call that proves the connection works, for /health. */
export async function storeReachable(): Promise<{ ok: boolean; detail?: string }> {
  try {
    await sql("SELECT 1");
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function closeStore(): Promise<void> {
  if (pool) { await pool.end().catch(() => {}); pool = null; }
}
