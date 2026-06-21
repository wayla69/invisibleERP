import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, asc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { workflowDefinitions, workflowSteps, workflowInstances, approvalActions, approvalDelegations, users } from '../../database/schema';
import { ymd, n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { SodService } from './sod.service';

export interface StartWorkflowArgs { docType: string; docNo: string; amount: number; createdBy: string; tenantId: number | null; }
export interface StepDto { step_no: number; approver_role?: string; approver_user?: string; min_amount?: number; all_of_n?: number; name?: string; }

// Generic, polymorphic approval engine. A module calls start() on submit, and canTransition()/act() to gate
// its own status flips. The engine posts NOTHING to the GL — it only routes approvals. Maker-checker is
// always on (an approver can never be the document's creator).
@Injectable()
export class WorkflowService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly sod: SodService) {}

  // ── Definitions ──
  async createDefinition(dto: { doc_type: string; name: string; steps: StepDto[] }, user: JwtUser) {
    const db = this.db as any;
    if (!dto.steps?.length) throw new BadRequestException({ code: 'NO_STEPS', message: 'A workflow needs at least one step', messageTh: 'ต้องมีอย่างน้อยหนึ่งขั้น' });
    const [d] = await db.insert(workflowDefinitions).values({ tenantId: user.tenantId ?? null, docType: dto.doc_type, name: dto.name, active: true, createdBy: user.username }).returning({ id: workflowDefinitions.id });
    for (const s of dto.steps) {
      if (!(s.approver_role) === !(s.approver_user)) throw new BadRequestException({ code: 'STEP_ROLE_XOR_USER', message: 'A step needs exactly one of approver_role / approver_user', messageTh: 'ขั้นต้องระบุ role หรือ user อย่างใดอย่างหนึ่ง' });
      await db.insert(workflowSteps).values({ tenantId: user.tenantId ?? null, definitionId: Number(d.id), stepNo: s.step_no, approverRole: s.approver_role ?? null, approverUser: s.approver_user ?? null, minAmount: String(s.min_amount ?? 0), allOfN: s.all_of_n ?? 1, name: s.name ?? null });
    }
    return { id: Number(d.id) };
  }
  async listDefinitions(_user: JwtUser) {
    const db = this.db as any;
    const defs = await db.select().from(workflowDefinitions).orderBy(asc(workflowDefinitions.docType));
    const out = [] as any[];
    for (const d of defs) {
      const steps = await db.select().from(workflowSteps).where(eq(workflowSteps.definitionId, Number(d.id))).orderBy(asc(workflowSteps.stepNo));
      out.push({ id: Number(d.id), doc_type: d.docType, name: d.name, active: d.active, steps: steps.map((s: any) => ({ step_no: s.stepNo, approver_role: s.approverRole, approver_user: s.approverUser, min_amount: n(s.minAmount), all_of_n: s.allOfN })) });
    }
    return { definitions: out };
  }
  async setDefinitionActive(id: number, active: boolean, _user: JwtUser) {
    const db = this.db as any;
    await db.update(workflowDefinitions).set({ active }).where(eq(workflowDefinitions.id, id));
    return { id, active };
  }

  private async activeDef(docType: string) {
    const db = this.db as any;
    const [d] = await db.select().from(workflowDefinitions).where(and(eq(workflowDefinitions.docType, docType), eq(workflowDefinitions.active, true))).limit(1);
    return d ?? null;
  }
  private async steps(definitionId: number) {
    const db = this.db as any;
    return db.select().from(workflowSteps).where(eq(workflowSteps.definitionId, definitionId)).orderBy(asc(workflowSteps.stepNo));
  }
  // first engaged step (min_amount <= amount), in order; null = none engaged → auto-approve
  private firstEngaged(steps: any[], amount: number, after = 0) {
    return steps.filter((s) => Number(s.stepNo) > after && n(s.minAmount) <= amount).sort((a, b) => a.stepNo - b.stepNo)[0] ?? null;
  }

  // ── Engine entrypoints a module calls ──
  // Creates a pending instance routed to the first engaged step. No active definition → autoApproved (the
  // module keeps its legacy behaviour). Idempotent: a live instance for (doc_type,doc_no) is reused.
  async start(args: StartWorkflowArgs): Promise<{ instanceId: number | null; status: string; currentStep: number; autoApproved: boolean }> {
    const db = this.db as any;
    const def = await this.activeDef(args.docType);
    if (!def) return { instanceId: null, status: 'auto', currentStep: 0, autoApproved: true };
    const [existing] = await db.select().from(workflowInstances).where(and(eq(workflowInstances.docType, args.docType), eq(workflowInstances.docNo, args.docNo), eq(workflowInstances.status, 'pending'))).limit(1);
    if (existing) return { instanceId: Number(existing.id), status: existing.status, currentStep: existing.currentStep ?? 0, autoApproved: false };
    const steps = await this.steps(Number(def.id));
    // an ACTIVE definition must always require at least one approval — if a (maker-supplied, optional)
    // amount engages no step by threshold, fall back to the lowest step so the chain can't be skipped.
    const engaged = this.firstEngaged(steps, args.amount, 0) ?? [...steps].sort((a, b) => a.stepNo - b.stepNo)[0] ?? null;
    const status = engaged ? 'pending' : 'approved';
    const [inst] = await db.insert(workflowInstances).values({ tenantId: args.tenantId ?? null, definitionId: Number(def.id), docType: args.docType, docNo: args.docNo, amount: String(args.amount), createdBy: args.createdBy, status, currentStep: engaged ? engaged.stepNo : 0, closedAt: engaged ? null : new Date() }).returning({ id: workflowInstances.id });
    return { instanceId: Number(inst.id), status, currentStep: engaged ? engaged.stepNo : 0, autoApproved: !engaged };
  }

  private async liveInstance(docType: string, docNo: string) {
    const db = this.db as any;
    const [i] = await db.select().from(workflowInstances).where(and(eq(workflowInstances.docType, docType), eq(workflowInstances.docNo, docNo))).orderBy(sql`${workflowInstances.id} DESC`).limit(1);
    return i ?? null;
  }
  // the live (pending) instance for a doc, or null — used by a module's own approve handler to decide
  // whether to route through the engine or fall back to its legacy direct flip.
  async pendingInstanceFor(docType: string, docNo: string) {
    const db = this.db as any;
    const [i] = await db.select().from(workflowInstances).where(and(eq(workflowInstances.docType, docType), eq(workflowInstances.docNo, docNo), eq(workflowInstances.status, 'pending'))).limit(1);
    return i ?? null;
  }
  async canTransition(docType: string, docNo: string): Promise<boolean> {
    const i = await this.liveInstance(docType, docNo);
    return !i || i.status === 'approved'; // no instance (no workflow configured) = passthrough
  }
  async assertCanTransition(docType: string, docNo: string) {
    const i = await this.liveInstance(docType, docNo);
    if (i && i.status === 'pending') throw new ForbiddenException({ code: 'WORKFLOW_PENDING', message: `${docType} ${docNo} awaits approval`, messageTh: 'เอกสารยังรออนุมัติ' });
    if (i && i.status === 'rejected') throw new ForbiddenException({ code: 'WORKFLOW_REJECTED', message: `${docType} ${docNo} was rejected`, messageTh: 'เอกสารถูกปฏิเสธ' });
  }

  // eligibility for a step: direct (user/role) match
  private eligible(step: any, username: string, role: string) {
    if (step.approverUser) return username === step.approverUser;
    if (step.approverRole) return role === step.approverRole;
    return false;
  }
  private async roleOf(username: string): Promise<string | null> {
    const db = this.db as any;
    const [u] = await db.select({ role: users.role }).from(users).where(eq(users.username, username)).limit(1);
    return u?.role ?? null;
  }
  // resolve the effective approver: direct, or via an active delegation whose from_user is eligible
  private async resolveActor(step: any, user: JwtUser): Promise<{ ok: boolean; onBehalfOf: string | null }> {
    if (this.eligible(step, user.username, user.role)) return { ok: true, onBehalfOf: null };
    const db = this.db as any;
    const today = ymd();
    const dels = await db.select().from(approvalDelegations).where(and(eq(approvalDelegations.toUser, user.username), eq(approvalDelegations.active, true), sql`${approvalDelegations.fromDate} <= ${today}`, sql`${approvalDelegations.toDate} >= ${today}`));
    for (const d of dels) {
      const fromRole = await this.roleOf(d.fromUser);
      if (this.eligible(step, d.fromUser, fromRole ?? '')) return { ok: true, onBehalfOf: d.fromUser };
    }
    return { ok: false, onBehalfOf: null };
  }

  // ── Approver action ──
  async act(instanceId: number, args: { decision: 'approve' | 'reject'; comment?: string }, user: JwtUser) {
    const db = this.db as any;
    const [inst] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId)).for('update').limit(1);
    if (!inst) throw new NotFoundException({ code: 'INSTANCE_NOT_FOUND', message: 'Workflow instance not found', messageTh: 'ไม่พบรายการอนุมัติ' });
    if (inst.status !== 'pending') throw new BadRequestException({ code: 'WORKFLOW_CLOSED', message: `Instance already ${inst.status}`, messageTh: 'รายการนี้ปิดแล้ว' });
    const steps = await this.steps(Number(inst.definitionId));
    const step = steps.find((s: any) => s.stepNo === inst.currentStep);
    if (!step) throw new BadRequestException({ code: 'NO_STEP', message: 'No active step', messageTh: 'ไม่พบขั้นอนุมัติ' });
    // eligibility (direct OR via delegation) + maker-checker on the EFFECTIVE approver + configurable SoD.
    const who = await this.resolveActor(step, user);
    if (!who.ok) throw new ForbiddenException({ code: 'NOT_AN_APPROVER', message: 'You are not an approver for this step', messageTh: 'คุณไม่มีสิทธิ์อนุมัติขั้นนี้' });
    // maker-checker (always on): NEITHER the caller NOR the person they act on behalf of may be the creator
    // (closes the "delegate the approval back to yourself" bypass).
    const effectiveApprover = who.onBehalfOf ?? user.username;
    if (user.username === inst.createdBy || effectiveApprover === inst.createdBy) throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'The maker cannot approve their own document', messageTh: 'ผู้สร้างเอกสารอนุมัติเองไม่ได้' });
    await this.sod.assertActionAllowed({ tenantId: inst.tenantId, docType: inst.docType, createdBy: inst.createdBy, actor: effectiveApprover, actorPermissions: user.permissions ?? [], action: 'approve' });

    await db.insert(approvalActions).values({ tenantId: inst.tenantId, instanceId, stepNo: inst.currentStep, actor: user.username, onBehalfOf: who.onBehalfOf, decision: args.decision, comment: args.comment ?? null });
    if (args.decision === 'reject') {
      await db.update(workflowInstances).set({ status: 'rejected', closedAt: new Date() }).where(eq(workflowInstances.id, instanceId));
      return { status: 'rejected', currentStep: inst.currentStep };
    }
    // approve — clear the step (all-of-N: count DISTINCT approving actors at this step)
    const approversAtStep = await db.select({ actor: approvalActions.actor }).from(approvalActions).where(and(eq(approvalActions.instanceId, instanceId), eq(approvalActions.stepNo, inst.currentStep), eq(approvalActions.decision, 'approve')));
    const distinct = new Set(approversAtStep.map((a: any) => a.actor)).size;
    if (distinct < (step.allOfN ?? 1)) return { status: 'pending', currentStep: inst.currentStep };
    const next = this.firstEngaged(steps, n(inst.amount), Number(inst.currentStep));
    if (next) { await db.update(workflowInstances).set({ currentStep: next.stepNo }).where(eq(workflowInstances.id, instanceId)); return { status: 'pending', currentStep: next.stepNo }; }
    await db.update(workflowInstances).set({ status: 'approved', closedAt: new Date() }).where(eq(workflowInstances.id, instanceId));
    return { status: 'approved', currentStep: inst.currentStep };
  }

  async getInstance(id: number, _user: JwtUser) {
    const db = this.db as any;
    const [i] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, id)).limit(1);
    if (!i) throw new NotFoundException({ code: 'INSTANCE_NOT_FOUND', message: 'Not found', messageTh: 'ไม่พบรายการ' });
    const actions = await db.select().from(approvalActions).where(eq(approvalActions.instanceId, id)).orderBy(asc(approvalActions.actedAt));
    return { id: Number(i.id), doc_type: i.docType, doc_no: i.docNo, amount: n(i.amount), created_by: i.createdBy, status: i.status, current_step: i.currentStep, actions: actions.map((a: any) => ({ step_no: a.stepNo, actor: a.actor, on_behalf_of: a.onBehalfOf, decision: a.decision, comment: a.comment, acted_at: a.actedAt })) };
  }

  // instances pending at a step this user can act on (direct or delegated), excluding their own docs
  async myApprovals(user: JwtUser) {
    const db = this.db as any;
    const pend = await db.select().from(workflowInstances).where(eq(workflowInstances.status, 'pending')).orderBy(asc(workflowInstances.id));
    const items: any[] = [];
    for (const i of pend) {
      if (i.createdBy === user.username) continue; // maker-checker hides own docs
      const steps = await this.steps(Number(i.definitionId));
      const step = steps.find((s: any) => s.stepNo === i.currentStep);
      if (!step) continue;
      const who = await this.resolveActor(step, user);
      // hide docs the user would only be able to approve as the maker (direct or via delegation-from-creator)
      if (who.ok && (who.onBehalfOf ?? user.username) !== i.createdBy) items.push({ instance_id: Number(i.id), doc_type: i.docType, doc_no: i.docNo, amount: n(i.amount), current_step: i.currentStep, created_by: i.createdBy, on_behalf_of: who.onBehalfOf });
    }
    return { items };
  }

  // ── Delegation ──
  async createDelegation(dto: { to_user: string; from_date: string; to_date: string }, user: JwtUser) {
    const db = this.db as any;
    const [d] = await db.insert(approvalDelegations).values({ tenantId: user.tenantId ?? null, fromUser: user.username, toUser: dto.to_user, fromDate: dto.from_date, toDate: dto.to_date, active: true, createdBy: user.username }).returning({ id: approvalDelegations.id });
    return { id: Number(d.id), from_user: user.username, to_user: dto.to_user };
  }
  async listDelegations(_user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(approvalDelegations).orderBy(sql`${approvalDelegations.id} DESC`);
    return { delegations: rows.map((d: any) => ({ id: Number(d.id), from_user: d.fromUser, to_user: d.toUser, from_date: d.fromDate, to_date: d.toDate, active: d.active })) };
  }
  async revokeDelegation(id: number, _user: JwtUser) {
    const db = this.db as any;
    await db.update(approvalDelegations).set({ active: false }).where(eq(approvalDelegations.id, id));
    return { id, active: false };
  }
}
