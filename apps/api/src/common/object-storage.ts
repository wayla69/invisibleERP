// Object storage for large binary blobs (receipt photos, …). S3-compatible via a simple authorized HTTP
// PUT/GET/DELETE, so it drops in for AWS S3 / MinIO / Cloudflare R2 / any presigned-or-token object store —
// no SDK dependency. Mirrors the messaging/payment "real client activates via env, else fall back" pattern.
//
// Config (all optional; unset ⇒ storage disabled ⇒ callers keep the blob inline in the DB as today):
//   OBJECT_STORE_URL         base URL objects are written under (e.g. https://s3.../bucket)
//   OBJECT_STORE_TOKEN       optional Bearer token / presigned auth for the PUT/DELETE
//   OBJECT_STORE_PUBLIC_URL  optional public base for reads (CDN); defaults to OBJECT_STORE_URL
//
// A stored blob is referenced by the opaque string `objstore:<key>`; `objectUrl()` turns that back into a
// retrievable URL and passes through anything else (an inline `data:` URL, `[erased]`, null) unchanged.
const PREFIX = 'objstore:';

// Path-safety guard (security review L-9). Object keys are server-generated today, but building the request
// URL by concatenation (`${base()}/${key}`) means a key containing `..`, a leading `/`, a backslash, or a
// scheme (`http:`) could traverse out of the bucket or redirect the PUT/DELETE to another host. Restrict the
// key to safe relative path segments so a future caller that forwards user-influenced input can't do so.
export function isSafeObjectKey(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0 || key.length > 1024) return false;
  if (key.startsWith('/') || key.startsWith('\\')) return false;   // no absolute paths
  if (/[\\]/.test(key)) return false;                               // no backslashes
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(key)) return false;            // no scheme:// (host redirect)
  if (/[\x00-\x1f]/.test(key)) return false;                        // no control chars
  // each segment must be a plain name; reject any `.`/`..` traversal segment
  return key.split('/').every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

export function objectStoreConfigured(): boolean {
  return !!process.env.OBJECT_STORE_URL;
}

export function isObjectRef(ref: string | null | undefined): boolean {
  return typeof ref === 'string' && ref.startsWith(PREFIX);
}

function base(): string {
  return (process.env.OBJECT_STORE_URL ?? '').replace(/\/$/, '');
}

// Upload a `data:<mime>;base64,<data>` URL to the store under `key`. Returns the `objstore:<key>` reference on
// success, or null (unconfigured, bad input, or a transport error) so the caller can fall back to inline.
export async function putObject(key: string, dataUrl: string): Promise<string | null> {
  if (!objectStoreConfigured() || !isSafeObjectKey(key)) return null;
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl ?? '');
  if (!m) return null;
  const contentType = m[1];
  const bytes = Buffer.from(m[2]!, 'base64');
  try {
    const res = await fetch(`${base()}/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': contentType, ...(process.env.OBJECT_STORE_TOKEN ? { Authorization: `Bearer ${process.env.OBJECT_STORE_TOKEN}` } : {}) } as Record<string, string>,
      body: bytes,
    });
    return res.ok ? `${PREFIX}${key}` : null;
  } catch {
    return null;
  }
}

// Resolve a stored reference to a retrievable URL. Non-refs (inline data URLs, sentinels, null) pass through.
export function objectUrl(ref: string | null | undefined): string | null {
  if (!isObjectRef(ref)) return ref ?? null;
  const key = (ref as string).slice(PREFIX.length);
  if (!isSafeObjectKey(key)) return null; // never build a traversal/host-redirect URL from a malformed ref
  const pub = (process.env.OBJECT_STORE_PUBLIC_URL ?? process.env.OBJECT_STORE_URL ?? '').replace(/\/$/, '');
  return `${pub}/${key}`;
}

// Best-effort delete (for PDPA erasure). No-op for non-refs / unconfigured; never throws.
export async function deleteObject(ref: string | null | undefined): Promise<void> {
  if (!objectStoreConfigured() || !isObjectRef(ref)) return;
  const key = (ref as string).slice(PREFIX.length);
  if (!isSafeObjectKey(key)) return; // never issue a DELETE against a traversal/host-redirect target
  try {
    await fetch(`${base()}/${key}`, { method: 'DELETE', headers: process.env.OBJECT_STORE_TOKEN ? { Authorization: `Bearer ${process.env.OBJECT_STORE_TOKEN}` } : {} });
  } catch { /* best-effort */ }
}
