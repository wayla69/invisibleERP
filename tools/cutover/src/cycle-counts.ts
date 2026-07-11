/**
 * Cutover check — INV-3 / INV-17: Cycle-count program with ABC classification + blind counts.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover cycle-counts
 *
 * Proves: ABC recompute tiers items by consumption value (A/B/C) → the due worklist honours the per-class
 * cadence → a generated count is BLIND (system/book qty never returned to the counter) → the variance posts
 * through the EXISTING INV-04 counter≠poster maker-checker with a valued GL adjustment → a self-post is blocked.
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e-secret';
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
import { PERMISSIONS, PERM_GROUPS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const grpOf = (k: string) => Object.entries(PERM_GROUPS).find(([, ks]) => (ks as string[]).includes(k))?.[0] ?? null;
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function seed(db: any) {
  const pw = new PasswordService();
  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k, grp: grpOf(k) }))).onConflictDoNothing();
  for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((perms as string[]).map((perm) => ({ role: role as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }]).onConflictDoNothing();
  const hq = (await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq.id },
  ]).onConflictDoNothing();
  await db.insert(s.items).values([
    { itemId: 'X', itemDescription: 'High-velocity widget', uom: 'EA', unitPrice: '10' },
    { itemId: 'Y', itemDescription: 'Mid widget', uom: 'EA', unitPrice: '10' },
    { itemId: 'Z', itemDescription: 'Slow widget', uom: 'EA', unitPrice: '10' },
  ]).onConflictDoNothing();
}

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  await seed(db);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const inj = async (method: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: method as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };

  const token = (await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' })).json.token;
  ok('login', !!token);

  // ── Establish valued stock (tracked items) + consumption of different magnitudes ──
  // X consumed 500 @ 10 = 5,000; Y consumed 50 @ 10 = 500; Z consumed 5 @ 10 = 50 → Pareto A / B / C.
  await inj('POST', '/api/inventory/receipts', token, { item_id: 'X', item_description: 'High-velocity widget', uom: 'EA', qty: 1000, unit_cost: 10, ref_type: 'GRN', ref_id: 'GRN-X' });
  await inj('POST', '/api/inventory/receipts', token, { item_id: 'Y', item_description: 'Mid widget', uom: 'EA', qty: 200, unit_cost: 10, ref_type: 'GRN', ref_id: 'GRN-Y' });
  await inj('POST', '/api/inventory/receipts', token, { item_id: 'Z', item_description: 'Slow widget', uom: 'EA', qty: 50, unit_cost: 10, ref_type: 'GRN', ref_id: 'GRN-Z' });
  await inj('POST', '/api/inventory/issue', token, { from_location: 'WH-MAIN', ref_doc: 'WO-X', lines: [{ item_id: 'X', uom: 'EA', qty: 500 }] });
  await inj('POST', '/api/inventory/issue', token, { from_location: 'WH-MAIN', ref_doc: 'WO-Y', lines: [{ item_id: 'Y', uom: 'EA', qty: 50 }] });
  await inj('POST', '/api/inventory/issue', token, { from_location: 'WH-MAIN', ref_doc: 'WO-Z', lines: [{ item_id: 'Z', uom: 'EA', qty: 5 }] });

  // ── ABC recompute → tiers ──
  const rec = await inj('POST', '/api/stock-ops/abc/recompute', token);
  ok('ABC recompute runs → 3 classified, A/B/C = 1/1/1', (rec.status === 200 || rec.status === 201) && rec.json.recomputed === 3 && rec.json.tiers?.A === 1 && rec.json.tiers?.B === 1 && rec.json.tiers?.C === 1, JSON.stringify(rec.json));

  const abc = await inj('GET', '/api/stock-ops/abc', token);
  const clsOf = (id: string) => abc.json.classes?.find((c: any) => c.item_id === id)?.class;
  ok('ABC classes: X=A (highest consumption value), Y=B, Z=C', clsOf('X') === 'A' && clsOf('Y') === 'B' && clsOf('Z') === 'C', `X=${clsOf('X')} Y=${clsOf('Y')} Z=${clsOf('Z')}`);
  ok('ABC annual_value for X = 5000 (500 × 10)', abc.json.classes?.find((c: any) => c.item_id === 'X')?.annual_value === 5000, JSON.stringify(abc.json.classes?.find((c: any) => c.item_id === 'X')));
  ok('default cadence plans seeded A=30 / B=90 / C=180', abc.json.plans?.find((p: any) => p.class === 'A')?.cadence_days === 30 && abc.json.plans?.find((p: any) => p.class === 'C')?.cadence_days === 180, JSON.stringify(abc.json.plans));

  // ── Due worklist: nothing counted yet → all three due ──
  const due0 = await inj('GET', '/api/stock-ops/cycle-counts/due', token);
  ok('due worklist lists all 3 never-counted items (A first)', due0.json.count === 3 && due0.json.due?.[0]?.item_id === 'X' && due0.json.due?.every((d: any) => d.never_counted === true), JSON.stringify(due0.json.due?.map((d: any) => d.item_id)));

  // ── Blind count generation: system/book qty is NEVER returned to the counter ──
  const gen = await inj('POST', '/api/stock-ops/cycle-counts', token, { item_ids: ['X'], counted_by: 'counter1' });
  ok('generate blind count task → CC- + linked ST-', (gen.status === 200 || gen.status === 201) && /^CC-\d{8}-\d{3}$/.test(gen.json.task_no) && /^ST-\d{8}-\d{3}$/.test(gen.json.st_no), JSON.stringify(gen.json));
  const blindItem = gen.json.items?.find((i: any) => i.item_id === 'X');
  ok('BLIND: generate response carries the item list but NO system/book qty', !!blindItem && blindItem.system_qty === undefined && !('system_qty' in (blindItem ?? {})), JSON.stringify(blindItem));
  const stNo = gen.json.st_no, taskNo = gen.json.task_no;

  // The linked stocktake IS blind on the wire too — the detail read does surface system_qty for the POSTER
  // (wh_adjust), but the counter's generate/worklist path never does. Confirm the stocktake was captured at book 500.
  const stCaptured = await db.select().from(s.stocktakes).where(eq(s.stocktakes.stNo, stNo));
  ok('server captured the book qty server-side (system_qty=500, hidden from counter)', stCaptured.length === 1 && Number(stCaptured[0].systemQty) === 500, `sys=${stCaptured[0]?.systemQty}`);

  // ── Blind count entry: counter submits physical 480 → hidden variance −20 ──
  const cnt = await inj('POST', `/api/stock-ops/cycle-counts/${taskNo}/count`, token, { lines: [{ item_id: 'X', physical_qty: 480 }] });
  ok('submit blind count → Counted, 1 variance line, points to the existing post path', cnt.json.status === 'Counted' && cnt.json.variance_lines === 1 && cnt.json.post_via === `/api/stocktake/${stNo}/post`, JSON.stringify(cnt.json));

  // ── Post via the EXISTING stocktake path — counter1 counted, admin (≠ counter1) posts ──
  const post = await inj('POST', `/api/stocktake/${stNo}/post`, token);
  ok('post via existing stocktake path → Posted + 1 variance movement + valued GL adjustment', post.json.status === 'Posted' && post.json.variance_movements === 1 && post.json.valued_lines === 1, JSON.stringify(post.json));
  const xVal = (await inj('GET', '/api/inventory/valuation', token)).json.items?.find((i: any) => i.item_id === 'X');
  ok('valued on-hand for X corrected to the count (480 @ 10 = 4800)', Number(xVal?.on_hand_qty) === 480 && Number(xVal?.total_value) === 4800, `qty=${xVal?.on_hand_qty} val=${xVal?.total_value}`);

  // ── Cadence honoured: X was just counted (class A cadence 30d) → drops off the due worklist ──
  const due1 = await inj('GET', '/api/stock-ops/cycle-counts/due', token);
  ok('due worklist honours cadence — freshly-counted A item X is no longer due', !due1.json.due?.some((d: any) => d.item_id === 'X') && due1.json.due?.some((d: any) => d.item_id === 'Y'), JSON.stringify(due1.json.due?.map((d: any) => d.item_id)));

  // ── Task list reflects Posted (derived from the linked stocktake) ──
  const tasks = await inj('GET', '/api/stock-ops/cycle-counts', token);
  ok('task list shows the cycle count as Posted', tasks.json.tasks?.find((tk: any) => tk.task_no === taskNo)?.status === 'Posted', JSON.stringify(tasks.json.tasks?.[0]));

  // ── INV-04 self-post blocked: the counter cannot post their own count ──
  const genSelf = await inj('POST', '/api/stock-ops/cycle-counts', token, { item_ids: ['Y'], counted_by: 'admin' });
  await inj('POST', `/api/stock-ops/cycle-counts/${genSelf.json.task_no}/count`, token, { lines: [{ item_id: 'Y', physical_qty: 140 }] });
  const selfPost = await inj('POST', `/api/stocktake/${genSelf.json.st_no}/post`, token);
  ok('INV-04 / R11: the counter cannot post their own cycle count → 403 SOD_SELF_APPROVAL', selfPost.status === 403 && selfPost.json.error?.code === 'SOD_SELF_APPROVAL', `${selfPost.status} ${selfPost.json.error?.code}`);

  await app.close();
  await pg.close();

  console.log('\n── INV-3 / INV-17 Cycle-count program (ABC + blind counts, PGlite) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
