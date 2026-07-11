/**
 * QMS-1 (QC-01) — Non-Conformance (NCR) register with maker-checker disposition. Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover quality-ncr
 *
 * Proves: defect-code create; raise an NCR from a failed inspection; propose scrap → pending_disposition;
 * self-disposition blocked (SOD_SELF_APPROVAL); a DISTINCT approver dispositions scrap → GL write-off posted
 * (Dr 5810 / Cr the source inventory account, entry_no recorded, TB balanced); reject → open; RLS isolation.
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ncr-secret';
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
import { LedgerService } from '../../../apps/api/dist/modules/ledger/ledger.service';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });
const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.01;

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T2', name: 'Tenant 2' }]).onConflictDoNothing();
  const hq = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0].id);
  const t2 = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'T2')))[0].id);
  // Seed users directly (no forced password-change, unlike /api/admin/users). A raiser holds only `quality`,
  // a checker only `quality_approve` (per-user override via user_permissions) — both SoD-clean.
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'admin2', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t2 },
    { username: 'qraiser', passwordHash: await pw.hash('pw1234'), role: 'Warehouse', tenantId: hq },
    { username: 'qcheck', passwordHash: await pw.hash('pw1234'), role: 'Warehouse', tenantId: hq },
    { username: 'q2', passwordHash: await pw.hash('pw1234'), role: 'Warehouse', tenantId: t2 },
  ]).onConflictDoNothing();
  const uid = async (u: string) => Number((await db.select().from(s.users).where(eq(s.users.username, u)))[0].id);
  await db.insert(s.userPermissions).values([
    { userId: await uid('qraiser'), perm: 'quality' },
    { userId: await uid('qcheck'), perm: 'quality_approve' },
    { userId: await uid('q2'), perm: 'quality' },
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token;
  const admin = await login('admin', 'admin123');

  const raiser = await login('qraiser', 'pw1234');
  const checker = await login('qcheck', 'pw1234');
  ok('Fixture users: quality raiser + quality_approve checker log in', !!raiser && !!checker, JSON.stringify({ r: !!raiser, c: !!checker }));

  // ── 1. Defect-code lookup: create + list ──
  const dc = await inj('POST', '/api/quality/defect-codes', raiser, { code: 'DIM-01', name: 'ขนาดเกินพิกัด', category: 'dimensional' });
  ok('Defect code created + listed', dc.status < 300 && (dc.json.defect_codes ?? []).some((d: any) => d.code === 'DIM-01'), JSON.stringify({ s: dc.status, n: dc.json.count }));

  // ── 2. Raise a plain NCR (no financial disposition) → stays open ──
  const nOpen = await inj('POST', '/api/quality/ncr', raiser, { source: 'in_process', item_id: 'CAKE', defect_code: 'DIM-01', severity: 'minor', qty: 1, description: 'ผิวไม่เรียบ' });
  ok('Raise NCR without disposition → status open', nOpen.status < 300 && nOpen.json.status === 'open' && /^NCR-/.test(nOpen.json.ncr_no ?? ''), JSON.stringify({ s: nOpen.status, st: nOpen.json.status, no: nOpen.json.ncr_no }));

  // ── 3. Promote a FAILED quality inspection into an NCR ──
  await inj('POST', '/api/quality/inspect', admin, { ref_type: 'GR', ref_doc: 'GR-QC', item_id: 'STEEL', qty_inspected: 10, qty_passed: 6, qty_failed: 4, disposition: 'Quarantine', unit_cost: 10 });
  const inspId = Number((await db.select().from(s.qualityInspections))[0].id); // the single inspection just created
  const promo = await inj('POST', `/api/quality/inspections/${inspId}/promote`, raiser, { severity: 'major', proposed_disposition: 'scrap', qty: 4, unit_cost: 10 });
  ok('Promote failed inspection → NCR (pending_disposition, ref to GR)',
    promo.status < 300 && promo.json.status === 'pending_disposition' && promo.json.ref_type === 'GR' && near(promo.json.qty, 4),
    JSON.stringify({ s: promo.status, st: promo.json.status, ref: promo.json.ref_type }));

  // ── 4. Raise NCR proposing scrap → pending_disposition ──
  const nScrap = await inj('POST', '/api/quality/ncr', raiser, { source: 'incoming', ref_type: 'GR', ref_doc: 'GR-9', item_id: 'STEEL', defect_code: 'DIM-01', severity: 'major', qty: 5, unit_cost: 10, proposed_disposition: 'scrap', description: 'รับเข้าไม่ผ่าน' });
  const scrapId = nScrap.json.id;
  ok('Raise NCR proposing scrap → pending_disposition', nScrap.json.status === 'pending_disposition', JSON.stringify({ st: nScrap.json.status }));

  // ── 5. Maker-checker (QC-01): a user cannot disposition an NCR they raised (SOD_SELF_APPROVAL). Admin holds
  //    both quality + quality_approve (all perms) so it passes the permission guard and hits the SoD check. ──
  const nSelf = await inj('POST', '/api/quality/ncr', admin, { source: 'in_process', ref_type: 'WO', item_id: 'CAKE', severity: 'major', qty: 2, unit_cost: 21, proposed_disposition: 'scrap' });
  const selfDisp = await inj('POST', `/api/quality/ncr/${nSelf.json.id}/disposition`, admin, { disposition: 'scrap' });
  ok('Self-disposition blocked → 403 SOD_SELF_APPROVAL', selfDisp.status === 403 && selfDisp.json.error?.code === 'SOD_SELF_APPROVAL', JSON.stringify({ s: selfDisp.status, c: selfDisp.json.error?.code }));

  // ── 6. A DISTINCT approver dispositions scrap → GL write-off posted ──
  const disp = await inj('POST', `/api/quality/ncr/${scrapId}/disposition`, checker, { disposition: 'scrap', notes: 'อนุมัติทิ้ง' });
  ok('Distinct approver dispositions scrap → dispositioned, write-off 50, entry_no JE-*',
    disp.status === 200 && disp.json.status === 'dispositioned' && near(disp.json.write_off_value, 50) && /^JE-/.test(disp.json.entry_no ?? '') && disp.json.dispositioned_by === 'qcheck',
    JSON.stringify({ s: disp.status, st: disp.json.status, wo: disp.json.write_off_value, e: disp.json.entry_no }));

  // ── 7. GL: Dr 5810 50, Cr 1200 raw materials 50, TB balanced ──
  const tb = await inj('GET', '/api/ledger/trial-balance', admin);
  const row = (c: string) => (tb.json.rows ?? []).find((r: any) => r.account_code === c);
  ok('Scrap GL: 5810 dr 50, 1200 raw materials cr 50, TB balanced',
    tb.json.totals?.balanced === true && near(row('5810')?.debit, 50) && near(row('1200')?.balance, -50),
    JSON.stringify({ bal: tb.json.totals?.balanced, loss: row('5810')?.debit, inv: row('1200')?.balance }));

  // ── 8. Reject flow: raise pending → approver rejects → back to open ──
  const nRej = await inj('POST', '/api/quality/ncr', raiser, { source: 'in_process', ref_type: 'WO', item_id: 'CAKE', severity: 'major', qty: 1, unit_cost: 21, proposed_disposition: 'use_as_is' });
  const rej = await inj('POST', `/api/quality/ncr/${nRej.json.id}/reject`, checker, { notes: 'ต้องตรวจซ้ำ' });
  ok('Reject pending disposition → NCR returns to open (no GL)', rej.status === 200 && rej.json.status === 'open' && rej.json.proposed_disposition === null, JSON.stringify({ s: rej.status, st: rej.json.status }));

  // ── 9. Permission guard: a raiser (quality only, no quality_approve) cannot disposition ──
  const nGuard = await inj('POST', '/api/quality/ncr', admin, { source: 'in_process', ref_type: 'WO', item_id: 'CAKE', severity: 'minor', qty: 1, unit_cost: 5, proposed_disposition: 'return' });
  const guard = await inj('POST', `/api/quality/ncr/${nGuard.json.id}/disposition`, raiser, { disposition: 'return' });
  ok('Raiser without quality_approve is blocked from disposition (403)', guard.status === 403, JSON.stringify({ s: guard.status, c: guard.json.error?.code }));

  // ── 10. RLS tenant isolation: a T2 NCR is invisible to HQ ──
  const q2 = await login('q2', 'pw1234');
  const t2ncr = await inj('POST', '/api/quality/ncr', q2, { source: 'in_process', item_id: 'T2ITEM', severity: 'minor', qty: 1, description: 'T2 defect' });
  const hqList = await inj('GET', '/api/quality/ncr', admin);
  const t2no = t2ncr.json.ncr_no;
  ok('RLS: T2 NCR not visible in HQ register',
    t2ncr.status < 300 && !(hqList.json.ncrs ?? []).some((r: any) => r.ncr_no === t2no && r.description === 'T2 defect' && r.item_id === 'T2ITEM'),
    JSON.stringify({ t2: t2no, hqCount: hqList.json.count }));

  console.log('\n── QMS-1 (QC-01) — Non-Conformance register with maker-checker disposition (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} quality-ncr checks failed` : `\n✅ All ${checks.length} quality-ncr checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
