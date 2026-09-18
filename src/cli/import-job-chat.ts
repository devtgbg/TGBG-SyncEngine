/**
 * Import a job's Internal Chat from Zuper.
 *
 *   npx tsx src/cli/import-job-chat.ts [--apply] [--limit 500] [--all]
 *
 * Zuper keeps these apart from a job's notes (GET /api/messaging/message?job_uid=…), and Tuper keeps them in the same
 * threads table its own chat uses — jms.entity_comments, entity_type 'job_chat'. A message already imported is
 * recognised by its Zuper uid and left alone, so a second run adds only what is new. Zuper is read.
 *
 * Every job has to be asked, because Zuper's messaging list takes no filter but a job. Of 60 recent GBG jobs, two
 * carried a message, so most of the asking finds nothing — it is still the only way to find the ones that do.
 */
import { tuper as db } from "../tuper-client.js";
import { config } from "../config.js";

const apply = process.argv.includes("--apply");
const all = process.argv.includes("--all");
const limitAt = process.argv.indexOf("--limit");
const LIMIT = limitAt > 0 ? Number(process.argv[limitAt + 1]) || 200 : 200;
const client = db();
const tenantId = config.tenantId;

async function zuper(path: string): Promise<any | null> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(config.zuper.apiUrl + path, {
        headers: { "x-api-key": config.zuper.apiKey, "content-type": "application/json" },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as any;
    } catch (e) {
      if (attempt === 4) return null;
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  return null;
}

/** Where a run has got to, so --all can carry on from there rather than asking about the same jobs again. */
async function alreadyAsked(): Promise<Set<string>> {
  const asked = new Set<string>();
  for (let page = 0; ; page++) {
    const { data } = await client.schema("jms").from("zuper_sync_map")
      .select("zuper_uid").eq("tenant_id", tenantId).eq("entity", "job_chat_asked")
      .range(page * 1000, page * 1000 + 999);
    const rows = (data ?? []) as any[];
    for (const r of rows) asked.add(r.zuper_uid);
    if (rows.length < 1000) break;
  }
  return asked;
}

const users = new Map<string, string>();
{
  for (let page = 0; ; page++) {
    const { data } = await client.schema("jms").from("zuper_sync_map")
      .select("zuper_uid, jms_id").eq("tenant_id", tenantId).eq("entity", "users").range(page * 1000, page * 1000 + 999);
    const rows = (data ?? []) as any[];
    for (const r of rows) users.set(r.zuper_uid, r.jms_id);
    if (rows.length < 1000) break;
  }
}

let round = 0, asked = 0, found = 0, written = 0;
const seen = await alreadyAsked();
while (true) {
  round++;
  const { data: rows, error } = await client.schema("jms").from("jobs")
    .select("id").eq("tenant_id", tenantId).is("deleted_at", null)
    .order("created_at", { ascending: false }).limit(LIMIT + seen.size > 1000 ? 1000 : LIMIT);
  if (error) throw error;
  const jobIds = ((rows ?? []) as any[]).map((r) => r.id as string);

  // each job's Zuper uid, 60 at a time
  const uidOf = new Map<string, string>();
  for (let i = 0; i < jobIds.length; i += 60) {
    const { data: m } = await client.schema("jms").from("zuper_sync_map")
      .select("zuper_uid, jms_id").eq("tenant_id", tenantId).eq("entity", "jobs").in("jms_id", jobIds.slice(i, i + 60));
    for (const r of (m ?? []) as any[]) uidOf.set(r.jms_id, r.zuper_uid);
  }

  const todo = jobIds.filter((id) => uidOf.get(id) && !seen.has(uidOf.get(id)!)).slice(0, LIMIT);
  if (!todo.length) { console.log("nothing left to ask about"); break; }

  for (const jobId of todo) {
    const uid = uidOf.get(jobId)!;
    asked++;
    seen.add(uid);
    const answer = await zuper(`/api/messaging/message?job_uid=${uid}&limit=100&page=1`);
    const messages: any[] = answer?.data ?? [];
    if (apply) {
      await client.schema("jms").from("zuper_sync_map").upsert(
        { tenant_id: tenantId, entity: "job_chat_asked", zuper_uid: uid, jms_id: jobId, synced_at: new Date().toISOString() },
        { onConflict: "tenant_id,entity,zuper_uid" });
    }
    if (!messages.length) continue;
    found += messages.length;

    // what is already here, by Zuper's own uid
    const { data: have } = await client.schema("jms").from("entity_comments")
      .select("zuper_uid").eq("tenant_id", tenantId).eq("entity_type", "job_chat").eq("entity_id", jobId);
    const known = new Set(((have ?? []) as any[]).map((r) => r.zuper_uid).filter(Boolean));

    const fresh = messages
      .filter((m) => m.message_uid && !known.has(m.message_uid))
      .map((m) => ({
        tenant_id: tenantId, entity_type: "job_chat", entity_id: jobId,
        author_id: users.get(m.sender?.user_uid) ?? null,
        body: String(m.message ?? "").trim() || (m.attachement_url ? "(file)" : ""),
        created_at: m.created_at ?? new Date().toISOString(),
        zuper_uid: m.message_uid,
      }))
      .filter((r) => r.body);
    if (!fresh.length) continue;
    if (apply) {
      const { error: iErr } = await client.schema("jms").from("entity_comments").insert(fresh);
      if (iErr) throw iErr;
    }
    written += fresh.length;
    console.log(`  job ${jobId.slice(0, 8)}: ${fresh.length} message(s)`);
  }
  console.log(`round ${round}: asked about ${asked} jobs, ${found} found, ${written} written${apply ? "" : " (dry run)"}`);
  if (!all || !apply) break;
}
console.log(`\ndone: asked about ${asked} jobs, ${found} messages found, ${written} written`);
