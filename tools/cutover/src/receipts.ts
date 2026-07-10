/**
 * POS Tier 2 #8 — Receipts (ใบเสร็จ) + Customer Display (จอลูกค้า) over PGlite:
 * 80mm HTML / ESC-POS / PDF receipt rendering, reprint COPY tracking, email/SMS send seam, CFD snapshot,
 * and the POS-2 LINE e-receipt (member-resolved flex push via the messaging mock + opaque public link).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover receipts
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'rcpt-secret';
process.env.NODE_ENV = 'test';
process.env.WEB_BASE_URL = 'http://shop.example'; // makes the LINE e-receipt mint a public receipt link

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

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านอาหารหนึ่ง', taxId: '0105556000017', vatRegistered: true, phone: '021234567' }, { code: 'T2', name: 'ร้านสอง', vatRegistered: true }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'sales1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: t1 },
    { username: 'sales2', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t2 },
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ routerOptions: { maxParamLength: 500 } })); // long HMAC receipt tokens in path (mirrors main.ts)
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json, body: res.payload as string, headers: res.headers };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const sales1 = await login('sales1', 'pw1');
  const sales2 = await login('sales2', 'pw2');

  let tn = 0;
  const makeOrder = async (price: number, token = sales1) => {
    const t = await inj('POST', '/api/restaurant/tables', token, { table_no: `R${++tn}`, seats: 4 });
    return (await inj('POST', '/api/restaurant/orders', token, { table_id: t.json.id, items: [{ name: 'ข้าวผัด', qty: 1, unit_price: price, station_code: 'hot' }] })).json;
  };
  const checkout = (orderNo: string, body: any, token = sales1) => inj('POST', `/api/restaurant/orders/${orderNo}/checkout`, token, body);

  // sale A — 170 net → vat 11.90 → total 181.90
  const oA = await makeOrder(170);
  const cA = await checkout(oA.order_no, { method: 'Cash' });
  const saleA = cA.json.sale_no as string;

  // ── 1 + 2. first receipt (original) ──
  const r1 = await inj('GET', `/api/pos/sales/${saleA}/receipt?format=html`, sales1);
  const b1 = r1.body ?? '';
  ok('Receipt HTML: shop name + total 181.90 + ใบเสร็จรับเงิน + Thai footer', r1.status === 200 && b1.includes('ร้านอาหารหนึ่ง') && b1.includes('181.90') && b1.includes('ใบเสร็จรับเงิน') && b1.includes('ขอบคุณที่ใช้บริการ') && b1.includes('ไม่ใช่ใบกำกับภาษี'), `status=${r1.status}`);
  ok('Receipt shows tender (Cash) + is original (no สำเนา)', b1.includes('Cash') && !b1.includes('สำเนา'), `cash=${b1.includes('Cash')} copy=${b1.includes('สำเนา')}`);

  // ── 3. reprint → COPY banner + count ──
  const r2 = await inj('GET', `/api/pos/sales/${saleA}/receipt?format=html`, sales1);
  const b2 = r2.body ?? '';
  const cnt = (await pg.query(`SELECT count(*)::int n FROM receipt_prints WHERE sale_no='${saleA}' AND channel='print'`)).rows as any[];
  ok('Reprint: สำเนา (COPY) + พิมพ์ซ้ำครั้งที่ 1 + 2 print rows', b2.includes('สำเนา (COPY)') && b2.includes('พิมพ์ซ้ำครั้งที่ 1') && cnt[0].n === 2, `copy=${b2.includes('สำเนา (COPY)')} n=${cnt[0].n}`);

  // ── 4. ESC/POS plain text ──
  const r4 = await inj('GET', `/api/pos/sales/${saleA}/receipt?format=escpos`, sales1);
  ok('ESC/POS: text/plain, contains total, not HTML', r4.status === 200 && /text\/plain/.test(String(r4.headers['content-type'])) && r4.body.includes('181.90') && !r4.body.includes('<html'), `ct=${r4.headers['content-type']}`);

  // ── 5. PDF (or Chromium-absent HTML fallback) ──
  const r5 = await inj('GET', `/api/pos/sales/${saleA}/receipt?format=pdf`, sales1);
  const ct5 = String(r5.headers['content-type'] ?? '');
  ok('PDF: 200 + content-type pdf or html (no 500)', r5.status === 200 && (/application\/pdf/.test(ct5) || /text\/html/.test(ct5)), `status=${r5.status} ct=${ct5}`);

  // ── 6. send (noop provider) ──
  const snd = await inj('POST', `/api/pos/sales/${saleA}/receipt/send`, sales1, { channel: 'email', to: 'lukkha@example.com' });
  const emailRow = (await pg.query(`SELECT count(*)::int n FROM receipt_prints WHERE sale_no='${saleA}' AND channel='email'`)).rows as any[];
  ok('Send email → queued true, provider noop, ref + email print row', (snd.status === 200 || snd.status === 201) && snd.json.queued === true && snd.json.provider === 'noop' && /.+/.test(snd.json.ref ?? '') && emailRow[0].n === 1, `${snd.status} ${JSON.stringify(snd.json)}`);

  // ── 7. send validates email ──
  const bad = await inj('POST', `/api/pos/sales/${saleA}/receipt/send`, sales1, { channel: 'email', to: 'not-an-email' });
  ok('Send invalid email → 400', bad.status === 400, `${bad.status}`);

  // ── POS-2: LINE e-receipt (member-resolved flex push + opaque public link) ──
  // Seed: loyalty enabled + a LINE-linked member; checkout WITH member_id so the points ledger carries
  // ref_doc = sale_no (the server resolves the member FROM the sale — never from caller input).
  await db.insert(s.loyaltyConfig).values({ id: 1, enabled: true, pointsPerBaht: '1' })
    .onConflictDoUpdate({ target: s.loyaltyConfig.id, set: { enabled: true, pointsPerBaht: '1' } });
  const [mLine] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-LINE1', name: 'คุณลิงก์', phone: '0812345678', lineUserId: 'U0000000000000000000000000000line', balance: '0', lifetime: '0' }).returning();
  const [mNoLine] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-NOLINE', name: 'คุณไม่ลิงก์', phone: '0898765432', balance: '0', lifetime: '0' }).returning();

  const oL = await makeOrder(200); // 200 net → vat 14 → total 214
  const cL = await checkout(oL.order_no, { method: 'Cash', member_id: Number(mLine.id) });
  const saleL = cL.json.sale_no as string;
  const sndLine = await inj('POST', `/api/pos/sales/${saleL}/receipt/send`, sales1, { channel: 'line' });
  ok('LINE e-receipt: queued, provider mock (no token), status sent, member resolved from sale',
    (sndLine.status === 200 || sndLine.status === 201) && sndLine.json.queued === true && sndLine.json.provider === 'mock' && sndLine.json.status === 'sent' && sndLine.json.member_id === Number(mLine.id),
    `${sndLine.status} ${JSON.stringify(sndLine.json)}`);
  const lineLog = (await pg.query(`SELECT count(*)::int n FROM message_log WHERE channel='line' AND campaign='e-receipt' AND status='sent'`)).rows as any[];
  const linePrint = (await pg.query(`SELECT count(*)::int n FROM receipt_prints WHERE sale_no='${saleL}' AND channel='line'`)).rows as any[];
  ok('LINE e-receipt: send audited in message_log (e-receipt) + receipt_prints channel line', lineLog[0].n === 1 && linePrint[0].n === 1, `log=${lineLog[0].n} print=${linePrint[0].n}`);

  // public receipt link: the response carries an opaque HMAC-token URL; the HTML renders WITHOUT auth,
  // and a tampered token is rejected (401) — never a guessable sale_no URL.
  const rcptUrl = String(sndLine.json.receipt_url ?? '');
  const pubPath = rcptUrl.replace('http://shop.example', '');
  const pub = await inj('GET', pubPath);
  ok('Public e-receipt link: opaque token URL renders the HTML receipt without auth', rcptUrl.startsWith('http://shop.example/api/pos/receipt/public/') && pub.status === 200 && pub.body.includes('214.00') && pub.body.includes('ใบเสร็จรับเงิน'), `url=${rcptUrl.slice(0, 60)} status=${pub.status}`);
  const forged = await inj('GET', `/api/pos/receipt/public/${'A'.repeat(48)}`);
  ok('Public e-receipt link: forged token → 401 BAD_TOKEN', forged.status === 401 && forged.json.error?.code === 'BAD_TOKEN', `${forged.status} ${forged.json.error?.code}`);

  // negatives: a sale with no member, and a member without a linked LINE account → LINE_NOT_LINKED
  const noMem = await inj('POST', `/api/pos/sales/${saleA}/receipt/send`, sales1, { channel: 'line' });
  ok('LINE e-receipt: sale without member → 400 LINE_NOT_LINKED', noMem.status === 400 && noMem.json.error?.code === 'LINE_NOT_LINKED', `${noMem.status} ${noMem.json.error?.code}`);
  const oN = await makeOrder(50);
  const cN = await checkout(oN.order_no, { method: 'Cash', member_id: Number(mNoLine.id) });
  const notLinked = await inj('POST', `/api/pos/sales/${cN.json.sale_no}/receipt/send`, sales1, { channel: 'line' });
  ok('LINE e-receipt: member without linked LINE → 400 LINE_NOT_LINKED', notLinked.status === 400 && notLinked.json.error?.code === 'LINE_NOT_LINKED', `${notLinked.status} ${notLinked.json.error?.code}`);

  // DTO: email/sms still require an explicit recipient (to optional only for 'line')
  const noTo = await inj('POST', `/api/pos/sales/${saleA}/receipt/send`, sales1, { channel: 'email' });
  ok('Send email without recipient → 400', noTo.status === 400, `${noTo.status}`);

  // ── 8. CFD on an OPEN order ──
  const oC = await makeOrder(100); // 100 net → total 107
  const d8 = await inj('GET', `/api/pos/orders/${oC.order_no}/display`, sales1);
  ok('CFD open order: items≥1, total 107, amount_due == total, paid false', d8.status === 200 && (d8.json.items?.length ?? 0) >= 1 && near(d8.json.total, 107) && near(d8.json.amount_due, 107) && d8.json.paid === false, JSON.stringify({ n: d8.json.items?.length, total: d8.json.total, due: d8.json.amount_due, paid: d8.json.paid }));

  // ── 9. CFD after checkout → paid ──
  await checkout(oC.order_no, { method: 'Cash' });
  const d9 = await inj('GET', `/api/pos/orders/${oC.order_no}/display`, sales1);
  ok('CFD after checkout: amount_due 0, paid true', d9.status === 200 && near(d9.json.amount_due, 0) && d9.json.paid === true, JSON.stringify({ due: d9.json.amount_due, paid: d9.json.paid }));

  // ── 10. RLS cross-tenant ──
  const xrcpt = await inj('GET', `/api/pos/sales/${saleA}/receipt?format=html`, sales2);
  ok('RLS: T2 cannot read T1 sale receipt → 404', xrcpt.status === 404, `${xrcpt.status}`);

  // ── 11. unknown sale ──
  const nope = await inj('GET', `/api/pos/sales/SALE-NOPE/receipt`, sales1);
  ok('Unknown sale → 404 NOT_FOUND', nope.status === 404 && nope.json.error?.code === 'NOT_FOUND', `${nope.status} ${nope.json.error?.code}`);

  console.log('\n── POS Tier 2 #8 Receipts (ใบเสร็จ) + Customer Display (จอลูกค้า) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} receipt checks failed` : `\n✅ All ${checks.length} receipt checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
