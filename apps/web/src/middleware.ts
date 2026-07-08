import { NextRequest, NextResponse } from 'next/server';

/**
 * Content-Security-Policy with a per-request nonce (security review M-1).
 *
 * The old CSP (in next.config's static `headers()`) carried `script-src 'self' 'unsafe-inline'`, which lets
 * ANY inline `<script>` execute — so a single unescaped field reaching the DOM would be XSS. A static header
 * can't hold a per-request value, so the nonce policy has to live in middleware.
 *
 * In **production** the policy is the Google "strict CSP" shape:
 *   script-src 'self' 'nonce-<rand>' 'strict-dynamic' 'unsafe-inline'
 *   - CSP3 browsers: `'strict-dynamic'` makes them IGNORE `'self'` and `'unsafe-inline'`; only the nonce'd
 *     bootstrap (Next injects the nonce into its own scripts — it reads it from this header) and scripts it
 *     transitively loads run. An injected inline `<script>` has no nonce ⇒ blocked.
 *   - Legacy (CSP1/2) browsers: ignore the nonce + `'strict-dynamic'` tokens and fall back to
 *     `'self' 'unsafe-inline'` — i.e. exactly today's behaviour, so there is no regression for them.
 * In **development** we keep `'self' 'unsafe-inline' 'unsafe-eval'` with NO nonce, because a nonce would
 * disable `'unsafe-inline'` and break Next's HMR / react-refresh inline scripts. Dev is unchanged.
 *
 * `style-src 'unsafe-inline'` is retained deliberately: Next/font + Tailwind inject inline styles, and style
 * injection is not script execution — nonce-ing styles is out of scope and low value.
 *
 * Rollout safety: set `CSP_REPORT_ONLY=1` to emit the policy under `Content-Security-Policy-Report-Only`
 * instead of enforcing it. Next still nonces its scripts in report-only mode (it reads the nonce from either
 * header), so the reports are clean signal — any violation is a REAL inline script, not Next's own. Flip the
 * flag off to enforce once a deploy's telemetry is quiet.
 */

const isDev = process.env.NODE_ENV !== 'production';

// Derive just the API origin (proxy mode uses same-origin, so it may be empty).
let apiOrigin = '';
try { apiOrigin = process.env.NEXT_PUBLIC_API_URL ? new URL(process.env.NEXT_PUBLIC_API_URL).origin : ''; } catch { /* ignore */ }

function buildCsp(nonce: string): string {
  const scriptSrc = isDev
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline'`;
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    scriptSrc,
    `connect-src 'self'${apiOrigin ? ' ' + apiOrigin : ''}${isDev ? ' ws: wss:' : ''}`,
  ].join('; ');
}

export function middleware(req: NextRequest): NextResponse {
  // base64url nonce (16 random bytes) — Edge-runtime crypto, no Node Buffer needed.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const nonce = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const csp = buildCsp(nonce);
  const headerName = process.env.CSP_REPORT_ONLY === '1' ? 'content-security-policy-report-only' : 'content-security-policy';

  // Set the CSP on the REQUEST headers so Next's app-render can read the nonce and stamp it onto its own
  // <script> tags, and expose the raw nonce to server components via `x-nonce` (the root layout forwards it
  // to next-themes' inline anti-flash script).
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(headerName, csp);
  requestHeaders.set('x-nonce', nonce);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  // …and on the RESPONSE so the browser actually applies the policy.
  res.headers.set(headerName, csp);
  return res;
}

export const config = {
  // Run on documents, skip Next's static assets, the image optimizer, and common static files (they need no
  // CSP and would just add per-asset overhead). API routes are served by the separate Nest API, not Next.
  matcher: [
    {
      source: '/((?!api/|_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|sw.js|robots.txt|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|txt|xml)$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
