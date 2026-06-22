/**
 * Phase 17C — SCM depth. GR→putaway derived tasks + wave-consolidated shipment. Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover scm17c
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'scm17c-secret';
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }]).onConflictDoNothing();
  const hq = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0].id);
  await db.insert(s.users).values([{ username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq }]).onConflictDoNothing();

  // seed a GR (2 lines received into Receiving) + a wave with 2 packed shipments
  await db.insert(s.stockMovements).values([
    { moveDate: new Date(), docNo: 'GR-1', moveType: 'GR', itemId: 'ITEM-A', itemDescription: 'สินค้า A', qty: '100', uom: 'pcs', toLocation: 'Receiving' },
    { moveDate: new Date(), docNo: 'GR-1', moveType: 'GR', itemId: 'ITEM-B', itemDescription: 'สินค้า B', qty: '50', uom: 'pcs', toLocation: 'Receiving' },
  ]);
  const [wave] = await db.insert(s.pickWaves).values({ tenantId: hq, waveNo: 'WAVE-X1', status: 'Open', orderCount: 2 }).returning({ id: s.pickWaves.id });
  await db.insert(s.shipments).values([
    { tenantId: hq, shipmentNo: 'SHP-X1', waveId: Number(wave.id), sourceType: 'POS', sourceRef: 'SALE-1', status: 'Packed' },
    { tenantId: hq, shipmentNo: 'SHP-X2', waveId: Number(wave.id), sourceType: 'POS', sourceRef: 'SALE-2', status: 'Packed' },
  ]);

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
  const admin = (await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' })).json.token;

  // bin to put away into
  await inj('POST', '/api/wms/bins', admin, { bin_code: 'A-01-01' });

  // ── 1. GR → putaway: pending shows both received lines ──
  const p0 = await inj('GET', '/api/wms/putaway/pending/GR-1', admin);
  const a = (p0.json.tasks ?? []).find((t: any) => t.item_id === 'ITEM-A');
  ok('Pending putaway from GR → 2 tasks (A 100, B 50), bin suggested',
    p0.json.count === 2 && near(a?.pending_qty, 100) && a?.suggested_bin === 'A-01-01',
    JSON.stringify({ n: p0.json.count, a: a?.pending_qty }));

  // ── 2. put A away → pending drops to 1 (only B left) ──
  await inj('POST', '/api/wms/putaway', admin, { gr_no: 'GR-1', bin_code: 'A-01-01', item_id: 'ITEM-A', qty: 100, uom: 'pcs' });
  const p1 = await inj('GET', '/api/wms/putaway/pending/GR-1', admin);
  ok('After putaway A → pending = 1 (only ITEM-B)', p1.json.count === 1 && p1.json.tasks[0].item_id === 'ITEM-B', JSON.stringify({ n: p1.json.count }));

  // ── 3. wave-consolidated ship → both shipments shipped under one tracking ──
  const shipped = await inj('POST', '/api/wms/waves/WAVE-X1/ship', admin, { carrier: 'Kerry', tracking_no: 'TRK-999' });
  ok('Ship wave → 2 shipments consolidated, 2 shipped, one tracking',
    shipped.json.consolidated_shipments === 2 && shipped.json.shipped === 2 && shipped.json.tracking_no === 'TRK-999',
    JSON.stringify(shipped.json));

  // ── 4. both shipment rows + the wave are now Shipped ──
  const sh = await db.select().from(s.shipments).where(eq(s.shipments.waveId, Number(wave.id)));
  const [wv] = await db.select().from(s.pickWaves).where(eq(s.pickWaves.id, Number(wave.id)));
  ok('Both shipments + wave marked Shipped, tracking propagated',
    sh.every((x: any) => x.status === 'Shipped' && x.trackingNo === 'TRK-999') && wv.status === 'Shipped',
    JSON.stringify({ statuses: sh.map((x: any) => x.status), wave: wv.status }));

  console.log('\n── Phase 17C — SCM depth (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} 17C checks failed` : `\n✅ All ${checks.length} 17C checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
