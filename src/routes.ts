/**
 * Zuper webhook → sync entity routing.
 *
 * The catalogue below is Zuper's own, not a transcription of its UI. It comes from
 * `GET /api/misc/{MODULE}/events` — the endpoint Zuper's New Webhook form calls
 * when a module is picked — which returns every event with its wire key and its
 * display name. 12 modules, 203 events, captured 2026-09-17 and kept verbatim in
 * src/cli/fixtures/zuper-events.json, which `npm run check-wire-routes` holds this
 * file to.
 *
 * WHY KEYS, NOT LABELS. An earlier version was keyed by the form's display labels
 * ("New Note", "Status Update"), but a real delivery carries the wire key
 * (`job.new_note`, `job.status_update`) and the two rarely normalise to the same
 * string. So most per-event rules never fired on live traffic: a job note would
 * have been re-synced as a whole job instead of being recognised as a note.
 *
 * WHY AN EXACT INDEX, NOT THE PREFIX. A real delivery carries no module field, and
 * the key's prefix is not always its module: `measurement.*` belongs to JOB,
 * `inspection_form.*` to ASSETS, `timesheet_approval.*` to TIMESHEET and
 * `import.organization` to ORGANIZATION. Every known key is therefore looked up
 * exactly; the prefix is only a fallback for events Zuper adds later.
 *
 * WHY PROPERTY IS NOT ORGANIZATIONS. Zuper has both modules. This account has
 * 1,008 organizations and one property, and `GET /api/organization/{uid}` answers
 * 404 for a property uid — which is what an earlier mapping would have requested.
 *
 * The routing principle is unchanged: a webhook is a TRIGGER, not a payload. We
 * take the record's uid and re-read it from Zuper, the system of record. Most
 * events therefore mean "this record changed": a status rollback, a team
 * assignment and a checklist update on a job all re-read the job.
 *
 * WHY A JOB RUNS THREE ENTITIES. `jobs` writes the row itself — title, schedule,
 * priority, addresses, customer, actual times — and rebuilds assignments, status
 * history (with checklist photos), custom fields, teams, tags and the job's own
 * attachments. `job_details` adds what only it resolves: the parent job, the
 * linked asset, feedback, and the customer's organization. `job_activity`
 * rebuilds the job's Zuper activity feed and, when the feed shows punches, its
 * time logs. An earlier version ran job_details alone for every job event, and
 * job_details never writes the schedule: 69 of 73 rescheduled jobs kept their old
 * times while the log said "applied" (found 2026-09-17; WO 54200 read 16 Sep,
 * Zuper 20 Sep). Until 2026-09-17 nothing refreshed activity or time logs after
 * the import either.
 */

/** How a single record can be obtained for an entity. */
export type FetchMode =
  /** GET a documented by-uid endpoint and hand the result to transform. */
  | "detail"
  /** The entity's own transform fetches what it needs; a uid stub is enough. */
  | "self"
  /** Zuper publishes no read-by-uid for this entity — see `reason`. */
  | "unsupported"
  /** Re-read every note on the record the note belongs to (GET /api/notes?filter.<host>=uid). */
  | "host"
  /** Re-read the recent part of a list Zuper only serves whole (collections.ts). */
  | "collection";

/**
 * Where one record of each entity comes from.
 *
 * `unsupported` is load-bearing: a webhook we cannot service must be recorded as
 * unserviced. Handing a bare uid stub to a transform written for a full record
 * writes a near-empty payload OVER a live row, silently blanking real data.
 */
const ENTITY_FETCH: Record<string, { mode: FetchMode; path?: (uid: string) => string; reason?: string }> = {
  job_details: { mode: "self" },                                            // transform GETs /api/jobs/{uid} itself
  job_activity: { mode: "self" },                                           // GETs the job's activity feed (+ /timelog)
  jobs: { mode: "detail", path: (u) => `/api/jobs/${u}` },               // never a list row — see sweep.ts
  customers: { mode: "detail", path: (u) => `/api/customers/${u}` },        // plural
  organizations: { mode: "detail", path: (u) => `/api/organization/${u}` }, // singular
  assets: { mode: "detail", path: (u) => `/api/assets/${u}` },              // plural
  products: { mode: "detail", path: (u) => `/api/products/${u}` },          // plural
  contracts: { mode: "detail", path: (u) => `/api/service_contract/${u}` }, // singular
  users: { mode: "detail", path: (u) => `/api/user/${u}` },                 // singular
  estimates: { mode: "detail", path: (u) => `/api/estimate/${u}` },
  invoices: { mode: "detail", path: (u) => `/api/invoice/${u}` },
  requests: { mode: "detail", path: (u) => `/api/request/${u}` },

  // No read-by-uid exists. Changes are refused rather than guessed at; DELETIONS
  // still work for mapped records, because marking a row deleted needs no fetch.
  // Zuper has no GET by note_uid, but lists a record's notes; the host's uid is in every note event.
  notes: { mode: "host" },
  // No read-by-uid; the recent part of each list is re-read instead (collections.ts).
  timesheets: { mode: "collection" },
  timeoff_requests: { mode: "collection" },
  timeoff_types: { mode: "collection" },
};

/** The by-uid path for an entity, or null when Zuper publishes none. */
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
  /** Zuper's wire module the event belongs to (JOB, ESTIMATES, …). */
  module: string;
  /** ENTITIES key in lib/migration/zuper-sync.ts. */
  entity: string;
  /** Entities to run, in order, once `entity` has written the record (job_details and job_activity, for jobs). */
  enrich?: string[];
  /** Candidate field names for the uid, in the order they should be tried. */
  uidFields: string[];
  fetch: FetchMode;
  /** Set when fetch === "detail". */
  detail: ((uid: string) => string) | null;
  /** The record itself was removed — mark it deleted rather than re-fetching a 404. */
  deletion: boolean;
  /** Set when this event will not be synced, with the reason. */
  skip?: string;
  /** True when the event is not in Zuper's catalogue and the module default was used. */
  inferred: boolean;
  /** For note events: the kind of record the note is on; the uid is that record's. */
  noteHost?: NoteHost;
  /** For list-only records: which list to re-read. No uid is needed. */
  collection?: Collection;
}

/** Lists Zuper only serves whole (see collections.ts). */
export type Collection = "timesheets" | "timeoff_requests" | "timeoff_types";

/** Records Tuper keeps notes on — the hosts the notes import understands. */
export type NoteHost = "job" | "customer" | "request" | "asset";

interface EventRule {
  /** Recorded as not synced, with this reason. */
  skip?: string;
  /** Mark the record deleted instead of re-reading it. */
  deletion?: true;
  /** A different entity than the module's. */
  entity?: string;
  uidFields?: string[];
  noteHost?: NoteHost;
  collection?: Collection;
}

interface ModuleSpec {
  /** Zuper's display name for the module. */
  label: string;
  entity: string;
  enrich?: string[];
  uidFields: string[];
  /** Every event Zuper offers, keyed by wire key: [display name, rule]. No rule = re-read the record. */
  events: Record<string, [string, EventRule?]>;
  /** Applies to every event in the module that has no rule of its own. */
  skipAll?: string;
  /** Applies to events Zuper adds later that the catalogue does not know yet. */
  skipUncatalogued?: string;
}

// Shared rules, so the same decision reads the same everywhere.
const DELETE: EventRule = { deletion: true };
// A note event names the record it is on. Its notes are re-read from Zuper, which
// catches new and edited notes; a deleted note is flagged by note_uid when the
// delivery carries one, otherwise by its absence from that list (Zuper's list
// omits deleted notes).
const NOTE = (host: NoteHost): EventRule => ({ entity: "notes", uidFields: [`${host}_uid`], noteHost: host });
const NOTE_DELETE = (host: NoteHost): EventRule => ({ ...NOTE(host), deletion: true });
const NO_NOTES: EventRule = { skip: "Tuper keeps no notes on quotes, invoices or contracts" };
const PUNCHES: EventRule = { entity: "timesheets", uidFields: [], collection: "timesheets" };
const TIMEOFF: EventRule = { entity: "timeoff_requests", uidFields: [], collection: "timeoff_requests" };
const TIMEOFF_TYPES: EventRule = { entity: "timeoff_types", uidFields: [], collection: "timeoff_types" };
const NOT_KEPT = (what: string): EventRule => ({ skip: `not kept in Tuper: ${what}` });
const SHIFTS: EventRule = { skip: "shift planning is not used in Zuper here" };
const ATTACHMENT: EventRule = { skip: "files attached to this kind of record are not synced (job files and note files are)" };
const NO_STATE: (what: string) => EventRule = (what) => ({ skip: `${what} changes nothing on the record` });

/** The passes after `jobs` for every job change. */
export const JOB_ENRICH = ["job_details", "job_activity"];

const MODULES: Record<string, ModuleSpec> = {
  JOB: {
    label: "Jobs",
    // `jobs` creates or updates the row from GET /api/jobs/{uid} — safe, because the
    // detail carries organization, skills and parent_job, which a LIST row lacks.
    entity: "jobs",
    enrich: JOB_ENRICH,
    uidFields: ["job_uid"],
    events: {
      "job.new": ["New Job"],
      "job.update": ["Update Job"],
      "job.schedule": ["Schedule Job"],
      "job.update_schedule": ["Reschedule Job"],
      "job.assign_users": ["Assign Users"],
      "job.unassign_users": ["Unassign Users"],
      "job.assign_teams": ["Assign Teams"],
      "job.unassign_teams": ["Unassign Teams"],
      "job.update_acceptance": ["Job Accept / Reject"],
      "job.status_update": ["Status Update"],
      "job.status_rollback": ["Status Rollback"],
      "job.status_delete": ["Status Delete"],
      "job.feedback": ["Job Feedback"],
      "job.new_note": ["New Note", NOTE("job")],
      "job.update_note": ["Update Note", NOTE("job")],
      "job.delete_note": ["Delete Note", NOTE_DELETE("job")],
      "job.delete": ["Delete Job", DELETE],
      "job.bulk_action": ["Job Bulk Action"],
      // Checklist answers ride on the status history both entities rebuild.
      "job.update_checklist": ["Update Job Checklist"],
      "job.recurring_update": ["Update Recurring Job"],
      "job.update_recurrence": ["Update Recurring Job Rule"],
      "job.new_recurrence": ["New Recurring Job"],
      // Deletes the recurrence rule, not the job.
      "job.delete_recurrence": ["Delete Recurring Job"],
      "job.status_alert": ["Status Alert", NO_STATE("sending an alert")],
      // A punch also sets the job's actual start/end, so it re-reads the whole job; job_activity writes the log.
      "job.timelog_update": ["Update Job Timelog"],
      "job.timelog": ["Create Job Timelog"],
      // None of 12,000 jobs changed since 2025 carried a line item (checked 2026-09-17), and Tuper's own job
      // line items would be replaced by Zuper's empty list - so these stay out until someone uses them.
      "job.product_update": ["Update Job Product", { skip: "Zuper jobs here carry no line items; syncing them would replace Tuper's" }],
      // The job's own files are linked on a full re-read. A removal is not synced.
      "job.new_attachment": ["New Job Attachment"],
      "job.update_attachment": ["Update Job Attachment"],
      "job.delete_attachment": ["Delete Job Attachment", { skip: "removing a job attachment is not synced" }],
      "job.new_message": ["New Job Message", { skip: "job chat is Stream Chat and was never imported" }],
      "measurement.new": ["New Measurement", { skip: "measurements have no sync entity" }],
      "measurement.update": ["Measurement Updated", { skip: "measurements have no sync entity" }],
      "measurement.status_update": ["Measurement Status Updated", { skip: "measurements have no sync entity" }],
      "measurement.delete": ["Measurement Deleted", { skip: "measurements have no sync entity" }],
    },
  },

  CUSTOMER: {
    label: "Customers",
    // Zuper has no customer delete — only deactivate, which is a field change.
    entity: "customers",
    uidFields: ["customer_uid"],
    events: {
      "customer.create": ["New Customer"],
      "customer.update": ["Customer Update"],
      "customer.deactivate": ["Customer Deactivate"],
      "customer.activate": ["Customer Activate"],
      "customer.accounts_update": ["Customer Accounts Update"],
      "customer.update_technician": ["Favourite Technician Update"],
      "customer.new_note": ["New Note", NOTE("customer")],
      "customer.update_note": ["Update Note", NOTE("customer")],
      "customer.delete_note": ["Delete Note", NOTE_DELETE("customer")],
      "customer.add_card": ["New Customer Card", { skip: "payment cards are not synced" }],
      "customer.delete_card": ["Remove Customer Card", { skip: "payment cards are not synced" }],
      "customer.new_attachment": ["New Customer Attachment", ATTACHMENT],
      "customer.delete_attachment": ["Delete Customer Attachment", ATTACHMENT],
      "customer.update_attachment": ["Update Customer Attachment", ATTACHMENT],
      "customer.bulk_action": ["Customer Bulk Action"],
    },
  },

  ORGANIZATION: {
    label: "Organizations",
    entity: "organizations",
    uidFields: ["organization_uid"],
    events: {
      "organization.new": ["New Organization"],
      "organization.update": ["Organization Update"],
      "organization.delete": ["Organization Delete", DELETE],
      "organization.bulk_action": ["Organization Bulk Action"],
      "organization.assign_users": ["Assign Users"],
      "organization.unassign_users": ["Unassign Users"],
      "organization.new_attachment": ["New Organization Attachment", ATTACHMENT],
      "organization.update_attachment": ["Update Organization Attachment", ATTACHMENT],
      "organization.delete_attachment": ["Delete Organization Attachment", ATTACHMENT],
      "import.organization": ["Import Organization", { skip: "a bulk import notice carries no single record" }],
    },
  },

  PROPERTY: {
    label: "Properties",
    // A separate Zuper record, not an organization. No importer exists, and this
    // account has exactly one property.
    entity: "properties",
    uidFields: ["property_uid"],
    skipAll: "properties have no importer (this account has one)",
    events: {
      "property.new": ["New Property"],
      "property.update": ["Update Property"],
      "property.activate": ["Property Activate"],
      "property.deactivate": ["Property Deactivate"],
      "property.delete": ["Property Delete"],
      "property.bulk_action": ["Property Bulk Action"],
      "property.assign_users": ["Assign Users"],
      "property.unassign_users": ["Unassign Users"],
      "property.new_attachment": ["New Property Attachment"],
      "property.update_attachment": ["Update Property Attachment"],
      "property.delete_attachment": ["Delete Property Attachment"],
    },
  },

  TIMESHEET: {
    label: "Timesheets",
    // One Zuper module spanning punches, approvals, time off, shifts and GPS. None
    // has a read-by-uid, so punches and time off re-read the recent part of their
    // list (collections.ts); no uid is needed.
    entity: "timesheets",
    uidFields: [],
    skipUncatalogued: "an uncatalogued timesheet event has no known list to re-read",
    events: {
      "timesheet.check_in": ["Timesheet Check In", PUNCHES],
      "timesheet.check_out": ["Timesheet Check Out", PUNCHES],
      "timesheet.break": ["Timesheet Break", PUNCHES],
      "timesheet.resume_work": ["Timesheet Resume Work", PUNCHES],
      "timesheet.bulk_check_in": ["Timesheet Bulk Check In", PUNCHES],
      "timesheet.bulk_check_out": ["Timesheet Bulk Check Out", PUNCHES],
      "timesheet.bulk_resume_work": ["Timesheet Bulk Resume Work", PUNCHES],
      "timesheet.bulk_break": ["Timesheet Bulk Break", PUNCHES],
      "timesheet.update": ["Timesheet Update", PUNCHES],
      "timesheet.day_activity": ["Timesheet Day Activity", PUNCHES],
      "timesheet.delete": ["Timesheet Delete", { skip: "a deleted punch stays in Tuper — the table keeps no deleted flag" }],
      "timesheet.new_timeoff": ["New Timeoff", TIMEOFF],
      "timesheet.approve_timeoff": ["Approve Timeoff", TIMEOFF],
      "timesheet.reject_timeoff": ["Reject Timeoff", TIMEOFF],
      "timesheet.update_timeoff": ["Update Timeoff", TIMEOFF],
      "timesheet.delete_timeoff": ["Delete Timeoff", { skip: "a deleted time off request stays in Tuper — the table keeps no deleted flag" }],
      "timesheet.new_timeoff_type": ["New Timeoff Type", TIMEOFF_TYPES],
      "timesheet.edit_timeoff_type": ["Edit Timeoff Type", TIMEOFF_TYPES],
      "timesheet.delete_timeoff_type": ["Delete Timeoff Type", TIMEOFF_TYPES],
      "timesheet_approval.new": ["New Timesheet Approval", NOT_KEPT("timesheet approvals")],
      "timesheet_approval.update": ["Update Timesheet Approval", NOT_KEPT("timesheet approvals")],
      "timesheet_approval.delete": ["Delete Timesheet approval", NOT_KEPT("timesheet approvals")],
      "timesheet_approval.status_update": ["Timesheet Approval Status Update", NOT_KEPT("timesheet approvals")],
      "timesheet.new_location": ["Timesheet New Location", NOT_KEPT("timesheet locations")],
      "timesheet.edit_location": ["Timesheet Edit Location", NOT_KEPT("timesheet locations")],
      "timesheet.delete_location": ["Timesheet Delete Location", NOT_KEPT("timesheet locations")],
      "timesheet.employee_location_create": ["New Timesheet Location", NOT_KEPT("timesheet locations")],
      "timesheet.employee_location_delete": ["Delete Timesheet Location", NOT_KEPT("timesheet locations")],
      "timesheet.new_timeoff_availability": ["New Timeoff Availability", NOT_KEPT("time off availability")],
      "timesheet.edit_timeoff_availability": ["Edit Timeoff Availability", NOT_KEPT("time off availability")],
      "timesheet.delete_timeoff_availability": ["Delete Timeoff Availability", NOT_KEPT("time off availability")],
      // No shift is scheduled in Zuper from Sep to Dec 2026 (checked 2026-09-17).
      "timesheet.user_shift_create": ["New User Shift", SHIFTS],
      "timesheet.user_shift_delete": ["Delete User Shift", SHIFTS],
      "timesheet.master_shift_create": ["Timesheet Master Shift Create", SHIFTS],
      "timesheet.master_shift_update": ["Timesheet Master Shift Updating", SHIFTS],
      "timesheet.master_shift_delete": ["Timesheet Master Shift Delete", SHIFTS],
    },
  },

  PRODUCTS: {
    label: "Products",
    entity: "products",
    uidFields: ["product_uid"],
    events: {
      "product.new": ["New Product"],
      "product.update": ["Product Update"],
      "product.delete": ["Product Delete", DELETE],
      "product.location_new": ["New Product Location", { skip: "product locations are only readable as a whole list" }],
      "product.location_update": ["Product Location Update", { skip: "product locations are only readable as a whole list" }],
      "product.location_delete": ["Product Location Delete", { skip: "product locations are only readable as a whole list" }],
      // "transcation" is Zuper's spelling, kept because it is what arrives.
      "product.transcation_inward": ["Product Transaction Inward", { skip: "Zuper has no GET by transaction uid" }],
      "product.transcation_outward": ["Product Transaction Outward", { skip: "Zuper has no GET by transaction uid" }],
      "product.transcation_transfer": ["Product Transaction Transfer", { skip: "Zuper has no GET by transaction uid" }],
      "product.consumption": ["Product Consumption", { skip: "Zuper has no GET by transaction uid" }],
      "product.update_stock": ["Update Product Stock"],
      "product.bulk_action": ["Product Bulk Action"],
    },
  },

  ESTIMATES: {
    label: "Quotes",
    entity: "estimates",
    uidFields: ["estimate_uid"],
    events: {
      "estimate.new": ["New Quote"],
      "estimate.update": ["Quote Update"],
      "estimate.status_update": ["Quote Status Update"],
      "estimate.deposit": ["Quote Deposit Payment"],
      "estimate.print": ["Print Quote", NO_STATE("printing")],
      "estimate.send": ["Send Quote"],
      "estimate.new_note": ["Quote New Note", NO_NOTES],
      "estimate.new_attachment": ["Quote New Attachment", ATTACHMENT],
      "estimate.delete_attachment": ["Quote Delete Attachment", ATTACHMENT],
      "estimate.delete_note": ["Quote Delete Note", NO_NOTES],
      "estimate.delete": ["Quote Delete", DELETE],
      "estimate.bulk_action": ["Quote Bulk Action"],
      // Undelete: re-reading restores is_deleted from Zuper.
      "estimate.recover": ["Quote Recover"],
    },
  },

  INVOICE: {
    label: "Invoices",
    entity: "invoices",
    uidFields: ["invoice_uid"],
    events: {
      "invoice.new": ["New Invoice"],
      "invoice.update": ["Invoice Update"],
      "invoice.status_update": ["Invoice Status Update"],
      "invoice.payment": ["Invoice Payment"],
      "invoice.print": ["Print Invoice", NO_STATE("printing")],
      "invoice.send": ["Send Invoice"],
      "invoice.new_note": ["Invoice New Note", NO_NOTES],
      "invoice.new_attachment": ["Invoice Attachment", ATTACHMENT],
      "invoice.delete_attachment": ["Invoice Delete Attachment", ATTACHMENT],
      "invoice.delete_note": ["Invoice Delete Note", NO_NOTES],
      "invoice.delete": ["Invoice Delete", DELETE],
      "invoice.bulk_action": ["Invoice Bulk Action"],
      // Company-level payment settings, not an invoice.
      "invoice.payment_mode_create": ["Invoice New Payment Mode", { skip: "payment modes are company settings, not invoices" }],
      "invoice.payment_mode_update": ["Invoice Update Payment Mode", { skip: "payment modes are company settings, not invoices" }],
      "invoice.payment_mode_delete": ["Invoice Delete Payment Mode", { skip: "payment modes are company settings, not invoices" }],
      "invoice.payment_term_create": ["Invoice New Payment Term", { skip: "payment terms are company settings, not invoices" }],
      "invoice.payment_term_update": ["Invoice Update Payment Term", { skip: "payment terms are company settings, not invoices" }],
      "invoice.payment_term_delete": ["Invoice Delete Payment Term", { skip: "payment terms are company settings, not invoices" }],
      "invoice.update_note": ["Invoice Update Note", NO_NOTES],
    },
  },

  SERVICE_CONTRACTS: {
    label: "Contracts",
    // Zuper's own API calls this contract_uid; the body is undocumented, so both.
    entity: "contracts",
    uidFields: ["service_contract_uid", "contract_uid"],
    events: {
      "service_contract.new": ["New Service Contract"],
      "service_contract.update": ["Service Contract Update"],
      "service_contract.delete": ["Service Contract Delete", DELETE],
      "service_contract.status_update": ["Service Contract Status Update"],
      "service_contract.renew": ["Service Contract Renewal"],
      "service_contract.new_note": ["Service Contract New Note", NO_NOTES],
      "service_contract.delete_note": ["Service Contract Delete Note", NO_NOTES],
      "service_contract.update_note": ["Service Contract Update Note", NO_NOTES],
      "service_contract.bulk_action": ["Service Contract Bulk Action"],
      "service_contract.activate": ["Service Contract Activate"],
      "service_contract.deactivate": ["Service Contract Deactivate"],
    },
  },

  ASSETS: {
    label: "Assets",
    entity: "assets",
    uidFields: ["asset_uid"],
    events: {
      "asset.new": ["New Asset"],
      "asset.update": ["Asset Update"],
      "asset.delete": ["Asset Delete", DELETE],
      "asset.activate": ["Asset activate"],
      "asset.deactivate": ["Asset Deactivate"],
      "asset.new_attachment": ["New Asset Attachment", ATTACHMENT],
      // "Aseet" is Zuper's typo in the display name; the keys are spelled correctly.
      "asset.delete_attachment": ["Delete Aseet Attachment", ATTACHMENT],
      "asset.update_attachment": ["Update Aseet Attachment", ATTACHMENT],
      "asset.bulk_action": ["Asset Bulk Action"],
      "asset.status_update": ["Asset Status Update"],
      "asset.history": ["Asset History"],
      "asset.recover": ["Asset Recover"],
      "asset.new_note": ["Asset New Note", NOTE("asset")],
      "asset.update_note": ["Asset Update Note", NOTE("asset")],
      "asset.delete_note": ["Asset Delete Note", NOTE_DELETE("asset")],
      "inspection_form.submit": ["Inspection Form Submission", { skip: "filling inspections is not built" }],
      "inspection_form.update": ["Inspection Form Update", { skip: "filling inspections is not built" }],
    },
  },

  USER: {
    label: "Users",
    entity: "users",
    uidFields: ["user_uid"],
    events: {
      "user.resource_create": ["New User Resource", { skip: "user resources are not synced" }],
      "user.resource_delete": ["User Resource Delete", { skip: "user resources are not synced" }],
      "user.resource_edit": ["User Resource Update", { skip: "user resources are not synced" }],
      "user.trigger_sos": ["User Sos Trigger", NO_STATE("an SOS alert")],
      "user.activate": ["User Activate"],
      "user.deactivate": ["User Deactivate"],
      "user.delete": ["User Delete", DELETE],
      "user.new": ["New User"],
      "user.update": ["User Update"],
      "user.work_hours_update": ["User Work Hours Update"],
      "user.login": ["User Login", NO_STATE("a login")],
      "user.recover": ["User Recover"],
      "user.add_skill": ["User New Skill"],
      "user.remove_skill": ["User Delete Skill"],
      "user.update_skill": ["User Update Skill"],
      "user.preference_edit": ["User Preference Update", { skip: "Zuper-side UI preferences are not synced" }],
    },
  },

  REQUEST: {
    label: "Requests",
    entity: "requests",
    uidFields: ["request_uid"],
    events: {
      "request.new": ["New Request"],
      "request.update": ["Update Request"],
      "request.status_update": ["Update request status"],
      "request.status_rollback": ["Status Rollback"],
      "request.assign_users": ["Assign Users"],
      "request.unassign_users": ["Unassign Users"],
      "request.new_note": ["New Note", NOTE("request")],
      "request.delete": ["Delete Request", DELETE],
    },
  },
};

/** Zuper's wire module names. */
export const MODULE_NAMES = Object.keys(MODULES);

/** Every event Zuper can send, by wire module, as wire keys. */
export const EVENT_CATALOGUE: Record<string, string[]> = Object.fromEntries(
  Object.entries(MODULES).map(([m, s]) => [m, Object.keys(s.events)]),
);

export const EVENT_COUNT = Object.values(EVENT_CATALOGUE).reduce((n, e) => n + e.length, 0);

/** Case/spacing/punctuation-insensitive: "job.update", "JOB_UPDATE", "Job Update". */
const norm = (s: string) => String(s ?? "").toLowerCase().replace(/[\s_\-/.]+/g, "");

/** Wire key → its module. Keys are globally unique; check-wire-routes asserts it. */
const EVENT_INDEX = new Map<string, { module: string; key: string }>();
for (const [module, spec] of Object.entries(MODULES)) {
  for (const key of Object.keys(spec.events)) EVENT_INDEX.set(norm(key), { module, key });
}

/**
 * Other spellings of a module → its wire name: the form labels, singulars, and the
 * key prefixes (used only for events Zuper adds after the catalogue was captured).
 * `measurement` is deliberately absent — measurements have nowhere to go, so an
 * unknown measurement event should be unroutable, not a job re-sync.
 */
const MODULE_ALIASES: Record<string, string> = {
  job: "JOB", jobs: "JOB",
  customer: "CUSTOMER", customers: "CUSTOMER",
  organization: "ORGANIZATION", organizations: "ORGANIZATION",
  property: "PROPERTY", properties: "PROPERTY",
  timesheet: "TIMESHEET", timesheets: "TIMESHEET", timesheetapproval: "TIMESHEET",
  product: "PRODUCTS", products: "PRODUCTS",
  estimate: "ESTIMATES", estimates: "ESTIMATES", quote: "ESTIMATES", quotes: "ESTIMATES",
  invoice: "INVOICE", invoices: "INVOICE",
  servicecontract: "SERVICE_CONTRACTS", servicecontracts: "SERVICE_CONTRACTS",
  contract: "SERVICE_CONTRACTS", contracts: "SERVICE_CONTRACTS",
  asset: "ASSETS", assets: "ASSETS", inspectionform: "ASSETS",
  user: "USER", users: "USER",
  request: "REQUEST", requests: "REQUEST",
};

function build(module: string, rule: EventRule | undefined, inferred: boolean): Route {
  const spec = MODULES[module];
  const entity = rule?.entity ?? spec.entity;
  const fetchSpec = ENTITY_FETCH[entity] ?? { mode: "unsupported" as FetchMode, reason: `no fetch strategy for "${entity}"` };
  const deletion = rule?.deletion === true;
  const skip = rule?.skip
    ?? spec.skipAll
    ?? (!rule && inferred ? spec.skipUncatalogued : undefined)
    // A deletion needs no fetch, so an unsupported read does not block it.
    ?? (fetchSpec.mode === "unsupported" && !deletion ? fetchSpec.reason : undefined);
  return {
    module,
    entity,
      // An override points at a different entity (notes), so the module's second
    // pass must not follow it. Nor does a deletion need one.
    enrich: rule?.entity || deletion ? undefined : spec.enrich,
    noteHost: rule?.noteHost,
    collection: rule?.collection,
    uidFields: rule?.uidFields ?? spec.uidFields,
    fetch: fetchSpec.mode,
    detail: fetchSpec.mode === "detail" ? fetchSpec.path ?? null : null,
    deletion,
    skip,
    inferred,
  };
}

/**
 * Resolve a delivery to a route.
 *
 * 1. A catalogued event key wins outright — keys are unique, and a real delivery
 *    has no module field to consult anyway.
 * 2. Otherwise a known module plus a display name (older synthetic deliveries and
 *    the simulator send those).
 * 3. Otherwise a known module — from the delivery, or the key's prefix — with an
 *    uncatalogued event means "this record changed": re-read it.
 * 4. Otherwise null, so the delivery is stored as unroutable rather than sent to a
 *    default entity that would write the wrong table.
 */
export function resolveRoute(module: string, event: string): Route | null {
  const hit = EVENT_INDEX.get(norm(event));
  if (hit) return build(hit.module, MODULES[hit.module].events[hit.key][1], false);

  const fromModule = MODULE_ALIASES[norm(module)] ?? MODULE_NAMES.find((m) => norm(m) === norm(module));
  if (fromModule) {
    const byName = Object.values(MODULES[fromModule].events).find(([name]) => norm(name) === norm(event));
    return build(fromModule, byName?.[1], !byName);
  }

  const prefix = String(event ?? "").split(".")[0];
  const fromPrefix = MODULE_ALIASES[norm(prefix)];
  return fromPrefix ? build(fromPrefix, undefined, true) : null;
}

/** Events that will not be synced, and why — so the log UI can show it plainly. */
export function unroutedEvents(): { module: string; event: string; reason: string }[] {
  const out: { module: string; event: string; reason: string }[] = [];
  for (const [module, spec] of Object.entries(MODULES)) {
    for (const key of Object.keys(spec.events)) {
      const r = resolveRoute(module, key);
      if (r?.skip) out.push({ module, event: key, reason: r.skip });
    }
  }
  return out;
}
