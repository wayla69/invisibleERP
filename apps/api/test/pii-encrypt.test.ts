import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../src/common/crypto';
import { blindIndex } from '../src/database/encrypted-column';

// PII-at-rest encryption primitives (panel Round-2, condition #2). The encryptedText Drizzle column type
// delegates to encrypt()/decrypt(); blindIndex() backs exact-match lookups on encrypted columns.
describe('PII encryption — encrypt/decrypt round-trip', () => {
  it('round-trips a value through ciphertext', () => {
    const ct = encrypt('0105561012345'); // a Thai tax/national-id-shaped value
    expect(ct).not.toContain('0105561012345');      // not stored in the clear
    expect(ct.startsWith('v1:')).toBe(true);          // versioned format
    expect(decrypt(ct)).toBe('0105561012345');        // decrypts back
  });
  it('produces a fresh IV each time (ciphertext differs, plaintext same)', () => {
    const a = encrypt('secret'), b = encrypt('secret');
    expect(a).not.toBe(b);                 // random IV → different ciphertext
    expect(decrypt(a)).toBe(decrypt(b));   // both decrypt to the same value
  });
  it('passes through legacy plaintext on read (incremental rollout, no backfill needed)', () => {
    expect(decrypt('legacy-plaintext-value')).toBe('legacy-plaintext-value');
  });
});

describe('PII encryption — blind index (exact-match lookups)', () => {
  it('is deterministic and normalizes case/whitespace', () => {
    expect(blindIndex('A@B.CO')).toBe(blindIndex('  a@b.co '));
  });
  it('differs for different values and never echoes the value', () => {
    const idx = blindIndex('0812345678')!;
    expect(blindIndex('0899999999')).not.toBe(idx);
    expect(idx).not.toContain('0812345678');
  });
  it('returns null for null/empty', () => {
    expect(blindIndex(null)).toBeNull();
    expect(blindIndex('   ')).toBeNull();
  });
});
