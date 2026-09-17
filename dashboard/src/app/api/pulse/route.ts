/**
 * "Has anything changed?" — what the open page asks every few seconds.
 *
 * Behind the sign-in like every other route (see middleware.ts); the browser
 * sends the Basic credentials it already holds. Returns a fingerprint and
 * nothing else, so a poll never moves customer data.
 */

import { pulse } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const page = new URL(req.url).searchParams.get("view") === "pushes" ? "pushes" : "deliveries";
  try {
    return Response.json({ v: await pulse(page) }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const e = err as { message?: string };
    return Response.json({ error: e?.message ?? String(err) }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
