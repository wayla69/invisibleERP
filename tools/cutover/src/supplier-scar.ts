/**
 * QMS-4 — Supplier Corrective Action Request (SCAR / 8D) control QC-04 over PGlite.
 * Raise a SCAR from a real gr_claim; close blocked while incomplete (SCAR_INCOMPLETE); self-close blocked
 * (SOD_SELF_APPROVAL); supplier responds + populates the 8D fields; a DISTINCT reviewer closes it effective;
 * the overdue detective read (GET /api/quality/scar/open); RLS isolation. Builds ONLY on gr_claims/vendors —
 * never recomputes a supplier scorecard.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover supplier-scar
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'scar-secret';
process.env.NODE_ENV = 'test';
// multi-company so per-tenant Admins are RLS-scoped to their own tenant (single-company grants a global
// Admin bypass) — lets the RLS-isolation checks below prove a T1 Admin can't see/act on HQ SCARs.
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
    { username: 'qa', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },       // SCAR raiser (HQ)
    { username: 'qmgr', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },      // distinct closure reviewer (QC-04 maker-checker)
    { username: 't1admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t1 },   // other tenant (RLS)
  ]).onConflictDoNothing();

  // Seed a supplier + a real GR claim in HQ (the SCAR sources from this claim; a fabricated ref is rejected).
  const [vendor] = await db.insert(s.vendors).values({ tenantId: hq, vendorCode: 'V-ACME', name: 'Acme Parts', isSupplier: true }).returning();
  const vid = Number(vendor.id);
  await db.insert(s.grClaims).values({ tenantId: hq, claimNo: 'CLM-QMS4-1', vendorId: vid, grNo: 'GR-1', itemId: 'ITM-1', reason: 'Damaged on arrival', status: 'Open' }).onConflictDoNothing();

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
  const [qa, qmgr, t1admin] = [await login('qa', 'admin123'), await login('qmgr', 'admin123'), await login('t1admin', 'admin123')];

  // ── 1. Raise a SCAR from a real claim ──
  const raise = await inj('POST', '/api/quality/scar', qa, { vendor_id: vid, source_claim_no: 'CLM-QMS4-1', defect_summary: 'Repeated dimensional defects on bracket lot', severity: 'major', due_date: '2026-07-01' });
  ok('Raise SCAR from a real claim → open', raise.status === 201 && raise.json.status === 'open' && !!raise.json.scar_no && raise.json.source_claim_no === 'CLM-QMS4-1', JSON.stringify(raise.json));
  const scarId = raise.json.id;

  // ── 2. Raising against a fabricated claim ref is rejected (no fictitious defect reference) ──
  const badClaim = await inj('POST', '/api/quality/scar', qa, { vendor_id: vid, source_claim_no: 'CLM-DOES-NOT-EXIST', defect_summary: 'x' });
  ok('SCAR against a non-existent claim → 400 CLAIM_NOT_FOUND', badClaim.status === 400 && badClaim.json.error?.code === 'CLAIM_NOT_FOUND', JSON.stringify(badClaim.json));

  // ── 3. Close blocked while the 8D response is incomplete ──
  const earlyClose = await inj('POST', `/api/quality/scar/${scarId}/close`, qmgr, { effectiveness: 'effective' });
  ok('Close before supplier response/8D → 400 SCAR_INCOMPLETE', earlyClose.status === 400 && earlyClose.json.error?.code === 'SCAR_INCOMPLETE', JSON.stringify(earlyClose.json));

  // ── 4. Supplier responds + populates the 8D fields ──
  const respond = await inj('POST', `/api/quality/scar/${scarId}/respond`, qa, { containment: 'Quarantined lot', root_cause: 'Worn die', corrective_action: 'Replaced die + re-ran SPC', preventive_action: 'Added die-wear PM', responder: 'Acme QA' });
  ok('Supplier response populates 8D → supplier_responded', respond.status === 200 && respond.json.status === 'supplier_responded' && respond.json.root_cause === 'Worn die', JSON.stringify(respond.json));

  // ── 5. Submit for closure review (supplier_responded → pending_closure) ──
  const submit = await inj('POST', `/api/quality/scar/${scarId}/submit-closure`, qa);
  ok('Submit for closure → pending_closure', submit.status === 200 && submit.json.status === 'pending_closure', JSON.stringify(submit.json));

  // ── 6. QC-04: the raiser cannot close their own SCAR ──
  const selfClose = await inj('POST', `/api/quality/scar/${scarId}/close`, qa, { effectiveness: 'effective' });
  ok('Raiser self-close → 403 SOD_SELF_APPROVAL', selfClose.status === 403 && selfClose.json.error?.code === 'SOD_SELF_APPROVAL', JSON.stringify(selfClose.json));

  // ── 7. A DISTINCT reviewer closes it effective (requalifies the supplier) ──
  const close = await inj('POST', `/api/quality/scar/${scarId}/close`, qmgr, { effectiveness: 'effective' });
  ok('Distinct reviewer closes effective → closed + requalifies_supplier', close.status === 200 && close.json.status === 'closed' && close.json.effectiveness === 'effective' && close.json.requalifies_supplier === true && close.json.closed_by === 'qmgr', JSON.stringify(close.json));

  // ── 8. A closed SCAR cannot be re-decided ──
  const reClose = await inj('POST', `/api/quality/scar/${scarId}/reject`, qmgr, { reason: 'x' });
  ok('Re-decide a closed SCAR → 400 SCAR_ALREADY_CLOSED', reClose.status === 400 && reClose.json.error?.code === 'SCAR_ALREADY_CLOSED', JSON.stringify(reClose.json));

  // ── 9. Overdue detective read — an open, past-due SCAR surfaces on the worklist ──
  const raise2 = await inj('POST', '/api/quality/scar', qa, { vendor_id: vid, defect_summary: 'Late containment', severity: 'critical', due_date: '2026-06-01' });
  const worklist = await inj('GET', '/api/quality/scar/open?days=0&as_of=2026-07-11', qa);
  const nos = (worklist.json.scars ?? []).map((x: any) => x.scar_no);
  ok('Overdue worklist includes the open past-due SCAR', worklist.status === 200 && nos.includes(raise2.json.scar_no) && worklist.json.overdue >= 1, JSON.stringify({ nos, overdue: worklist.json.overdue }));
  ok('Overdue worklist excludes the closed SCAR', !nos.includes(raise.json.scar_no), JSON.stringify(nos));

  // ── 10. Reject path (distinct reviewer declines an incomplete/unsatisfactory response) ──
  const raise3 = await inj('POST', '/api/quality/scar', qa, { vendor_id: vid, defect_summary: 'Insufficient RCA', due_date: '2026-07-10' });
  await inj('POST', `/api/quality/scar/${raise3.json.id}/respond`, qa, { root_cause: 'tbd', corrective_action: 'tbd' });
  const rejNoReason = await inj('POST', `/api/quality/scar/${raise3.json.id}/reject`, qmgr, {});
  ok('Reject with no reason → 400 REASON_REQUIRED', rejNoReason.status === 400 && rejNoReason.json.error?.code === 'REASON_REQUIRED', JSON.stringify(rejNoReason.json));
  const reject = await inj('POST', `/api/quality/scar/${raise3.json.id}/reject`, qmgr, { reason: 'RCA not credible — resubmit' });
  ok('Distinct reviewer rejects → rejected', reject.status === 200 && reject.json.status === 'rejected' && reject.json.reject_reason?.includes('RCA'), JSON.stringify(reject.json));

  // ── 11. RLS isolation — T1 cannot see or act on HQ SCARs ──
  const t1List = await inj('GET', '/api/quality/scar', t1admin);
  ok('RLS: T1 sees none of HQ SCARs', t1List.status === 200 && t1List.json.count === 0, JSON.stringify({ count: t1List.json.count }));
  const t1Close = await inj('POST', `/api/quality/scar/${raise2.json.id}/close`, t1admin, { effectiveness: 'effective' });
  ok('RLS: T1 cannot close an HQ SCAR → 404 SCAR_NOT_FOUND', t1Close.status === 404 && t1Close.json.error?.code === 'SCAR_NOT_FOUND', JSON.stringify(t1Close.json));

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
