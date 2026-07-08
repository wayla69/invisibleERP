// AES-256-GCM AEAD for encryption-at-rest (TOTP seeds, webhook secrets, PII columns).
// Wire formats:
//   v1:<iv_b64>:<tag_b64>:<ct_b64>          — legacy: the single sha256(APP_ENC_KEY) key (key id '1')
//   v2:<kid>:<iv_b64>:<tag_b64>:<ct_b64>    — versioned: an HKDF-SHA256 key from the APP_ENC_KEYRING
// decrypt() passes through any value in neither format (legacy plaintext) so existing rows keep working.
//
// 4.3 (key versioning + rotation) — DEFAULT-INERT: with no keyring configured, the active key id is the
// legacy '1' and encrypt() emits the v1 format byte-for-byte as before. To rotate: set
// APP_ENC_KEYRING='{"2":"<new secret>"}' + APP_ENC_ACTIVE_KID=2 (new writes become v2:2:…, everything old
// still decrypts via the embedded key id), then run the `key_rotation_sweep` job until no v1/old-kid
// ciphertext remains. KEK custody stays in env for now (external KMS is an infra dependency — see
// docs/ops/secrets.md §5); the keyring gives the versioning + re-encrypt machinery a KMS would drive.
import { createCipheriv, createDecipheriv, randomBytes, createHash, createHmac, timingSafeEqual, hkdfSync } from 'node:crypto';

const ALG = 'aes-256-gcm';
const V1 = 'v1';
const V2 = 'v2';
const LEGACY_KID = '1'; // reserved: the pre-keyring sha256(APP_ENC_KEY) key

// 32-byte legacy key derived from APP_ENC_KEY. In dev/test (unset) derive a deterministic key so
// harnesses round-trip without configuration; in production APP_ENC_KEY is REQUIRED (fail closed).
function legacyKey(): Buffer {
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

// APP_ENC_KEYRING: JSON map of key id → secret, e.g. '{"2":"<random ≥32 chars>"}'. Key ids must be
// colon-free tokens (they ride inside the colon-delimited wire format). Malformed JSON FAILS CLOSED —
// silently ignoring it would encrypt new data under the wrong (legacy) key and mask the misconfiguration.
function keyring(): Record<string, string> {
  const raw = process.env.APP_ENC_KEYRING;
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('APP_ENC_KEYRING is not valid JSON (fail closed).'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('APP_ENC_KEYRING must be a JSON object of {"<kid>":"<secret>"} (fail closed).');
  return parsed as Record<string, string>;
}

function keyForKid(kid: string): Buffer {
  if (kid === LEGACY_KID) return legacyKey();
  if (!/^[A-Za-z0-9_-]+$/.test(kid)) throw new Error(`Invalid encryption key id '${kid}' (colon-free [A-Za-z0-9_-]+ required).`);
  const secret = keyring()[kid];
  if (!secret) throw new Error(`Encryption key '${kid}' is not in APP_ENC_KEYRING — cannot encrypt/decrypt (fail closed).`);
  // Proper KDF (unlike the legacy bare sha256): HKDF-SHA256 with a salt + per-key-id info label, so each
  // key id yields an independent 32-byte key even from the same root secret (label separation).
  return Buffer.from(hkdfSync('sha256', secret, 'ierp-enc-v2', `data:${kid}`, 32));
}

// The key id new writes are encrypted under. Default (no APP_ENC_ACTIVE_KID) = the legacy key '1'
// (encrypt() then emits the v1 format — byte-compatible, nothing changes until rotation is configured).
export function activeKeyId(): string {
  const kid = (process.env.APP_ENC_ACTIVE_KID ?? '').trim();
  if (!kid) return LEGACY_KID;
  keyForKid(kid); // validate up front: an active kid missing from the keyring is a fatal misconfiguration
  return kid;
}

export function encrypt(plaintext: string): string {
  const kid = activeKeyId();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, keyForKid(kid), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (kid === LEGACY_KID) return [V1, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
  return [V2, kid, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(blob: string): string {
  const parts = (blob ?? '').split(':');
  if (parts[0] === V2 && parts.length === 5) {
    const [, kid, ivB64, tagB64, ctB64] = parts;
    const decipher = createDecipheriv(ALG, keyForKid(kid!), Buffer.from(ivB64!, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64!, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64!, 'base64')), decipher.final()]).toString('utf8');
  }
  if (parts[0] !== V1 || parts.length !== 4) {
    return blob; // back-compat: value predates encryption (plaintext) — return as-is
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv(ALG, legacyKey(), Buffer.from(ivB64!, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64!, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64!, 'base64')), decipher.final()]).toString('utf8');
}

// Which key id a stored blob is encrypted under; null = not an encrypted blob (legacy plaintext — the
// encrypt-backfill's concern, not rotation's).
export function ciphertextKeyId(blob: string): string | null {
  const parts = (blob ?? '').split(':');
  if (parts[0] === V2 && parts.length === 5) return parts[1]!;
  if (parts[0] === V1 && parts.length === 4) return LEGACY_KID;
  return null;
}

// Rotation discriminator: an encrypted blob under any key OTHER than the active one needs re-encrypting.
export function needsRotation(blob: string): boolean {
  const kid = ciphertextKeyId(blob);
  return kid != null && kid !== activeKeyId();
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
