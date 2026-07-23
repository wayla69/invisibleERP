import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { scmNetworkPlans, scmNetworkPlanLines } from '../../database/schema';
import { n, ymd } from '../../database/queries';
import { addDaysYmd } from '../demand-ml/forecast-algorithms';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';
import { ProcurementService } from '../procurement/procurement.service';
import { StatusLogService } from '../../common/status-log.service';

// docs/57 Track B (B2b) — the network-plan LIFECYCLE + reads (control SCM-05).
//
// Draft → PendingApproval → Approved → Converted. The maker is the SUBMITTER (not created_by — a
// nightly run is scheduler-created); approve binds maker≠approver via assertMakerChecker (→ 403
// SOD_SELF_APPROVAL under the enterprise profile). Only an Approved plan may roll up, and the roll-up
// of the DC's supplier-facing order goes through the EXISTING ProcurementService.createPr seam
// (idempotent by pr_no) — Track B writes no PR/PO rows and posts no GL of its own.

export const RejectBody = z.object({ reason: z.string().min(1).max(500) });
export const ApproveBody = z.object({ self_approval_reason: z.string().max(500).optional() });

@Injectable()
export class ScmNetworkPlanService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly procurement: ProcurementService,
    private readonly statusLog: StatusLogService,
  ) {}

  private tenantEq(tenantId: number | null) {
    return tenantId != null ? eq(scmNetworkPlans.tenantId, tenantId) : sql`true`;
  }

  async listPlans(user: JwtUser, q: { status?: string; limit?: number } = {}) {
    const tenantId = user.tenantId ?? null;
    const conds = [this.tenantEq(tenantId)];
    if (q.status) conds.push(eq(scmNetworkPlans.status, q.status));
    const rows = await this.db.select().from(scmNetworkPlans).where(and(...conds))
      .orderBy(desc(scmNetworkPlans.createdAt)).limit(Math.min(Math.max(q.limit ?? 50, 1), 200));
    return rows;
  }

  private async loadPlan(id: number, tenantId: number | null) {
    const [plan] = await this.db.select().from(scmNetworkPlans)
      .where(and(eq(scmNetworkPlans.id, id), this.tenantEq(tenantId))).limit(1);
    if (!plan) throw new NotFoundException({ code: 'NETWORK_PLAN_NOT_FOUND', message: 'network plan not found' });
    return plan;
  }

  async getPlan(id: number, user: JwtUser) {
    const tenantId = user.tenantId ?? null;
    const plan = await this.loadPlan(id, tenantId);
    const lines = await this.db.select().from(scmNetworkPlanLines)
      .where(and(eq(scmNetworkPlanLines.planId, id), tenantId != null ? eq(scmNetworkPlanLines.tenantId, tenantId) : sql`true`));
    return { plan, lines };
  }

  async submitPlan(id: number, user: JwtUser) {
    const tenantId = user.tenantId ?? null;
    const plan = await this.loadPlan(id, tenantId);
    if (plan.status !== 'Draft' && plan.status !== 'Rejected') {
      throw new ConflictException({ code: 'NETWORK_PLAN_NOT_DRAFT', message: `plan is ${plan.status}, only a Draft/Rejected plan can be submitted` });
    }
    await this.db.update(scmNetworkPlans)
      .set({ status: 'PendingApproval', submittedBy: user.username, submittedAt: new Date(), rejectReason: null })
      .where(and(eq(scmNetworkPlans.id, id), this.tenantEq(tenantId)));
    await this.statusLog.log('SCMN', plan.planNo, plan.status, 'PendingApproval', user.username);
    return { plan_no: plan.planNo, status: 'PendingApproval' };
  }

  // control SCM-05: a DIFFERENT person than the submitter must approve before any roll-up.
  async approvePlan(id: number, body: z.infer<typeof ApproveBody>, user: JwtUser) {
    const tenantId = user.tenantId ?? null;
    const plan = await this.loadPlan(id, tenantId);
    if (plan.status !== 'PendingApproval') {
      throw new ConflictException({ code: 'NETWORK_PLAN_NOT_PENDING', message: `plan is ${plan.status}, only a PendingApproval plan can be approved` });
    }
    await assertMakerChecker(this.db, {
      user,
      maker: plan.submittedBy ?? plan.createdBy ?? '',
      event: 'scm.network-plan.approve',
      ref: plan.planNo,
      amount: n(plan.estTotalCost),
      reason: body.self_approval_reason,
    });
    await this.db.update(scmNetworkPlans)
      .set({ status: 'Approved', approvedBy: user.username, approvedAt: new Date() })
      .where(and(eq(scmNetworkPlans.id, id), this.tenantEq(tenantId)));
    await this.statusLog.log('SCMN', plan.planNo, 'PendingApproval', 'Approved', user.username);
    return { plan_no: plan.planNo, status: 'Approved' };
  }

  async rejectPlan(id: number, body: z.infer<typeof RejectBody>, user: JwtUser) {
    const tenantId = user.tenantId ?? null;
    const plan = await this.loadPlan(id, tenantId);
    if (plan.status !== 'PendingApproval') {
      throw new ConflictException({ code: 'NETWORK_PLAN_NOT_PENDING', message: `plan is ${plan.status}, only a PendingApproval plan can be rejected` });
    }
    await this.db.update(scmNetworkPlans)
      .set({ status: 'Rejected', rejectReason: body.reason })
      .where(and(eq(scmNetworkPlans.id, id), this.tenantEq(tenantId)));
    await this.statusLog.log('SCMN', plan.planNo, 'PendingApproval', 'Rejected', user.username, body.reason);
    return { plan_no: plan.planNo, status: 'Rejected' };
  }

  // Roll up the DC's SUPPLIER-facing order to a PR through the existing procurement seam — idempotent
  // by pr_no (a second convert returns the first PR). Only an Approved plan converts.
  async convertPlan(id: number, user: JwtUser) {
    const tenantId = user.tenantId ?? null;
    const plan = await this.loadPlan(id, tenantId);
    if (plan.prNo) return { plan_no: plan.planNo, pr_no: plan.prNo, status: 'Converted', idempotent: true };
    if (plan.status !== 'Approved') {
      throw new ConflictException({ code: 'NETWORK_PLAN_NOT_APPROVED', message: `plan is ${plan.status}, only an Approved plan can be converted` });
    }
    const lines = await this.db.select().from(scmNetworkPlanLines)
      .where(and(eq(scmNetworkPlanLines.planId, id), tenantId != null ? eq(scmNetworkPlanLines.tenantId, tenantId) : sql`true`));
    // The supplier-facing release is the DC (echelon 1) line's order. (Full time-phased DRP is B4.)
    const dcQty = lines.filter((l) => l.echelon === 1).reduce((a, l) => a + n(l.orderQty), 0);
    if (dcQty <= 0) {
      throw new BadRequestException({ code: 'NETWORK_PLAN_NOTHING_TO_ORDER', message: 'the DC line has no supplier-facing order to roll up' });
    }
    const pr = await this.procurement.createPr({
      remarks: `SCM network plan ${plan.planNo}`,
      items: [{
        item_id: plan.itemCode,
        request_qty: dcQty,
        required_date: addDaysYmd(ymd(), 3),
        reason: 'SCM-NET',
      }],
    }, user);
    await this.db.update(scmNetworkPlans)
      .set({ status: 'Converted', prNo: pr.pr_no, convertedAt: new Date() })
      .where(and(eq(scmNetworkPlans.id, id), this.tenantEq(tenantId)));
    await this.statusLog.log('SCMN', plan.planNo, 'Approved', 'Converted', user.username, `PR ${pr.pr_no}`);
    return { plan_no: plan.planNo, pr_no: pr.pr_no, status: 'Converted', idempotent: false };
  }
}
