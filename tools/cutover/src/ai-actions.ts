/**
 * Phase D1 — agentic write-ops (propose → approve → execute) over PGlite.
 * Proves the AI can only PROPOSE a mutating action (it files a PENDING request); a DIFFERENT authorized
 * human must approve it (SoD: approver ≠ proposer + must hold the action's permission), and approval
 * executes through the normal service + GL. Covers: propose, balance validation, self-approval block,
 * missing-permission block, execute→JE/PO, re-approve guard, reject, and tenant isolation (RLS).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover ai-actions
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'aiact-secret';
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง', vatRegistered: true }, { code: 'T2', name: 'ร้านสอง', vatRegistered: true }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'proposer1', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: t1 },        // can propose + (Admin) approve → used for self-approval block
    { username: 'approverGl', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: t1 },        // approvals + gl_post → approves JE
    { username: 'approverProc', passwordHash: await pw.hash('pw'), role: 'Procurement', tenantId: t1 },// approvals + procurement → approves PO
    { username: 'approverFc', passwordHash: await pw.hash('pw'), role: 'FinancialController', tenantId: t1 }, // approvals but NO gl_post → blocked on JE
    { username: 't2sales', passwordHash: await pw.hash('pw'), role: 'Sales', tenantId: t2 },           // approvals + dashboard, other tenant → RLS
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
  const login = async (u: string) => (await inj('POST', '/api/login', undefined, { username: u, password: 'pw' })).json.token as string;
  const proposer1 = await login('proposer1');
  const approverGl = await login('approverGl');
  const approverProc = await login('approverProc');
  const approverFc = await login('approverFc');
  const t2sales = await login('t2sales');

  const JE = { kind: 'journal_entry', rationale: 'reclassify', payload: { memo: 'AI reclassify', lines: [{ account_code: '1000', debit: 100 }, { account_code: '4000', credit: 100 }] } };

  // 1. propose JE → pending
  const p1 = await inj('POST', '/api/ai/actions', proposer1, JE);
  ok('Propose JE → 201 pending, amount 100', (p1.status === 200 || p1.status === 201) && p1.json.status === 'pending' && near(p1.json.amount, 100), `${p1.status} ${JSON.stringify(p1.json).slice(0, 90)}`);
  const id1 = p1.json.id;

  // 2. unbalanced JE rejected at propose
  const pBad = await inj('POST', '/api/ai/actions', proposer1, { kind: 'journal_entry', payload: { lines: [{ account_code: '1000', debit: 100 }, { account_code: '4000', credit: 90 }] } });
  ok('Propose unbalanced JE → 400 UNBALANCED', pBad.status === 400 && pBad.json.error?.code === 'UNBALANCED', `${pBad.status} ${pBad.json.error?.code}`);

  // 3. self-approval blocked (proposer is Admin so passes the controller guard, hits the SoD check)
  const selfA = await inj('POST', `/api/ai/actions/${id1}/approve`, proposer1);
  ok('Self-approval blocked → 400 SOD_SELF_APPROVAL', selfA.status === 400 && selfA.json.error?.code === 'SOD_SELF_APPROVAL', `${selfA.status} ${selfA.json.error?.code}`);

  // 4. approver with 'approvals' but missing the kind permission (gl_post) → 403
  const fcA = await inj('POST', `/api/ai/actions/${id1}/approve`, approverFc);
  ok('Approver without gl_post → 403 FORBIDDEN', fcA.status === 403 && fcA.json.error?.code === 'FORBIDDEN', `${fcA.status} ${fcA.json.error?.code}`);
  const stillPending = (await inj('GET', `/api/ai/actions/${id1}`, approverGl)).json;
  ok('Blocked attempts leave it pending', stillPending.status === 'pending', stillPending.status);

  // 5. authorized different approver → EXECUTES (posts the JE)
  const okA = await inj('POST', `/api/ai/actions/${id1}/approve`, approverGl);
  ok('Authorized approve → executed + JE result_ref', okA.status === 200 || okA.status === 201 ? okA.json.status === 'executed' && /^JE-/.test(okA.json.result_ref ?? '') : false, `${okA.status} ${JSON.stringify(okA.json)}`);
  const gl = (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source_ref='AIACT-${id1}'`)).rows as any[];
  ok('Executed JE posted to GL + balanced (Dr1000=100, Cr4000=100)', near(gl.filter((l) => l.account_code === '1000').reduce((a, l) => a + Number(l.debit || 0), 0), 100) && near(gl.reduce((a, l) => a + Number(l.debit || 0), 0), gl.reduce((a, l) => a + Number(l.credit || 0), 0)), JSON.stringify(gl));

  // 6. re-approve an executed action → 409
  const reA = await inj('POST', `/api/ai/actions/${id1}/approve`, approverGl);
  ok('Re-approve executed → 409 NOT_PENDING', reA.status === 409 && reA.json.error?.code === 'NOT_PENDING', `${reA.status} ${reA.json.error?.code}`);

  // 7. PO proposal → approve by Procurement → PO created
  const p2 = await inj('POST', '/api/ai/actions', proposer1, { kind: 'purchase_order', rationale: 'restock', payload: { items: [{ item_id: 'WIDGET', order_qty: 5, unit_price: 20 }] } });
  ok('Propose PO → pending, amount 100', p2.json.status === 'pending' && near(p2.json.amount, 100), JSON.stringify(p2.json).slice(0, 80));
  const poA = await inj('POST', `/api/ai/actions/${p2.json.id}/approve`, approverProc);
  ok('Approve PO (Procurement) → executed + PO result_ref', poA.json.status === 'executed' && /^PO-/.test(poA.json.result_ref ?? ''), `${poA.status} ${JSON.stringify(poA.json)}`);

  // 8. reject flow
  const p3 = await inj('POST', '/api/ai/actions', proposer1, JE);
  const rej = await inj('POST', `/api/ai/actions/${p3.json.id}/reject`, approverGl, { reason: 'not needed' });
  ok('Reject → status rejected', rej.json.status === 'rejected', JSON.stringify(rej.json));
  const rejRow = (await inj('GET', `/api/ai/actions/${p3.json.id}`, approverGl)).json;
  ok('Rejected action records decided_by + reason', rejRow.status === 'rejected' && rejRow.decided_by === 'approverGl' && rejRow.decision_reason === 'not needed', JSON.stringify(rejRow).slice(0, 100));

  // 9. tenant isolation — a T2 user sees none of T1's actions, and cannot approve one
  const t2list = await inj('GET', '/api/ai/actions', t2sales);
  ok('RLS: T2 sees 0 of T1 actions', t2list.json.count === 0, JSON.stringify(t2list.json).slice(0, 60));
  const p4 = await inj('POST', '/api/ai/actions', proposer1, JE);
  const t2approve = await inj('POST', `/api/ai/actions/${p4.json.id}/approve`, t2sales);
  ok('RLS: T2 cannot approve a T1 action → 404 NOT_FOUND', t2approve.status === 404 && t2approve.json.error?.code === 'NOT_FOUND', `${t2approve.status} ${t2approve.json.error?.code}`);

  await app.close();
  await pg.close();

  console.log('\n── Phase D1 — agentic write-ops (เสนอ→อนุมัติ→ดำเนินการ) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} ai-actions checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} ai-actions checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
