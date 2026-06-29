// API client. Auth is a server-set httpOnly cookie (the JWT is NOT readable from JS — XSS can't steal it),
// paired with a readable double-submit CSRF token cookie (`ierp_csrf`) that we echo in the X-CSRF-Token
// header on mutating requests. Every call sends credentials so the browser attaches the auth cookie.
const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';
/** API origin (or same-origin proxy base). Exported for non-JSON fetches — e.g. the POS terminal bridge
 *  pulling raw ESC/POS receipt bytes / the HTML slip, which can't go through the JSON `api()` helper. */
export const API_BASE = BASE;
const CSRF_COOKIE = 'ierp_csrf';

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// "Is there a session?" — the readable CSRF cookie is present iff the server set the auth cookies at login.
// Replaces the old localStorage token-presence check (the auth cookie itself is httpOnly and unreadable).
export function hasSession(): boolean {
  return readCookie(CSRF_COOKIE) != null;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
function csrfHeader(method?: string): Record<string, string> {
  if (!MUTATING.has((method ?? 'GET').toUpperCase())) return {};
  const t = readCookie(CSRF_COOKIE);
  return t ? { 'X-CSRF-Token': t } : {};
}

// Log out: clear the server cookies, then bounce to /login. Best-effort on the network call.
export async function logout(): Promise<void> {
  try {
    await fetch(`${BASE}/api/auth/logout`, { method: 'POST', credentials: 'include', headers: csrfHeader('POST') });
  } catch { /* ignore — we redirect regardless */ }
}

const DEFAULT_TIMEOUT_MS = 15_000;

// Wrap a fetch with an AbortController timeout so a hung request rejects instead of leaving a button
// spinning forever. Honours a caller-supplied signal too. Throws a Thai, actionable message on timeout.
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (init.signal) init.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    return await fetch(url, { ...init, credentials: 'include', signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error('การเชื่อมต่อหมดเวลา — กรุณาลองอีกครั้ง (เครือข่ายอาจขัดข้อง)');
    throw new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจสอบเครือข่ายแล้วลองใหม่');
  } finally {
    clearTimeout(timer);
  }
}

// Refresh-on-401: the access token (now short-lived, ~1h) expires while the refresh cookie (7d) is still
// valid. On a 401 we POST /api/auth/refresh once (httpOnly refresh cookie → new access cookie), then retry
// the original request. Concurrent 401s share ONE in-flight refresh so we don't stampede the endpoint.
let refreshInFlight: Promise<boolean> | null = null;
async function tryRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch(`${BASE}/api/auth/refresh`, { method: 'POST', credentials: 'include' });
        return res.ok;
      } catch {
        return false;
      } finally {
        // Clear after this microtask so simultaneous callers reuse this result, then it resets.
        setTimeout(() => { refreshInFlight = null; }, 0);
      }
    })();
  }
  return refreshInFlight;
}

// On 401 the session is stale/expired: bounce to /login (once — never from /login itself, to avoid a
// redirect loop). The httpOnly cookie can't be cleared from JS; the server expires it on next login/logout.
function handleUnauthorized(status: number): boolean {
  if (status !== 401) return false;
  if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.assign(`/login?next=${next}`);
  }
  return true;
}

// Build request headers. Only declare a JSON content-type when there's actually a body — Fastify rejects an
// empty body sent with `Content-Type: application/json` (this broke the body-less diner QR open-table POST
// `/api/qr/start/:qrToken`). A caller-supplied header still wins.
function buildHeaders(init: RequestInit): Record<string, string> {
  return {
    ...(init.body != null ? { 'Content-Type': 'application/json' } : {}),
    ...csrfHeader(init.method),
    ...((init.headers as Record<string, string>) ?? {}),
  };
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await fetchWithTimeout(`${BASE}${path}`, { ...init, headers: buildHeaders(init) });
  // Access token likely just expired — try a one-shot silent refresh, then replay the request once.
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    if (await tryRefresh()) {
      res = await fetchWithTimeout(`${BASE}${path}`, { ...init, headers: buildHeaders(init) });
    }
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (handleUnauthorized(res.status)) throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
    const msg = body?.error?.messageTh ?? body?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

// Download a file (xlsx/csv/pdf export, QR labels) with auth → save via a blob anchor.
export async function apiDownload(path: string, filename: string, init: RequestInit = {}): Promise<void> {
  const res = await fetchWithTimeout(`${BASE}${path}`, {
    ...init,
    headers: { ...csrfHeader(init.method), ...(init.headers ?? {}) },
  }, 60_000); // exports/PDF generation can be slow — allow longer
  if (!res.ok) {
    if (handleUnauthorized(res.status)) throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      msg = j?.error?.messageTh ?? j?.error?.message ?? msg;
    } catch { /* non-json */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Pre-auth / public client. Sends credentials so a Set-Cookie from login/SSO is stored, and the CSRF
// header when present, but never requires a session. Used for /api/login, SSO callback, and the diner QR
// page (the table-session token is in the URL path; the server scopes the tenant from it).
export async function publicApi<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetchWithTimeout(`${BASE}${path}`, {
    ...init,
    headers: buildHeaders(init),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.messageTh ?? body?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}
