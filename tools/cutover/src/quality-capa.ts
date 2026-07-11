/**
 * QMS-2 — CAPA (Corrective & Preventive Action) lifecycle + QC-02 effectiveness sign-off, over PGlite.
 * Create a CAPA + child actions; close blocked while actions pending (ACTIONS_INCOMPLETE); self-verify
 * blocked (SOD_SELF_APPROVAL); a DISTINCT verifier marks effective → closed; ineffective → reopened; the
 * overdue detective read; RLS isolation across tenants. Builds ONLY on the new capas/capa_actions tables.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover quality-capa
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'capa-secret';
process.env.NODE_ENV = 'test';
// multi-company so per-tenant Admins are RLS-scoped to their own tenant (single-company grants a global
// Admin bypass) — lets the RLS-isolation checks below prove a T1 Admin can't see/act on HQ CAPAs.
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
    { username: 'owner', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },     // CAPA owner/creator
    { username: 'verifier', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },   // independent verifier (QC-02)
    { username: 't1admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t1 },    // other tenant (RLS)
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
  const [owner, verifier, t1admin] = [await login('owner', 'admin123'), await login('verifier', 'admin123'), await login('t1admin', 'admin123')];

  // ── 1. Create a CAPA + child actions ──
  const c1 = await inj('POST', '/api/quality/capa', owner, {
    title: 'Repeated sealing-machine leak', problem_statement: 'Seal fails > spec on line 3',
    root_cause: 'Worn gasket + no PM schedule', action_type: 'both', target_date: '2026-08-31',
    source_type: 'gr_claim', source_ref: 'CLAIM-42',
  });
  ok('Create CAPA → capa_no + status open', c1.status === 201 && /^CAPA-\d{5}$/.test(c1.json.capa_no) && c1.json.status === 'open', JSON.stringify(c1.json));
  ok('CAPA owner defaults to creator + source link recorded', c1.json.owner === 'owner' && c1.json.source_type === 'gr_claim' && c1.json.source_ref === 'CLAIM-42', JSON.stringify(c1.json));
  const id1 = c1.json.id;

  const a1 = await inj('POST', `/api/quality/capa/${id1}/actions`, owner, { description: 'Replace gasket', due_date: '2026-08-10' });
  const a2 = await inj('POST', `/api/quality/capa/${id1}/actions`, owner, { description: 'Add weekly PM task', due_date: '2026-08-20' });
  ok('Add two child actions (seq 1,2)', a1.status === 201 && a2.status === 201 && a1.json.seq === 1 && a2.json.seq === 2, JSON.stringify([a1.json.seq, a2.json.seq]));

  const afterActions = await inj('GET', `/api/quality/capa/${id1}`, owner);
  ok('First action moves CAPA open → in_progress; detail carries actions', afterActions.json.status === 'in_progress' && afterActions.json.actions?.length === 2, JSON.stringify({ st: afterActions.json.status, n: afterActions.json.actions?.length }));

  // ── 2. Submit for verification ──
  const sub1 = await inj('POST', `/api/quality/capa/${id1}/submit`, owner);
  ok('Submit → pending_verification', sub1.status === 200 && sub1.json.status === 'pending_verification', JSON.stringify(sub1.json));

  // ── 3. QC-02: close blocked while actions still pending (ACTIONS_INCOMPLETE) ──
  const early = await inj('POST', `/api/quality/capa/${id1}/verify`, verifier, { result: 'effective' });
  ok('Verify blocked while actions pending → ACTIONS_INCOMPLETE', early.status === 400 && early.json.error?.code === 'ACTIONS_INCOMPLETE', JSON.stringify(early.json));

  // ── 4. QC-02: self-verify blocked (SOD_SELF_APPROVAL) — owner is also the creator ──
  const selfVerify = await inj('POST', `/api/quality/capa/${id1}/verify`, owner, { result: 'effective' });
  ok('Owner self-verify → 403 SOD_SELF_APPROVAL', selfVerify.status === 403 && selfVerify.json.error?.code === 'SOD_SELF_APPROVAL', JSON.stringify(selfVerify.json));

  // Complete both actions.
  await inj('POST', `/api/quality/capa/${id1}/actions/${a1.json.id}/complete`, owner);
  const doneA2 = await inj('POST', `/api/quality/capa/${id1}/actions/${a2.json.id}/complete`, owner);
  ok('Complete actions → status done + completed_by', doneA2.status === 200 && doneA2.json.status === 'done' && doneA2.json.completed_by === 'owner', JSON.stringify(doneA2.json));

  // ── 5. Distinct verifier marks effective → closed ──
  const verified = await inj('POST', `/api/quality/capa/${id1}/verify`, verifier, { result: 'effective', note: 'No recurrence in 30d' });
  ok('Distinct verifier effective → closed + effectiveness_result + verified_by', verified.status === 200 && verified.json.status === 'closed' && verified.json.effectiveness_result === 'effective' && verified.json.verified_by === 'verifier', JSON.stringify(verified.json));

  // A closed CAPA cannot be re-verified.
  const reVerify = await inj('POST', `/api/quality/capa/${id1}/verify`, verifier, { result: 'effective' });
  ok('Re-verify a closed CAPA → NOT_PENDING_VERIFICATION', reVerify.status === 400 && reVerify.json.error?.code === 'NOT_PENDING_VERIFICATION', JSON.stringify(reVerify.json));

  // ── 6. Ineffective verification reopens (in_progress) ──
  const c2 = await inj('POST', '/api/quality/capa', owner, { title: 'Label mis-print', action_type: 'corrective', target_date: '2026-09-15' });
  const id2 = c2.json.id;
  const b1 = await inj('POST', `/api/quality/capa/${id2}/actions`, owner, { description: 'Recalibrate printer' });
  await inj('POST', `/api/quality/capa/${id2}/actions/${b1.json.id}/complete`, owner);
  await inj('POST', `/api/quality/capa/${id2}/submit`, owner);
  const ineff = await inj('POST', `/api/quality/capa/${id2}/verify`, verifier, { result: 'ineffective', note: 'Recurred after 1 week' });
  ok('Ineffective verification → reopened (in_progress), not closed', ineff.status === 200 && ineff.json.status === 'in_progress' && ineff.json.effectiveness_result === 'ineffective', JSON.stringify(ineff.json));

  // ── 7. Reject verification sends it back (distinct user + reason) ──
  const c3 = await inj('POST', '/api/quality/capa', owner, { title: 'Torque spec drift', target_date: '2026-09-20' });
  const id3 = c3.json.id;
  const d1 = await inj('POST', `/api/quality/capa/${id3}/actions`, owner, { description: 'Re-torque + audit' });
  await inj('POST', `/api/quality/capa/${id3}/actions/${d1.json.id}/complete`, owner);
  await inj('POST', `/api/quality/capa/${id3}/submit`, owner);
  const rejNoReason = await inj('POST', `/api/quality/capa/${id3}/reject`, verifier, {});
  ok('Reject without reason → REASON_REQUIRED', rejNoReason.status === 400 && rejNoReason.json.error?.code === 'REASON_REQUIRED', JSON.stringify(rejNoReason.json));
  const rejSelf = await inj('POST', `/api/quality/capa/${id3}/reject`, owner, { reason: 'x' });
  ok('Owner self-reject → 403 SOD_SELF_APPROVAL', rejSelf.status === 403 && rejSelf.json.error?.code === 'SOD_SELF_APPROVAL', JSON.stringify(rejSelf.json));
  const rej = await inj('POST', `/api/quality/capa/${id3}/reject`, verifier, { reason: 'Evidence insufficient' });
  ok('Distinct verifier reject → back to in_progress', rej.status === 200 && rej.json.status === 'in_progress', JSON.stringify(rej.json));

  // ── 8. Submit with no actions is blocked ──
  const c4 = await inj('POST', '/api/quality/capa', owner, { title: 'No-plan CAPA' });
  const noAct = await inj('POST', `/api/quality/capa/${c4.json.id}/submit`, owner);
  ok('Submit with no actions → NO_ACTIONS', noAct.status === 400 && noAct.json.error?.code === 'NO_ACTIONS', JSON.stringify(noAct.json));

  // ── 9. Cancel a CAPA ──
  const cancel = await inj('POST', `/api/quality/capa/${c4.json.id}/cancel`, owner, { reason: 'Duplicate of C1' });
  ok('Cancel → status cancelled', cancel.status === 200 && cancel.json.status === 'cancelled', JSON.stringify(cancel.json));

  // ── 10. Overdue detective read (target_date already passed, not closed/cancelled) ──
  const past = await inj('POST', '/api/quality/capa', owner, { title: 'Overdue item', target_date: '2020-01-01' });
  const overdue = await inj('GET', '/api/quality/capa/overdue?days=0', owner);
  const overNos = (overdue.json.capas ?? []).map((c: any) => c.capa_no);
  ok('Overdue read includes a past-target open CAPA', overdue.status === 200 && overNos.includes(past.json.capa_no), JSON.stringify(overNos));
  ok('Overdue read excludes the closed CAPA', !overNos.includes(c1.json.capa_no), JSON.stringify(overNos));

  // ── 11. RLS isolation — T1 cannot see or act on HQ CAPAs ──
  const t1List = await inj('GET', '/api/quality/capa', t1admin);
  ok('RLS: T1 sees none of HQ CAPAs', t1List.status === 200 && t1List.json.count === 0, JSON.stringify({ count: t1List.json.count }));
  const t1Verify = await inj('POST', `/api/quality/capa/${id2}/verify`, t1admin, { result: 'effective' });
  ok('RLS: T1 cannot verify an HQ CAPA → 404 CAPA_NOT_FOUND', t1Verify.status === 404 && t1Verify.json.error?.code === 'CAPA_NOT_FOUND', JSON.stringify(t1Verify.json));

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
