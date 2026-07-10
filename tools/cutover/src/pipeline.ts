/**
 * Phase 20 Batch 2A — Sales Pipeline over PGlite.
 * Stages, opportunities, move/close, activities, forecast.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover pipeline
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'pipeline-secret';
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
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'sales1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: t1 },
    { username: 'sales2', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t1 }, // CRM-1: distinct actor for the account-merge maker-checker
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
  const [admin, sales1, sales2] = [await login('admin', 'admin123'), await login('sales1', 'pw1'), await login('sales2', 'pw2')];

  // 1. List stages auto-seeds 6 default stages
  const stages = await inj('GET', '/api/pipeline/stages', sales1);
  ok('Stages auto-seeded → 6 stages', Array.isArray(stages.json) && stages.json.length === 6, `count=${stages.json?.length}`);

  // 2. Create opportunity (Prospect stage)
  const opp1 = await inj('POST', '/api/pipeline/opportunities', sales1, { name: 'Acme ERP Deal', account_name: 'Acme Corp', expected_value: 500000, expected_close: '2026-06-30' });
  ok('Create opportunity → OPP-00001, Prospect stage', opp1.status === 201 && opp1.json.opp_no === 'OPP-00001' && opp1.json.stage_name === 'Prospect', JSON.stringify(opp1.json));
  const oppId = opp1.json.id;

  // 3. Move to Qualified → probability = 25
  const moved = await inj('POST', `/api/pipeline/opportunities/${oppId}/move`, sales1, { stage_name: 'Qualified' });
  ok('Move to Qualified → probability=25', moved.status === 200 && moved.json.stage_name === 'Qualified' && moved.json.probability === 25, JSON.stringify(moved.json));

  // 4. Add call activity
  const act = await inj('POST', `/api/pipeline/opportunities/${oppId}/activities`, sales1, { activity_type: 'call', subject: 'Discovery call', notes: 'Discussed requirements', activity_date: '2026-01-15' });
  ok('Add call activity', act.status === 201 && act.json.activity_type === 'call', JSON.stringify(act.json));

  // 5. List activities → 1
  const acts = await inj('GET', `/api/pipeline/opportunities/${oppId}/activities`, sales1);
  ok('List activities → 1', acts.json.activities?.length === 1, `count=${acts.json.activities?.length}`);

  // 6. Create second opportunity for Won/Lost tests
  const opp2 = await inj('POST', '/api/pipeline/opportunities', sales1, { name: 'Beta Solutions', expected_value: 200000 });
  ok('Create second opportunity', opp2.status === 201 && opp2.json.opp_no === 'OPP-00002', JSON.stringify(opp2.json));

  // 7. Close opp1 as Won
  const won = await inj('POST', `/api/pipeline/opportunities/${oppId}/close`, sales1, { outcome: 'Won', reason: 'Best price + support' });
  ok('Close as Won → status=Won, win_reason stored', won.status === 200 && won.json.status === 'Won' && won.json.win_reason === 'Best price + support', JSON.stringify(won.json));

  // 8. Close opp2 as Lost
  const lost = await inj('POST', `/api/pipeline/opportunities/${opp2.json.id}/close`, sales1, { outcome: 'Lost', reason: 'Chose competitor' });
  ok('Close as Lost → status=Lost, loss_reason stored', lost.status === 200 && lost.json.status === 'Lost' && lost.json.loss_reason === 'Chose competitor', JSON.stringify(lost.json));

  // 9. List Won opportunities
  const wonList = await inj('GET', '/api/pipeline/opportunities?status=Won', sales1);
  ok('Filter by Won → 1 result', wonList.json.opportunities?.length === 1, `count=${wonList.json.opportunities?.length}`);

  // 10. List Open opportunities → 0 (both closed)
  const openList = await inj('GET', '/api/pipeline/opportunities?status=Open', sales1);
  ok('Filter by Open → 0 (both closed)', openList.json.opportunities?.length === 0, `count=${openList.json.opportunities?.length}`);

  // 11. Forecast (no open opportunities → empty by_stage)
  const fc = await inj('GET', '/api/pipeline/forecast', sales1);
  ok('Forecast returns total_pipeline + weighted_pipeline', fc.status === 200 && 'total_pipeline' in fc.json && 'weighted_pipeline' in fc.json, JSON.stringify(fc.json));

  // 12. Create open opp and check forecast weighted value
  const opp3 = await inj('POST', '/api/pipeline/opportunities', sales1, { name: 'Open Deal', expected_value: 100000, stage_name: 'Proposal' });
  const fc2 = await inj('GET', '/api/pipeline/forecast', sales1);
  const proposalRow = fc2.json.by_stage?.find((r: any) => r.stage === 'Proposal');
  ok('Forecast: Proposal stage weighted = 50000 (50% of 100000)', proposalRow && near(proposalRow.weighted_value, 50000), JSON.stringify(proposalRow));

  // ── CRM-1 unification (migration 0294) — ONE opportunity spine, both routes ────────────────────────

  // 13. Unified read: an opp created via the legacy /api/pipeline route is visible via the crm route
  const crmList = await inj('GET', '/api/crm/pipeline/opportunities', sales1);
  const crmOpp1 = crmList.json.opportunities?.find((o: any) => o.opp_no === 'OPP-00001');
  ok('Unified read: legacy-route OPP-00001 visible via /api/crm/pipeline (stage=won, status=Won)',
    crmOpp1 && crmOpp1.stage === 'won' && crmOpp1.status === 'Won' && near(crmOpp1.amount, 500000), JSON.stringify(crmOpp1));

  // 14. Stage transitions wrote crm_stage_history (creation + move + close)
  const hist = await inj('GET', '/api/crm/pipeline/opportunities/OPP-00001/history', sales1);
  const histStages = (hist.json.history ?? []).map((h: any) => h.to_stage);
  ok('Stage history recorded: prospecting → qualification → won',
    hist.status === 200 && histStages.join(',') === 'prospecting,qualification,won' && hist.json.history?.[0]?.from_stage === null,
    JSON.stringify(hist.json.history));

  // 15. REV-17 terminal guard now binds on the legacy route too: moving a closed deal → OPP_CLOSED
  const moveClosed = await inj('POST', `/api/pipeline/opportunities/${oppId}/move`, sales1, { stage_name: 'Proposal' });
  ok('Move a Won opp via legacy route → 400 OPP_CLOSED (terminal)', moveClosed.status === 400 && moveClosed.json.error?.code === 'OPP_CLOSED', `${moveClosed.status} ${moveClosed.json.error?.code}`);

  // 16. Accounts: create + duplicate detection (409 DUPLICATE_SUSPECT with match list) + force override
  const accA = await inj('POST', '/api/crm/accounts', sales1, { name: 'บริษัท อินวิซิเบิล จำกัด', tax_id: '0105561000001', email: 'contact@invisible.example', industry: 'software' });
  ok('Create account → 201 + ACC- number', accA.status === 201 && /^ACC-/.test(accA.json.account_no ?? ''), JSON.stringify(accA.json));
  const dupTry = await inj('POST', '/api/crm/accounts', sales1, { name: 'Invisible Co., Ltd.', tax_id: '0105561000001' });
  ok('Duplicate account (same tax_id) → 409 DUPLICATE_SUSPECT + matches', dupTry.status === 409 && dupTry.json.error?.code === 'DUPLICATE_SUSPECT' && dupTry.json.error?.details?.matches?.length >= 1, `${dupTry.status} ${dupTry.json.error?.code} matches=${dupTry.json.error?.details?.matches?.length}`);
  const accB = await inj('POST', '/api/crm/accounts', sales1, { name: 'Invisible Co., Ltd.', tax_id: '0105561000001', force: true });
  ok('Force override → 201 (steward-confirmed duplicate create)', accB.status === 201 && !!accB.json.account_no, JSON.stringify(accB.json));

  // 17. Contacts: create under account + duplicate email detection + force
  const con1 = await inj('POST', '/api/crm/contacts', sales1, { account_no: accA.json.account_no, name: 'สมหญิง ผู้ตัดสินใจ', email: 'somying@invisible.example', role: 'decision_maker' });
  ok('Create contact (decision_maker) → 201', con1.status === 201 && con1.json.role === 'decision_maker', JSON.stringify(con1.json));
  const conDup = await inj('POST', '/api/crm/contacts', sales1, { account_no: accB.json.account_no, name: 'Somying D.', email: 'Somying@Invisible.example' });
  ok('Duplicate contact (same email, normalized) → 409 DUPLICATE_SUSPECT', conDup.status === 409 && conDup.json.error?.code === 'DUPLICATE_SUSPECT', `${conDup.status} ${conDup.json.error?.code}`);
  const con2 = await inj('POST', '/api/crm/contacts', sales1, { account_no: accB.json.account_no, name: 'Somying D.', email: 'somying@invisible.example', force: true });
  ok('Force contact create under duplicate account → 201', con2.status === 201, JSON.stringify(con2.json));

  // 18. Opportunity carries the account/contact FKs (crm route create with account_no)
  const accOpp = await inj('POST', '/api/crm/pipeline/opportunities', sales1, { name: 'ดีลบัญชี B', amount: 60000, account_no: accB.json.account_no });
  const accOppRow = (await inj('GET', '/api/crm/pipeline/opportunities', sales1)).json.opportunities?.find((o: any) => o.opp_no === accOpp.json.opp_no);
  ok('Opportunity links account_id (unified party model)', accOpp.status === 201 && accOppRow?.account_id != null, JSON.stringify({ opp: accOpp.json, account_id: accOppRow?.account_id }));

  // 19. Merge maker-checker: the duplicate's creator cannot merge it away while children reassign
  const selfMerge = await inj('POST', `/api/crm/accounts/${accA.json.account_no}/merge`, sales1, { duplicate_account_no: accB.json.account_no });
  ok('Merge by the duplicate creator (children present) → 403 SOD_VIOLATION', selfMerge.status === 403 && selfMerge.json.error?.code === 'SOD_VIOLATION', `${selfMerge.status} ${selfMerge.json.error?.code}`);

  // 20. Merge by a DIFFERENT user → children (contact + opportunity) repoint to the survivor; dup soft-retired
  const merged = await inj('POST', `/api/crm/accounts/${accA.json.account_no}/merge`, sales2, { duplicate_account_no: accB.json.account_no });
  ok('Merge (distinct actor) → 200, children reassigned', merged.status === 200 && merged.json.merged === true && merged.json.reassigned_children >= 2, JSON.stringify(merged.json));
  const accAAfter = await inj('GET', `/api/crm/accounts/${accA.json.account_no}`, sales1);
  const survivorContacts = (accAAfter.json.contacts ?? []).map((c: any) => c.email);
  ok('Survivor owns the duplicate\'s contact + opportunity after merge',
    survivorContacts.includes('somying@invisible.example') && survivorContacts.length >= 2 && Number(accAAfter.json.opportunity_count) >= 1,
    JSON.stringify({ contacts: survivorContacts, opportunity_count: accAAfter.json.opportunity_count }));
  const accBAfter = await inj('GET', `/api/crm/accounts/${accB.json.account_no}`, sales1);
  ok('Duplicate soft-retired (status=merged, merged_into set)', accBAfter.json.status === 'merged' && accBAfter.json.merged_into != null, JSON.stringify({ status: accBAfter.json.status, merged_into: accBAfter.json.merged_into }));

  // 21. CPQ quote against a unified-spine opportunity id (created via the legacy route) resolves
  const q1 = await inj('POST', '/api/cpq/quotes', sales1, { customer_name: 'Unified Buyer', opportunity_id: opp3.json.id, lines: [{ description: 'Implementation', qty: 1, unit_price: 90000 }] });
  ok('CPQ quote created against unified opp id → 201, opportunity_id echoed', q1.status === 201 && q1.json.opportunity_id === opp3.json.id, JSON.stringify({ status: q1.status, opportunity_id: q1.json.opportunity_id }));
  const qBad = await inj('POST', '/api/cpq/quotes', sales1, { customer_name: 'Ghost', opportunity_id: 999999 });
  ok('CPQ quote against a dangling opp id → 404 OPP_NOT_FOUND', qBad.status === 404 && qBad.json.error?.code === 'OPP_NOT_FOUND', `${qBad.status} ${qBad.json.error?.code}`);

  // 22. Legacy data-migration replay: seed rows in the RETIRED Batch 2A tables and re-run the (idempotent)
  //     0294 migration — the legacy opportunity + its activity + its CPQ quote must fold into the spine.
  const t1Stages = await db.select().from(s.pipelineStages).where(eq(s.pipelineStages.tenantId, t1));
  const proposalStage = t1Stages.find((st: any) => st.name === 'Proposal');
  const [legOpp] = await db.insert(s.opportunities).values({
    tenantId: t1, oppNo: 'OPP-LEG-1', name: 'ดีลเก่า Batch2A', accountName: 'Legacy Corp',
    stageId: Number(proposalStage!.id), probability: 50, expectedValue: '75000', currency: 'THB',
    status: 'Open', assignedTo: 'sales1', createdBy: 'sales1',
  }).returning();
  await db.insert(s.opportunityActivities).values({ oppId: Number(legOpp!.id), activityType: 'meeting', subject: 'Legacy kickoff', createdBy: 'sales1' });
  await db.insert(s.quotes).values({ tenantId: t1, quoteNo: 'QT-LEG-1', opportunityId: Number(legOpp!.id), customerName: 'Legacy Corp', status: 'Draft', subtotal: '0', discountTotal: '0', total: '0', createdBy: 'sales1' });
  await pg.exec(readFileSync(join(MIGRATIONS_DIR, '0294_crm_unification.sql'), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const migList = await inj('GET', '/api/pipeline/opportunities', sales1);
  const migOpp = migList.json.opportunities?.find((o: any) => o.opp_no === 'OPP-LEG-1');
  ok('Migrated legacy opp visible via /api/pipeline (expected_value mapped)', migOpp && near(migOpp.expected_value, 75000) && migOpp.status === 'Open', JSON.stringify(migOpp));
  const migCrm = (await inj('GET', '/api/crm/pipeline/opportunities', sales1)).json.opportunities?.find((o: any) => o.opp_no === 'OPP-LEG-1');
  ok('Migrated legacy opp visible via /api/crm/pipeline (stage name mapped → proposal)', migCrm && migCrm.stage === 'proposal', JSON.stringify(migCrm));
  const migActs = await inj('GET', `/api/pipeline/opportunities/${migOpp?.id}/activities`, sales1);
  ok('Legacy opportunity_activities folded into crm_activities', migActs.json.activities?.some((a: any) => a.subject === 'Legacy kickoff'), JSON.stringify(migActs.json.activities));
  const quoteList = await inj('GET', '/api/cpq/quotes', sales1);
  const migQuote = quoteList.json.quotes?.find((q: any) => q.quote_no === 'QT-LEG-1');
  ok('CPQ quote repointed to the migrated opportunity (crm_opportunity_id backfilled)', migQuote && migQuote.opportunity_id === migOpp?.id, JSON.stringify({ quote_opp: migQuote?.opportunity_id, crm_id: migOpp?.id }));

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
