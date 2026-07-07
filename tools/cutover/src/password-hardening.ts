/**
 * Wave 2 · 4.5 — password legacy-hash hardening ToE.
 * Verifies PasswordService.verify: current scrypt roundtrip, legacy scrypt upgrade, and the weak legacy
 * unsalted-SHA-256 path — accepted (flagged legacyWeak + needsRehash) when LEGACY_SHA256_LOGIN is on,
 * REJECTED when off. verifyScrypt never accepts the SHA-256 path.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover password-hardening
 */
import { createHash } from 'node:crypto';
import { PasswordService, legacySha256LoginAllowed } from '../../../apps/api/dist/modules/auth/password.service';

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

async function main() {
  const pw = new PasswordService();

  // ── current scrypt roundtrip ──
  const h = await pw.hash('S3cret!');
  ok('scrypt hash verifies', (await pw.verify('S3cret!', h)).ok === true);
  ok('wrong password rejected', (await pw.verify('nope', h)).ok === false);
  ok('current scrypt needs no rehash', (await pw.verify('S3cret!', h)).needsRehash === false);

  const legacyHash = sha256('OldP@ss');

  // ── LEGACY_SHA256_LOGIN on (default) ──
  process.env.LEGACY_SHA256_LOGIN = 'on';
  ok('flag on: helper true', legacySha256LoginAllowed() === true);
  const on = await pw.verify('OldP@ss', legacyHash);
  ok('flag on: legacy SHA-256 accepted', on.ok === true);
  ok('flag on: flagged legacyWeak', on.legacyWeak === true);
  ok('flag on: flagged needsRehash (upgrade to scrypt)', on.needsRehash === true);
  ok('flag on: wrong legacy password rejected', (await pw.verify('bad', legacyHash)).ok === false);

  // ── LEGACY_SHA256_LOGIN off (hardened) ──
  process.env.LEGACY_SHA256_LOGIN = 'off';
  ok('flag off: helper false', legacySha256LoginAllowed() === false);
  const off = await pw.verify('OldP@ss', legacyHash);
  ok('flag off: legacy SHA-256 REJECTED even with correct password', off.ok === false);
  ok('flag off: not flagged legacyWeak', !off.legacyWeak);

  // ── verifyScrypt never touches the SHA-256 branch ──
  process.env.LEGACY_SHA256_LOGIN = 'on';
  ok('verifyScrypt: SHA-256 hash never accepted (no weak branch)', (await pw.verifyScrypt('OldP@ss', legacyHash)).ok === false);
  ok('verifyScrypt: scrypt still works', (await pw.verifyScrypt('S3cret!', h)).ok === true);

  // reset for any downstream import
  delete process.env.LEGACY_SHA256_LOGIN;

  console.log('\n── Wave 2 · 4.5 — password legacy-hash hardening (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} password-hardening checks failed` : `\n✅ All ${checks.length} password-hardening checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
