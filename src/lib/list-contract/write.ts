/**
 * NOT the JMS module of this name — deliberately.
 *
 * JMS's `list-contract/write.ts` is its request-scoped entity writer: createEntity,
 * updateEntity, softDeleteEntity, getOne, assertTenantRefs. Zupersync needs none of
 * it — the sync engine writes straight through `client.schema(x).from(y).insert()`
 * (zuper-sync.ts:1743, 1752) and never goes near this path.
 *
 * It was pulled into this service for exactly one reason: `checklists.ts` imports
 * `StaleWriteError` from here. Every other export had zero references anywhere in
 * the copied tree.
 *
 * Carrying the real file would have meant carrying `events.ts` with it, and through
 * that JMS's whole automation fan-out: outbound webhook dispatch, the workflow
 * engine, Custom Functions (a QuickJS/WASM sandbox) and job notification rules —
 * all fired on every create/update/delete. In a sync service that is actively
 * dangerous: a reconcile sweep over 46,769 jobs would fan out into customer
 * notifications, and workflow actions writing back to Zuper would feed the echo
 * loop the outbox design exists to prevent.
 *
 * Reducing this module to its error classes means Zupersync *cannot* fire JMS
 * automation, rather than merely not doing so by convention.
 *
 * If a future change here needs the real writer, copy it from JMS deliberately and
 * deal with `events.ts` at that point — don't restore it by accident.
 *
 * The two classes below are verbatim from
 * apps/JMS/web/src/lib/list-contract/write.ts.
 */

export class StaleWriteError extends Error {
  constructor() {
    super("This record was changed by someone else after you opened it. Reload to see their changes, then make yours.");
    this.name = "StaleWriteError";
  }
}

export class ConflictError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
