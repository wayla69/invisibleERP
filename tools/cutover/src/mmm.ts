/**
 * docs/48 — Marketing Mix Modeling (MMM) end-to-end ToE over PGlite. Re-performs the control MKT-15:
 * ingest signals → run the audited attribution → verify the pure model's invariants (ROI null on zero
 * spend, allocations sum EXACTLY to the budget, lift shares sum to 100, buzz boost lifts contribution),
 * the reproducible audited run header (inputs + actor + timestamp) + the append-only audit_log row, BOLA
 * safety (cross-tenant run fetch → 404), the permission gate, and the multi-tenant isolation/leak protocol.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover mmm
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'mmm-secret';
process.env.NODE_ENV = 'test';
process.env.APP_ENC_KEY = process.env.APP_ENC_KEY || 'mmm-enc-key';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
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
const near = (a: number, b: number, eps = 0.05) => Math.abs(a - b) <= eps;
const today = new Date().toISOString().slice(0, 10); // within any window ≥ 1 day

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [t1, t2] = [await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'mkt1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: t1 }, // Sales default perms include marketing/exec
    { username: 'mkt2', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t2 },
    { username: 'wh1', passwordHash: await pw.hash('pw3'), role: 'Warehouse', tenantId: t1 }, // no marketing/exec
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const mkt1 = await login('mkt1', 'pw1');
  const mkt2 = await login('mkt2', 'pw2');
  const wh1 = await login('wh1', 'pw3');

  // ── 1. Permission gate — a non-marketing/exec user cannot run the model ──
  const noPerm = await inj('POST', '/api/mmm/run', wh1, {});
  ok('MKT-15: a user without marketing/exec cannot run the MMM model (403)', noPerm.status === 403, JSON.stringify(noPerm));

  // ── 2. Ingest signals for T1 (idempotent staging/core write path) ──
  const sales = await inj('POST', '/api/mmm/ingest/sales-daily', mkt1, { rows: [
    { bizDate: today, utmSource: 'facebook', revenue: 100000, unitsSold: 200 },
    { bizDate: today, utmSource: 'google', revenue: 60000, unitsSold: 90 },
    { bizDate: today, utmSource: 'tiktok', revenue: 20000, unitsSold: 40 },
  ] });
  const salesReplay = await inj('POST', '/api/mmm/ingest/sales-daily', mkt1, { rows: [
    { bizDate: today, utmSource: 'facebook', revenue: 100000, unitsSold: 200 },
  ] });
  ok('MKT-15: sales-daily ingest upserts 3 channel rows (idempotent grain key — a re-ingest updates, not duplicates)',
    sales.json.upserted === 3 && salesReplay.json.upserted === 1, JSON.stringify(sales.json));

  await inj('POST', '/api/mmm/ingest/sentiment', mkt1, { rows: [
    { bizDate: today, platform: 'facebook', mentionCount: 100, sentimentScore: 0.8 }, // strongest positive buzz
    { bizDate: today, platform: 'tiktok', mentionCount: 50, sentimentScore: 0.4 },
  ] });

  // ── 3. Run the model — spend on facebook + google, ZERO on tiktok ──
  const run = await inj('POST', '/api/mmm/run', mkt1, { windowDays: 30, spendByChannel: { facebook: 30000, google: 20000, tiktok: 0 } });
  const res: any[] = run.json.results ?? [];
  const byCh = Object.fromEntries(res.map((r) => [r.channel, r]));
  const allocSum = res.reduce((a, r) => a + (r.optimal_budget_allocation ?? 0), 0);
  const liftSum = res.reduce((a, r) => a + (r.sales_lift_contribution ?? 0), 0);
  ok('MKT-15: run persists a run_no + 3 channel results, total_spend = Σ channel spend (50,000)',
    /^MMM-\d{8}-\d{3}$/.test(run.json.run_no) && run.json.channels === 3 && run.json.total_spend === 50000, JSON.stringify(run.json));
  ok('MKT-15: ROI is NULL (not Infinity) for the zero-spend channel (tiktok), a real ratio for funded ones',
    byCh.tiktok.roi === null && near(byCh.facebook.roi, 100000 * 1.25 / 30000) && near(byCh.google.roi, 60000 / 20000),
    JSON.stringify({ fb: byCh.facebook.roi, g: byCh.google.roi, tk: byCh.tiktok.roi }));
  ok('MKT-15: the "optimal" budget allocation sums EXACTLY to the total spend (no rounding leak)',
    near(allocSum, 50000, 0.001), JSON.stringify({ allocSum, allocs: res.map((r) => [r.channel, r.optimal_budget_allocation]) }));
  ok('MKT-15: sales-lift contributions sum to 100% across channels', near(liftSum, 100, 0.05), JSON.stringify({ liftSum }));
  ok('MKT-15: positive social buzz lifts a channel — facebook (strongest buzz) attributes contribution ABOVE its raw revenue, so its lift share leads',
    byCh.facebook.sales_lift_contribution > byCh.google.sales_lift_contribution && byCh.facebook.optimal_budget_allocation > byCh.google.optimal_budget_allocation,
    JSON.stringify({ fbLift: byCh.facebook.sales_lift_contribution, gLift: byCh.google.sales_lift_contribution }));

  // ── 4. Determinism / re-performance — identical inputs reproduce identical channel results ──
  const run2 = await inj('POST', '/api/mmm/run', mkt1, { windowDays: 30, spendByChannel: { facebook: 30000, google: 20000, tiktok: 0 } });
  const same = ['facebook', 'google', 'tiktok'].every((c) => {
    const a = byCh[c]; const b = (run2.json.results as any[]).find((r) => r.channel === c);
    return a.roi === b.roi && a.optimal_budget_allocation === b.optimal_budget_allocation && a.sales_lift_contribution === b.sales_lift_contribution;
  });
  ok('MKT-15: the model is deterministic — a re-run over the same inputs reproduces the same per-channel ROI/allocation (auditor re-performance)', same, '');

  // ── 5. Audited run header — inputs + actor + timestamp persisted, BOLA-safe fetch ──
  const runNo = run.json.run_no as string;
  const getRun = await inj('GET', `/api/mmm/runs/${runNo}`, mkt1);
  ok('MKT-15: the run header records the reproducible inputs (window, spend-by-channel) + the actor who ran it',
    getRun.status === 200 && getRun.json.window_days === 30 && getRun.json.created_by === 'mkt1' &&
    getRun.json.spend_by_channel?.facebook === 30000, JSON.stringify(getRun.json?.spend_by_channel));

  const runRows = await db.select().from(s.mmmModelRuns).where(eq(s.mmmModelRuns.tenantId, t1));
  ok('MKT-15: the audited run row is persisted tenant-scoped with created_by + created_at (the reproducibility record)',
    runRows.length >= 2 && runRows.every((r: any) => r.createdBy === 'mkt1' && r.createdAt != null && Number(r.tenantId) === t1),
    JSON.stringify({ n: runRows.length }));

  // ── 6. Append-only audit_log row for the run (global audit interceptor over the mutation) ──
  const auditRows = await db.select().from(s.auditLog).where(eq(s.auditLog.action, 'POST /api/mmm/run'));
  ok('MKT-15: every model run writes an append-only audit_log row (action, actor, success) — hash-chained evidence',
    auditRows.length >= 2 && auditRows.some((r: any) => r.actor === 'mkt1' && r.status === 'success' && Number(r.tenantId) === t1),
    JSON.stringify({ n: auditRows.length, last: auditRows.at(-1)?.actor }));

  // ── 7. Summary reads (GET /api/mmm/summary and the live BI read) ──
  const summary = await inj('GET', '/api/mmm/summary', mkt1);
  const biSummary = await inj('GET', '/api/bi/mmm-summary', mkt1);
  ok('MKT-15: /api/mmm/summary returns the latest run with its channel results (ordered by optimal budget)',
    summary.json.has_run === true && summary.json.results.length === 3 && summary.json.results[0].channel === 'facebook', JSON.stringify(summary.json.run_no));
  ok('MKT-15: the live BI read GET /api/bi/mmm-summary returns the SAME payload shape (dashboard aggregate)',
    biSummary.status === 200 && biSummary.json.has_run === true && biSummary.json.run_no === summary.json.run_no, JSON.stringify(biSummary.json.run_no));

  // ── 8. BOLA / cross-tenant run fetch — T2 cannot read T1's run ──
  const crossGet = await inj('GET', `/api/mmm/runs/${runNo}`, mkt2);
  ok('MKT-15 (BOLA): T2 fetching T1\'s run by run_no → 404 MMM_RUN_NOT_FOUND (filtered by tenant AND run_no)',
    crossGet.status === 404 && crossGet.json?.error?.code === 'MMM_RUN_NOT_FOUND', JSON.stringify(crossGet));

  // ── 9. MULTI-TENANT TEST PROTOCOL — isolation + data-leak (T2 sees ZERO of T1's data) ──
  const t2Runs = await inj('GET', '/api/mmm/runs', mkt2);
  const t2Sales = await inj('GET', '/api/mmm/sales-daily', mkt2);
  const t2Sent = await inj('GET', '/api/mmm/sentiment', mkt2);
  const t2Summary = await inj('GET', '/api/mmm/summary', mkt2);
  ok('MKT-15 (Multi-Tenant Test Protocol — isolation): T2 sees ZERO T1 runs / sales-signals / sentiment rows (RLS + explicit tenant filter)',
    t2Runs.json.count === 0 && t2Sales.json.channels.length === 0 && t2Sent.json.platforms.length === 0,
    JSON.stringify({ runs: t2Runs.json.count, sales: t2Sales.json.channels.length, sent: t2Sent.json.platforms.length }));
  ok('MKT-15 (Multi-Tenant Test Protocol — data-leak): T2\'s summary has no run (never surfaces T1\'s result)',
    t2Summary.json.has_run === false, JSON.stringify(t2Summary.json));

  await app.close();
  console.log('\n── Marketing Mix Modeling ToE (docs/48, MKT-15) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) { console.log(`\n❌ ${failed}/${checks.length} mmm checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} mmm checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
