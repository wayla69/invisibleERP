/**
 * Phase 20 Batch 2B — CPQ (Configure-Price-Quote) over PGlite.
 * Product configs, options, pricing rules, quote lifecycle.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover cpq
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cpq-secret';
process.env.NODE_ENV = 'test';
// A sender identity so the doc-email path clears its sender guard and reaches the (unconfigured) SMTP
// transport — proving the generic email chain is wired end-to-end (render → mailer) → EMAIL_NOT_CONFIGURED.
process.env.MAIL_FROM = process.env.MAIL_FROM || 'shop@example.com';

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
    { username: 'sales1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: hq },
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
    return { status: res.statusCode, json, text: res.payload };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const [admin, sales1] = [await login('admin', 'admin123'), await login('sales1', 'pw1')];

  // Base price: 50,000 THB
  // 1. Create product config
  const cfg = await inj('POST', '/api/cpq/configs', admin, { code: 'LAPTOP-PRO', name: 'Laptop Pro', base_price: 50000 });
  ok('Create product config → has id, code', cfg.status === 201 && cfg.json.code === 'LAPTOP-PRO' && near(cfg.json.base_price, 50000), JSON.stringify(cfg.json));
  const configId = cfg.json.id;

  // 2. Add RAM option (+5,000)
  const optRam = await inj('POST', `/api/cpq/configs/${configId}/options`, admin, { group_name: 'RAM', option_code: '16GB', option_name: '16GB RAM', price_delta: 5000 });
  ok('Add RAM option (+5000)', optRam.status === 201 && near(optRam.json.price_delta, 5000), JSON.stringify(optRam.json));

  // 3. Add SSD option (+3,000)
  const optSsd = await inj('POST', `/api/cpq/configs/${configId}/options`, admin, { group_name: 'SSD', option_code: '512GB', option_name: '512GB SSD', price_delta: 3000 });
  ok('Add SSD option (+3000)', optSsd.status === 201 && near(optSsd.json.price_delta, 3000), JSON.stringify(optSsd.json));

  // 4. Create pricing rule: qty >= 2 → 10% discount
  const rule = await inj('POST', `/api/cpq/configs/${configId}/rules`, admin, { name: 'Volume 2+', rule_type: 'volume', discount_pct: 10, min_qty: 2 });
  ok('Create volume pricing rule (10% off for 2+)', rule.status === 201 && near(rule.json.discount_pct, 10), JSON.stringify(rule.json));

  // 5. Create quote with qty=1 (no discount): total = 50000+5000+3000 = 58000
  const q1 = await inj('POST', '/api/cpq/quotes', sales1, {
    customer_name: 'ลูกค้าทดสอบ', config_id: configId, qty: 1,
    selected_options: [{ group_name: 'RAM', option_code: '16GB' }, { group_name: 'SSD', option_code: '512GB' }],
  });
  ok('Quote qty=1 → total=58000 (no volume discount)', q1.status === 201 && near(q1.json.total, 58000), `total=${q1.json.total}`);
  const q1Id = q1.json.id;

  // Printable ใบเสนอราคา (Quotation) — HTML fallback when Chromium absent (CI): title + customer + total.
  const qPdf = await inj('GET', `/api/cpq/quotes/${q1Id}/pdf`, sales1);
  ok('Quote PDF/HTML contains "ใบเสนอราคา" + customer + total (58,000.00)', qPdf.status === 200 && qPdf.text.includes('ใบเสนอราคา') && qPdf.text.includes('ลูกค้าทดสอบ') && qPdf.text.includes('58,000.00'), `${qPdf.status} ${String(qPdf.text).slice(0, 50)}`);
  // Generic email path is wired end-to-end: with no SMTP configured in CI it reaches the mailer guard.
  const qEmail = await inj('POST', `/api/cpq/quotes/${q1Id}/send-email`, sales1, { to_email: 'buyer@example.com' });
  ok('Quote email path wired → EMAIL_NOT_CONFIGURED (503) with no SMTP in CI', qEmail.status === 503 && qEmail.json.error?.code === 'EMAIL_NOT_CONFIGURED', `${qEmail.status} ${qEmail.json.error?.code}`);

  // 6. Create quote with qty=2 → 10% discount: total = 58000*2*0.9 = 104400
  const q2 = await inj('POST', '/api/cpq/quotes', sales1, {
    customer_name: 'Corp Buyer', config_id: configId, qty: 2,
    selected_options: [{ group_name: 'RAM', option_code: '16GB' }, { group_name: 'SSD', option_code: '512GB' }],
  });
  ok('Quote qty=2 → total=104400 (10% volume discount)', q2.status === 201 && near(q2.json.total, 104400), `total=${q2.json.total}`);
  const q2Id = q2.json.id;

  // 7. Quote status = Draft
  ok('Quote starts as Draft', q1.json.status === 'Draft', `status=${q1.json.status}`);

  // 8. Send quote → Sent
  const sent = await inj('POST', `/api/cpq/quotes/${q1Id}/send`, sales1);
  ok('Send quote → status=Sent', sent.status === 200 && sent.json.status === 'Sent', JSON.stringify(sent.json));

  // 9. Accept quote → Accepted
  const accepted = await inj('POST', `/api/cpq/quotes/${q1Id}/accept`, sales1);
  ok('Accept quote → status=Accepted', accepted.status === 200 && accepted.json.status === 'Accepted', JSON.stringify(accepted.json));

  // 10. Cannot accept already-accepted quote (invalid transition)
  const dblAccept = await inj('POST', `/api/cpq/quotes/${q1Id}/accept`, sales1);
  ok('Double-accept → 400 (invalid transition)', dblAccept.status === 400, `status=${dblAccept.status}`);

  // 11. Reject draft quote → Rejected
  const rejected = await inj('POST', `/api/cpq/quotes/${q2Id}/reject`, sales1);
  ok('Reject draft quote → Rejected', rejected.status === 200 && rejected.json.status === 'Rejected', JSON.stringify(rejected.json));

  // 12. List by status=Accepted → 1 result
  const accList = await inj('GET', '/api/cpq/quotes?status=Accepted', sales1);
  ok('List Accepted quotes → 1', accList.json.quotes?.length === 1, `count=${accList.json.quotes?.length}`);

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
