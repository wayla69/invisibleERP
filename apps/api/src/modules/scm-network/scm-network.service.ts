import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import type { JwtUser } from '../../common/decorators';
import { isUniqueViolation } from '../../common/db-error';
import { supplyLanes, supplyNodes } from '../../database/schema';
import {
  validateTopology, type NodeKind, type TopoNode, type TopoLane,
} from './scm-network-topology';

// docs/57 Track B (B1) — supply-network master-data service.
//
// Governed CRUD for supply_nodes / supply_lanes + topology assembly and validation. Definition only:
// no engine call, no plan lifecycle, no PR handoff (those land in B2/B4). Every read/mutation is
// tenant-scoped (RLS at the DB, plus an explicit (id, tenant) guard on every mutation so an id is never
// assumed to belong to the caller). Codes surface through AllExceptionsFilter as json.error.code.

const KIND = z.enum(['supplier', 'central_kitchen', 'dc', 'branch']);
const KIND_ECHELON: Record<NodeKind, number> = { supplier: 0, central_kitchen: 1, dc: 1, branch: 2 };

export const NodeBody = z.object({
  node_code: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  name_th: z.string().max(200).nullable().optional(),
  kind: KIND,
  branch_id: z.number().int().positive().nullable().optional(),
  service_time_out_days: z.number().min(0).max(365).optional(),
  holding_cost_per_day: z.number().min(0).optional(),
  active: z.boolean().optional(),
});
export type NodeDto = z.infer<typeof NodeBody>;

export const LaneBody = z.object({
  from_node_id: z.number().int().positive(),
  to_node_id: z.number().int().positive(),
  lead_time_mean_days: z.number().min(0).max(365).optional(),
  lead_time_std_days: z.number().min(0).max(365).optional(),
  unit_cost: z.number().min(0).optional(),
  moq: z.number().min(0).optional(),
  pack_size: z.number().min(0.0001).optional(),
  fixed_order_cost: z.number().min(0).optional(),
  active: z.boolean().optional(),
});
export type LaneDto = z.infer<typeof LaneBody>;

@Injectable()
export class ScmNetworkService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private static tenantOf(user: JwtUser): number | null { return user.tenantId ?? null; }

  private tenantEq(col: typeof supplyNodes.tenantId | typeof supplyLanes.tenantId, tenantId: number | null) {
    return tenantId != null ? eq(col, tenantId) : sql`true`;
  }

  // ── nodes ──

  async listNodes(user: JwtUser) {
    const tenantId = ScmNetworkService.tenantOf(user);
    return this.db.select().from(supplyNodes)
      .where(this.tenantEq(supplyNodes.tenantId, tenantId))
      .orderBy(asc(supplyNodes.echelon), asc(supplyNodes.nodeCode));
  }

  async upsertNode(dto: NodeDto, user: JwtUser) {
    const tenantId = ScmNetworkService.tenantOf(user);
    const echelon = KIND_ECHELON[dto.kind];
    if (dto.kind === 'branch' && dto.branch_id == null) {
      throw new BadRequestException({ code: 'BRANCH_NODE_NEEDS_BRANCH', message: 'a branch node must link a branch_id', messageTh: 'โหนดสาขาต้องระบุ branch_id' });
    }
    const vals = {
      name: dto.name,
      nameTh: dto.name_th ?? null,
      kind: dto.kind,
      echelon,
      branchId: dto.kind === 'branch' ? dto.branch_id ?? null : null,
      serviceTimeOutDays: dto.service_time_out_days != null ? String(dto.service_time_out_days) : (dto.kind === 'branch' ? '0' : undefined),
      holdingCostPerDay: dto.holding_cost_per_day != null ? String(dto.holding_cost_per_day) : undefined,
      active: dto.active ?? true,
      updatedAt: new Date(),
    };
    const existing = await this.db.select({ id: supplyNodes.id }).from(supplyNodes)
      .where(and(eq(supplyNodes.nodeCode, dto.node_code), this.tenantEq(supplyNodes.tenantId, tenantId)))
      .limit(1);
    try {
      if (existing.length) {
        await this.db.update(supplyNodes).set(vals)
          .where(and(eq(supplyNodes.id, existing[0]!.id), this.tenantEq(supplyNodes.tenantId, tenantId)));
        return this.getNode(existing[0]!.id, user);
      }
      const [row] = await this.db.insert(supplyNodes).values({
        tenantId: tenantId ?? null,
        nodeCode: dto.node_code,
        ...vals,
        serviceTimeOutDays: vals.serviceTimeOutDays ?? '0',
        holdingCostPerDay: vals.holdingCostPerDay ?? '0',
        createdBy: user.username,
      }).returning();
      return row;
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException({ code: 'NODE_CODE_TAKEN', message: `node_code '${dto.node_code}' already exists`, messageTh: 'รหัสโหนดนี้มีอยู่แล้ว' });
      }
      throw e;
    }
  }

  async getNode(id: number, user: JwtUser) {
    const tenantId = ScmNetworkService.tenantOf(user);
    const [row] = await this.db.select().from(supplyNodes)
      .where(and(eq(supplyNodes.id, id), this.tenantEq(supplyNodes.tenantId, tenantId))).limit(1);
    if (!row) throw new NotFoundException({ code: 'NODE_NOT_FOUND', message: 'supply node not found' });
    return row;
  }

  async deleteNode(id: number, user: JwtUser) {
    const tenantId = ScmNetworkService.tenantOf(user);
    // A node with lanes cannot be deleted — remove the lanes first (avoid orphan edges).
    const lanes = await this.db.select({ id: supplyLanes.id }).from(supplyLanes)
      .where(and(
        this.tenantEq(supplyLanes.tenantId, tenantId),
        sql`(${supplyLanes.fromNodeId} = ${id} OR ${supplyLanes.toNodeId} = ${id})`,
      )).limit(1);
    if (lanes.length) {
      throw new ConflictException({ code: 'NODE_HAS_LANES', message: 'remove the node’s lanes before deleting it', messageTh: 'ต้องลบเลนของโหนดก่อน' });
    }
    const res = await this.db.delete(supplyNodes)
      .where(and(eq(supplyNodes.id, id), this.tenantEq(supplyNodes.tenantId, tenantId)))
      .returning({ id: supplyNodes.id });
    if (!res.length) throw new NotFoundException({ code: 'NODE_NOT_FOUND', message: 'supply node not found' });
    return { deleted: res.length };
  }

  // ── lanes ──

  async listLanes(user: JwtUser) {
    const tenantId = ScmNetworkService.tenantOf(user);
    return this.db.select().from(supplyLanes)
      .where(this.tenantEq(supplyLanes.tenantId, tenantId))
      .orderBy(asc(supplyLanes.fromNodeId), asc(supplyLanes.toNodeId));
  }

  async upsertLane(dto: LaneDto, user: JwtUser) {
    const tenantId = ScmNetworkService.tenantOf(user);
    if (dto.from_node_id === dto.to_node_id) {
      throw new BadRequestException({ code: 'LANE_SELF_LOOP', message: 'a lane cannot start and end at the same node', messageTh: 'เลนต้องไม่วนกลับโหนดเดิม' });
    }
    // Both endpoints must be the caller's nodes (combined id+tenant read — never trust the id).
    const ends = await this.db.select({ id: supplyNodes.id }).from(supplyNodes)
      .where(and(inArray(supplyNodes.id, [dto.from_node_id, dto.to_node_id]), this.tenantEq(supplyNodes.tenantId, tenantId)));
    if (ends.length !== 2) {
      throw new BadRequestException({ code: 'LANE_ENDPOINTS_INVALID', message: 'both lane endpoints must be your supply nodes', messageTh: 'ปลายทั้งสองของเลนต้องเป็นโหนดของคุณ' });
    }
    const vals = {
      leadTimeMeanDays: dto.lead_time_mean_days != null ? String(dto.lead_time_mean_days) : undefined,
      leadTimeStdDays: dto.lead_time_std_days != null ? String(dto.lead_time_std_days) : undefined,
      unitCost: dto.unit_cost != null ? String(dto.unit_cost) : undefined,
      moq: dto.moq != null ? String(dto.moq) : undefined,
      packSize: dto.pack_size != null ? String(dto.pack_size) : undefined,
      fixedOrderCost: dto.fixed_order_cost != null ? String(dto.fixed_order_cost) : undefined,
      active: dto.active ?? true,
      updatedAt: new Date(),
    };
    const existing = await this.db.select({ id: supplyLanes.id }).from(supplyLanes)
      .where(and(
        eq(supplyLanes.fromNodeId, dto.from_node_id),
        eq(supplyLanes.toNodeId, dto.to_node_id),
        this.tenantEq(supplyLanes.tenantId, tenantId),
      )).limit(1);
    if (existing.length) {
      await this.db.update(supplyLanes).set(vals)
        .where(and(eq(supplyLanes.id, existing[0]!.id), this.tenantEq(supplyLanes.tenantId, tenantId)));
      const [row] = await this.db.select().from(supplyLanes).where(eq(supplyLanes.id, existing[0]!.id)).limit(1);
      return row;
    }
    const [row] = await this.db.insert(supplyLanes).values({
      tenantId: tenantId ?? null,
      fromNodeId: dto.from_node_id,
      toNodeId: dto.to_node_id,
      ...vals,
      leadTimeMeanDays: vals.leadTimeMeanDays ?? '0',
      leadTimeStdDays: vals.leadTimeStdDays ?? '0',
      unitCost: vals.unitCost ?? '0',
      moq: vals.moq ?? '0',
      packSize: vals.packSize ?? '1',
      fixedOrderCost: vals.fixedOrderCost ?? '0',
      createdBy: user.username,
    }).returning();
    return row;
  }

  async deleteLane(id: number, user: JwtUser) {
    const tenantId = ScmNetworkService.tenantOf(user);
    const res = await this.db.delete(supplyLanes)
      .where(and(eq(supplyLanes.id, id), this.tenantEq(supplyLanes.tenantId, tenantId)))
      .returning({ id: supplyLanes.id });
    if (!res.length) throw new NotFoundException({ code: 'LANE_NOT_FOUND', message: 'supply lane not found' });
    return { deleted: res.length };
  }

  // ── topology assembly + validation ──

  /** Assemble the tenant's current active topology and validate it (DAG, echelons, reachability). */
  async topology(user: JwtUser) {
    const [nodes, lanes] = await Promise.all([this.listNodes(user), this.listLanes(user)]);
    const codeById = new Map<number, string>(nodes.map((n) => [n.id, n.nodeCode]));
    const topoNodes: TopoNode[] = nodes
      .filter((n) => n.active)
      .map((n) => ({ node_code: n.nodeCode, kind: n.kind as NodeKind, echelon: n.echelon }));
    const topoLanes: TopoLane[] = lanes
      .filter((l) => l.active && codeById.has(l.fromNodeId) && codeById.has(l.toNodeId))
      .map((l) => ({ from_code: codeById.get(l.fromNodeId)!, to_code: codeById.get(l.toNodeId)! }));
    const validation = validateTopology(topoNodes, topoLanes);
    return { nodes, lanes, validation };
  }
}
