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
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ maxParamLength: 500 }));
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
  const [admin, sales1] = [await login('admin', 'admin123'), await login('sales1', 'pw1')];

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
