/**
 * Sign-in for the whole dashboard.
 *
 * Every page here shows stored webhook bodies and planned Zuper requests, which
 * carry customer names, addresses and job details. HTTP Basic is enough for an
 * internal tool behind HTTPS and needs no user table; the pair comes from
 * DASHBOARD_USER / DASHBOARD_PASSWORD.
 *
 * In production an unset pair refuses every request rather than falling open.
 * Locally (next dev) it is allowed through, so the tool stays usable on
 * localhost without configuration.
 */

import { NextResponse, type NextRequest } from "next/server";

/** Compares without stopping at the first difference. */
function same(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export function middleware(req: NextRequest) {
  const user = process.env.DASHBOARD_USER ?? "";
  const pass = process.env.DASHBOARD_PASSWORD ?? "";

  if (!user || !pass) {
    if (process.env.NODE_ENV === "production") {
      return new NextResponse("Sign-in is not configured: set DASHBOARD_USER and DASHBOARD_PASSWORD.", { status: 503 });
    }
    return NextResponse.next();
  }

  const [scheme, encoded] = (req.headers.get("authorization") ?? "").split(" ");
  if (scheme === "Basic" && encoded) {
    let decoded = "";
    try { decoded = atob(encoded); } catch { /* malformed — treated as no credentials */ }
    const i = decoded.indexOf(":");
    // Both halves are always compared, so timing does not reveal which one was wrong.
    const userOk = i >= 0 && same(decoded.slice(0, i), user);
    const passOk = i >= 0 && same(decoded.slice(i + 1), pass);
    if (userOk && passOk) return NextResponse.next();
  }

  return new NextResponse("Sign in to see the Zupersync log.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Zupersync", charset="UTF-8"' },
  });
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
