/**
 * ToE — entity-level governance evidence capture (ELC-01 ethics acknowledgement register, ELC-04
 * whistleblower hotline case log). Boots the real Nest app over PGlite and asserts: a staff member can
 * acknowledge the code of conduct (idempotent), compliance sees the register; any staff can file an
 * (optionally anonymous) whistleblower case, the audit committee reviews + advances the case log; the
 * views are permission-gated and tenant-isolated (RLS).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover governance
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'governance-secret';
process.env.NODE_ENV = 'test';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import * as s from '../../../apps/api/dist/database/schema/index';
import { AppModule } from '../../../apps/api/dist/app.module';
import { DRIZZLE, tenantAwareProxy } from '../../../apps/api/dist/database/database.module';
import { AllExceptionsFilter } from '../../../apps/api/dist/common/all-exceptions.filter';
import { PasswordService } from '../../../apps/api/dist/modules/auth/password.service';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIG = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) await pg.exec(readFileSync(join(MIG, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();
  await db.insert(s.permissions).values(PERMISSIONS.map((k: string) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },     // HQ admin (RLS bypass)
    { username: 'audit1', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: t1 },           // T1 compliance/admin ('users'), RLS-scoped
    { username: 'staff1', passwordHash: await pw.hash('pw'), role: 'Sales', tenantId: t1 },           // T1 staff (no 'users')
    { username: 'staff2', passwordHash: await pw.hash('pw'), role: 'Sales', tenantId: t2 },           // T2 staff (RLS isolation probe)
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const [audit1, staff1, staff2] = [await login('audit1', 'pw'), await login('staff1', 'pw'), await login('staff2', 'pw')];

  // ── ELC-01: ethics acknowledgement (idempotent) + register ──
  const ack1 = await inj('POST', '/api/governance/ethics/acknowledge', staff1, { policy_version: '2026-CoC' });
  ok('ELC-01: staff acknowledges the code of conduct → 200 + acknowledged_at', (ack1.status === 200 || ack1.status === 201) && !!ack1.json.acknowledged_at && ack1.json.policy_version === '2026-CoC', JSON.stringify(ack1.json));
  await inj('POST', '/api/governance/ethics/acknowledge', staff1, { policy_version: '2026-CoC' }); // re-ack
  const reg = await inj('GET', '/api/governance/ethics/register?policy_version=2026-CoC', audit1);
  ok('ELC-01: acknowledgement is idempotent — register has exactly one row for (staff1, 2026-CoC)',
    reg.status === 200 && (reg.json.register ?? []).filter((r: any) => r.username === 'staff1' && r.policy_version === '2026-CoC').length === 1, JSON.stringify({ n: reg.json.count }));
  const regForbidden = await inj('GET', '/api/governance/ethics/register', staff1);
  ok('ELC-01: a non-compliance staff cannot view the register → 403', regForbidden.status === 403, `${regForbidden.status}`);

  // ── ELC-04: whistleblower intake (anonymous-capable) + case log + lifecycle ──
  const anon = await inj('POST', '/api/governance/hotline/cases', staff1, { allegation: 'Suspected expense fraud', category: 'fraud', anonymous: true });
  ok('ELC-04: anonymous report filed → case_ref, reporter not recorded', (anon.status === 200 || anon.status === 201) && /^WB-/.test(anon.json.case_ref ?? '') && anon.json.anonymous === true, JSON.stringify(anon.json));
  const named = await inj('POST', '/api/governance/hotline/cases', staff1, { allegation: 'Policy breach by manager', anonymous: false });
  ok('ELC-04: non-anonymous report records the reporter', (named.status === 200 || named.status === 201) && /^WB-/.test(named.json.case_ref ?? ''), JSON.stringify(named.json));
  const log = await inj('GET', '/api/governance/hotline/cases', audit1);
  const anonCase = (log.json.cases ?? []).find((c: any) => c.case_ref === anon.json.case_ref);
  const namedCase = (log.json.cases ?? []).find((c: any) => c.case_ref === named.json.case_ref);
  ok('ELC-04: audit committee sees the case log; anonymous case hides the reporter, named case keeps it',
    log.status === 200 && anonCase?.reporter == null && anonCase?.anonymous === true && namedCase?.reporter === 'staff1', JSON.stringify({ a: anonCase?.reporter, n: namedCase?.reporter }));
  const upd = await inj('PATCH', `/api/governance/hotline/cases/${anon.json.case_ref}`, audit1, { status: 'investigating', resolution_note: 'assigned to internal audit' });
  ok('ELC-04: a case advances through its lifecycle (received → investigating) with handler recorded',
    (upd.status === 200 || upd.status === 201) && upd.json.status === 'investigating' && upd.json.handled_by === 'audit1', JSON.stringify(upd.json));
  const fileForbidden = await inj('PATCH', `/api/governance/hotline/cases/${anon.json.case_ref}`, staff1, { status: 'resolved' });
  ok('ELC-04: a non-compliance staff cannot manage cases → 403', fileForbidden.status === 403, `${fileForbidden.status}`);

  // ── RLS: tenant isolation at the DB layer. (The admin API viewer bypasses RLS in single-company mode by
  //    design — ITGC-AC-18 — so isolation is asserted on a tenant-scoped app_user connection, not via admin.)
  const t2case = await inj('POST', '/api/governance/hotline/cases', staff2, { allegation: 'T2-only matter', anonymous: true });
  const isolation = await pg.transaction(async (tx: any) => {
    await tx.query('SET LOCAL ROLE app_user');
    await tx.query(`SELECT set_config('app.bypass_rls','off',true)`);
    await tx.query(`SELECT set_config('app.tenant_id',$1,true)`, [String(t1)]);
    const foreign = await tx.query(`SELECT case_ref FROM whistleblower_cases WHERE case_ref=$1`, [t2case.json.case_ref]); // T2's case → hidden
    return { foreign: foreign.rows.length };
  });
  ok('RLS: a tenant-scoped (T1) connection cannot see a T2 whistleblower case (tenant isolation)', isolation.foreign === 0, JSON.stringify(isolation));

  await app.close();
  console.log('\n── ELC-01 / ELC-04 — entity-level governance evidence capture ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) { console.log(`\n❌ ${failed}/${checks.length} governance checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} governance checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
