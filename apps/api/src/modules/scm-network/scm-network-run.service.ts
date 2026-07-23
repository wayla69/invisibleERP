import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { ScmOptimizeNetworkResponse } from '@ierp/shared';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { scmNetworkPlans, scmNetworkPlanLines } from '../../database/schema';
import { ymd } from '../../database/queries';
import { addDaysYmd } from '../demand-ml/forecast-algorithms';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import type { JwtUser } from '../../common/decorators';
import { ScmEngineClientService } from '../scm-planning/scm-engine-client.service';
import { ScmNetworkExtractService, type NetworkExtract } from './scm-network-extract.service';

// docs/57 Track B (B2b) — orchestrate a two-echelon network run and PERSIST it as a Draft plan.
//
//   extract → (engine /v1/optimize-network when enabled + demand paths present, else in-process
//   fallback) → clamp every engine quantity (trust boundary) → persist scm_network_plans Draft +
//   per-stocking-node lines + allocation diagnostics. The plan is NEVER actionable until a DIFFERENT
//   person approves it (control SCM-05, in ScmNetworkService). The fallback is independent per-branch
//   base-stock (no pooling), so it is safe + auditable without the GSM optimum (docs/57 §9).

interface NodePlan {
  nodeCode: string;
  echelon: number;
  serviceTimeOut: number;
  baseStock: number[];
  installationBaseStock: number[];
  safetyStock: number[];
  orders: { order_ds: string; arrival_ds: string; from_node: string; qty: number; packs: number }[];
  orderQty: number;
  expectedFillRate: number | null;
  expectedWasteCost: number | null;
  clamped: boolean;
}

interface PoolingReport { independent: number; pooled: number; benefitPct: number }

@Injectable()
export class ScmNetworkRunService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly extract: ScmNetworkExtractService,
    private readonly engine: ScmEngineClientService,
    private readonly docNo: DocNumberService,
    private readonly statusLog: StatusLogService,
  ) {}

  /** Standard-normal inverse CDF (Acklam) — the safety factor z for a service level, no scipy/stdlib. */
  private static zScore(p: number): number {
    const pp = Math.min(0.999999, Math.max(0.000001, p));
    const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
    const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
    const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
    const plow = 0.02425, phigh = 1 - plow;
    let q: number, r: number;
    if (pp < plow) { q = Math.sqrt(-2 * Math.log(pp)); return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
    if (pp > phigh) { q = Math.sqrt(-2 * Math.log(1 - pp)); return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
    q = pp - 0.5; r = q * q;
    return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }

  private static onHand(inv: { remaining_days: number; qty: number }[]): number {
    return inv.filter((l) => l.remaining_days >= 1).reduce((a, l) => a + l.qty, 0);
  }

  async run(user: JwtUser, itemCode: string): Promise<{ plan_no: string; status: string; engine: string; nodes: number; pooling_benefit_pct: number }> {
    if (!itemCode || !itemCode.trim()) throw new BadRequestException({ code: 'ITEM_REQUIRED', message: 'item_code is required' });
    const ex = await this.extract.build(user, itemCode.trim());
    const useEngine = this.engine.enabled() && ex.hasEnginePaths;
    const { nodePlans, pooling, allocations, engineName } = useEngine
      ? await this.fromEngine(ex)
      : this.fromFallback(ex);

    return this.persist(user, ex, nodePlans, pooling, allocations, engineName);
  }

  // ── engine path ──
  private async fromEngine(ex: NetworkExtract): Promise<{ nodePlans: NodePlan[]; pooling: PoolingReport; allocations: unknown[]; engineName: string }> {
    let resp: ScmOptimizeNetworkResponse;
    try {
      resp = await this.engine.optimizeNetwork(ex.request);
    } catch {
      return { ...this.fromFallback(ex), engineName: 'fallback' };
    }
    if (!resp.node_plans.length) return { ...this.fromFallback(ex), engineName: 'fallback' };
    const nodeCap = new Map(ex.request.nodes.map((n) => [n.node_id, ScmNetworkRunService.onHand(n.current_inventory)]));
    const nodePlans: NodePlan[] = resp.node_plans.map((p) => {
      const capBase = Math.max(1, (p.base_stock[0] ?? 0)) * ex.qtyCapFactor;
      let clamped = false;
      const orders = p.orders.map((o) => {
        let qty = Math.max(0, o.qty);
        const cap = Math.max(capBase, ScmNetworkRunService.num(nodeCap.get(p.node_id)) * ex.qtyCapFactor);
        if (qty > cap) { qty = cap; clamped = true; }
        return { order_ds: o.order_ds, arrival_ds: o.arrival_ds, from_node: o.from_node, qty, packs: o.packs };
      });
      return {
        nodeCode: p.node_id, echelon: p.echelon, serviceTimeOut: p.service_time_out_days,
        baseStock: p.base_stock, installationBaseStock: p.installation_base_stock, safetyStock: p.safety_stock,
        orders, orderQty: orders.reduce((a, o) => a + o.qty, 0),
        expectedFillRate: p.expected.fill_rate, expectedWasteCost: p.expected.waste_cost, clamped,
      };
    });
    return {
      nodePlans,
      pooling: { independent: resp.pooling.independent_safety_units, pooled: resp.pooling.pooled_safety_units, benefitPct: resp.pooling.pooling_benefit_pct },
      allocations: resp.allocations, engineName: 'engine',
    };
  }

  // ── in-process fallback (engine off): independent per-branch base-stock, no pooling (docs/57 §9) ──
  private fromFallback(ex: NetworkExtract): { nodePlans: NodePlan[]; pooling: PoolingReport; allocations: unknown[]; engineName: string } {
    const z = ScmNetworkRunService.zScore(ex.request.service_level);
    const H = ex.request.horizon_days;
    const R = ex.request.review_period_days;
    const start = ymd();
    const vec = (v: number): number[] => Array.from({ length: H }, () => v);
    const invByNode = new Map(ex.request.nodes.map((n) => [n.node_id, ScmNetworkRunService.onHand(n.current_inventory)]));

    const branchNodes = ex.request.nodes.filter((n) => n.echelon === 2);
    const nodePlans: NodePlan[] = [];
    let sumSigma = 0, sumSigmaSq = 0, sumBranchSafety = 0, sumMu = 0, sumBranchBase = 0;

    for (const bn of branchNodes) {
      const st = ex.statsByNode.get(bn.node_id) ?? { mu: 0, sigma: 0 };
      const L = ex.laneLeadByNode.get(bn.node_id) ?? 0;
      const protection = L + R;
      const rootP = Math.sqrt(Math.max(0, protection));
      const safety = z * st.sigma * rootP;
      const base = st.mu * protection + safety;
      const onHand = invByNode.get(bn.node_id) ?? 0;
      const orderQty = ScmNetworkRunService.clampQty(Math.max(0, base - onHand), st.mu, ex.qtyCapFactor);
      sumSigma += st.sigma; sumSigmaSq += st.sigma * st.sigma; sumBranchSafety += safety; sumMu += st.mu; sumBranchBase += base;
      nodePlans.push({
        nodeCode: bn.node_id, echelon: 2, serviceTimeOut: 0,
        baseStock: vec(base), installationBaseStock: vec(base), safetyStock: vec(safety),
        orders: orderQty > 0 ? [{ order_ds: start, arrival_ds: addDaysYmd(start, Math.round(L)), from_node: ex.dcNodeCode ?? 'DC', qty: orderQty, packs: orderQty }] : [],
        orderQty, expectedFillRate: null, expectedWasteCost: null, clamped: false,
      });
    }

    // DC — independent aggregate (no pooling): σ_DC = √Σσ² (not the ρ-pooled form the engine uses).
    if (ex.dcNodeCode) {
      const Ldc = ex.laneLeadByNode.get(ex.dcNodeCode) ?? 0;
      const protection = Ldc + R;
      const rootP = Math.sqrt(Math.max(0, protection));
      const sigmaDc = Math.sqrt(sumSigmaSq);
      const safety = z * sigmaDc * rootP;
      const install = sumMu * protection + safety;
      const echelonBase = install + sumBranchBase;
      const onHand = invByNode.get(ex.dcNodeCode) ?? 0;
      const orderQty = ScmNetworkRunService.clampQty(Math.max(0, install - onHand), sumMu, ex.qtyCapFactor);
      nodePlans.push({
        nodeCode: ex.dcNodeCode, echelon: 1, serviceTimeOut: 0,
        baseStock: vec(echelonBase), installationBaseStock: vec(install), safetyStock: vec(safety),
        orders: orderQty > 0 ? [{ order_ds: start, arrival_ds: addDaysYmd(start, Math.round(Ldc)), from_node: ex.supplierNodeCode ?? 'SUP', qty: orderQty, packs: orderQty }] : [],
        orderQty, expectedFillRate: null, expectedWasteCost: null, clamped: false,
      });
    }
    // No pooling in the fallback: independent == pooled, benefit 0 (honest — docs/57 §9).
    return { nodePlans, pooling: { independent: sumBranchSafety, pooled: sumBranchSafety, benefitPct: 0 }, allocations: [], engineName: 'fallback' };
  }

  private static clampQty(raw: number, mu: number, factor: number): number {
    const cap = Math.max(1, mu) * factor * 56; // ≤ factor× a full-horizon mean need (56-day max window)
    return Math.round(Math.min(raw, cap));
  }

  private static num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  private async persist(
    user: JwtUser, ex: NetworkExtract, nodePlans: NodePlan[], pooling: PoolingReport, allocations: unknown[], engineName: string,
  ): Promise<{ plan_no: string; status: string; engine: string; nodes: number; pooling_benefit_pct: number }> {
    const tenantId = user.tenantId ?? null;
    const planNo = await this.docNo.nextDaily('SCMN');
    const estTotal = nodePlans.reduce((a, p) => a + p.orderQty * ex.params.unitCost, 0);
    const [plan] = await this.db.insert(scmNetworkPlans).values({
      tenantId, planNo, itemCode: ex.itemCode,
      horizonDays: ex.request.horizon_days,
      serviceLevel: String(ex.request.service_level),
      allocationMethod: ex.request.allocation.method,
      status: 'Draft', engine: engineName,
      poolingBenefitPct: String(Math.round(pooling.benefitPct * 1000) / 1000),
      independentSafetyUnits: String(Math.round(pooling.independent * 1e4) / 1e4),
      pooledSafetyUnits: String(Math.round(pooling.pooled * 1e4) / 1e4),
      estTotalCost: String(Math.round(estTotal * 100) / 100),
      allocations: allocations as object[],
      createdBy: user.username,
    }).returning({ id: scmNetworkPlans.id });
    const planId = plan!.id;
    if (nodePlans.length) {
      await this.db.insert(scmNetworkPlanLines).values(nodePlans.map((p) => ({
        tenantId, planId, nodeCode: p.nodeCode, echelon: p.echelon,
        serviceTimeOutDays: String(p.serviceTimeOut),
        baseStock: p.baseStock, installationBaseStock: p.installationBaseStock, safetyStock: p.safetyStock,
        orders: p.orders,
        expectedFillRate: p.expectedFillRate != null ? String(p.expectedFillRate) : null,
        expectedWasteCost: p.expectedWasteCost != null ? String(p.expectedWasteCost) : null,
        orderQty: String(p.orderQty),
        detail: { clamped: p.clamped },
      })));
    }
    await this.statusLog.log('SCMN', planNo, '', 'Draft', user.username);
    return { plan_no: planNo, status: 'Draft', engine: engineName, nodes: nodePlans.length, pooling_benefit_pct: pooling.benefitPct };
  }
}
