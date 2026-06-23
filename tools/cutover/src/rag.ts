/**
 * Phase D2 — RAG over policies/SOPs (cite-or-refuse) over PGlite.
 * Proves: ingest chunks + embeds a document; search retrieves the relevant chunk with a high score;
 * ask() cites it; an off-topic query is REFUSED (below threshold, no citation = no hallucination);
 * and the knowledge base is tenant-isolated (RLS). Uses the deterministic local embedder (no API key,
 * no pgvector) so it runs offline.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover rag
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'rag-secret';
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

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  // Non-admin role (MasterDataAdmin: masterdata) + an ai_chat override so RLS is ENFORCED
  // (Admin would bypass it). MasterDataAdmin can ingest (masterdata); ai_chat enables search/ask.
  await db.insert(s.users).values([
    { username: 'admin1', passwordHash: await pw.hash('pw'), role: 'MasterDataAdmin', tenantId: t1 },
    { username: 'admin2', passwordHash: await pw.hash('pw'), role: 'MasterDataAdmin', tenantId: t2 },
  ]).onConflictDoNothing();
  const uid = async (u: string) => Number((await db.select().from(s.users).where(eq(s.users.username, u)))[0].id);
  for (const u of ['admin1', 'admin2']) await db.insert(s.userPermissions).values({ userId: await uid(u), perm: 'ai_chat' }).onConflictDoNothing();

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
  const login = async (u: string) => (await inj('POST', '/api/login', undefined, { username: u, password: 'pw' })).json.token as string;
  const t1tok = await login('admin1');
  const t2tok = await login('admin2');

  // ingest a refund policy (T1)
  const refundDoc = [
    'Refund and Return Policy. Customers may request a refund within 14 days of purchase with the original receipt.',
    'Perishable food items are non-refundable unless spoiled on delivery. Refunds are issued to the original payment method within 7 business days.',
    'A manager must approve any refund above 5000 baht. Store credit may be offered as an alternative to a cash refund.',
  ].join('\n\n');
  const ing = await inj('POST', '/api/ai/kb/documents', t1tok, { title: 'Refund Policy', source: 'POL-REFUND', content: refundDoc });
  ok('Ingest doc → chunks created', (ing.status === 200 || ing.status === 201) && ing.json.chunks >= 3, `${ing.status} ${JSON.stringify(ing.json)}`);
  // a second, unrelated doc so retrieval must discriminate
  await inj('POST', '/api/ai/kb/documents', t1tok, { title: 'Kitchen Safety', source: 'POL-KITCHEN', content: 'Wash hands before handling food. Store raw meat below 4 degrees celsius. Sanitize all surfaces each shift.' });

  // search: relevant query retrieves the refund chunk with a high score
  const srch = await inj('GET', '/api/ai/kb/search?q=' + encodeURIComponent('how many days to get a refund with receipt'), t1tok);
  const top = srch.json.results?.[0];
  ok('Search returns refund policy as top hit', top?.title === 'Refund Policy' && top?.score > 0.15, `top=${top?.title} score=${top?.score}`);
  ok('Search uses the local embedder (offline)', srch.json.provider === 'local', srch.json.provider);

  // ask: relevant question → cite-or-answer with citations (not refused)
  const ask1 = await inj('GET', '/api/ai/kb/ask?q=' + encodeURIComponent('who approves a large refund over 5000 baht'), t1tok);
  ok('Ask relevant → not refused, has citations', ask1.json.refused === false && (ask1.json.citations?.length ?? 0) >= 1, JSON.stringify(ask1.json).slice(0, 120));
  ok('Ask relevant → citation is the Refund Policy', (ask1.json.citations ?? []).some((c: any) => c.title === 'Refund Policy'), JSON.stringify(ask1.json.citations?.map((c: any) => c.title)));

  // ask: off-topic question → REFUSE (no relevant source ⇒ no hallucinated answer)
  const ask2 = await inj('GET', '/api/ai/kb/ask?q=' + encodeURIComponent('what is the wifi password for the spaceship'), t1tok);
  ok('Ask off-topic → refused, no citations', ask2.json.refused === true && (ask2.json.citations?.length ?? 0) === 0, JSON.stringify(ask2.json).slice(0, 120));

  // tenant isolation: T2 cannot see T1's documents
  const t2search = await inj('GET', '/api/ai/kb/search?q=' + encodeURIComponent('refund within 14 days'), t2tok);
  ok('RLS: T2 sees none of T1 KB (0 results)', (t2search.json.results?.length ?? 0) === 0, JSON.stringify(t2search.json).slice(0, 80));
  const t2ask = await inj('GET', '/api/ai/kb/ask?q=' + encodeURIComponent('refund policy'), t2tok);
  ok('RLS: T2 ask refuses (no T1 leakage)', t2ask.json.refused === true, JSON.stringify(t2ask.json).slice(0, 80));

  await app.close();
  await pg.close();

  console.log('\n── Phase D2 — RAG over policies/SOPs (cite-or-refuse) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} rag checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} rag checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
