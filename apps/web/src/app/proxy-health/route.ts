import { NextResponse } from 'next/server';

// Ops diagnostic — same-origin /api proxy reachability (incident 2026-07-10 follow-up; see
// docs/ops/incident-2026-07-10-login-bounce-cross-site-cookie.md). Answers, from INSIDE the web
// container (the only place Railway private networking is visible), the question every blind
// rebuild-and-pray cycle was trying to answer: "can this web instance reach the API at <target>?"
//
//   GET /proxy-health                → tests the runtime API_PROXY_TARGET (note: the /api rewrite
//                                      itself is baked at BUILD time — if `configured_runtime` here
//                                      differs from what the proxy actually does, the last build is
//                                      stale and the service needs a REBUILD, not a restart)
//   GET /proxy-health?target=http://invisibleerp.railway.internal:8000
//                                    → tests any *.railway.internal target WITHOUT a rebuild
//
// Deliberately NOT under /api (that path segment is rewritten to the API). SSRF-safe by
// construction: the ?target override only accepts http://<name>.railway.internal[:port] — private
// addresses reachable solely from inside the project's own Railway network — and the response
// carries status/error codes only, never the upstream body. Internal hostnames are not secrets
// (they are derived from the service names); external targets are never echoed.
export const dynamic = 'force-dynamic';

const INTERNAL_TARGET = /^http:\/\/[a-z0-9-]+\.railway\.internal(:\d{2,5})?$/;

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get('target');
  const configured = (process.env.API_PROXY_TARGET ?? '').trim() || null;
  const override = q && INTERNAL_TARGET.test(q) ? q : null;
  const target = override ?? configured;

  const out: Record<string, unknown> = {
    checked_at: new Date().toISOString(),
    configured_runtime: configured && INTERNAL_TARGET.test(configured) ? configured : configured ? '(external target set — hidden)' : null,
    tested: override ?? (configured && INTERNAL_TARGET.test(configured) ? configured : configured ? '(configured external target)' : null),
    note: q && !override ? 'target param rejected — only http://<name>.railway.internal[:port] is testable' : undefined,
  };
  if (!target) return NextResponse.json({ ...out, ok: false, error: 'NO_TARGET_CONFIGURED' });

  try {
    const r = await fetch(`${target}/api/config`, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    return NextResponse.json({ ...out, ok: r.ok, status: r.status });
  } catch (e: unknown) {
    const err = e as { name?: string; message?: string; cause?: { code?: string } };
    return NextResponse.json({
      ...out,
      ok: false,
      // ECONNREFUSED = host reachable, wrong port · ENOTFOUND = wrong hostname ·
      // TimeoutError/ETIMEDOUT = unroutable (e.g. target not on the private network / IPv4-only bind)
      error: err?.cause?.code ?? err?.name ?? String(err?.message ?? 'unknown').slice(0, 80),
    });
  }
}
