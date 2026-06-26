import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { closeRuns, closeRunSteps, fiscalPeriods } from '../../database/schema';
import { currentTenantStore } from '../../common/tenant-context';

// WS2.1 (GL-15/GL-16) — Hard period close + close checklist.
// Lifecycle: Open → InProgress (startClose seeds the checklist) → ReadyToLock (all required steps Done)
// → Locked (lockPeriod, by a user ≠ the starter). Locking writes 'Locked' into fiscal_periods.status so
// LedgerService.postEntry hard-blocks any further posting into the period.

// Standard close checklist. `required` steps gate the lock; advisory steps don't.
const CHECKLIST: { stepKey: string; title: string; required: boolean }[] = [
  { stepKey: 'subledger_tieout', title: 'Sub-ledger tie-out (AR/AP/INV/FA) reconciled', required: true },
  { stepKey: 'bank_rec', title: 'Bank reconciliation complete', required: true },
  { stepKey: 'depreciation', title: 'Depreciation posted for the period', required: true },
  { stepKey: 'recurring', title: 'Recurring / prepaid journals run', required: true },
  { stepKey: 'fx_reval', title: 'FX revaluation posted', required: false },
  { stepKey: 'trial_balance_review', title: 'Trial-balance review & sign-off', required: true },
];

@Injectable()
export class CloseService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private tenantId(): number | null {
    return currentTenantStore()?.tenantId ?? null;
  }

  // ───────────────────── Start a close run ─────────────────────
  // GL-15: create the close_runs row (InProgress) + seed the standard checklist. Upsert-safe: if a run
  // already exists for the period and is not Locked, return it; if Locked, reject (PERIOD_ALREADY_LOCKED).
  async startClose(dto: { period: string; startedBy: string }) {
    const db = this.db as any;
    const tenantId = this.tenantId();
    const existing = await this.findRunByPeriod(dto.period, tenantId);
    if (existing) {
      if (existing.status === 'Locked') {
        throw new BadRequestException({ code: 'PERIOD_ALREADY_LOCKED', message: `Period ${dto.period} is already locked`, messageTh: `งวดบัญชี ${dto.period} ถูกล็อกแล้ว` });
      }
      return this.shape(existing, await this.stepsFor(existing.id));
    }
    const [run] = await db.insert(closeRuns).values({
      tenantId: tenantId as number,
      period: dto.period,
      status: 'InProgress',
      startedBy: dto.startedBy,
    }).returning();
    await db.insert(closeRunSteps).values(CHECKLIST.map((c, i) => ({
      closeRunId: Number(run.id),
      tenantId: tenantId as number,
      stepKey: c.stepKey,
      title: c.title,
      seq: i + 1,
      required: c.required,
      status: 'Pending',
    })));
    return this.shape(run, await this.stepsFor(Number(run.id)));
  }

  // ───────────────────── Complete a checklist step ─────────────────────
  // GL-15: mark a step Done (record completedBy/At). When all REQUIRED steps are Done, advance the run
  // to ReadyToLock.
  async completeStep(dto: { closeRunId: number; stepKey: string; completedBy: string; detail?: any }) {
    const db = this.db as any;
    const run = await this.getRun(dto.closeRunId);
    if (run.status === 'Locked') {
      throw new BadRequestException({ code: 'PERIOD_ALREADY_LOCKED', message: `Period ${run.period} is already locked`, messageTh: `งวดบัญชี ${run.period} ถูกล็อกแล้ว` });
    }
    const [step] = await db.select().from(closeRunSteps)
      .where(and(eq(closeRunSteps.closeRunId, dto.closeRunId), eq(closeRunSteps.stepKey, dto.stepKey))).limit(1);
    if (!step) throw new NotFoundException({ code: 'STEP_NOT_FOUND', message: `Step ${dto.stepKey} not found on close run ${dto.closeRunId}`, messageTh: 'ไม่พบขั้นตอนการปิดงวด' });

    await db.update(closeRunSteps).set({
      status: 'Done',
      completedBy: dto.completedBy,
      completedAt: new Date(),
      ...(dto.detail !== undefined ? { detail: dto.detail } : {}),
    }).where(eq(closeRunSteps.id, step.id));

    // Re-evaluate: all REQUIRED steps Done ⇒ ReadyToLock.
    const steps = await this.stepsFor(dto.closeRunId);
    const allReqDone = steps.filter((s: any) => s.required).every((s: any) => s.status === 'Done');
    if (allReqDone && run.status !== 'ReadyToLock') {
      await db.update(closeRuns).set({ status: 'ReadyToLock' }).where(eq(closeRuns.id, dto.closeRunId));
    }
    return this.shape(await this.getRun(dto.closeRunId), steps);
  }

  // ───────────────────── Lock the period (maker-checker) ─────────────────────
  // GL-16: require ReadyToLock (else STEPS_INCOMPLETE listing the pending required steps). The locker MUST
  // differ from the starter (SELF_LOCK). Sets the run Locked AND marks fiscal_periods.status = 'Locked' so
  // postEntry hard-blocks the period.
  async lockPeriod(dto: { closeRunId: number; lockedBy: string }) {
    const db = this.db as any;
    const tenantId = this.tenantId();
    const run = await this.getRun(dto.closeRunId);
    if (run.status === 'Locked') {
      throw new BadRequestException({ code: 'PERIOD_ALREADY_LOCKED', message: `Period ${run.period} is already locked`, messageTh: `งวดบัญชี ${run.period} ถูกล็อกแล้ว` });
    }
    if (run.status !== 'ReadyToLock') {
      const pending = (await this.stepsFor(dto.closeRunId))
        .filter((s: any) => s.required && s.status !== 'Done')
        .map((s: any) => s.step_key);
      throw new BadRequestException({ code: 'STEPS_INCOMPLETE', message: `Close steps incomplete: ${pending.join(', ')}`, messageTh: 'ขั้นตอนการปิดงวดยังไม่ครบถ้วน', pending });
    }
    if (run.startedBy === dto.lockedBy) {
      throw new BadRequestException({ code: 'SELF_LOCK', message: 'Maker-checker: you cannot lock a close run you started', messageTh: 'ผู้เริ่มปิดงวดล็อกงวดของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    const [locked] = await db.update(closeRuns).set({
      status: 'Locked',
      lockedBy: dto.lockedBy,
      lockedAt: new Date(),
    }).where(eq(closeRuns.id, dto.closeRunId)).returning();

    // Hard-lock the fiscal period so postEntry rejects further postings. Ensure the row exists first.
    await db.insert(fiscalPeriods).values({
      code: run.period,
      startDate: `${run.period}-01`,
      endDate: this.periodEndDate(run.period),
      status: 'Locked',
      tenantId: tenantId as number,
    }).onConflictDoUpdate({
      target: [fiscalPeriods.tenantId, fiscalPeriods.code],
      set: { status: 'Locked' },
    });

    return this.shape(locked, await this.stepsFor(dto.closeRunId));
  }

  // ───────────────────── Read ─────────────────────
  async status(period: string) {
    const tenantId = this.tenantId();
    const run = await this.findRunByPeriod(period, tenantId);
    if (!run) throw new NotFoundException({ code: 'CLOSE_RUN_NOT_FOUND', message: `No close run for period ${period}`, messageTh: 'ไม่พบการปิดงวด' });
    return this.shape(run, await this.stepsFor(run.id));
  }

  async list() {
    const db = this.db as any;
    const tenantId = this.tenantId();
    const rows = await db.select().from(closeRuns)
      .where(tenantId == null ? undefined : eq(closeRuns.tenantId, tenantId))
      .orderBy(desc(closeRuns.id));
    return { runs: rows.map((r: any) => this.shape(r, [])), count: rows.length };
  }

  // ───────────────────── helpers ─────────────────────
  private async getRun(id: number) {
    const db = this.db as any;
    const [run] = await db.select().from(closeRuns).where(eq(closeRuns.id, id)).limit(1);
    if (!run) throw new NotFoundException({ code: 'CLOSE_RUN_NOT_FOUND', message: `Close run ${id} not found`, messageTh: 'ไม่พบการปิดงวด' });
    return run;
  }

  private async findRunByPeriod(period: string, tenantId: number | null) {
    const db = this.db as any;
    const conds = [eq(closeRuns.period, period)];
    if (tenantId != null) conds.push(eq(closeRuns.tenantId, tenantId));
    const [run] = await db.select().from(closeRuns).where(and(...conds)).limit(1);
    return run ?? null;
  }

  private async stepsFor(closeRunId: number) {
    const db = this.db as any;
    const rows = await db.select().from(closeRunSteps)
      .where(eq(closeRunSteps.closeRunId, closeRunId))
      .orderBy(closeRunSteps.seq);
    return rows.map((s: any) => ({
      id: Number(s.id),
      step_key: s.stepKey,
      title: s.title,
      seq: s.seq,
      required: s.required,
      status: s.status,
      completed_by: s.completedBy ?? null,
      completed_at: s.completedAt ?? null,
      detail: s.detail ?? null,
    }));
  }

  private periodEndDate(period: string): string {
    const [y, m] = period.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${period}-${String(last).padStart(2, '0')}`;
  }

  private shape(r: any, steps: any[]) {
    return {
      id: Number(r.id),
      period: r.period,
      status: r.status,
      started_by: r.startedBy,
      locked_by: r.lockedBy ?? null,
      locked_at: r.lockedAt ?? null,
      note: r.note ?? null,
      created_at: r.createdAt ?? null,
      steps,
    };
  }
}
