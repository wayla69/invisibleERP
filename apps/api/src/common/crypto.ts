// AES-256-GCM AEAD for encryption-at-rest (TOTP seeds, webhook secrets).
// Output format: v1:<iv_b64>:<tag_b64>:<ct_b64>. decrypt() passes through any value
// that is not in this format (legacy plaintext) so existing rows keep working.
import { createCipheriv, createDecipheriv, randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';

const ALG = 'aes-256-gcm';
const VERSION = 'v1';

// 32-byte key derived from APP_ENC_KEY. In dev/test (unset) derive a deterministic key so
// harnesses round-trip without configuration; in production APP_ENC_KEY is REQUIRED (fail closed).
function encKey(): Buffer {
  const raw = process.env.APP_ENC_KEY;
  if (!raw) {
    // Fail closed everywhere except explicit dev/test (mirrors the JWT_SECRET gate). A NODE_ENV-unset
    // deploy must NOT silently fall back to a public hardcoded key for TOTP/webhook secrets.
    const env = process.env.NODE_ENV;
    if (env !== 'development' && env !== 'test') {
      throw new Error('APP_ENC_KEY is required (encryption-at-rest). No insecure default outside NODE_ENV=development|test.');
    }
    return createHash('sha256').update('ierp-dev-enc-key').digest(); // dev/test only
  }
  return createHash('sha256').update(raw).digest(); // normalize any-length secret to 32 bytes
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, encKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(blob: string): string {
  const parts = (blob ?? '').split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    return blob; // back-compat: value predates encryption (plaintext) — return as-is
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv(ALG, encKey(), Buffer.from(ivB64!, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64!, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64!, 'base64')), decipher.final()]).toString('utf8');
}

// Constant-time hex-string compare (for hashed-secret verification).
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Constant-time, length-independent compare of two arbitrary secret strings. Both sides are SHA-256'd
// first so the comparison is always over equal-length digests — this avoids the early-exit timing oracle
// of `a !== b` AND avoids leaking the secret length. Use for bare shared-secret header auth (webhooks).
export function safeEqualStr(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a ?? '').digest();
  const hb = createHash('sha256').update(b ?? '').digest();
  return timingSafeEqual(ha, hb);
}

// HMAC-SHA256 of a payload as lowercase hex — for verifying signed inbound webhooks (PSP callbacks).
export function hmacSha256Hex(secret: string, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

// Verify a webhook signature header against the raw body. The provided signature may be bare hex or
// prefixed `sha256=<hex>` (common PSP convention). Returns false on any malformed/short input.
export function verifyWebhookSignature(secret: string, rawBody: Buffer | string, signature: string | undefined): boolean {
  if (!signature) return false;
  const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  if (!/^[0-9a-fA-F]+$/.test(provided)) return false;
  return safeEqualHex(hmacSha256Hex(secret, rawBody), provided.toLowerCase());
}
