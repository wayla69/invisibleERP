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
  if (!objectStoreConfigured()) return null;
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl ?? '');
  if (!m) return null;
  const contentType = m[1];
  const bytes = Buffer.from(m[2], 'base64');
  try {
    const res = await fetch(`${base()}/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': contentType, ...(process.env.OBJECT_STORE_TOKEN ? { Authorization: `Bearer ${process.env.OBJECT_STORE_TOKEN}` } : {}) },
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
  const pub = (process.env.OBJECT_STORE_PUBLIC_URL ?? process.env.OBJECT_STORE_URL ?? '').replace(/\/$/, '');
  return `${pub}/${key}`;
}

// Best-effort delete (for PDPA erasure). No-op for non-refs / unconfigured; never throws.
export async function deleteObject(ref: string | null | undefined): Promise<void> {
  if (!objectStoreConfigured() || !isObjectRef(ref)) return;
  const key = (ref as string).slice(PREFIX.length);
  try {
    await fetch(`${base()}/${key}`, { method: 'DELETE', headers: process.env.OBJECT_STORE_TOKEN ? { Authorization: `Bearer ${process.env.OBJECT_STORE_TOKEN}` } : {} });
  } catch { /* best-effort */ }
}
