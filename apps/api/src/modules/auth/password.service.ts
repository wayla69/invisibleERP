import { Injectable } from '@nestjs/common';
import { scrypt, randomBytes, timingSafeEqual, createHmac, type ScryptOptions } from 'node:crypto';

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

// ── Server-side pepper (SOX-ICFR audit 4.5-bis) ────────────────────────────────────────────────────────
// A per-deployment SECRET keyed into the hash BEFORE scrypt, held outside the database (env / secret
// manager — never in a column, per CLAUDE.md §8). It closes the "hashes sitting in the DB" risk: a
// DB-ONLY compromise (dump, replica, backup) yields salt+hash but NOT the pepper, so the stolen material
// is uncrackable offline without also breaching the app tier. Implemented as an HMAC-SHA256 pre-hash so
// the secret is mixed in with a keyed PRF (not naive concatenation).
//
// Versioned + rotatable: the format tag records whether a pepper was applied and which version, so the
// KDF/pepper can change while every historical hash still verifies. `PASSWORD_PEPPER` is OPTIONAL — when
// unset, behaviour is byte-identical to before (plain `scrypt$…`), so this is additive and safe to deploy
// dark. When it IS set: new hashes are peppered (`scrypt-p1$…`) and every successful login transparently
// upgrades a non-peppered hash to the peppered format (needsRehash), so the crackable-without-pepper
// population drains to zero as users log in. The scheduled census (ops) force-resets the dormant tail.
const PEPPER = process.env.PASSWORD_PEPPER && process.env.PASSWORD_PEPPER.length > 0 ? process.env.PASSWORD_PEPPER : null;
const PEPPER_TAG = 'scrypt-p1'; // current peppered format version
const PLAIN_TAG = 'scrypt';     // un-peppered (legacy default, and the format when no pepper is configured)

/**
 * Effective scrypt SALT = HMAC-SHA256(pepper, storedSalt) when a pepper is configured, else the stored salt.
 * The pepper is mixed into the SALT, not the password — so the password only ever flows into scrypt (a
 * memory-hard KDF), never a fast hash. Security is identical to a password-pepper: a DB-only leak yields the
 * stored salt + hash but not the pepper, and without the pepper the effective salt can't be derived, so the
 * scrypt output can't be reproduced. (Keeping the password out of any SHA-256/HMAC also avoids the CodeQL
 * js/insufficient-password-hash false positive that a password→HMAC-SHA256 edge trips.)
 */
function effectiveSalt(saltHex: string): string {
  return PEPPER ? createHmac('sha256', PEPPER).update(saltHex, 'utf8').digest('hex') : saltHex;
}

/**
 * Password hashing — scrypt (built-in, no native deps) with an optional server-side pepper.
 * Hash formats:
 *   • scrypt-p1$<N>$<r>$<p>$<saltHex>$<hashHex>  — CURRENT when PASSWORD_PEPPER is set. scrypt runs over the
 *     raw password with an effective salt = HMAC-SHA256(pepper, saltHex). A DB-only leak cannot be cracked
 *     without the (out-of-DB) pepper.
 *   • scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>     — CURRENT when no pepper is set; also every hash written
 *     before this change. Parameters are self-describing, so the work factor can be raised and old hashes
 *     still verify (and are transparently rehashed on login).
 *   • scrypt$<saltHex>$<hashHex> (N=16384)       — legacy parameter-less scrypt; verifies + rehashes.
 * The pre-V2 unsalted-SHA-256 hash (a bare 64-hex value) is NO LONGER accepted (weak-hash sink, 4.5) — such
 * an account must be reset by an admin (and migration 0428 scrubs the crackable material from the DB).
 * (Production target remains argon2id — swap the KDF behind a new `-a1` tag without touching callers.)
 */
@Injectable()
export class PasswordService {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16).toString('hex');
    const tag = PEPPER ? PEPPER_TAG : PLAIN_TAG;
    const derived = (await scryptAsync(password, effectiveSalt(salt), KEYLEN, { N, r: R, p: P, maxmem: MAXMEM })) as Buffer;
    return `${tag}$${N}$${R}$${P}$${salt}$${derived.toString('hex')}`;
  }

  async verify(password: string, stored: string): Promise<{ ok: boolean; needsRehash: boolean }> {
    // 4.5 — the pre-V2 unsalted SHA-256 login path (V1 user_store, a 64-hex value) is REMOVED. Hashing a
    // password with unsalted SHA-256 is a weak-hash sink (CodeQL js/insufficient-password-hash) and trivially
    // crackable on a DB dump. A dormant legacy account can no longer authenticate on the weak hash — it must
    // be reset by an admin (must_change_password). Reject WITHOUT computing any weak hash.
    if (/^[a-f0-9]{64}$/i.test(stored)) return { ok: false, needsRehash: false };
    return this.verifyScryptFormat(password, stored);
  }

  /**
   * Verify a secret against a stored hash WITHOUT the legacy unsalted-SHA-256 escape hatch — only the
   * (current and legacy-param, peppered or plain) scrypt formats are accepted. Use this for secrets that
   * are guaranteed to be in a scrypt format: PINs (always issued via hash()), and step-up re-checks for an
   * ALREADY-AUTHENTICATED user (a successful login transparently rehashes any legacy password to the
   * current format, so an authenticated caller's stored hash is scrypt by then). Keeping these flows out of
   * the SHA-256 branch means a PIN / step-up secret never reaches a weak-hash comparison.
   */
  async verifyScrypt(secret: string, stored: string): Promise<{ ok: boolean; needsRehash: boolean }> {
    return this.verifyScryptFormat(secret, stored);
  }

  // Shared scrypt verifier for both the parameterized (peppered `scrypt-p1$…` or plain `scrypt$…`) and the
  // legacy parameter-less format. `needsRehash` upgrades weaker cost parameters AND — when a pepper is now
  // configured — any non-peppered hash, so the un-peppered population drains on next login.
  private async verifyScryptFormat(secret: string, stored: string): Promise<{ ok: boolean; needsRehash: boolean }> {
    const parts = stored.split('$');
    const tag = parts[0];
    // current: (scrypt-p1|scrypt)$N$r$p$salt$hash
    if ((tag === PEPPER_TAG || tag === PLAIN_TAG) && parts.length === 6) {
      const peppered = tag === PEPPER_TAG;
      // A peppered hash cannot be verified if the pepper is not configured — fail closed (misconfiguration),
      // never silently accept.
      if (peppered && !PEPPER) return { ok: false, needsRehash: false };
      const [, nStr, rStr, pStr, salt, hashHex] = parts;
      const n = Number(nStr), r = Number(rStr), p = Number(pStr);
      // Peppered hashes derive the effective salt from the pepper; plain hashes use the stored salt as-is.
      const useSalt = peppered ? effectiveSalt(salt!) : salt!;
      const derived = (await scryptAsync(secret, useSalt, KEYLEN, { N: n, r, p, maxmem: MAXMEM })) as Buffer;
      const expected = Buffer.from(hashHex!, 'hex');
      const ok = derived.length === expected.length && timingSafeEqual(derived, expected);
      const wantsPepper = !!PEPPER && !peppered; // upgrade plain → peppered once a pepper exists
      return { ok, needsRehash: ok && (n < N || r < R || p < P || wantsPepper) };
    }
    // legacy: scrypt$salt$hash (no embedded params → Node-default N=16384) — always upgrade on success
    // (to the peppered current format when a pepper is configured, else the parameterized plain format).
    if (tag === PLAIN_TAG && parts.length === 3 && parts[1] && parts[2]) {
      const derived = (await scryptAsync(secret, parts[1], KEYLEN, { N: LEGACY_N, r: 8, p: 1, maxmem: MAXMEM })) as Buffer;
      const expected = Buffer.from(parts[2], 'hex');
      const ok = derived.length === expected.length && timingSafeEqual(derived, expected);
      return { ok, needsRehash: ok };
    }
    return { ok: false, needsRehash: false };
  }
}
