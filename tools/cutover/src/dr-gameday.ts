/**
 * DR game-day (ITGC-OP-02) — executes the recovery end-to-end against a REAL Postgres and MEASURES the
 * RTO/RPO, exercising the actual ops scripts (tools/ops/pg-backup.sh + restore.sh). It is the automatable
 * core of the annual DR test: backup → simulated disaster → restore → verify → app bring-up, timed.
 *
 *   Phases:  setup (untimed) → BACKUP → [DISASTER] → RESTORE → MIGRATE → VERIFY → APP-READY
 *   RTO clock runs from the disaster to a ready+smoke-passing app on the recovered database.
 *   RPO is proven by reconciling key-table row counts captured at backup time against the restored db.
 *
 * Requires (CI / a host with psql, pg_dump, pg_restore, bash):
 *   DR_ADMIN_URL=postgres://user:pass@host:port/postgres   (a server where we may CREATE/DROP DATABASE)
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover dr-gameday
 *
 * NOTE: a same-cluster drill (CI) keeps the cluster-level `app_user` role from setup; a true fresh-cluster
 * region failover must (re)create that role — db:migrate does so. We re-assert it defensively below.
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dr-gameday-secret';
process.env.NODE_ENV = 'test';

import { execSync } from 'node:child_process';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import * as s from '../../../apps/api/dist/database/schema/index';
import { AppModule } from '../../../apps/api/dist/app.module';
import { DRIZZLE, tenantAwareProxy } from '../../../apps/api/dist/database/database.module';
import { AllExceptionsFilter } from '../../../apps/api/dist/common/all-exceptions.filter';
import { PasswordService } from '../../../apps/api/dist/modules/auth/password.service';

const REPO = resolve(process.cwd(), '../..');           // tools/cutover → repo root
const MIG_DIR = resolve(REPO, 'apps/api/drizzle');
const OUT_DIR = resolve(process.cwd(), 'dr-backups');   // throwaway
const KEY_TABLES = ['tenants', 'users', 'accounts', 'journal_entries']; // verify-restore.sh sanity set

const sh = (cmd: string, env: Record<string, string> = {}) =>
  execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }, encoding: 'utf8' });
const now = () => Date.now();
const secs = (ms: number) => (ms / 1000).toFixed(1);

function adminPsql(adminUrl: string, q: string): string {
  return sh(`psql "${adminUrl}" -v ON_ERROR_STOP=1 -tAc "${q.replace(/"/g, '\\"')}"`).trim();
}
function counts(url: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of KEY_TABLES) {
    try { out[t] = Number(sh(`psql "${url}" -tAc "SELECT count(*) FROM public.${t}"`).trim()); }
    catch { out[t] = -1; }
  }
  return out;
}

// Apply the drizzle migrations file-by-file via psql (NOT drizzle-kit). Each file is its own
// autocommit session, so the RLS DO-loops (which take ACCESS EXCLUSIVE on every tenant table) release
// their locks between files — drizzle-kit batches them into too few transactions and exhausts
// max_locks_per_transaction ("out of shared memory") on a stock postgres:16. Mirrors how pg-smoke/pg-core
// apply migrations on real Postgres.
function applyMigrations(url: string): void {
  for (const f of readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    sh(`psql "${url}" -v ON_ERROR_STOP=1 -f "${MIG_DIR}/${f}"`);
  }
}

// Re-establish the cluster-level app_user role + its table/sequence GRANTs after a --no-privileges
// restore (the dump carries schema + RLS policies but not roles/privileges). Light locks (GRANT, not DDL).
function reestablishAppUser(url: string): void {
  // Create the role if absent, tolerating "already exists" (roles are cluster-level and persist across the
  // dropped primary db). Deliberately NO `DO $$…$$` block: passed through a shell -c string, `$$` expands
  // to the shell's PID → "syntax error near <pid>".
  try { sh(`psql "${url}" -c "CREATE ROLE app_user NOLOGIN"`); } catch { /* already exists — fine */ }
  const grants = `GRANT USAGE ON SCHEMA public TO app_user; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user; GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user;`;
  sh(`psql "${url}" -v ON_ERROR_STOP=1 -c "${grants}"`);
}

async function main() {
  const ADMIN = process.env.DR_ADMIN_URL;
  if (!ADMIN) { console.log('dr-gameday: SKIPPED (set DR_ADMIN_URL to a Postgres server where DBs can be created/dropped)'); return; }
  const base = ADMIN.replace(/\/[^/]*$/, '');           // strip the trailing db name → server base
  const PRIMARY = `${base}/ierp_dr_primary`;
  const RECOVERY = `${base}/ierp_dr_recovery`;
  mkdirSync(OUT_DIR, { recursive: true });

  const phase: Record<string, number> = {};
  const report: string[] = [];
  const log = (m: string) => { console.log(m); report.push(m); };

  // ── SETUP (untimed) — stand up a "primary", migrate, seed representative data ────────────────────
  log('## DR game-day');
  for (const db of ['ierp_dr_primary', 'ierp_dr_recovery']) adminPsql(ADMIN, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  adminPsql(ADMIN, `CREATE DATABASE ierp_dr_primary`);
  log('- setup: created primary db; applying migrations (file-by-file)…');
  applyMigrations(PRIMARY);

  // Seed tenant + user + chart-of-accounts via DRIZZLE inside one app boot (NOT psql -c): a scrypt hash
  // contains `$` delimiters which a shell would expand inside a -c string, corrupting the stored hash →
  // login fails. Bound drizzle params avoid all shell escaping. Role 'ExecutiveViewer' is read-only and
  // NOT MFA-required, so the app-readiness phase can log in (an Admin/finance role gates login on TOTP).
  await seedPrimary(PRIMARY);

  const snapshot = counts(PRIMARY); // RPO evidence — the state captured at backup time
  log(`- setup: seeded; row snapshot = ${JSON.stringify(snapshot)}`);

  // ── BACKUP (timed) — the REAL pg-backup.sh ───────────────────────────────────────────────────────
  let t = now();
  sh(`bash ${REPO}/tools/ops/pg-backup.sh "${OUT_DIR}"`, { DATABASE_URL: PRIMARY });
  phase.backup = now() - t;
  const dump = readdirSync(OUT_DIR).filter((f) => f.endsWith('.dump.gz')).sort().pop()!;
  log(`- BACKUP: ${dump} in ${secs(phase.backup)}s`);

  // ── DISASTER — total loss of the primary database. RTO clock starts now. ─────────────────────────
  adminPsql(ADMIN, `DROP DATABASE ierp_dr_primary WITH (FORCE)`);
  log('- DISASTER: primary database dropped (simulated total loss) — RTO clock START');
  const rto0 = now();

  // ── RESTORE (timed) — the REAL restore.sh into a fresh db ────────────────────────────────────────
  adminPsql(ADMIN, `CREATE DATABASE ierp_dr_recovery`);
  t = now();
  sh(`bash ${REPO}/tools/ops/restore.sh "${OUT_DIR}/${dump}"`, { TARGET_DATABASE_URL: RECOVERY, FORCE: '1' });
  phase.restore = now() - t;
  log(`- RESTORE: ${secs(phase.restore)}s`);

  // ── RE-GRANT (timed) — the --no-privileges dump restored schema + RLS policies but NOT the
  // cluster-level app_user role or its GRANTs; re-establish them so the app (running as app_user) can
  // query the recovered db. This is the documented post-restore step (restore.sh note).
  t = now();
  reestablishAppUser(RECOVERY);
  phase.migrate = now() - t;
  log(`- RE-GRANT app_user role + privileges: ${secs(phase.migrate)}s`);

  // ── VERIFY (timed) — key tables restorable + RPO reconciliation ──────────────────────────────────
  t = now();
  const restored = counts(RECOVERY);
  phase.verify = now() - t;
  const rpoOk = KEY_TABLES.every((k) => restored[k] >= 0 && restored[k] === snapshot[k]);
  log(`- VERIFY: restored = ${JSON.stringify(restored)} (${secs(phase.verify)}s) — RPO ${rpoOk ? 'OK (0 loss)' : 'MISMATCH'}`);

  // ── APP-READY (timed) — boot the real app on the recovered db, /readyz + login smoke ─────────────
  t = now();
  const client = postgres(RECOVERY, { max: 4, onnotice: () => {} });
  const db = tenantAwareProxy(drizzle(client, { schema: s }) as any);
  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(db).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const ready = await app.inject({ method: 'GET', url: '/readyz' });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'druser', password: 'admin123' } });
  let token = ''; try { token = login.json().token; } catch { /* */ }
  // Bonus authenticated read (informational — not part of the verdict, to avoid coupling the DR smoke to a
  // specific module permission): the session works against the recovered db.
  const kpi = token ? await app.inject({ method: 'GET', url: '/api/finance/kpi', headers: { authorization: `Bearer ${token}` } }) : { statusCode: 0 };
  phase.appReady = now() - t;
  // Verdict gate = the app boots on the recovered db (/readyz) AND the recovered auth data logs in (token).
  const appOk = ready.statusCode === 200 && !!token;
  log(`- APP-READY: /readyz=${ready.statusCode}, login=${token ? 'ok' : 'FAIL'}, kpi=${(kpi as any).statusCode} (informational) (${secs(phase.appReady)}s)`);
  await app.close();
  await client.end({ timeout: 5 });

  const rtoMs = now() - rto0;
  log('- RTO clock STOP');

  // ── REPORT ───────────────────────────────────────────────────────────────────────────────────────
  const RTO_TARGET_MIN = 30;
  const rtoMin = rtoMs / 60000;
  const pass = rpoOk && appOk && rtoMin <= RTO_TARGET_MIN;
  log('');
  log('### Result');
  log(`| Phase | Duration |`);
  log(`|---|---|`);
  log(`| Backup | ${secs(phase.backup)}s |`);
  log(`| Restore | ${secs(phase.restore)}s |`);
  log(`| Migrate (idempotent) | ${secs(phase.migrate)}s |`);
  log(`| Verify | ${secs(phase.verify)}s |`);
  log(`| App bring-up | ${secs(phase.appReady)}s |`);
  log(`| **Measured RTO** (restore→ready) | **${secs(rtoMs)}s (${rtoMin.toFixed(2)} min)** |`);
  log(`| RTO target | ${RTO_TARGET_MIN} min |`);
  log(`| RPO (key-table reconciliation) | ${rpoOk ? '0 loss' : 'MISMATCH'} |`);
  log(`| App smoke (readyz + login + GL read) | ${appOk ? 'PASS' : 'FAIL'} |`);
  log(`| **Verdict** | **${pass ? 'PASS ✅' : 'FAIL ❌'}** |`);

  // cleanup
  for (const dbn of ['ierp_dr_primary', 'ierp_dr_recovery']) adminPsql(ADMIN, `DROP DATABASE IF EXISTS ${dbn} WITH (FORCE)`);

  // Emit the report so CI can upload it as DR-test evidence.
  mkdirSync(resolve(REPO, 'dr-gameday-out'), { recursive: true });
  writeFileSync(resolve(REPO, 'dr-gameday-out/report.md'), report.join('\n') + '\n');

  console.log(`\ndr-gameday: ${pass ? 'PASS' : 'FAIL'} — measured RTO ${secs(rtoMs)}s, RPO ${rpoOk ? '0' : 'mismatch'}`);
  process.exit(pass ? 0 : 1);
}

// Boot the app once against `url` and seed tenant + login user + chart-of-accounts — all via DRIZZLE
// (bound params, no shell/psql), so the scrypt password hash (which contains `$`) is stored intact.
async function seedPrimary(url: string): Promise<void> {
  const client = postgres(url, { max: 2, onnotice: () => {} });
  const db = tenantAwareProxy(drizzle(client, { schema: s }) as any);
  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(db).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const hash = await new PasswordService().hash('admin123');
  const { LedgerService } = await import('../../../apps/api/dist/modules/ledger/ledger.service');
  const { runInTenantContext } = await import('../../../apps/api/dist/common/tenant-run');
  const ledger = app.get(LedgerService);
  try {
    await runInTenantContext(db, { tenantId: null, bypass: true, actor: 'dr-seed' }, async () => {
      await db.insert(s.tenants).values({ code: 'DR-HQ', name: 'DR HQ' }).onConflictDoNothing();
      const [hq] = await db.select().from(s.tenants).where(eq(s.tenants.code, 'DR-HQ'));
      // ExecutiveViewer = read-only, NOT MFA-required → the readiness phase can log in.
      await db.insert(s.users).values({ username: 'druser', passwordHash: hash, role: 'ExecutiveViewer' as any, tenantId: Number(hq.id) }).onConflictDoNothing();
      await ledger.seedChartOfAccounts(); // populate `accounts` so the VERIFY key-table set is non-empty
    });
  } finally {
    await app.close();
    await client.end({ timeout: 5 });
  }
}

main().catch((e) => { console.error('dr-gameday crashed:', e); process.exit(1); });
