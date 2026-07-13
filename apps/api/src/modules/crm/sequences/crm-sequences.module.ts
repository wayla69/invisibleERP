import { Inject, Injectable, Module, Controller, Get, Post, Param, Query, Body, Optional, HttpCode, NotFoundException, BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { eq, and, lte, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { crmSequences, crmSequenceSteps, crmSequenceEnrollments, crmLeads, crmOpportunities, crmContacts, crmActivities } from '../../../database/schema/crm-pipeline';
import { Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { MessagingModule } from '../../messaging/messaging.module';
import { MessagingService } from '../../messaging/messaging.service';
import type { BiReportGenerator, BiReportSource } from '../../bi/report-registry';

// ── CRM-8 — sales SEQUENCES / cadences (CRM-11, migration 0392) ─────────────────────────────────────────
// Multi-step outreach playbooks on the REV-17 CRM spine + the CRM-6 comms rail. A SEQUENCE is an ordered
// list of STEPS (channel email/line/sms/task + wait_days + subject/body). A lead or opportunity is ENROLLED
// and the due-runner ADVANCES each enrolment on cadence — sending the due step (via MessagingService) and
// logging it as an auditable crm_activities entry, then scheduling the next step by its wait_days — until
// the last step (status → completed). A rep may stop an enrolment at any time. The control (CRM-11): a
// nurtured lead/deal is worked on a governed cadence and every touch is logged — none silently drops out.

const DAY_MS = 24 * 60 * 60 * 1000;
const StepBody = z.object({
  channel: z.enum(['email', 'line', 'sms', 'task']).optional(),
  wait_days: z.number().int().min(0).max(365).optional(),
  subject: z.string().max(300).optional(),
  body: z.string().max(5000).optional(),
});
const SequenceBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  steps: z.array(StepBody).min(1).max(50),
});
const EnrollBody = z.object({ entity_type: z.enum(['lead', 'opportunity']), entity_no: z.string().min(1).max(60) });

@Injectable()
export class CrmSequencesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Optional() private readonly messaging?: MessagingService,
  ) {}

  private tCond(col: any, user: JwtUser) { return user.tenantId != null ? [eq(col, user.tenantId)] : []; }
  private now() { return new Date(); }

  private async resolveSeq(user: JwtUser, code: string) {
    const [row] = await this.db.select().from(crmSequences)
      .where(and(eq(crmSequences.code, code), ...this.tCond(crmSequences.tenantId, user)));
    if (!row) throw new NotFoundException({ code: 'SEQUENCE_NOT_FOUND', message: 'Sequence not found', messageTh: 'ไม่พบลำดับการติดตาม' });
    return row;
  }
  private async steps(user: JwtUser, sequenceId: number) {
    return this.db.select().from(crmSequenceSteps)
      .where(and(eq(crmSequenceSteps.sequenceId, sequenceId), ...this.tCond(crmSequenceSteps.tenantId, user)))
      .orderBy(crmSequenceSteps.stepNo);
  }

  async createSequence(user: JwtUser, body: z.infer<typeof SequenceBody>) {
    const existing = await this.db.select({ id: crmSequences.id }).from(crmSequences).where(and(...this.tCond(crmSequences.tenantId, user)));
    const code = `SEQ-${String(existing.length + 1).padStart(4, '0')}`;
    const [seq] = await this.db.insert(crmSequences).values({
      tenantId: user.tenantId ?? null, code, name: body.name, description: body.description ?? null, createdBy: user.username ?? null,
    }).returning({ id: crmSequences.id });
    const seqId = Number(seq?.id);
    let stepNo = 1;
    for (const s of body.steps) {
      await this.db.insert(crmSequenceSteps).values({
        tenantId: user.tenantId ?? null, sequenceId: seqId, stepNo: stepNo++, channel: s.channel ?? 'email',
        waitDays: s.wait_days ?? 0, subject: s.subject ?? null, body: s.body ?? '',
      });
    }
    return { code, name: body.name, steps: body.steps.length };
  }

  async listSequences(user: JwtUser) {
    const rows = await this.db.select().from(crmSequences).where(and(...this.tCond(crmSequences.tenantId, user)));
    return { sequences: rows.map((s) => ({ code: s.code, name: s.name, active: s.active, description: s.description })) };
  }

  async getSequence(user: JwtUser, code: string) {
    const seq = await this.resolveSeq(user, code);
    const steps = await this.steps(user, Number(seq.id));
    const enrols = await this.db.select({ status: crmSequenceEnrollments.status }).from(crmSequenceEnrollments)
      .where(and(eq(crmSequenceEnrollments.sequenceId, Number(seq.id)), ...this.tCond(crmSequenceEnrollments.tenantId, user)));
    const active = enrols.filter((e) => e.status === 'active').length;
    return {
      code: seq.code, name: seq.name, description: seq.description, active: seq.active,
      steps: steps.map((s) => ({ step_no: s.stepNo, channel: s.channel, wait_days: s.waitDays, subject: s.subject, body: s.body })),
      enrollments: { total: enrols.length, active },
    };
  }

  async enroll(user: JwtUser, code: string, body: z.infer<typeof EnrollBody>) {
    const seq = await this.resolveSeq(user, code);
    if (!seq.active) throw new BadRequestException({ code: 'SEQUENCE_INACTIVE', message: 'Sequence is not active', messageTh: 'ลำดับการติดตามถูกปิดใช้งาน' });
    const steps = await this.steps(user, Number(seq.id));
    if (!steps.length) throw new BadRequestException({ code: 'SEQUENCE_NO_STEPS', message: 'Sequence has no steps', messageTh: 'ลำดับการติดตามยังไม่มีขั้นตอน' });
    // Validate the target entity exists in the caller's tenant.
    if (body.entity_type === 'lead') {
      const [l] = await this.db.select({ id: crmLeads.id }).from(crmLeads).where(and(eq(crmLeads.leadNo, body.entity_no), ...this.tCond(crmLeads.tenantId, user)));
      if (!l) throw new NotFoundException({ code: 'ENTITY_NOT_FOUND', message: 'Lead not found', messageTh: 'ไม่พบลีด' });
    } else {
      const [o] = await this.db.select({ id: crmOpportunities.id }).from(crmOpportunities).where(and(eq(crmOpportunities.oppNo, body.entity_no), ...this.tCond(crmOpportunities.tenantId, user)));
      if (!o) throw new NotFoundException({ code: 'ENTITY_NOT_FOUND', message: 'Opportunity not found', messageTh: 'ไม่พบโอกาสการขาย' });
    }
    const firstWait = Number(steps[0]?.waitDays ?? 0);
    const dueAt = new Date(this.now().getTime() + firstWait * DAY_MS);
    let enrolId: number;
    try {
      const [row] = await this.db.insert(crmSequenceEnrollments).values({
        tenantId: user.tenantId ?? null, sequenceId: Number(seq.id), entityType: body.entity_type, entityNo: body.entity_no,
        currentStep: 0, status: 'active', nextDueAt: dueAt, enrolledBy: user.username ?? null,
      }).returning({ id: crmSequenceEnrollments.id });
      enrolId = Number(row?.id);
    } catch (e) {
      throw new BadRequestException({ code: 'ALREADY_ENROLLED', message: 'This entity is already enrolled in the sequence', messageTh: 'รายการนี้ถูกเพิ่มในลำดับการติดตามแล้ว' });
    }
    return { id: enrolId, sequence_code: code, entity_type: body.entity_type, entity_no: body.entity_no, status: 'active', next_due_at: dueAt };
  }

  private async recipient(user: JwtUser, entityType: string, entityNo: string, channel: string): Promise<string | null> {
    if (entityType === 'lead') {
      const [l] = await this.db.select().from(crmLeads).where(and(eq(crmLeads.leadNo, entityNo), ...this.tCond(crmLeads.tenantId, user)));
      if (!l) return null;
      return channel === 'email' ? (l.email ?? null) : (l.phone ?? null);
    }
    const [o] = await this.db.select().from(crmOpportunities).where(and(eq(crmOpportunities.oppNo, entityNo), ...this.tCond(crmOpportunities.tenantId, user)));
    if (!o || o.primaryContactId == null) return null;
    const [c] = await this.db.select().from(crmContacts).where(eq(crmContacts.id, Number(o.primaryContactId)));
    if (!c) return null;
    return channel === 'email' ? (c.email ?? null) : channel === 'line' ? (c.lineId ?? null) : (c.phone ?? null);
  }

  // Execute the next due step of an enrolment: send (best-effort) + log an activity + schedule the next step.
  async advance(user: JwtUser, id: number) {
    const [en] = await this.db.select().from(crmSequenceEnrollments)
      .where(and(eq(crmSequenceEnrollments.id, id), ...this.tCond(crmSequenceEnrollments.tenantId, user)));
    if (!en) throw new NotFoundException({ code: 'ENROLLMENT_NOT_FOUND', message: 'Enrollment not found', messageTh: 'ไม่พบการติดตาม' });
    if (en.status !== 'active') throw new BadRequestException({ code: 'ENROLLMENT_NOT_ACTIVE', message: 'Enrollment is not active', messageTh: 'การติดตามนี้ไม่ได้ทำงานอยู่' });
    const steps = await this.steps(user, Number(en.sequenceId));
    const nextNo = Number(en.currentStep) + 1;
    const step = steps.find((s) => s.stepNo === nextNo);
    if (!step) {
      await this.db.update(crmSequenceEnrollments).set({ status: 'completed', nextDueAt: null, updatedAt: this.now() }).where(eq(crmSequenceEnrollments.id, id));
      return { id, status: 'completed', step_no: null };
    }
    // Send the step (email/line/sms) best-effort; a 'task' step is a reminder only (no send).
    let sent = false, to: string | null = null;
    if (step.channel !== 'task') {
      to = await this.recipient(user, en.entityType, en.entityNo, step.channel);
      if (to && this.messaging) {
        try { await this.messaging.send({ to, channel: step.channel as 'email' | 'line' | 'sms', body: step.body, campaign: 'crm_sequence' }, user); sent = true; } catch { sent = false; }
      }
    }
    // Log the touch as an auditable timeline activity on the lead/opportunity.
    await this.db.insert(crmActivities).values({
      tenantId: user.tenantId ?? null, entityType: en.entityType, entityNo: en.entityNo,
      type: step.channel === 'email' ? 'email' : step.channel === 'task' ? 'task' : 'note',
      subject: step.subject ?? `Sequence step ${nextNo} (${step.channel})`,
      notes: (step.body ?? '').slice(0, 2000), done: step.channel !== 'task', owner: user.username ?? null, source: 'sequence', createdBy: user.username ?? null,
    });
    const isLast = nextNo >= steps.length;
    const nextStep = steps.find((s) => s.stepNo === nextNo + 1);
    const nextDue = isLast ? null : new Date(this.now().getTime() + Number(nextStep?.waitDays ?? 0) * DAY_MS);
    await this.db.update(crmSequenceEnrollments).set({
      currentStep: nextNo, status: isLast ? 'completed' : 'active', nextDueAt: nextDue, updatedAt: this.now(),
    }).where(eq(crmSequenceEnrollments.id, id));
    return { id, status: isLast ? 'completed' : 'active', step_no: nextNo, channel: step.channel, sent, to };
  }

  async stop(user: JwtUser, id: number) {
    const [en] = await this.db.select({ id: crmSequenceEnrollments.id }).from(crmSequenceEnrollments)
      .where(and(eq(crmSequenceEnrollments.id, id), ...this.tCond(crmSequenceEnrollments.tenantId, user)));
    if (!en) throw new NotFoundException({ code: 'ENROLLMENT_NOT_FOUND', message: 'Enrollment not found', messageTh: 'ไม่พบการติดตาม' });
    await this.db.update(crmSequenceEnrollments).set({ status: 'stopped', nextDueAt: null, updatedAt: this.now() }).where(eq(crmSequenceEnrollments.id, id));
    return { id, status: 'stopped' };
  }

  async listEnrollments(user: JwtUser, dto?: { status?: string }) {
    const conds = [...this.tCond(crmSequenceEnrollments.tenantId, user)];
    if (dto?.status) conds.push(eq(crmSequenceEnrollments.status, dto.status));
    const rows = await this.db.select().from(crmSequenceEnrollments).where(and(...conds));
    return { enrollments: rows.map((e) => ({ id: Number(e.id), entity_type: e.entityType, entity_no: e.entityNo, current_step: e.currentStep, status: e.status, next_due_at: e.nextDueAt })) };
  }

  // The schedulable BI job: advance every active enrolment whose next step is due. Idempotent per due date
  // (advancing sets the next due in the future). Returns a run summary.
  async runDue(user: JwtUser) {
    const now = this.now();
    const due = await this.db.select({ id: crmSequenceEnrollments.id }).from(crmSequenceEnrollments)
      .where(and(eq(crmSequenceEnrollments.status, 'active'), lte(crmSequenceEnrollments.nextDueAt, now), ...this.tCond(crmSequenceEnrollments.tenantId, user)));
    let advanced = 0, completed = 0;
    for (const d of due) {
      const r = await this.advance(user, Number(d.id));
      advanced++;
      if (r.status === 'completed') completed++;
    }
    return { as_of: now.toISOString(), scanned: due.length, advanced, completed };
  }
}

// docs/46 Phase 1 — module-owned BI report generator (discovered by BiReportRegistrarService).
@Injectable()
export class CrmSequenceBiReports implements BiReportSource {
  constructor(private readonly svc: CrmSequencesService) {}
  biReports(): BiReportGenerator[] {
    return [{
      type: 'crm_sequence_run',
      generate: async (_f, user) => {
        const r = await this.svc.runDue(user); // idempotent: advances only due enrolments
        return { data: r, summary: `Sequence run: advanced ${r.advanced} of ${r.scanned} due enrolment(s), ${r.completed} completed`, summaryTh: `รันลำดับติดตาม: เดินหน้า ${r.advanced} จาก ${r.scanned} รายการที่ถึงกำหนด · จบ ${r.completed} ราย` };
      },
    }];
  }
}

@Controller('api/crm/sequences')
@Permissions('crm', 'exec', 'ar')
export class CrmSequencesController {
  constructor(private readonly svc: CrmSequencesService) {}

  @Get() list(@CurrentUser() u: JwtUser) { return this.svc.listSequences(u); }
  @Get('enrollments') enrollments(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listEnrollments(u, { status }); }
  @Get(':code') get(@Param('code') code: string, @CurrentUser() u: JwtUser) { return this.svc.getSequence(u, code); }
  @Post() @Permissions('crm', 'exec') create(@Body(new ZodValidationPipe(SequenceBody)) b: z.infer<typeof SequenceBody>, @CurrentUser() u: JwtUser) { return this.svc.createSequence(u, b); }
  @Post(':code/enroll') @Permissions('crm', 'exec') enroll(@Param('code') code: string, @Body(new ZodValidationPipe(EnrollBody)) b: z.infer<typeof EnrollBody>, @CurrentUser() u: JwtUser) { return this.svc.enroll(u, code, b); }
  @Post('enrollments/:id/advance') @Permissions('crm', 'exec') advance(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.advance(u, Number(id)); }
  @Post('enrollments/:id/stop') @Permissions('crm', 'exec') stop(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.stop(u, Number(id)); }
  // Manual trigger for the due-runner (also schedulable as the crm_sequence_run BI report).
  @Post('run-due') @HttpCode(200) @Permissions('crm', 'exec') runDue(@CurrentUser() u: JwtUser) { return this.svc.runDue(u); }
}

@Module({
  imports: [MessagingModule],
  controllers: [CrmSequencesController],
  providers: [CrmSequencesService, CrmSequenceBiReports],
  exports: [CrmSequencesService],
})
export class CrmSequencesModule {}
