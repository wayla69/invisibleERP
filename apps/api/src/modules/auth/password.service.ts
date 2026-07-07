import { Injectable } from '@nestjs/common';
import { scrypt, randomBytes, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// promisify(scrypt) resolves to the no-options overload, so wrap manually to pass cost parameters + maxmem.
function scryptAsync(password: string, salt: string, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, dk) => (err ? reject(err) : resolve(dk as Buffer)));
  });
}

// scrypt work factors. N is the CPU/memory cost (must be a power of two). We harden from Node's default
// N=2^14 (16384) to 2^15 (32768) — ~2× the work, ≈64 MB transient per hash — a real uplift while staying
// well clear of the multi-GB blow-up that a fleet of concurrent logins at N=2^17 would cause (the login
// throttle in ITGC-AC-07 bounds abuse of this cost). Tunable via env for future hardening without a code
// change. maxmem is sized to admit N=2^15 (Node's 32 MB default would otherwise reject it).
const N = Number(process.env.SCRYPT_N ?? 32768);
const R = Number(process.env.SCRYPT_R ?? 8);
const P = Number(process.env.SCRYPT_P ?? 1);
const KEYLEN = 64;
const MAXMEM = 256 * 1024 * 1024; // 256 MB ceiling — comfortably admits N=2^15..2^17
const LEGACY_N = 16384; // params of the pre-hardening `scrypt$salt$hash` format (Node default at the time)

/**
 * Password hashing — scrypt (built-in, no native deps).
 * Hash format (current):  scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>   — parameters are self-describing, so the
 *   work factor can be raised later and old hashes still verify (and are transparently rehashed on login).
 * Back-compat: a legacy parameterized-less scrypt hash (scrypt$<saltHex>$<hashHex>, N=16384) still verifies
 * and is flagged needsRehash → upgraded to the current format on next successful login.
 * The pre-V2 unsalted-SHA-256 hash (a bare 64-hex value) is NO LONGER accepted (weak-hash sink, 4.5) — such
 * an account must be reset by an admin.
 * (Production target remains argon2id — swap the implementation behind this interface without touching callers.)
 */
@Injectable()
export class PasswordService {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16).toString('hex');
    const derived = (await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM })) as Buffer;
    return `scrypt$${N}$${R}$${P}$${salt}$${derived.toString('hex')}`;
  }

  async verify(password: string, stored: string): Promise<{ ok: boolean; needsRehash: boolean }> {
    // 4.5 — the pre-V2 unsalted SHA-256 login path (V1 user_store, a 64-hex value) is REMOVED. Hashing a
    // password with unsalted SHA-256 is a weak-hash sink (CodeQL js/insufficient-password-hash) and trivially
    // crackable on a DB dump. A dormant legacy account can no longer authenticate on the weak hash — it must
    // be reset by an admin (must_change_password). Reject WITHOUT computing any weak hash.
    if (/^[a-f0-9]{64}$/i.test(stored)) return { ok: false, needsRehash: false };
    const parts = stored.split('$');
    // current: scrypt$N$r$p$salt$hash
    if (parts[0] === 'scrypt' && parts.length === 6) {
      const [, nStr, rStr, pStr, salt, hashHex] = parts;
      const n = Number(nStr), r = Number(rStr), p = Number(pStr);
      const derived = (await scryptAsync(password, salt!, KEYLEN, { N: n, r, p, maxmem: MAXMEM })) as Buffer;
      const expected = Buffer.from(hashHex!, 'hex');
      const ok = derived.length === expected.length && timingSafeEqual(derived, expected);
      // upgrade if the stored parameters are weaker than the current target
      return { ok, needsRehash: ok && (n < N || r < R || p < P) };
    }
    // legacy: scrypt$salt$hash (no embedded params → Node-default N=16384)
    if (parts[0] === 'scrypt' && parts.length === 3 && parts[1] && parts[2]) {
      const derived = (await scryptAsync(password, parts[1], KEYLEN, { N: LEGACY_N, r: 8, p: 1, maxmem: MAXMEM })) as Buffer;
      const expected = Buffer.from(parts[2], 'hex');
      const ok = derived.length === expected.length && timingSafeEqual(derived, expected);
      return { ok, needsRehash: ok }; // always upgrade legacy scrypt to the parameterized, hardened format
    }
    return { ok: false, needsRehash: false };
  }

  /**
   * Verify a secret against a stored hash WITHOUT the legacy unsalted-SHA-256 escape hatch — only the
   * (current and legacy-param) scrypt formats are accepted. Use this for secrets that are guaranteed to be
   * in the scrypt format: PINs (always issued via hash()), and step-up re-checks for an ALREADY-AUTHENTICATED
   * user (a successful login transparently rehashes any legacy password to scrypt, so an authenticated
   * caller's stored hash is scrypt by then). Keeping these flows out of the SHA-256 branch means a PIN /
   * step-up secret never reaches a weak-hash comparison (no js/insufficient-password-hash sink).
   */
  async verifyScrypt(secret: string, stored: string): Promise<{ ok: boolean; needsRehash: boolean }> {
    const parts = stored.split('$');
    // current: scrypt$N$r$p$salt$hash
    if (parts[0] === 'scrypt' && parts.length === 6) {
      const [, nStr, rStr, pStr, salt, hashHex] = parts;
      const n = Number(nStr), r = Number(rStr), p = Number(pStr);
      const derived = (await scryptAsync(secret, salt!, KEYLEN, { N: n, r, p, maxmem: MAXMEM })) as Buffer;
      const expected = Buffer.from(hashHex!, 'hex');
      const ok = derived.length === expected.length && timingSafeEqual(derived, expected);
      return { ok, needsRehash: ok && (n < N || r < R || p < P) };
    }
    // legacy: scrypt$salt$hash (no embedded params → Node-default N=16384) — upgrade on success
    if (parts[0] === 'scrypt' && parts.length === 3 && parts[1] && parts[2]) {
      const derived = (await scryptAsync(secret, parts[1], KEYLEN, { N: LEGACY_N, r: 8, p: 1, maxmem: MAXMEM })) as Buffer;
      const expected = Buffer.from(parts[2], 'hex');
      const ok = derived.length === expected.length && timingSafeEqual(derived, expected);
      return { ok, needsRehash: ok };
    }
    return { ok: false, needsRehash: false };
  }
}
