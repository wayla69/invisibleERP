// docs/57 Track B (B1) — supply-network topology validation (pure logic, no DB).
//
// Validates that a declared set of nodes + lanes forms a legal two-echelon distribution network:
//   • kind ↔ echelon consistency (supplier=0, central_kitchen/dc=1, branch=2);
//   • at most TWO stocking echelons (DC=1 + branch=2) — a 3rd tier is rejected (docs/57 §9);
//   • lanes are a DAG whose edges step down exactly one echelon (supplier→DC→branch);
//   • every non-supplier node has exactly one inbound lane (single-sourcing — docs/57 §1.2);
//   • every branch is reachable from a supplier through a DC (no orphan leaf).
//
// The validator NEVER trusts the engine: the API runs it before any optimize call so a malformed
// topology is rejected here (NETWORK_NOT_DAG etc.), not downstream. Codes mirror docs/57 §2.3.

export type NodeKind = 'supplier' | 'central_kitchen' | 'dc' | 'branch';

export interface TopoNode {
  node_code: string;
  kind: NodeKind;
  echelon: number;
}

export interface TopoLane {
  from_code: string;
  to_code: string;
}

export type TopoErrorCode =
  | 'NETWORK_NOT_DAG'
  | 'ECHELON_DEPTH_EXCEEDED'
  | 'LANE_ENDPOINTS_INVALID'
  | 'UNREACHABLE_BRANCH'
  | 'KIND_ECHELON_MISMATCH'
  | 'MULTI_SOURCED_NODE';

export interface TopoIssue {
  code: TopoErrorCode;
  message: string;
  at?: string;
}

export interface TopoResult {
  ok: boolean;
  issues: TopoIssue[];
  // Derived once valid: node_code → { echelon, inbound supplier code | null }.
  reachableBranches: string[];
}

const KIND_ECHELON: Record<NodeKind, number> = {
  supplier: 0,
  central_kitchen: 1,
  dc: 1,
  branch: 2,
};

const MAX_ECHELON = 2; // supplier(0) → DC(1) → branch(2): two stocking echelons

/** Validate a topology. Pure — same inputs always yield the same issues (deterministic order). */
export function validateTopology(nodes: TopoNode[], lanes: TopoLane[]): TopoResult {
  const issues: TopoIssue[] = [];
  const byCode = new Map<string, TopoNode>();
  for (const n of nodes) byCode.set(n.node_code, n);

  // 1. kind ↔ echelon consistency + depth bound.
  for (const n of nodes) {
    if (KIND_ECHELON[n.kind] !== n.echelon) {
      issues.push({
        code: 'KIND_ECHELON_MISMATCH',
        message: `node '${n.node_code}' kind '${n.kind}' expects echelon ${KIND_ECHELON[n.kind]}, got ${n.echelon}`,
        at: n.node_code,
      });
    }
    if (n.echelon > MAX_ECHELON) {
      issues.push({
        code: 'ECHELON_DEPTH_EXCEEDED',
        message: `node '${n.node_code}' echelon ${n.echelon} exceeds the two-echelon limit (${MAX_ECHELON})`,
        at: n.node_code,
      });
    }
  }

  // 2. lane endpoints exist, step down exactly one echelon, and no self-loop.
  const inboundCount = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const l of lanes) {
    const from = byCode.get(l.from_code);
    const to = byCode.get(l.to_code);
    if (!from || !to) {
      issues.push({
        code: 'LANE_ENDPOINTS_INVALID',
        message: `lane ${l.from_code}→${l.to_code} references an unknown node`,
        at: `${l.from_code}->${l.to_code}`,
      });
      continue;
    }
    if (from.node_code === to.node_code) {
      issues.push({ code: 'NETWORK_NOT_DAG', message: `lane ${l.from_code}→${l.to_code} is a self-loop`, at: from.node_code });
      continue;
    }
    if (to.echelon - from.echelon !== 1) {
      issues.push({
        code: 'LANE_ENDPOINTS_INVALID',
        message: `lane ${l.from_code}→${l.to_code} must step down exactly one echelon (${from.echelon}→${to.echelon})`,
        at: `${l.from_code}->${l.to_code}`,
      });
      continue;
    }
    inboundCount.set(to.node_code, (inboundCount.get(to.node_code) ?? 0) + 1);
    const arr = children.get(from.node_code) ?? [];
    arr.push(to.node_code);
    children.set(from.node_code, arr);
  }

  // 3. single-sourcing: every non-supplier node has exactly one inbound lane.
  for (const n of nodes) {
    if (n.kind === 'supplier') continue;
    const c = inboundCount.get(n.node_code) ?? 0;
    if (c > 1) {
      issues.push({ code: 'MULTI_SOURCED_NODE', message: `node '${n.node_code}' has ${c} inbound lanes (single-sourcing only)`, at: n.node_code });
    }
  }

  // 4. cycle check (DFS over the child map). Echelon-stepping edges cannot cycle, but a malformed
  //    input can still be checked cheaply and honestly rather than assumed acyclic.
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n.node_code, WHITE);
  let cyclic = false;
  const visit = (code: string): void => {
    color.set(code, GREY);
    for (const nxt of children.get(code) ?? []) {
      const c = color.get(nxt) ?? WHITE;
      if (c === GREY) { cyclic = true; return; }
      if (c === WHITE) { visit(nxt); if (cyclic) return; }
    }
    color.set(code, BLACK);
  };
  for (const n of nodes) {
    if ((color.get(n.node_code) ?? WHITE) === WHITE) { visit(n.node_code); if (cyclic) break; }
  }
  if (cyclic) issues.push({ code: 'NETWORK_NOT_DAG', message: 'topology contains a cycle' });

  // 5. reachability: every branch is reachable from a supplier (0) through a DC (1). Only compute when
  //    the structural checks above passed, so we walk a well-formed graph.
  const reachableBranches: string[] = [];
  if (!issues.length) {
    const reachable = new Set<string>();
    const suppliers = nodes.filter((n) => n.kind === 'supplier').map((n) => n.node_code);
    const stack = [...suppliers];
    while (stack.length) {
      const cur = stack.pop()!;
      if (reachable.has(cur)) continue;
      reachable.add(cur);
      for (const nxt of children.get(cur) ?? []) stack.push(nxt);
    }
    for (const n of nodes) {
      if (n.kind !== 'branch') continue;
      if (reachable.has(n.node_code)) reachableBranches.push(n.node_code);
      else issues.push({ code: 'UNREACHABLE_BRANCH', message: `branch '${n.node_code}' is not reachable from a supplier via a DC`, at: n.node_code });
    }
    reachableBranches.sort();
  }

  return { ok: issues.length === 0, issues, reachableBranches };
}
