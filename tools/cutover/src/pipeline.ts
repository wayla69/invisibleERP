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
import { eq, and } from 'drizzle-orm';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import * as s from '../../../apps/api/dist/database/schema/index';
import { AppModule } from '../../../apps/api/dist/app.module';
import { encrypt } from '../../../apps/api/dist/common/crypto';
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
  // rawBody:true mirrors production main.ts — CRM-6's inbound webhook verifies the per-tenant email HMAC over
  // the exact raw bytes (needs rawBody populated), like the email-capture / LINE webhooks.
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ routerOptions: { maxParamLength: 500 } }), { rawBody: true });
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

  // ── CRM-4 — automation: scoring, pipeline events, follow-up SLA, comms (migration 0307, control REV-22) ──

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
  ok('Comms send stamps a reply-threading token and embeds it in the dispatched subject (CRM-6 seam)',
    typeof comms.json.thread_token === 'string' && comms.json.thread_token.startsWith('crmt_') && String(comms.json.subject ?? '').includes(`[ref:${comms.json.thread_token}]`),
    JSON.stringify({ token: comms.json.thread_token, subj: comms.json.subject }));

  // ── CRM-6 — inbound email capture → CRM (2-way comms; migration 0309). Mirrors email-capture's AP rail: a
  // per-tenant CRM inbound address receives replies, authenticated by the tenant email HMAC, matched to a
  // deal/lead and logged as a timeline activity; unmatched → the review queue; a bad signature is rejected. ──
  const CRM_WH_SECRET = 'crmwhsec-t1';
  await db.insert(s.tenantMessagingConfig)
    .values({ tenantId: t1, channel: 'email', configEnc: encrypt(JSON.stringify({ host: 'smtp.test', hmac_secret: CRM_WH_SECRET })), enabled: true, updatedBy: 'test' })
    .onConflictDoUpdate({ target: [s.tenantMessagingConfig.tenantId, s.tenantMessagingConfig.channel], set: { configEnc: encrypt(JSON.stringify({ host: 'smtp.test', hmac_secret: CRM_WH_SECRET })), enabled: true } });
  // Signed inbound-webhook injector: HMAC-SHA256 (hex) over the exact serialized bytes, like production.
  const crmInbound = async (payload: any, secret = CRM_WH_SECRET) => {
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: 'POST', url: '/api/crm/email/inbound/T1',
      headers: { 'content-type': 'application/json', 'x-inbound-signature': createHmac('sha256', secret).update(body).digest('hex') },
      payload: body,
    });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };

  // 37. Threading-token match: a reply carrying the outbound comms token threads back to the Comms Deal and is
  //     logged as an inbound timeline activity — even though it arrives from a different address.
  const replyTok = await crmInbound({ from: 'assistant@invisible.example', subject: `Re: สวัสดี [ref:${comms.json.thread_token}]`, text: 'สนใจครับ ขอใบเสนอราคา', message_id: 'crm-in-1' });
  ok('CRM-6: signed inbound reply with the thread token → matched to the deal (matched_by=thread_token)',
    replyTok.status === 201 || replyTok.status === 200 ? replyTok.json.matched === true && replyTok.json.matched_by === 'thread_token' && replyTok.json.entity_no === commsOpp.json.opp_no : false,
    JSON.stringify({ st: replyTok.status, matched: replyTok.json.matched, by: replyTok.json.matched_by, no: replyTok.json.entity_no }));
  const afterTok = await inj('GET', `/api/crm/pipeline/opportunities/${commsOpp.json.opp_no}`, sales1);
  ok('CRM-6: the inbound reply is logged as an email activity on the deal timeline (source=inbound)',
    afterTok.json.activities?.some((a: any) => a.type === 'email' && String(a.notes ?? '').includes('ขอใบเสนอราคา')),
    JSON.stringify(afterTok.json.activities?.map((a: any) => ({ t: a.type, s: a.subject }))));

  // 38. Sender-address match: a reply from the contact-of-record's email (no token) matches their open deal.
  const replyContact = await crmInbound({ from: 'somying@invisible.example', subject: 'สอบถามเพิ่มเติม', text: 'ราคานี้รวม VAT ไหม', message_id: 'crm-in-2' });
  ok('CRM-6: inbound from a known contact email (no token) → matched to their open opportunity (contact_email)',
    replyContact.json.matched === true && replyContact.json.matched_by === 'contact_email' && replyContact.json.entity_no === commsOpp.json.opp_no,
    JSON.stringify({ matched: replyContact.json.matched, by: replyContact.json.matched_by, no: replyContact.json.entity_no }));

  // 39. Redelivery dedupe on message_id — the provider retrying the same delivery does not double-log.
  const replyDup = await crmInbound({ from: 'somying@invisible.example', subject: 'สอบถามเพิ่มเติม', text: 'ราคานี้รวม VAT ไหม', message_id: 'crm-in-2' });
  ok('CRM-6: provider redelivery (same message_id) is deduped — no duplicate activity', replyDup.json.matched === false && replyDup.json.skipped === 'duplicate', JSON.stringify(replyDup.json));

  // 40. Unmatched inbound → the review queue (not attached to a guessed deal).
  const replyUnknown = await crmInbound({ from: 'stranger@nowhere.example', subject: 'hello', text: 'who are you', message_id: 'crm-in-3' });
  ok('CRM-6: inbound from an unknown sender (no token, no contact) → parked in the review queue', replyUnknown.json.matched === false && replyUnknown.json.queued === true, JSON.stringify(replyUnknown.json));
  const queue = await inj('GET', '/api/crm/inbound/review', sales1);
  const queued = queue.json.messages?.find((m: any) => m.from === 'stranger@nowhere.example');
  ok('CRM-6: the review queue lists the unmatched inbound (unmatched + unresolved)', queue.status === 200 && !!queued && queued.match_status === 'unmatched' && queued.resolved === false, JSON.stringify({ n: queue.json.count, found: !!queued }));

  // 41. Manual link from the queue → logs the activity on a chosen deal + resolves the queue item.
  const linkRes = await inj('POST', `/api/crm/inbound/${queued?.id}/link`, sales1, { entity_type: 'opportunity', entity_no: commsOpp.json.opp_no });
  ok('CRM-6: manually linking a queued inbound logs the activity and resolves it (matched_by=manual)', linkRes.status === 200 && linkRes.json.matched === true && linkRes.json.activity_id != null, JSON.stringify(linkRes.json));
  const queueAfter = await inj('GET', '/api/crm/inbound/review', sales1);
  ok('CRM-6: the linked message leaves the review queue', !queueAfter.json.messages?.some((m: any) => m.id === queued?.id), JSON.stringify({ n: queueAfter.json.count }));

  // 42. Authenticity gate: a tampered/bad signature is rejected (401 BAD_INBOUND_SECRET) — nothing logged.
  const badSig = await crmInbound({ from: 'somying@invisible.example', subject: 'forged', text: 'x', message_id: 'crm-in-4' }, 'wrong-secret');
  ok('CRM-6: inbound with a bad HMAC signature → 401 BAD_INBOUND_SECRET (fail-closed authenticity)', badSig.status === 401 && badSig.json.error?.code === 'BAD_INBOUND_SECRET', JSON.stringify({ st: badSig.status, code: badSig.json.error?.code }));
  const recentAll = await inj('GET', '/api/crm/inbound?limit=50', sales1);
  ok('CRM-6: the forged delivery was not journaled (no crm-in-4 capture row)', !recentAll.json.messages?.some((m: any) => m.subject === 'forged'), JSON.stringify({ n: recentAll.json.count }));
  // ── CRM-3 — Customer 360: the finance-joined pre-call screen (docs/42) ────────────────────────────
  // "CRM ไม่เห็นเงิน": one read joins the CRM-1 account to the money. Seed a loyalty member with a paid
  // order (→ RFM profile), the company's overdue AR invoice + a receipt for T1 (AR/credit position + last
  // payment), then a CRM account whose contact links that member and that carries an open deal + a CPQ
  // quote. GET /api/crm/customer-360/:accountNo must fold ALL of it into ONE payload.
  await db.update(s.tenants).set({ creditLimit: '50000' }).where(eq(s.tenants.id, t1));
  const [mem360] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-360', name: 'ลูกค้า 360', phone: '0899990360', lifetime: '1200', tier: 'Gold', active: true }).returning();
  const mem360Id = Number(mem360!.id);
  await db.insert(s.dineInOrders).values({ tenantId: t1, orderNo: 'DIN-360-1', channel: 'web', memberId: mem360Id, total: '850', saleNo: 'S-360-1', openedAt: new Date() });
  await db.insert(s.arInvoices).values({ invoiceNo: 'INV-360-1', tenantId: t1, invoiceDate: '2026-01-01', dueDate: '2026-02-01', amount: '10000', paidAmount: '3000', status: 'Unpaid', currency: 'THB', createdAt: new Date() });
  await db.insert(s.arReceipts).values({ receiptNo: 'RCP-360-1', tenantId: t1, invoiceNo: 'INV-360-1', amount: '3000', receiptDate: '2026-01-20', createdAt: new Date() });

  const acc360 = await inj('POST', '/api/crm/accounts', sales1, { name: 'บริษัท 360 องศา จำกัด', email: 'ceo@360.example' });
  await inj('POST', `/api/crm/profile/${mem360Id}/refresh`, sales1); // compute the RFM profile (the order was db-seeded)
  await inj('POST', '/api/crm/contacts', sales1, { account_no: acc360.json.account_no, name: 'ผู้ซื้อ 360', email: 'buyer@360.example', role: 'decision_maker', member_id: mem360Id });
  const deal360 = await inj('POST', '/api/crm/pipeline/opportunities', sales1, { name: 'ดีล 360', amount: 120000, probability: 40, account_no: acc360.json.account_no });
  const [oppRow360] = await db.select({ id: s.crmOpportunities.id }).from(s.crmOpportunities).where(eq(s.crmOpportunities.oppNo, deal360.json.opp_no)).limit(1);
  await inj('POST', '/api/cpq/quotes', sales1, { customer_name: 'บริษัท 360', opportunity_id: Number(oppRow360!.id), lines: [{ description: 'Implementation', qty: 1, unit_price: 120000 }] });

  const c360 = await inj('GET', `/api/crm/customer-360/${acc360.json.account_no}`, sales1);
  ok('Customer 360: account joined to the money — AR open balance + overdue + credit limit (company position)',
    c360.status === 200 && near(c360.json.finance?.open_balance, 7000) && near(c360.json.finance?.overdue, 7000)
      && near(c360.json.finance?.credit_limit, 50000) && c360.json.finance?.serious_overdue === true && c360.json.finance?.company_level === true,
    JSON.stringify(c360.json.finance && { bal: c360.json.finance.open_balance, overdue: c360.json.finance.overdue, limit: c360.json.finance.credit_limit }));
  ok('Customer 360: last payment folded in from the statement (RCP-360-1 / ฿3,000)',
    c360.json.finance?.last_payments?.[0]?.ref === 'RCP-360-1' && near(c360.json.finance?.last_payments?.[0]?.amount, 3000),
    JSON.stringify(c360.json.finance?.last_payments));
  ok('Customer 360: open deal value + probability-weighted forecast',
    c360.json.deals?.open_count >= 1 && near(c360.json.deals?.open_value, 120000) && near(c360.json.deals?.weighted_value, 48000),
    JSON.stringify(c360.json.deals && { open: c360.json.deals.open_count, val: c360.json.deals.open_value, wt: c360.json.deals.weighted_value }));
  ok('Customer 360: the account\'s CPQ quote joined (via crm_opportunity_id)',
    Array.isArray(c360.json.quotes) && c360.json.quotes.some((q: any) => near(q.total, 120000)),
    JSON.stringify(c360.json.quotes));
  ok('Customer 360: loyalty joined through the member-linked contact (RFM + tier + points)',
    c360.json.loyalty?.member?.id === mem360Id && c360.json.loyalty?.member?.tier === 'Gold'
      && c360.json.loyalty?.crm?.rfm_segment === 'New' && c360.json.loyalty?.recent_orders?.length === 1,
    JSON.stringify(c360.json.loyalty && { id: c360.json.loyalty.member?.id, seg: c360.json.loyalty.crm?.rfm_segment }));

  // RLS: a T-scoped manager on ANOTHER account cannot read the 360 for an account they don't own's tenant
  const c360Missing = await inj('GET', '/api/crm/customer-360/ACC-DOES-NOT-EXIST', sales1);
  ok('Customer 360: unknown account → 404 ACCOUNT_NOT_FOUND', c360Missing.status === 404 && c360Missing.json.error?.code === 'ACCOUNT_NOT_FOUND', `${c360Missing.status} ${c360Missing.json.error?.code}`);

  // ── CRM-5 — analytics that answer "why" (funnel/velocity, source ROI, forecast, date-bounded win/loss) ──

  // Seed a clean lead→qualify→convert→won path with a KNOWN source so the funnel + source-ROI have signal.
  const seedLead = await inj('POST', '/api/crm/pipeline/leads', sales1, { name: 'Funnel Lead', company: 'Funnel Co', email: 'funnel@lead.example', source: 'webinar' });
  const seedLeadNo = seedLead.json.lead_no;
  await inj('POST', `/api/crm/pipeline/leads/${seedLeadNo}/qualify`, sales1);
  const conv = await inj('POST', `/api/crm/pipeline/leads/${seedLeadNo}/convert`, sales1, { opportunity_name: 'Funnel Deal', amount: 300000 });
  const convOppNo = conv.json.opp_no;
  // Walk it through stages (writes crm_stage_history rows for velocity) then win it.
  await inj('PATCH', `/api/crm/pipeline/opportunities/${convOppNo}/stage`, sales1, { stage: 'qualification' });
  await inj('PATCH', `/api/crm/pipeline/opportunities/${convOppNo}/stage`, sales1, { stage: 'proposal' });
  await inj('PATCH', `/api/crm/pipeline/opportunities/${convOppNo}/stage`, sales1, { stage: 'won', win_reason: 'best fit' });

  // 31. Funnel conversion: lead → qualified → opportunity → won, with end-to-end conversion %.
  const funnel = await inj('GET', '/api/crm/pipeline/analytics/funnel', sales1);
  const fStages = (funnel.json.funnel ?? []).map((s: any) => s.stage);
  const wonRow = funnel.json.funnel?.find((s: any) => s.stage === 'won');
  ok('Funnel: 4-stage lead→qualified→opportunities→won with won count ≥ 1',
    funnel.status === 200 && fStages.join(',') === 'leads,qualified,opportunities,won' && Number(wonRow?.count) >= 1 && funnel.json.overall_conversion_pct > 0,
    JSON.stringify({ funnel: funnel.json.funnel, conv: funnel.json.overall_conversion_pct }));

  // 32. Velocity / stage-duration derived from crm_stage_history (progression + avg days in stage present).
  ok('Velocity: stage_progression + time-in-stage from crm_stage_history',
    Array.isArray(funnel.json.stage_progression) && funnel.json.stage_progression.length >= 1
      && Array.isArray(funnel.json.velocity)
      && funnel.json.stage_progression.some((p: any) => p.stage === 'qualification' && p.opportunities_reached >= 1)
      && 'avg_sales_cycle_days' in funnel.json,
    JSON.stringify({ progression: funnel.json.stage_progression, velocity: funnel.json.velocity }));

  // 33. Source ROI: lead source → won revenue. The 'webinar' source carries the 300000 won deal.
  const roi = await inj('GET', '/api/crm/pipeline/analytics/source-roi', sales1);
  const webinar = roi.json.sources?.find((s: any) => s.source === 'webinar');
  ok('Source ROI: webinar source → won revenue 300000, win_rate 100%',
    roi.status === 200 && webinar && near(webinar.won_amount, 300000) && webinar.won === 1 && webinar.win_rate_pct === 100,
    JSON.stringify({ webinar, total_won: roi.json.total_won }));

  // 34. Forecast categories (commit/best-case/pipeline) + quota attainment + activity leaderboard shapes.
  const fcast = await inj('GET', '/api/crm/pipeline/analytics/forecast', sales1);
  ok('Forecast: commit/best-case/pipeline buckets + weighted forecast_amount + quota_attainment array',
    fcast.status === 200 && fcast.json.categories?.commit && fcast.json.categories?.best_case && fcast.json.categories?.pipeline
      && typeof fcast.json.forecast_amount === 'number'
      && Array.isArray(fcast.json.quota_attainment) && fcast.json.quota_attainment.some((q: any) => q.owner === 'sales1' && q.won_amount > 0)
      && Array.isArray(fcast.json.activity_leaderboard),
    JSON.stringify({ categories: fcast.json.categories, quota: fcast.json.quota_attainment }));

  // 35. Win/loss is now date-bounded server-side: window_months echoed; a tiny window still returns a summary.
  const wl = await inj('GET', '/api/crm/pipeline/win-loss?months=1', sales1);
  ok('Win/loss date-bounded (months window echoed, summary present)',
    wl.status === 200 && wl.json.window_months === 1 && !!wl.json.summary && Array.isArray(wl.json.by_owner),
    JSON.stringify({ window: wl.json.window_months, has_summary: !!wl.json.summary }));

  // 36. The 3 CRM-5 report types are registered in the BI registry (scheduler picker).
  const rtypes = await inj('GET', '/api/bi/report-types', admin);
  const keys = (rtypes.json.report_types ?? []).map((r: any) => r.key);
  ok('BI registry exposes crm_funnel + crm_source_roi + crm_forecast report types',
    rtypes.status === 200 && ['crm_funnel', 'crm_source_roi', 'crm_forecast'].every((k) => keys.includes(k)),
    JSON.stringify(keys.filter((k: string) => k.startsWith('crm_'))));

  // ── CRM-7 — B2B Account/Contact 360 depth (migration 0365, control CRM-07) ──────────────────────
  // Seed active item categories for the whitespace/plan-target validation (tenant T1).
  await db.insert(s.itemCategories).values([
    { tenantId: t1, code: 'SOFTWARE', name: 'Software', active: true },
    { tenantId: t1, code: 'HARDWARE', name: 'Hardware', active: true },
    { tenantId: t1, code: 'SERVICES', name: 'Services', active: true },
  ]).onConflictDoNothing();

  // 37. Account hierarchy: parent link, cycle guard, subtree pipeline rollup.
  const parentAcc = await inj('POST', '/api/crm/accounts', sales1, { name: 'Globex Holdings', tax_id: '0105561000777' });
  const childAcc = await inj('POST', '/api/crm/accounts', sales1, { name: 'Globex Subsidiary', tax_id: '0105561000778' });
  const setPar = await inj('PATCH', `/api/crm/accounts/${childAcc.json.account_no}/parent`, sales1, { parent_account_no: parentAcc.json.account_no });
  ok('CRM-7 hierarchy: set parent account → child linked', setPar.status === 200 && setPar.json.parent_account_no === parentAcc.json.account_no, JSON.stringify(setPar.json));
  const cycle = await inj('PATCH', `/api/crm/accounts/${parentAcc.json.account_no}/parent`, sales1, { parent_account_no: childAcc.json.account_no });
  ok('CRM-7 hierarchy: parenting a company under its own child → 400 HIERARCHY_CYCLE', cycle.status === 400 && cycle.json.error?.code === 'HIERARCHY_CYCLE', `${cycle.status} ${cycle.json.error?.code}`);
  await inj('POST', '/api/crm/pipeline/opportunities', sales1, { name: 'Child Deal', amount: 100000, account_no: childAcc.json.account_no });
  const hier = await inj('GET', `/api/crm/accounts/${parentAcc.json.account_no}/hierarchy`, sales1);
  ok('CRM-7 hierarchy: read exposes 1 child + rolls the child deal into subtree_open_weighted', hier.status === 200 && hier.json.children?.length === 1 && hier.json.subtree_open_weighted > 0, JSON.stringify({ children: hier.json.children?.length, weighted: hier.json.subtree_open_weighted }));

  // 38. Buying committee: contact must belong to the deal's account; unique per deal; single primary.
  const bcContact = await inj('POST', '/api/crm/contacts', sales1, { account_no: parentAcc.json.account_no, name: 'ผู้ตัดสินใจ Globex', email: 'dm@globex.example', role: 'decision_maker' });
  const bcOpp = await inj('POST', '/api/crm/pipeline/opportunities', sales1, { name: 'Globex Deal', amount: 250000, account_no: parentAcc.json.account_no });
  const addBc = await inj('POST', `/api/crm/opportunities/${bcOpp.json.opp_no}/committee`, sales1, { contact_id: bcContact.json.id, role: 'decision_maker', influence: 'high', is_primary: true });
  ok('CRM-7 committee: add member → 201, is_primary + role', addBc.status === 201 && addBc.json.is_primary === true && addBc.json.role === 'decision_maker', JSON.stringify(addBc.json));
  const dupBc = await inj('POST', `/api/crm/opportunities/${bcOpp.json.opp_no}/committee`, sales1, { contact_id: bcContact.json.id });
  ok('CRM-7 committee: re-add the same contact → 409 COMMITTEE_DUP', dupBc.status === 409 && dupBc.json.error?.code === 'COMMITTEE_DUP', `${dupBc.status} ${dupBc.json.error?.code}`);
  const otherContact = await inj('POST', '/api/crm/contacts', sales1, { account_no: childAcc.json.account_no, name: 'Outsider', email: 'out@globex-sub.example' });
  const mismatchBc = await inj('POST', `/api/crm/opportunities/${bcOpp.json.opp_no}/committee`, sales1, { contact_id: otherContact.json.id });
  ok('CRM-7 committee: contact from another account → 400 CONTACT_ACCOUNT_MISMATCH', mismatchBc.status === 400 && mismatchBc.json.error?.code === 'CONTACT_ACCOUNT_MISMATCH', `${mismatchBc.status} ${mismatchBc.json.error?.code}`);
  const bcList = await inj('GET', `/api/crm/opportunities/${bcOpp.json.opp_no}/committee`, sales1);
  ok('CRM-7 committee: list → 1 member with contact_name joined', bcList.json.count === 1 && bcList.json.committee?.[0]?.contact_name != null, JSON.stringify(bcList.json));
  const rmBc = await inj('DELETE', `/api/crm/opportunities/${bcOpp.json.opp_no}/committee/${bcContact.json.id}`, sales1);
  ok('CRM-7 committee: remove member → 200 removed', rmBc.status === 200 && rmBc.json.removed === true, JSON.stringify(rmBc.json));

  // 39. Account plans: category validation + governed draft → active → closed lifecycle.
  const planCreate = await inj('POST', '/api/crm/account-plans', sales1, { account_no: parentAcc.json.account_no, period: 'FY2026', objective: 'Grow Globex', target_revenue: 1000000, target_categories: ['SOFTWARE'] });
  ok('CRM-7 plan: create → draft, APL- number, target category kept', planCreate.status === 201 && planCreate.json.status === 'draft' && /^APL-/.test(planCreate.json.plan_no) && planCreate.json.target_categories?.includes('SOFTWARE'), JSON.stringify(planCreate.json));
  const badCat = await inj('POST', '/api/crm/account-plans', sales1, { account_no: parentAcc.json.account_no, target_categories: ['NONEXIST'] });
  ok('CRM-7 plan: unknown target category → 400 UNKNOWN_CATEGORY', badCat.status === 400 && badCat.json.error?.code === 'UNKNOWN_CATEGORY', `${badCat.status} ${badCat.json.error?.code}`);
  const activate = await inj('POST', `/api/crm/account-plans/${planCreate.json.plan_no}/activate`, sales1, {});
  ok('CRM-7 plan: activate a complete draft (owner + objective) → active', activate.status === 200 && activate.json.status === 'active', JSON.stringify({ status: activate.json.status }));
  const reactivate = await inj('POST', `/api/crm/account-plans/${planCreate.json.plan_no}/activate`, sales1, {});
  ok('CRM-7 plan: re-activate an active plan → 400 PLAN_NOT_DRAFT', reactivate.status === 400 && reactivate.json.error?.code === 'PLAN_NOT_DRAFT', `${reactivate.status} ${reactivate.json.error?.code}`);
  const draft2 = await inj('POST', '/api/crm/account-plans', sales1, { account_no: childAcc.json.account_no });
  const actIncomplete = await inj('POST', `/api/crm/account-plans/${draft2.json.plan_no}/activate`, sales1, {});
  ok('CRM-7 plan: activate an incomplete draft (no objective) → 400 PLAN_INCOMPLETE', actIncomplete.status === 400 && actIncomplete.json.error?.code === 'PLAN_INCOMPLETE', `${actIncomplete.status} ${actIncomplete.json.error?.code}`);

  // 40. Whitespace: the active-plan target vs the tenant's active categories.
  const ws = await inj('GET', `/api/crm/accounts/${parentAcc.json.account_no}/whitespace`, sales1);
  const softwareRow = ws.json.categories?.find((c: any) => c.code === 'SOFTWARE');
  ok('CRM-7 whitespace: SOFTWARE targeted by the active plan; 1 targeted / 2 whitespace', ws.status === 200 && softwareRow?.targeted === true && ws.json.targeted_count === 1 && ws.json.whitespace_count === 2, JSON.stringify({ targeted: ws.json.targeted_count, whitespace: ws.json.whitespace_count }));
  const close = await inj('POST', `/api/crm/account-plans/${planCreate.json.plan_no}/close`, sales1, {});
  ok('CRM-7 plan: close an active plan → closed', close.status === 200 && close.json.status === 'closed', JSON.stringify({ status: close.json.status }));

  // 41. RLS: a plan created under HQ is invisible to the T1 sales user.
  const hqAcc = await inj('POST', '/api/crm/accounts', admin, { name: 'HQ Only Account' });
  const hqPlan = await inj('POST', '/api/crm/account-plans', admin, { account_no: hqAcc.json.account_no, objective: 'HQ plan' });
  const t1Plans = await inj('GET', '/api/crm/account-plans', sales1);
  ok('CRM-7 RLS: a T1 user sees none of HQ\'s account plans', t1Plans.status === 200 && !t1Plans.json.plans?.some((p: any) => p.plan_no === hqPlan.json.plan_no), `t1_count=${t1Plans.json.plans?.length}`);

  // ── CRM-15 — B2B account health / churn + renewal pipeline (migration 0370, control CRM-08) ──────
  // 42. Healthy account: a recent activity + an open deal → high score, 'healthy' band, explainable breakdown.
  const hAcc = await inj('POST', '/api/crm/accounts', sales1, { name: 'Healthy Health Co', tax_id: '0105561000901' });
  const hOpp = await inj('POST', '/api/crm/pipeline/opportunities', sales1, { name: 'Health Deal', amount: 200000, account_no: hAcc.json.account_no });
  await inj('POST', '/api/crm/pipeline/activities', sales1, { entity_type: 'opportunity', entity_no: hOpp.json.opp_no, type: 'call', subject: 'health check call' });
  const hHealth = await inj('GET', `/api/crm/accounts/${hAcc.json.account_no}/health`, sales1);
  ok('CRM-15 health: engaged account (recent activity + open pipeline) → healthy band, score ≥ 70', hHealth.status === 200 && hHealth.json.band === 'healthy' && hHealth.json.score >= 70, JSON.stringify({ score: hHealth.json.score, band: hHealth.json.band }));
  ok('CRM-15 health: explainable breakdown (engagement + pipeline factors)', Array.isArray(hHealth.json.breakdown) && hHealth.json.breakdown.some((b: any) => b.factor === 'engagement') && hHealth.json.breakdown.some((b: any) => b.factor === 'pipeline'), JSON.stringify(hHealth.json.breakdown?.map((b: any) => b.factor)));

  // 43. At-risk account: open escalated (P1/P2) + SLA-breached support cases, no activity, no open pipeline.
  const rAcc = await inj('POST', '/api/crm/accounts', sales1, { name: 'Churny Risk Co', tax_id: '0105561000902' });
  const [rRow] = await db.select().from(s.crmAccounts).where(eq(s.crmAccounts.accountNo, rAcc.json.account_no));
  await db.insert(s.serviceCases).values([
    { tenantId: t1, caseNo: 'CASE-R1', subject: 'system down', status: 'open', priority: 'P1', accountId: Number(rRow.id), responseBreached: true, resolutionBreached: false, createdBy: 'sales1' },
    { tenantId: t1, caseNo: 'CASE-R2', subject: 'degraded', status: 'open', priority: 'P2', accountId: Number(rRow.id), responseBreached: false, resolutionBreached: false, createdBy: 'sales1' },
  ]);
  const rHealth = await inj('GET', `/api/crm/accounts/${rAcc.json.account_no}/health`, sales1);
  ok('CRM-15 health: open escalated + SLA-breached cases, no pipeline → at_risk band', rHealth.status === 200 && rHealth.json.band === 'at_risk' && rHealth.json.signals?.escalated_cases === 2 && rHealth.json.signals?.breached_cases === 1, JSON.stringify({ score: rHealth.json.score, band: rHealth.json.band, sig: rHealth.json.signals }));

  // 44. deal_type + renewal/expansion pipeline.
  const renOpp = await inj('POST', '/api/crm/pipeline/opportunities', sales1, { name: 'Renewal Deal', amount: 150000, account_no: hAcc.json.account_no });
  const setDt = await inj('PATCH', `/api/crm/opportunities/${renOpp.json.opp_no}/deal-type`, sales1, { deal_type: 'renewal' });
  ok('CRM-15 deal-type: set an opportunity to renewal', setDt.status === 200 && setDt.json.deal_type === 'renewal', JSON.stringify(setDt.json));
  const renPipe = await inj('GET', '/api/crm/account-health/renewals', sales1);
  ok('CRM-15 renewals: the renewal pipeline lists the renewal deal + a weighted total', renPipe.status === 200 && renPipe.json.renewals?.some((o: any) => o.opp_no === renOpp.json.opp_no && o.deal_type === 'renewal') && renPipe.json.weighted > 0, JSON.stringify({ count: renPipe.json.count, weighted: renPipe.json.weighted }));

  // 45. Renewal GAP: an account with a won deal but NO open renewal is flagged a churn risk.
  const gapAcc = await inj('POST', '/api/crm/accounts', sales1, { name: 'Gap Renewal Co', tax_id: '0105561000903' });
  const gapOpp = await inj('POST', '/api/crm/pipeline/opportunities', sales1, { name: 'Gap Deal', amount: 90000, account_no: gapAcc.json.account_no });
  await inj('PATCH', `/api/crm/pipeline/opportunities/${gapOpp.json.opp_no}/stage`, sales1, { stage: 'won', win_reason: 'closed' });
  const renPipe2 = await inj('GET', '/api/crm/account-health/renewals', sales1);
  ok('CRM-15 renewal gap: a won account with no open renewal is flagged', renPipe2.json.renewal_gaps?.some((g: any) => g.account_no === gapAcc.json.account_no), `gaps=${renPipe2.json.gap_count}`);

  // 46. Portfolio churn watchlist: ranks worst-first + band counts + band filter.
  const port = await inj('GET', '/api/crm/account-health', sales1);
  ok('CRM-15 portfolio: churn watchlist ranks at_risk first + band counts', port.status === 200 && (port.json.accounts?.length ?? 0) > 0 && port.json.accounts[0].band === 'at_risk' && port.json.band_counts?.at_risk >= 1, JSON.stringify({ first: port.json.accounts?.[0]?.band, counts: port.json.band_counts }));
  const portFilter = await inj('GET', '/api/crm/account-health?band=at_risk', sales1);
  ok('CRM-15 portfolio: band filter → only at_risk accounts', (portFilter.json.accounts ?? []).every((a: any) => a.band === 'at_risk') && portFilter.json.count >= 1, `count=${portFilter.json.count}`);

  // 47. Snapshot (BI-schedulable) + trend history, idempotent per (account, day).
  const snap = await inj('POST', '/api/crm/account-health/snapshot', sales1, {});
  ok('CRM-15 snapshot: captures a health snapshot for every account', snap.status === 200 && snap.json.captured >= 1 && snap.json.captured === snap.json.scanned, JSON.stringify(snap.json));
  await inj('POST', '/api/crm/account-health/snapshot', sales1, {}); // re-run same day → upsert, not dup
  const rHist = await inj('GET', `/api/crm/accounts/${rAcc.json.account_no}/health/history`, sales1);
  ok('CRM-15 history: one dated snapshot (idempotent), band=at_risk', rHist.status === 200 && rHist.json.history?.length === 1 && rHist.json.history[0].band === 'at_risk', JSON.stringify(rHist.json));

  // 48. BI registry exposes the crm_account_health snapshot report type.
  const rtypes2 = await inj('GET', '/api/bi/report-types', admin);
  ok('CRM-15 BI: registry exposes crm_account_health report type', (rtypes2.json.report_types ?? []).some((r: any) => r.key === 'crm_account_health'), 'crm_account_health');

  // 49. RLS: a T1 user cannot read an HQ account's health.
  const hqhAcc = await inj('POST', '/api/crm/accounts', admin, { name: 'HQ Health Only' });
  await inj('POST', '/api/crm/account-health/snapshot', admin, {});
  const t1See = await inj('GET', `/api/crm/accounts/${hqhAcc.json.account_no}/health/history`, sales1);
  ok('CRM-15 RLS: a T1 user cannot read an HQ account\'s health (404)', t1See.status === 404 && t1See.json.error?.code === 'ACCOUNT_NOT_FOUND', `${t1See.status} ${t1See.json.error?.code}`);

  // ── CRM-12 — sales forecasting depth (migration 0378, control CRM-09) ────────────────────────────
  // 50. Rep→manager override: a rep submits a governed forecast (draft→submitted) for a named owner, and the
  //     manager roll-up reconciles it against the system-weighted forecast (commit at full value) + variance.
  const fcAcc = await inj('POST', '/api/crm/accounts', sales1, { name: 'Forecast Co', tax_id: '0105561000904' });
  await inj('POST', '/api/crm/pipeline/opportunities', sales1, { name: 'Commit Deal', amount: 500000, probability: 80, owner: 'fc_rep', account_no: fcAcc.json.account_no });
  const fcSub = await inj('POST', '/api/crm/forecast/submission', sales1, { owner: 'fc_rep', commit_amount: 400000, best_case_amount: 50000, status: 'submitted' });
  ok('CRM-12 submission: a rep submits a governed forecast override (draft→submitted)', [200, 201].includes(fcSub.status) && fcSub.json.status === 'submitted' && fcSub.json.owner === 'fc_rep', JSON.stringify(fcSub.json));

  const fcDepth = await inj('GET', '/api/crm/forecast/depth', sales1);
  const fcRow = (fcDepth.json.rollup ?? []).find((r: any) => r.owner === 'fc_rep');
  ok('CRM-12 roll-up: system-weighted vs submitted forecast with variance', fcDepth.status === 200 && !!fcRow && fcRow.system.commit >= 500000 && fcRow.submitted?.commit === 400000 && fcRow.variance !== null, JSON.stringify(fcRow && { sys: fcRow.system.forecast, sub: fcRow.submitted?.forecast, variance: fcRow.variance }));

  // 51. Pipeline coverage: open pipeline ÷ commit target ratio is computed.
  ok('CRM-12 coverage: open pipeline ÷ commit target ratio computed', !!fcDepth.json.coverage && fcDepth.json.coverage.ratio !== null && fcDepth.json.coverage.open_pipeline > 0, JSON.stringify(fcDepth.json.coverage));

  // 52. Category waterfall: commit → best-case → pipeline builds up to the system forecast total.
  const wf = fcDepth.json.waterfall ?? [];
  const wfLast = wf[wf.length - 1];
  ok('CRM-12 waterfall: commit→best-case→pipeline builds to the system forecast', wf.length === 3 && Math.abs((wfLast?.running ?? 0) - fcDepth.json.totals.system_forecast) < 0.02, JSON.stringify(wf.map((w: any) => `${w.stage}:${w.running}`)));

  // 53. Snapshot (BI-schedulable) captures the forecast + the period's actual won (a won deal exists this period).
  const fcSnap = await inj('POST', '/api/crm/forecast/snapshot', sales1, {});
  ok('CRM-12 snapshot: captures a dated forecast + the period actual-won', fcSnap.status === 200 && fcSnap.json.forecast > 0 && fcSnap.json.actual_won >= 90000, JSON.stringify(fcSnap.json));

  // 54. Forecast-vs-actual accuracy trend, idempotent per (period, day).
  await inj('POST', '/api/crm/forecast/snapshot', sales1, {}); // re-run same day → upsert, not dup
  const fcHist = await inj('GET', '/api/crm/forecast/history', sales1);
  const fcPeriodRows = (fcHist.json.accuracy ?? []).filter((a: any) => a.period === fcSnap.json.period);
  ok('CRM-12 forecast-vs-actual: one snapshot per period (idempotent) + accuracy %', fcHist.status === 200 && fcPeriodRows.length === 1 && fcPeriodRows[0].actual_won >= 90000 && fcPeriodRows[0].accuracy_pct !== null, JSON.stringify(fcPeriodRows[0]));

  // 55. BI registry exposes the crm_forecast_snapshot report type.
  const rtypes3 = await inj('GET', '/api/bi/report-types', admin);
  ok('CRM-12 BI: registry exposes crm_forecast_snapshot report type', (rtypes3.json.report_types ?? []).some((r: any) => r.key === 'crm_forecast_snapshot'), 'crm_forecast_snapshot');

  // 56. RLS: a T1 user cannot see an HQ tenant's forecast submissions.
  await inj('POST', '/api/crm/forecast/submission', admin, { owner: 'hq_rep', commit_amount: 999999, status: 'submitted' });
  const t1subs = await inj('GET', '/api/crm/forecast/submissions', sales1);
  ok('CRM-12 RLS: a T1 user cannot see HQ forecast submissions', t1subs.status === 200 && !(t1subs.json.submissions ?? []).some((x: any) => x.owner === 'hq_rep'), `owners=${(t1subs.json.submissions ?? []).map((x: any) => x.owner).join(',')}`);

  // ── CRM-11 — persisted territory & quota management (migration 0385, control CRM-10) ─────────────
  // 57. Create a territory hierarchy (parent + child) + assign a rep to the child.
  const terrN = await inj('POST', '/api/crm/territory/territories', sales1, { name: 'North Region', manager: 'mgr_n' });
  const terrNE = await inj('POST', '/api/crm/territory/territories', sales1, { name: 'Northeast', parent_code: terrN.json.code, manager: 'mgr_ne' });
  ok('CRM-11 territory: create a parent + child territory (hierarchy)', [200, 201].includes(terrN.status) && [200, 201].includes(terrNE.status) && !!terrN.json.code && !!terrNE.json.code, JSON.stringify({ parent: terrN.json.code, child: terrNE.json.code }));
  const addM = await inj('POST', `/api/crm/territory/territories/${terrNE.json.code}/members`, sales1, { owner: 'terr_rep', role: 'rep' });
  ok('CRM-11 territory: assign a rep to the child territory', [200, 201].includes(addM.status) && addM.json.owner === 'terr_rep', JSON.stringify(addM.json));

  // 58. A won deal for the rep in the current period + owner & territory quotas → attainment roll-up.
  const twAcc = await inj('POST', '/api/crm/accounts', sales1, { name: 'Territory Deal Co', tax_id: '0105561000905' });
  const twOpp = await inj('POST', '/api/crm/pipeline/opportunities', sales1, { name: 'Terr Deal', amount: 300000, owner: 'terr_rep', account_no: twAcc.json.account_no });
  await inj('PATCH', `/api/crm/pipeline/opportunities/${twOpp.json.opp_no}/stage`, sales1, { stage: 'won', win_reason: 'closed' });
  await inj('POST', '/api/crm/territory/quotas', sales1, { scope: 'owner', subject: 'terr_rep', target_amount: 600000 });
  await inj('POST', '/api/crm/territory/quotas', sales1, { scope: 'territory', subject: terrN.json.code, target_amount: 1000000 });
  const att = await inj('GET', '/api/crm/territory/attainment', sales1);
  const ownerRow = (att.json.owners ?? []).find((o: any) => o.owner === 'terr_rep');
  ok('CRM-11 attainment: rep won-in-period vs a persisted owner quota', att.status === 200 && !!ownerRow && ownerRow.won_amount >= 300000 && ownerRow.quota === 600000 && ownerRow.attainment_pct !== null, JSON.stringify(ownerRow));

  // 59. Territory subtree roll-up: parent North's subtree includes the child NE member's won.
  const parentRow = (att.json.territories ?? []).find((tr: any) => tr.code === terrN.json.code);
  ok('CRM-11 roll-up: parent territory subtree_won includes the child member\'s won + territory quota', !!parentRow && parentRow.subtree_won >= 300000 && parentRow.quota === 1000000 && parentRow.attainment_pct !== null, JSON.stringify(parentRow));

  // 60. Territory read exposes members.
  const terrGet = await inj('GET', `/api/crm/territory/territories/${terrNE.json.code}`, sales1);
  ok('CRM-11 territory read: members listed on the territory', terrGet.status === 200 && (terrGet.json.members ?? []).some((m: any) => m.owner === 'terr_rep'), JSON.stringify({ members: (terrGet.json.members ?? []).map((m: any) => m.owner) }));

  // 61. RLS: a T1 user cannot see an HQ tenant's territory (per-tenant codes collide, so assert via the
  //     tenant-scoped list rather than a code lookup).
  await inj('POST', '/api/crm/territory/territories', admin, { name: 'HQ Only Region' });
  const t1list = await inj('GET', '/api/crm/territory/territories', sales1);
  ok('CRM-11 RLS: a T1 user cannot see an HQ tenant\'s territory', t1list.status === 200 && !(t1list.json.territories ?? []).some((tr: any) => tr.name === 'HQ Only Region'), `names=${(t1list.json.territories ?? []).map((tr: any) => tr.name).join('|')}`);

  // ── CRM-8 — sales sequences / cadences (migration 0392, control CRM-11) ──────────────────────────
  // 62. Create a 2-step sequence (email now + a follow-up task after 3 days).
  const seq = await inj('POST', '/api/crm/sequences', sales1, { name: 'New-lead nurture', steps: [{ channel: 'email', wait_days: 0, subject: 'Welcome', body: 'Hi {{name}}' }, { channel: 'task', wait_days: 3, subject: 'Call the lead' }] });
  ok('CRM-8 sequence: create a 2-step cadence', [200, 201].includes(seq.status) && !!seq.json.code && seq.json.steps === 2, JSON.stringify(seq.json));

  // 63. Enroll a lead (with an email) → active, first step due now (wait_days 0).
  const seqLead = await inj('POST', '/api/crm/pipeline/leads', sales1, { name: 'Cadence Lead', email: 'cadence@example.com', company: 'Cadence Co' });
  const enrol = await inj('POST', `/api/crm/sequences/${seq.json.code}/enroll`, sales1, { entity_type: 'lead', entity_no: seqLead.json.lead_no });
  ok('CRM-8 enroll: a lead is enrolled and active with a due date', [200, 201].includes(enrol.status) && enrol.json.status === 'active' && !!enrol.json.id && !!enrol.json.next_due_at, JSON.stringify({ id: enrol.json.id, status: enrol.json.status }));

  // 64. Advance step 1 (email) → sent/logged, enrolment stays active (step 2 remains).
  const adv1 = await inj('POST', `/api/crm/sequences/enrollments/${enrol.json.id}/advance`, sales1, {});
  ok('CRM-8 advance: step 1 email executed, enrolment still active', [200, 201].includes(adv1.status) && adv1.json.step_no === 1 && adv1.json.channel === 'email' && adv1.json.status === 'active', JSON.stringify(adv1.json));
  // The touch is logged as an auditable activity on the lead's timeline.
  const [actRow] = await db.select().from(s.crmActivities).where(and(eq(s.crmActivities.entityNo, seqLead.json.lead_no), eq(s.crmActivities.source, 'sequence')));
  ok('CRM-8 advance: the step is logged as a sequence activity', !!actRow && actRow.type === 'email', JSON.stringify({ type: actRow?.type, source: actRow?.source }));

  // 65. Advance step 2 (the last step) → enrolment completes.
  const adv2 = await inj('POST', `/api/crm/sequences/enrollments/${enrol.json.id}/advance`, sales1, {});
  ok('CRM-8 advance: the last step completes the enrolment', [200, 201].includes(adv2.status) && adv2.json.step_no === 2 && adv2.json.status === 'completed', JSON.stringify(adv2.json));
  // Advancing a completed enrolment is rejected.
  const advDone = await inj('POST', `/api/crm/sequences/enrollments/${enrol.json.id}/advance`, sales1, {});
  ok('CRM-8 advance: a completed enrolment cannot advance', advDone.status === 400 && advDone.json.error?.code === 'ENROLLMENT_NOT_ACTIVE', `${advDone.status} ${advDone.json.error?.code}`);

  // 66. The schedulable due-runner (BI job) advances due enrolments; a fresh enrolment (step1 due now) is advanced.
  const seqLead2 = await inj('POST', '/api/crm/pipeline/leads', sales1, { name: 'Cadence Lead 2', email: 'cadence2@example.com' });
  await inj('POST', `/api/crm/sequences/${seq.json.code}/enroll`, sales1, { entity_type: 'lead', entity_no: seqLead2.json.lead_no });
  const run = await inj('POST', '/api/crm/sequences/run-due', sales1, {});
  ok('CRM-8 due-runner: advances due enrolments (schedulable as crm_sequence_run)', run.status === 200 && run.json.advanced >= 1 && run.json.scanned >= 1, JSON.stringify({ scanned: run.json.scanned, advanced: run.json.advanced }));

  // 67. Stop an enrolment.
  const seqLead3 = await inj('POST', '/api/crm/pipeline/leads', sales1, { name: 'Cadence Lead 3', email: 'cadence3@example.com' });
  const enrol3 = await inj('POST', `/api/crm/sequences/${seq.json.code}/enroll`, sales1, { entity_type: 'lead', entity_no: seqLead3.json.lead_no });
  const stopped = await inj('POST', `/api/crm/sequences/enrollments/${enrol3.json.id}/stop`, sales1, {});
  ok('CRM-8 stop: an enrolment can be stopped', [200, 201].includes(stopped.status) && stopped.json.status === 'stopped', JSON.stringify(stopped.json));

  // 68. BI registry exposes the crm_sequence_run report type.
  const rtypesSeq = await inj('GET', '/api/bi/report-types', admin);
  ok('CRM-8 BI: registry exposes crm_sequence_run report type', (rtypesSeq.json.report_types ?? []).some((r: any) => r.key === 'crm_sequence_run'), 'crm_sequence_run');

  // 69. RLS: a T1 user cannot see an HQ tenant's sequence.
  await inj('POST', '/api/crm/sequences', admin, { name: 'HQ Only Cadence', steps: [{ channel: 'email', body: 'x' }] });
  const t1seqs = await inj('GET', '/api/crm/sequences', sales1);
  ok('CRM-8 RLS: a T1 user cannot see an HQ tenant\'s sequence', t1seqs.status === 200 && !(t1seqs.json.sequences ?? []).some((x: any) => x.name === 'HQ Only Cadence'), `names=${(t1seqs.json.sequences ?? []).map((x: any) => x.name).join('|')}`);

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
