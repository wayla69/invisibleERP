/**
 * W2 (docs/27) — Coalition network over PGlite (control LYL-19): earn anywhere / burn anywhere on the
 * member's HOME ledger, every cross-shop movement settled through a balanced intercompany clearing entry
 * (category 'loyalty-clearing', 1150/2150 ↔ 5700), PDPA-minimal cross-shop resolution, HQ-only config.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover coalition
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'coal-secret';
process.env.NODE_ENV = 'test';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import * as s from '../../../apps/api/dist/database/schema/index';
import { blindIndex } from '../../../apps/api/dist/database/encrypted-column';
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
  await db.insert(s.tenants).values([
    { code: 'HQ', name: 'HQ' },
    { code: 'A1', name: 'ร้านบ้าน A', vatRegistered: true },
    { code: 'B2', name: 'ร้านพันธมิตร B', vatRegistered: true },
    { code: 'C3', name: 'ร้านนอกเครือ C', vatRegistered: true },
  ]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, tA, tB, tC] = [await tid('HQ'), await tid('A1'), await tid('B2'), await tid('C3')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    // 'Customer' role carries the 'loyalty' duty (same principal shape the loyalty harness uses)
    { username: 'staffA', passwordHash: await pw.hash('pw'), role: 'Customer', tenantId: tA },
    { username: 'staffB', passwordHash: await pw.hash('pw'), role: 'Customer', tenantId: tB },
    { username: 'staffC', passwordHash: await pw.hash('pw'), role: 'Customer', tenantId: tC },
    // legacy-'Sales' carries exec but NOT the Admin role — probes the COALITION_HQ_ONLY guard behind the perm gate
    { username: 'execB', passwordHash: await pw.hash('pw'), role: 'Sales', tenantId: tB },
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
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const admin = await login('admin', 'admin123');
  const staffA = await login('staffA', 'pw');
  const staffB = await login('staffB', 'pw');
  const staffC = await login('staffC', 'pw');
  const execB = await login('execB', 'pw');

  await inj('PUT', '/api/loyalty/config', admin, { enabled: true, points_per_baht: 1, baht_per_point: 0.1, min_redeem: 0 });

  // Seed the home-shop member (A) + a decoy member in the non-coalition shop (C) with a different phone.
  const [mA] = await db.insert(s.posMembers).values({ tenantId: tA, memberCode: 'M-COALA1', name: 'สมาชิกบ้าน A', phone: '0812223344', phoneBidx: blindIndex('0812223344'), balance: '0', lifetime: '0', active: true, createdBy: 'seed' }).returning();
  await db.insert(s.posMembers).values({ tenantId: tC, memberCode: 'M-OUTC1', name: 'นอกเครือ', phone: '0819998877', phoneBidx: blindIndex('0819998877'), balance: '0', lifetime: '0', active: true, createdBy: 'seed' });
  const mid = Number(mA.id);

  // ── 1. HQ-only configuration ──
  const denied = await inj('POST', '/api/coalition', execB, { code: 'X', name: 'X' });
  ok('HQ-only: exec (non-Admin) creating a coalition → 403 COALITION_HQ_ONLY', denied.status === 403 && denied.json.error?.code === 'COALITION_HQ_ONLY', `${denied.status} ${denied.json.error?.code}`);
  const co = await inj('POST', '/api/coalition', admin, { code: 'THAICO', name: 'เครือข่ายไทย' });
  const coId = Number(co.json.id);
  const add1 = await inj('POST', `/api/coalition/${coId}/members`, admin, { tenant_id: tA });
  const add2 = await inj('POST', `/api/coalition/${coId}/members`, admin, { tenant_id: tB });
  ok('HQ creates coalition + adds shops A and B', (co.status === 200 || co.status === 201) && add1.json.active === true && add2.json.active === true, `co=${co.status} id=${coId}`);

  // ── 2. Cross-shop resolve (PDPA-minimal) ──
  const rv = await inj('GET', '/api/coalition/resolve?phone=0812223344', staffB);
  ok('Partner shop B resolves the A-member by phone (badge data: code/name/tier/points, home shop)',
    rv.status === 200 && Number(rv.json.member_id) === mid && rv.json.is_home === false && rv.json.home_tenant_code === 'A1' && rv.json.coalition === 'THAICO' && near(rv.json.balance, 0),
    JSON.stringify(rv.json).slice(0, 120));
  ok('PDPA-minimal: the resolve payload carries NO phone/email/birthday/consents',
    rv.json.phone === undefined && rv.json.email === undefined && rv.json.birthday === undefined && rv.json.consents === undefined && rv.json.marketing_opt_in === undefined,
    Object.keys(rv.json).join(','));
  const rvC = await inj('GET', '/api/coalition/resolve?phone=0812223344', staffC);
  ok('Non-coalition shop C cannot resolve → 404 NOT_IN_COALITION', rvC.status === 404 && rvC.json.error?.code === 'NOT_IN_COALITION', `${rvC.status} ${rvC.json.error?.code}`);
  const rvOut = await inj('GET', '/api/coalition/resolve?phone=0819998877', staffB);
  ok('A non-coalition shop\'s member is invisible to the network → 404 MEMBER_NOT_FOUND', rvOut.status === 404 && rvOut.json.error?.code === 'MEMBER_NOT_FOUND', `${rvOut.status} ${rvOut.json.error?.code}`);

  // ── 3. Earn at partner shop B → HOME (A) ledger + IC clearing at fair value ──
  const earn = await inj('POST', '/api/coalition/earn', staffB, { member_id: mid, net_spend: 200, ref_doc: 'B-SALE-001' });
  ok('Earn at B: 200 pts land on the HOME ledger, IC clearing created', (earn.status === 200 || earn.status === 201) && earn.json.points_earned === 200 && near(earn.json.balance, 200) && !!earn.json.ic_no && earn.json.home_tenant_id === tA && earn.json.partner_tenant_id === tB, JSON.stringify(earn.json).slice(0, 140));
  const ledHome = (await pg.query(`SELECT tenant_id, txn_type, points FROM pos_member_ledger WHERE member_id=${mid} AND ref_doc='B-SALE-001'`)).rows as any[];
  ok('Home-ledger row: Earn +200 recorded under tenant A (never B)', ledHome.length === 1 && Number(ledHome[0].tenant_id) === tA && near(ledHome[0].points, 200), JSON.stringify(ledHome));
  const ic1 = await inj('GET', `/api/intercompany/${earn.json.ic_no}`, admin);
  ok('IC clearing: A(due-from) ← B(due-to), fair value ฿20 (200 pts × 0.1), category loyalty-clearing',
    ic1.json.from_tenant_id === tA && ic1.json.to_tenant_id === tB && near(ic1.json.amount, 20) && ic1.json.category === 'loyalty-clearing' && !!ic1.json.from_journal_no && !!ic1.json.to_journal_no,
    JSON.stringify(ic1.json).slice(0, 140));
  const glA = (await pg.query(`SELECT jl.account_code, jl.debit, jl.credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source_ref='${earn.json.ic_no}' AND je.tenant_id=${tA}`)).rows as any[];
  const glB = (await pg.query(`SELECT jl.account_code, jl.debit, jl.credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source_ref='${earn.json.ic_no}:TO' AND je.tenant_id=${tB}`)).rows as any[];
  const leg = (gl: any[], code: string, side: string) => gl.filter((l) => l.account_code === code).reduce((a, l) => a + Number(l[side] || 0), 0);
  ok('GL legs: A Dr1150/Cr5700 ฿20 · B Dr5700/Cr2150 ฿20 (both balanced)',
    near(leg(glA, '1150', 'debit'), 20) && near(leg(glA, '5700', 'credit'), 20) && near(leg(glB, '5700', 'debit'), 20) && near(leg(glB, '2150', 'credit'), 20),
    `A=${JSON.stringify(glA)} B=${JSON.stringify(glB)}`);

  // ── 4. Each shop's 2250 stays true to ITS OWN roster ──
  const liaA = await inj('GET', '/api/loyalty/liability', staffA);
  const liaB = await inj('GET', '/api/loyalty/liability', staffB);
  ok('Liability tie-out: A outstanding 200 pts (฿20); B outstanding 0 — per-shop truth preserved',
    near(liaA.json.outstanding_points, 200) && near(liaA.json.liability_value, 20) && near(liaB.json.outstanding_points, 0),
    `A=${liaA.json.outstanding_points}/${liaA.json.liability_value} B=${liaB.json.outstanding_points}`);
  const postA = await inj('POST', '/api/loyalty/maintenance/run', admin, { tenant_id: tA });
  const accrA = (postA.json.results ?? []).find((r: any) => Number(r.tenant_id) === tA)?.accrual;
  ok('A accrues its liability to 2250 (฿20) — the coalition-earned ledger drives A\'s own GL', accrA?.posted === true && near(accrA?.liability_delta, 20), JSON.stringify(accrA));

  // ── 5. Burn at partner shop B → HOME ledger redeem + reverse IC ──
  const burn = await inj('POST', '/api/coalition/redeem', staffB, { member_id: mid, points: 100, ref_doc: 'B-RDM-001' });
  ok('Burn at B: 100 pts consumed on the HOME ledger (balance 100), reverse IC created', (burn.status === 200 || burn.status === 201) && burn.json.points_redeemed === 100 && near(burn.json.balance, 100) && near(burn.json.redeem_value, 10) && !!burn.json.ic_no, JSON.stringify(burn.json).slice(0, 130));
  const ic2 = await inj('GET', `/api/intercompany/${burn.json.ic_no}`, admin);
  ok('Reverse IC: B(due-from) ← A(due-to) at redeem value ฿10', ic2.json.from_tenant_id === tB && ic2.json.to_tenant_id === tA && near(ic2.json.amount, 10) && ic2.json.category === 'loyalty-clearing', JSON.stringify(ic2.json).slice(0, 120));
  const over = await inj('POST', '/api/coalition/redeem', staffB, { member_id: mid, points: 99999 });
  ok('Over-burn at B → 409 INSUFFICIENT_POINTS (home-ledger lock enforces the balance)', over.status === 409 && over.json.error?.code === 'INSUFFICIENT_POINTS', `${over.status} ${over.json.error?.code}`);

  // ── 6. Guards: outsiders and home-shop earns ──
  const earnC = await inj('POST', '/api/coalition/earn', staffC, { member_id: mid, net_spend: 100 });
  ok('Shop C (not in the coalition) cannot earn for the member → 404 NOT_IN_COALITION', earnC.status === 404 && earnC.json.error?.code === 'NOT_IN_COALITION', `${earnC.status} ${earnC.json.error?.code}`);
  const earnHome = await inj('POST', '/api/coalition/earn', staffA, { member_id: mid, net_spend: 50, ref_doc: 'A-SALE-002' });
  ok('Earn at the HOME shop via the coalition route: points post, NO IC entry (nothing owed)', earnHome.json.points_earned === 50 && earnHome.json.ic_no === null, JSON.stringify(earnHome.json).slice(0, 110));

  // ── 7. Settlement nets the clearing balances (HQ) ──
  const st = await inj('POST', `/api/intercompany/${earn.json.ic_no}/settle`, admin, { amount: 20 });
  ok('HQ settles the ฿20 earn clearing → Settled', (st.status === 200 || st.status === 201) && st.json.status === 'Settled', JSON.stringify(st.json).slice(0, 90));
  const rec = await inj('GET', '/api/intercompany/reconciliation', admin);
  ok('IC reconciliation eliminates: total due-from == total due-to across the group', rec.json.eliminates === true, JSON.stringify({ df: rec.json.total_due_from, dt: rec.json.total_due_to, diff: rec.json.difference }));

  // ── 8. RLS sanity + trial balance ──
  const xleak = await inj('GET', '/api/loyalty/members/lookup?phone=0812223344', staffB);
  ok('Ordinary (non-coalition) lookup at B still cannot see the A member — RLS unchanged', xleak.status === 404, `${xleak.status}`);
  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
  ok('Trial balance balanced at end', near(Number(tb.totals?.debit ?? tb.total_debit), Number(tb.totals?.credit ?? tb.total_credit)), JSON.stringify(tb.totals ?? {}).slice(0, 80));

  // ── report ──
  console.log('\n── W2 (docs/27) Coalition network — earn/burn anywhere, settle in the GL (LYL-19) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} coalition checks failed` : `\n✅ All ${checks.length} coalition checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
