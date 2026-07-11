/**
 * ToE — GRC-1 / ITGC-MON-01: the auditor-facing Control Console (RCM catalogue + test-of-effectiveness
 * evidence). Boots the real Nest app over PGlite and asserts: the catalogue endpoint returns the full
 * control inventory (>=240 controls) + a census summary + family roll-up; a control-detail read returns the
 * 17 RCM fields + its (initially empty) ToE history; a ToE test-run is recorded against a control and read
 * back with its result/harness/checks; a run against an unknown control is rejected (404); the endpoints are
 * permission-gated; and a second tenant cannot see the first tenant's recorded test-runs (RLS isolation).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover control-console
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'control-console-secret';
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
    { username: 'audit1', passwordHash: await pw.hash('pw'), role: 'AccessAdmin', tenantId: t1 }, // T1 compliance ('users'), tenant-scoped (NO RLS bypass — not Admin)
    { username: 'audit2', passwordHash: await pw.hash('pw'), role: 'AccessAdmin', tenantId: t2 }, // T2 compliance (RLS isolation probe)
    { username: 'staff1', passwordHash: await pw.hash('pw'), role: 'ApClerk', tenantId: t1 },     // T1 staff (creditors/pr_raise only — no 'exec'/'users')
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
  const [audit1, audit2, staff1] = [await login('audit1', 'pw'), await login('audit2', 'pw'), await login('staff1', 'pw')];

  // ── Catalogue: full control inventory + census + families ──
  const cat = await inj('GET', '/api/controls/rcm', audit1);
  const controls = cat.json.controls ?? [];
  ok('Catalogue: GET /api/controls/rcm returns the full control inventory (>=240 controls)',
    cat.status === 200 && controls.length >= 240, `n=${controls.length}`);
  ok('Catalogue: each control carries all 17 RCM fields',
    controls.length > 0 && ['control_id', 'cycle', 'category', 'fsli', 'risk', 'assertion', 'description', 'prev_det', 'nature', 'frequency', 'owner', 'coso', 'code_reference', 'tod', 'toe', 'evidence', 'status'].every((k) => k in controls[0]),
    controls[0] ? Object.keys(controls[0]).length + ' keys' : 'no controls');
  ok('Catalogue: the census summary + family roll-up are present',
    typeof cat.json.census?.total === 'number' && cat.json.census.total === controls.length && Array.isArray(cat.json.families) && cat.json.families.length > 0,
    JSON.stringify({ total: cat.json.census?.total, families: cat.json.families?.length }));
  ok('Catalogue: ITGC-MON-01 (this capability) is itself in the catalogue',
    controls.some((c: any) => c.control_id === 'ITGC-MON-01'), '');

  // ── Control detail: 17 fields + (empty) ToE history + evidence containers ──
  const detail = await inj('GET', '/api/controls/rcm/GL-05', audit1);
  ok('Detail: GET /api/controls/rcm/GL-05 returns the control fields + evidence containers',
    detail.status === 200 && detail.json.control?.control_id === 'GL-05' && Array.isArray(detail.json.test_runs) && Array.isArray(detail.json.ccm_findings) && Array.isArray(detail.json.audit_evidence),
    JSON.stringify({ id: detail.json.control?.control_id, runs: detail.json.test_runs?.length }));
  ok('Detail: latest_test_run is null before any ToE run is recorded',
    detail.json.latest_test_run === null && detail.json.test_runs.length === 0, JSON.stringify(detail.json.latest_test_run));
  const bad = await inj('GET', '/api/controls/rcm/NOPE-99', audit1);
  ok('Detail: an unknown control id → 404 CONTROL_NOT_FOUND', bad.status === 404 && bad.json.error?.code === 'CONTROL_NOT_FOUND', `${bad.status} ${bad.json.error?.code}`);

  // ── Record a ToE test-run + read it back ──
  const rec = await inj('POST', '/api/controls/rcm/GL-05/test-run', audit1, { result: 'pass', harness: 'compliance', checks_passed: 8, checks_total: 8, evidence_ref: 'ci-run-123', notes: 'JE maker-checker re-performed' });
  ok('Test-run: POST records a ToE run (pass) with harness + check tally',
    (rec.status === 200 || rec.status === 201) && rec.json.result === 'pass' && rec.json.harness === 'compliance' && rec.json.checks_passed === 8 && rec.json.recorded_by === 'audit1',
    JSON.stringify(rec.json));
  const badRun = await inj('POST', '/api/controls/rcm/NOPE-99/test-run', audit1, { result: 'pass' });
  ok('Test-run: recording against an unknown control → 404 CONTROL_NOT_FOUND', badRun.status === 404 && badRun.json.error?.code === 'CONTROL_NOT_FOUND', `${badRun.status}`);
  const detail2 = await inj('GET', '/api/controls/rcm/GL-05', audit1);
  ok('Test-run: the recorded run is read back as latest_test_run on the control detail',
    detail2.status === 200 && detail2.json.test_runs.length === 1 && detail2.json.latest_test_run?.result === 'pass' && detail2.json.latest_test_run?.harness === 'compliance' && detail2.json.latest_test_run?.checks_total === 8,
    JSON.stringify(detail2.json.latest_test_run));

  // ── ITGC-MON-01 links CCM findings (it is a Monitoring control) ──
  const monDetail = await inj('GET', '/api/controls/rcm/ITGC-MON-01', audit1);
  ok('Detail: a Monitoring control (ITGC-MON-01) exposes the CCM-findings container', monDetail.status === 200 && Array.isArray(monDetail.json.ccm_findings), '');

  // ── Permission gating: a non-compliance staff cannot read the console ──
  const forbiddenCat = await inj('GET', '/api/controls/rcm', staff1);
  ok('Gating: a non-compliance staff cannot read the catalogue → 403', forbiddenCat.status === 403, `${forbiddenCat.status}`);
  const forbiddenRec = await inj('POST', '/api/controls/rcm/GL-05/test-run', staff1, { result: 'pass' });
  ok('Gating: a non-compliance staff cannot record a test-run → 403', forbiddenRec.status === 403, `${forbiddenRec.status}`);

  // ── RLS: T2 records its own run; the api viewer scopes by RLS, and a DB-level app_user probe confirms
  //    isolation (T1 connection cannot see T2's recorded run). ──
  await inj('POST', '/api/controls/rcm/GL-05/test-run', audit2, { result: 'fail', harness: 'manual', notes: 'T2 run' });
  const t2seenByT1 = await inj('GET', '/api/controls/rcm/GL-05', audit1);
  const t1RunOwners = (t2seenByT1.json.test_runs ?? []).map((r: any) => r.recorded_by);
  ok('RLS: T1 compliance sees its own GL-05 run but NOT T2\'s run (tenant isolation via the API)',
    t2seenByT1.json.test_runs.length === 1 && t1RunOwners.every((o: string) => o === 'audit1'), JSON.stringify(t1RunOwners));
  const isolation = await pg.transaction(async (tx: any) => {
    await tx.query('SET LOCAL ROLE app_user');
    await tx.query(`SELECT set_config('app.bypass_rls','off',true)`);
    await tx.query(`SELECT set_config('app.tenant_id',$1,true)`, [String(t1)]);
    const foreign = await tx.query(`SELECT id FROM control_test_runs WHERE notes = 'T2 run'`); // T2's run → hidden
    const own = await tx.query(`SELECT id FROM control_test_runs WHERE recorded_by = 'audit1'`);
    return { foreign: foreign.rows.length, own: own.rows.length };
  });
  ok('RLS: a tenant-scoped (T1) app_user connection cannot see T2\'s control_test_run row', isolation.foreign === 0 && isolation.own >= 1, JSON.stringify(isolation));

  await app.close();
  console.log('\n── GRC-1 / ITGC-MON-01 — Control Console (RCM catalogue + ToE evidence) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) { console.log(`\n❌ ${failed}/${checks.length} control-console checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} control-console checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
