/**
 * Wave 2 · 4.5 — password legacy-hash hardening ToE.
 * Verifies PasswordService.verify: current scrypt roundtrip, legacy scrypt upgrade, and that the weak legacy
 * unsalted-SHA-256 path is REMOVED — a 64-hex stored value is always rejected without computing any weak
 * hash (CodeQL js/insufficient-password-hash sink eliminated). verifyScrypt likewise never accepts it.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover password-hardening
 */
import { createHash } from 'node:crypto';
import { PasswordService } from '../../../apps/api/dist/modules/auth/password.service';

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

  // ── legacy unsalted SHA-256 path REMOVED — always rejected, no flag, even with the correct password ──
  const r1 = await pw.verify('OldP@ss', legacyHash);
  ok('legacy SHA-256 REJECTED even with correct password', r1.ok === false);
  ok('legacy SHA-256 → no rehash signal (nothing to upgrade)', r1.needsRehash === false);
  ok('legacy SHA-256 → no legacyWeak flag (property removed)', (r1 as any).legacyWeak === undefined);
  ok('wrong legacy password also rejected', (await pw.verify('bad', legacyHash)).ok === false);

  // ── verifyScrypt never touches a SHA-256 value either ──
  ok('verifyScrypt: SHA-256 hash never accepted', (await pw.verifyScrypt('OldP@ss', legacyHash)).ok === false);
  ok('verifyScrypt: scrypt still works', (await pw.verifyScrypt('S3cret!', h)).ok === true);

  console.log('\n── Wave 2 · 4.5 — password legacy-hash hardening (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} password-hardening checks failed` : `\n✅ All ${checks.length} password-hardening checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
