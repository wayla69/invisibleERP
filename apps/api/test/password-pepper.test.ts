import { describe, it, expect } from 'vitest';
import { scrypt as _scrypt, randomBytes } from 'node:crypto';

// SOX-ICFR 4.5-bis — server-side password pepper. The service captures PASSWORD_PEPPER at module load,
// so set it BEFORE importing (a dynamic import runs after this assignment).
process.env.PASSWORD_PEPPER = 'unit-test-pepper-value-0123456789abcdef0123456789abcdef';
const { PasswordService } = await import('../src/modules/auth/password.service');

// Build an UN-peppered legacy `scrypt$N$r$p$salt$hash` hash (as written before the pepper existed), to
// exercise the transparent upgrade path when a pepper is now configured.
function plainScrypt(pw: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return new Promise((res, rej) =>
    _scrypt(pw, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (e, dk) =>
      e ? rej(e) : res(`scrypt$32768$8$1$${salt}$${(dk as Buffer).toString('hex')}`)));
}

describe('PasswordService — server-side pepper (4.5-bis)', () => {
  const svc = new PasswordService();

  it('hash() emits the versioned peppered format when a pepper is configured', async () => {
    const h = await svc.hash('correct horse battery staple');
    expect(h.startsWith('scrypt-p1$')).toBe(true);
    expect(h.split('$')).toHaveLength(6);
  });

  it('verify() round-trips a peppered hash and rejects the wrong password', async () => {
    const h = await svc.hash('s3cret-passphrase');
    await expect(svc.verify('s3cret-passphrase', h)).resolves.toEqual({ ok: true, needsRehash: false });
    const bad = await svc.verify('wrong-passphrase', h);
    expect(bad.ok).toBe(false);
  });

  it('a peppered hash does NOT verify against the raw (un-peppered) password', async () => {
    // Proves the pepper is actually keyed in: an attacker with salt+hash but not the pepper cannot verify.
    const pw = 'another-passphrase';
    const h = await svc.hash(pw);
    const raw = h.replace('scrypt-p1$', 'scrypt$'); // pretend it were an un-peppered hash of the same params
    const [, nStr, rStr, pStr, salt] = raw.split('$');
    const derivedRaw = await new Promise<Buffer>((res, rej) =>
      _scrypt(pw, salt!, 64, { N: Number(nStr), r: Number(rStr), p: Number(pStr), maxmem: 256 * 1024 * 1024 },
        (e, dk) => (e ? rej(e) : res(dk as Buffer))));
    // The stored peppered hash bytes must NOT equal a plain scrypt of the raw password.
    expect(h.split('$')[5]).not.toBe(derivedRaw.toString('hex'));
  });

  it('verify() upgrades an un-peppered scrypt hash on success (needsRehash = true)', async () => {
    const h = await plainScrypt('legacy-user-pw');
    const res = await svc.verify('legacy-user-pw', h);
    expect(res).toEqual({ ok: true, needsRehash: true }); // wantsPepper ⇒ upgrade to peppered on next login
  });

  it('bare unsalted SHA-256 hashes are rejected without computing a weak hash', async () => {
    const sha = 'a'.repeat(64); // shape of the removed V1 unsalted-SHA-256 credential
    await expect(svc.verify('anything', sha)).resolves.toEqual({ ok: false, needsRehash: false });
  });

  it('verifyScrypt() (PIN / step-up path) round-trips a peppered secret', async () => {
    const h = await svc.hash('1234');
    await expect(svc.verifyScrypt('1234', h)).resolves.toEqual({ ok: true, needsRehash: false });
    expect((await svc.verifyScrypt('9999', h)).ok).toBe(false);
  });
});
