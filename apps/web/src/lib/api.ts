// Minimal API client (Phase 0). Phase 4: แทนด้วย TanStack Query + httpOnly cookie auth.
const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';
const TOKEN_KEY = 'ierp_token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string) {
  window.localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken() {
  window.localStorage.removeItem(TOKEN_KEY);
}

const DEFAULT_TIMEOUT_MS = 15_000;

// Wrap a fetch with an AbortController timeout so a hung request rejects instead of leaving a button
// spinning forever. Honours a caller-supplied signal too. Throws a Thai, actionable message on timeout.
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // chain an externally-provided signal into ours
  if (init.signal) init.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error('การเชื่อมต่อหมดเวลา — กรุณาลองอีกครั้ง (เครือข่ายอาจขัดข้อง)');
    throw new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจสอบเครือข่ายแล้วลองใหม่');
  } finally {
    clearTimeout(timer);
  }
}

// On 401 the token is stale/expired: clear it and bounce to /login (once — never from /login itself, to
// avoid a redirect loop). Returns true if it handled a 401 so the caller can stop.
function handleUnauthorized(status: number): boolean {
  if (status !== 401) return false;
  clearToken();
  if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.assign(`/login?next=${next}`);
  }
  return true;
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetchWithTimeout(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
  const token = getToken();
  const res = await fetchWithTimeout(`${BASE}${path}`, {
    ...init,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
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

// Public client — NO Authorization header. For the unauthenticated diner QR page (the table-session
// token is in the URL path; the server scopes the tenant from it).
export async function publicApi<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetchWithTimeout(`${BASE}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.messageTh ?? body?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}
