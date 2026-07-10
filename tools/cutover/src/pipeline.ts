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

  // ── CRM-2 — the modern CRM workspace (docs/41): deal detail, web-to-lead, CSV import ─────────────

  // 23. Deal detail endpoint composes account + stage history + activities + linked CPQ quotes
  const dealOppNo = opp3.json.opp_no; // 'Open Deal' from check 12, carries the CPQ quote of check 21
  await inj('POST', '/api/crm/pipeline/activities', sales1, { entity_type: 'opportunity', entity_no: dealOppNo, type: 'task', subject: 'ส่งใบเสนอราคา', due_date: '2026-08-01' });
  const detail = await inj('GET', `/api/crm/pipeline/opportunities/${dealOppNo}`, sales1);
  ok('Deal detail: opp + history + activities + linked quotes in ONE payload',
    detail.status === 200 && detail.json.opp_no === dealOppNo
      && (detail.json.history?.length ?? 0) >= 1
      && detail.json.activities?.some((a: any) => a.subject === 'ส่งใบเสนอราคา')
      && detail.json.quotes?.length === 1 && detail.json.quotes[0].total > 0,
    JSON.stringify({ history: detail.json.history?.length, acts: detail.json.activities?.length, quotes: detail.json.quotes?.length }));
  ok('Deal detail: next_task = the nearest undone task (next-step highlight)',
    detail.json.next_task?.subject === 'ส่งใบเสนอราคา' && detail.json.next_task?.done === false, JSON.stringify(detail.json.next_task));

  // 24. Board enrichment: list rows expose account_name + stage_entered_at (age-in-stage)
  const enriched = (await inj('GET', '/api/crm/pipeline/opportunities', sales1)).json.opportunities?.find((o: any) => o.opp_no === accOpp.json.opp_no);
  ok('Board list enriched with account_name + stage_entered_at', !!enriched && !!enriched.account_name && !!enriched.stage_entered_at, JSON.stringify({ account_name: enriched?.account_name, entered: enriched?.stage_entered_at }));

  // 25. Governed won-close via PATCH stage now records the optional win_reason
  const winMove = await inj('PATCH', `/api/crm/pipeline/opportunities/${dealOppNo}/stage`, sales1, { stage: 'won', win_reason: 'ราคาดีที่สุด' });
  const wonDetail = await inj('GET', `/api/crm/pipeline/opportunities/${dealOppNo}`, sales1);
  ok('PATCH stage → won stores win_reason (CRM-2 board close dialog)', winMove.status === 200 && wonDetail.json.status === 'Won' && wonDetail.json.win_reason === 'ราคาดีที่สุด', JSON.stringify({ status: wonDetail.json.status, win_reason: wonDetail.json.win_reason }));

  // 26. Public web-to-lead: anonymous POST creates a 'web' lead (no auth header at all)
  const w2l = await inj('POST', '/api/crm/web-to-lead', undefined, { name: 'คุณเว็บ ลูกค้าใหม่', company: 'Website Co', email: 'web@lead.example', message: 'สนใจสินค้า', tenant_code: 'T1' });
  const webLead = (await inj('GET', '/api/crm/pipeline/leads', sales1)).json.leads?.find((l: any) => l.email === 'web@lead.example');
  ok('Web-to-lead (public, no JWT) → { ok: true } + lead created with source=web',
    w2l.status === 200 && w2l.json.ok === true && !!webLead && webLead.source === 'web' && webLead.status === 'new',
    JSON.stringify({ status: w2l.status, body: w2l.json, lead: webLead?.lead_no, source: webLead?.source }));

  // 27. Honeypot: a filled `website` field is dropped SILENTLY with the identical { ok: true } shape
  const honey = await inj('POST', '/api/crm/web-to-lead', undefined, { name: 'Bot Bot', email: 'bot@spam.example', website: 'http://spam.example', tenant_code: 'T1' });
  const botLead = (await inj('GET', '/api/crm/pipeline/leads', sales1)).json.leads?.find((l: any) => l.email === 'bot@spam.example');
  ok('Web-to-lead honeypot → 200 { ok: true } but NO lead created', honey.status === 200 && honey.json.ok === true && !botLead, JSON.stringify({ status: honey.status, body: honey.json, created: !!botLead }));

  // 28. Multi-tenant install without tenant_code → 400 TENANT_REQUIRED (never a cross-tenant guess)
  const noTenant = await inj('POST', '/api/crm/web-to-lead', undefined, { name: 'ไม่มี tenant' });
  ok('Web-to-lead without tenant_code on a multi-tenant DB → 400 TENANT_REQUIRED', noTenant.status === 400 && noTenant.json.error?.code === 'TENANT_REQUIRED', `${noTenant.status} ${noTenant.json.error?.code}`);

  // 29. Rate-limit shape: the public path rides its OWN strict edge bucket (not the loose global one)
  const { rateLimitBucketOf } = await import('../../../apps/api/dist/common/edge');
  ok('Edge rate limiter: /api/crm/web-to-lead is on the dedicated strict bucket',
    rateLimitBucketOf('/api/crm/web-to-lead') === 'lead' && rateLimitBucketOf('/api/crm/pipeline/leads') === 'api' && rateLimitBucketOf('/api/login') === 'auth',
    `bucket=${rateLimitBucketOf('/api/crm/web-to-lead')}`);

  // 30. CSV lead import: dry-run validation report, then commit (invalid row skipped, LEAD- numbered)
  const csv = 'Name,Company,Email,Phone,Source\nสมชาย นำเข้า,Import Co,somchai@imp.example,0812345678,expo\n,NoName Co,,,\nสมหญิง นำเข้า,,somying@imp.example,,expo';
  const dry = await inj('POST', '/api/crm/pipeline/leads/import', sales1, { format: 'csv', csv, dry_run: true });
  ok('Lead import dry-run → 3 rows, 2 valid, 1 invalid (Name required), nothing written',
    dry.status === 200 && dry.json.dry_run === true && dry.json.total === 3 && dry.json.valid === 2 && dry.json.invalid === 1
      && dry.json.errors?.[0]?.code === 'REQUIRED_EMPTY'
      && !(await inj('GET', '/api/crm/pipeline/leads', sales1)).json.leads?.some((l: any) => l.email === 'somchai@imp.example'),
    JSON.stringify(dry.json));
  const imp = await inj('POST', '/api/crm/pipeline/leads/import', sales1, { format: 'csv', csv });
  const impLeads = (await inj('GET', '/api/crm/pipeline/leads', sales1)).json.leads?.filter((l: any) => l.source === 'expo');
  ok('Lead import commit → imported 2 / skipped 1; leads LEAD-numbered with source from the file',
    imp.status === 200 && imp.json.imported === 2 && imp.json.skipped === 1
      && impLeads?.length === 2 && impLeads.every((l: any) => /^LEAD-/.test(l.lead_no) && l.status === 'new'),
    JSON.stringify({ result: imp.json, leads: impLeads?.map((l: any) => l.lead_no) }));
  const tpl = await inj('GET', '/api/crm/pipeline/leads/import/template', sales1);
  ok('Lead import template lists the header contract (Name required)', tpl.status === 200 && tpl.json.headers?.[0] === 'Name' && tpl.json.required?.includes('Name'), JSON.stringify(tpl.json));

  // ── CRM-4 — automation: scoring, pipeline events, follow-up SLA, comms (migration 0301, control REV-22) ──

  // 31. Lead scoring (explainable, versioned): a referral B2B lead with email+phone grades A
  const hotLead = await inj('POST', '/api/crm/pipeline/leads', sales1, { name: 'Hot Prospect', company: 'BigCo', email: 'buyer@bigco.example', phone: '0891112222', source: 'referral' });
  ok('Create lead returns an A-grade score (referral + company + email + phone → 100)', hotLead.status === 201 && hotLead.json.grade === 'A' && hotLead.json.score >= 70, JSON.stringify({ grade: hotLead.json.grade, score: hotLead.json.score }));
  const scoreRead = await inj('GET', `/api/crm/pipeline/leads/${hotLead.json.lead_no}/score`, sales1);
  ok('Lead score is versioned (v1) + carries an explainable per-factor breakdown', scoreRead.status === 200 && scoreRead.json.version === 'v1' && Array.isArray(scoreRead.json.breakdown) && scoreRead.json.breakdown.some((b: any) => b.factor === 'source' && b.points === 40), JSON.stringify(scoreRead.json.breakdown));
  const coldLead = await inj('POST', '/api/crm/pipeline/leads', sales1, { name: 'ไม่ทราบชื่อ', source: 'cold' });
  ok('A cold, contactless lead grades D (low score)', coldLead.json.grade === 'D', JSON.stringify({ grade: coldLead.json.grade, score: coldLead.json.score }));

  // 32. Pipeline event → automation engine: a rule on deal.won fires when a deal closes Won
  await inj('POST', '/api/automation/rules', sales1, { name: 'แจ้งเมื่อปิดการขาย', event_type: 'deal.won', action: { type: 'notification', message: 'ปิดการขายสำเร็จ' } });
  const evOpp = await inj('POST', '/api/pipeline/opportunities', sales1, { name: 'Event Deal', expected_value: 300000 });
  await inj('POST', `/api/pipeline/opportunities/${evOpp.json.id}/close`, sales1, { outcome: 'Won', reason: 'good fit' });
  const execs = await inj('GET', '/api/automation/executions', sales1);
  ok('deal.won emitted into the automation engine → rule executed', execs.status === 200 && execs.json.executions?.some((e: any) => e.event_type === 'deal.won' && e.status === 'executed'), JSON.stringify(execs.json.executions?.slice(0, 3)));
  const cat = await inj('GET', '/api/automation/events', sales1);
  ok('Automation catalog exposes the CRM-4 pipeline events', cat.status === 200 && ['lead.created', 'lead.stagnant', 'opp.stage_changed', 'deal.won', 'deal.lost'].every((k) => cat.json.events?.some((e: any) => e.key === k)), '');

  // 33. Follow-up SLA breach detection: an aged, untouched 'new' lead surfaces; logging an activity clears it
  const slaLead = await inj('POST', '/api/crm/pipeline/leads', sales1, { name: 'Aging Lead', email: 'aging@x.example', source: 'web' });
  await db.update(s.crmLeads).set({ createdAt: new Date(Date.now() - 48 * 3600_000) }).where(eq(s.crmLeads.leadNo, slaLead.json.lead_no));
  const foll1 = await inj('GET', '/api/crm/pipeline/follow-up', sales1);
  const breach = foll1.json.items?.find((i: any) => i.kind === 'lead_sla_breach' && i.ref === slaLead.json.lead_no);
  ok('Follow-up center flags an aged untouched lead as an SLA breach (REV-22)', foll1.status === 200 && !!breach && breach.severity === 'high', JSON.stringify({ total: foll1.json.summary?.total, breach: breach?.ref }));
  await inj('POST', '/api/crm/pipeline/activities', sales1, { entity_type: 'lead', entity_no: slaLead.json.lead_no, type: 'call', subject: 'reached out' });
  const foll2 = await inj('GET', '/api/crm/pipeline/follow-up', sales1);
  ok('Logging an activity clears the SLA breach (the lead is now touched)', !foll2.json.items?.some((i: any) => i.kind === 'lead_sla_breach' && i.ref === slaLead.json.lead_no), '');

  // 34. Follow-up settings + round-robin assignment per pipeline
  const setSettings = await inj('PUT', '/api/crm/pipeline/follow-up/settings', sales1, { sla_hours: 12, rotting_days: 5, round_robin_owners: ['sales1', 'sales2'] });
  ok('Follow-up settings persisted (SLA + rotting + round-robin owners)', setSettings.status === 200 && setSettings.json.sla_hours === 12 && setSettings.json.round_robin_owners?.length === 2, JSON.stringify(setSettings.json));
  const rr1 = await inj('POST', '/api/crm/pipeline/leads', sales1, { name: 'RR One', source: 'web' });
  const rr2 = await inj('POST', '/api/crm/pipeline/leads', sales1, { name: 'RR Two', source: 'web' });
  ok('Round-robin assigns new leads across the configured owners', rr1.json.owner !== rr2.json.owner && ['sales1', 'sales2'].includes(rr1.json.owner) && ['sales1', 'sales2'].includes(rr2.json.owner), JSON.stringify({ a: rr1.json.owner, b: rr2.json.owner }));

  // 35. Daily follow-up digest sweep → counts + emits lead.stagnant into the automation engine
  const digLead = await inj('POST', '/api/crm/pipeline/leads', sales1, { name: 'Digest Lead', source: 'web' });
  await db.update(s.crmLeads).set({ createdAt: new Date(Date.now() - 72 * 3600_000) }).where(eq(s.crmLeads.leadNo, digLead.json.lead_no));
  await inj('POST', '/api/automation/rules', sales1, { name: 'escalate stagnant', event_type: 'lead.stagnant', action: { type: 'log' } });
  const sweep = await inj('POST', '/api/crm/pipeline/follow-up/run', sales1);
  ok('Follow-up digest sweep reports SLA breaches', sweep.status === 200 && sweep.json.sla_breaches >= 1, JSON.stringify(sweep.json));
  const stagExecs = await inj('GET', '/api/automation/executions', sales1);
  ok('lead.stagnant emitted into the automation engine by the sweep', stagExecs.json.executions?.some((e: any) => e.event_type === 'lead.stagnant'), '');

  // 36. Sales comms from a deal: merge fields resolved, sent via messaging, logged as a timeline activity
  const mf = await inj('GET', '/api/crm/pipeline/comms/merge-fields', sales1);
  ok('Comms merge-field catalog lists the deal fields', mf.status === 200 && mf.json.fields?.includes('contact.name') && mf.json.fields?.includes('opp.name'), JSON.stringify(mf.json.fields));
  const commsOpp = await inj('POST', '/api/crm/pipeline/opportunities', sales1, { name: 'Comms Deal', account_no: accA.json.account_no, primary_contact_id: con1.json.id, amount: 45000 });
  const comms = await inj('POST', `/api/crm/pipeline/opportunities/${commsOpp.json.opp_no}/comms`, sales1, { channel: 'email', subject: 'สวัสดี {{contact.name}}', body: 'ดีล {{opp.name}} มูลค่า {{opp.amount}} บาท' });
  ok('Comms send resolves merge fields (contact.name + opp.name) and returns the rendered body', comms.status === 200 && comms.json.subject?.includes('สมหญิง') && comms.json.body?.includes('Comms Deal') && !comms.json.body?.includes('{{'), JSON.stringify({ subject: comms.json.subject, body: comms.json.body }));
  const commsDetail = await inj('GET', `/api/crm/pipeline/opportunities/${commsOpp.json.opp_no}`, sales1);
  ok('Comms send is logged as a timeline activity on the deal', commsDetail.json.activities?.some((a: any) => a.type === 'email' && String(a.subject ?? '').includes('สวัสดี')), JSON.stringify(commsDetail.json.activities?.map((a: any) => a.subject)));

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
