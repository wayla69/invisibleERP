// API client. Auth is a server-set httpOnly cookie (the JWT is NOT readable from JS — XSS can't steal it),
// paired with a readable double-submit CSRF token cookie (`ierp_csrf`) that we echo in the X-CSRF-Token
// header on mutating requests. Every call sends credentials so the browser attaches the auth cookie.
const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';
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

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetchWithTimeout(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...csrfHeader(init.method),
      ...(init.headers ?? {}),
    },
  });
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
    headers: { 'Content-Type': 'application/json', ...csrfHeader(init.method), ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.messageTh ?? body?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}
