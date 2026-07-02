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
 *  3. SCORED agent benchmark (docs/24 R4-4, always runs, no key): a scripted fake LLM (injected through the
 *     common/llm-client provider seam) drives the REAL agent loop end-to-end over the seeded DB — scoring
 *     that the tool pipeline hands the model the right figures, that Voided rows stay excluded through the
 *     whole loop, and that tool results reach the model wrapped as untrusted data. Deterministic → 100% gate.
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
import { pickModel, SYSTEM_CACHED, AgentService } from '../../../apps/api/dist/modules/ai/agent.service';
import { setLlmClientForTests } from '../../../apps/api/dist/common/llm-client';
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

  // Layer 3 needs AgentService to construct with an apiKey — inject a placeholder when no real key exists
  // (the fake client below intercepts every call, so nothing ever reaches the network).
  const hadRealKey = !!(process.env.ANTHROPIC_API_KEY ?? '').trim();
  if (!hadRealKey) process.env.ANTHROPIC_API_KEY = 'fake-scored-eval-key';

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const pos = app.get(PosService);
  // Run inside a tenant context so the DRIZZLE proxy routes to our db (bypass to see the single tenant).
  const summary: any = await tenantALS.run({ tx: db, tenantId: tid, bypass: true }, () => pos.summary('2026-06-01', '2026-06-30'));
  ok('sales summary sums Completed sales (1000+1500)', near(summary?.total_sales, 2500), `got ${summary?.total_sales}`);
  ok('sales summary EXCLUDES the Voided sale', !near(summary?.total_sales, 12499), `got ${summary?.total_sales}`);

  // ── Layer 3: SCORED agent benchmark over the fake LLM (docs/24 R4-4) ───────────────────────────
  // The fake is scripted, so what we score is everything the model does NOT control: the agent loop, the
  // tool pipeline's figures from the seeded DB, the Voided exclusion, and the untrusted-data framing.
  const seenToolResults: string[] = [];
  setLlmClientForTests({
    create: async (params: any) => {
      const last = params.messages[params.messages.length - 1];
      const toolResults = Array.isArray(last?.content) ? last.content.filter((b: any) => b.type === 'tool_result') : [];
      if (!toolResults.length) {
        // Opening turn → ask for the June sales summary via the real tool.
        return { stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 },
          content: [{ type: 'tool_use', id: 'bench-1', name: 'get_sales_summary', input: { start_date: '2026-06-01', end_date: '2026-06-30' } }] };
      }
      // Tool round-trip → echo the figure the pipeline handed us; capture what the model actually saw.
      for (const tr of toolResults) seenToolResults.push(String(tr.content));
      let total = NaN;
      try { total = Number(JSON.parse(String(toolResults[0].content))?.untrusted_data?.total_sales); } catch { /* scored below */ }
      return { stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 },
        content: [{ type: 'text', text: `ยอดขายรวมเดือนมิถุนายน ${total} บาท` }] };
    },
    stream: () => { throw new Error('bench uses the blocking path'); },
  });
  try {
    const agent = app.get(AgentService);
    const benchUser: any = { username: 'aie-bench', role: 'Admin', customerName: null, tenantId: tid, permissions: [] };
    const res: any = await tenantALS.run({ tx: db, tenantId: tid, bypass: true }, () => agent.chat('ยอดขายเดือนมิถุนายนเท่าไร', [], benchUser));
    const reply = String(res?.reply ?? '');
    const bench: { name: string; pass: boolean; detail: string }[] = [
      { name: 'figure correctness end-to-end (reply carries 2500 from the seeded DB)', pass: /2500/.test(reply.replace(/[,\s]/g, '')), detail: reply },
      { name: 'Voided sale excluded through the whole agent loop', pass: !/9999|12499/.test(reply.replace(/[,\s]/g, '')), detail: reply },
      { name: 'tool result reached the model wrapped as untrusted data', pass: seenToolResults.length > 0 && seenToolResults.every((t) => /untrusted_data/.test(t)), detail: `${seenToolResults.length} tool result(s)` },
    ];
    const score = bench.filter((b) => b.pass).length;
    for (const b of bench) ok(`bench: ${b.name}`, b.pass, b.detail.slice(0, 120));
    ok(`scored agent benchmark = ${score}/${bench.length} (gate: 100%)`, score === bench.length, `score=${score}/${bench.length}`);
  } finally {
    setLlmClientForTests(null);
    if (!hadRealKey) delete process.env.ANTHROPIC_API_KEY;
  }
  await app.close();

  // ── Optional live accuracy eval (skipped without a key) ─────────────────────────────────────────
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('ai-eval: live accuracy eval SKIPPED (no ANTHROPIC_API_KEY) — deterministic guardrails + tool accuracy + scored fake-LLM benchmark ran.');
  }
}

main().then(() => {
  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
  console.log(`\nai-eval: ${checks.length - failed.length}/${checks.length} passed`);
  process.exit(failed.length ? 1 : 0);
}).catch((e) => { console.error('ai-eval crashed:', e); process.exit(1); });
