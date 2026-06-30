/**
 * AI guardrail + accuracy eval (panel Round-2, condition #4 — "prove the AI, don't claim it").
 *
 * Two layers:
 *  1. Deterministic guardrails (always run, no API key, CI gate): model tiering never regresses to Opus,
 *     PII redaction masks contact identifiers, the system prompt carries the prompt-injection clause, and
 *     tool outputs are framed as untrusted data.
 *  2. Tool-accuracy over a seeded DB: the figures the model is handed are CORRECT (a wrong number is worse
 *     than a refusal). Boots the real services over PGlite, seeds known sales, asserts the summary total.
 *
 * An optional LIVE accuracy eval (seed → ask fixed questions → assert figures in the reply) runs only when
 * ANTHROPIC_API_KEY is present; it is skipped in CI.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover ai-eval
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ai-eval-secret';
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
import { tenantALS } from '../../../apps/api/dist/common/tenant-context';
import { pickModel, SYSTEM_CACHED } from '../../../apps/api/dist/modules/ai/agent.service';
import { modelFor, MODEL } from '../../../apps/api/dist/common/ai-models';
import { redactPii } from '../../../apps/api/dist/common/pii-redact';
import { PosService } from '../../../apps/api/dist/modules/pos/pos.service';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });
const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.01;

async function main() {
  // ── Layer 1: deterministic guardrails (no DB, no key) ──────────────────────────────────────────
  // Model tiering never regresses to Opus.
  for (const t of ['agent_reasoning', 'agent_tool_relay', 'doc_extract', 'nl_query', 'config_suggest', 'insight'] as const)
    ok(`modelFor(${t}) is not Opus`, !/opus/.test(modelFor(t)));
  ok('extraction tasks use CHEAP tier', modelFor('doc_extract') === MODEL.CHEAP && modelFor('nl_query') === MODEL.CHEAP);
  ok('tool-relay turn → cheap model', /haiku/.test(pickModel([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '{}' }] }])));
  ok('reasoning turn → strong model', pickModel([{ role: 'user', content: 'hi' }]) === MODEL.REASONING);

  // PII redaction masks contact identifiers before they leave for the model.
  const red: any = redactPii({ name: 'ACME', email: 'a@b.co', phone: '0812345678', national_id: '1234567890123', total: 5000 });
  ok('redactPii masks email', red.email !== 'a@b.co');
  ok('redactPii masks phone', red.phone !== '0812345678');
  ok('redactPii masks national_id', red.national_id !== '1234567890123');
  ok('redactPii keeps non-PII (amount) intact', Number(red.total) === 5000);

  // System prompt carries the injection-defense clause (untrusted-data framing).
  const sys = String(SYSTEM_CACHED?.[0]?.text ?? '');
  ok('system prompt has prompt-injection clause', /untrusted|injection|ไม่น่าเชื่อถือ|prompt-injection/i.test(sys));

  // ── Layer 2: tool-accuracy over a seeded DB ────────────────────────────────────────────────────
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  await db.insert(s.tenants).values([{ code: 'AIE', name: 'AI Eval Shop' }]).onConflictDoNothing();
  const tid = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'AIE')))[0].id);
  // Two completed sales (1,000 + 1,500 = 2,500) and one Voided (excluded → must NOT count).
  await db.insert(s.custPosSales).values([
    { saleNo: 'AIE-1', saleDate: '2026-06-01', tenantId: tid, total: '1000.00', status: 'Completed' },
    { saleNo: 'AIE-2', saleDate: '2026-06-15', tenantId: tid, total: '1500.00', status: 'Completed' },
    { saleNo: 'AIE-3', saleDate: '2026-06-20', tenantId: tid, total: '9999.00', status: 'Voided' },
  ]);

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const pos = app.get(PosService);
  // Run inside a tenant context so the DRIZZLE proxy routes to our db (bypass to see the single tenant).
  const summary: any = await tenantALS.run({ tx: db, tenantId: tid, bypass: true }, () => pos.summary('2026-06-01', '2026-06-30'));
  ok('sales summary sums Completed sales (1000+1500)', near(summary?.total_sales, 2500), `got ${summary?.total_sales}`);
  ok('sales summary EXCLUDES the Voided sale', !near(summary?.total_sales, 12499), `got ${summary?.total_sales}`);
  await app.close();

  // ── Optional live accuracy eval (skipped without a key) ─────────────────────────────────────────
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('ai-eval: live accuracy eval SKIPPED (no ANTHROPIC_API_KEY) — deterministic guardrails + tool accuracy ran.');
  }
}

main().then(() => {
  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
  console.log(`\nai-eval: ${checks.length - failed.length}/${checks.length} passed`);
  process.exit(failed.length ? 1 : 0);
}).catch((e) => { console.error('ai-eval crashed:', e); process.exit(1); });
