// Field-level PII encryption at rest (panel Round-2, condition #2).
// `encryptedText` is a transparent Drizzle column type: it encrypts on write and decrypts on read using
// the AES-256-GCM helpers in common/crypto.ts (versioned `v1:…`, with legacy-plaintext passthrough — so a
// column can be switched to this type WITHOUT a backfill: existing plaintext rows still read, new writes
// are encrypted, and a later one-off backfill can re-write old rows ciphertext).
//
// IMPORTANT — searchability: a value encrypted with `encryptedText` can no longer be matched by SQL
// equality or `ilike` (you'd be comparing ciphertext). Only apply it to columns NOT used in a value-based
// WHERE/search. For exact-match lookups (login by email, dedupe by phone), add a companion blind-index
// column (`blindIndex(value)`) and query THAT instead. Substring search over encrypted data is not
// supported — keep such columns plaintext or redesign the search.
import { customType } from 'drizzle-orm/pg-core';
import { createHash } from 'node:crypto';
import { encrypt, decrypt, hmacSha256Hex } from '../common/crypto';

export const encryptedText = customType<{ data: string; driverData: string }>({
  dataType() { return 'text'; },
  toDriver(value: string): string {
    // null/undefined are passed through by Drizzle without calling this; guard defensively anyway.
    return value == null ? value : encrypt(String(value));
  },
  fromDriver(value: string): string {
    return value == null ? value : decrypt(String(value));
  },
});

// Deterministic blind index for exact-match lookups on an encrypted column. HMAC-SHA256 over the
// normalized (trimmed, lower-cased) value, keyed off APP_ENC_KEY (separated from the data key by a label so
// the index can't be reversed to the ciphertext key). Store in a companion `<col>_bidx` column and filter
// on it for equality. Same input → same index (so it's queryable); the raw value is never stored in it.
function blindIndexKey(): string {
  const raw = process.env.APP_ENC_KEY ?? 'ierp-dev-enc-key';
  return createHash('sha256').update(`${raw}:blind-index`).digest('hex');
}

export function blindIndex(value: string | null | undefined): string | null {
  if (value == null) return null;
  const norm = String(value).trim().toLowerCase();
  if (!norm) return null;
  return hmacSha256Hex(blindIndexKey(), norm);
}
