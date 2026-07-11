/**
 * HR-7 (docs/42, Wave 3) — Training & Certifications, control HR-07 (mandatory-training / certification
 * compliance). Boots the AppModule over PGlite, seeds a tenant + role/permission fixtures, and drives the
 * training endpoints end-to-end: course catalogue, sessions, enrollments, the completion → certification mint
 * (expiry = completed_date + validity_months), the SCORE_REQUIRED completion gate, the 404 on a foreign/absent
 * enrollment, the expired/expiring detective compliance read, ess own-scope reads, and RLS tenant isolation.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover hcm-training
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hcm-training-secret';
process.env.NODE_ENV = 'test';
process.env.TENANCY_MODE = 'multi-company'; // per-company isolation (org_id=NULL ⇒ own tenant only) — needed for the RLS check

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

// business-calendar YYYY-MM-DD math, matching the service (for building past/future completed_date fixtures).
const addDays = (d: string, days: number) => {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, day! + days)).toISOString().slice(0, 10);
};
const today = new Date().toISOString().slice(0, 10);

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();

  // Two separate companies (org_id NULL ⇒ each isolated to its own tenant in multi-company mode).
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'CO2', name: 'Second Co' }]).onConflictDoNothing();
  const t1 = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0].id);
  const t2 = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'CO2')))[0].id);

  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t1 },     // exec (read)
    { username: 'hradmin', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t1 },    // hr_admin (create + complete)
    { username: 'hrmaker', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t1 },    // hr only
    { username: 'essuser', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t1 },    // ess (own-scope reads)
    { username: 't2admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t2 },    // other company
  ]).onConflictDoNothing();
  const uid = async (u: string) => Number((await db.select().from(s.users).where(eq(s.users.username, u)))[0].id);
  await db.insert(s.userPermissions).values([
    { userId: await uid('hradmin'), perm: 'hr_admin' },
    { userId: await uid('hrmaker'), perm: 'hr' },
    { userId: await uid('essuser'), perm: 'ess' },
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
  const login = async (u: string) => (await inj('POST', '/api/login', undefined, { username: u, password: 'admin123' })).json.token;
  const admin = await login('admin');
  const hradmin = await login('hradmin');
  const hrmaker = await login('hrmaker');
  const essuser = await login('essuser');
  const t2admin = await login('t2admin');

  // Two employees on the shared payroll identity (T1); link emp2 to the ess login for own-scope reads.
  const e1 = await inj('POST', '/api/payroll/employees', admin, { name: 'Somchai', monthly_salary: 30000 });
  const e2 = await inj('POST', '/api/payroll/employees', admin, { name: 'Malee', monthly_salary: 28000 });
  const emp1 = e1.json.emp_code; const emp2 = e2.json.emp_code;
  await db.update(s.employees).set({ userName: 'essuser' }).where(eq(s.employees.empCode, emp2));
  ok('Seed two employees on payroll identity', /^EMP/.test(emp1 ?? '') && /^EMP/.test(emp2 ?? ''), JSON.stringify({ emp1, emp2 }));

  // ── 1. Course catalogue ──────────────────────────────────────────────────
  const safety = await inj('POST', '/api/hcm/training/courses', hradmin, { course_code: 'SAFETY', name: 'Safety Induction', category: 'safety', is_mandatory: true, validity_months: 12 });
  ok('hr_admin creates a mandatory recert course', safety.status < 300 && safety.json.course_code === 'SAFETY', JSON.stringify({ s: safety.status }));
  const scored = await inj('POST', '/api/hcm/training/courses', hradmin, { course_code: 'FIRSTAID', name: 'First Aid', category: 'compliance', is_mandatory: true, requires_score: true, validity_months: 24 });
  ok('Create a mandatory requires-score course', scored.status < 300 && scored.json.course_code === 'FIRSTAID', JSON.stringify({ s: scored.status }));
  await inj('POST', '/api/hcm/training/courses', hradmin, { course_code: 'ORIENT', name: 'Orientation', category: 'general' }); // non-mandatory, no validity
  await inj('POST', '/api/hcm/training/courses', hradmin, { course_code: 'EXPSOON', name: 'Expiring Soon', category: 'compliance', is_mandatory: true, validity_months: 1 });
  await inj('POST', '/api/hcm/training/courses', hradmin, { course_code: 'LAPSED', name: 'Lapsed Cert', category: 'safety', is_mandatory: true, validity_months: 1 });
  const dup = await inj('POST', '/api/hcm/training/courses', hradmin, { course_code: 'SAFETY', name: 'Dup' });
  ok('Duplicate course_code rejected (COURSE_EXISTS)', dup.status === 400 && dup.json?.error?.code === 'COURSE_EXISTS', JSON.stringify({ s: dup.status, c: dup.json?.error?.code }));
  const courseList = await inj('GET', '/api/hcm/training/courses', hrmaker);
  ok('hr (read) user CAN list courses', courseList.status === 200 && courseList.json.count >= 5, JSON.stringify({ s: courseList.status, c: courseList.json.count }));

  // ── 2. Sessions ──────────────────────────────────────────────────────────
  const mkSession = async (course: string, when: string) => (await inj('POST', '/api/hcm/training/sessions', hradmin, { course_code: course, session_date: when, instructor: 'Trainer A', capacity: 20 })).json.id;
  const safetySess = await mkSession('SAFETY', today);
  const scoredSess = await mkSession('FIRSTAID', today);
  const orientSess = await mkSession('ORIENT', today);
  const soonSess = await mkSession('EXPSOON', today);
  const lapsedSess = await mkSession('LAPSED', today);
  ok('Create training sessions for the courses', [safetySess, scoredSess, orientSess, soonSess, lapsedSess].every((x) => Number(x) > 0), JSON.stringify({ safetySess, scoredSess }));
  const sessBadCourse = await inj('POST', '/api/hcm/training/sessions', hradmin, { course_code: 'NOPE' });
  ok('Session on an unknown course rejected (COURSE_NOT_FOUND)', sessBadCourse.status === 404 && sessBadCourse.json?.error?.code === 'COURSE_NOT_FOUND', JSON.stringify({ s: sessBadCourse.status, c: sessBadCourse.json?.error?.code }));
  const sessList = await inj('GET', `/api/hcm/training/sessions?course_code=SAFETY`, hradmin);
  ok('List sessions filtered by course', sessList.status === 200 && sessList.json.count === 1, JSON.stringify({ c: sessList.json.count }));

  // ── 3. Enrollments + completion → certification mint (HR-07) ─────────────
  const enroll = async (session: number, emp: string, token = hradmin) => inj('POST', '/api/hcm/training/enrollments', token, { session_id: session, emp_code: emp });
  const en1 = await enroll(safetySess, emp1);
  ok('Enroll an employee into a session', en1.status < 300 && en1.json.status === 'enrolled', JSON.stringify({ s: en1.status }));
  const enDup = await enroll(safetySess, emp1);
  ok('Duplicate enrollment rejected (ALREADY_ENROLLED)', enDup.status === 400 && enDup.json?.error?.code === 'ALREADY_ENROLLED', JSON.stringify({ s: enDup.status, c: enDup.json?.error?.code }));

  // Complete a mandatory recert course → mints a certification with expiry = completed_date + validity_months.
  const done1 = await inj('POST', `/api/hcm/training/enrollments/${en1.json.id}/complete`, hradmin, {});
  ok('HR-07: completing a recert course mints a certification', done1.status < 300 && done1.json.status === 'completed' && done1.json.certification?.cert_code === 'SAFETY', JSON.stringify({ s: done1.status, cert: done1.json.certification }));
  ok('HR-07: minted certification expiry = completed_date + 12 months', done1.json.certification?.expiry_date === addMonths(today, 12), JSON.stringify({ exp: done1.json.certification?.expiry_date, want: addMonths(today, 12) }));

  // 404 on an absent enrollment.
  const done404 = await inj('POST', `/api/hcm/training/enrollments/999999/complete`, hradmin, {});
  ok('HR-07: completing an absent enrollment → 404 (ENROLLMENT_NOT_FOUND)', done404.status === 404 && done404.json?.error?.code === 'ENROLLMENT_NOT_FOUND', JSON.stringify({ s: done404.status, c: done404.json?.error?.code }));

  // SCORE_REQUIRED gate — a requires_score course cannot be completed without a score.
  const enScored = await enroll(scoredSess, emp1);
  const noScore = await inj('POST', `/api/hcm/training/enrollments/${enScored.json.id}/complete`, hradmin, {});
  ok('HR-07: completing a requires-score course with NO score → SCORE_REQUIRED', noScore.status === 400 && noScore.json?.error?.code === 'SCORE_REQUIRED', JSON.stringify({ s: noScore.status, c: noScore.json?.error?.code }));
  const withScore = await inj('POST', `/api/hcm/training/enrollments/${enScored.json.id}/complete`, hradmin, { score: 88 });
  ok('HR-07: completing with a score succeeds and mints the certification', withScore.status < 300 && withScore.json.score === 88 && withScore.json.certification?.cert_code === 'FIRSTAID', JSON.stringify({ s: withScore.status }));

  // A non-mandatory, non-recert course completion mints NO certification.
  const enOrient = await enroll(orientSess, emp1);
  const doneOrient = await inj('POST', `/api/hcm/training/enrollments/${enOrient.json.id}/complete`, hradmin, {});
  ok('HR-07: a non-mandatory/non-recert completion mints no certification', doneOrient.status < 300 && doneOrient.json.certification === null, JSON.stringify({ cert: doneOrient.json.certification }));

  // ── 4. Certifications + expiry compliance detective read (HR-07) ─────────
  // emp2: an EXPSOON cert expiring within ~1 month, and a LAPSED cert already expired (completed 3 months ago).
  const enSoon = await enroll(soonSess, emp2);
  await inj('POST', `/api/hcm/training/enrollments/${enSoon.json.id}/complete`, hradmin, {}); // expiry ≈ today+1mo
  const enLapsed = await enroll(lapsedSess, emp2);
  await inj('POST', `/api/hcm/training/enrollments/${enLapsed.json.id}/complete`, hradmin, { completed_date: addDays(today, -90) }); // expiry ≈ today-60d → expired

  const certList = await inj('GET', `/api/hcm/training/certifications?emp_code=${emp2}`, hradmin);
  ok('List an employee certifications (derived expired flag)', certList.status === 200 && certList.json.count === 2, JSON.stringify({ c: certList.json.count }));
  const lapsedRow = (certList.json.certifications ?? []).find((r: any) => r.cert_code === 'LAPSED');
  ok('HR-07: an expired mandatory cert reads status=expired', lapsedRow?.status === 'expired' && lapsedRow?.expired === true, JSON.stringify({ row: lapsedRow }));

  // Detective read — default 30d window surfaces both the lapsed (expired) and the soon-expiring (≈30d) certs.
  const comp = await inj('GET', '/api/hcm/training/compliance', admin);
  const compCodes = (comp.json.items ?? []).map((i: any) => i.cert_code);
  ok('HR-07 detective: compliance read surfaces the expired mandatory cert', comp.status === 200 && compCodes.includes('LAPSED') && comp.json.expired >= 1, JSON.stringify({ codes: compCodes, expired: comp.json.expired }));
  const compWide = await inj('GET', '/api/hcm/training/compliance?days=45', admin);
  const wideCodes = (compWide.json.items ?? []).map((i: any) => i.cert_code);
  ok('HR-07 detective: a wider window includes the soon-expiring cert (EXPSOON)', wideCodes.includes('EXPSOON') && compWide.json.expiring >= 1, JSON.stringify({ codes: wideCodes, expiring: compWide.json.expiring }));
  const compNarrow = await inj('GET', '/api/hcm/training/compliance?days=5', admin);
  const narrowCodes = (compNarrow.json.items ?? []).map((i: any) => i.cert_code);
  ok('HR-07 detective: a 5-day window excludes the ~30-day-out cert but keeps the expired one', !narrowCodes.includes('EXPSOON') && narrowCodes.includes('LAPSED'), JSON.stringify({ codes: narrowCodes }));
  ok('HR-07 detective: the non-expiring SAFETY (emp1) cert is NOT flagged as a lapse', !compWide.json.items.some((i: any) => i.cert_code === 'SAFETY'), JSON.stringify({ codes: wideCodes }));

  // Recert renewal supersedes the prior active cert (so only the freshest is evaluated).
  const soonSess2 = await mkSession('EXPSOON', today);
  const enRenew = await enroll(soonSess2, emp2);
  await inj('POST', `/api/hcm/training/enrollments/${enRenew.json.id}/complete`, hradmin, {});
  const soonCerts = (await inj('GET', `/api/hcm/training/certifications?emp_code=${emp2}`, hradmin)).json.certifications ?? [];
  const activeSoon = soonCerts.filter((r: any) => r.cert_code === 'EXPSOON' && r.status === 'active');
  ok('HR-07: recert renewal supersedes the prior active cert (one active EXPSOON)', activeSoon.length === 1, JSON.stringify({ n: activeSoon.length }));

  // ── 5. ess own-scope reads ────────────────────────────────────────────────
  const essCerts = await inj('GET', '/api/hcm/training/certifications', essuser);
  const essCertEmps = (essCerts.json.certifications ?? []).map((r: any) => r.emp_code);
  ok('ess user sees ONLY their own certifications (own-scope read)', essCerts.status === 200 && essCertEmps.length >= 1 && essCertEmps.every((c: string) => c === emp2), JSON.stringify({ essCertEmps }));
  const essEnr = await inj('GET', '/api/hcm/training/enrollments', essuser);
  const essEnrEmps = (essEnr.json.enrollments ?? []).map((r: any) => r.emp_code);
  ok('ess user sees ONLY their own enrollments (own-scope read)', essEnr.status === 200 && essEnrEmps.every((c: string) => c === emp2), JSON.stringify({ essEnrEmps }));

  // ── 6. RLS tenant isolation ──────────────────────────────────────────────
  const t2course = await inj('POST', '/api/hcm/training/courses', t2admin, { course_code: 'T2C', name: 'T2 Course' });
  ok('T2 admin can create its own course', t2course.status < 300, JSON.stringify({ s: t2course.status }));
  const t1courses = ((await inj('GET', '/api/hcm/training/courses', admin)).json.courses ?? []).map((c: any) => c.course_code);
  const t2courses = ((await inj('GET', '/api/hcm/training/courses', t2admin)).json.courses ?? []).map((c: any) => c.course_code);
  ok('RLS: T1 does NOT see T2C; T2 does NOT see SAFETY (tenant isolation)', t1courses.includes('SAFETY') && !t1courses.includes('T2C') && t2courses.includes('T2C') && !t2courses.includes('SAFETY'), JSON.stringify({ t1courses, t2courses }));

  console.log('\n── HR-7 — Training & Certifications (control HR-07) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} HR-7 training checks failed` : `\n✅ All ${checks.length} HR-7 training checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}

// calendar-month add matching the service (clamps day to the target month length).
function addMonths(ymdStr: string, months: number): string {
  const [y, m, d] = ymdStr.split('-').map(Number);
  const base = new Date(Date.UTC(y!, (m! - 1) + months, 1));
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(d!, lastDay));
  return base.toISOString().slice(0, 10);
}
main().catch((e) => { console.error(e); process.exit(1); });
