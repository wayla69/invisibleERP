/**
 * C2 — e-Tax Invoice by Email (ETDA, no CA). POST /api/tax-invoices/:docNo/send-etax-email →
 * emails buyer + CC ETDA time-stamp mailbox, XML attached. Uses a capturing mock mailer (no SMTP). Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover etax-email
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'etaxmail-secret';
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
import { MAILER } from '../../../apps/api/dist/modules/tax/documents/mailer';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

// capturing mock mailer — records messages instead of sending over SMTP
const sent: any[] = [];
const mockMailer = { async send(msg: any) { sent.push(msg); return { messageId: `mock-${sent.length}`, accepted: [msg.to] }; } };

async function seedInvoice(db: any, tid: number, docNo: string) {
  const [tiv] = await db.insert(s.taxInvoices).values({
    tenantId: tid, docNo, type: 'full', issueDate: '2026-06-22', sourceType: 'AR', sourceRef: 'INV-1',
    sellerName: 'ร้านโอชิเนอิ', sellerTaxId: '0105551234567', sellerBranchCode: '00000', sellerBranchLabel: 'สำนักงานใหญ่',
    sellerAddress: 'กทม.', buyerName: 'ลูกค้า', buyerTaxId: '0992001234567', buyerBranchCode: '00000', buyerAddress: 'นนทบุรี',
    currency: 'THB', subtotal: '100.00', discount: '0', vatRate: '0.0700', vatAmount: '7.00', grandTotal: '107.00', isVatInclusive: false, status: 'Issued',
  }).returning({ id: s.taxInvoices.id });
  await db.insert(s.taxInvoiceLines).values({ taxInvoiceId: Number(tiv.id), tenantId: tid, lineNo: '1', description: 'อาหาร', qty: '1', uom: 'EA', unitPrice: '100.00', discount: '0', amount: '100.00' });
}

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  // HQ has a seller email; T2 does NOT (to prove the guard)
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ', email: 'shop@oshinei.co.th' }, { code: 'T2', name: 'No Email Co' }]).onConflictDoNothing();
  const hq = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0].id);
  const t2 = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'T2')))[0].id);
  await db.insert(s.users).values([{ username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq }]).onConflictDoNothing();
  await seedInvoice(db, hq, 'TIV-202606-0011');
  await seedInvoice(db, t2, 'TIV-202606-0012');

  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db))
    .overrideProvider(MAILER).useValue(mockMailer)
    .compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const admin = (await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' })).json.token;

  // ── 1. send → ok, CC ETDA ──
  const r = await inj('POST', '/api/tax-invoices/TIV-202606-0011/send-etax-email', admin, { to_email: 'buyer@example.com' });
  ok('Send returns sent=true, CC=ETDA timestamp, message id',
    r.status < 300 && r.json.sent === true && r.json.cc === 'csemail@etda.or.th' && /^mock-/.test(r.json.message_id ?? ''),
    JSON.stringify({ s: r.status, cc: r.json.cc }));

  // ── 2. the captured message: from seller, to buyer, CC ETDA, XML attached ──
  const m = sent[sent.length - 1];
  ok('Mailer got: from seller, to buyer, CC ETDA, <docNo>.xml attached',
    !!m && m.from === 'shop@oshinei.co.th' && m.to === 'buyer@example.com' && m.cc === 'csemail@etda.or.th' &&
    m.attachments?.[0]?.filename === 'TIV-202606-0011.xml' && String(m.attachments?.[0]?.content).includes('<Invoice '),
    JSON.stringify({ from: m?.from, att: m?.attachments?.[0]?.filename }));

  // ── 3. invalid recipient → 400 (zod) ──
  const bad = await inj('POST', '/api/tax-invoices/TIV-202606-0011/send-etax-email', admin, { to_email: 'not-an-email' });
  ok('Invalid recipient → 400', bad.status === 400, `status=${bad.status}`);

  // ── 4. seller without email → 400 NO_SELLER_EMAIL ──
  const noEmail = await inj('POST', '/api/tax-invoices/TIV-202606-0012/send-etax-email', admin, { to_email: 'buyer@example.com' });
  ok('Seller without email → 400 NO_SELLER_EMAIL', noEmail.status === 400 && noEmail.json.error?.code === 'NO_SELLER_EMAIL', JSON.stringify({ s: noEmail.status, c: noEmail.json.error?.code }));

  console.log('\n── C2 — e-Tax Invoice by Email (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} e-Tax-email checks failed` : `\n✅ All ${checks.length} e-Tax-email checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
