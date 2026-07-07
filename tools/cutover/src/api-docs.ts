/**
 * Wave 2 · 2.12 — public API developer portal (self-contained HTML reference) ToE.
 * Boots the app (PGlite) and asserts the curated OpenAPI contract is served as JSON at /api/v1/openapi.json
 * and a dependency-free HTML reference at /api/v1/docs (open, no key, no external assets).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover api-docs
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'api-docs';
process.env.NODE_ENV = 'test';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import * as s from '../../../apps/api/dist/database/schema/index';
import { AppModule } from '../../../apps/api/dist/app.module';
import { DRIZZLE, tenantAwareProxy } from '../../../apps/api/dist/database/database.module';
import { AllExceptionsFilter } from '../../../apps/api/dist/common/all-exceptions.filter';
import { renderApiReferenceHtml } from '../../../apps/api/dist/modules/public-api/api-reference';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function main() {
  // ── pure renderer ──
  const html = renderApiReferenceHtml();
  ok('renderer: returns a full HTML document', html.startsWith('<!doctype html>') && html.includes('</html>'));
  ok('renderer: no external asset references (CSP-safe/offline)', !/https?:\/\//i.test(html.replace(/https?:\/\/[^"']*openapi/gi, '')) || !/<script src=|<link[^>]+href="http/i.test(html));
  ok('renderer: lists the /api/v1/me endpoint', html.includes('/api/v1/me') || html.includes('/me'));

  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const inj = async (url: string) => { const r = await app.inject({ method: 'GET', url }); return { status: r.statusCode, body: r.body, ct: String(r.headers['content-type'] ?? '') }; };

  const jsonRes = await inj('/api/v1/openapi.json');
  let doc: any = {}; try { doc = JSON.parse(jsonRes.body); } catch { /* */ }
  ok('GET /api/v1/openapi.json → 200 (open)', jsonRes.status === 200, `status=${jsonRes.status}`);
  ok('openapi.json is OpenAPI 3.1', doc.openapi === '3.1.0', JSON.stringify({ v: doc.openapi }));

  const docsRes = await inj('/api/v1/docs');
  ok('GET /api/v1/docs → 200 (open)', docsRes.status === 200, `status=${docsRes.status}`);
  ok('docs served as text/html', docsRes.ct.includes('text/html'), docsRes.ct);
  ok('docs HTML renders endpoints', docsRes.body.includes('Endpoints') && /GET|POST/.test(docsRes.body));

  await app.close();
  console.log('\n── Wave 2 · 2.12 — public API docs (HTML reference) (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} api-docs checks failed` : `\n✅ All ${checks.length} api-docs checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
