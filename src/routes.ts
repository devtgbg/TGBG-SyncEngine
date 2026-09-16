/**
 * Zuper webhook → sync entity routing.
 *
 * The catalogue below was read out of Zuper's own New Webhook form (Settings ›
 * Developer › Webhooks) on 2026-09-16: 10 modules, 184 events. It is recorded in
 * full because Zuper does not document it, and because an event we have never
 * seen must be distinguishable from one we chose not to handle.
 *
 * The routing principle: a webhook is a TRIGGER, not a payload. We take the
 * record's uid from the delivery and re-fetch that record from Zuper, which is
 * the system of record. That survives payload shapes Zuper has never published,
 * deliveries that arrive out of order, and the ones that arrive twice. It is also
 * why nearly all 35 Jobs events collapse onto one route: "New Note", "Assign
 * Users", "Status Update" and "Update Job Checklist" all mean "this job changed",
 * and job_details already re-reads the job and rebuilds its assignments, history,
 * custom fields, teams and tags.
 *
 * Every path below is taken from Zuper's OpenAPI specs, because the pattern
 * genuinely does not generalise: /customers but /organization, /products but
 * /service_contract, and service contracts identify by `contract_uid` rather than
 * `service_contract_uid`. Inferring a path from its sibling produces a silent 404.
 */

/** How a single record can be obtained for an entity. */
export type FetchMode =
  /** GET a documented by-uid endpoint and hand the result to transform. */
  | "detail"
  /** The entity's own transform fetches what it needs; a uid stub is enough. */
  | "self"
  /** Zuper publishes no read-by-uid for this entity — see `reason`. */
  | "unsupported";

/**
 * Where one record of each entity comes from.
 *
 * Held per ENTITY rather than per module because several modules route note and
 * attachment events to the same entity, and the fetch strategy belongs to the
 * thing being fetched.
 *
 * `unsupported` is a deliberate, load-bearing state: a webhook we cannot service
 * must be recorded as unserviced. The alternative — handing a bare uid stub to a
 * transform written for a full record — writes a near-empty payload OVER a live
 * row, which silently blanks real data.
 */
const ENTITY_FETCH: Record<string, { mode: FetchMode; path?: (uid: string) => string; reason?: string }> = {
  // Documented by-uid reads.
  job_details: { mode: "self" },                                            // transform GETs /api/jobs/{uid} itself
  jobs: { mode: "detail", path: (u) => `/api/jobs/${u}` },
  customers: { mode: "detail", path: (u) => `/api/customers/${u}` },        // plural
  organizations: { mode: "detail", path: (u) => `/api/organization/${u}` }, // singular
  assets: { mode: "detail", path: (u) => `/api/assets/${u}` },              // plural
  products: { mode: "detail", path: (u) => `/api/products/${u}` },          // plural
  contracts: { mode: "detail", path: (u) => `/api/service_contract/${u}` }, // singular
  users: { mode: "detail", path: (u) => `/api/user/${u}` },                 // singular
  estimates: { mode: "detail", path: (u) => `/api/estimate/${u}` },
  invoices: { mode: "detail", path: (u) => `/api/invoice/${u}` },
  requests: { mode: "detail", path: (u) => `/api/request/${u}` },

  // No read-by-uid exists. These need a parent-scoped list fetch and a match on
  // the uid, which is not built — so they are refused rather than guessed at.
  notes: { mode: "unsupported", reason: "Zuper has no GET by note_uid — needs the parent's note list and a client-side match" },
  timesheets: { mode: "unsupported", reason: "Zuper has no GET by timesheet_uid, and /timesheets has no uid filter" },
  timeoff_requests: { mode: "unsupported", reason: "time off is only readable as a whole list" },
  timeoff_types: { mode: "unsupported", reason: "time off types are only readable as a whole list" },
  user_shifts: { mode: "unsupported", reason: "shifts are only readable by date window" },
  master_shifts: { mode: "unsupported", reason: "master shifts are only readable as a whole list" },
  product_transactions: { mode: "unsupported", reason: "Zuper has no GET by transaction uid" },
  stock_locations: { mode: "unsupported", reason: "product locations are only readable as a whole list" },
};

/**
 * The by-uid path for an entity, or null when Zuper publishes none.
 *
 * Exported so callers that already know the entity (the create-fallback in
 * processor.ts) read the same table resolveRoute does, instead of keeping a
 * second copy of these paths that could drift out of step with it.
 */
export function detailPathFor(entity: string): ((uid: string) => string) | null {
  const f = ENTITY_FETCH[entity];
  return f?.mode === "detail" ? f.path ?? null : null;
}

/** Whether an entity's own transform fetches what it needs from a uid stub. */
export function isSelfFetching(entity: string): boolean {
  return ENTITY_FETCH[entity]?.mode === "self";
}

/** A route says which sync entity to run, and how to get the record. */
export interface Route {
  /** ENTITIES key in lib/migration/zuper-sync.ts. */
  entity: string;
  /** Entity to run when the record has no jms_id yet (enrichOnly entities throw otherwise). */
  createEntity?: string;
  /** Candidate field names for the uid, in the order they should be tried. */
  uidFields: string[];
  fetch: FetchMode;
  /** Set when fetch === "detail". */
  detail: ((uid: string) => string) | null;
  /** The record itself was removed — mark it deleted rather than re-fetching a 404. */
  deletion: boolean;
  /** Set when this event will not be synced, with the reason. */
  skip?: string;
  /** True when the event was not in the catalogue and the module default was used. */
  inferred: boolean;
}

interface ModuleSpec {
  entity: string;
  createEntity?: string;
  uidFields: string[];
  overrides?: Record<string, { entity?: string; uidFields?: string[]; skip?: string }>;
  deletions?: string[];
  events: string[];
}

/**
 * Zuper's WIRE module names -> the catalogue keys below.
 *
 * Read from the live API (GET /service/notifications/webhook, 98 configured
 * webhooks, 2026-09-16). Zuper's form labels and its wire names agree for exactly
 * one module out of nine, so this map is not optional: an unmatched module
 * resolves to null and the delivery is stored but never processed.
 *
 * PROPERTY is Zuper's name for Organizations, and ESTIMATES for the module its
 * own form calls "Quotes".
 */
const MODULE_ALIASES: Record<string, string> = {
  job: "Jobs", jobs: "Jobs",
  customer: "Customers", customers: "Customers",
  property: "Organizations", organization: "Organizations", organizations: "Organizations",
  estimate: "Quotes", estimates: "Quotes", quote: "Quotes", quotes: "Quotes",
  invoice: "Invoices", invoices: "Invoices",
  servicecontract: "Contracts", servicecontracts: "Contracts", contract: "Contracts", contracts: "Contracts",
  asset: "Assets", assets: "Assets",
  user: "Users", users: "Users",
  request: "Requests", requests: "Requests",
  timesheet: "Timesheets", timesheets: "Timesheets",
  product: "Products", products: "Products",
};

const MODULES: Record<string, ModuleSpec> = {
  // ── Jobs ──────────────────────────────────────────────────────────────────
  // job_details is enrichOnly: it throws for a job with no jms_id, so a genuinely
  // new job runs `jobs` first. Everything else is "re-read this job".
  Jobs: {
    entity: "job_details",
    createEntity: "jobs",
    uidFields: ["job_uid"],
    deletions: ["Delete Job", "job.delete"],
    overrides: {
      "New Note": { entity: "notes", uidFields: ["note_uid", "job_uid"] },
      "Update Note": { entity: "notes", uidFields: ["note_uid", "job_uid"] },
      "Delete Note": { entity: "notes", uidFields: ["note_uid", "job_uid"] },
      "New Job Message": { skip: "job chat is Stream Chat and was never imported" },
      "New Measurement": { skip: "measurements have no sync entity" },
      "Measurement Updated": { skip: "measurements have no sync entity" },
      "Measurement Status Updated": { skip: "measurements have no sync entity" },
      "Measurement Deleted": { skip: "measurements have no sync entity" },
    },
    events: [
      "New Job", "Update Job", "Schedule Job", "Reschedule Job", "Assign Users", "Unassign Users",
      "Assign Teams", "Unassign Teams", "Job Accept / Reject", "Status Update", "Status Rollback",
      "Status Delete", "Job Feedback", "New Note", "Update Note", "Delete Note", "Delete Job",
      "Job Bulk Action", "Update Job Checklist", "Update Recurring Job", "Update Recurring Job Rule",
      "New Recurring Job", "Delete Recurring Job", "Status Alert", "Update Job Timelog",
      "Create Job Timelog", "Update Job Product", "New Job Attachment", "Delete Job Attachment",
      "Update Job Attachment", "New Job Message", "New Measurement", "Measurement Updated",
      "Measurement Status Updated", "Measurement Deleted",
    ],
  },

  // ── Requests ──────────────────────────────────────────────────────────────
  // Zuper's New Webhook form does NOT offer this module, but 8 request webhooks
  // are configured and firing. The events below are therefore the real wire
  // names, taken from the API rather than a form label.
  Requests: {
    entity: "requests",
    uidFields: ["request_uid"],
    deletions: ["request.delete", "Delete Request"],
    overrides: {
      "request.new_note": { entity: "notes", uidFields: ["note_uid", "request_uid"] },
      "New Note": { entity: "notes", uidFields: ["note_uid", "request_uid"] },
    },
    events: [
      "request.new", "request.update", "request.delete", "request.status_update",
      "request.status_rollback", "request.assign_users", "request.unassign_users", "request.new_note",
    ],
  },

  // ── Customers ─────────────────────────────────────────────────────────────
  // Zuper has no customer delete — only Deactivate, which arrives as a field change.
  Customers: {
    entity: "customers",
    uidFields: ["customer_uid"],
    overrides: {
      "New Note": { entity: "notes", uidFields: ["note_uid", "customer_uid"] },
      "Update Note": { entity: "notes", uidFields: ["note_uid", "customer_uid"] },
      "Delete Note": { entity: "notes", uidFields: ["note_uid", "customer_uid"] },
      "New Customer Card": { skip: "payment cards are not synced" },
      "Remove Customer Card": { skip: "payment cards are not synced" },
    },
    events: [
      "New Customer", "Customer Update", "Customer Deactivate", "Customer Activate",
      "Customer Accounts Update", "Favourite Technician Update", "New Note", "Update Note",
      "Delete Note", "New Customer Card", "Remove Customer Card", "New Customer Attachment",
      "Delete Customer Attachment", "Update Customer Attachment", "Customer Bulk Action",
    ],
  },

  // ── Organizations ─────────────────────────────────────────────────────────
  Organizations: {
    entity: "organizations",
    uidFields: ["organization_uid"],
    deletions: ["Organization Delete", "property.delete"],
    events: [
      "New Organization", "Organization Update", "Organization Delete", "Organization Bulk Action",
      "Assign Users", "Unassign Users", "New Organization Attachment", "Update Organization Attachment",
      "Delete Organization Attachment", "Import Organization",
    ],
  },

  // ── Assets ────────────────────────────────────────────────────────────────
  // "Delete Aseet Attachment" / "Update Aseet Attachment" are Zuper's own typos,
  // kept verbatim — that is the string the webhook will actually send.
  Assets: {
    entity: "assets",
    uidFields: ["asset_uid"],
    deletions: ["Asset Delete", "asset.delete"],
    overrides: {
      "Asset New Note": { entity: "notes", uidFields: ["note_uid", "asset_uid"] },
      "Asset Update Note": { entity: "notes", uidFields: ["note_uid", "asset_uid"] },
      "Asset Delete Note": { entity: "notes", uidFields: ["note_uid", "asset_uid"] },
      "Inspection Form Submission": { skip: "filling inspections is not built" },
      "Inspection Form Update": { skip: "filling inspections is not built" },
    },
    events: [
      "New Asset", "Asset Update", "Asset Delete", "Asset activate", "Asset Deactivate",
      "New Asset Attachment", "Delete Aseet Attachment", "Update Aseet Attachment", "Asset Bulk Action",
      "Asset Status Update", "Asset History", "Asset Recover", "Asset New Note", "Asset Update Note",
      "Asset Delete Note", "Inspection Form Submission", "Inspection Form Update",
    ],
  },

  // ── Quotes → the `estimates` entity (jms.quotes) ───────────────────────────
  Quotes: {
    entity: "estimates",
    uidFields: ["estimate_uid"],
    deletions: ["Quote Delete", "estimate.delete"],
    overrides: {
      "Quote New Note": { entity: "notes", uidFields: ["note_uid", "estimate_uid"] },
      "Quote Delete Note": { entity: "notes", uidFields: ["note_uid", "estimate_uid"] },
      "Print Quote": { skip: "printing changes nothing on the record" },
    },
    events: [
      "New Quote", "Quote Update", "Quote Status Update", "Quote Deposit Payment", "Print Quote",
      "Send Quote", "Quote New Note", "Quote New Attachment", "Quote Delete Attachment",
      "Quote Delete Note", "Quote Delete", "Quote Bulk Action", "Quote Recover",
    ],
  },

  // ── Invoices ──────────────────────────────────────────────────────────────
  Invoices: {
    entity: "invoices",
    uidFields: ["invoice_uid"],
    deletions: ["Invoice Delete", "invoice.delete"],
    overrides: {
      "Invoice New Note": { entity: "notes", uidFields: ["note_uid", "invoice_uid"] },
      "Invoice Delete Note": { entity: "notes", uidFields: ["note_uid", "invoice_uid"] },
      "Invoice Update Note": { entity: "notes", uidFields: ["note_uid", "invoice_uid"] },
      "Print Invoice": { skip: "printing changes nothing on the record" },
    },
    events: [
      "New Invoice", "Invoice Update", "Invoice Status Update", "Invoice Payment", "Print Invoice",
      "Send Invoice", "Invoice New Note", "Invoice Attachment", "Invoice Delete Attachment",
      "Invoice Delete Note", "Invoice Delete", "Invoice Bulk Action", "Invoice New Payment Mode",
      "Invoice Update Payment Mode", "Invoice Delete Payment Mode", "Invoice New Payment Term",
      "Invoice Update Payment Term", "Invoice Delete Payment Term", "Invoice Update Note",
    ],
  },

  // ── Contracts → the `contracts` entity (jms.service_contracts) ─────────────
  // Zuper's own API calls this one `contract_uid`, not `service_contract_uid`;
  // the webhook body is undocumented, so both are tried.
  Contracts: {
    entity: "contracts",
    uidFields: ["service_contract_uid", "contract_uid"],
    deletions: ["Service Contract Delete", "service_contract.delete"],
    overrides: {
      "Service Contract New Note": { entity: "notes", uidFields: ["note_uid", "contract_uid"] },
      "Service Contract Delete Note": { entity: "notes", uidFields: ["note_uid", "contract_uid"] },
      "Service Contract Update Note": { entity: "notes", uidFields: ["note_uid", "contract_uid"] },
    },
    events: [
      "New Service Contract", "Service Contract Update", "Service Contract Delete",
      "Service Contract Status Update", "Service Contract Renewal", "Service Contract New Note",
      "Service Contract Delete Note", "Service Contract Update Note", "Service Contract Bulk Action",
      "Service Contract Activate", "Service Contract Deactivate",
    ],
  },

  // ── Products ──────────────────────────────────────────────────────────────
  Products: {
    entity: "products",
    uidFields: ["product_uid"],
    deletions: ["Product Delete", "product.delete"],
    overrides: {
      "New Product Location": { entity: "stock_locations", uidFields: ["location_uid"] },
      "Product Location Update": { entity: "stock_locations", uidFields: ["location_uid"] },
      "Product Location Delete": { entity: "stock_locations", uidFields: ["location_uid"] },
      "Product Transaction Inward": { entity: "product_transactions", uidFields: ["transaction_uid"] },
      "Product Transaction Outward": { entity: "product_transactions", uidFields: ["transaction_uid"] },
      "Product Transaction Transfer": { entity: "product_transactions", uidFields: ["transaction_uid"] },
      "Product Consumption": { entity: "product_transactions", uidFields: ["transaction_uid"] },
    },
    events: [
      "New Product", "Product Update", "Product Delete", "New Product Location",
      "Product Location Update", "Product Location Delete", "Product Transaction Inward",
      "Product Transaction Outward", "Product Transaction Transfer", "Product Consumption",
      "Update Product Stock", "Product Bulk Action",
    ],
  },

  // ── Users ─────────────────────────────────────────────────────────────────
  Users: {
    entity: "users",
    uidFields: ["user_uid"],
    deletions: ["User Delete", "user.delete"],
    overrides: {
      "User Login": { skip: "a login changes nothing on the record" },
      "User Sos Trigger": { skip: "an SOS alert is not record state" },
      "User Preference Update": { skip: "Zuper-side UI preferences are not synced" },
    },
    events: [
      "New User Resource", "User Resource Delete", "User Resource Update", "User Sos Trigger",
      "User Activate", "User Deactivate", "User Delete", "New User", "User Update",
      "User Work Hours Update", "User Login", "User Recover", "User New Skill", "User Delete Skill",
      "User Update Skill", "User Preference Update",
    ],
  },

  // ── Timesheets ────────────────────────────────────────────────────────────
  // The widest module — one Zuper "module" spanning four of our entities. None of
  // them has a documented read-by-uid, so every route here currently resolves to
  // `unsupported`; the deliveries are still stored, so nothing is lost when the
  // parent-scoped fetch is built.
  Timesheets: {
    entity: "timesheets",
    uidFields: ["timesheet_uid", "user_uid"],
    overrides: {
      "New Timeoff": { entity: "timeoff_requests", uidFields: ["timeoff_uid"] },
      "Approve Timeoff": { entity: "timeoff_requests", uidFields: ["timeoff_uid"] },
      "Reject Timeoff": { entity: "timeoff_requests", uidFields: ["timeoff_uid"] },
      "Update Timeoff": { entity: "timeoff_requests", uidFields: ["timeoff_uid"] },
      "Delete Timeoff": { entity: "timeoff_requests", uidFields: ["timeoff_uid"] },
      "New Timeoff Type": { entity: "timeoff_types", uidFields: ["timeoff_type_uid"] },
      "Edit Timeoff Type": { entity: "timeoff_types", uidFields: ["timeoff_type_uid"] },
      "Delete Timeoff Type": { entity: "timeoff_types", uidFields: ["timeoff_type_uid"] },
      "New User Shift": { entity: "user_shifts", uidFields: ["shift_uid"] },
      "Delete User Shift": { entity: "user_shifts", uidFields: ["shift_uid"] },
      "Timesheet Master Shift Create": { entity: "master_shifts", uidFields: ["shift_uid"] },
      "Timesheet Master Shift Updating": { entity: "master_shifts", uidFields: ["shift_uid"] },
      "Timesheet Master Shift Delete": { entity: "master_shifts", uidFields: ["shift_uid"] },
      "New Timeoff Availability": { skip: "availability windows have no sync entity" },
      "Edit Timeoff Availability": { skip: "availability windows have no sync entity" },
      "Delete Timeoff Availability": { skip: "availability windows have no sync entity" },
      "Timesheet New Location": { skip: "GPS breadcrumbs are not synced" },
      "Timesheet Edit Location": { skip: "GPS breadcrumbs are not synced" },
      "Timesheet Delete Location": { skip: "GPS breadcrumbs are not synced" },
      "New Timesheet Location": { skip: "GPS breadcrumbs are not synced" },
      "Delete Timesheet Location": { skip: "GPS breadcrumbs are not synced" },
    },
    events: [
      "New Timesheet Approval", "Update Timesheet Approval", "Delete Timesheet approval",
      "Timesheet Approval Status Update", "Timesheet Update", "Timesheet Delete",
      "Timesheet New Location", "Timesheet Edit Location", "Timesheet Delete Location",
      "New Timeoff", "Approve Timeoff", "Reject Timeoff", "Update Timeoff", "Delete Timeoff",
      "New User Shift", "Delete User Shift", "New Timeoff Availability", "Edit Timeoff Availability",
      "Delete Timeoff Availability", "New Timeoff Type", "Edit Timeoff Type", "Delete Timeoff Type",
      "New Timesheet Location", "Delete Timesheet Location", "Timesheet Day Activity",
      "Timesheet Check In", "Timesheet Check Out", "Timesheet Break", "Timesheet Resume Work",
      "Timesheet Master Shift Create", "Timesheet Master Shift Updating", "Timesheet Master Shift Delete",
      "Timesheet Bulk Check In", "Timesheet Bulk Check Out", "Timesheet Bulk Resume Work",
      "Timesheet Break",
    ],
  },
};

/** Zuper's module names, exactly as its webhook form spells them. */
export const MODULE_NAMES = Object.keys(MODULES);

/** Every event Zuper can send, by module — 184 in total. */
export const EVENT_CATALOGUE: Record<string, string[]> = Object.fromEntries(
  Object.entries(MODULES).map(([m, s]) => [m, s.events]),
);

export const EVENT_COUNT = Object.values(EVENT_CATALOGUE).reduce((n, e) => n + e.length, 0);

/**
 * Case/spacing/punctuation-insensitive.
 *
 * Zuper's catalogue below holds the DISPLAY labels from its New Webhook form
 * ("Asset activate"), but the wire format is lowercase dotted — the live API
 * returns module "ASSETS", event "asset.activate". Dots must be stripped too, or
 * nothing a real delivery says would ever match.
 */
const norm = (s: string) => String(s ?? "").toLowerCase().replace(/[\s_\-/.]+/g, "");

/**
 * Resolve a delivery to a route.
 *
 * Returns null for an unknown module — deliberately, so an unrecognised module is
 * recorded as unroutable rather than falling through to a default entity that
 * would write the wrong table.
 */
export function resolveRoute(module: string, event: string): Route | null {
  const key = MODULE_ALIASES[norm(module)] ?? MODULE_NAMES.find((m) => norm(m) === norm(module));
  if (!key) return null;
  const spec = MODULES[key];

  const override = spec.overrides
    ? Object.entries(spec.overrides).find(([e]) => norm(e) === norm(event))?.[1]
    : undefined;

  // Is this an event we actually catalogued? Zuper's wire names are not always a
  // word-for-word match for its form labels ("New Asset" may arrive as
  // "asset.create"), so an uncatalogued event on a KNOWN module is not an error:
  // in a trigger-based design it still means "this record changed", and
  // re-reading the record is the right answer. Dropping it would lose data.
  const known = spec.events.some((e) => norm(e) === norm(event));

  const entity = override?.entity ?? spec.entity;
  const fetchSpec = ENTITY_FETCH[entity] ?? { mode: "unsupported" as FetchMode, reason: `no fetch strategy defined for "${entity}"` };
  const deletion = (spec.deletions ?? []).some((e) => norm(e) === norm(event));

  return {
    entity,
    // An override points at a different entity, so the module's create fallback
    // (jobs, for job_details) must not leak into it.
    createEntity: override?.entity ? undefined : spec.createEntity,
    uidFields: override?.uidFields ?? spec.uidFields,
    fetch: fetchSpec.mode,
    detail: fetchSpec.mode === "detail" ? fetchSpec.path ?? null : null,
    deletion,
    // A deletion needs no fetch, so an unsupported read does not block it.
    skip: override?.skip ?? (fetchSpec.mode === "unsupported" && !deletion ? fetchSpec.reason : undefined),
    inferred: !known,
  };
}

/** Events that will not be synced, and why — so the log UI can show it plainly. */
export function unroutedEvents(): { module: string; event: string; reason: string }[] {
  const out: { module: string; event: string; reason: string }[] = [];
  for (const [m, spec] of Object.entries(MODULES)) {
    for (const e of spec.events) {
      const r = resolveRoute(m, e);
      if (r?.skip) out.push({ module: m, event: e, reason: r.skip });
    }
  }
  return out;
}
