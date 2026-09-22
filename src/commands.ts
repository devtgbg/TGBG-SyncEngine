/**
 * Actions asked for on the dashboard, carried out by the engine.
 *
 * The dashboard writes a row into sync.commands; this picks it up within five seconds, runs it, and writes back
 * whether it worked and what it did, which the dashboard shows beside the button. One at a time, oldest first, each
 * claimed in the database before it runs so two containers during a deploy never run the same one. A command left
 * waiting more than ten minutes (the engine was down when it was asked) is closed as expired rather than run late.
 */
import { config, errorText } from "./config.js";
import { one, sql } from "./store.js";
import { withCause } from "./api-log.js";
import { sweepNow } from "./sweep.js";
import { refreshConnections, registerMissingZuperWebhooks } from "./connections.js";

type Handler = () => Promise<string>;

const COMMANDS: Record<string, Handler> = {
  /** Failed Zuper deliveries back into the replay queue: they are processed again, for real, not relabelled. */
  async "replay-failed"() {
    const rows = await sql(
      `UPDATE sync.webhook_events SET attempts = 0
        WHERE tenant_id = $1 AND source = 'zuper' AND verified AND processed_at IS NULL
          AND process_error IS NOT NULL AND process_error NOT LIKE 'skipped:%'
       RETURNING 1`, [config.tenantId]);
    const note = !config.inbound ? " They run once Zuper → Tuper is on." : !config.reconcile.enabled ? " They run once replay is on." : " The replay takes them within two minutes.";
    return `${rows.length} failed deliver${rows.length === 1 ? "y" : "ies"} put back in the replay queue.${rows.length ? note : ""}`;
  },

  /** Changes made in Tuper that have not been sent to Zuper, removed from the queue. */
  async "discard-unsent"() {
    const rows = await sql(
      `DELETE FROM sync.outbox WHERE tenant_id = $1 AND status IN ('queued', 'planned', 'failed') RETURNING 1`, [config.tenantId]);
    return `${rows.length} unsent change${rows.length === 1 ? "" : "s"} discarded. Nothing was sent to Zuper.`;
  },

  async "sweep-now"() { return sweepNow(); },
  async "refresh-connections"() { return refreshConnections(); },
  async "register-zuper-webhooks"() { return registerMissingZuperWebhooks(); },
};

export const COMMAND_NAMES = Object.keys(COMMANDS);

let running = false;

async function next(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await sql(
      `UPDATE sync.commands SET started_at = now(), finished_at = now(), ok = false,
              result = 'expired: the engine was not running when this was asked; ask again'
        WHERE tenant_id = $1 AND started_at IS NULL AND requested_at < now() - interval '10 minutes'`, [config.tenantId]);
    for (;;) {
      const cmd = await one<{ id: string; command: string }>(
        `UPDATE sync.commands SET started_at = now()
          WHERE id = (SELECT id FROM sync.commands WHERE tenant_id = $1 AND started_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING id::text, command`, [config.tenantId]);
      if (!cmd) return;
      const handler = COMMANDS[cmd.command];
      let ok = false, result: string;
      try {
        if (!handler) throw new Error(`no such command '${cmd.command}'`);
        result = await withCause({ origin: "admin" }, handler);
        ok = !result.startsWith("not run:");
      } catch (err) {
        result = errorText(err);
      }
      console.log(`[commands] ${cmd.command}: ${ok ? "" : "FAILED "}${result}`);
      await sql(`UPDATE sync.commands SET finished_at = now(), ok = $2, result = $3 WHERE id = $1::bigint`, [cmd.id, ok, result.slice(0, 2000)]);
    }
  } catch (err) {
    console.warn("[commands] could not read the command queue:", errorText(err));
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startCommands(): void {
  timer = setInterval(() => { void next(); }, 5_000);
  timer.unref?.();
}

export function stopCommands(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
