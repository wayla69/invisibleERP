/**
 * SVC-1 — CPQ-01 discount-approval & margin-floor control. Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover cpq-approval
 *
 * A quote whose effective discount% breaches max_discount_pct OR whose margin% falls below min_margin_pct
 * (per-tenant floor, cpq_settings) parks in PendingApproval on send and CANNOT be accepted until a DIFFERENT
 * authorised user approves it (author cannot self-approve → SOD_SELF_APPROVAL). Reject sends it back to Draft.
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cpq-approval-secret';
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

  await db.insert(s.permissions).values(PERMISSIONS.map((k: string) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'T1' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1] = [await tid('HQ'), await tid('T1')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },   // approver (cpq_approve via Admin)
    { username: 'sales1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: hq },        // author (cpq)
    { username: 't1user', passwordHash: await pw.hash('pw1'), role: 'Admin', tenantId: t1 },        // other-tenant, for RLS
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ routerOptions: { maxParamLength: 500 } }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();

  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /**/ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const [admin, sales1, t1user] = [await login('admin', 'admin123'), await login('sales1', 'pw1'), await login('t1user', 'pw1')];

  // Floor: default 20% margin / 15% discount. Read it, then tighten the discount ceiling to 5% for the test.
  const set0 = await inj('GET', '/api/cpq/settings', sales1);
  ok('Default floor = 20% margin / 15% discount', near(set0.json.min_margin_pct, 20) && near(set0.json.max_discount_pct, 15), JSON.stringify(set0.json));
  const setPut = await inj('PUT', '/api/cpq/settings', admin, { min_margin_pct: 20, max_discount_pct: 5 });
  ok('Update floor → max_discount 5%', setPut.status === 200 && near(setPut.json.max_discount_pct, 5), JSON.stringify(setPut.json));

  // ── 1. WITHIN floor: price 50000, cost 30000 → margin 40% ≥ 20, discount 0 ≤ 5 → sends normally ──
  const qOk = await inj('POST', '/api/cpq/quotes', sales1, { customer_name: 'In-floor Buyer', lines: [{ description: 'Widget', qty: 1, unit_price: 50000, unit_cost: 30000 }] });
  ok('Create in-floor quote → margin 40%', qOk.status === 201 && near(qOk.json.margin_pct, 40), JSON.stringify({ m: qOk.json.margin_pct, d: qOk.json.discount_pct }));
  const sentOk = await inj('POST', `/api/cpq/quotes/${qOk.json.id}/send`, sales1);
  ok('In-floor quote sends normally → Sent (no approval)', sentOk.status === 200 && sentOk.json.status === 'Sent' && sentOk.json.requires_approval === false, JSON.stringify({ st: sentOk.json.status, ra: sentOk.json.requires_approval }));

  // ── 2. MARGIN breach: price 50000, cost 45000 → margin 10% < 20 → PendingApproval, accept blocked ──
  const qLow = await inj('POST', '/api/cpq/quotes', sales1, { customer_name: 'Thin-margin Buyer', lines: [{ description: 'Widget', qty: 1, unit_price: 50000, unit_cost: 45000 }] });
  ok('Create thin-margin quote → margin 10%', qLow.status === 201 && near(qLow.json.margin_pct, 10), JSON.stringify({ m: qLow.json.margin_pct }));
  const sentLow = await inj('POST', `/api/cpq/quotes/${qLow.json.id}/send`, sales1);
  ok('Margin-floor breach on send → PendingApproval + requires_approval', sentLow.status === 200 && sentLow.json.status === 'PendingApproval' && sentLow.json.requires_approval === true, JSON.stringify({ st: sentLow.json.status, ra: sentLow.json.requires_approval }));
  const acceptBlocked = await inj('POST', `/api/cpq/quotes/${qLow.json.id}/accept`, admin);
  ok('Un-approved quote cannot be accepted → 400 INVALID_TRANSITION', acceptBlocked.status === 400 && acceptBlocked.json.error?.code === 'INVALID_TRANSITION', JSON.stringify({ s: acceptBlocked.status, c: acceptBlocked.json.error?.code }));

  // ── 3. Self-approve blocked (author = sales1) ──
  const selfApprove = await inj('POST', `/api/cpq/quotes/${qLow.json.id}/approve`, sales1);
  ok('Author self-approve → 403 SOD_SELF_APPROVAL', selfApprove.status === 403 && selfApprove.json.error?.code === 'SOD_SELF_APPROVAL', JSON.stringify({ s: selfApprove.status, c: selfApprove.json.error?.code }));

  // ── 4. Distinct approver approves → Sent → acceptable (revenue posts) ──
  const approve = await inj('POST', `/api/cpq/quotes/${qLow.json.id}/approve`, admin);
  ok('Distinct approver approves → Sent + approved_by', approve.status === 200 && approve.json.status === 'Sent' && approve.json.approved_by === 'admin', JSON.stringify({ st: approve.json.status, by: approve.json.approved_by }));
  const accepted = await inj('POST', `/api/cpq/quotes/${qLow.json.id}/accept`, admin);
  ok('Approved quote accepts → Accepted + AR posted 50000', accepted.status === 200 && accepted.json.status === 'Accepted' && near(accepted.json.ar_posted, 50000), JSON.stringify({ st: accepted.json.status, ar: accepted.json.ar_posted }));
  const apprList = await inj('GET', '/api/cpq/approvals?status=approved', admin);
  ok('Approval audit row recorded (approved)', apprList.json.approvals?.length === 1 && apprList.json.approvals[0].approved_by === 'admin', JSON.stringify({ n: apprList.json.approvals?.length }));

  // ── 5. DISCOUNT breach + REJECT → back to Draft ──
  const cfg = await inj('POST', '/api/cpq/configs', admin, { code: 'LAPTOP', name: 'Laptop', base_price: 50000 });
  await inj('POST', `/api/cpq/configs/${cfg.json.id}/rules`, admin, { name: 'Vol 2+', rule_type: 'volume', discount_pct: 10, min_qty: 2 });
  const qDisc = await inj('POST', '/api/cpq/quotes', sales1, { customer_name: 'Over-discount Buyer', config_id: cfg.json.id, qty: 2, unit_cost: 10000 });
  ok('Create 10%-discount quote → discount_pct 10 (> 5 ceiling)', qDisc.status === 201 && near(qDisc.json.discount_pct, 10), JSON.stringify({ d: qDisc.json.discount_pct }));
  const sentDisc = await inj('POST', `/api/cpq/quotes/${qDisc.json.id}/send`, sales1);
  ok('Discount-ceiling breach on send → PendingApproval', sentDisc.status === 200 && sentDisc.json.status === 'PendingApproval', JSON.stringify({ st: sentDisc.json.status }));
  const rejSelf = await inj('POST', `/api/cpq/quotes/${qDisc.json.id}/reject`, sales1);
  ok('Author self-reject of a breach → 403 SOD_SELF_APPROVAL', rejSelf.status === 403 && rejSelf.json.error?.code === 'SOD_SELF_APPROVAL', JSON.stringify({ s: rejSelf.status, c: rejSelf.json.error?.code }));
  const rejected = await inj('POST', `/api/cpq/quotes/${qDisc.json.id}/reject`, admin);
  ok('Distinct approver rejects breach → back to Draft', rejected.status === 200 && rejected.json.status === 'Draft', JSON.stringify({ st: rejected.json.status }));

  // ── 6. RLS: another tenant sees neither the HQ quotes nor the HQ approvals ──
  const t1Quotes = await inj('GET', '/api/cpq/quotes', t1user);
  ok('RLS: T1 sees 0 HQ quotes', t1Quotes.json.quotes?.length === 0, `count=${t1Quotes.json.quotes?.length}`);
  const t1Appr = await inj('GET', '/api/cpq/approvals', t1user);
  ok('RLS: T1 sees 0 HQ approvals', t1Appr.json.approvals?.length === 0, `count=${t1Appr.json.approvals?.length}`);

  // ── CRM-14 (CRM-12) — CPQ guided selling: bundles + tiered discount-approval matrix ──────────────
  // A 'manager1' approver: cpq_approve WITHOUT exec (a plain manager, not an exec) — proves the exec-tier
  // gate is a real permission check, not just the existing cpq_approve-or-exec route gate.
  await db.insert(s.users).values([{ username: 'manager1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: hq }]).onConflictDoNothing();
  const [mgr1Row] = await db.select().from(s.users).where(eq(s.users.username, 'manager1'));
  await db.insert(s.userPermissions).values([{ userId: Number(mgr1Row.id), perm: 'cpq_approve' }]).onConflictDoNothing();
  const manager1 = await login('manager1', 'pw1');

  // 18. Bundle master data: LAPTOP (thin-margin component) + MOUSE (healthy component).
  const mouseCfg = await inj('POST', '/api/cpq/configs', admin, { code: 'MOUSE', name: 'Mouse', base_price: 2000 });
  const bundle = await inj('POST', '/api/cpq/bundles', admin, { code: 'STARTER-KIT', name: 'Starter Kit', items: [{ config_id: cfg.json.id, qty: 1, unit_cost: 45000 }, { config_id: mouseCfg.json.id, qty: 2, unit_cost: 200 }] });
  ok('CRM-14 bundle: create with 2 components', bundle.status === 201 && bundle.json.code === 'STARTER-KIT' && bundle.json.items === 2, JSON.stringify(bundle.json));

  // 19. Add the bundle to a fresh Draft quote → expands into 2 quote_lines (bundle-tagged), blended margin
  //     15.9% < the 20% floor — the EXISTING CPQ-01 send() floor check covers it with NO core-service change.
  const bq = await inj('POST', '/api/cpq/quotes', sales1, { customer_name: 'Bundle Buyer' });
  const addBundle = await inj('POST', `/api/cpq/quotes/${bq.json.id}/lines/bundle`, sales1, { bundle_code: 'STARTER-KIT' });
  ok('CRM-14 bundle: adding to a Draft quote expands 2 lines', addBundle.status === 201 && addBundle.json.lines_added === 2 && near(addBundle.json.total, 54000), JSON.stringify({ st: addBundle.status, n: addBundle.json.lines_added, total: addBundle.json.total }));
  const bqLines = await inj('GET', `/api/cpq/quotes/${bq.json.id}/lines`, sales1);
  ok('CRM-14 bundle: both lines share the same bundle instance tag', bqLines.json.lines?.length === 2 && bqLines.json.lines[0].bundle_code === bqLines.json.lines[1].bundle_code && !!bqLines.json.lines[0].bundle_code, JSON.stringify(bqLines.json.lines?.map((l: any) => l.bundle_code)));
  const bqSend = await inj('POST', `/api/cpq/quotes/${bq.json.id}/send`, sales1);
  ok('CRM-14 bundle: blended margin breach on send → PendingApproval (bundle covered by CPQ-01)', bqSend.status === 200 && bqSend.json.status === 'PendingApproval' && near(bqSend.json.margin_pct, 15.926), JSON.stringify({ st: bqSend.json.status, m: bqSend.json.margin_pct }));
  const bqApprove = await inj('POST', `/api/cpq/quotes/${bq.json.id}/approve`, manager1);
  ok('CRM-14 tier: a margin-only breach stays manager-tier — cpq_approve (no exec) can approve it', bqApprove.status === 200 && bqApprove.json.status === 'Sent', JSON.stringify(bqApprove.json));

  // 20. Set the exec-tier discount ceiling, then breach ABOVE it via a discounted bundle instance (healthy
  //     margin, so ONLY the discount tier is at stake) → requires exec specifically.
  const setExecTier = await inj('PUT', '/api/cpq/settings', admin, { exec_discount_pct: 20 });
  ok('CRM-14 tier: set the exec-tier discount ceiling (20%)', setExecTier.status === 200 && near(setExecTier.json.exec_discount_pct, 20), JSON.stringify(setExecTier.json));
  const healthyBundle = await inj('POST', '/api/cpq/bundles', admin, { code: 'HEALTHY-KIT', name: 'Healthy Kit', items: [{ config_id: cfg.json.id, qty: 1, unit_cost: 10000 }, { config_id: mouseCfg.json.id, qty: 1, unit_cost: 200 }] });
  const tq = await inj('POST', '/api/cpq/quotes', sales1, { customer_name: 'Exec Tier Buyer' });
  const addHealthy = await inj('POST', `/api/cpq/quotes/${tq.json.id}/lines/bundle`, sales1, { bundle_code: 'HEALTHY-KIT', discount_pct: 25 });
  ok('CRM-14 tier: a 25% bundle discount (healthy margin) added to the quote', addHealthy.status === 201, JSON.stringify({ st: addHealthy.status }));
  const tqSend = await inj('POST', `/api/cpq/quotes/${tq.json.id}/send`, sales1);
  ok('CRM-14 tier: a discount above the exec ceiling → PendingApproval', tqSend.status === 200 && tqSend.json.status === 'PendingApproval' && near(tqSend.json.discount_pct, 25), JSON.stringify({ st: tqSend.json.status, d: tqSend.json.discount_pct }));
  const tqMgrBlocked = await inj('POST', `/api/cpq/quotes/${tq.json.id}/approve`, manager1);
  ok('CRM-14 tier: a plain cpq_approve holder (no exec) is BLOCKED on an exec-tier breach', tqMgrBlocked.status === 403 && tqMgrBlocked.json.error?.code === 'TIER_APPROVAL_REQUIRED', JSON.stringify({ s: tqMgrBlocked.status, c: tqMgrBlocked.json.error?.code }));
  const tqExecApprove = await inj('POST', `/api/cpq/quotes/${tq.json.id}/approve`, admin);
  ok('CRM-14 tier: an exec-permission holder clears the exec-tier breach', tqExecApprove.status === 200 && tqExecApprove.json.status === 'Sent', JSON.stringify(tqExecApprove.json));

  // 21. Guided-selling recommendations: LAPTOP + MOUSE were co-purchased (Accepted) by the same customer.
  const acceptBundle = await inj('POST', `/api/cpq/quotes/${bq.json.id}/accept`, admin);
  ok('CRM-14 recommendations setup: bundle quote accepted', acceptBundle.status === 200 && acceptBundle.json.status === 'Accepted', JSON.stringify(acceptBundle.json));
  const recs = await inj('GET', '/api/cpq/recommendations?config_code=LAPTOP', sales1);
  ok('CRM-14 recommendations: MOUSE surfaces as a co-purchase for LAPTOP', recs.status === 200 && (recs.json.recommendations ?? []).some((r: any) => r.config_code === 'MOUSE'), JSON.stringify(recs.json));

  // 22. RLS: T1 cannot see the HQ bundle.
  const t1Bundles = await inj('GET', '/api/cpq/bundles', t1user);
  ok('CRM-14 RLS: a T1 user cannot see an HQ bundle', t1Bundles.status === 200 && !(t1Bundles.json.bundles ?? []).some((b: any) => b.code === 'STARTER-KIT'), `codes=${(t1Bundles.json.bundles ?? []).map((b: any) => b.code).join('|')}`);

  // ── CRM-15 CPQ pricebooks (control CRM-15, migration 0408) — quotes price from a governed, effective-dated
  //    price list; the CPQ-01 floor still governs; the effective window + active flag are enforced ──────────
  // 23. Create a pricebook (masterdata) — active, no effective bounds (always effective) + entries.
  const pb = await inj('POST', '/api/cpq/pricebooks', admin, { code: 'PB-2026', name: 'FY2026 List', currency: 'THB' });
  ok('CRM-15 pricebook: created under the masterdata duty', pb.status === 201 && pb.json.id > 0 && pb.json.code === 'PB-2026', JSON.stringify(pb.json));

  // 24. A cpq author WITHOUT masterdata cannot create a pricebook.
  const pbForbidden = await inj('POST', '/api/cpq/pricebooks', sales1, { code: 'NOPE', name: 'x' });
  ok('CRM-15 pricebook: a non-masterdata author is refused → 403', pbForbidden.status === 403, `${pbForbidden.status}`);

  const ent = await inj('POST', '/api/cpq/pricebooks/PB-2026/entries', admin, { entries: [{ item_code: 'WIDGET', unit_price: 42000 }, { item_code: 'CHEAP', unit_price: 20000 }] });
  ok('CRM-15 pricebook: entries upserted (item_code → unit_price)', ent.status === 201 && (ent.json.entries ?? []).length === 2, JSON.stringify(ent.json.entries));

  // 25. A quote priced FROM the pricebook: a covered line takes the pricebook price (typed price ignored); an
  // uncovered line keeps its typed price; quotes.pricebook_id records the pricing basis.
  const pq = await inj('POST', '/api/cpq/quotes', sales1, { customer_name: 'Pricebook Buyer', pricebook_id: pb.json.id, lines: [
    { description: 'Widget', item_code: 'WIDGET', qty: 1, unit_price: 99999, unit_cost: 30000 },
    { description: 'Custom', item_code: 'UNLISTED', qty: 1, unit_price: 5000, unit_cost: 1000 },
  ] });
  ok('CRM-15 pricing: covered line → pricebook price (42000), uncovered line keeps typed (5000); subtotal 47000, basis recorded',
    pq.status === 201 && near(pq.json.subtotal, 47000) && pq.json.pricebook_id === pb.json.id, JSON.stringify({ subtotal: pq.json.subtotal, pb: pq.json.pricebook_id }));

  // 26. Config path also prices from the pricebook (by config code), overriding the config base price.
  const cfgW = await inj('POST', '/api/cpq/configs', admin, { code: 'WIDGET', name: 'Widget Config', base_price: 88888 });
  const pqCfg = await inj('POST', '/api/cpq/quotes', sales1, { customer_name: 'Config Pricebook', pricebook_id: pb.json.id, config_id: cfgW.json.id, qty: 1, unit_cost: 30000 });
  ok('CRM-15 pricing: a config-path quote prices from the pricebook (WIDGET 42000, not base_price 88888)', pqCfg.status === 201 && near(pqCfg.json.subtotal, 42000), JSON.stringify({ subtotal: pqCfg.json.subtotal }));

  // 27. The CPQ-01 margin floor STILL governs a pricebook price (a below-cost entry trips it on send).
  const pbLowQ = await inj('POST', '/api/cpq/quotes', sales1, { customer_name: 'Below-cost Buyer', pricebook_id: pb.json.id, lines: [{ description: 'Cheap', item_code: 'CHEAP', qty: 1, unit_price: 99999, unit_cost: 30000 }] });
  const pbSentLow = await inj('POST', `/api/cpq/quotes/${pbLowQ.json.id}/send`, sales1);
  ok('CRM-15 floor composes: a below-cost pricebook price (20000 vs cost 30000) still trips CPQ-01 → PendingApproval',
    near(pbLowQ.json.subtotal, 20000) && pbSentLow.status === 200 && pbSentLow.json.status === 'PendingApproval', JSON.stringify({ sub: pbLowQ.json.subtotal, st: pbSentLow.json.status }));

  // 28. Effective window enforced: an EXPIRED pricebook is rejected at quote time.
  const pbExp = await inj('POST', '/api/cpq/pricebooks', admin, { code: 'PB-OLD', name: 'Old', effective_from: '2020-01-01', effective_to: '2020-12-31' });
  await inj('POST', '/api/cpq/pricebooks/PB-OLD/entries', admin, { entries: [{ item_code: 'WIDGET', unit_price: 1 }] });
  const qExp = await inj('POST', '/api/cpq/quotes', sales1, { customer_name: 'Expired', pricebook_id: pbExp.json.id, lines: [{ description: 'Widget', item_code: 'WIDGET', qty: 1, unit_price: 5000, unit_cost: 1000 }] });
  ok('CRM-15 effective window: an expired pricebook → 400 PRICEBOOK_NOT_EFFECTIVE', qExp.status === 400 && qExp.json.error?.code === 'PRICEBOOK_NOT_EFFECTIVE', `${qExp.status} ${qExp.json.error?.code}`);

  // 29. An INACTIVE pricebook is rejected.
  const pbOff = await inj('POST', '/api/cpq/pricebooks', admin, { code: 'PB-OFF', name: 'Off', is_active: false });
  const qOff = await inj('POST', '/api/cpq/quotes', sales1, { customer_name: 'Off', pricebook_id: pbOff.json.id, lines: [{ description: 'x', item_code: 'WIDGET', qty: 1, unit_price: 5000, unit_cost: 1000 }] });
  ok('CRM-15: an inactive pricebook → 400 PRICEBOOK_INACTIVE', qOff.status === 400 && qOff.json.error?.code === 'PRICEBOOK_INACTIVE', `${qOff.status} ${qOff.json.error?.code}`);

  // 30. An unknown pricebook id → 404; a from>to window on create → 400.
  const qBad = await inj('POST', '/api/cpq/quotes', sales1, { customer_name: 'Bad', pricebook_id: 999999, lines: [{ description: 'x', qty: 1, unit_price: 1000, unit_cost: 100 }] });
  const pbBad = await inj('POST', '/api/cpq/pricebooks', admin, { code: 'PB-BAD', name: 'Bad', effective_from: '2026-12-31', effective_to: '2026-01-01' });
  ok('CRM-15 validation: unknown pricebook → 404 PRICEBOOK_NOT_FOUND; from>to → 400 BAD_EFFECTIVE_WINDOW',
    qBad.status === 404 && qBad.json.error?.code === 'PRICEBOOK_NOT_FOUND' && pbBad.status === 400 && pbBad.json.error?.code === 'BAD_EFFECTIVE_WINDOW', `${qBad.json.error?.code}/${pbBad.json.error?.code}`);

  // 31. RLS: a T1 user sees no HQ pricebook and cannot price a quote from it.
  const t1pbs = await inj('GET', '/api/cpq/pricebooks', t1user);
  const t1Priced = await inj('POST', '/api/cpq/quotes', t1user, { customer_name: 'T1', pricebook_id: pb.json.id, lines: [{ description: 'x', item_code: 'WIDGET', qty: 1, unit_price: 5000, unit_cost: 1000 }] });
  ok('CRM-15 RLS: a T1 user sees no HQ pricebook and cannot price from it (404)',
    t1pbs.status === 200 && !(t1pbs.json.pricebooks ?? []).some((p: any) => p.code === 'PB-2026') && t1Priced.status === 404, `t1see=${(t1pbs.json.pricebooks ?? []).map((p: any) => p.code).join('|')} priced=${t1Priced.status}`);

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
