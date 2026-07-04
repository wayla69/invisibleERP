/**
 * Ops recovery tool — reset a user's password when no one can log in to do it from /admin/users
 * (single-admin lockout). Deliberately NOT a "forgot password" email flow and there is NO default
 * credential (AUD-SEC-03 / docs/27 R0-3) — this needs server + DB access, which is the recovery gate.
 *
 * Run:   NEW_ADMIN_PASSWORD='…' pnpm --filter @ierp/api db:reset-password [username]
 *   or:  pnpm --filter @ierp/api db:reset-password [username]      (prompts for the password, no echo)
 *   username defaults to `admin`. Optional: CLEAR_MFA=1 to also drop a lost TOTP device.
 *
 * Safety: the password is read from stdin (no terminal echo) or the NEW_ADMIN_PASSWORD env — NEVER from
 * argv (which leaks in `ps`/shell history) — and is NEVER written to a log or the console (matches the
 * seed's no-clear-text-logging rule). The account is forced to rotate on next login, its login lockout is
 * cleared, and all existing sessions are revoked.
 */
import { resolve } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import * as schema from './schema';
import { PasswordService } from '../modules/auth/password.service';

for (const p of ['.env', resolve(process.cwd(), '../../.env')]) {
  try { (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(p); } catch { /* ignore */ }
}

const MIN_LEN = 8;

// Core mutation — driver-agnostic (works on postgres-js AND PGlite) so it can be smoke-tested. Returns a
// summary with NO secret in it. Throws USER_NOT_FOUND if the username does not exist.
export async function resetUserPassword(
  db: any,
  opts: { username: string; password: string; clearMfa?: boolean; pw?: PasswordService },
): Promise<{ username: string; role: string; mfaCleared: boolean }> {
  const uname = (opts.username ?? '').trim();
  if (!uname) throw new Error('USERNAME_REQUIRED');
  if (!opts.password || opts.password.length < MIN_LEN) throw new Error(`WEAK_PASSWORD (min ${MIN_LEN} chars)`);
  const pw = opts.pw ?? new PasswordService();

  // Match the username case-insensitively (users.username is stored as entered; be forgiving on input).
  const [u] = await db.select().from(schema.users).where(sql`lower(${schema.users.username}) = ${uname.toLowerCase()}`).limit(1);
  if (!u) throw new Error('USER_NOT_FOUND');

  const hash = await pw.hash(opts.password);
  const set: Record<string, unknown> = {
    passwordHash: hash,
    mustChangePassword: true,         // hard API gate — must rotate on first login (guards.ts)
    tokensValidFrom: new Date(),      // ITGC-AC-15 — revoke every existing session (JWTs issued before now)
  };
  if (opts.clearMfa) { set.mfaEnabled = false; set.totpSecret = null; }
  await db.update(schema.users).set(set).where(eq(schema.users.id, u.id));

  // Clear any login-throttle lockout (ITGC-AC-07; keyed by lower-cased username) so the new password works
  // immediately instead of hitting a leftover lock.
  await db.delete(schema.loginAttempts).where(eq(schema.loginAttempts.username, uname.toLowerCase()));

  return { username: u.username, role: u.role, mfaCleared: !!opts.clearMfa };
}

// Read a secret from stdin without echoing it (falls back to a plain line read when stdin is not a TTY,
// e.g. piped input in automation). Never prints the typed characters.
function readHidden(prompt: string): Promise<string> {
  return new Promise((res) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    if (!stdin.isTTY) {
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (d) => { buf += d; });
      stdin.on('end', () => res(buf.replace(/\r?\n$/, '')));
      return;
    }
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const onKey = (ch: string, key: { name?: string; ctrl?: boolean }) => {
      if (key && (key.name === 'return' || key.name === 'enter')) {
        stdin.setRawMode(false); stdin.pause(); stdin.off('keypress', onKey);
        process.stdout.write('\n'); res(buf); return;
      }
      if (key && key.ctrl && key.name === 'c') { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
      if (key && key.name === 'backspace') { buf = buf.slice(0, -1); return; }
      if (ch) buf += ch;
    };
    stdin.on('keypress', onKey);
  });
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set (copy .env.example → .env, or export it for this run)');

  const username = (process.argv[2] || process.env.RESET_USERNAME || 'admin').trim();
  const clearMfa = process.env.CLEAR_MFA === '1';

  // Password: env first (automation), else an interactive no-echo prompt. Confirmed twice when interactive.
  let password = process.env.NEW_ADMIN_PASSWORD ?? '';
  if (!password) {
    password = await readHidden(`New password for "${username}" (min ${MIN_LEN} chars, hidden): `);
    if (process.stdin.isTTY) {
      const again = await readHidden('Confirm new password: ');
      if (again !== password) throw new Error('Passwords did not match — nothing changed.');
    }
  }
  if (!password || password.length < MIN_LEN) throw new Error(`Password too short (min ${MIN_LEN} chars) — nothing changed.`);

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });
  try {
    const r = await resetUserPassword(db, { username, password, clearMfa });
    // NOTE: the password is intentionally never printed or logged.
    console.log(`✅ Reset password for "${r.username}" (role ${r.role}).`);
    console.log('   • must change password on next login (enforced)');
    console.log('   • login lockout cleared · all existing sessions revoked' + (r.mfaCleared ? ' · MFA disabled' : ''));
  } catch (e: any) {
    if (e?.message === 'USER_NOT_FOUND') throw new Error(`No user named "${username}" — check the username (nothing changed).`);
    throw e;
  } finally {
    await client.end();
  }
}

// Run only when invoked directly (so `resetUserPassword` can be imported by a smoke test without connecting).
if (process.argv[1] && /reset-admin-password\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e) => { console.error(`❌ ${e?.message ?? e}`); process.exit(1); });
}
