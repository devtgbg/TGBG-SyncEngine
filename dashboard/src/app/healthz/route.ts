/**
 * Liveness for Coolify and Docker. Outside the sign-in (see middleware.ts), so it
 * says nothing beyond "the server answers" — no data, no database call.
 */

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true, service: "zupersync-dashboard" });
}
