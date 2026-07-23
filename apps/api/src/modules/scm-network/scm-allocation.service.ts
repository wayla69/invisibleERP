import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { scmAllocationOverrides, scmAllocationPolicies, scmNetworkPlans } from '../../database/schema';
import { ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';
import { StatusLogService } from '../../common/status-log.service';

// docs/57 Track B (B3) — DC-shortage allocation fairness (control SCM-06).
//
// Two responsibilities, both maker-checker'd (maker `scm_allocate` ≠ approver `scm_approve`, SoD R25):
//   1. The GOVERNED allocation POLICY per DC (method + priority weights) — how scarce DC stock is
//      rationed across branches when it cannot fill the sum of their replenishment orders.
//   2. A per-plan OVERRIDE of the computed fair-share — rejected unless a justification is recorded
//      (ALLOCATION_OVERRIDE_UNLOGGED) and staged for a SECOND approver (never auto-applied).
// It also owns the PURE rationing primitive `allocateShortage` the run + engine fallback call, and the
// trust-boundary check `assertAllocationSound` (0 ≤ allocated, Σ allocated ≤ available).

export type AllocMethod = 'proportional' | 'fair_share' | 'priority';

export interface AllocInput {
  node: string;        // branch node_code
  requested: number;   // its replenishment order from the DC (r_i)
  mu: number;          // its mean daily demand (for equal-runout)
  onHand: number;      // its projected on-hand
}
export interface AllocLine {
  ds: string;
  from_node: string;
  to_node: string;
  requested: number;
  allocated: number;
  shortfall: number;
}

const METHODS = ['proportional', 'fair_share', 'priority'] as const;

export const PolicyBody = z.object({
  dc_node_code: z.string().min(1).max(64),
  method: z.enum(METHODS).default('proportional'),
  priorities: z.record(z.string(), z.number().nonnegative()).default({}),
  reason: z.string().max(500).optional(),
});
export const ApproveBody = z.object({ self_approval_reason: z.string().max(500).optional() });
export const RejectBody = z.object({ reason: z.string().min(1).max(500) });
export const OverrideBody = z.object({
  // The maker's proposed allocation per branch; justification is MANDATORY (an unlogged override → 403).
  allocations: z.array(z.object({ to_node: z.string().min(1), allocated: z.number().nonnegative() })).min(1),
  justification: z.string().max(1000).optional(),
});

@Injectable()
export class ScmAllocationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly statusLog: StatusLogService,
  ) {}

  // ── pure rationing (also unit-testable; mirrors the engine's network.py allocate) ──────────────────

  /**
   * Ration `available` DC stock across branch `reqs` by `method`. Guarantees `a_i ≥ 0` and
   * `Σ a_i ≤ available`, and is symmetric under equal `(requested, mu, onHand[, weight])`. Returns the
   * per-branch allocated amount in the input order. When `available ≥ Σ requested` there is no shortage
   * and every branch is fully allocated.
   */
  static allocateShortage(
    reqs: AllocInput[],
    available: number,
    method: AllocMethod = 'proportional',
    priorities: Record<string, number> = {},
  ): number[] {
    const A = Math.max(0, available);
    const totalReq = reqs.reduce((s, r) => s + Math.max(0, r.requested), 0);
    if (totalReq <= 0) return reqs.map(() => 0);
    if (A >= totalReq) return reqs.map((r) => Math.max(0, r.requested)); // no shortage — fill all

    if (method === 'fair_share') return ScmAllocationService.equalRunout(reqs, A);
    if (method === 'priority') return ScmAllocationService.byPriority(reqs, A, priorities);
    return ScmAllocationService.proportional(reqs, A, totalReq);
  }

  private static proportional(reqs: AllocInput[], A: number, totalReq: number): number[] {
    return reqs.map((r) => (A * Math.max(0, r.requested)) / totalReq);
  }

  /** Equal-runout: allocate so active branches reach the SAME projected days-of-cover d, capped at the
   *  request; solved by the water-filling breakpoint over t_i = onHand_i/mu_i. */
  private static equalRunout(reqs: AllocInput[], A: number): number[] {
    const idx = reqs.map((r, i) => ({ i, mu: Math.max(0, r.mu), onHand: Math.max(0, r.onHand), req: Math.max(0, r.requested) }));
    const withDemand = idx.filter((x) => x.mu > 0);
    if (!withDemand.length) return ScmAllocationService.proportional(reqs, A, reqs.reduce((s, r) => s + Math.max(0, r.requested), 0));
    // Water-filling over breakpoints t_i = onHand_i/mu_i (a branch becomes "active" once d passes t_i):
    // raise the level d over active branches 0..k until the candidate d no longer reaches the next
    // breakpoint (no further branch joins) — that is the coherent equal-runout water level.
    const bps = [...withDemand].sort((a, b) => a.onHand / a.mu - b.onHand / b.mu);
    let d = 0;
    for (let k = 0; k < bps.length; k++) {
      const active = bps.slice(0, k + 1);
      const sumMu = active.reduce((s, x) => s + x.mu, 0);
      const sumOn = active.reduce((s, x) => s + x.onHand, 0);
      const cand = (A + sumOn) / sumMu;
      const hi = k + 1 < bps.length ? bps[k + 1]!.onHand / bps[k + 1]!.mu : Infinity;
      d = cand;
      if (cand <= hi) break;
    }
    const alloc = new Array(reqs.length).fill(0);
    for (const x of withDemand) alloc[x.i] = Math.min(x.req, Math.max(0, d * x.mu - x.onHand));
    // renormalize to exactly A (rounding / the cap at request may leave slack)
    return ScmAllocationService.rescale(alloc, A);
  }

  /** Priority tiers (higher weight served first); fair-share proportionally WITHIN a tier before the
   *  next tier is served. Branches with no weight share the lowest tier (weight 0). */
  private static byPriority(reqs: AllocInput[], A: number, priorities: Record<string, number>): number[] {
    const alloc = new Array(reqs.length).fill(0);
    const tiers = [...new Set(reqs.map((r) => Number(priorities[r.node] ?? 0)))].sort((a, b) => b - a);
    let remaining = A;
    for (const w of tiers) {
      if (remaining <= 0) break;
      const members = reqs.map((r, i) => ({ i, req: Math.max(0, r.requested) })).filter((m) => Number(priorities[reqs[m.i]!.node] ?? 0) === w);
      const tierReq = members.reduce((s, m) => s + m.req, 0);
      if (tierReq <= 0) continue;
      const give = Math.min(remaining, tierReq);
      for (const m of members) alloc[m.i] = (give * m.req) / tierReq;
      remaining -= give;
    }
    return alloc;
  }

  private static rescale(alloc: number[], target: number): number[] {
    const sum = alloc.reduce((s, v) => s + v, 0);
    if (sum <= 0) return alloc;
    const k = Math.min(1, target / sum); // never exceed available; equal-runout may under-fill (kept)
    return alloc.map((v) => v * k);
  }

  /** Build the persisted allocation lines from branch requests + the available DC stock + the method. */
  static buildLines(dcNode: string, reqs: AllocInput[], available: number, method: AllocMethod, priorities: Record<string, number>, ds = ymd()): AllocLine[] {
    const totalReq = reqs.reduce((s, r) => s + Math.max(0, r.requested), 0);
    if (totalReq <= 0 || available >= totalReq) return []; // no projected shortage ⇒ no rationing lines
    const alloc = ScmAllocationService.allocateShortage(reqs, available, method, priorities);
    return reqs.map((r, i) => {
      const allocated = Math.round((alloc[i] ?? 0) * 1e4) / 1e4;
      return { ds, from_node: dcNode, to_node: r.node, requested: Math.max(0, r.requested), allocated, shortfall: Math.round(Math.max(0, r.requested - allocated) * 1e4) / 1e4 };
    });
  }

  /** Trust boundary (docs/57 §4.2): reject an allocation set that is negative or over-issues the DC. */
  static assertAllocationSound(lines: AllocLine[], available: number): void {
    let sum = 0;
    for (const l of lines) {
      if (!(l.allocated >= 0)) throw new BadRequestException({ code: 'ALLOCATION_NEGATIVE', message: `allocation to ${l.to_node} is negative` });
      sum += l.allocated;
    }
    if (sum > available + 1e-6) throw new BadRequestException({ code: 'ALLOCATION_OVER_AVAILABLE', message: 'total allocation exceeds available DC stock' });
  }

  // ── policy governance (control SCM-06 / SoD R25) ────────────────────────────────────────────────────

  private tenantEq(tenantId: number | null) {
    return tenantId != null ? eq(scmAllocationPolicies.tenantId, tenantId) : sql`true`;
  }

  /** The APPROVED policy for a DC (freshest wins), else the proportional default. Read by the run. */
  async effectivePolicy(tenantId: number | null, dcNodeCode: string): Promise<{ method: AllocMethod; priorities: Record<string, number> }> {
    const [row] = await this.db.select().from(scmAllocationPolicies)
      .where(and(
        tenantId != null ? eq(scmAllocationPolicies.tenantId, tenantId) : sql`true`,
        eq(scmAllocationPolicies.dcNodeCode, dcNodeCode),
        eq(scmAllocationPolicies.status, 'Approved'),
      ))
      .orderBy(desc(scmAllocationPolicies.approvedAt)).limit(1);
    if (!row) return { method: 'proportional', priorities: {} };
    return { method: (row.method as AllocMethod) ?? 'proportional', priorities: (row.priorities as Record<string, number>) ?? {} };
  }

  async listPolicies(user: JwtUser, q: { dc_node_code?: string; status?: string } = {}) {
    const tenantId = user.tenantId ?? null;
    const conds = [this.tenantEq(tenantId)];
    if (q.dc_node_code) conds.push(eq(scmAllocationPolicies.dcNodeCode, q.dc_node_code));
    if (q.status) conds.push(eq(scmAllocationPolicies.status, q.status));
    return this.db.select().from(scmAllocationPolicies).where(and(...conds)).orderBy(desc(scmAllocationPolicies.createdAt)).limit(200);
  }

  /** Set/change a DC's allocation policy — staged as PendingApproval (needs a DIFFERENT approver). */
  async setPolicy(user: JwtUser, body: z.infer<typeof PolicyBody>) {
    const tenantId = user.tenantId ?? null;
    const [row] = await this.db.insert(scmAllocationPolicies).values({
      tenantId, dcNodeCode: body.dc_node_code, method: body.method, priorities: body.priorities,
      status: 'PendingApproval', reason: body.reason ?? null, createdBy: user.username, submittedBy: user.username,
    }).returning({ id: scmAllocationPolicies.id });
    await this.statusLog.log('SCMALLOC', `POL-${row!.id}`, '', 'PendingApproval', user.username);
    return { id: row!.id, dc_node_code: body.dc_node_code, method: body.method, status: 'PendingApproval' };
  }

  async approvePolicy(id: number, body: z.infer<typeof ApproveBody>, user: JwtUser) {
    const tenantId = user.tenantId ?? null;
    const [row] = await this.db.select().from(scmAllocationPolicies)
      .where(and(eq(scmAllocationPolicies.id, id), this.tenantEq(tenantId))).limit(1);
    if (!row) throw new NotFoundException({ code: 'ALLOCATION_POLICY_NOT_FOUND', message: 'allocation policy not found' });
    if (row.status !== 'PendingApproval') throw new ConflictException({ code: 'ALLOCATION_POLICY_NOT_PENDING', message: `policy is ${row.status}` });
    await assertMakerChecker(this.db, {
      user, maker: row.submittedBy ?? row.createdBy ?? '',
      event: 'scm.allocation-policy.approve', ref: `POL-${id}`, reason: body.self_approval_reason,
    });
    // supersede any prior Approved policy for this DC so `effectivePolicy` stays single-valued
    await this.db.update(scmAllocationPolicies)
      .set({ status: 'Rejected', rejectReason: `superseded by POL-${id}` })
      .where(and(this.tenantEq(tenantId), eq(scmAllocationPolicies.dcNodeCode, row.dcNodeCode), eq(scmAllocationPolicies.status, 'Approved')));
    await this.db.update(scmAllocationPolicies)
      .set({ status: 'Approved', approvedBy: user.username, approvedAt: new Date() })
      .where(and(eq(scmAllocationPolicies.id, id), this.tenantEq(tenantId)));
    await this.statusLog.log('SCMALLOC', `POL-${id}`, 'PendingApproval', 'Approved', user.username);
    return { id, dc_node_code: row.dcNodeCode, status: 'Approved' };
  }

  async rejectPolicy(id: number, body: z.infer<typeof RejectBody>, user: JwtUser) {
    const tenantId = user.tenantId ?? null;
    const [row] = await this.db.select().from(scmAllocationPolicies)
      .where(and(eq(scmAllocationPolicies.id, id), this.tenantEq(tenantId))).limit(1);
    if (!row) throw new NotFoundException({ code: 'ALLOCATION_POLICY_NOT_FOUND', message: 'allocation policy not found' });
    if (row.status !== 'PendingApproval') throw new ConflictException({ code: 'ALLOCATION_POLICY_NOT_PENDING', message: `policy is ${row.status}` });
    await this.db.update(scmAllocationPolicies).set({ status: 'Rejected', rejectReason: body.reason })
      .where(and(eq(scmAllocationPolicies.id, id), this.tenantEq(tenantId)));
    return { id, status: 'Rejected' };
  }

  // ── per-plan override staging (the two-person control) ──────────────────────────────────────────────

  private async loadPlan(planId: number, tenantId: number | null) {
    const [plan] = await this.db.select().from(scmNetworkPlans)
      .where(and(eq(scmNetworkPlans.id, planId), tenantId != null ? eq(scmNetworkPlans.tenantId, tenantId) : sql`true`)).limit(1);
    if (!plan) throw new NotFoundException({ code: 'NETWORK_PLAN_NOT_FOUND', message: 'network plan not found' });
    return plan;
  }

  /** Stage an override of a plan's computed fair-share. An UNLOGGED override (no justification) is
   *  rejected outright (ALLOCATION_OVERRIDE_UNLOGGED); a logged one is staged for a second approver. */
  async stageOverride(planId: number, body: z.infer<typeof OverrideBody>, user: JwtUser) {
    const tenantId = user.tenantId ?? null;
    const plan = await this.loadPlan(planId, tenantId);
    const justification = (body.justification ?? '').trim();
    if (!justification) {
      // A control rejection, not a mere validation error: an unlogged deviation from the approved
      // fair-share is forbidden outright (§5) — a favoured branch cannot be served off the record.
      throw new ForbiddenException({ code: 'ALLOCATION_OVERRIDE_UNLOGGED', message: 'an allocation override must record a justification' });
    }
    const [row] = await this.db.insert(scmAllocationOverrides).values({
      tenantId, planId, proposed: body.allocations, justification, status: 'PendingApproval', requestedBy: user.username,
    }).returning({ id: scmAllocationOverrides.id });
    await this.statusLog.log('SCMALLOC', `OVR-${row!.id}`, '', 'PendingApproval', user.username, `plan ${plan.planNo}`);
    // NOT applied to the plan yet — a DIFFERENT approver must approve it first.
    return { id: row!.id, plan_no: plan.planNo, status: 'PendingApproval', applied: false };
  }

  async approveOverride(id: number, body: z.infer<typeof ApproveBody>, user: JwtUser) {
    const tenantId = user.tenantId ?? null;
    const [row] = await this.db.select().from(scmAllocationOverrides)
      .where(and(eq(scmAllocationOverrides.id, id), tenantId != null ? eq(scmAllocationOverrides.tenantId, tenantId) : sql`true`)).limit(1);
    if (!row) throw new NotFoundException({ code: 'ALLOCATION_OVERRIDE_NOT_FOUND', message: 'allocation override not found' });
    if (row.status !== 'PendingApproval') throw new ConflictException({ code: 'ALLOCATION_OVERRIDE_NOT_PENDING', message: `override is ${row.status}` });
    await assertMakerChecker(this.db, {
      user, maker: row.requestedBy ?? '',
      event: 'scm.allocation-override.approve', ref: `OVR-${id}`, reason: body.self_approval_reason,
    });
    const plan = await this.loadPlan(row.planId, tenantId);
    await this.db.update(scmAllocationOverrides)
      .set({ status: 'Approved', approvedBy: user.username, approvedAt: new Date() })
      .where(and(eq(scmAllocationOverrides.id, id), tenantId != null ? eq(scmAllocationOverrides.tenantId, tenantId) : sql`true`));
    // only NOW is the override applied to the plan's persisted allocations
    await this.db.update(scmNetworkPlans).set({ allocations: row.proposed as object[] })
      .where(and(eq(scmNetworkPlans.id, row.planId), tenantId != null ? eq(scmNetworkPlans.tenantId, tenantId) : sql`true`));
    await this.statusLog.log('SCMALLOC', `OVR-${id}`, 'PendingApproval', 'Approved', user.username, `applied to ${plan.planNo}`);
    return { id, plan_no: plan.planNo, status: 'Approved', applied: true };
  }

  async listOverrides(user: JwtUser, q: { plan_id?: number; status?: string } = {}) {
    const tenantId = user.tenantId ?? null;
    const conds = [tenantId != null ? eq(scmAllocationOverrides.tenantId, tenantId) : sql`true`];
    if (q.plan_id) conds.push(eq(scmAllocationOverrides.planId, q.plan_id));
    if (q.status) conds.push(eq(scmAllocationOverrides.status, q.status));
    return this.db.select().from(scmAllocationOverrides).where(and(...conds)).orderBy(desc(scmAllocationOverrides.requestedAt)).limit(200);
  }
}
