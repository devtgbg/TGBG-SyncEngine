/**
 * What a webhook says changed, in words.
 *
 * Zuper publishes no payload schema, so every shape here was read off real
 * deliveries (2026-09-17) and every access is guarded: an event this file has
 * never seen falls through to a plain list of the simple fields in the body, and
 * a field that is missing is left out rather than guessed at.
 *
 * This describes the WEBHOOK, not the write. Zupersync treats a delivery as a
 * trigger and re-reads the record from Zuper, so what reached jms.* is the
 * record as it stood a moment later: usually the same thing, not always.
 *
 * What Zuper sends differs by event, and the view is only as good as that:
 *   reschedules        the previous AND the new times
 *   *.update           the names of the changed fields, with new values only
 *   status, note, ...  the new state only
 */

export interface Change { label: string; before?: string; after: string }
export interface Described { headline: string; changes: Change[]; notes: string[] }

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

export const dubaiTime = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Dubai", weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** job_title becomes "Job title"; a.b becomes "A · b". */
const label = (key: string) =>
  key.split(".").map((part) => part.replace(/_/g, " ").trim()).filter(Boolean)
    .map((part, i) => (i === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part)).join(" · ");

const ADDRESS_PARTS = ["street", "landmark", "city", "state", "country", "zip_code"];

/** A value as a person would read it. Never throws, whatever Zuper sent. */
export function show(v: unknown, names: Record<string, string> = {}): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    if (UID.test(v)) return names[v] ? `${names[v]} (${v})` : v;
    if (TIME.test(v) && !Number.isNaN(Date.parse(v))) return `${dubaiTime(v)} (Dubai)`;
    return v;
  }
  if (Array.isArray(v)) {
    if (!v.length) return "none";
    if (v.every((x) => typeof x !== "object" || x === null)) return v.map((x) => show(x, names)).join(", ");
    return v.map((x) => show(x, names)).join("; ");
  }
  if (isObj(v)) {
    const person = [str(v.first_name), str(v.last_name)].filter(Boolean).join(" ");
    const address = ADDRESS_PARTS.map((k) => str(v[k])).filter(Boolean).join(", ");
    if (address) return person ? `${person}, ${address}` : address;
    if (person) return person;
    for (const k of ["status_name", "asset_name", "skill_name", "label", "name", "note"]) if (str(v[k])) return str(v[k]);
    const flat = Object.entries(v).filter(([, x]) => typeof x !== "object" || x === null).map(([k, x]) => `${label(k)}: ${show(x, names)}`);
    if (flat.length) return flat.slice(0, 8).join(", ");
    return `${Object.keys(v).length} nested field(s)`;
  }
  return String(v);
}

/** A dotted path, looked up in the body and then in the record nested inside it. */
function lookup(body: Obj, path: string): unknown {
  for (const root of [body, obj(body.asset), obj(body.customer), obj(body.job)]) {
    let cur: unknown = root;
    for (const part of path.split(".")) cur = isObj(cur) ? cur[part] : undefined;
    if (cur !== undefined) return cur;
  }
  return undefined;
}

/** Every Zuper user uid the body mentions, so the caller can fetch their names once. */
export function userUidsIn(body: unknown): string[] {
  const b = obj(body);
  const out = new Set<string>();
  const add = (v: unknown) => { if (typeof v === "string" && UID.test(v)) out.add(v); };
  add(b.user_uid);
  if (Array.isArray(b.user_uid)) b.user_uid.forEach(add);
  for (const k of ["assigned_users", "unassigned_users"]) if (Array.isArray(b[k])) (b[k] as unknown[]).forEach((u) => add(obj(u).user_uid));
  return [...out];
}

/** Envelope fields: about the delivery, not about the record. */
const ENVELOPE = new Set(["event", "company_uid", "max_retries", "retry_count", "triggered_at", "triggered_by", "workflow_builder", "__v", "_id", "id", "updated_fields"]);

const push = (list: Change[], l: string, after: unknown, names: Record<string, string>, before?: unknown) => {
  if (after === undefined && before === undefined) return;
  list.push({ label: l, after: show(after, names), ...(before !== undefined ? { before: show(before, names) } : {}) });
};

export function describe(event: string | null, body: unknown, names: Record<string, string> = {}): Described {
  const b = obj(body);
  const ev = (event ?? str(b.event)).toLowerCase();
  const changes: Change[] = [];
  const notes: string[] = [];
  const wo = str(b.work_order_number);
  const job = wo ? `job ${wo}` : "the job";
  const who = (uid: unknown) => (typeof uid === "string" ? names[uid] ?? uid : "");
  const people = (list: unknown) => (Array.isArray(list) ? list.map((u) => who(obj(u).user_uid)).filter(Boolean) : []);

  if (b._unparsed !== undefined) {
    return { headline: "The body could not be read as JSON", changes: [{ label: "Parse error", after: show(b._parse_error) }], notes: ["It was stored as received and never processed."] };
  }

  if (ev === "job.update_schedule") {
    push(changes, "Start", b.scheduled_start_time, names, b.prev_scheduled_start_time ?? null);
    push(changes, "End", b.scheduled_end_time, names, b.prev_scheduled_end_time ?? null);
    if (b.all_day_schedule !== undefined) push(changes, "All day", b.all_day_schedule, names);
    if (str(b.reason)) push(changes, "Reason", b.reason, names);
    return { headline: `Rescheduled ${job}`, changes, notes };
  }

  if (ev === "job.status_update" || ev === "job.status_rollback") {
    const s = obj(b.status);
    push(changes, "Status", [str(s.status_name), str(s.status_type) && `(${str(s.status_type)})`].filter(Boolean).join(" ") || undefined, names);
    if (str(b.remarks) || str(s.remarks)) push(changes, "Remarks", str(b.remarks) || str(s.remarks), names);
    if (str(b.remarks_free_text)) push(changes, "Free-text remarks", b.remarks_free_text, names);
    if (s.eta) push(changes, "ETA", s.eta, names);
    if (Array.isArray(s.checklist) && s.checklist.length) push(changes, "Checklist", `${s.checklist.length} answer(s) sent with the status`, names);
    notes.push("Zuper sends the new status only, not the one it replaced.");
    return { headline: `${ev.endsWith("rollback") ? "Status rolled back to" : "Status set to"} "${str(s.status_name) || "?"}" on ${job}`, changes, notes };
  }

  if (ev === "job.feedback") {
    push(changes, "Rating", b.rating, names);
    push(changes, "Feedback", b.feedback, names);
    return { headline: "Customer feedback received", changes, notes };
  }

  if (ev === "job.assign_users" || ev === "job.unassign_users") {
    const added = ev === "job.assign_users";
    const list = people(added ? b.assigned_users : b.unassigned_users);
    push(changes, added ? "Assigned" : "Unassigned", list.length ? list : "nobody named", names);
    return { headline: `${added ? "Assigned" : "Unassigned"} ${list.length || "no"} ${list.length === 1 ? "person" : "people"}`, changes, notes };
  }

  if (ev === "job.update_acceptance") {
    push(changes, "Response", b.type, names);
    push(changes, "By", who(b.user_uid) || undefined, names);
    return { headline: `Job ${str(b.type).toLowerCase() || "acceptance changed"}`, changes, notes };
  }

  if (ev.endsWith("_note") || ev.endsWith(".note")) {
    const n = obj(b.note);
    // Zuper sends the note as the editor's HTML; the words are what someone wants to read.
    const text = str(n.note).replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, "\n").replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, "\n\n").trim();
    push(changes, "Note", text || undefined, names);
    if (!text && str(b.note_uid)) push(changes, "Note id", b.note_uid, names);
    if (n.is_private !== undefined) push(changes, "Private", n.is_private, names);
    if (Array.isArray(n.attachments)) push(changes, "Attachments", n.attachments.length, names);
    return { headline: ev.includes("delete") ? "Note deleted" : ev.includes("update") ? "Note edited" : "Note added", changes, notes };
  }

  if (ev === "job.update_checklist") {
    push(changes, "At status", b.status_name, names);
    for (const item of Array.isArray(b.checklist) ? b.checklist : []) {
      const q = str(obj(item).question);
      if (q) push(changes, q, obj(item).answer ?? null, names);
    }
    return { headline: `Checklist filled in on ${job}`, changes, notes };
  }

  if (ev.startsWith("job.timelog")) {
    push(changes, "Punch", b.type, names);
    push(changes, "At", b.time, names);
    push(changes, "Person", b.user, names);
    const kind = str(b.type).replace(/_/g, " ").toLowerCase() || "time log";
    return { headline: kind.charAt(0).toUpperCase() + kind.slice(1), changes, notes };
  }

  if (ev.endsWith(".delete")) return { headline: "Deleted in Zuper", changes, notes: ["The record is marked deleted in jms.*, not removed."] };

  // *.update: Zuper names the fields and sends the record as it now stands.
  if (Array.isArray(b.updated_fields)) {
    for (const f of b.updated_fields as unknown[]) {
      const key = str(f);
      if (!key) continue;
      const v = lookup(b, key);
      changes.push({ label: label(key), after: v === undefined ? "changed (the webhook does not carry the new value)" : show(v, names) });
    }
    notes.push("Zuper names the fields that changed and sends their new values. It does not send the old ones.");
    return { headline: `${changes.length} field${changes.length === 1 ? "" : "s"} changed`, changes, notes };
  }

  if (ev === "job.new") {
    push(changes, "Title", b.job_title, names);
    push(changes, "Category", b.job_category, names);
    push(changes, "Priority", b.job_priority, names);
    push(changes, "Type", b.job_type, names);
    push(changes, "Status", obj(b.current_job_status).status_name, names);
    push(changes, "Start", b.scheduled_start_time, names);
    push(changes, "End", b.scheduled_end_time, names);
    push(changes, "Due", b.due_date, names);
    push(changes, "Address", b.customer_address, names);
    return { headline: `New ${job}`, changes, notes };
  }

  if (ev === "customer.create") {
    push(changes, "Name", [str(b.customer_first_name), str(b.customer_last_name)].filter(Boolean).join(" ") || undefined, names);
    push(changes, "Email", b.customer_email, names);
    push(changes, "Phone", b.customer_contact_no, names);
    return { headline: "New customer", changes, notes };
  }

  if (ev === "asset.new") {
    const a = obj(b.asset);
    push(changes, "Name", a.asset_name, names);
    push(changes, "Code", a.asset_code, names);
    push(changes, "Status", a.asset_status, names);
    return { headline: "New asset", changes, notes };
  }

  // Anything else: the simple fields of the body, as sent.
  for (const [k, v] of Object.entries(b)) {
    if (ENVELOPE.has(k) || (typeof v === "object" && v !== null)) continue;
    push(changes, label(k), v, names);
  }
  notes.push("No specific view for this event yet, so these are the simple fields of the body as sent.");
  return { headline: event ?? "Delivery", changes, notes };
}
