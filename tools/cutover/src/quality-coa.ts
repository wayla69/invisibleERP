/**
 * QMS-3 — Certificate of Analysis (CoA) capture + out-of-spec release approval (QC-03) over PGlite.
 * Spec create; CoA + in-spec results → pass → recorder releases; out-of-spec results → fail; recorder
 * self-release of a fail blocked (SOD_SELF_APPROVAL); release without a reason blocked
 * (DEVIATION_REASON_REQUIRED); a distinct approver releases the fail WITH a reason; the out-of-spec
 * (deviation) register; RLS isolation. References lot_no as text — the read-only lot_ledger is untouched.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover quality-coa
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'coa-secret';
process.env.NODE_ENV = 'test';
// multi-company so per-tenant Admins are RLS-scoped to their own tenant (single-company grants a global
// Admin bypass) — lets the RLS-isolation checks below prove a T1 Admin can't see/act on HQ CoAs.
process.env.TENANCY_MODE = 'multi-company';

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

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k: string) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'T1' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1] = [await tid('HQ'), await tid('T1')];
  await db.insert(s.users).values([
    { username: 'qcrec', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq }, // CoA recorder
    { username: 'qcmgr', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq }, // distinct deviation approver
    { username: 't1admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t1 }, // other tenant (RLS)
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ routerOptions: { maxParamLength: 500 } }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /**/ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const [rec, mgr, t1admin] = [await login('qcrec', 'admin123'), await login('qcmgr', 'admin123'), await login('t1admin', 'admin123')];

  // ── 1. Spec create ──
  const spec = await inj('POST', '/api/quality/specs', rec, { item_id: 'ITEM-A', characteristic: 'Moisture %', uom: '%', min_value: 10, max_value: 14, target_value: 12 });
  ok('Create quality spec → spec_no + range', spec.status === 201 && !!spec.json.spec_no && spec.json.min_value === 10 && spec.json.max_value === 14, JSON.stringify(spec.json));
  const specList = await inj('GET', '/api/quality/specs?item_id=ITEM-A', rec);
  ok('List specs by item', specList.status === 200 && specList.json.count === 1, JSON.stringify({ count: specList.json.count }));
  const badSpec = await inj('POST', '/api/quality/specs', rec, { item_id: 'ITEM-A', characteristic: 'pH', min_value: 9, max_value: 3 });
  ok('Spec min>max → 400 SPEC_RANGE_INVALID', badSpec.status === 400 && badSpec.json.error?.code === 'SPEC_RANGE_INVALID', JSON.stringify(badSpec.json));

  // ── 2. In-spec CoA → pass → recorder releases ──
  const coa1 = await inj('POST', '/api/quality/coa', rec, { lot_no: 'LOT-1001', item_id: 'ITEM-A', source: 'incoming' });
  ok('Create CoA → held/pending', coa1.status === 201 && coa1.json.overall_result === 'pending' && coa1.json.release_status === 'held', JSON.stringify(coa1.json));
  const coa1Id = coa1.json.id;
  const res1 = await inj('POST', `/api/quality/coa/${coa1Id}/results`, rec, { results: [{ characteristic: 'Moisture %', uom: '%', spec_min: 10, spec_max: 14, actual_value: 12 }] });
  ok('In-spec result computed pass', res1.status === 201 && res1.json.results?.[0]?.result === 'pass', JSON.stringify(res1.json));
  // Release before evaluate is blocked
  const early = await inj('POST', `/api/quality/coa/${coa1Id}/release`, rec, {});
  ok('Release before evaluate → 400 COA_NOT_EVALUATED', early.status === 400 && early.json.error?.code === 'COA_NOT_EVALUATED', JSON.stringify(early.json));
  const eval1 = await inj('POST', `/api/quality/coa/${coa1Id}/evaluate`, rec);
  ok('Evaluate in-spec CoA → overall pass', eval1.status === 200 && eval1.json.overall_result === 'pass' && eval1.json.out_of_spec === false, JSON.stringify(eval1.json));
  const rel1 = await inj('POST', `/api/quality/coa/${coa1Id}/release`, rec, {});
  ok('Recorder releases a PASS CoA (no deviation needed)', rel1.status === 200 && rel1.json.release_status === 'released' && rel1.json.deviation_release === false, JSON.stringify(rel1.json));

  // ── 3. Out-of-spec CoA → fail ──
  const coa2 = await inj('POST', '/api/quality/coa', rec, { lot_no: 'LOT-1002', item_id: 'ITEM-A', source: 'production' });
  const coa2Id = coa2.json.id;
  await inj('POST', `/api/quality/coa/${coa2Id}/results`, rec, { results: [
    { characteristic: 'Moisture %', uom: '%', spec_min: 10, spec_max: 14, actual_value: 18 }, // out of spec
    { characteristic: 'pH', spec_min: 6, spec_max: 8, actual_value: 7 }, // in spec
  ] });
  const eval2 = await inj('POST', `/api/quality/coa/${coa2Id}/evaluate`, rec);
  ok('Out-of-spec result → overall fail (1 failed characteristic)', eval2.status === 200 && eval2.json.overall_result === 'fail' && eval2.json.failed_count === 1, JSON.stringify(eval2.json));

  // ── 4. Recorder self-release of a fail is blocked (QC-03 maker-checker) ──
  const selfRel = await inj('POST', `/api/quality/coa/${coa2Id}/release`, rec, { deviation_reason: 'looks fine to me' });
  ok('Recorder self-releases a FAIL → 403 SOD_SELF_APPROVAL', selfRel.status === 403 && selfRel.json.error?.code === 'SOD_SELF_APPROVAL', JSON.stringify(selfRel.json));

  // ── 5. Distinct approver release WITHOUT a reason is blocked ──
  const noReason = await inj('POST', `/api/quality/coa/${coa2Id}/release`, mgr, {});
  ok('Out-of-spec release without reason → 400 DEVIATION_REASON_REQUIRED', noReason.status === 400 && noReason.json.error?.code === 'DEVIATION_REASON_REQUIRED', JSON.stringify(noReason.json));

  // ── 6. Distinct approver releases the fail WITH a deviation reason ──
  const rel2 = await inj('POST', `/api/quality/coa/${coa2Id}/release`, mgr, { deviation_reason: 'QA concession CN-77: within customer tolerance, one-time' });
  ok('Distinct approver releases out-of-spec lot with reason → released', rel2.status === 200 && rel2.json.release_status === 'released' && rel2.json.deviation_release === true && rel2.json.released_by === 'qcmgr', JSON.stringify(rel2.json));

  // ── 7. Reject path (a third fail CoA held & rejected) ──
  const coa3 = await inj('POST', '/api/quality/coa', rec, { lot_no: 'LOT-1003', item_id: 'ITEM-A', source: 'incoming' });
  const coa3Id = coa3.json.id;
  await inj('POST', `/api/quality/coa/${coa3Id}/results`, rec, { results: [{ characteristic: 'Moisture %', spec_min: 10, spec_max: 14, actual_value: 20 }] });
  await inj('POST', `/api/quality/coa/${coa3Id}/evaluate`, rec);
  const rej = await inj('POST', `/api/quality/coa/${coa3Id}/reject`, mgr, { reason: 'reworked; scrap the lot' });
  ok('Reject a fail CoA → release_status=rejected, not released', rej.status === 200 && rej.json.release_status === 'rejected' && rej.json.released === false, JSON.stringify(rej.json));

  // ── 8. Out-of-spec register (deviation audit sample) — only the RELEASED fail ──
  const register = await inj('GET', '/api/quality/coa/out-of-spec', mgr);
  const lots = (register.json.deviations ?? []).map((d: any) => d.lot_no);
  ok('Out-of-spec register lists the released fail only', register.status === 200 && register.json.count === 1 && lots.includes('LOT-1002') && !lots.includes('LOT-1003'), JSON.stringify(lots));

  // ── 9. RLS isolation — T1 cannot see or act on HQ CoAs ──
  const t1List = await inj('GET', '/api/quality/coa', t1admin);
  ok('RLS: T1 sees none of HQ CoAs', t1List.status === 200 && t1List.json.count === 0, JSON.stringify({ count: t1List.json.count }));
  const t1Get = await inj('GET', `/api/quality/coa/${coa1Id}`, t1admin);
  ok('RLS: T1 cannot read an HQ CoA → 404 COA_NOT_FOUND', t1Get.status === 404 && t1Get.json.error?.code === 'COA_NOT_FOUND', JSON.stringify(t1Get.json));

  await app.close();
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => {
  const pass = checks.filter((c) => c.ok).length;
  const fail = checks.filter((c) => !c.ok).length;
  console.log(`\n${'─'.repeat(60)}`);
  for (const c of checks) console.log(`${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  console.log(`${'─'.repeat(60)}\n${pass}/${checks.length} passed${fail ? ` (${fail} failed)` : ' 🎉'}`);
  if (fail) process.exit(1);
});
