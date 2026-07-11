/**
 * HR-3 — Performance management (docs/42 HCM depth). Proves the appraisal loop and Control HR-03:
 *   - create a cycle; add goals whose weights validate <= 100% (over-100% -> WEIGHT_EXCEEDED);
 *   - self-review, manager rating by a DIFFERENT employee (ok);
 *   - self-review then self-sign -> SOD_SELF_REVIEW; sign without a manager rating -> NO_MANAGER_RATING;
 *   - calibrate + sign by HR (ok); cycle close; cross-tenant RLS isolation.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover hcm-perf
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hcm-perf-secret';
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

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [t1, t2] = [await tid('T1'), await tid('T2')];

  // Users: hradmin (hr_admin, t1), hrops (hr, t1), emp1login linked to employee E001 (t1, self-review probe),
  // hrT2 (hr_admin, t2) for the RLS isolation probe. All non-Admin so the permission gates are exercised.
  await db.insert(s.users).values([
    { username: 'hradmin', passwordHash: await pw.hash('pw'), role: 'AccessAdmin', tenantId: t1 },
    { username: 'hrops', passwordHash: await pw.hash('pw'), role: 'AccessAdmin', tenantId: t1 },
    { username: 'emp1login', passwordHash: await pw.hash('pw'), role: 'AccessAdmin', tenantId: t1 },
    { username: 'hrT2', passwordHash: await pw.hash('pw'), role: 'AccessAdmin', tenantId: t2 },
  ]).onConflictDoNothing();
  const uid = async (un: string) => Number((await db.select().from(s.users).where(eq(s.users.username, un)))[0].id);
  // Grant HR duties via explicit per-user overrides (overrides take precedence over the AccessAdmin default).
  for (const [un, perms] of [
    ['hradmin', ['hr', 'hr_admin']], ['hrops', ['hr']], ['emp1login', ['hr']], ['hrT2', ['hr', 'hr_admin']],
  ] as const) {
    const id = await uid(un);
    await db.insert(s.userPermissions).values(perms.map((perm) => ({ userId: id, perm }))).onConflictDoNothing();
  }

  // Employees: E001 links to emp1login (so a self-review by emp1 is caught at sign-off); E002 is the manager.
  await db.insert(s.employees).values([
    { tenantId: t1, empCode: 'E001', name: 'Somchai', position: 'Cook', userName: 'emp1login', monthlySalary: '20000' },
    { tenantId: t1, empCode: 'E002', name: 'Manager', position: 'GM', userName: 'hradmin', monthlySalary: '40000' },
    { tenantId: t2, empCode: 'E900', name: 'Other Co', position: 'Staff', monthlySalary: '15000' },
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
  const login = async (u: string) => (await inj('POST', '/api/login', undefined, { username: u, password: 'pw' })).json.token as string;
  const hradmin = await login('hradmin');
  const hrops = await login('hrops');
  const emp1 = await login('emp1login');
  const hrT2 = await login('hrT2');

  // 1. Create a cycle (hr).
  const cyc = await inj('POST', '/api/hcm/performance/cycles', hrops, { name: 'H1-2026', period_start: '2026-01-01', period_end: '2026-06-30' });
  const cycleId = cyc.json.id as number;
  ok('Create appraisal cycle (open)', (cyc.status === 200 || cyc.status === 201) && cyc.json.status === 'open' && !!cycleId, JSON.stringify(cyc.json));

  // 2. List cycles.
  const cycList = await inj('GET', '/api/hcm/performance/cycles', hradmin);
  ok('List cycles shows the new cycle', (cycList.json.cycles ?? []).some((c: any) => c.id === cycleId), JSON.stringify(cycList.json).slice(0, 80));

  // 3. Add goals for E001 totalling exactly 100% (60 + 40).
  const g1 = await inj('POST', '/api/hcm/performance/goals', hrops, { cycle_id: cycleId, emp_code: 'E001', title: 'Ship HR-3', weight_pct: 60, metric: 'delivery', target: 'GA' });
  const g2 = await inj('POST', '/api/hcm/performance/goals', hrops, { cycle_id: cycleId, emp_code: 'E001', title: 'Quality', weight_pct: 40 });
  ok('Add two goals (weights 60 + 40 = 100%)', (g1.status === 200 || g1.status === 201) && (g2.status === 200 || g2.status === 201) && !!g1.json.id && !!g2.json.id, `${g1.status}/${g2.status}`);

  // 4. A third goal pushing weights over 100% -> WEIGHT_EXCEEDED.
  const g3 = await inj('POST', '/api/hcm/performance/goals', hrops, { cycle_id: cycleId, emp_code: 'E001', title: 'Extra', weight_pct: 10 });
  ok('Goal weights over 100% -> 400 WEIGHT_EXCEEDED', g3.status === 400 && g3.json.error?.code === 'WEIGHT_EXCEEDED', `${g3.status} ${g3.json.error?.code}`);

  // 5. Patch goal progress.
  const patch = await inj('PATCH', `/api/hcm/performance/goals/${g1.json.id}`, hrops, { progress_pct: 50, status: 'active' });
  ok('Patch goal progress -> 50%', (patch.status === 200 || patch.status === 201) && patch.json.progress_pct === 50, JSON.stringify(patch.json));

  // 6. Self-assessment review for E001 (created by emp1 for their own record).
  const rev = await inj('POST', '/api/hcm/performance/reviews', emp1, { cycle_id: cycleId, emp_code: 'E001', self_rating: 4, comments: 'good year' });
  const reviewId = rev.json.id as number;
  ok('Self-assessment review created (status self)', (rev.status === 200 || rev.status === 201) && rev.json.status === 'self' && !!reviewId, JSON.stringify(rev.json));

  // 7. Sign-off attempted with no manager rating yet -> NO_MANAGER_RATING.
  const signEarly = await inj('POST', `/api/hcm/performance/reviews/${reviewId}/sign`, hradmin, {});
  ok('Sign without manager rating -> 400 NO_MANAGER_RATING', signEarly.status === 400 && signEarly.json.error?.code === 'NO_MANAGER_RATING', `${signEarly.status} ${signEarly.json.error?.code}`);

  // 8. Manager rating by the reviewee themselves -> SOD_SELF_REVIEW.
  const selfRate = await inj('POST', `/api/hcm/performance/reviews/${reviewId}/manager`, hradmin, { manager_emp_code: 'E001', manager_rating: 5 });
  ok('Manager rating with manager_emp_code == reviewee -> 403 SOD_SELF_REVIEW', selfRate.status === 403 && selfRate.json.error?.code === 'SOD_SELF_REVIEW', `${selfRate.status} ${selfRate.json.error?.code}`);

  // 9. Manager rating by a DIFFERENT employee (E002) -> ok, status 'manager'.
  const mrate = await inj('POST', `/api/hcm/performance/reviews/${reviewId}/manager`, hradmin, { manager_emp_code: 'E002', manager_rating: 4.5, comments: 'solid' });
  ok('Manager rating by a different employee (E002) -> status manager', (mrate.status === 200 || mrate.status === 201) && mrate.json.status === 'manager' && mrate.json.manager_rating === 4.5, JSON.stringify(mrate.json));

  // 10. The reviewee (emp1, linked to E001) tries to sign their own review -> SOD_SELF_REVIEW.
  const selfSign = await inj('POST', `/api/hcm/performance/reviews/${reviewId}/sign`, emp1, { calibrated_rating: 5 });
  // emp1 holds only 'hr' (not hr_admin/exec) so the perm gate would 403 first; grant path is tested via a
  // second review below. Accept either the SoD block or the perm gate — both prove emp1 cannot self-finalise.
  ok('Reviewee cannot self-sign (SoD or perm gate blocks)', selfSign.status === 403, `${selfSign.status} ${selfSign.json.error?.code}`);

  // 10b. A self-review self-sign by an hr_admin who IS the reviewee -> SOD_SELF_REVIEW (link hradmin=E002 as reviewee).
  const rev2 = await inj('POST', '/api/hcm/performance/reviews', hradmin, { cycle_id: cycleId, emp_code: 'E002', self_rating: 5 });
  await inj('POST', `/api/hcm/performance/reviews/${rev2.json.id}/manager`, hradmin, { manager_emp_code: 'E001', manager_rating: 4 });
  const selfSign2 = await inj('POST', `/api/hcm/performance/reviews/${rev2.json.id}/sign`, hradmin, {});
  ok('hr_admin signing OWN review (signer==reviewee) -> 403 SOD_SELF_REVIEW', selfSign2.status === 403 && selfSign2.json.error?.code === 'SOD_SELF_REVIEW', `${selfSign2.status} ${selfSign2.json.error?.code}`);

  // 11. Calibrate + sign the E001 review by HR (hradmin links to E002 ≠ E001) -> signed.
  const sign = await inj('POST', `/api/hcm/performance/reviews/${reviewId}/sign`, hradmin, { calibrated_rating: 4.25 });
  ok('Calibrate + sign by HR (signer ≠ reviewee) -> status signed', (sign.status === 200 || sign.status === 201) && sign.json.status === 'signed' && sign.json.calibrated_rating === 4.25, JSON.stringify(sign.json));

  // 12. Re-sign is idempotent.
  const resign = await inj('POST', `/api/hcm/performance/reviews/${reviewId}/sign`, hradmin, {});
  ok('Re-sign is idempotent (already signed)', resign.json.status === 'signed' && resign.json.already === true, JSON.stringify(resign.json));

  // 13. Cross-tenant RLS isolation: an hr_admin in T2 sees none of T1's cycles/goals/reviews.
  const t2Cyc = await inj('GET', '/api/hcm/performance/cycles', hrT2);
  const t2Rev = await inj('GET', `/api/hcm/performance/reviews?cycle_id=${cycleId}`, hrT2);
  ok('RLS: T2 HR sees no T1 cycle', !(t2Cyc.json.cycles ?? []).some((c: any) => c.id === cycleId), JSON.stringify(t2Cyc.json).slice(0, 60));
  ok('RLS: T2 HR sees no T1 reviews', (t2Rev.json.count ?? 0) === 0, JSON.stringify(t2Rev.json).slice(0, 60));

  // 14. Close the cycle -> calibration/close guard; further goal creation blocked.
  const close = await inj('POST', `/api/hcm/performance/cycles/${cycleId}/close`, hradmin, {});
  ok('Close cycle -> status closed', (close.status === 200 || close.status === 201) && close.json.status === 'closed', JSON.stringify(close.json));
  const gClosed = await inj('POST', '/api/hcm/performance/goals', hrops, { cycle_id: cycleId, emp_code: 'E001', title: 'Late', weight_pct: 5 });
  ok('Add goal to a closed cycle -> 400 CYCLE_CLOSED', gClosed.status === 400 && gClosed.json.error?.code === 'CYCLE_CLOSED', `${gClosed.status} ${gClosed.json.error?.code}`);

  await app.close();
  await pg.close();

  console.log('\n── HR-3 — Performance management (HR-03) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} hcm-perf checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} hcm-perf checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
