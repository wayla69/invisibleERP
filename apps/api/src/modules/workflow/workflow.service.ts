import { Inject, Injectable, Optional, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, asc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { workflowDefinitions, workflowSteps, workflowInstances, approvalActions, approvalDelegations, users, notifications } from '../../database/schema';
import { ymd, n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker, assertSmeAllowsDistinctApprovers } from '../../common/control-profile';
import { SodService } from './sod.service';
import { LineNotifyService, buildApproveCard } from '../messaging/line-notify.service';

export interface StartWorkflowArgs { docType: string; docNo: string; amount: number; createdBy: string; tenantId: number | null; context?: Record<string, string>; }
export interface StepDto { step_no: number; approver_role?: string; approver_user?: string; min_amount?: number; all_of_n?: number; name?: string; sla_hours?: number; escalate_to_role?: string; escalate_to_user?: string; match_key?: string; match_value?: string; }

// Generic, polymorphic approval engine. A module calls start() on submit, and canTransition()/act() to gate
// its own status flips. The engine posts NOTHING to the GL — it only routes approvals. Maker-checker is
// always on (an approver can never be the document's creator).
@Injectable()
export class WorkflowService {
  // Doc types wired to the generic approval engine (procurement PR/PO, pmr PMR/BQR, planning BUDGET). Each is
  // dual-controlled ONLY if an active workflow definition exists — else start() auto-approves. See readiness().
  static readonly ENGINE_WIRED_DOCTYPES = ['PR', 'PO', 'BUDGET', 'PMR', 'BQR'] as const;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly sod: SodService,
    // 0228 — LINE staff notifications on workflow events. @Optional + last so harnesses that construct
    // this service directly keep working; every call is best-effort (never breaks the approval).
    @Optional() private readonly lineNotify?: LineNotifyService,
  ) {}

  // Push a LINE notification to the step's approver (user or role fan-out) that a doc awaits them.
  // For PRs the push is a flex card with one-tap [อนุมัติ]/[ปฏิเสธ] postback buttons (LC-1) — the postback
  // routes through the same chat decision path (permission + engine SoD + a confirm step); the text below
  // doubles as the card's altText and keeps the typed-command hint for clients without flex rendering.
  private async notifyStepApprovers(inst: { docType: string; docNo: string; createdBy: string | null; tenantId: number | null }, step: any) {
    if (!this.lineNotify || !step) return;
    const chatHint = inst.docType === 'PR' ? `\nอนุมัติจากแชทนี้ได้: พิมพ์ "approve ${inst.docNo}" หรือ "reject ${inst.docNo} <เหตุผล>"` : '';
    const text = `🔔 รออนุมัติ: ${inst.docType} ${inst.docNo} (โดย ${inst.createdBy ?? '-'})${chatHint}`;
    const flex = inst.docType === 'PR' ? buildApproveCard(inst.docType, inst.docNo, inst.createdBy) : undefined;
    if (step.approverUser) await this.lineNotify.notifyUser(step.approverUser, inst.tenantId, text, flex);
    else if (step.approverRole) await this.lineNotify.notifyRole(step.approverRole, inst.tenantId, text, 20, flex);
  }

  // ── Definitions ──
  async createDefinition(dto: { doc_type: string; name: string; sla_hours?: number; steps: StepDto[] }, user: JwtUser) {
    const db = this.db;
    if (!dto.steps?.length) throw new BadRequestException({ code: 'NO_STEPS', message: 'A workflow needs at least one step', messageTh: 'ต้องมีอย่างน้อยหนึ่งขั้น' });
    const [d] = await db.insert(workflowDefinitions).values({ tenantId: user.tenantId ?? null, docType: dto.doc_type, name: dto.name, slaHours: dto.sla_hours ?? null, active: true, createdBy: user.username }).returning({ id: workflowDefinitions.id });
    await this.insertSteps(Number(d!.id), dto.steps, user);
    return { id: Number(d!.id) };
  }
  // Replace a definition's steps (no-code builder save). Validates the same XOR rule per step.
  async updateDefinition(id: number, dto: { name?: string; sla_hours?: number; steps?: StepDto[] }, user: JwtUser) {
    const db = this.db;
    const [def] = await db.select().from(workflowDefinitions).where(and(eq(workflowDefinitions.tenantId, user.tenantId!), eq(workflowDefinitions.id, id))).limit(1);
    if (!def) throw new NotFoundException({ code: 'DEF_NOT_FOUND', message: 'Workflow definition not found', messageTh: 'ไม่พบเวิร์กโฟลว์' });
    const patch: any = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.sla_hours !== undefined) patch.slaHours = dto.sla_hours;
    if (Object.keys(patch).length) await db.update(workflowDefinitions).set(patch).where(eq(workflowDefinitions.id, id));
    if (dto.steps) {
      if (!dto.steps.length) throw new BadRequestException({ code: 'NO_STEPS', message: 'A workflow needs at least one step', messageTh: 'ต้องมีอย่างน้อยหนึ่งขั้น' });
      await db.delete(workflowSteps).where(eq(workflowSteps.definitionId, id));
      await this.insertSteps(id, dto.steps, user);
    }
    return { id };
  }
  private async insertSteps(definitionId: number, steps: StepDto[], user: JwtUser) {
    const db = this.db;
    for (const s of steps) {
      if (!(s.approver_role) === !(s.approver_user)) throw new BadRequestException({ code: 'STEP_ROLE_XOR_USER', message: 'A step needs exactly one of approver_role / approver_user', messageTh: 'ขั้นต้องระบุ role หรือ user อย่างใดอย่างหนึ่ง' });
      if (!(s.match_key) !== !(s.match_value)) throw new BadRequestException({ code: 'MATCH_KEY_VALUE', message: 'A dimension condition needs both match_key and match_value', messageTh: 'เงื่อนไขมิติต้องมีทั้ง key และ value' });
      // docs/49 v1.3: a solo-operator SME company can never supply N>1 distinct approvers — reject the
      // deadlock-guaranteeing step at build time rather than letting the workflow park pending forever.
      assertSmeAllowsDistinctApprovers(user, s.all_of_n);
      await db.insert(workflowSteps).values({ tenantId: user.tenantId ?? null, definitionId, stepNo: s.step_no, approverRole: s.approver_role ?? null, approverUser: s.approver_user ?? null, minAmount: String(s.min_amount ?? 0), allOfN: s.all_of_n ?? 1, name: s.name ?? null, slaHours: s.sla_hours ?? null, escalateToRole: s.escalate_to_role ?? null, escalateToUser: s.escalate_to_user ?? null, matchKey: s.match_key ?? null, matchValue: s.match_value ?? null });
    }
  }
  async listDefinitions(_user: JwtUser) {
    const db = this.db;
    const defs = await db.select().from(workflowDefinitions).orderBy(asc(workflowDefinitions.docType));
    const out: Array<Record<string, unknown>> = [];
    for (const d of defs) {
      const steps = await db.select().from(workflowSteps).where(eq(workflowSteps.definitionId, Number(d.id))).orderBy(asc(workflowSteps.stepNo));
      out.push({ id: Number(d.id), doc_type: d.docType, name: d.name, sla_hours: d.slaHours, active: d.active, steps: steps.map((s: any) => ({ step_no: s.stepNo, approver_role: s.approverRole, approver_user: s.approverUser, min_amount: n(s.minAmount), all_of_n: s.allOfN, name: s.name, sla_hours: s.slaHours, escalate_to_role: s.escalateToRole, escalate_to_user: s.escalateToUser, match_key: s.matchKey, match_value: s.matchValue })) });
    }
    return { definitions: out };
  }
  async setDefinitionActive(id: number, active: boolean, _user: JwtUser) {
    const db = this.db;
    await db.update(workflowDefinitions).set({ active }).where(eq(workflowDefinitions.id, id));
    return { id, active };
  }

  // Cross-cutting control-integrity check (maker-checker audit — "workflow-engine dependence on configured
  // definitions"). `start()` AUTO-APPROVES a docType that has NO active workflow definition, so a deploy that
  // ships without seeded definitions silently has NO second-person approval on PR/PO/BUDGET (and PMR/BQR).
  // This read-only reporter surfaces, per the caller's tenant, which engine-wired docTypes lack an active
  // definition (i.e. currently auto-approve) so an admin / readiness probe can catch the config gap. No
  // behaviour change — auto-approve-when-unconfigured is retained for zero-config deploys; this only detects.
  async readiness(_user: JwtUser) {
    const items: { doc_type: string; has_active_definition: boolean; auto_approves: boolean }[] = [];
    for (const dt of WorkflowService.ENGINE_WIRED_DOCTYPES) {
      const def = await this.activeDef(dt);
      items.push({ doc_type: dt, has_active_definition: !!def, auto_approves: !def });
    }
    const missing = items.filter((i) => !i.has_active_definition).map((i) => i.doc_type);
    return {
      doc_types: items,
      ready: missing.length === 0,
      missing,
      message: missing.length
        ? `No active approval workflow for: ${missing.join(', ')} — these document types AUTO-APPROVE (no second-person control) until a workflow definition is seeded.`
        : 'All engine-wired document types have an active approval workflow.',
    };
  }

  private async activeDef(docType: string) {
    const db = this.db;
    const [d] = await db.select().from(workflowDefinitions).where(and(eq(workflowDefinitions.docType, docType), eq(workflowDefinitions.active, true))).limit(1);
    return d ?? null;
  }
  private async defById(id: number) {
    const [d] = await this.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, id)).limit(1);
    return d ?? null;
  }
  private async steps(definitionId: number) {
    const db = this.db;
    return db.select().from(workflowSteps).where(eq(workflowSteps.definitionId, definitionId)).orderBy(asc(workflowSteps.stepNo));
  }
  // a step engages when its amount threshold is met AND its dimension condition (if any) matches the context
  private engages(step: any, amount: number, context: Record<string, string>) {
    if (n(step.minAmount) > amount) return false;
    if (step.matchKey) return String(context?.[step.matchKey] ?? '') === String(step.matchValue);
    return true;
  }
  // first engaged step after `after`, in order; null = none engaged → auto-approve
  private firstEngaged(steps: any[], amount: number, context: Record<string, string>, after = 0) {
    return steps.filter((s) => Number(s.stepNo) > after && this.engages(s, amount, context)).sort((a, b) => a.stepNo - b.stepNo)[0] ?? null;
  }
  // SLA deadline for a step (step override → definition default → none)
  private dueFor(step: any, def: any): Date | null {
    const hrs = step?.slaHours ?? def?.slaHours ?? null;
    return hrs ? new Date(Date.now() + Number(hrs) * 3600 * 1000) : null;
  }

  // ── Engine entrypoints a module calls ──
  // Creates a pending instance routed to the first engaged step. No active definition → autoApproved (the
  // module keeps its legacy behaviour). Idempotent: a live instance for (doc_type,doc_no) is reused.
  async start(args: StartWorkflowArgs): Promise<{ instanceId: number | null; status: string; currentStep: number; autoApproved: boolean }> {
    const db = this.db;
    const def = await this.activeDef(args.docType);
    if (!def) return { instanceId: null, status: 'auto', currentStep: 0, autoApproved: true };
    const [existing] = await db.select().from(workflowInstances).where(and(eq(workflowInstances.docType, args.docType), eq(workflowInstances.docNo, args.docNo), eq(workflowInstances.status, 'pending'))).limit(1);
    if (existing) return { instanceId: Number(existing.id), status: existing.status, currentStep: existing.currentStep ?? 0, autoApproved: false };
    const steps = await this.steps(Number(def.id));
    const context = args.context ?? {};
    // an ACTIVE definition must always require at least one approval — if a (maker-supplied, optional)
    // amount engages no step by threshold, fall back to the lowest step so the chain can't be skipped.
    const engaged = this.firstEngaged(steps, args.amount, context, 0) ?? [...steps].sort((a, b) => a.stepNo - b.stepNo)[0] ?? null;
    const status = engaged ? 'pending' : 'approved';
    const [inst] = await db.insert(workflowInstances).values({ tenantId: args.tenantId ?? null, definitionId: Number(def.id), docType: args.docType, docNo: args.docNo, amount: String(args.amount), createdBy: args.createdBy, status, currentStep: engaged ? engaged.stepNo : 0, context, dueAt: engaged ? this.dueFor(engaged, def) : null, closedAt: engaged ? null : new Date() }).returning({ id: workflowInstances.id });
    if (engaged) await this.notifyStepApprovers({ docType: args.docType, docNo: args.docNo, createdBy: args.createdBy, tenantId: args.tenantId ?? null }, engaged);
    return { instanceId: Number(inst!.id), status, currentStep: engaged ? engaged.stepNo : 0, autoApproved: !engaged };
  }

  // Cancel a doc's pending instance (e.g. the requester withdraws a PR before approval). No-op when none.
  async cancel(docType: string, docNo: string): Promise<boolean> {
    const updated = await this.db.update(workflowInstances)
      .set({ status: 'cancelled', closedAt: new Date() })
      .where(and(eq(workflowInstances.docType, docType), eq(workflowInstances.docNo, docNo), eq(workflowInstances.status, 'pending')))
      .returning({ id: workflowInstances.id });
    return updated.length > 0;
  }

  private async liveInstance(docType: string, docNo: string) {
    const db = this.db;
    const [i] = await db.select().from(workflowInstances).where(and(eq(workflowInstances.docType, docType), eq(workflowInstances.docNo, docNo))).orderBy(sql`${workflowInstances.id} DESC`).limit(1);
    return i ?? null;
  }
  // the live (pending) instance for a doc, or null — used by a module's own approve handler to decide
  // whether to route through the engine or fall back to its legacy direct flip.
  async pendingInstanceFor(docType: string, docNo: string) {
    const db = this.db;
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

  // eligibility for a step: direct (user/role) match — plus the escalation fallback once the SLA has lapsed
  private eligible(step: any, username: string, role: string, escalated = false) {
    if (step.approverUser && username === step.approverUser) return true;
    if (step.approverRole && role === step.approverRole) return true;
    if (escalated) {
      if (step.escalateToUser && username === step.escalateToUser) return true;
      if (step.escalateToRole && role === step.escalateToRole) return true;
    }
    return false;
  }
  private async roleOf(username: string): Promise<string | null> {
    const db = this.db;
    const [u] = await db.select({ role: users.role }).from(users).where(eq(users.username, username)).limit(1);
    return u?.role ?? null;
  }
  // resolve the effective approver: direct, or via an active delegation whose from_user is eligible
  private async resolveActor(step: any, user: JwtUser, escalated = false): Promise<{ ok: boolean; onBehalfOf: string | null }> {
    if (this.eligible(step, user.username, user.role, escalated)) return { ok: true, onBehalfOf: null };
    const db = this.db;
    const today = ymd();
    const dels = await db.select().from(approvalDelegations).where(and(eq(approvalDelegations.toUser, user.username), eq(approvalDelegations.active, true), sql`${approvalDelegations.fromDate} <= ${today}`, sql`${approvalDelegations.toDate} >= ${today}`));
    for (const d of dels) {
      const fromRole = await this.roleOf(d.fromUser);
      if (this.eligible(step, d.fromUser, fromRole ?? '', escalated)) return { ok: true, onBehalfOf: d.fromUser };
    }
    return { ok: false, onBehalfOf: null };
  }

  // ── Approver action ──
  async act(instanceId: number, args: { decision: 'approve' | 'reject'; comment?: string; self_approval_reason?: string }, user: JwtUser) {
    const db = this.db;
    const [inst] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId)).for('update').limit(1);
    if (!inst) throw new NotFoundException({ code: 'INSTANCE_NOT_FOUND', message: 'Workflow instance not found', messageTh: 'ไม่พบรายการอนุมัติ' });
    if (inst.status !== 'pending') throw new BadRequestException({ code: 'WORKFLOW_CLOSED', message: `Instance already ${inst.status}`, messageTh: 'รายการนี้ปิดแล้ว' });
    const steps = await this.steps(Number(inst.definitionId));
    const step = steps.find((s: any) => s.stepNo === inst.currentStep);
    if (!step) throw new BadRequestException({ code: 'NO_STEP', message: 'No active step', messageTh: 'ไม่พบขั้นอนุมัติ' });
    // eligibility (direct OR via delegation, plus the escalation fallback once SLA-lapsed) + maker-checker
    // on the EFFECTIVE approver + configurable SoD.
    const who = await this.resolveActor(step, user, !!inst.escalated);
    if (!who.ok) throw new ForbiddenException({ code: 'NOT_AN_APPROVER', message: 'You are not an approver for this step', messageTh: 'คุณไม่มีสิทธิ์อนุมัติขั้นนี้' });
    // maker-checker (always on): NEITHER the caller NOR the person they act on behalf of may be the creator
    // (closes the "delegate the approval back to yourself" bypass). Under docs/49 an 'sme' tenant may
    // self-act WITH a logged justification (assertMakerChecker writes the SME-01 evidence); the flag then
    // tells the configurable SoD engine the same condition was already adjudicated (PERM_PAIR unaffected).
    const effectiveApprover = who.onBehalfOf ?? user.username;
    const selfMaker = user.username === inst.createdBy || effectiveApprover === inst.createdBy;
    if (selfMaker) await assertMakerChecker(db, { user, maker: user.username, event: 'workflow.act', ref: `${inst.docType}:${inst.docNo}`, amount: inst.amount != null ? String(inst.amount) : null, reason: args.self_approval_reason, code: 'SOD_VIOLATION', message: 'The maker cannot approve their own document', messageTh: 'ผู้สร้างเอกสารอนุมัติเองไม่ได้' });
    await this.sod.assertActionAllowed({ tenantId: inst.tenantId, docType: inst.docType, createdBy: inst.createdBy, actor: effectiveApprover, actorPermissions: user.permissions ?? [], action: 'approve', selfApprovalAllowed: selfMaker });

    await db.insert(approvalActions).values({ tenantId: inst.tenantId, instanceId, stepNo: inst.currentStep!, actor: user.username, onBehalfOf: who.onBehalfOf, decision: args.decision, comment: args.comment ?? null });
    if (args.decision === 'reject') {
      await db.update(workflowInstances).set({ status: 'rejected', closedAt: new Date() }).where(eq(workflowInstances.id, instanceId));
      if (inst.createdBy) await this.lineNotify?.notifyUser(inst.createdBy, inst.tenantId, `❌ ${inst.docType} ${inst.docNo} ไม่ได้รับอนุมัติ (โดย ${effectiveApprover})${args.comment ? ` — ${args.comment}` : ''}`);
      return { status: 'rejected', currentStep: inst.currentStep };
    }
    // approve — clear the step (all-of-N: count DISTINCT approving actors at this step)
    const approversAtStep = await db.select({ actor: approvalActions.actor }).from(approvalActions).where(and(eq(approvalActions.instanceId, instanceId), eq(approvalActions.stepNo, inst.currentStep!), eq(approvalActions.decision, 'approve')));
    const distinct = new Set(approversAtStep.map((a: any) => a.actor)).size;
    if (distinct < (step.allOfN ?? 1)) return { status: 'pending', currentStep: inst.currentStep };
    const def = await this.defById(Number(inst.definitionId));
    const next = this.firstEngaged(steps, n(inst.amount), (inst.context as Record<string, string> | null) ?? {}, Number(inst.currentStep));
    if (next) {
      await db.update(workflowInstances).set({ currentStep: next.stepNo, dueAt: this.dueFor(next, def), escalated: false, lastRemindedAt: null }).where(eq(workflowInstances.id, instanceId));
      await this.notifyStepApprovers({ docType: inst.docType, docNo: inst.docNo, createdBy: inst.createdBy, tenantId: inst.tenantId }, next);
      return { status: 'pending', currentStep: next.stepNo };
    }
    await db.update(workflowInstances).set({ status: 'approved', closedAt: new Date() }).where(eq(workflowInstances.id, instanceId));
    if (inst.createdBy) await this.lineNotify?.notifyUser(inst.createdBy, inst.tenantId, `✅ ${inst.docType} ${inst.docNo} อนุมัติแล้ว (โดย ${effectiveApprover})`);
    return { status: 'approved', currentStep: inst.currentStep };
  }

  async getInstance(id: number, _user: JwtUser) {
    const db = this.db;
    const [i] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, id)).limit(1);
    if (!i) throw new NotFoundException({ code: 'INSTANCE_NOT_FOUND', message: 'Not found', messageTh: 'ไม่พบรายการ' });
    const actions = await db.select().from(approvalActions).where(eq(approvalActions.instanceId, id)).orderBy(asc(approvalActions.actedAt));
    const overdue = i.status === 'pending' && i.dueAt != null && new Date(i.dueAt).getTime() < Date.now();
    return { id: Number(i.id), doc_type: i.docType, doc_no: i.docNo, amount: n(i.amount), created_by: i.createdBy, status: i.status, current_step: i.currentStep, context: i.context ?? {}, due_at: i.dueAt, overdue, escalated: !!i.escalated, actions: actions.map((a: any) => ({ step_no: a.stepNo, actor: a.actor, on_behalf_of: a.onBehalfOf, decision: a.decision, comment: a.comment, acted_at: a.actedAt })) };
  }

  // ── Escalation / SLA sweep ──
  // Cron-callable: find pending instances past their SLA deadline, flag them escalated (enabling the step's
  // escalation fallback approver to act), and drop a reminder notification to that fallback (or the step's
  // approver role). Idempotent within `remindEveryHours` so re-runs don't spam.
  async runEscalations(user: JwtUser, remindEveryHours = 12) {
    const db = this.db;
    const now = Date.now();
    const pend = await db.select().from(workflowInstances).where(eq(workflowInstances.status, 'pending'));
    let escalated = 0, reminded = 0;
    for (const i of pend) {
      if (!i.dueAt || new Date(i.dueAt).getTime() >= now) continue;     // not past SLA
      const steps = await this.steps(Number(i.definitionId));
      const step = steps.find((s: any) => s.stepNo === i.currentStep);
      if (!step) continue;
      const recently = i.lastRemindedAt && (now - new Date(i.lastRemindedAt).getTime()) < remindEveryHours * 3600 * 1000;
      if (recently) continue;
      if (!i.escalated) escalated++;
      // notify the escalation target role (fallback role → step approver role)
      const targetRole = step.escalateToRole ?? step.approverRole ?? null;
      if (targetRole) {
        await db.insert(notifications).values({ targetTenantId: i.tenantId, targetRole: targetRole as typeof notifications.$inferInsert.targetRole, message: `รออนุมัติเกินกำหนด: ${i.docType} ${i.docNo} (ขั้น ${i.currentStep})`, messageEn: `Approval overdue: ${i.docType} ${i.docNo} (step ${i.currentStep})` });
        reminded++;
      }
      await db.update(workflowInstances).set({ escalated: true, lastRemindedAt: new Date() }).where(eq(workflowInstances.id, i.id));
    }
    return { scanned: pend.length, escalated, reminded };
  }

  // instances pending at a step this user can act on (direct or delegated), excluding their own docs
  async myApprovals(user: JwtUser) {
    const db = this.db;
    const pend = await db.select().from(workflowInstances).where(eq(workflowInstances.status, 'pending')).orderBy(asc(workflowInstances.id));
    const items: any[] = [];
    for (const i of pend) {
      if (i.createdBy === user.username) continue; // maker-checker hides own docs
      const steps = await this.steps(Number(i.definitionId));
      const step = steps.find((s: any) => s.stepNo === i.currentStep);
      if (!step) continue;
      const who = await this.resolveActor(step, user, !!i.escalated);
      // hide docs the user would only be able to approve as the maker (direct or via delegation-from-creator)
      if (who.ok && (who.onBehalfOf ?? user.username) !== i.createdBy) {
        const overdue = i.dueAt != null && new Date(i.dueAt).getTime() < Date.now();
        items.push({ instance_id: Number(i.id), doc_type: i.docType, doc_no: i.docNo, amount: n(i.amount), current_step: i.currentStep, created_by: i.createdBy, on_behalf_of: who.onBehalfOf, due_at: i.dueAt, overdue, escalated: !!i.escalated });
      }
    }
    return { items };
  }

  // ── Delegation ──
  async createDelegation(dto: { to_user: string; from_date: string; to_date: string }, user: JwtUser) {
    const db = this.db;
    const [d] = await db.insert(approvalDelegations).values({ tenantId: user.tenantId ?? null, fromUser: user.username, toUser: dto.to_user, fromDate: dto.from_date, toDate: dto.to_date, active: true, createdBy: user.username }).returning({ id: approvalDelegations.id });
    return { id: Number(d!.id), from_user: user.username, to_user: dto.to_user };
  }
  async listDelegations(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(approvalDelegations).orderBy(sql`${approvalDelegations.id} DESC`);
    return { delegations: rows.map((d: any) => ({ id: Number(d.id), from_user: d.fromUser, to_user: d.toUser, from_date: d.fromDate, to_date: d.toDate, active: d.active })) };
  }
  async revokeDelegation(id: number, _user: JwtUser) {
    const db = this.db;
    await db.update(approvalDelegations).set({ active: false }).where(eq(approvalDelegations.id, id));
    return { id, active: false };
  }
}
