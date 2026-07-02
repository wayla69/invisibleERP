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

export async function serverApi<T>(path: string, timeoutMs = 5000): Promise<T | null> {
  try {
    const jar = await cookies();
    const cookie = jar
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    if (!cookie) return null;
    const res = await fetch(`${BASE}${path}`, {
      headers: { cookie },
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
