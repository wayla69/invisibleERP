import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  ScmOptimizeNetworkRequest, ScmNetworkNode, ScmNetworkLane, ScmDemandPath,
} from '@ierp/shared';
import { SCM_ENGINE_CONTRACT_VERSION } from '@ierp/shared';
import { ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { ScmPlanningService } from '../scm-planning/scm-planning.service';
import type { ItemParams, ScmSettingsView } from '../scm-planning/scm-planning.types';
import { ScmNetworkService } from './scm-network.service';

// docs/57 Track B (B2b) — build the engine payload for a two-echelon network run of ONE item.
//
// Loose coupling (docs/57 §4.1): the per-branch demand paths + item economics come THROUGH
// scm-planning's PUBLIC surface (ScmPlanningService.demandPathsFor + .extract.extractAll) — never a
// cross-module table read or SQL join. The topology comes from the B1 ScmNetworkService. Also derives
// per-branch (μ,σ) from history so the ENGINE-OFF fallback (what the CI harness exercises) can plan
// without calling out.

const NODE_QTY_CAP_FACTOR = 2; // trust boundary: clamp any engine qty to ≤ 2× the node's mean need

export interface BranchStat { mu: number; sigma: number }

export interface NetworkExtract {
  itemCode: string;
  request: ScmOptimizeNetworkRequest;      // the engine payload (used when the engine is enabled)
  statsByNode: Map<string, BranchStat>;    // nodeCode → per-branch demand stats (fallback input)
  laneLeadByNode: Map<string, number>;     // nodeCode → inbound-lane mean lead (fallback input)
  holdingByNode: Map<string, number>;      // nodeCode → holding cost per day (fallback input)
  dcNodeCode: string | null;
  supplierNodeCode: string | null;
  params: ItemParams;
  settings: ScmSettingsView;
  hasEnginePaths: boolean;                  // ≥1 branch had engine demand paths
  qtyCapFactor: number;
}

@Injectable()
export class ScmNetworkExtractService {
  constructor(
    private readonly network: ScmNetworkService,
    private readonly planning: ScmPlanningService,
  ) {}

  private static num(v: unknown, d = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }

  private static stats(values: number[]): BranchStat {
    if (!values.length) return { mu: 0, sigma: 0 };
    const mu = values.reduce((a, b) => a + b, 0) / values.length;
    if (values.length < 2) return { mu, sigma: 0 };
    const v = values.reduce((a, b) => a + (b - mu) ** 2, 0) / (values.length - 1);
    return { mu, sigma: Math.sqrt(Math.max(0, v)) };
  }

  async build(user: JwtUser, itemCode: string): Promise<NetworkExtract> {
    const tenantId = user.tenantId ?? null;
    const topo = await this.network.topology(user);
    if (!topo.validation.ok) {
      const first = topo.validation.issues[0];
      throw new BadRequestException({
        code: first?.code ?? 'NETWORK_INVALID',
        message: first?.message ?? 'the supply network is not a valid two-echelon topology',
        messageTh: 'โครงข่ายซัพพลายไม่ถูกต้อง (ต้องเป็นสองชั้นแบบ DAG)',
      });
    }
    const nodeByCode = new Map(topo.nodes.map((n) => [n.nodeCode, n]));
    const codeById = new Map(topo.nodes.map((n) => [n.id, n.nodeCode]));
    const branchNodes = topo.nodes.filter((n) => n.active && n.echelon === 2 && n.branchId != null);
    if (!branchNodes.length) {
      throw new BadRequestException({ code: 'UNREACHABLE_BRANCH', message: 'the network has no branch node linked to a branch', messageTh: 'ไม่มีโหนดสาขาที่ผูกกับสาขา' });
    }
    const dc = topo.nodes.find((n) => n.active && n.echelon === 1) ?? null;
    const supplier = topo.nodes.find((n) => n.active && n.echelon === 0) ?? null;

    // Item economics + history via scm-planning's PUBLIC extract (loose coupling).
    const data = await this.planning.extract.extractAll(tenantId, { itemIds: [itemCode] });
    const params = data.params.get(itemCode);
    if (!params) {
      throw new BadRequestException({ code: 'ITEM_NOT_PLANNED', message: `item ${itemCode} is not a planned ingredient (no recipe / params)`, messageTh: 'สินค้านี้ไม่อยู่ในแผน (ไม่มีสูตร/พารามิเตอร์)' });
    }

    // Per-branch demand paths (engine mode) + per-branch (μ,σ) from history (fallback mode).
    const branchIds = branchNodes.map((n) => n.branchId).filter((b): b is number => b != null);
    const pathsByBranch = await this.planning.demandPathsFor(tenantId, [itemCode], branchIds);
    const edges = data.recipes.filter((r) => r.ingredientItemId === itemCode);
    const statsByNode = new Map<string, BranchStat>();
    const demandPaths: ScmDemandPath[] = [];
    let hasEnginePaths = false;
    for (const node of branchNodes) {
      // fallback stats: item daily demand = Σ_menu grossQtyPerUnit × that menu sku's branch series
      const daily: number[] = [];
      for (const e of edges) {
        const s = data.series.find((x) => x.branchId === node.branchId && x.itemId === e.menuSku);
        if (!s) continue;
        s.values.forEach((y, i) => { daily[i] = (daily[i] ?? 0) + y * e.grossQtyPerUnit; });
      }
      statsByNode.set(node.nodeCode, ScmNetworkExtractService.stats(daily));
      const paths = pathsByBranch.get(node.branchId ?? -1)?.get(itemCode);
      if (paths && paths.length) {
        demandPaths.push({ node_id: node.nodeCode, demand_scenarios: paths });
        hasEnginePaths = true;
      }
    }

    const nodes: ScmNetworkNode[] = topo.nodes
      .filter((n) => n.active)
      .map((n) => {
        const pos = n.branchId != null ? data.stock.find((s) => s.branchId === n.branchId && s.itemId === itemCode) : undefined;
        return {
          node_id: n.nodeCode,
          kind: n.kind as ScmNetworkNode['kind'],
          echelon: n.echelon as 0 | 1 | 2,
          service_time_out_days: ScmNetworkExtractService.num(n.serviceTimeOutDays),
          holding_cost_per_day: ScmNetworkExtractService.num(n.holdingCostPerDay),
          current_inventory: (pos?.layers ?? []).map((l) => ({ remaining_days: l.remaining_days, qty: l.qty })),
          in_transit: (pos?.inTransit ?? []).map((t) => ({ arrival_ds: t.arrival_ds, qty: t.qty })),
        };
      });

    const holdingByNode = new Map(nodes.map((n) => [n.node_id, n.holding_cost_per_day ?? 0]));
    const laneLeadByNode = new Map<string, number>();
    const lanes: ScmNetworkLane[] = topo.lanes
      .filter((l) => l.active && codeById.has(l.fromNodeId) && codeById.has(l.toNodeId))
      .map((l) => {
        const toCode = codeById.get(l.toNodeId)!;
        const mean = ScmNetworkExtractService.num(l.leadTimeMeanDays);
        laneLeadByNode.set(toCode, mean);
        return {
          from_node: codeById.get(l.fromNodeId)!,
          to_node: toCode,
          lead_time: { mean_days: mean, std_days: ScmNetworkExtractService.num(l.leadTimeStdDays) },
          unit_cost: ScmNetworkExtractService.num(l.unitCost),
          moq: ScmNetworkExtractService.num(l.moq),
          pack_size: ScmNetworkExtractService.num(l.packSize, 1) || 1,
          fixed_order_cost: ScmNetworkExtractService.num(l.fixedOrderCost),
        };
      });

    const serviceLevel = Math.min(0.999, Math.max(0.5, params.serviceLevel || data.settings.service_level || 0.95));
    const request: ScmOptimizeNetworkRequest = {
      contract_version: SCM_ENGINE_CONTRACT_VERSION,
      request_id: `net:${tenantId ?? 'null'}:${itemCode}:${ymd()}`,
      start_ds: ymd(),
      horizon_days: data.settings.horizon_days,
      item_code: itemCode,
      shelf_life_days: Math.max(1, Math.min(365, params.shelfLifeDays ?? 30)),
      review_period_days: 1,
      unit_price: Math.max(0, params.unitPrice),
      unit_cost: Math.max(0, params.unitCost),
      salvage_value: Math.max(0, params.salvageValue),
      disposal_cost: Math.max(0, params.disposalCost),
      goodwill_cost: Math.max(0, params.goodwillCost),
      service_level: serviceLevel,
      nodes,
      lanes,
      demand_paths: demandPaths,
      allocation: { method: 'proportional' },
      time_budget_ms: 20_000,
    };

    return {
      itemCode, request, statsByNode, laneLeadByNode, holdingByNode,
      dcNodeCode: dc?.nodeCode ?? null,
      supplierNodeCode: supplier?.nodeCode ?? null,
      params, settings: data.settings, hasEnginePaths,
      qtyCapFactor: NODE_QTY_CAP_FACTOR,
    };
  }
}
