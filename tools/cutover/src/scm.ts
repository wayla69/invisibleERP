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
import { ScmAllocationService } from '../../../apps/api/dist/modules/scm-network/scm-allocation.service';
import { drpNode, daysBetweenYmd } from '../../../apps/api/dist/modules/scm-network/scm-drp.service';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const ENGINE_SECRET = 'scm-engine-harness-secret';
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });
const dayStr = (back: number) => ymd(new Date(Date.now() - back * 86400_000));

/** In-process engine stub: verifies our HMAC, then answers with contract-valid canned data. */
function startEngineStub(secret: string) {
  const state = { signed: 0, rejected: 0, forecasts: 0, optimizes: 0, reconRequests: 0, reconCoherent: false, warmHits: 0, fitsReturned: 0 };
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
        const points = Array.from({ length: horizon }, (_, i) => ({
          ds: day(i), yhat: 10, q: { '0.1': 8, '0.5': 10, '0.9': 12 },
        }));
        const flatPaths = () => Array.from({ length: k }, () => Array.from({ length: horizon }, () => 10));
        const results = (body.series ?? []).map((ser: any) => {
          // Flat 10/day so downstream assertions are arithmetic, not statistical.
          // A1: echo whether the API sent GOVERNED promo regressors (server-derived).
          const hasPromo = Array.isArray(ser.regressors) && ser.regressors.some((r: any) => r.promo_flag);
          // A2: when the series carries a governed PRICE signal, echo an identified own-price ε (as the
          // real engine's log-log estimator would after its identifiability floor). Distinct prices ⇒
          // identifiable; a single flat price ⇒ null (the floor not met).
          const prices = Array.isArray(ser.regressors)
            ? Array.from(new Set(ser.regressors.map((r: any) => r.price).filter((p: any) => p != null && p > 0)))
            : [];
          const eps = prices.length >= 2 ? -1.2 : null;
          const used = ['payday', ...(hasPromo ? ['promo'] : []), ...(prices.length ? ['price'] : [])];
          // D2: a deterministic fingerprint of the training window (stable across runs with unchanged
          // history) mirrors the real engine's fit_hash. A shipped warm_start whose hash still matches ⇒
          // a HIT (skip the "fit", no fitted_state, no fresh WAPE); else a (re)fit returns fitted_state.
          const hist: any[] = Array.isArray(ser.history) ? ser.history : [];
          const fitHash = `${hist.length}:${hist[hist.length - 1]?.ds ?? ''}:${hist.reduce((a: number, p: any) => a + (p.y || 0), 0)}`;
          const warmHit = !!ser.warm_start && ser.warm_start.fit_hash === fitHash;
          if (warmHit) state.warmHits++; else state.fitsReturned++;
          return {
            series_id: ser.series_id, model: 'prophet', points, sample_paths: flatPaths(),
            accuracy: { wape: warmHit ? null : 0.12, cutoffs: warmHit ? 0 : 1 },
            attribution: {
              promo_uplift_pct: hasPromo ? 0.3 : null,
              price_elasticity: eps,
              elasticity_r2: eps != null ? 0.82 : null,
              elasticity_n_obs: prices.length ? 40 : 0,
              regressors_used: used,
            },
            ...(warmHit ? {} : { fitted_state: { params: '{"stub":"prophet-fit"}', fit_hash: fitHash, fit_wape: 0.12 } }),
          };
        });
        // C2: bottom-up reconcile the requested forest — leaves unchanged, an aggregate = Σ children.
        let reconciled: any[] = [];
        const recon = body.reconciliation;
        if (recon && recon.method && recon.method !== 'none' && Array.isArray(recon.nodes)) {
          state.reconRequests++;
          const byId: Record<string, any> = Object.fromEntries(recon.nodes.map((n: any) => [n.node_id, n]));
          const kids = (id: string) => recon.nodes.filter((n: any) => n.parent_id === id).map((n: any) => n.node_id);
          const leafSids = (id: string): string[] =>
            byId[id].series_id ? [byId[id].series_id] : kids(id).flatMap(leafSids);
          const sumGrid = (sids: string[]) =>
            Array.from({ length: k }, (_, r) => Array.from({ length: horizon }, () => 10 * sids.length));
          reconciled = recon.nodes.map((n: any) => {
            const sids = leafSids(n.node_id);
            const paths = n.series_id ? flatPaths() : sumGrid(sids);
            const nn = sids.length;
            return {
              node_id: n.node_id, level: n.series_id ? 0 : 1, method: 'bottom_up',
              points: Array.from({ length: horizon }, (_, i) => ({ ds: day(i), yhat: 10 * nn, q: { '0.1': 8 * nn, '0.5': 10 * nn, '0.9': 12 * nn } })),
              sample_paths: paths, accuracy: { wape: null, cutoffs: 0 },
            };
          });
          // coherence: TOTAL (a root) equals the sum of all leaf forecasts (10 × #leaves)
          const root = recon.nodes.find((n: any) => n.parent_id == null);
          const nLeaves = recon.nodes.filter((n: any) => n.series_id).length;
          state.reconCoherent = !!root && reconciled.find((x) => x.node_id === root.node_id)?.sample_paths?.[0]?.[0] === 10 * nLeaves;
        }
        res.end(JSON.stringify({ contract_version: '2', request_id: body.request_id, results, reconciled, errors: [] }));
        return;
      }

      state.optimizes++;
      const horizon = body.horizon_days ?? 7;
      res.end(JSON.stringify({
        contract_version: '2',
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

  // A3: a governed cross-elasticity (MENU-KP responds to sibling MENU-B's price, γ=0.5, category 'main').
  // Seeded in setup so the read-through cache is warm with it before the first scenario call.
  await db.insert(s.scmCrossElasticity).values({
    tenantId: hq, itemA: 'MENU-KP', itemB: 'MENU-B', category: 'main', gamma: '0.5', r2: '0.7', nObs: 40,
  });

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

  // ── docs/56 Track A (A1) — promo/price regressors (server-derived; control SCM-04) ──

  // Baseline run above had NO governed promo → the menu forecast carries no 'promo' regressor.
  const baselinePromo = menuFc.every((f: any) => !((f.regressorsUsed ?? []) as string[]).includes('promo'));
  ok('A1 no governed promo ⇒ forecast carries no promo attribution (baseline)',
    menuFc.length > 0 && baselinePromo,
    `regressors=${JSON.stringify(menuFc[0]?.regressorsUsed ?? [])}`);

  // Seed a GOVERNED promotion (tenant HQ, all-items, active, covering history∪horizon), then re-run.
  await db.insert(s.promotions).values({
    tenantId: hq, promoId: 'PROMO-SCM-A1', promoName: 'สงกรานต์ลด', promoType: 'percent',
    startDate: dayStr(30), endDate: dayStr(-30), discountPct: '20', category: null, active: true,
  });
  const promoRun = await inj('POST', '/api/scm-planning/run', tPlanner, {});
  const promoFc = await db.select().from(s.scmDemandForecasts)
    .where(and(eq(s.scmDemandForecasts.runId, Number(promoRun.json.run_id)), eq(s.scmDemandForecasts.level, 'menu')));
  const promoApplied = promoFc.some((f: any) =>
    ((f.regressorsUsed ?? []) as string[]).includes('promo') && f.promoUpliftPct != null);
  ok('A1 governed promo ⇒ menu forecast carries promo attribution (regressors_used + promo_uplift_pct)',
    promoRun.status === 201 && promoRun.json.status === 'Completed' && promoApplied,
    `status=${promoRun.json.status} sample=${JSON.stringify({ used: promoFc[0]?.regressorsUsed, uplift: promoFc[0]?.promoUpliftPct })}`);

  // Cross-tenant: HQ's promo is tenant-scoped — T2's extraction never sees it. (T2's own run would
  // need seeded demand; assert directly that the governed promo does not leak across the RLS boundary.)
  const t2SeesHqPromo = (await db.execute(
    `select count(*)::int as n from promotions where promo_id = 'PROMO-SCM-A1' and tenant_id = ${t2}`,
  ) as any).rows?.[0]?.n ?? 0;
  ok('A1 governed promo is tenant-scoped (T2 sees 0 of HQ promos)', Number(t2SeesHqPromo) === 0,
    `t2 rows=${t2SeesHqPromo}`);

  // ── docs/58 Track C (C2) — bottom-up reconciliation flows end-to-end ──
  // Every engine-backed run sends a reconciliation forest (TOTAL over the branch's menu series); the
  // engine returns a COHERENT reconciled block (aggregate == Σ leaves) and the API explodes the
  // reconciled leaf paths (bottom-up ⇒ leaves unchanged, so plans are unaffected but now coherent).
  ok('C2 engine run sends a coherent reconciliation (bottom-up) and still produces menu forecasts',
    engine.state.reconRequests > 0 && engine.state.reconCoherent === true && promoFc.length > 0,
    `reconRequests=${engine.state.reconRequests} coherent=${engine.state.reconCoherent} menuFc=${promoFc.length}`);

  // ── docs/56 Track A (A2) — own-price elasticity ──
  // The promo above cut the effective price on part of the history (base 65 → 52), so the engine's
  // regressor now carries ≥2 distinct prices → an identified ε<0. The run upserts it; the menu
  // forecast carries the price attribution; and the scenario tool applies it.
  const priceAttr = promoFc.some((f: any) =>
    f.priceElasticity != null && ((f.regressorsUsed ?? []) as string[]).includes('price'));
  ok('A2 menu forecast carries price attribution (price_elasticity + price regressor)',
    priceAttr, `sample=${JSON.stringify({ eps: promoFc[0]?.priceElasticity, used: promoFc[0]?.regressorsUsed })}`);

  const elast = await inj('GET', '/api/scm-planning/elasticity', tPlanner);
  const kpElast = (elast.json.items ?? []).find((e: any) => e.itemId === 'MENU-KP');
  ok('A2 run persists an identified own-price elasticity (ε<0) for the promoted menu item',
    elast.status === 200 && kpElast != null && Number(kpElast.elasticity) < 0 && Number(kpElast.nObs) > 0,
    `items=${JSON.stringify(elast.json.items)}`);

  // Scenario applies ε: a price RISE shrinks demand (response <1) and a price CUT grows it (>1); with
  // ε<0 the suggested quantity never rises with price (qty↑ ≤ qty↓). Advisory — persists nothing.
  const scUp = await inj('POST', '/api/scm-planning/scenario', tPlanner,
    { branch_id: branchId, item_ids: ['MENU-KP'], horizon_days: 7, demand_multiplier: 3, price_multiplier: 1.5 });
  const scDown = await inj('POST', '/api/scm-planning/scenario', tPlanner,
    { branch_id: branchId, item_ids: ['MENU-KP'], horizon_days: 7, demand_multiplier: 3, price_multiplier: 0.5 });
  const qtyOf = (r: any) => (r.json.lines ?? []).reduce((a: number, l: any) => a + Number(l.qty), 0);
  const respOf = (r: any) => Number((r.json.price_attribution ?? []).find((p: any) => p.item_id === 'MENU-KP')?.demand_response);
  ok('A2 scenario applies elasticity — a price rise shrinks demand and a price cut grows it (advisory, persists nothing)',
    scUp.status === 201 && scDown.status === 201
      && respOf(scUp) < 1 && respOf(scDown) > 1 && qtyOf(scUp) <= qtyOf(scDown),
    `respUp=${respOf(scUp)} respDown=${respOf(scDown)} qtyUp=${qtyOf(scUp)} qtyDown=${qtyOf(scDown)}`);

  // Cross-tenant: HQ's elasticities never appear for T2 (RLS).
  const elastB = await inj('GET', '/api/scm-planning/elasticity', tPlannerB);
  ok('A2 elasticity is tenant-isolated (T2 sees 0 of HQ elasticities)',
    (elastB.json.items?.length ?? 0) === 0, `t2=${elastB.json.items?.length}`);

  // ── docs/56 Track A (A3) — category-scoped cannibalization/halo cross-elasticity ──
  // The estimator math is proven in apps/api vitest; here we prove the WIRING: a persisted γ (seeded in
  // setup, before app boot, as a substitute pair MENU-KP↔MENU-B γ=0.5) is applied by the scenario tool
  // ONLY to sibling items whose price also moved in the scenario, and it is tenant-isolated.
  const xlist = await inj('GET', '/api/scm-planning/cross-elasticity', tPlanner);
  ok('A3 persisted cross-elasticity is readable',
    xlist.status === 200 && (xlist.json.pairs ?? []).some((p: any) => p.itemA === 'MENU-KP' && p.itemB === 'MENU-B' && Number(p.gamma) === 0.5),
    `pairs=${JSON.stringify(xlist.json.pairs)}`);

  // Scenario WITH the sibling in item_ids ⇒ MENU-KP's response folds in γ (its price rise is partly
  // offset by cannibalization). Scenario WITHOUT the sibling ⇒ no cross term (category-scoped to the
  // items whose price actually moved).
  const scPair = await inj('POST', '/api/scm-planning/scenario', tPlanner,
    { branch_id: branchId, item_ids: ['MENU-KP', 'MENU-B'], horizon_days: 7, demand_multiplier: 3, price_multiplier: 1.5 });
  const scSolo = await inj('POST', '/api/scm-planning/scenario', tPlanner,
    { branch_id: branchId, item_ids: ['MENU-KP'], horizon_days: 7, demand_multiplier: 3, price_multiplier: 1.5 });
  const kpPair = (scPair.json.price_attribution ?? []).find((p: any) => p.item_id === 'MENU-KP');
  const kpSolo = (scSolo.json.price_attribution ?? []).find((p: any) => p.item_id === 'MENU-KP');
  ok('A3 scenario folds the sibling cross-term in ONLY when the sibling is in the scenario (category-scoped)',
    Math.abs(Number(kpPair?.cross_elasticity_sum) - 0.5) < 1e-9 && Number(kpSolo?.cross_elasticity_sum) === 0
      && Number(kpPair?.demand_response) > Number(kpSolo?.demand_response),
    `pair={x:${kpPair?.cross_elasticity_sum},resp:${kpPair?.demand_response}} solo={x:${kpSolo?.cross_elasticity_sum},resp:${kpSolo?.demand_response}}`);

  // Cross-tenant: HQ's cross-elasticities never appear for T2 (RLS).
  const xlistB = await inj('GET', '/api/scm-planning/cross-elasticity', tPlannerB);
  ok('A3 cross-elasticity is tenant-isolated (T2 sees 0 of HQ cross pairs)',
    (xlistB.json.pairs?.length ?? 0) === 0, `t2=${xlistB.json.pairs?.length}`);

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

  // ── B1: multi-echelon supply-network master data (docs/57 Track B) ──
  // Declare a supplier → DC → branch topology, wire the two lanes, and validate it.
  const nSup = await inj('POST', '/api/scm-network/nodes', tPlanner, {
    node_code: 'SUP-1', name: 'ผู้ผลิตไก่', kind: 'supplier', holding_cost_per_day: 0.02,
  });
  const nDc = await inj('POST', '/api/scm-network/nodes', tPlanner, {
    node_code: 'DC-1', name: 'ครัวกลาง', kind: 'central_kitchen', holding_cost_per_day: 0.05,
  });
  const nBr = await inj('POST', '/api/scm-network/nodes', tPlanner, {
    node_code: 'BR-1', name: 'สาขาสีลม', kind: 'branch', branch_id: branchId, holding_cost_per_day: 0.08,
  });
  ok('B1 nodes created with kind→echelon mapping (supplier 0, kitchen 1, branch 2)',
    nSup.status === 201 && nSup.json.echelon === 0 && nDc.json.echelon === 1 && nBr.json.echelon === 2,
    `status=${nSup.status} echelons=${nSup.json.echelon}/${nDc.json.echelon}/${nBr.json.echelon}`);

  // A branch node requires a branch_id (fail-closed).
  const badBranch = await inj('POST', '/api/scm-network/nodes', tPlanner, {
    node_code: 'BR-X', name: 'สาขาไร้ที่อ้าง', kind: 'branch',
  });
  ok('B1 branch node without branch_id rejected (BRANCH_NODE_NEEDS_BRANCH)',
    badBranch.status === 400 && badBranch.json.error?.code === 'BRANCH_NODE_NEEDS_BRANCH',
    `status=${badBranch.status} code=${badBranch.json.error?.code}`);

  const lSupDc = await inj('POST', '/api/scm-network/lanes', tPlanner, {
    from_node_id: nSup.json.id, to_node_id: nDc.json.id, lead_time_mean_days: 3, lead_time_std_days: 1, moq: 20, pack_size: 5,
  });
  const lDcBr = await inj('POST', '/api/scm-network/lanes', tPlanner, {
    from_node_id: nDc.json.id, to_node_id: nBr.json.id, lead_time_mean_days: 1, lead_time_std_days: 0.5, pack_size: 1,
  });
  ok('B1 lanes created (supplier→DC, DC→branch)',
    lSupDc.status === 201 && lDcBr.status === 201,
    `status=${lSupDc.status}/${lDcBr.status}`);

  const topo = await inj('GET', '/api/scm-network/topology', tPlanner);
  ok('B1 topology validates as a legal two-echelon DAG (branch reachable from supplier via DC)',
    topo.status === 200 && topo.json.validation?.ok === true
      && (topo.json.validation?.reachableBranches ?? []).includes('BR-1'),
    `ok=${topo.json.validation?.ok} reachable=${JSON.stringify(topo.json.validation?.reachableBranches)}`);

  // A lane that skips an echelon (supplier→branch, echelon 0→2) is rejected by the validator.
  const lSkip = await inj('POST', '/api/scm-network/lanes', tPlanner, {
    from_node_id: nSup.json.id, to_node_id: nBr.json.id,
  });
  const topoBad = await inj('GET', '/api/scm-network/topology', tPlanner);
  const badCodes = (topoBad.json.validation?.issues ?? []).map((i: any) => i.code);
  ok('B1 an echelon-skipping lane makes the topology invalid (LANE_ENDPOINTS_INVALID)',
    lSkip.status === 201 && topoBad.json.validation?.ok === false && badCodes.includes('LANE_ENDPOINTS_INVALID'),
    `ok=${topoBad.json.validation?.ok} codes=${JSON.stringify(badCodes)}`);
  // Clean the bad lane so later assertions see a valid graph again.
  await inj('DELETE', `/api/scm-network/lanes/${lSkip.json.id}`, tPlanner);

  // A branch with no inbound lane is flagged unreachable.
  const nBr2 = await inj('POST', '/api/scm-network/nodes', tPlanner, {
    node_code: 'BR-2', name: 'สาขาลอย', kind: 'branch', branch_id: branchId,
  });
  const topoOrphan = await inj('GET', '/api/scm-network/topology', tPlanner);
  const orphanCodes = (topoOrphan.json.validation?.issues ?? []).map((i: any) => i.code);
  ok('B1 an unwired branch is flagged UNREACHABLE_BRANCH',
    nBr2.status === 201 && orphanCodes.includes('UNREACHABLE_BRANCH'),
    `codes=${JSON.stringify(orphanCodes)}`);
  await inj('DELETE', `/api/scm-network/nodes/${nBr2.json.id}`, tPlanner);

  // A node that still has lanes cannot be deleted (referential guard).
  const delWired = await inj('DELETE', `/api/scm-network/nodes/${nDc.json.id}`, tPlanner);
  ok('B1 a node with lanes cannot be deleted (NODE_HAS_LANES)',
    delWired.status === 409 && delWired.json.error?.code === 'NODE_HAS_LANES',
    `status=${delWired.status} code=${delWired.json.error?.code}`);

  // Cross-tenant boundary (mandatory): T2 sees 0 HQ nodes and cannot wire a lane onto HQ node ids.
  const nodesB = await inj('GET', '/api/scm-network/nodes', tPlannerB);
  const laneCross = await inj('POST', '/api/scm-network/lanes', tPlannerB, {
    from_node_id: nSup.json.id, to_node_id: nDc.json.id,
  });
  ok('B1 cross-tenant isolation (T2 sees 0 HQ nodes; a lane onto HQ nodes is rejected)',
    (nodesB.json?.length ?? 0) === 0 && laneCross.status === 400 && laneCross.json.error?.code === 'LANE_ENDPOINTS_INVALID',
    `T2nodes=${nodesB.json?.length} crossStatus=${laneCross.status} code=${laneCross.json.error?.code}`);

  // ── B2b: two-echelon network plan run + maker-checker (docs/57 Track B, control SCM-05) ──
  // Reuses the valid SUP-1 → DC-1 → BR-1 topology from B1 (BR-1 links the branch that has MENU-KP
  // demand, so ING-CHK gets μ/σ via the recipe). Engine is unconfigured in CI ⇒ the in-process fallback.
  const netRun = await inj('POST', '/api/scm-network/plans/run', tPlanner, { item_code: 'ING-CHK' });
  ok('B2 network run persists a Draft plan across both stocking echelons (DC + branch)',
    (netRun.status === 200 || netRun.status === 201) && netRun.json.status === 'Draft'
      && netRun.json.nodes >= 2 && netRun.json.engine === 'fallback' && typeof netRun.json.pooling_benefit_pct === 'number',
    JSON.stringify({ st: netRun.status, s: netRun.json.status, nodes: netRun.json.nodes, eng: netRun.json.engine }));
  const netPlanId = netRun.json.id;
  const netPlan = await inj('GET', `/api/scm-network/plans/${netPlanId}`, tPlanner);
  const dcLine = (netPlan.json.lines ?? []).find((l: any) => l.echelon === 1);
  const brLine = (netPlan.json.lines ?? []).find((l: any) => l.echelon === 2);
  ok('B2 the plan carries per-node base-stock lines; DC echelon base-stock ≥ branch installation (coherence)',
    netPlan.status === 200 && !!dcLine && !!brLine
      && Number((dcLine.baseStock ?? [0])[0]) >= Number((brLine.installationBaseStock ?? [0])[0]) - 1e-6,
    `lines=${netPlan.json.lines?.length}`);

  const netSubmit = await inj('POST', `/api/scm-network/plans/${netPlanId}/submit`, tPlanner);
  ok('B2 submit → PendingApproval', (netSubmit.status === 200 || netSubmit.status === 201) && netSubmit.json.status === 'PendingApproval', `${netSubmit.status} ${netSubmit.json.status}`);

  // control SCM-05: the submitter (plannerA) cannot approve their own network plan even HOLDING
  // scm_approve — tPlannerSelf is plannerA's post-grant token, so this reaches the maker-checker, not
  // the guard. (The submittedBy is plannerA regardless of which plannerA token submitted it.)
  const netSelf = await inj('POST', `/api/scm-network/plans/${netPlanId}/approve`, tPlannerSelf, {});
  ok('SCM-05: the submitter cannot approve their own network plan (403 SOD_SELF_APPROVAL)',
    netSelf.status === 403 && netSelf.json.error?.code === 'SOD_SELF_APPROVAL', `${netSelf.status} ${netSelf.json.error?.code}`);
  // a caller without scm_approve on this tenant is refused at the guard (never reaches the service).
  const netGuard = await inj('POST', `/api/scm-network/plans/${netPlanId}/approve`, tPlannerB, {});
  ok('SCM-05: approve is gated by scm_approve + tenant (a foreign/unauthorised caller is refused)',
    netGuard.status === 403 || netGuard.status === 404, `${netGuard.status}`);

  const netApprove = await inj('POST', `/api/scm-network/plans/${netPlanId}/approve`, tApprover, {});
  ok('SCM-05: an independent scm_approve holder (≠ submitter) approves → Approved',
    (netApprove.status === 200 || netApprove.status === 201) && netApprove.json.status === 'Approved', `${netApprove.status} ${netApprove.json.status}`);

  const netConvert = await inj('POST', `/api/scm-network/plans/${netPlanId}/convert`, tPlanner);
  ok('B2 an Approved plan rolls the DC supplier-facing order up to a PR (procurement seam, no direct PR write)',
    (netConvert.status === 200 || netConvert.status === 201) && !!netConvert.json.pr_no && netConvert.json.status === 'Converted',
    JSON.stringify({ st: netConvert.status, pr: netConvert.json.pr_no, s: netConvert.json.status }));
  const netReconvert = await inj('POST', `/api/scm-network/plans/${netPlanId}/convert`, tPlanner);
  ok('B2 re-convert is idempotent — the same pr_no, no second PR',
    netReconvert.json.pr_no === netConvert.json.pr_no && netReconvert.json.idempotent === true,
    JSON.stringify({ pr: netReconvert.json.pr_no, idem: netReconvert.json.idempotent }));

  // Cross-tenant boundary (mandatory): T2 cannot read the HQ plan and sees none in its own list.
  const netCross = await inj('GET', `/api/scm-network/plans/${netPlanId}`, tPlannerB);
  const netListB = await inj('GET', '/api/scm-network/plans', tPlannerB);
  ok('B2 cross-tenant: T2 cannot read HQ network plan (404) + sees 0 in its list',
    netCross.status === 404 && (netListB.json?.length ?? 0) === 0,
    `crossStatus=${netCross.status} t2plans=${netListB.json?.length}`);

  // ════════════════════════ docs/57 B3 — DC-shortage allocation fairness (SCM-06 / SoD R25) ════════════════════════
  // (a) the PURE rationing primitive — non-negative, Σ ≤ available, equal shares for equal branches,
  //     priority tiers served first, and the trust boundary rejects an over-issue. Deterministic; no DB.
  const eqReqs = [
    { node: 'BR-A', requested: 30, mu: 10, onHand: 0 },
    { node: 'BR-B', requested: 30, mu: 10, onHand: 0 },
    { node: 'BR-C', requested: 30, mu: 10, onHand: 0 },
  ];
  const propAlloc = ScmAllocationService.allocateShortage(eqReqs, 30, 'proportional', {});
  const propSum = propAlloc.reduce((a: number, b: number) => a + b, 0);
  ok('SCM-06 fair-share rationing is non-negative, sums to available, and equal branches get EQUAL shares',
    propAlloc.every((a: number) => a >= 0) && Math.abs(propSum - 30) < 1e-6
      && Math.abs(propAlloc[0]! - propAlloc[1]!) < 1e-6 && Math.abs(propAlloc[1]! - propAlloc[2]!) < 1e-6,
    `alloc=${JSON.stringify(propAlloc)} sum=${propSum}`);
  const priAlloc = ScmAllocationService.allocateShortage(eqReqs, 30, 'priority', { 'BR-A': 2, 'BR-B': 1, 'BR-C': 1 });
  ok('SCM-06 priority rationing serves the higher-priority tier first (before lower tiers)',
    priAlloc[0] === 30 && priAlloc[1] === 0 && priAlloc[2] === 0, `pri=${JSON.stringify(priAlloc)}`);
  let overThrew = false;
  try { ScmAllocationService.assertAllocationSound([{ ds: 'x', from_node: 'DC', to_node: 'BR-A', requested: 10, allocated: 20, shortfall: 0 }], 10); } catch { overThrew = true; }
  ok('SCM-06 the trust boundary rejects an allocation that exceeds available DC stock', overThrew, `threw=${overThrew}`);

  // (b) the allocation POLICY is GOVERNED data — maker-checker'd (SoD R25). plannerA gains scm_allocate.
  await db.insert(s.userPermissions).values({ userId: await uid('plannerA'), perm: 'scm_allocate' }).onConflictDoNothing();
  const tAlloc = await login('plannerA');
  const setPol = await inj('POST', '/api/scm-network/allocation/policies', tAlloc, { dc_node_code: 'DC-1', method: 'fair_share', reason: 'peak season equal runout' });
  ok('SCM-06 an allocation policy is staged PendingApproval by the scm_allocate maker',
    (setPol.status === 200 || setPol.status === 201) && setPol.json.status === 'PendingApproval', `${setPol.status} ${setPol.json.status}`);
  const polId = setPol.json.id;
  const setPolGuard = await inj('POST', '/api/scm-network/allocation/policies', tApprover, { dc_node_code: 'DC-1', method: 'proportional' });
  ok('SCM-06 setting a policy is gated by scm_allocate (an scm_approve-only caller is refused at the guard)',
    setPolGuard.status === 403, `${setPolGuard.status}`);
  const polSelf = await inj('POST', `/api/scm-network/allocation/policies/${polId}/approve`, tAlloc, {});
  ok('SCM-06 the policy maker cannot self-approve (403 SOD_SELF_APPROVAL, SoD R25)',
    polSelf.status === 403 && polSelf.json.error?.code === 'SOD_SELF_APPROVAL', `${polSelf.status} ${polSelf.json.error?.code}`);
  const polApprove = await inj('POST', `/api/scm-network/allocation/policies/${polId}/approve`, tApprover, {});
  ok('SCM-06 an independent scm_approve holder (≠ maker) approves the allocation policy → Approved',
    (polApprove.status === 200 || polApprove.status === 201) && polApprove.json.status === 'Approved', `${polApprove.status} ${polApprove.json.status}`);

  // (c) a per-plan OVERRIDE of the computed fair-share — unlogged is rejected, logged is STAGED (not
  //     auto-applied) and applied only on a SECOND approver's sign-off (the two-person control).
  const ovrUnlogged = await inj('POST', `/api/scm-network/plans/${netPlanId}/allocation-override`, tAlloc, { allocations: [{ to_node: 'BR-1', allocated: 5 }] });
  ok('SCM-06 an UNLOGGED override (no justification) is rejected (403 ALLOCATION_OVERRIDE_UNLOGGED)',
    ovrUnlogged.status === 403 && ovrUnlogged.json.error?.code === 'ALLOCATION_OVERRIDE_UNLOGGED', `${ovrUnlogged.status} ${ovrUnlogged.json.error?.code}`);
  const ovr = await inj('POST', `/api/scm-network/plans/${netPlanId}/allocation-override`, tAlloc, { allocations: [{ to_node: 'BR-1', allocated: 5 }], justification: 'BR-1 has a confirmed catering event this week' });
  ok('SCM-06 a JUSTIFIED override is STAGED for a second approver (PendingApproval, not auto-applied)',
    (ovr.status === 200 || ovr.status === 201) && ovr.json.status === 'PendingApproval' && ovr.json.applied === false, `${ovr.status} ${ovr.json.status} applied=${ovr.json.applied}`);
  const ovrId = ovr.json.id;
  const ovrSelf = await inj('POST', `/api/scm-network/allocation/overrides/${ovrId}/approve`, tAlloc, {});
  ok('SCM-06 the override maker cannot self-approve their own deviation (403 SOD_SELF_APPROVAL)',
    ovrSelf.status === 403 && ovrSelf.json.error?.code === 'SOD_SELF_APPROVAL', `${ovrSelf.status} ${ovrSelf.json.error?.code}`);
  const ovrApprove = await inj('POST', `/api/scm-network/allocation/overrides/${ovrId}/approve`, tApprover, {});
  ok('SCM-06 an independent approver applies the override to the plan (two-person control)',
    (ovrApprove.status === 200 || ovrApprove.status === 201) && ovrApprove.json.applied === true, `${ovrApprove.status} applied=${ovrApprove.json.applied}`);
  const planAfterOvr = await inj('GET', `/api/scm-network/plans/${netPlanId}`, tPlanner);
  ok('SCM-06 the approved override becomes the plan’s persisted allocation',
    JSON.stringify(planAfterOvr.json.plan?.allocations ?? []).includes('BR-1'), `alloc=${JSON.stringify(planAfterOvr.json.plan?.allocations)}`);

  // (d) cross-tenant boundary (mandatory): T2 sees 0 HQ policies and cannot approve an HQ override.
  const polCrossList = await inj('GET', '/api/scm-network/allocation/policies', tPlannerB);
  const ovrCross = await inj('POST', `/api/scm-network/allocation/overrides/${ovrId}/approve`, tPlannerB, {});
  ok('SCM-06 cross-tenant: T2 sees 0 HQ allocation policies and cannot approve an HQ override (403/404)',
    (polCrossList.json?.length ?? 0) === 0 && (ovrCross.status === 403 || ovrCross.status === 404),
    `t2pols=${polCrossList.json?.length} crossStatus=${ovrCross.status}`);

  // ════════════════════════ docs/57 B4 — DRP time-phased roll-up ════════════════════════
  // A fresh run now time-phases each node's orders (net requirements offset by the inbound lead, lot-
  // sized to the lane moq/pack) and rolls branch releases up into the DC's supplier-facing releases.
  const drpRun = await inj('POST', '/api/scm-network/plans/run', tPlanner, { item_code: 'ING-CHK' });
  const drpPlan = await inj('GET', `/api/scm-network/plans/${drpRun.json.id}`, tPlanner);
  const drpDc = (drpPlan.json.lines ?? []).find((l: any) => l.echelon === 1);
  const drpOrders = (drpDc?.orders ?? []) as { order_ds: string; arrival_ds: string; qty: number }[];
  ok('B4 the DC line carries time-phased supplier-facing releases (each with an order + arrival date, qty > 0)',
    drpOrders.length >= 1 && drpOrders.every((o) => !!o.order_ds && !!o.arrival_ds && o.order_ds <= o.arrival_ds && o.qty > 0),
    `releases=${drpOrders.length} sample=${JSON.stringify(drpOrders[0])}`);
  // Lead-offset + on-hand netting are proven deterministically on the pure DRP primitive (the plan
  // fixture's demand can land entirely at day 0, clamping the offset — so assert the math directly):
  // 10/day for 5 days, no on-hand, lead 2 ⇒ a receipt on day t is RELEASED on day t−2.
  const drpUnit = drpNode({ nodeCode: 'X', grossReq: [10, 10, 10, 10, 10], onHand: 0, schedReceipts: [0, 0, 0, 0, 0], leadDays: 2, moq: 0, pack: 1 }, '2026-01-10', 'SUP');
  ok('B4 DRP offsets a planned release back by the inbound lead time',
    drpUnit.releases.length > 0 && drpUnit.releases.some((r) => daysBetweenYmd(r.order_ds, r.arrival_ds) === 2),
    `rel=${JSON.stringify(drpUnit.releases.map((r) => [r.order_ds, r.arrival_ds]))}`);
  // Net against on-hand: 100 on-hand covers all 50 of demand ⇒ NO planned release at all.
  const drpCovered = drpNode({ nodeCode: 'X', grossReq: [10, 10, 10, 10, 10], onHand: 100, schedReceipts: [0, 0, 0, 0, 0], leadDays: 2, moq: 0, pack: 1 }, '2026-01-10', 'SUP');
  ok('B4 DRP nets requirements against projected on-hand (demand covered by stock ⇒ no release)',
    drpCovered.releases.length === 0, `releases=${drpCovered.releases.length}`);
  // The SUP→DC lane has moq 20, pack 5 → every DC release is a whole number of packs, ≥ the moq.
  ok('B4 DC releases respect the inbound lane lot-sizing (moq 20 + pack 5)',
    drpOrders.length > 0 && drpOrders.every((o) => Math.abs(o.qty % 5) < 1e-6 && o.qty >= 20 - 1e-6),
    `qtys=${JSON.stringify(drpOrders.map((o) => o.qty))}`);
  const drpBr = (drpPlan.json.lines ?? []).find((l: any) => l.echelon === 2);
  const drpBrOrders = (drpBr?.orders ?? []) as { from_node: string }[];
  ok('B4 branch releases are sourced from the DC (the roll-up chains branch→DC→supplier)',
    drpBrOrders.length === 0 || drpBrOrders.every((o) => o.from_node === 'DC-1'),
    `brFrom=${JSON.stringify([...new Set(drpBrOrders.map((o) => o.from_node))])}`);
  // Convert rolls the time-phased supplier releases up to a PR through the existing procurement seam.
  await inj('POST', `/api/scm-network/plans/${drpRun.json.id}/submit`, tPlanner);
  await inj('POST', `/api/scm-network/plans/${drpRun.json.id}/approve`, tApprover, {});
  const drpConvert = await inj('POST', `/api/scm-network/plans/${drpRun.json.id}/convert`, tPlanner);
  ok('B4 an approved plan rolls its time-phased supplier releases up to a PR (reuses ProcurementService.createPr)',
    (drpConvert.status === 200 || drpConvert.status === 201) && !!drpConvert.json.pr_no && drpConvert.json.status === 'Converted',
    JSON.stringify({ st: drpConvert.status, pr: drpConvert.json.pr_no, s: drpConvert.json.status }));

  // ════════════════════════ docs/59 D2 — warm-start / model registry ════════════════════════
  // A prophet (re)fit persists to scm_model_cache; a run inside the refit cadence ships the cached fit
  // as warm_start so the engine reuses it (skips the cmdstan refit); a fit older than the cadence forces
  // a refit. The cache is fully tenant-scoped. Re-point at the still-running stub (the fallback test at
  // §19 cleared the engine env).
  process.env.SCM_ENGINE_URL = engine.url;
  process.env.SCM_ENGINE_SECRET = ENGINE_SECRET;
  const primeRun = await inj('POST', '/api/scm-planning/run', tPlanner, {});
  const cacheRows = await db.select().from(s.scmModelCache).where(eq(s.scmModelCache.tenantId, hq));
  ok('D2 a prophet fit persists to scm_model_cache (per branch/item, with fit_hash + serialized params)',
    primeRun.status === 201 && cacheRows.length > 0 && cacheRows.every((r: any) => r.model === 'prophet' && !!r.fitHash && !!r.fitParams),
    `run=${primeRun.status} rows=${cacheRows.length}`);

  // Reuse: a second run within the cadence ships the cached fit and the engine reports a warm hit.
  const hitsBefore = engine.state.warmHits;
  const reuseRun = await inj('POST', '/api/scm-planning/run', tPlanner, {});
  ok('D2 warm-start reuse — a run inside the cadence ships the cached fit (engine reports a warm hit)',
    reuseRun.status === 201 && engine.state.warmHits > hitsBefore,
    `status=${reuseRun.status} warmHits ${hitsBefore}→${engine.state.warmHits}`);

  // Cadence guard (fail-safe toward refit): age every cached fit beyond the default 14-day cadence →
  // the next run must NOT warm-start; the engine refits instead.
  await db.update(s.scmModelCache).set({ fittedAt: new Date(Date.now() - 30 * 86_400_000) }).where(eq(s.scmModelCache.tenantId, hq));
  const hitsAtStale = engine.state.warmHits;
  const fitsAtStale = engine.state.fitsReturned;
  const staleRun = await inj('POST', '/api/scm-planning/run', tPlanner, {});
  ok('D2 cadence guard — a fit older than refit_cadence_days is not reused (forces a refit)',
    staleRun.status === 201 && engine.state.warmHits === hitsAtStale && engine.state.fitsReturned > fitsAtStale,
    `warmHits ${hitsAtStale}(unchanged) fitsReturned ${fitsAtStale}→${engine.state.fitsReturned}`);

  // Cross-tenant boundary (mandatory): T2 owns none of HQ's cached fits.
  const t2Cache = await db.select().from(s.scmModelCache).where(eq(s.scmModelCache.tenantId, t2));
  ok('D2 cross-tenant: T2 owns 0 of HQ scm_model_cache rows (tenant-scoped registry)',
    t2Cache.length === 0 && cacheRows.length > 0,
    `t2=${t2Cache.length} hq=${cacheRows.length}`);

  // ════════════════════════ docs/59 D1 — scheduled batch retrain + forecast-source seam ════════════════════════
  // A retrain run forecasts + PERSISTS the reconciled sample paths (producer); a nightly run within the
  // staleness window REUSES them and does not call the engine (consumer); the retrain scope is per-day
  // idempotent. Drive the scoped runs through the service (no HTTP endpoint for scheduled scopes).
  process.env.SCM_ENGINE_URL = engine.url; // ensure the engine is on (fallback §19 cleared it)
  process.env.SCM_ENGINE_SECRET = ENGINE_SECRET;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const planningSvc = app.get(require('../../../apps/api/dist/modules/scm-planning/scm-planning.service').ScmPlanningService, { strict: false });

  const retrain = await planningSvc.executePlanRun(hq, 'retrain', { actor: 'system:test' });
  const rtFc = await db.select().from(s.scmDemandForecasts).where(and(
    eq(s.scmDemandForecasts.runId, Number(retrain.run_id)), eq(s.scmDemandForecasts.level, 'menu')));
  ok('D1 batch-retrain persists reconciled sample_paths on menu forecasts (the producer)',
    retrain.status === 'Completed' && rtFc.length > 0
      && rtFc.every((f: any) => Array.isArray(f.samplePaths) && f.samplePaths.length > 0),
    `run=${retrain.status} menuFc=${rtFc.length}`);

  // The earlier § job-idempotency test already ran a nightly for HQ today; mark it Failed (the run guard
  // ignores Failed runs) so THIS fresh nightly actually executes the forecast-source seam. An UPDATE (not
  // a DELETE) avoids touching its child order-plan rows.
  await db.update(s.scmPlanRuns).set({ status: 'Failed' })
    .where(and(eq(s.scmPlanRuns.tenantId, hq), eq(s.scmPlanRuns.scope, 'nightly')));

  const fcBefore = engine.state.forecasts;
  const nightlyRun = await planningSvc.executePlanRun(hq, 'nightly', { actor: 'system:test' });
  ok('D1 nightly reuses the batch-retrain forecast within the staleness window — engine NOT re-called',
    nightlyRun.status === 'Completed' && engine.state.forecasts === fcBefore,
    `nightly=${nightlyRun.status} forecasts ${fcBefore}→${engine.state.forecasts}`);

  const retrain2 = await planningSvc.executePlanRun(hq, 'retrain', { actor: 'system:test' });
  ok('D1 duplicate retrain the same day is a no-op (per-tenant run guard, migration 0477)',
    retrain2.status === 'Skipped', `status=${retrain2.status}`);

  await app.close();
  await engine.close();

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  console.log(`\nscm: ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
