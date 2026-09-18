/**
 * "Has anything changed?" — what the open page asks every few seconds.
 *
 * Behind the sign-in like every other route (see middleware.ts); the browser
 * sends the Basic credentials it already holds. Returns a fingerprint and
 * nothing else, so a poll never moves customer data.
 */

import { pulse } from "@/lib/db";

export const dynamic = "force-dynamic";

const VIEWS = ["deliveries", "pushes", "calls"] as const;

export async function GET(req: Request) {
  const asked = new URL(req.url).searchParams.get("view");
  const view = VIEWS.find((v) => v === asked) ?? "deliveries";
  try {
    return Response.json({ v: await pulse(view) }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const e = err as { message?: string };
    return Response.json({ error: e?.message ?? String(err) }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
