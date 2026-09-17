/**
 * Pushing customer changes made in Tuper to Zuper.
 *
 *   PUT  /api/customers/{uid}   { customer: { … } }   DataHouse writeback/zuper/customer_writer.py, production
 *   POST /api/customers_new     { customer: { … } }   same file; answers { type, customer_uid }
 *
 * Rules carried over from that writer, each one learned against this account:
 *
 *  • customer_first_name is required on EVERY PUT, not only on create.
 *  • Zuper re-validates email and mobile uniqueness on every PUT, and counts
 *    archived customers. Re-sending a customer's own unchanged email can be
 *    refused as "already used". So an email or mobile that is not changing is
 *    left out of the body.
 *  • Zuper answers "success" to a PUT it did not apply (seen on the organization
 *    link). Every push is read back and compared.
 *  • A customer is NEVER deleted in Zuper from here: the delete succeeds and
 *    orphans the customer's jobs, assets and contracts there.
 *  • A create is never repeated blindly: a second POST after a timeout makes a
 *    second customer.
 *
 * Address edits live in jms.addresses, not on the customer row, so they arrive as
 * an `_addresses` marker (migrations/0011) and are planned from the rows as they
 * stand, like a job's assignees.
 */

import type { TuperClient as SupabaseClient } from "./tuper-client.js";
import { config } from "./config.js";
import { zuperGet, type SyncConfig } from "./lib/migration/zuper-sync.js";
import { isValue, sameAddress, uidFor, zuperAddress, type Edits, type Plan } from "./pusher.js";

const trimmed = (v: unknown): string | null => { const t = v == null ? "" : String(v).trim(); return t || null; };
const digits = (v: unknown) => String(v ?? "").replace(/\D+/g, "");
const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** Plain columns, and the Zuper field each becomes. */
const FIELDS: Record<string, string> = {
  first_name: "customer_first_name",
  last_name: "customer_last_name",
  company_name: "customer_company_name",
  email: "customer_email",
  description: "customer_description",
  has_sla: "has_sla",
  do_not_service: "do_not_service",
};

/** Columns Tuper changes that are not sent, and why. */
const NOT_PUSHED: Record<string, string> = {
  no_of_jobs: "Zuper counts a customer's jobs itself",
  deleted_at: "follows is_deleted",
  additional_emails: "not pushed yet",
  category_id: "customer categories are not pushed yet",
  account_manager_id: "the account manager is not pushed yet",
  tax_exempt: "tax settings are not pushed yet",
  tax_group_id: "tax settings are not pushed yet",
  is_portal_enabled: "Zuper's own customer portal is not used",
  auto_charge_enabled: "Tuper's own setting",
  visible_to_all: "Tuper's own setting",
  accounts: "balances are worked out by Zuper",
  has_card_on_file: "set by Zuper",
  is_active: "activating and deactivating a customer is not pushed yet",
};

/** Zuper's value, put the way the inbound sync stores it (customerFields in zuper-sync.ts). */
function zuperAsStored(column: string, zc: any): unknown {
  switch (column) {
    case "first_name": return trimmed(zc.customer_first_name) ?? trimmed(zc.customer_company_name) ?? trimmed(zc.customer_email) ?? "Customer";
    case "last_name": return trimmed(zc.customer_last_name);
    case "company_name": return trimmed(zc.customer_company_name);
    case "email": return trimmed(zc.customer_email);
    case "has_sla": return zc.has_sla === true;
    case "do_not_service": return zc.do_not_service === true;
    default: return undefined;   // description is stored stripped of HTML: not reproducible, so no conflict is claimed
  }
}

const same = (column: string, ours: unknown, theirs: unknown) =>
  column === "email" ? lower(ours) === lower(theirs)
  : typeof ours === "boolean" || typeof theirs === "boolean" ? (ours === true) === (theirs === true)
  : (trimmed(ours) ?? "") === (trimmed(theirs) ?? "");

async function zuperCustomer(cfg: SyncConfig, uid: string): Promise<any | null> {
  try {
    const data = (await zuperGet(cfg, `/api/customers/${uid}`))?.data ?? null;
    return Array.isArray(data) ? data[0] ?? null : data;
  } catch (err) {
    if (/→ 404/.test(String(err))) return null;
    throw err;
  }
}

async function addressesOf(client: SupabaseClient, customerId: string): Promise<{ service: any | null; billing: any | null }> {
  const { data, error } = await client.schema("jms").from("addresses").select("*")
    .eq("tenant_id", config.tenantId).eq("parent_type", "CUSTOMER").eq("parent_id", customerId);
  if (error) throw error;
  const rows = (data ?? []) as any[];
  return { service: rows.find((r) => r.address_kind === "SERVICE") ?? null, billing: rows.find((r) => r.address_kind === "BILLING") ?? null };
}

const nameOf = (c: Record<string, any>) => [c.first_name, c.last_name].map(trimmed).filter(Boolean).join(" ") || trimmed(c.company_name) || trimmed(c.email);

/** Work out the Zuper requests for one customer's pending changes. Reads only. */
export async function planCustomer(
  client: SupabaseClient, cfg: SyncConfig, customerId: string, columns: string[], forceCreate: boolean, edits: Edits = {},
): Promise<Plan> {
  const { data: row, error } = await client.schema("jms").from("customers").select("*")
    .eq("tenant_id", config.tenantId).eq("id", customerId).maybeSingle();
  if (error) throw error;
  const zuperUid = await uidFor(client, "customers", customerId);
  const plan: Plan = {
    entity: "customers", label: row ? nameOf(row as Record<string, any>) : null,
    jobId: customerId, workOrder: null, zuperUid,
    operation: zuperUid ? "update" : "create", columns, requests: [], notPushed: [],
  };
  if (!row) { plan.blocked = "the customer no longer exists in Tuper"; return plan; }
  // What people set, not what an inbound sync may have put back over it (see Edits in pusher.ts).
  const c = { ...(row as Record<string, any>) };
  for (const [k, e] of Object.entries(edits)) if (isValue(e) && k in c) c[k] = e.value;
  const cols = new Set(columns);

  if (c.is_deleted) {
    plan.notPushed.push({ column: "is_deleted", reason: "a customer is never deleted in Zuper from here: it would orphan their jobs, assets and contracts there" });
    plan.blocked = "deleted in Tuper";
    return plan;
  }
  if (cols.has("is_deleted")) plan.notPushed.push({ column: "is_deleted", reason: "restoring a customer in Zuper is not pushed" });

  if (!zuperUid) return planCreate(client, c, plan, forceCreate);

  const zc = await zuperCustomer(cfg, zuperUid);
  if (!zc) { plan.blocked = "Zuper no longer has this customer (404)"; return plan; }

  const conflict = (col: string, zuperStillHas: (previous: unknown) => boolean) => {
    const e = edits[col];
    return config.push.onConflict === "zuper-wins" && isValue(e) && !zuperStillHas(e.previous);
  };
  const changedToo = (now: unknown) =>
    `changed in Zuper too, which now has ${JSON.stringify(now ?? null).slice(0, 80)}: left as Zuper has it (PUSH_ON_CONFLICT=zuper-wins)`;

  const fields: Record<string, unknown> = {};
  for (const col of cols) {
    const zf = FIELDS[col];
    if (!zf) continue;
    const ours = typeof c[col] === "boolean" ? c[col] : trimmed(c[col]);
    if (same(col, ours, zc[zf])) { plan.notPushed.push({ column: col, reason: "Zuper already has this value" }); continue; }
    const stored = zuperAsStored(col, zc);
    if (stored !== undefined && conflict(col, (previous) => same(col, previous, stored))) {
      plan.notPushed.push({ column: col, reason: changedToo(zc[zf]) });
      continue;
    }
    if (col === "first_name" && !ours) { plan.notPushed.push({ column: col, reason: "Zuper requires a first name" }); continue; }
    fields[zf] = ours ?? "";
  }

  if (cols.has("contact_no")) {
    const ours = (c.contact_no ?? {}) as Record<string, unknown>, theirs = (zc.customer_contact_no ?? {}) as Record<string, unknown>;
    const numbers: Record<string, string> = {};
    for (const kind of ["mobile", "home", "work"]) {
      if (digits(ours[kind]) !== digits(theirs[kind])) numbers[kind] = trimmed(ours[kind]) ?? "";
    }
    if (Object.keys(numbers).length) fields.customer_contact_no = numbers;
    else plan.notPushed.push({ column: "contact_no", reason: "Zuper already has these numbers" });
  }

  if (cols.has("organization_id")) {
    const uid = await uidFor(client, "organizations", c.organization_id);
    const theirs = zc.customer_organization?.organization_uid ?? zc.customer_organization ?? null;
    if (!c.organization_id) plan.notPushed.push({ column: "organization_id", reason: "taking a customer out of an organization is not pushed yet" });
    else if (!uid) plan.notPushed.push({ column: "organization_id", reason: "that organization is not in Zuper" });
    else if (uid === theirs) plan.notPushed.push({ column: "organization_id", reason: "Zuper already has this organization" });
    else fields.customer_organization = uid;
  }

  if (cols.has("_addresses")) {
    const { service, billing } = await addressesOf(client, customerId);
    for (const [ours, zf, name] of [[service, "customer_address", "service address"], [billing, "customer_billing_address", "billing address"]] as const) {
      if (!ours) { if (zc[zf]?.street) plan.notPushed.push({ column: "_addresses", reason: `removing the ${name} is not pushed yet` }); continue; }
      const mapped = zuperAddress(ours);
      if (sameAddress(mapped, zc[zf])) plan.notPushed.push({ column: "_addresses", reason: `Zuper already has this ${name}` });
      else fields[zf] = mapped;
    }
  }

  if (Object.keys(fields).length) {
    // Required on every PUT; sent as it stands when it is not the thing changing.
    if (!("customer_first_name" in fields)) fields.customer_first_name = trimmed(zc.customer_first_name) ?? trimmed(c.first_name) ?? "";
    plan.requests.push({
      method: "PUT", path: `/api/customers/${zuperUid}`, body: { customer: fields },
      why: `changed ${Object.keys(fields).filter((k) => k !== "customer_first_name" || cols.has("first_name")).join(", ")}`,
    });
  }

  for (const col of cols) if (NOT_PUSHED[col]) plan.notPushed.push({ column: col, reason: NOT_PUSHED[col] });
  return plan;
}

/** A customer Zuper has never had → POST /api/customers_new. */
async function planCreate(client: SupabaseClient, c: Record<string, any>, plan: Plan, forceCreate: boolean): Promise<Plan> {
  plan.operation = "create";
  if (!forceCreate && !plan.columns.length) { plan.blocked = "nothing to create"; return plan; }
  const first = trimmed(c.first_name) ?? trimmed(c.company_name) ?? trimmed(c.last_name);
  if (!first) { plan.blocked = "Zuper requires a first name"; return plan; }

  const organization = await uidFor(client, "organizations", c.organization_id);
  const { service, billing } = await addressesOf(client, c.id);
  const numbers = Object.fromEntries(["mobile", "home", "work"].map((k) => [k, trimmed(c.contact_no?.[k])]).filter(([, v]) => v));
  const customer: Record<string, unknown> = {
    customer_first_name: first,
    ...(trimmed(c.last_name) && trimmed(c.first_name) ? { customer_last_name: trimmed(c.last_name) } : {}),
    ...(trimmed(c.company_name) ? { customer_company_name: trimmed(c.company_name) } : {}),
    ...(trimmed(c.email) ? { customer_email: trimmed(c.email) } : {}),
    ...(Object.keys(numbers).length ? { customer_contact_no: numbers } : {}),
    ...(trimmed(c.description) ? { customer_description: trimmed(c.description) } : {}),
    ...(organization ? { customer_organization: organization } : {}),
    ...(service ? { customer_address: zuperAddress(service) } : {}),
    ...(billing ? { customer_billing_address: zuperAddress(billing) } : {}),
  };
  plan.requests.push({ method: "POST", path: "/api/customers_new", body: { customer }, why: "made in Tuper, not yet in Zuper" });
  if (c.organization_id && !organization) plan.notPushed.push({ column: "organization_id", reason: "that organization is not in Zuper" });
  plan.notPushed.push({ column: "email/mobile", reason: "Zuper refuses a customer whose email or mobile another customer already has, archived ones included" });
  return plan;
}

/** After a live push: did Zuper actually take it? Null when it did. */
export async function verifyCustomer(cfg: SyncConfig, plan: Plan, uid: string): Promise<string | null> {
  const zc = await zuperCustomer(cfg, uid);
  if (!zc) return "Zuper no longer has the customer";
  for (const r of plan.requests) {
    if (r.method !== "PUT") continue;
    const sent = ((r.body as any)?.customer ?? {}) as Record<string, unknown>;
    for (const [zf, v] of Object.entries(sent)) {
      if (zf === "customer_contact_no") {
        for (const [kind, n] of Object.entries(v as Record<string, string>)) {
          if (digits(zc.customer_contact_no?.[kind]) !== digits(n)) return `Zuper kept its old ${kind} number`;
        }
      } else if (zf === "customer_address" || zf === "customer_billing_address") {
        if (!sameAddress(v as Record<string, unknown>, zc[zf])) return `Zuper kept its old ${zf === "customer_address" ? "service" : "billing"} address`;
      } else if (zf === "customer_organization") {
        if ((zc.customer_organization?.organization_uid ?? zc.customer_organization) !== v) return "Zuper kept its old organization";
      } else if (zf === "customer_email") {
        if (lower(zc[zf]) !== lower(v)) return "Zuper kept its old email";
      } else if (typeof v === "boolean") {
        if ((zc[zf] === true) !== v) return `Zuper kept its old ${zf}`;
      } else if (zf !== "customer_description" && (trimmed(zc[zf]) ?? "") !== (trimmed(v) ?? "")) {
        return `Zuper kept its old ${zf}`;
      }
    }
  }
  return null;
}
