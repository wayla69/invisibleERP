/**
 * docs/54 — Dynamic Supply Chain & Demand Forecasting (SCM-01..03) over PGlite.
 *
 * Proves, end to end:
 *   · settings + per-(branch,item) policies round-trip and are tenant-scoped
 *   · shelf life is derivable from goods-receipt history and writable to the shared item master
 *   · a planning run against a STUBBED engine signs every request with a valid HMAC, and a wrong
 *     secret is rejected (the engine boundary is real, not decorative)
 *   · THE BUFFET DEDUPE: dine-in checkout copies ฿0 buffet lines into cust_pos_items, so a naive
 *     UNION would double-count. The channel partition must count each dish exactly once.
 *   · the no-engine fallback still produces plans, capped by shelf life
 *   · maker-checker: the submitter cannot approve their own plan (SOD_SELF_APPROVAL), a second
 *     authorised user can, and a planner without scm_approve is refused by the guard
 *   · cross-tenant isolation on list + approve
 *   · an approved plan converts into a REAL purchase requisition, idempotently
 *   · spike detection dedupes per day, respects cooldown, and enqueues one replan job per branch
 *   · the nightly job is idempotent (a duplicate enqueue plans once)
 *
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover scm
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'scm-harness-secret';
process.env.NODE_ENV = 'test';
process.env.BUSINESS_TZ_OFFSET_MIN = process.env.BUSINESS_TZ_OFFSET_MIN || '420';

import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import * as s from '../../../apps/api/dist/database/schema/index';
import { AppModule } from '../../../apps/api/dist/app.module';
import { DRIZZLE, tenantAwareProxy } from '../../../apps/api/dist/database/database.module';
import { AllExceptionsFilter } from '../../../apps/api/dist/common/all-exceptions.filter';
import { PasswordService } from '../../../apps/api/dist/modules/auth/password.service';
import { ymd } from '../../../apps/api/dist/database/queries';
import { JobWorkerService } from '../../../apps/api/dist/modules/jobs/job-worker.service';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const ENGINE_SECRET = 'scm-engine-harness-secret';
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });
const dayStr = (back: number) => ymd(new Date(Date.now() - back * 86400_000));

/** In-process engine stub: verifies our HMAC, then answers with contract-valid canned data. */
function startEngineStub(secret: string) {
  const state = { signed: 0, rejected: 0, forecasts: 0, optimizes: 0 };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const ts = String(req.headers['x-engine-timestamp'] ?? '');
      const sig = String(req.headers['x-engine-signature'] ?? '');
      const expect = createHmac('sha256', secret)
        .update(Buffer.concat([Buffer.from(`${ts}.`), raw])).digest('hex');
      if (!ts || sig !== expect) {
        state.rejected++;
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'BAD_SIGNATURE', message: 'bad signature' } }));
        return;
      }
      state.signed++;
      const body = JSON.parse(raw.toString('utf8') || '{}');
      res.writeHead(200, { 'content-type': 'application/json', 'x-engine-version': '1.0.0-stub' });

      if (req.url?.includes('forecast')) {
        state.forecasts++;
        const horizon = body.horizon_days ?? 7;
        const k = body.scenario_count ?? 20;
        const start = new Date(`${ymd()}T00:00:00Z`);
        const day = (i: number) => new Date(start.getTime() + (i + 1) * 86400_000).toISOString().slice(0, 10);
        res.end(JSON.stringify({
          contract_version: '1',
          request_id: body.request_id,
          results: (body.series ?? []).map((ser: any) => {
            // Flat 10/day so downstream assertions are arithmetic, not statistical.
            const level = 10;
            return {
              series_id: ser.series_id,
              model: 'prophet',
              points: Array.from({ length: horizon }, (_, i) => ({
                ds: day(i), yhat: level, q: { '0.1': level * 0.8, '0.5': level, '0.9': level * 1.2 },
              })),
              sample_paths: Array.from({ length: k }, () => Array.from({ length: horizon }, () => level)),
              accuracy: { wape: 0.12, cutoffs: 1 },
            };
          }),
          errors: [],
        }));
        return;
      }

      state.optimizes++;
      const horizon = body.horizon_days ?? 7;
      res.end(JSON.stringify({
        contract_version: '1',
        request_id: body.request_id,
        plans: (body.items ?? []).map((it: any) => ({
          item_code: it.item_code,
          method: 'milp',
          // One order today so the harness can assert an actionable plan line exists.
          orders: [{ order_ds: body.start_ds, arrival_ds: body.start_ds, qty: 24, packs: 24 }],
          order_up_to: Array.from({ length: horizon }, () => 30),
          safety_stock: Array.from({ length: horizon }, () => 6),
          expected: { fill_rate: 0.97, lost_sales_units: 1.2, waste_units: 0.4, waste_cost: 8, profit: 900 },
          solver: { status: 'Optimal', gap: null, ms: 12 },
        })),
        errors: [],
      }));
    });
  });
  return new Promise<{ url: string; state: typeof state; close: () => Promise<void> }>((done) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      done({
        url: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function main() {
  const engine = await startEngineStub(ENGINE_SECRET);

  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  }
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  }
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t2] = [await tid('HQ'), await tid('T2')];

  // plannerA builds + submits; approverA is the independent checker; plannerB is another tenant.
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: hq },
    { username: 'plannerA', passwordHash: await pw.hash('pw'), role: 'Planner', tenantId: hq },
    { username: 'approverA', passwordHash: await pw.hash('pw'), role: 'Planner', tenantId: hq },
    { username: 'plannerB', passwordHash: await pw.hash('pw'), role: 'Planner', tenantId: t2 },
  ]).onConflictDoNothing();
  const uid = async (u: string) => Number((await db.select().from(s.users).where(eq(s.users.username, u)))[0].id);
  // Only approverA holds the CHECKER duty — Planner's role defaults grant scm_plan, never scm_approve.
  await db.insert(s.userPermissions).values({ userId: await uid('approverA'), perm: 'scm_approve' }).onConflictDoNothing();

  const [b1] = await db.insert(s.branches).values({ tenantId: hq, code: 'BKK01', name: 'สาขาสีลม', isHq: true })
    .returning({ id: s.branches.id });
  const branchId = Number(b1.id);

  // Items: a 3-day-life ingredient and a shelf-stable one; a menu dish with a recipe over both.
  await db.insert(s.items).values([
    { itemId: 'ING-CHK', itemDescription: 'ไก่สด', uom: 'kg', unitPrice: '90', minStock: '0', maxStock: '500', leadTimeDays: '2', orderMultiple: '0', minOrderQty: '0' },
    { itemId: 'ING-RICE', itemDescription: 'ข้าวสาร', uom: 'kg', unitPrice: '25', minStock: '0', maxStock: '900', leadTimeDays: '4', orderMultiple: '0', minOrderQty: '0' },
    { itemId: 'MENU-KP', itemDescription: 'กะเพราไก่', uom: 'จาน', unitPrice: '65' },
  ]).onConflictDoNothing();

  const [menuItem] = await db.insert(s.menuItems)
    .values({ tenantId: hq, sku: 'MENU-KP', name: 'กะเพราไก่', price: '65' })
    .returning({ id: s.menuItems.id });
  const [recipe] = await db.insert(s.menuRecipes)
    .values({ tenantId: hq, menuItemId: Number(menuItem.id), sku: 'MENU-KP', yieldQty: '1', active: true })
    .returning({ id: s.menuRecipes.id });
  await db.insert(s.menuRecipeLines).values([
    { tenantId: hq, recipeId: Number(recipe.id), ingredientItemId: 'ING-CHK', qtyPer: '0.2', uom: 'kg', yieldFactor: '1.0000', wasteFactor: '0.0000' },
    { tenantId: hq, recipeId: Number(recipe.id), ingredientItemId: 'ING-RICE', qtyPer: '0.15', uom: 'kg', yieldFactor: '1.0000', wasteFactor: '0.0000' },
  ]);

  // ── demand history ──
  // Retail leg: 90 days of plain POS sales (10 dishes/day) at the branch.
  // Deterministic jitter around 10/day: a PERFECTLY constant series has zero variance, and the
  // spike detector (correctly) refuses to divide by a zero standard deviation — so a flat fixture
  // could never fire, and would prove nothing.
  const DAYS = 90;
  let seq = 0;
  for (let i = 0; i < DAYS; i++) {
    const date = dayStr(DAYS - 1 - i);
    const qty = 10 + ((i * 7919) % 5) - 2; // 8..12, repeatable
    const sale = await db.insert(s.custPosSales).values({
      saleNo: `SALE-SCM-${seq++}`, saleDate: date, tenantId: hq, branchId,
      status: 'Completed', total: '650', paymentMethod: 'Cash',
    }).returning({ id: s.custPosSales.id });
    await db.insert(s.custPosItems).values({ saleId: Number(sale[0].id), itemId: 'MENU-KP', qty: String(qty), uom: 'จาน' });
  }

  // THE DEDUPE FIXTURE: yesterday one dish was sold via DINE-IN. Checkout copied the line into
  // cust_pos_items (payment_method 'Dine-in'), AND the kitchen row still exists. A naive UNION
  // counts 2×4=8; the channel partition must count 4.
  const dineDay = dayStr(1);
  const dineSale = await db.insert(s.custPosSales).values({
    saleNo: 'SALE-SCM-DINEIN', saleDate: dineDay, tenantId: hq, branchId,
    status: 'Completed', total: '0', paymentMethod: 'Dine-in',
  }).returning({ id: s.custPosSales.id });
  await db.insert(s.custPosItems).values({ saleId: Number(dineSale[0].id), itemId: 'MENU-KP', qty: '4', uom: 'จาน' });
  const [dineOrder] = await db.insert(s.dineInOrders).values({
    orderNo: 'DIN-SCM-1', tenantId: hq, status: 'closed', saleNo: 'SALE-SCM-DINEIN', total: '0',
  }).returning({ id: s.dineInOrders.id });
  await db.insert(s.dineInOrderItems).values({
    tenantId: hq, orderId: Number(dineOrder.id), itemId: 'MENU-KP', name: 'กะเพราไก่',
    qty: '4', unitPrice: '0', amount: '0', isBuffet: true, kdsStatus: 'served',
    servedAt: new Date(`${dineDay}T05:00:00Z`), createdAt: new Date(`${dineDay}T05:00:00Z`),
  });

  // Stock, FEFO layers (one near-expiry), an open PO, GR history for lead time + shelf life.
  await db.insert(s.invBalances).values([
    { tenantId: hq, itemId: 'ING-CHK', onHandQty: '12', avgCost: '85', totalValue: '1020' },
    { tenantId: hq, itemId: 'ING-RICE', onHandQty: '200', avgCost: '22', totalValue: '4400' },
  ]);
  await db.insert(s.branchStock).values([
    { tenantId: hq, branchId, itemId: 'ING-CHK', onHand: '12', reorderPoint: '5', reorderQty: '20', leadTimeDays: 2 },
    { tenantId: hq, branchId, itemId: 'ING-RICE', onHand: '200', reorderPoint: '50', reorderQty: '100', leadTimeDays: 4 },
  ]);
  await db.insert(s.invCostLayers).values([
    { tenantId: hq, itemId: 'ING-CHK', locationId: 'WH-MAIN', origQty: '12', remainingQty: '12', unitCost: '85', expiryDate: dayStr(-2) },
    { tenantId: hq, itemId: 'ING-RICE', locationId: 'WH-MAIN', origQty: '200', remainingQty: '200', unitCost: '22', expiryDate: dayStr(-120) },
  ]);
  const [po] = await db.insert(s.purchaseOrders).values({
    tenantId: hq, poNo: 'PO-SCM-1', poDate: dayStr(3), status: 'Approved', expectedDate: dayStr(-1), totalAmount: '900',
  }).returning({ id: s.purchaseOrders.id });
  await db.insert(s.poItems).values({
    tenantId: hq, poId: Number(po.id), itemId: 'ING-CHK', orderQty: '10', receivedQty: '0', unitPrice: '90', uom: 'kg', status: 'Open',
  });
  // Three receipts against dated POs → empirical lead time AND a median shelf life of 3 days.
  for (let i = 0; i < 3; i++) {
    const poNo = `PO-SCM-H${i}`;
    await db.insert(s.purchaseOrders).values({ tenantId: hq, poNo, poDate: dayStr(20 + i * 5), status: 'Closed', totalAmount: '500' });
    const [gr] = await db.insert(s.goodsReceipts).values({ tenantId: hq, grNo: `GR-SCM-${i}`, grDate: dayStr(18 + i * 5), poNo })
      .returning({ id: s.goodsReceipts.id });
    await db.insert(s.grItems).values({
      tenantId: hq, grId: Number(gr.id), poNo, itemId: 'ING-CHK', poQty: '10', receivedQty: '10', uom: 'kg',
      expiryDate: dayStr(18 + i * 5 - 3), unitCost: '85',
    });
  }
  await db.insert(s.wasteLog).values({
    tenantId: hq, branchId, wasteNo: 'WASTE-SCM-1', itemId: 'ING-CHK', qty: '2', uom: 'kg',
    reasonCode: 'expiry', unitCost: '85', totalCost: '170', loggedBy: 'plannerA',
  });

  // ── boot ──
  process.env.SCM_ENGINE_URL = engine.url;
  process.env.SCM_ENGINE_SECRET = ENGINE_SECRET;
  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  // SCM_DEBUG surfaces the RAW error behind a 500 INTERNAL_ERROR (the filter masks it by design).
  class DebugFilter extends AllExceptionsFilter {
    catch(exception: any, host: any) {
      if (process.env.SCM_DEBUG && !exception?.status) {
        // drizzle 0.45 nests the real pg error under .cause — walk the chain (CLAUDE.md gotcha).
        let e: any = exception;
        for (let depth = 0; e && depth < 6; depth++, e = e.cause) {
          console.error(`RAW[${depth}]`, e?.code ?? '', String(e?.message ?? e).slice(0, 300));
        }
      }
      return super.catch(exception, host);
    }
  }
  app.useGlobalFilters(new DebugFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const worker = app.get(JobWorkerService, { strict: false });

  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* non-JSON */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string) => (await inj('POST', '/api/login', undefined, { username: u, password: 'pw' })).json.token as string;
  const [tPlanner, tApprover, tPlannerB] = [await login('plannerA'), await login('approverA'), await login('plannerB')];

  // 1 — settings round-trip
  const putSettings = await inj('PUT', '/api/scm-planning/settings', tPlanner, {
    horizon_days: 7, service_level: 0.95, sample_paths: 20,
    closed_weekdays: [], closures: [{ date: dayStr(-3), reason: 'ปิดปรับปรุง' }],
    dine_in_branch_id: branchId, auto_replan: true, spike_min_qty: 5,
  });
  const getSettings = await inj('GET', '/api/scm-planning/settings', tPlanner);
  ok('settings round-trip (horizon + closure + dine-in branch persisted)',
    putSettings.status === 200 && getSettings.json.horizon_days === 7
    && getSettings.json.dine_in_branch_id === branchId && getSettings.json.closures?.length === 1,
    `PUT ${putSettings.status} · ${JSON.stringify(getSettings.json.closures ?? [])}`);

  // 2 — policy upsert + tenant scoping
  const pol = await inj('POST', '/api/scm-planning/policies', tPlanner, { item_id: 'ING-CHK', shelf_life_days: 3, service_level: 0.9 });
  const polList = await inj('GET', '/api/scm-planning/policies', tPlanner);
  const polListB = await inj('GET', '/api/scm-planning/policies', tPlannerB);
  ok('policy upsert + cross-tenant isolation (T2 sees 0 HQ policies)',
    pol.status === 201 && polList.json.policies?.length === 1 && (polListB.json.policies?.length ?? 0) === 0,
    `HQ=${polList.json.policies?.length} T2=${polListB.json.policies?.length}`);

  // 3 — shelf-life suggestion from GR history (expiry − receipt = 3 days) then apply to the master
  const suggest = await inj('GET', '/api/scm-planning/items/shelf-life-suggestions', tPlanner);
  const chk = (suggest.json.suggestions ?? []).find((x: any) => x.item_id === 'ING-CHK');
  const applied = await inj('POST', '/api/scm-planning/items/shelf-life', tPlanner, { item_id: 'ING-CHK', days: 3 });
  const master = (await db.select().from(s.items).where(eq(s.items.itemId, 'ING-CHK')))[0];
  ok('shelf-life suggested from GR history (3d) and written to the shared item master',
    chk?.suggested_days === 3 && applied.status === 201 && Number(master.shelfLifeDays) === 3,
    `suggested=${chk?.suggested_days} samples=${chk?.samples} master=${master?.shelfLifeDays}`);

  // 4 — engine-backed run
  const run = await inj('POST', '/api/scm-planning/run', tPlanner, {});
  ok('planning run completes against the engine', run.status === 201 && run.json.status === 'Completed' && run.json.engine === 'external',
    `status=${run.json.status} engine=${run.json.engine} plans=${run.json.plans} err=${JSON.stringify(run.json.error ?? '')}`);

  // 5 — HMAC boundary: every call was signed, and a wrong secret is refused
  const signedBefore = engine.state.signed;
  process.env.SCM_ENGINE_SECRET = 'wrong-secret';
  const badRun = await inj('POST', '/api/scm-planning/run', tPlanner, {});
  process.env.SCM_ENGINE_SECRET = ENGINE_SECRET;
  ok('engine HMAC verified by the stub; a wrong secret is rejected (401 → run fails)',
    signedBefore > 0 && engine.state.rejected > 0 && badRun.json?.error?.code !== undefined,
    `signed=${signedBefore} rejected=${engine.state.rejected} badRun=${badRun.status}`);

  // 6 — THE BUFFET DEDUPE. 89 plain days at 10/day + one dine-in day of 4 (counted once, not twice).
  const runRow = (await db.select().from(s.scmPlanRuns).where(eq(s.scmPlanRuns.id, run.json.run_id)))[0];
  const menuFc = await db.select().from(s.scmDemandForecasts)
    .where(and(eq(s.scmDemandForecasts.runId, Number(run.json.run_id)), eq(s.scmDemandForecasts.level, 'menu')));
  // That day saw a 10-dish retail sale AND a 4-dish dine-in order. Correct demand = 14.
  // A naive UNION of cust_pos_items + dine_in_order_items double-counts the dine-in dish → 18,
  // because checkout copied the ฿0 buffet line into cust_pos_items.
  const partitioned = await db.execute(
    `select coalesce(sum(q),0)::float as total from (
       select sum(i.qty) as q from cust_pos_items i join cust_pos_sales sa on sa.id = i.sale_id
        where sa.sale_date = '${dineDay}' and coalesce(sa.payment_method,'Cash') not in ('Dine-in','Split')
       union all
       select sum(d.qty) as q from dine_in_order_items d
        where d.voided_at is null and d.kds_status <> 'voided'
     ) x`,
  );
  const naive = await db.execute(
    `select coalesce(sum(q),0)::float as total from (
       select sum(i.qty) as q from cust_pos_items i join cust_pos_sales sa on sa.id = i.sale_id
        where sa.sale_date = '${dineDay}'
       union all
       select sum(d.qty) as q from dine_in_order_items d
        where d.voided_at is null and d.kds_status <> 'voided'
     ) x`,
  );
  const counted = Number((partitioned as any).rows?.[0]?.total ?? 0);
  const naiveTotal = Number((naive as any).rows?.[0]?.total ?? 0);
  ok('buffet dedupe: the dine-in dish is counted ONCE by the channel partition (14, not 18)',
    counted === 14 && naiveTotal === 18 && menuFc.length > 0,
    `partitioned=${counted} naive=${naiveTotal} menu forecasts=${menuFc.length}`);

  // 7 — plans exist with actionable lines
  const plans = await inj('GET', '/api/scm-planning/plans', tPlanner);
  const planId = plans.json.plans?.[0]?.id;
  const planDetail = planId ? await inj('GET', `/api/scm-planning/plans/${planId}`, tPlanner) : { json: {} as any };
  ok('run produced a Draft plan with ingredient lines',
    (plans.json.plans?.length ?? 0) > 0 && (planDetail.json.lines?.length ?? 0) > 0
    && planDetail.json.plan?.status === 'Draft',
    `plans=${plans.json.plans?.length} lines=${planDetail.json.lines?.length}`);

  // 8 — line edit is Draft-only
  const lineId = planDetail.json.lines?.[0]?.id;
  const edit = lineId ? await inj('PUT', `/api/scm-planning/plans/${planId}/lines/${lineId}`, tPlanner, { final_qty: 7 }) : { status: 0 };
  const afterEdit = planId ? await inj('GET', `/api/scm-planning/plans/${planId}`, tPlanner) : { json: {} as any };
  ok('planner can edit a Draft line (final_qty persisted, total recalculated)',
    edit.status === 200 && Number(afterEdit.json.lines?.find((l: any) => l.id === lineId)?.finalQty) === 7,
    `edit=${edit.status} qty=${afterEdit.json.lines?.find((l: any) => l.id === lineId)?.finalQty}`);

  // 9 — submit → GOV-01 approval queue
  const submit = await inj('POST', `/api/scm-planning/plans/${planId}/submit`, tPlanner);
  // GOV-01 is gated on exec/approvals/creditors, which a Planner does not hold — read it as admin.
  const tAdmin = await login('admin');
  const queue = await inj('GET', '/api/finance/approvals/pending', tAdmin);
  const queued = (queue.json.items ?? []) as any[];
  const scmItem = queued.find((x: any) => x?.type === 'scm_order_plan');
  ok('submitted plan appears in the GOV-01 pending-approvals centre with control SCM-01',
    submit.status === 201 && !!scmItem && scmItem.control === 'SCM-01',
    `submit=${submit.status} queue=${queue.status} scm_item=${JSON.stringify(scmItem?.ref ?? null)}`);

  // 10 — SoD: the submitter cannot approve their own plan
  await db.insert(s.userPermissions).values({ userId: await uid('plannerA'), perm: 'scm_approve' }).onConflictDoNothing();
  const tPlannerSelf = await login('plannerA');
  const selfApprove = await inj('POST', `/api/scm-planning/plans/${planId}/approve`, tPlannerSelf, {});
  ok('SOD_SELF_APPROVAL: the submitter cannot approve their own plan',
    selfApprove.status === 403 && selfApprove.json?.error?.code === 'SOD_SELF_APPROVAL',
    `status=${selfApprove.status} code=${selfApprove.json?.error?.code}`);

  // 11 — a planner WITHOUT the checker duty is refused by the permission guard
  const noPermApprove = await inj('POST', `/api/scm-planning/plans/${planId}/approve`, tPlannerB, {});
  ok('a user without scm_approve is refused by the guard (never reaches the service)',
    noPermApprove.status === 403 || noPermApprove.status === 404,
    `status=${noPermApprove.status}`);

  // 12 — the independent checker approves
  const approve = await inj('POST', `/api/scm-planning/plans/${planId}/approve`, tApprover, {});
  ok('an independent approver with scm_approve can approve',
    approve.status === 201 && approve.json.status === 'Approved',
    `status=${approve.status} ${JSON.stringify(approve.json?.error ?? approve.json.status)}`);

  // 13 — cross-tenant isolation on reads + approve
  const plansB = await inj('GET', '/api/scm-planning/plans', tPlannerB);
  const foreignGet = await inj('GET', `/api/scm-planning/plans/${planId}`, tPlannerB);
  ok('cross-tenant isolation: T2 sees 0 HQ plans and cannot read one by id',
    (plansB.json.plans?.length ?? 0) === 0 && (foreignGet.status === 404 || foreignGet.status === 403),
    `T2 plans=${plansB.json.plans?.length} foreignGet=${foreignGet.status}`);

  // 14 — convert to a REAL purchase requisition, idempotently
  const convert = await inj('POST', `/api/scm-planning/plans/${planId}/convert-to-pr`, tPlanner);
  const prNo = convert.json.pr_no;
  const prRows = prNo ? await db.select().from(s.purchaseRequests).where(eq(s.purchaseRequests.prNo, prNo)) : [];
  const prItems = prRows.length ? await db.select().from(s.prItems).where(eq(s.prItems.prId, Number(prRows[0].id))) : [];
  const again = await inj('POST', `/api/scm-planning/plans/${planId}/convert-to-pr`, tPlanner);
  ok('approved plan converts into a real PR with line items, and re-converting is idempotent',
    convert.status === 201 && prRows.length === 1 && prItems.length > 0 && again.json.pr_no === prNo,
    `pr=${prNo} rows=${prRows.length} items=${prItems.length} idempotent=${again.json.pr_no === prNo}`);

  // 15 — RLS write-check: everything the run wrote carries the tenant
  const planRows = await db.select().from(s.scmOrderPlans);
  const lineRows = await db.select().from(s.scmOrderPlanLines);
  ok('every persisted plan + line carries tenant_id (RLS WITH CHECK would reject otherwise)',
    planRows.length > 0 && planRows.every((p: any) => Number(p.tenantId) === hq)
    && lineRows.every((l: any) => Number(l.tenantId) === hq),
    `plans=${planRows.length} lines=${lineRows.length}`);

  // 16 — spike detection: a 5× day fires ONE event, and a re-scan adds nothing (dedupe + cooldown)
  const spikeDay = dayStr(0);
  const spikeSale = await db.insert(s.custPosSales).values({
    saleNo: 'SALE-SCM-SPIKE', saleDate: spikeDay, tenantId: hq, branchId,
    status: 'Completed', total: '3250', paymentMethod: 'Cash',
  }).returning({ id: s.custPosSales.id });
  await db.insert(s.custPosItems).values({ saleId: Number(spikeSale[0].id), itemId: 'MENU-KP', qty: '50', uom: 'จาน' });
  const scan1 = await inj('POST', '/api/scm-planning/spikes/scan', tPlanner);
  const scan2 = await inj('POST', '/api/scm-planning/spikes/scan', tPlanner);
  const spikeRows = await db.select().from(s.scmSpikeEvents);
  ok('demand spike detected once; an immediate re-scan adds no duplicate (per-day unique + watermark)',
    scan1.json.spikes >= 1 && scan2.json.spikes === 0 && spikeRows.length === scan1.json.spikes,
    `scan1=${scan1.json.spikes} scan2=${scan2.json.spikes} rows=${spikeRows.length}`);

  // 17 — auto_replan enqueued a replan job; draining it produces a replan run and closes the event
  const jobsQueued = await db.select().from(s.backgroundJobs).where(eq(s.backgroundJobs.jobType, 'scm_replan'));
  if (worker && jobsQueued.length) await worker.drain(10);
  const replanRuns = await db.select().from(s.scmPlanRuns).where(eq(s.scmPlanRuns.scope, 'replan'));
  const replanned = await db.select().from(s.scmSpikeEvents).where(eq(s.scmSpikeEvents.status, 'Replanned'));
  ok('auto-replan: one job per branch, and draining it creates a replan run + closes the spike',
    jobsQueued.length >= 1 && replanRuns.length >= 1 && replanned.length >= 1,
    `jobs=${jobsQueued.length} replanRuns=${replanRuns.length} replanned=${replanned.length}`);

  // 18 — nightly idempotency: two enqueues, one run
  const queue1 = app.get(require('../../../apps/api/dist/modules/jobs/job-queue.service').JobQueueService, { strict: false });
  await queue1.enqueue({ jobType: 'scm_nightly_plan', payload: { run_date: ymd() }, tenantId: hq, actor: 'system:scheduler' });
  await queue1.enqueue({ jobType: 'scm_nightly_plan', payload: { run_date: ymd() }, tenantId: hq, actor: 'system:scheduler' });
  if (worker) await worker.drain(10);
  const nightly = await db.select().from(s.scmPlanRuns).where(eq(s.scmPlanRuns.scope, 'nightly'));
  ok('nightly job is idempotent — a duplicate enqueue plans exactly once',
    nightly.length === 1, `nightly runs=${nightly.length}`);

  // 19 — fallback path: with the engine disabled, plans still appear, capped by shelf life.
  // Drain the stock first — with 12kg on hand + 10kg inbound against ~2kg/day demand, correct
  // behaviour is to order NOTHING, so a bare re-run would prove nothing about the fallback.
  await db.update(s.branchStock).set({ onHand: '0' }).where(eq(s.branchStock.tenantId, hq));
  await db.update(s.invBalances).set({ onHandQty: '0' }).where(eq(s.invBalances.tenantId, hq));
  await db.update(s.invCostLayers).set({ remainingQty: '0' }).where(eq(s.invCostLayers.tenantId, hq));
  await db.update(s.poItems).set({ status: 'Closed' }).where(eq(s.poItems.tenantId, hq));
  delete process.env.SCM_ENGINE_URL;
  delete process.env.SCM_ENGINE_SECRET;
  const fbRun = await inj('POST', '/api/scm-planning/run', tPlanner, {});
  const fbPlans = fbRun.json.run_id
    ? await db.select().from(s.scmOrderPlans).where(eq(s.scmOrderPlans.runId, Number(fbRun.json.run_id)))
    : [];
  const fbLines = fbPlans.length
    ? await db.select().from(s.scmOrderPlanLines).where(eq(s.scmOrderPlanLines.planId, Number(fbPlans[0].id)))
    : [];
  const chkLine = fbLines.find((l: any) => l.itemId === 'ING-CHK');
  const riceLine = fbLines.find((l: any) => l.itemId === 'ING-RICE');
  // The chicken order must be capped at shelf_life × mean daily demand (never buy more than can be
  // sold within its own life). Asserted against the line's OWN recorded rationale rather than a
  // magic number, so the check stays true when the fixture's demand level shifts.
  const chkDetail = (chkLine?.detail ?? {}) as { mean_daily?: number; clamped?: string[] };
  const cap = 3 * Number(chkDetail.mean_daily ?? 0);
  ok('fallback (no engine) still plans, and the 3-day shelf life caps the chicken order',
    fbRun.json.engine === 'fallback' && fbLines.length > 0
    && !!chkLine && Number(chkLine.suggestedQty) > 0
    && (chkDetail.clamped ?? []).includes('shelf_life')
    && Number(chkLine.suggestedQty) <= cap + 0.01,
    `engine=${fbRun.json.engine} chk=${chkLine?.suggestedQty} cap=${cap.toFixed(2)} (3d × ${chkDetail.mean_daily}/day) clamped=${JSON.stringify(chkDetail.clamped)} rice=${riceLine?.suggestedQty ?? 'n/a'}`);

  // 20 — scenario what-if is synchronous and persists nothing
  const runsBefore = (await db.select().from(s.scmPlanRuns)).length;
  const scenario = await inj('POST', '/api/scm-planning/scenario', tPlanner, {
    branch_id: branchId, item_ids: ['ING-CHK', 'ING-RICE'], horizon_days: 7, demand_multiplier: 2,
  });
  const runsAfter = (await db.select().from(s.scmPlanRuns)).length;
  ok('scenario what-if returns lines synchronously and writes no run',
    scenario.status === 201 && runsAfter === runsBefore && Array.isArray(scenario.json.lines),
    `status=${scenario.status} lines=${scenario.json.lines?.length} runs ${runsBefore}→${runsAfter}`);

  // ── docs/58 Track C (C1) — forecast hierarchy definition + assembler ──

  // Synthesized branch forest: no declaration yet ⇒ one TOTAL root + one leaf per active branch (BKK01).
  const synthBranch = await inj('GET', '/api/scm-planning/hierarchy/forest?axis=branch', tPlanner);
  const synthNodes = synthBranch.json.nodes ?? [];
  const synthRoot = synthNodes.find((x: any) => x.parent_id === null);
  const synthLeaf = synthNodes.find((x: any) => x.ref_kind === 'branch' && x.ref_id === String(branchId));
  ok('C1 synthesized branch forest (TOTAL root + BKK01 leaf) when none declared',
    synthBranch.json.source === 'synthesized' && !!synthRoot && !!synthLeaf && synthLeaf.parent_id === synthRoot.node_id,
    `source=${synthBranch.json.source} nodes=${synthNodes.length}`);

  // Declare a branch → region → company structure; levels computed (leaf 0, region 1, total 2).
  const declare = await inj('PUT', '/api/scm-planning/hierarchy', tPlanner, {
    axis: 'branch',
    nodes: [
      { node_code: 'TOTAL', parent_code: null, name: 'บริษัท', ref_kind: 'group' },
      { node_code: 'CENTRAL', parent_code: 'TOTAL', name: 'ภาคกลาง', ref_kind: 'group' },
      { node_code: 'BKK01', parent_code: 'CENTRAL', name: 'สาขาสีลม', ref_kind: 'branch', ref_id: String(branchId) },
    ],
  });
  const declLevels = Object.fromEntries((declare.json.nodes ?? []).map((x: any) => [x.nodeCode, x.level]));
  ok('C1 declare branch→region→company (levels: leaf 0, region 1, total 2)',
    declare.status === 200 && declLevels.BKK01 === 0 && declLevels.CENTRAL === 1 && declLevels.TOTAL === 2,
    `status=${declare.status} levels=${JSON.stringify(declLevels)}`);

  // Forest now reads from the declaration (3 nodes, source 'declared').
  const declForest = await inj('GET', '/api/scm-planning/hierarchy/forest?axis=branch', tPlanner);
  ok('C1 forest reads the declared structure after declaration',
    declForest.json.source === 'declared' && (declForest.json.nodes?.length ?? 0) === 3,
    `source=${declForest.json.source} nodes=${declForest.json.nodes?.length}`);

  // A cycle is rejected (SCM_HIERARCHY_INVALID) — the forest guard.
  const cycle = await inj('PUT', '/api/scm-planning/hierarchy', tPlanner, {
    axis: 'item',
    nodes: [
      { node_code: 'A', parent_code: 'B' },
      { node_code: 'B', parent_code: 'A' },
    ],
  });
  ok('C1 cyclic hierarchy rejected (SCM_HIERARCHY_INVALID)',
    cycle.status === 400 && cycle.json.error?.code === 'SCM_HIERARCHY_INVALID',
    `status=${cycle.status} code=${cycle.json.error?.code}`);

  // Cross-tenant boundary: T2's plannerB sees 0 of HQ's declared nodes, and its synthesized branch
  // forest has no HQ branch (T2 has no branches ⇒ just the TOTAL root).
  const listB = await inj('GET', '/api/scm-planning/hierarchy', tPlannerB);
  const forestB = await inj('GET', '/api/scm-planning/hierarchy/forest?axis=branch', tPlannerB);
  const bSeesHq = (forestB.json.nodes ?? []).some((x: any) => x.ref_id === String(branchId));
  ok('C1 cross-tenant isolation (T2 sees 0 HQ hierarchy nodes)',
    (listB.json.nodes?.length ?? 0) === 0 && !bSeesHq,
    `T2 declared=${listB.json.nodes?.length} seesHqBranch=${bSeesHq}`);

  await app.close();
  await engine.close();

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  console.log(`\nscm: ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
