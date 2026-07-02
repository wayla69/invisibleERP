// Server-side API helper for React Server Components (docs/28 §4 / docs/27 R5-2).
// Forwards the caller's cookies (httpOnly `ierp_token`) to the API, so a server component can prefetch the
// data a page needs before any client JS runs — no CORS change (server→API is a backend call, not a
// browser one) and no token exposure (the cookie never leaves the server).
// GET-only by design: mutations stay in client islands behind the CSRF double-submit header.
// Returns null on ANY failure (no session, 401 pending client-side refresh, API down, timeout) — callers
// pass the result as react-query `initialData`, so a null simply falls back to the existing client fetch.
import { cookies } from 'next/headers';

// Same resolution the browser uses, but from the Next server: the dev/preview proxy target when set,
// else the public API origin, else local dev.
const BASE = process.env.API_PROXY_TARGET || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
// Round-2 AUD-SEC NEW-2: a silent localhost default in production would POST the session cookie to
// whatever listens on the web host. Warn loudly once; the prefetch itself degrades to null as usual.
const BASE_DEFAULTED = !process.env.API_PROXY_TARGET && !process.env.NEXT_PUBLIC_API_URL;
let warnedBase = false;

// Forward ONLY the auth + CSRF cookies — never the whole jar (third-party/analytics cookies have no
// business reaching the API, and the surface stays minimal if more cookies appear later).
const FORWARD = new Set(['ierp_token', 'ierp_csrf']);

export async function serverApi<T>(path: string, timeoutMs = 5000): Promise<T | null> {
  if (BASE_DEFAULTED && process.env.NODE_ENV === 'production' && !warnedBase) {
    warnedBase = true;
    console.warn('[server-api] neither API_PROXY_TARGET nor NEXT_PUBLIC_API_URL is set in production — SSR prefetch is falling back to http://localhost:8000 and will be skipped.');
  }
  if (BASE_DEFAULTED && process.env.NODE_ENV === 'production') return null;
  try {
    const jar = await cookies();
    const cookie = jar
      .getAll()
      .filter((c) => FORWARD.has(c.name))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    if (!cookie) return null;
    const res = await fetch(`${BASE}${path}`, {
      headers: { cookie },
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      // Observability (round-2 ARC NEW-3): SSR prefetch failures were invisible. Status only — no body.
      console.warn(`[server-api] prefetch ${path} → ${res.status}; falling back to client fetch`);
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    console.warn(`[server-api] prefetch ${path} failed (${e instanceof Error ? e.name : 'error'}); falling back to client fetch`);
    return null;
  }
}
