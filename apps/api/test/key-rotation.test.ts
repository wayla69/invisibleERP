// 4.3 (ITGC-AC-12) — versioned encryption keyring: HKDF keys, v2 wire format, back-compat, rotation
// discriminator, and fail-closed misconfiguration handling. The legacy (no-keyring) path stays
// byte-format-identical (v1) — see pii-encrypt.test.ts which pins that behaviour.
import { describe, it, expect, afterEach } from 'vitest';
import { encrypt, decrypt, activeKeyId, ciphertextKeyId, needsRotation } from '../src/common/crypto';

const RING = JSON.stringify({ '2': 'keyring-secret-two-0123456789abcdef', '3': 'keyring-secret-three-0123456789abcd' });

afterEach(() => {
  delete process.env.APP_ENC_KEYRING;
  delete process.env.APP_ENC_ACTIVE_KID;
});

describe('encryption keyring (4.3)', () => {
  it('default (no keyring): active kid is the legacy 1 and encrypt emits the v1 format', () => {
    expect(activeKeyId()).toBe('1');
    const blob = encrypt('secret-data');
    expect(blob.startsWith('v1:')).toBe(true);
    expect(decrypt(blob)).toBe('secret-data');
    expect(ciphertextKeyId(blob)).toBe('1');
    expect(needsRotation(blob)).toBe(false);
  });

  it('with an active keyring kid: encrypt emits v2:<kid>: and round-trips', () => {
    process.env.APP_ENC_KEYRING = RING;
    process.env.APP_ENC_ACTIVE_KID = '2';
    expect(activeKeyId()).toBe('2');
    const blob = encrypt('secret-data');
    expect(blob.startsWith('v2:2:')).toBe(true);
    expect(decrypt(blob)).toBe('secret-data');
    expect(ciphertextKeyId(blob)).toBe('2');
    expect(needsRotation(blob)).toBe(false);
  });

  it('rotation back-compat: an old v1 blob still decrypts after the keyring activates, and is flagged for rotation', () => {
    const oldBlob = encrypt('legacy-era-value'); // v1 under the legacy key
    process.env.APP_ENC_KEYRING = RING;
    process.env.APP_ENC_ACTIVE_KID = '2';
    expect(decrypt(oldBlob)).toBe('legacy-era-value'); // embedded format selects the legacy key
    expect(needsRotation(oldBlob)).toBe(true);         // …but it should be re-encrypted
    const rotated = encrypt(decrypt(oldBlob));         // the sweep's core operation
    expect(rotated.startsWith('v2:2:')).toBe(true);
    expect(decrypt(rotated)).toBe('legacy-era-value');
    expect(needsRotation(rotated)).toBe(false);        // idempotent: converged
  });

  it('kids are label-separated: a blob relabelled to another kid fails auth (different HKDF key)', () => {
    process.env.APP_ENC_KEYRING = RING;
    process.env.APP_ENC_ACTIVE_KID = '2';
    const blob = encrypt('cross-kid');
    const tampered = blob.replace(/^v2:2:/, 'v2:3:'); // kid 3 exists in the ring but derives a DIFFERENT key
    expect(() => decrypt(tampered)).toThrow(); // GCM auth-tag failure — label separation holds
  });

  it('fails closed: a v2 blob whose kid is missing from the keyring throws (never returns ciphertext as plaintext)', () => {
    process.env.APP_ENC_KEYRING = RING;
    process.env.APP_ENC_ACTIVE_KID = '2';
    const blob = encrypt('will-lose-key');
    delete process.env.APP_ENC_KEYRING; // simulate a deploy that dropped the ring
    expect(() => decrypt(blob)).toThrow(/not in APP_ENC_KEYRING/);
  });

  it('fails closed: an active kid missing from the ring, or malformed keyring JSON, throws at encrypt time', () => {
    process.env.APP_ENC_ACTIVE_KID = '9';
    expect(() => encrypt('x')).toThrow(/not in APP_ENC_KEYRING/);
    process.env.APP_ENC_KEYRING = 'not-json';
    expect(() => encrypt('x')).toThrow(/not valid JSON/);
  });

  it('legacy plaintext passthrough is unchanged (neither v1 nor v2 shape)', () => {
    expect(decrypt('just-a-plain-value')).toBe('just-a-plain-value');
    expect(ciphertextKeyId('just-a-plain-value')).toBe(null);
    expect(needsRotation('just-a-plain-value')).toBe(false);
  });
});
