import { BadRequestException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DrizzleDb } from '../../database/database.module';
import { branches, itemCategories, scmForecastHierarchy } from '../../database/schema';

// docs/58 Track C (C1) — hierarchy DEFINITION + assembly for forecast reconciliation.
//
// Owns the governed `scm_forecast_hierarchy` master data (declare / list / delete) and the ASSEMBLER
// the reconciliation step (C2) consumes: `forest(tenant, axis)` returns the node forest a tenant
// declared, or — when none is declared — SYNTHESIZES one from the native structure (branches for the
// branch axis, item_categories for the item axis). No engine call here; C1 is definition only.
//
// db-only sub-service, built positionally in the ScmPlanningService ctor body (the scm-extract split
// precedent) so the facade stays under the check-service-size cap.

export type HierAxis = 'branch' | 'item';

export interface HierNode {
  node_id: string;          // stable id for the reconciliation contract
  parent_id: string | null; // null = a root (the total)
  node_code: string;
  name: string | null;
  level: number;            // 0 = leaf, increasing toward the root
  ref_kind: string | null;  // 'branch' | 'item_category' | 'group'
  ref_id: string | null;
  synthesized: boolean;
}

export interface HierForest {
  axis: HierAxis;
  source: 'declared' | 'synthesized';
  nodes: HierNode[];
}

// One declared node in a bulk `declare` payload (parent referenced by natural code, not DB id).
export const HierNodeInput = z.object({
  node_code: z.string().min(1).max(64),
  parent_code: z.string().min(1).max(64).nullable().optional(),
  name: z.string().max(200).optional(),
  name_th: z.string().max(200).optional(),
  ref_kind: z.enum(['branch', 'item_category', 'group']).optional(),
  ref_id: z.string().max(128).optional(),
});
export type HierNodeInputDto = z.infer<typeof HierNodeInput>;

export const HierDeclareBody = z.object({
  axis: z.enum(['branch', 'item']),
  nodes: z.array(HierNodeInput).max(2000), // empty ⇒ clear the declared structure (revert to synthesized)
});
export type HierDeclareDto = z.infer<typeof HierDeclareBody>;

export class ScmHierarchyService {
  constructor(private readonly db: DrizzleDb) {}

  /** Declared rows for a tenant, optionally one axis (root-first for a readable tree). */
  async list(tenantId: number | null, axis?: HierAxis) {
    return this.db.select().from(scmForecastHierarchy).where(and(
      tenantId != null ? eq(scmForecastHierarchy.tenantId, tenantId) : sql`true`,
      axis ? eq(scmForecastHierarchy.axis, axis) : sql`true`,
    )).orderBy(asc(scmForecastHierarchy.axis), asc(scmForecastHierarchy.level), asc(scmForecastHierarchy.nodeCode));
  }

  /**
   * Bulk-replace an axis's declared nodes for a tenant (governed master data). Validates the forest —
   * unique codes, resolvable parents, no cycle — then deletes the axis's rows and inserts the new set
   * root-first so `parent_id` resolves to the freshly-inserted parent. Empty `nodes` clears the axis.
   */
  async declare(tenantId: number | null, dto: HierDeclareDto, actor: string) {
    const { axis, nodes } = dto;
    const prepared = this.validateForest(nodes);

    // Idempotent replace: drop the axis's current declaration, then insert the validated set.
    await this.db.delete(scmForecastHierarchy).where(and(
      tenantId != null ? eq(scmForecastHierarchy.tenantId, tenantId) : sql`true`,
      eq(scmForecastHierarchy.axis, axis),
    ));

    const idByCode = new Map<string, number>();
    for (const node of prepared) { // prepared is depth-ascending (roots first)
      const parentId = node.parent_code != null ? idByCode.get(node.parent_code) ?? null : null;
      const [row] = await this.db.insert(scmForecastHierarchy).values({
        tenantId: tenantId ?? null,
        axis,
        nodeCode: node.node_code,
        name: node.name ?? null,
        nameTh: node.name_th ?? null,
        parentId,
        level: node.level,
        refKind: node.ref_kind ?? null,
        refId: node.ref_id ?? null,
        active: true,
        createdBy: actor,
      }).returning({ id: scmForecastHierarchy.id });
      idByCode.set(node.node_code, row!.id);
    }
    return this.list(tenantId, axis);
  }

  /** Delete one declared node. Combined (id, tenant) check — never assume the id is the caller's. */
  async remove(tenantId: number | null, id: number) {
    const res = await this.db.delete(scmForecastHierarchy).where(and(
      eq(scmForecastHierarchy.id, id),
      tenantId != null ? eq(scmForecastHierarchy.tenantId, tenantId) : sql`true`,
    )).returning({ id: scmForecastHierarchy.id });
    return { deleted: res.length };
  }

  /** The assembler: a tenant's declared forest, or a synthesized one from the native structure. */
  async forest(tenantId: number | null, axis: HierAxis): Promise<HierForest> {
    const declared = await this.list(tenantId, axis);
    if (declared.length) {
      return {
        axis,
        source: 'declared',
        nodes: declared.map((r) => ({
          node_id: `H${r.id}`,
          parent_id: r.parentId != null ? `H${r.parentId}` : null,
          node_code: r.nodeCode,
          name: r.name ?? null,
          level: r.level,
          ref_kind: r.refKind ?? null,
          ref_id: r.refId ?? null,
          synthesized: false,
        })),
      };
    }
    return { axis, source: 'synthesized', nodes: await this.synthesize(tenantId, axis) };
  }

  // ── internals ──

  /** Synthesize a 2-level forest (leaves → one TOTAL root) from the native structure. */
  private async synthesize(tenantId: number | null, axis: HierAxis): Promise<HierNode[]> {
    const root: HierNode = {
      node_id: 'root', parent_id: null, node_code: 'TOTAL', name: 'Total',
      level: 1, ref_kind: 'group', ref_id: null, synthesized: true,
    };
    if (axis === 'branch') {
      const rows = await this.db.select({ id: branches.id, code: branches.code, name: branches.name })
        .from(branches).where(and(
          tenantId != null ? eq(branches.tenantId, tenantId) : sql`true`,
          sql`coalesce(${branches.active}, true) = true`,
        )).orderBy(asc(branches.code));
      const leaves: HierNode[] = rows.map((b) => ({
        node_id: `branch:${b.id}`, parent_id: 'root', node_code: b.code, name: b.name,
        level: 0, ref_kind: 'branch', ref_id: String(b.id), synthesized: true,
      }));
      return [root, ...leaves];
    }
    const cats = await this.db.select({ code: itemCategories.code, name: itemCategories.name })
      .from(itemCategories).where(and(
        tenantId != null ? eq(itemCategories.tenantId, tenantId) : sql`true`,
        eq(itemCategories.active, true),
      )).orderBy(asc(itemCategories.code));
    const leaves: HierNode[] = cats.map((c) => ({
      node_id: `cat:${c.code}`, parent_id: 'root', node_code: c.code, name: c.name ?? null,
      level: 0, ref_kind: 'item_category', ref_id: c.code, synthesized: true,
    }));
    return [root, ...leaves];
  }

  /**
   * Validate a declared node set is a forest and compute each node's `level` (0 = leaf, up to the
   * root). Returns the nodes ordered root-first (ascending depth-from-root) for insertion.
   */
  private validateForest(nodes: HierNodeInputDto[]): (HierNodeInputDto & { level: number })[] {
    const bad = (message: string): never => {
      throw new BadRequestException({ code: 'SCM_HIERARCHY_INVALID', message, messageTh: 'โครงสร้างการรวมพยากรณ์ไม่ถูกต้อง' });
    };
    if (!nodes.length) return [];

    const byCode = new Map<string, HierNodeInputDto>();
    for (const node of nodes) {
      if (byCode.has(node.node_code)) bad(`duplicate node_code '${node.node_code}'`);
      byCode.set(node.node_code, node);
    }
    for (const node of nodes) {
      if (node.parent_code != null) {
        if (node.parent_code === node.node_code) bad(`node '${node.node_code}' is its own parent`);
        if (!byCode.has(node.parent_code)) bad(`node '${node.node_code}' references unknown parent '${node.parent_code}'`);
      }
    }
    // Every node must reach a root within N hops, else there is a cycle.
    const depthFromRoot = new Map<string, number>();
    for (const start of nodes) {
      let depth = 0;
      let cur: string | null | undefined = start.node_code;
      const seen = new Set<string>();
      while (cur != null) {
        if (seen.has(cur)) bad(`cycle detected at node '${start.node_code}'`);
        seen.add(cur);
        const parent: string | null = byCode.get(cur)!.parent_code ?? null;
        if (parent == null) break;
        cur = parent;
        depth++;
      }
      depthFromRoot.set(start.node_code, depth);
    }
    // level = height above the deepest leaf under a node (leaves = 0). Compute via children map.
    const children = new Map<string, string[]>();
    for (const node of nodes) {
      if (node.parent_code != null) {
        const arr = children.get(node.parent_code) ?? [];
        arr.push(node.node_code);
        children.set(node.parent_code, arr);
      }
    }
    const levelMemo = new Map<string, number>();
    const height = (code: string): number => {
      if (levelMemo.has(code)) return levelMemo.get(code)!;
      const kids = children.get(code) ?? [];
      const h = kids.length ? 1 + Math.max(...kids.map(height)) : 0;
      levelMemo.set(code, h);
      return h;
    };

    return nodes
      .map((node) => ({ ...node, level: height(node.node_code) }))
      .sort((a, b) => (depthFromRoot.get(a.node_code)! - depthFromRoot.get(b.node_code)!));
  }
}
