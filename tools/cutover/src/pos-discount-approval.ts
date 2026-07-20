/**
 * docs/52 Phase 4b — per-line manual-discount / bill-discount approval routing. A manual discount above the
 * tenant's configured cap (`pos_discount_settings`, both NULL = no cap by default → byte-identical) is refused
 * at the till (`DISCOUNT_APPROVAL_REQUIRED`) unless the sale references a SUPERVISOR's authorization (an OVR-…
 * from POST /api/pos/discount-authorize, gated to the refund/override duty — SoD R08, segregated from selling).
 * The authorization is single-use, bounds the % it covers, and its approver must differ from the selling cashier.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover pos-discount-approval
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'is-secret';
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
  await db.insert(s.tenants).values([{ code: 'SHOP', name: 'ร้านค้า', industry: 'retail' }, { code: 'SHOP2', name: 'ร้านอื่น', industry: 'retail' }]).onConflictDoNothing();
  const t = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'SHOP')))[0].id);
  const t2 = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'SHOP2')))[0].id);
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('pw1'), role: 'Admin', tenantId: t },              // settings + SoD-self case
    { username: 'sup', passwordHash: await pw.hash('pw1'), role: 'PosSupervisor', tenantId: t },         // legit approver (pos_refund)
    { username: 'cashier', passwordHash: await pw.hash('pw1'), role: 'Cashier', tenantId: t },           // seller (pos_sell, no pos_refund)
    { username: 'sup2', passwordHash: await pw.hash('pw1'), role: 'PosSupervisor', tenantId: t2 },       // SHOP2 approver
  ]).onConflictDoNothing();
  await db.insert(s.loyaltyConfig).values({ id: 1, enabled: false, pointsPerBaht: '0' }).onConflictDoNothing();
  await db.insert(s.items).values([{ itemId: 'WIDGET', itemDescription: 'วิดเจ็ต', supplyType: 'goods', uom: 'ชิ้น', unitPrice: '100' }]).onConflictDoNothing();
  await db.insert(s.customerInventory).values([{ tenantId: t, itemId: 'WIDGET', itemDescription: 'วิดเจ็ต', uom: 'ชิ้น', currentStock: '10000' }]).onConflictDoNothing();

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
  const login = async (u: string) => (await inj('POST', '/api/login', undefined, { username: u, password: 'pw1' })).json.token as string;
  const admin = await login('admin'); const sup = await login('sup'); const cashier = await login('cashier'); const sup2 = await login('sup2');
  // ring one WIDGET (list 100) as the cashier, with an optional line discount %, bill discount (THB), approval
  const sale = (opts: { line_pct?: number; bill?: number; approval?: string } = {}) => inj('POST', '/api/pos/sales', cashier, {
    items: [{ item_id: 'WIDGET', qty: 1, unit_price: 100, ...(opts.line_pct ? { discount_pct: opts.line_pct } : {}) }],
    ...(opts.bill ? { discount: opts.bill } : {}), ...(opts.approval ? { discount_approval_no: opts.approval } : {}),
  });
  const authorize = (tok: string, max_pct: number) => inj('POST', '/api/pos/discount-authorize', tok, { max_pct, reason: 'bulk buyer' });

  // ── 1. caps off (default) → a 50% line discount sells freely (byte-identical) ──
  const s1 = await sale({ line_pct: 50 });
  ok('caps NULL (default) → 50% line discount sells with no approval (byte-identical), subtotal 50',
    /^SALE-/.test(s1.json.sale_no ?? '') && near(s1.json.subtotal, 50), JSON.stringify({ sale: s1.json.sale_no, subtotal: s1.json.subtotal }));

  // ── 2. supervisor sets the caps (line 20% / bill 20%) ──
  const set = await inj('PUT', '/api/pos/discount-settings', admin, { max_line_discount_pct: 20, max_bill_discount_pct: 20 });
  ok('supervisor sets discount caps (line 20% / bill 20%)', set.status === 200 && near(set.json.max_line_discount_pct, 20), JSON.stringify(set.json));

  // ── 3. over-cap line discount with NO approval → refused ──
  const s3 = await sale({ line_pct: 50 });
  ok('50% line discount over the 20% cap, no approval → 400 DISCOUNT_APPROVAL_REQUIRED',
    s3.status === 400 && s3.json.error?.code === 'DISCOUNT_APPROVAL_REQUIRED', `${s3.status} ${s3.json.error?.code}`);

  // ── 4. a non-supervisor (cashier) cannot authorize a discount ──
  const c4 = await authorize(cashier, 60);
  ok('cashier (no pos_refund) POST /discount-authorize → 403 (SoD R08)', c4.status === 403, `${c4.status}`);

  // ── 5. a supervisor authorizes up to 60% ──
  const a5 = await authorize(sup, 60);
  ok('supervisor authorizes up to 60% → OVR- number, approved_by=sup', /^OVR-/.test(a5.json.override_no ?? '') && a5.json.approved_by === 'sup', JSON.stringify(a5.json));

  // ── 6. the over-cap sale WITH the authorization → sells ──
  const s6 = await sale({ line_pct: 50, approval: a5.json.override_no });
  ok('50% line discount WITH the supervisor authorization → sells, subtotal 50', /^SALE-/.test(s6.json.sale_no ?? '') && near(s6.json.subtotal, 50), JSON.stringify({ sale: s6.json.sale_no, subtotal: s6.json.subtotal }));

  // ── 7. the authorization is single-use ──
  const s7 = await sale({ line_pct: 50, approval: a5.json.override_no });
  ok('reusing the same authorization → 400 DISCOUNT_APPROVAL_CONSUMED', s7.status === 400 && s7.json.error?.code === 'DISCOUNT_APPROVAL_CONSUMED', `${s7.status} ${s7.json.error?.code}`);

  // ── 8. an authorization that does not cover the requested discount → refused ──
  const a8 = await authorize(sup, 30);
  const s8 = await sale({ line_pct: 50, approval: a8.json.override_no });
  ok('50% discount vs a 30% authorization → 400 DISCOUNT_APPROVAL_INSUFFICIENT', s8.status === 400 && s8.json.error?.code === 'DISCOUNT_APPROVAL_INSUFFICIENT', `${s8.status} ${s8.json.error?.code}`);

  // ── 9. SoD: the approver may not be the selling cashier ──
  const a9 = await authorize(admin, 60);         // admin authorizes (approved_by=admin)
  const s9 = await inj('POST', '/api/pos/sales', admin, { items: [{ item_id: 'WIDGET', qty: 1, unit_price: 100, discount_pct: 50 }], discount_approval_no: a9.json.override_no }); // admin also rings
  ok('the approver ringing their own authorized sale → 403 SOD_VIOLATION', s9.status === 403 && s9.json.error?.code === 'SOD_VIOLATION', `${s9.status} ${s9.json.error?.code}`);

  // ── 10. a discount AT the cap (not over) needs no approval ──
  const s10 = await sale({ line_pct: 20 });
  ok('20% line discount (at the cap, not over) → sells with no approval, subtotal 80', /^SALE-/.test(s10.json.sale_no ?? '') && near(s10.json.subtotal, 80), JSON.stringify({ subtotal: s10.json.subtotal }));

  // ── 11. a BILL discount over the cap is gated too ──
  const s11req = await sale({ bill: 30 });       // 30 THB on a 100 subtotal = 30% > 20%
  const a11 = await authorize(sup, 40);
  const s11 = await sale({ bill: 30, approval: a11.json.override_no });
  ok('30% bill discount over the cap → REQUIRED, then sells with a supervisor authorization',
    s11req.status === 400 && s11req.json.error?.code === 'DISCOUNT_APPROVAL_REQUIRED' && /^SALE-/.test(s11.json.sale_no ?? ''), JSON.stringify({ req: s11req.json.error?.code, sale: s11.json.sale_no }));

  // ── 12. an authorization with a BAHT cap: a discount exceeding the ฿ amount is refused (fail-closed) ──
  // authorize up to 60% AND up to ฿40; the check runs BEFORE consumption, so the code survives a rejected over.
  const a12a = await inj('POST', '/api/pos/discount-authorize', sup, { max_pct: 60, max_amount: 40, reason: 'capped giveaway' });
  ok('authorize up to 60% AND ฿40 → OVR- number carries max_amount 40', /^OVR-/.test(a12a.json.override_no ?? '') && near(a12a.json.max_amount, 40), JSON.stringify(a12a.json));
  const s12a = await sale({ line_pct: 50, approval: a12a.json.override_no }); // 50% of ฿100 = ฿50 discount > ฿40
  ok('฿50 discount vs a ฿40 authorization → 400 DISCOUNT_APPROVAL_AMOUNT_EXCEEDED', s12a.status === 400 && s12a.json.error?.code === 'DISCOUNT_APPROVAL_AMOUNT_EXCEEDED', `${s12a.status} ${s12a.json.error?.code}`);
  // ── 13. the SAME code (not consumed by the rejected over) now covers a within-฿ discount → sells ──
  const s12b = await sale({ line_pct: 30, approval: a12a.json.override_no }); // 30% > 20% cap, ≤60%, ฿30 ≤ ฿40
  ok('฿30 discount (≤ ฿40, over the % cap) reuses the un-consumed code → sells, subtotal 70', /^SALE-/.test(s12b.json.sale_no ?? '') && near(s12b.json.subtotal, 70), JSON.stringify({ sale: s12b.json.sale_no, subtotal: s12b.json.subtotal }));

  // ── 14. cross-tenant: a SHOP2 authorization is invisible to SHOP ──
  const a12 = await authorize(sup2, 60);
  const s12 = await sale({ line_pct: 50, approval: a12.json.override_no });
  ok("a SHOP2 authorization used on a SHOP sale → 400 DISCOUNT_APPROVAL_NOT_FOUND (tenant isolation)", s12.status === 400 && s12.json.error?.code === 'DISCOUNT_APPROVAL_NOT_FOUND', `${s12.status} ${s12.json.error?.code}`);

  await app.close();
  await pg.close();
  console.log('\n── docs/52 Phase 4b — manual-discount approval routing (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} pos-discount-approval checks failed` : `\n✅ All ${checks.length} pos-discount-approval checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
