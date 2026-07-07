/**
 * Wave 2 · 5.3 — input-VAT report (รายงานภาษีซื้อ): supplier Tax ID + exempt/estimated classification.
 * A bill linked to a vendor master shows the vendor's 13-digit Tax ID (RD requirement); a name-only bill
 * is counted in missing_tax_id; an exempt bill (vatAmount 0) classifies as exempt_or_zero (not 7/107).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover input-vat
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'input-vat';
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
const chk = (p12: string) => { let sum = 0; for (let i = 0; i < 12; i++) sum += Number(p12[i]) * (13 - i); return p12 + String((11 - (sum % 11)) % 10); };

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();
  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }]).onConflictDoNothing();
  const hq = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0].id);
  await db.insert(s.users).values([{ username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq }]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const admin = (await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' })).json.token;

  // Vendor master with a valid 13-digit Tax ID (taxId is encryptedText → stored encrypted, decrypted on read).
  const VTAX = chk('010555700007');
  await db.insert(s.vendors).values({ name: 'Acme Supplies Co.', taxId: VTAX, tenantId: hq });
  const vid = Number((await db.select().from(s.vendors).where(eq(s.vendors.name, 'Acme Supplies Co.')))[0].id);

  // 3 AP bills in 2026-06: linked (standard 70), name-only (standard 35), exempt (0).
  await inj('POST', '/api/finance/ap/transactions', admin, { vendor_id: vid, vendor_name: 'Acme Supplies Co.', txn_type: 'Service', invoice_no: 'PV-LINK', invoice_date: '2026-06-10', amount: 1070 });
  await inj('POST', '/api/finance/ap/transactions', admin, { vendor_name: 'ผู้ขายไม่มีเลขภาษี', txn_type: 'Service', invoice_no: 'PV-NOID', invoice_date: '2026-06-11', amount: 535 });
  await inj('POST', '/api/finance/ap/transactions', admin, { vendor_name: 'ยกเว้นภาษี', txn_type: 'Service', invoice_no: 'PV-EX', invoice_date: '2026-06-12', amount: 1000, vat_treatment: 'exempt' });

  const iv = await inj('GET', '/api/tax-reports/input-vat?month=6&year=2026', admin);
  const rows: any[] = iv.json.rows ?? [];
  const linked = rows.find((r) => r.invoice_no === 'PV-LINK');
  const noid = rows.find((r) => r.invoice_no === 'PV-NOID');
  const exempt = rows.find((r) => r.invoice_no === 'PV-EX');

  ok('linked bill: vendor Tax ID populated from vendor master (13-digit)', linked?.vendor_tax_id === VTAX, JSON.stringify({ got: linked?.vendor_tax_id, want: VTAX }));
  ok('linked bill: classified standard, vat 70', linked?.vat_type === 'standard' && near(linked?.vat, 70), JSON.stringify(linked));
  ok('name-only bill: vendor_tax_id null (surfaces the data gap)', noid && noid.vendor_tax_id === null, JSON.stringify(noid));
  ok('exempt bill: vat 0, classified exempt_or_zero (NOT fabricated 7/107)', exempt && near(exempt.vat, 0) && exempt.vat_type === 'exempt_or_zero', JSON.stringify(exempt));
  ok('totals.missing_tax_id counts the two Tax-ID-less rows', iv.json.totals?.missing_tax_id === 2, JSON.stringify(iv.json.totals));
  ok('totals: 3 rows, VAT = 70 (linked) + 35 (name-only) + 0 (exempt) = 105', iv.json.totals?.count === 3 && near(iv.json.totals?.vat, 105), JSON.stringify(iv.json.totals));

  console.log('\n── Wave 2 · 5.3 — input-VAT report (Tax ID + exempt) (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} input-vat checks failed` : `\n✅ All ${checks.length} input-vat checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
