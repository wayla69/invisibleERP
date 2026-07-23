import { addDaysYmd } from '../demand-ml/forecast-algorithms';

// docs/57 Track B (B4) — DRP (Distribution Requirements Planning) time-phased roll-up.
//
// Pure, DI-free lot-for-lot MRP netting: per node, net the period gross requirements against projected
// on-hand + scheduled receipts, lot-size to moq/pack, and offset the planned RECEIPT back by the inbound
// lead time to get the planned RELEASE. Branch planned releases become the DC's gross requirements
// (`gross_req_DC[t] = Σ_i release_i[t]`); the DC is netted the same way and its releases become the
// SUPPLIER's gross requirements (docs/57 §1.6). Only the supplier-facing releases hand off to a PR
// (`ScmNetworkPlanService.convertPlan`, the existing `ProcurementService.createPr` seam). No new writer,
// no engine call — this time-phases the quantities the run already computed.

export interface DrpNodeInput {
  nodeCode: string;
  grossReq: number[];       // per horizon day (length H)
  onHand: number;           // projected starting on-hand
  schedReceipts: number[];  // per day — in-transit arrivals already committed
  leadDays: number;         // inbound-lane mean lead (release = receipt offset back by this)
  moq: number;
  pack: number;
}
export interface DrpRelease {
  order_ds: string;         // when the order must be RELEASED (receipt day − lead)
  arrival_ds: string;       // when it must ARRIVE (the requirement day)
  from_node: string;        // upstream source (DC for a branch, supplier for the DC)
  qty: number;
  packs: number;
}

function lotSize(net: number, moq: number, pack: number): number {
  if (net <= 0) return 0;
  let q = Math.max(net, moq > 0 ? moq : 0);
  if (pack > 0) q = Math.ceil(q / pack) * pack;
  return q;
}

/**
 * Lot-for-lot net requirements for ONE node. Returns the planned RELEASES (receipt offset back by the
 * lead, floored at day 0) and the per-period planned receipts (what the parent must deliver — the
 * child's gross requirement). `H` is taken from `grossReq.length`.
 */
export function drpNode(input: DrpNodeInput, startDs: string, fromNode: string): { releases: DrpRelease[]; plannedReceipts: number[] } {
  const H = input.grossReq.length;
  const lead = Math.max(0, Math.round(input.leadDays));
  const pack = input.pack > 0 ? input.pack : 1;
  const plannedReceipts = new Array(H).fill(0);
  let proj = Math.max(0, input.onHand);
  for (let t = 0; t < H; t++) {
    proj += input.schedReceipts[t] ?? 0;
    const gross = Math.max(0, input.grossReq[t] ?? 0);
    if (proj < gross) {
      const receipt = lotSize(gross - proj, input.moq, pack);
      plannedReceipts[t] = receipt;
      proj += receipt;
    }
    proj = Math.max(0, proj - gross);
  }
  const releases: DrpRelease[] = [];
  for (let t = 0; t < H; t++) {
    const qty = plannedReceipts[t];
    if (qty <= 0) continue;
    const releaseOffset = Math.max(0, t - lead); // cannot release before the plan's day 0
    releases.push({
      order_ds: addDaysYmd(startDs, releaseOffset),
      arrival_ds: addDaysYmd(startDs, t),
      from_node: fromNode,
      qty: Math.round(qty * 1e4) / 1e4,
      packs: Math.round((qty / pack) * 1e4) / 1e4,
    });
  }
  return { releases, plannedReceipts };
}

/**
 * Roll the whole two-echelon tree bottom-up: net each branch, sum branch RELEASES into the DC's gross
 * requirements (by period), net the DC, and the DC's releases are the supplier-facing requirements.
 * Returns the per-node releases keyed by nodeCode. `demandByBranch` is each branch's per-period gross
 * demand; the maps carry the node economics.
 */
export function drpRollup(
  startDs: string,
  H: number,
  branches: DrpNodeInput[],
  dc: (grossReq: number[]) => DrpNodeInput,   // build the DC input given its rolled-up gross req
  dcNodeCode: string,
  supplierNodeCode: string,
): { byNode: Map<string, DrpRelease[]>; dcGrossReq: number[] } {
  const byNode = new Map<string, DrpRelease[]>();
  const dcGrossReq = new Array(H).fill(0);
  for (const b of branches) {
    const { releases } = drpNode(b, startDs, dcNodeCode);
    byNode.set(b.nodeCode, releases);
    // a branch release on day d is a unit the DC must have shipped that day → DC gross req at d
    for (const r of releases) {
      const t = daysBetweenYmd(startDs, r.order_ds);
      if (t >= 0 && t < H) dcGrossReq[t] += r.qty;
    }
  }
  const dcInput = dc(dcGrossReq);
  const { releases: dcReleases } = drpNode({ ...dcInput, nodeCode: dcNodeCode }, startDs, supplierNodeCode);
  byNode.set(dcNodeCode, dcReleases);
  return { byNode, dcGrossReq };
}

export function daysBetweenYmd(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(da) || !Number.isFinite(db)) return 0;
  return Math.round((db - da) / 86_400_000);
}
