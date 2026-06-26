/**
 * Labor — Shift scheduling / roster + labor % (จัดตารางเวร + แรงงาน%) over PGlite (W4):
 * plan shifts (hours from start/end), a labor summary sums scheduled hours×rate and computes labor % of
 * sales + scheduled-vs-actual (time_clock) hours. Operational — no GL. Tenant-scoped (RLS).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover scheduling
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'sched-secret';
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'mgr1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: t1 },   // pos/exec — manager
    { username: 'mgr2', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t2 },
  ]).onConflictDoNothing();
  // seed sales for T1 in the window (total 10,000) so labor % is computable
  await db.insert(s.custPosSales).values([
    { tenantId: t1, saleNo: 'SALE-A', saleDate: '2026-07-01', subtotal: '6000', total: '6000' },
    { tenantId: t1, saleNo: 'SALE-B', saleDate: '2026-07-02', subtotal: '4000', total: '4000' },
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
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const mgr1 = await login('mgr1', 'pw1');
  const mgr2 = await login('mgr2', 'pw2');

  // ── 1. create shifts: A 09:00–17:00 (8h @100) + B 17:00–01:00 overnight (8h @120) ──
  const sa = await inj('POST', '/api/pos/labor/shifts', mgr1, { emp_code: 'A', shift_date: '2026-07-01', start_time: '09:00', end_time: '17:00', hourly_rate: 100, position: 'cook' });
  const sb = await inj('POST', '/api/pos/labor/shifts', mgr1, { emp_code: 'B', shift_date: '2026-07-01', start_time: '17:00', end_time: '01:00', hourly_rate: 120, position: 'server' });
  ok('Shift: 8h day computed from 09:00–17:00', near(sa.json.hours, 8) && sa.json.status === 'scheduled', JSON.stringify(sa.json).slice(0, 80));
  ok('Shift: overnight 17:00–01:00 = 8h (crosses midnight)', near(sb.json.hours, 8), `hours=${sb.json.hours}`);

  // ── 2. bad time format rejected ──
  const bad = await inj('POST', '/api/pos/labor/shifts', mgr1, { emp_code: 'A', shift_date: '2026-07-01', start_time: '9am', end_time: '17:00' });
  ok('Shift: bad time format rejected (400)', bad.status === 400, `${bad.status} ${bad.json.error?.code}`);

  // ── 3. labor summary: 16h scheduled, cost 8×100 + 8×120 = 1760, sales 10000 → labor 17.6% ──
  const sum = await inj('GET', '/api/pos/labor/labor-summary?from=2026-07-01&to=2026-07-07', mgr1);
  ok('Labor summary: 16h scheduled, cost 1760, sales 10000, labor 17.6%', near(sum.json.scheduled_hours, 16) && near(sum.json.scheduled_cost, 1760) && near(sum.json.sales, 10000) && near(sum.json.labor_pct, 17.6), JSON.stringify(sum.json).slice(0, 140));
  ok('Labor summary: by-staff A 800 / B 960', near(sum.json.by_staff.find((x: any) => x.emp_code === 'A')?.cost, 800) && near(sum.json.by_staff.find((x: any) => x.emp_code === 'B')?.cost, 960), JSON.stringify(sum.json.by_staff));

  // ── 4. cancel a shift → excluded from the labor summary ──
  await inj('POST', `/api/pos/labor/shifts/${sb.json.id}/cancel`, mgr1);
  const sum2 = await inj('GET', '/api/pos/labor/labor-summary?from=2026-07-01&to=2026-07-07', mgr1);
  ok('Cancel: cancelled shift excluded → 8h, cost 800, labor 8%', near(sum2.json.scheduled_hours, 8) && near(sum2.json.scheduled_cost, 800) && near(sum2.json.labor_pct, 8), JSON.stringify(sum2.json).slice(0, 110));

  // ── 5. list shifts (incl. cancelled) ──
  const list = await inj('GET', '/api/pos/labor/shifts?from=2026-07-01&to=2026-07-07', mgr1);
  ok('List: 2 shifts in the week', list.json.count === 2, `count=${list.json.count}`);

  // ── 6. RLS: T2 sees none of T1's shifts ──
  const t2list = await inj('GET', '/api/pos/labor/shifts?from=2026-07-01&to=2026-07-07', mgr2);
  ok('RLS: T2 sees 0 of T1 shifts', t2list.json.count === 0, `t2=${t2list.json.count}`);

  await app.close();
  await pg.close();
  console.log('\n── Labor Shift scheduling + labor % (จัดตารางเวร + แรงงาน%) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} scheduling checks failed` : `\n✅ All ${checks.length} scheduling checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
