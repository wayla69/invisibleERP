/**
 * SVC-2 — Warranty & Entitlement registry (control SVC-01) over PGlite.
 * Term catalogue → serialized-unit registration (computed warranty_end) → the coverage-authorization control:
 * an in-coverage claim auto-authorizes FREE; an out-of-coverage claim parks pending and requires a DIFFERENT
 * authorizer (SOD_SELF_APPROVAL); the coverage-exceptions register captures authorized-free out-of-coverage
 * overrides; expiring detective read; RLS tenant isolation.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover warranty
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'warranty-secret';
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

// today + N days as YYYY-MM-DD (UTC) — for building coverage windows relative to "now"
const dayOffset = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

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
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    // requester (raise claims): exec; a distinct approver: FinancialController holds 'approvals'
    { username: 'agent1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: hq },      // Sales → exec
    { username: 'approver1', passwordHash: await pw.hash('pw2'), role: 'FinancialController', tenantId: hq }, // → approvals
    // a second-tenant admin to prove RLS isolation
    { username: 'admin_t1', passwordHash: await pw.hash('pw3'), role: 'Admin', tenantId: t1 },
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
  const [admin, agent1, approver1, adminT1] = [await login('admin', 'admin123'), await login('agent1', 'pw1'), await login('approver1', 'pw2'), await login('admin_t1', 'pw3')];

  // ── Terms ──
  // 1. Create a 12-month full-coverage term
  const term = await inj('POST', '/api/service/warranty/terms', admin, { term_code: 'W12', name: '12-month full', coverage_months: 12, coverage_type: 'full' });
  ok('Create warranty term W12 (12mo, full)', term.status === 201 && term.json.term_code === 'W12' && term.json.coverage_months === 12, JSON.stringify(term.json));
  const termId = term.json.id;

  // 2. Duplicate term_code → 409 TERM_EXISTS
  const dupTerm = await inj('POST', '/api/service/warranty/terms', admin, { term_code: 'W12', name: 'dup', coverage_months: 6 });
  ok('Duplicate term_code → 409 TERM_EXISTS', dupTerm.status === 409 && dupTerm.json.error?.code === 'TERM_EXISTS', JSON.stringify(dupTerm.json));

  // 3. A parts-only term (for the coverage-kind mismatch check)
  const partsTerm = await inj('POST', '/api/service/warranty/terms', admin, { term_code: 'WPARTS', name: 'parts only 12mo', coverage_months: 12, coverage_type: 'parts' });
  ok('Create parts-only term WPARTS', partsTerm.status === 201 && partsTerm.json.coverage_type === 'parts', JSON.stringify(partsTerm.json));

  // ── Installed base ──
  // 4. Register a unit sold today → warranty_end = sold + 12 months
  const soldDate = dayOffset(0);
  const expectEnd = (() => { const d = new Date(soldDate + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 12); return d.toISOString().slice(0, 10); })();
  const unit = await inj('POST', '/api/service/warranty/units', admin, { serial_no: 'SN-0001', item_code: 'PUMP-A', customer_name: 'Acme', sold_date: soldDate, warranty_term_id: termId });
  ok('Register unit SN-0001 → warranty_end computed (sold + 12mo)', unit.status === 201 && unit.json.serial_no === 'SN-0001' && unit.json.warranty_end === expectEnd, `end=${unit.json.warranty_end} expect=${expectEnd}`);
  const unitId = unit.json.id;

  // 5. Duplicate serial → 409 SERIAL_EXISTS
  const dupUnit = await inj('POST', '/api/service/warranty/units', admin, { serial_no: 'SN-0001', item_code: 'PUMP-A', sold_date: soldDate, warranty_term_id: termId });
  ok('Duplicate serial → 409 SERIAL_EXISTS', dupUnit.status === 409 && dupUnit.json.error?.code === 'SERIAL_EXISTS', JSON.stringify(dupUnit.json));

  // 6. A unit whose warranty already EXPIRED (sold 400 days ago, 12mo term)
  const expUnit = await inj('POST', '/api/service/warranty/units', admin, { serial_no: 'SN-EXP', item_code: 'PUMP-A', sold_date: dayOffset(-400), warranty_term_id: termId });
  ok('Register out-of-coverage unit SN-EXP (sold 400d ago)', expUnit.status === 201, JSON.stringify(expUnit.json));
  const expUnitId = expUnit.json.id;

  // 7. A unit under a parts-only term (for kind mismatch)
  const partsUnit = await inj('POST', '/api/service/warranty/units', admin, { serial_no: 'SN-PARTS', item_code: 'PUMP-A', sold_date: soldDate, warranty_term_id: partsTerm.json.id });
  ok('Register parts-only unit SN-PARTS', partsUnit.status === 201 && partsUnit.json.coverage_type === 'parts', JSON.stringify(partsUnit.json));
  const partsUnitId = partsUnit.json.id;

  // ── SVC-01 coverage-authorization control ──
  // 8. In-coverage claim (agent1) auto-authorizes FREE
  const inCov = await inj('POST', '/api/service/warranty/claims', agent1, { installed_base_id: unitId, fault: 'Seal leak', coverage_kind: 'full' });
  ok('In-coverage claim → auto-authorized, charge 0, is_in_coverage=true', inCov.status === 201 && inCov.json.status === 'authorized' && inCov.json.is_in_coverage === true && inCov.json.charge === 0, JSON.stringify(inCov.json));

  // 9. Out-of-coverage claim (expired unit) parks PENDING (not free)
  const outCov = await inj('POST', '/api/service/warranty/claims', agent1, { installed_base_id: expUnitId, fault: 'Motor burnt', coverage_kind: 'full' });
  ok('Out-of-coverage claim → pending, is_in_coverage=false', outCov.status === 201 && outCov.json.status === 'pending' && outCov.json.is_in_coverage === false, JSON.stringify(outCov.json));
  const outClaimId = outCov.json.id;

  // 10. Parts-only unit + a LABOR claim → out of coverage (kind mismatch) even though within window
  const kindMismatch = await inj('POST', '/api/service/warranty/claims', agent1, { installed_base_id: partsUnitId, fault: 'Labor callout', coverage_kind: 'labor' });
  ok('Parts-only unit + labor claim → out of coverage (kind mismatch)', kindMismatch.status === 201 && kindMismatch.json.is_in_coverage === false && kindMismatch.json.status === 'pending', JSON.stringify(kindMismatch.json));

  // 11. Self-authorize blocked → the requester cannot authorize their own claim. admin holds BOTH exec (raise)
  //     and approvals (authorize), so it is the pointed test of the in-app SOD_SELF_APPROVAL gate.
  const selfRaise = await inj('POST', '/api/service/warranty/claims', admin, { installed_base_id: expUnitId, fault: 'Self raise', coverage_kind: 'full' });
  ok('Admin raises an out-of-coverage claim (pending)', selfRaise.status === 201 && selfRaise.json.status === 'pending', JSON.stringify(selfRaise.json));
  const selfClaimId = selfRaise.json.id;
  const selfAuth = await inj('POST', `/api/service/warranty/claims/${selfClaimId}/authorize`, admin, { disposition: 'repair', charge: 0 });
  ok('Self-authorize blocked → 403 SOD_SELF_APPROVAL', selfAuth.status === 403 && selfAuth.json.error?.code === 'SOD_SELF_APPROVAL', JSON.stringify(selfAuth.json));

  // 12. A DISTINCT authorizer (approver1) approves with a charge (normal paid repair)
  const paidAuth = await inj('POST', `/api/service/warranty/claims/${selfClaimId}/authorize`, approver1, { disposition: 'repair', charge: 1500 });
  ok('Distinct authorizer approves with charge → authorized, charge 1500', paidAuth.status === 200 && paidAuth.json.status === 'authorized' && paidAuth.json.charge === 1500 && paidAuth.json.authorized_by === 'approver1', JSON.stringify(paidAuth.json));

  // 13. Distinct authorizer approves the agent1 out-of-coverage claim FREE (charge 0) → an override
  const freeOverride = await inj('POST', `/api/service/warranty/claims/${outClaimId}/authorize`, approver1, { disposition: 'replace', charge: 0 });
  ok('Distinct authorizer approves out-of-coverage FREE → override (charge 0)', freeOverride.status === 200 && freeOverride.json.status === 'authorized' && freeOverride.json.charge === 0, JSON.stringify(freeOverride.json));

  // 14. Re-authorize a non-pending claim → 400 CLAIM_NOT_PENDING
  const reAuth = await inj('POST', `/api/service/warranty/claims/${outClaimId}/authorize`, admin, { charge: 0 });
  ok('Re-authorize a decided claim → 400 CLAIM_NOT_PENDING', reAuth.status === 400 && reAuth.json.error?.code === 'CLAIM_NOT_PENDING', JSON.stringify(reAuth.json));

  // 15. Coverage-exceptions register → the free out-of-coverage override (claim from step 13) appears; the
  //     paid one (step 12) and the in-coverage auto-authorized one do NOT.
  const exceptions = await inj('GET', '/api/service/warranty/coverage-exceptions', admin);
  const exNos = (exceptions.json.exceptions ?? []).map((e: any) => e.claim_no);
  ok('Coverage-exceptions register lists the free out-of-coverage override only', exceptions.json.count === 1 && exNos.includes(outCov.json.claim_no), JSON.stringify(exceptions.json));

  // 16. Expiring detective read → the today-sold 12mo units are NOT within 30 days; a soon-expiring unit IS.
  await inj('POST', '/api/service/warranty/units', admin, { serial_no: 'SN-SOON', item_code: 'PUMP-A', sold_date: dayOffset(-360), warranty_term_id: termId }); // 12mo term → ends ~+5d
  const expiring = await inj('GET', '/api/service/warranty/expiring?days=30', admin);
  const expSerials = (expiring.json.units ?? []).map((u: any) => u.serial_no);
  ok('Expiring(30d) → surfaces SN-SOON, excludes fresh SN-0001', expSerials.includes('SN-SOON') && !expSerials.includes('SN-0001'), JSON.stringify(expSerials));

  // 17. Reject requires a reason + distinct user
  const rejRaise = await inj('POST', '/api/service/warranty/claims', agent1, { installed_base_id: expUnitId, fault: 'Bogus', coverage_kind: 'full' });
  const rejNoReason = await inj('POST', `/api/service/warranty/claims/${rejRaise.json.id}/reject`, admin, {});
  ok('Reject without reason → 400 (validation)', rejNoReason.status === 400, JSON.stringify(rejNoReason.json));
  const rejOk = await inj('POST', `/api/service/warranty/claims/${rejRaise.json.id}/reject`, admin, { reason: 'Not a warranty fault' });
  ok('Distinct user rejects with reason → closed/reject', rejOk.status === 200 && rejOk.json.status === 'closed' && rejOk.json.disposition === 'reject', JSON.stringify(rejOk.json));

  // 18. RLS tenant isolation → T1 admin sees none of HQ's terms/units
  const t1Terms = await inj('GET', '/api/service/warranty/terms', adminT1);
  const t1Units = await inj('GET', '/api/service/warranty/units', adminT1);
  ok('RLS isolation → T1 admin sees 0 HQ terms and 0 HQ units', (t1Terms.json.count === 0) && (t1Units.json.count === 0), `terms=${t1Terms.json.count} units=${t1Units.json.count}`);

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
