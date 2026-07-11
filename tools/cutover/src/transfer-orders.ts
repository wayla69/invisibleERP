/**
 * Cutover check — INV-2 inter-warehouse/branch TRANSFER ORDERS with in-transit ownership + GL (control INV-16).
 * A two-step ship→receive move: ship books Dr 1255 Goods-in-Transit / Cr 1200 (source inventory) + relieves
 * source qty; receive books Dr 1200 (dest) / Cr 1255 + lands dest qty; the aging report lists unreceived TOs.
 * Custody SoD: the shipper may not receive their own transfer (SOD_SELF_APPROVAL).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover transfer-orders
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e-secret';
process.env.NODE_ENV = 'test';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, and, inArray } from 'drizzle-orm';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import * as s from '../../../apps/api/dist/database/schema/index';
import { AppModule } from '../../../apps/api/dist/app.module';
import { DRIZZLE, tenantAwareProxy } from '../../../apps/api/dist/database/database.module';
import { AllExceptionsFilter } from '../../../apps/api/dist/common/all-exceptions.filter';
import { PasswordService } from '../../../apps/api/dist/modules/auth/password.service';
import { LedgerService } from '../../../apps/api/dist/modules/ledger/ledger.service';
import { PERMISSIONS, PERM_GROUPS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const grpOf = (k: string) => Object.entries(PERM_GROUPS).find(([, ks]) => (ks as string[]).includes(k))?.[0] ?? null;
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });
const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.01;

async function seed(db: any) {
  const pw = new PasswordService();
  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k, grp: grpOf(k) }))).onConflictDoNothing();
  for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((perms as string[]).map((perm) => ({ role: role as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }]).onConflictDoNothing();
  const hq = (await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq.id },
    { username: 'shipper', passwordHash: await pw.hash('pw1'), role: 'Admin', tenantId: hq.id },
    { username: 'receiver', passwordHash: await pw.hash('pw2'), role: 'Admin', tenantId: hq.id },
  ]).onConflictDoNothing();
  await db.insert(s.items).values([{ itemId: 'A', itemDescription: 'Apple', uom: 'EA', unitPrice: '10' }]).onConflictDoNothing();
  return hq.id as number;
}

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const hq = await seed(db);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();

  const inj = async (method: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: method as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;

  // GL net (debit − credit) on an account for the INV-GIT source, tenant HQ.
  const glNet = async (account: string) => {
    const rows = await db.select({ d: s.journalLines.debit, c: s.journalLines.credit })
      .from(s.journalLines).innerJoin(s.journalEntries, eq(s.journalLines.entryId, s.journalEntries.id))
      .where(and(eq(s.journalLines.accountCode, account), eq(s.journalLines.tenantId, hq), eq(s.journalEntries.source, 'INV-GIT'), eq(s.journalEntries.status, 'Posted')));
    return rows.reduce((a: number, r: any) => a + Number(r.d) - Number(r.c), 0);
  };
  const balAt = async (loc: string) => {
    const [b] = await db.select().from(s.invBalances).where(and(eq(s.invBalances.tenantId, hq), eq(s.invBalances.itemId, 'A'), eq(s.invBalances.locationId, loc))).limit(1);
    return b ? { qty: Number(b.onHandQty), value: Number(b.totalValue) } : { qty: 0, value: 0 };
  };

  const admin = await login('admin', 'admin123');
  const shipper = await login('shipper', 'pw1');
  const receiver = await login('receiver', 'pw2');
  ok('logins', !!admin && !!shipper && !!receiver);

  // Establish tracked item A at WH-MAIN via a valued receipt: 100 @ 10 = 1000.
  await inj('POST', '/api/inventory/receipts', admin, { item_id: 'A', item_description: 'Apple', uom: 'EA', location_id: 'WH-MAIN', qty: 100, unit_cost: 10, ref_type: 'GRN', ref_id: 'GRN-A1' });
  const m0 = await balAt('WH-MAIN');
  ok('tracked item A established (WH-MAIN 100 @ 10 = 1000)', m0.qty === 100 && m0.value === 1000, `qty=${m0.qty} val=${m0.value}`);

  // ── Create ──
  const created = await inj('POST', '/api/stock-ops/transfer-orders', shipper, { from_location: 'WH-MAIN', to_location: 'WH-2', remarks: 'branch top-up', lines: [{ item_id: 'A', item_description: 'Apple', uom: 'EA', qty: 20 }] });
  ok('create transfer order → TO- + Draft', (created.status === 200 || created.status === 201) && /^TO-\d{8}-\d{3}$/.test(created.json.to_no) && created.json.status === 'Draft', `status=${created.status} no=${created.json.to_no} st=${created.json.status}`);
  const toNo = created.json.to_no;

  const sameLoc = await inj('POST', '/api/stock-ops/transfer-orders', shipper, { from_location: 'WH-1', to_location: 'WH-1', lines: [{ item_id: 'A', qty: 1 }] });
  ok('create same-location → 400 SAME_LOCATION', sameLoc.status === 400 && sameLoc.json?.error?.code === 'SAME_LOCATION', `status=${sameLoc.status}`);

  const draftDetail = await inj('GET', `/api/stock-ops/transfer-orders/${toNo}`, shipper);
  ok('detail shows Draft with the line (qty 20, no cost yet)', draftDetail.json.status === 'Draft' && draftDetail.json.lines?.[0]?.qty === 20 && draftDetail.json.lines?.[0]?.line_value === 0, JSON.stringify(draftDetail.json?.lines?.[0]));

  // Cannot receive a Draft.
  const recvDraft = await inj('POST', `/api/stock-ops/transfer-orders/${toNo}/receive`, receiver);
  ok('receive a Draft → 400 NOT_SHIPPED', recvDraft.status === 400 && recvDraft.json?.error?.code === 'NOT_SHIPPED', `status=${recvDraft.status} code=${recvDraft.json?.error?.code}`);

  // ── Ship ── (Dr 1255 / Cr 1200; source qty 100→80, value 1000→800; in-transit value 200)
  const shipped = await inj('POST', `/api/stock-ops/transfer-orders/${toNo}/ship`, shipper);
  ok('ship → Shipped + in_transit_value 200', (shipped.status === 200 || shipped.status === 201) && shipped.json.status === 'Shipped' && near(shipped.json.in_transit_value, 200) && shipped.json.valued_lines === 1, JSON.stringify(shipped.json));
  const m1 = await balAt('WH-MAIN');
  ok('ship relieves source (WH-MAIN 80 @ value 800)', m1.qty === 80 && near(m1.value, 800), `qty=${m1.qty} val=${m1.value}`);
  ok('ship books Dr 1255 Goods-in-Transit 200 (net)', near(await glNet('1255'), 200), `1255 net=${await glNet('1255')}`);
  ok('ship books Cr 1200 Inventory −200 (net)', near(await glNet('1200'), -200), `1200 net=${await glNet('1200')}`);
  ok('ship JE is balanced (Dr 1255 = −Cr 1200)', near((await glNet('1255')) + (await glNet('1200')), 0));

  // Re-ship a Shipped order → NOT_DRAFT.
  const reship = await inj('POST', `/api/stock-ops/transfer-orders/${toNo}/ship`, shipper);
  ok('re-ship a Shipped order → 400 NOT_DRAFT', reship.status === 400 && reship.json?.error?.code === 'NOT_DRAFT', `status=${reship.status} code=${reship.json?.error?.code}`);

  // ── In-transit aging (cutoff report) lists the unreceived TO ──
  const aging1 = await inj('GET', '/api/stock-ops/transfer-orders/in-transit/aging', receiver);
  ok('aging lists the unreceived TO (open_count 1, value 200, bucket 0-7)', aging1.status === 200 && aging1.json.open_count === 1 && near(aging1.json.total_in_transit_value, 200) && aging1.json.items?.[0]?.to_no === toNo && aging1.json.items?.[0]?.aging_bucket === '0-7', JSON.stringify(aging1.json?.items?.[0] ?? aging1.json));

  // ── Custody SoD: the shipper may not receive their own transfer ──
  const selfRecv = await inj('POST', `/api/stock-ops/transfer-orders/${toNo}/receive`, shipper);
  ok('INV-16: shipper cannot receive own transfer → 403 SOD_SELF_APPROVAL', selfRecv.status === 403 && selfRecv.json?.error?.code === 'SOD_SELF_APPROVAL', `status=${selfRecv.status} code=${selfRecv.json?.error?.code}`);

  // ── Receive (independent user) ── (Dr 1200 dest / Cr 1255; dest qty +20, in-transit cleared)
  const received = await inj('POST', `/api/stock-ops/transfer-orders/${toNo}/receive`, receiver);
  ok('receive → Received + received_value 200', (received.status === 200 || received.status === 201) && received.json.status === 'Received' && near(received.json.received_value, 200) && received.json.valued_lines === 1, JSON.stringify(received.json));
  const wh2 = await balAt('WH-2');
  ok('receive lands dest (WH-2 20 @ value 200)', wh2.qty === 20 && near(wh2.value, 200), `qty=${wh2.qty} val=${wh2.value}`);
  ok('receive clears in-transit: 1255 net back to 0', near(await glNet('1255'), 0), `1255 net=${await glNet('1255')}`);
  ok('receive returns value to inventory: 1200 net back to 0 (over the two GIT legs)', near(await glNet('1200'), 0), `1200 net=${await glNet('1200')}`);

  const aging2 = await inj('GET', '/api/stock-ops/transfer-orders/in-transit/aging', receiver);
  ok('aging empty after receive (open_count 0)', aging2.json.open_count === 0 && near(aging2.json.total_in_transit_value, 0), JSON.stringify(aging2.json));

  // Perpetual sub-ledger still ties to GL inventory after the round-trip (total value 1000 across locations).
  const rec = (await inj('GET', '/api/inventory/reconciliation', receiver)).json;
  ok('sub-ledger ties to GL 1200 after the transfer round-trip (reconciled 1000)', near(rec.sub_ledger_value, 1000) && near(rec.gl_inventory, 1000) && rec.reconciled === true, `sub=${rec.sub_ledger_value} gl=${rec.gl_inventory} rec=${rec.reconciled}`);

  // ── Negative: ship more than on hand → NEG_STOCK (source unchanged) ──
  const bigTo = await inj('POST', '/api/stock-ops/transfer-orders', shipper, { from_location: 'WH-MAIN', to_location: 'WH-3', lines: [{ item_id: 'A', qty: 9999 }] });
  const bigShip = await inj('POST', `/api/stock-ops/transfer-orders/${bigTo.json.to_no}/ship`, shipper);
  ok('ship > on-hand → 400 NEG_STOCK', bigShip.status === 400 && bigShip.json?.error?.code === 'NEG_STOCK', `status=${bigShip.status} code=${bigShip.json?.error?.code}`);

  await app.close();
  await pg.close();

  console.log('\n── INV-2 inter-warehouse transfer orders + in-transit GL (INV-16, PGlite) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
