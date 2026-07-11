import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, gte, lte, sql, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { glPeriodBalances, closeRuns, closeRunSteps, fiscalPeriods, journalEntries, journalLines } from '../../database/schema';
import { currentTenantStore } from '../../common/tenant-context';

const num = (x: unknown) => Number(x) || 0;
const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
// Suspense / clearing accounts whose balance should normally be ~zero at close (advisory): the WIP "applied"
// contra accounts (2380 mfg labor+OH, 2390 project applied) and conventional suspense codes.
const SUSPENSE_ACCOUNTS = ['2380', '2390', '1999', '9999'];

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
  { stepKey: 'deferred_tax', title: 'Deferred tax computed & posted', required: false },
  { stepKey: 'trial_balance_review', title: 'Trial-balance review & sign-off', required: true },
  // CLS-02 (GL-26) — the disclosure / close-package checklist (governed close binder) is a separate
  // maker-checker artefact at /api/close/disclosure; this advisory step cross-links it into the close run.
  { stepKey: 'disclosure_review', title: 'Disclosure / close-package checklist reviewed', required: false },
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
    const db = this.db;
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
      closeRunId: Number(run!.id),
      tenantId: tenantId as number,
      stepKey: c.stepKey,
      title: c.title,
      seq: i + 1,
      required: c.required,
      status: 'Pending',
    })));
    return this.shape(run, await this.stepsFor(Number(run!.id)));
  }

  // ───────────────────── Complete a checklist step ─────────────────────
  // GL-15: mark a step Done (record completedBy/At). When all REQUIRED steps are Done, advance the run
  // to ReadyToLock.
  async completeStep(dto: { closeRunId: number; stepKey: string; completedBy: string; detail?: any }) {
    const db = this.db;
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
    const db = this.db;
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

  // ───────────────────── Emergency reopen (controlled override) ─────────────────────
  // GL-16b: a Locked period can be reopened ONLY for a documented exception — a mandatory `reason` is
  // required (REASON_REQUIRED) and the reopener MUST differ from the user who locked it (SELF_REOPEN), so the
  // override is two-person and never self-served. Flips the run back to ReadyToLock (the signed-off steps
  // stay Done) and the fiscal period back to Open so corrective postings are allowed; a different user must
  // then re-lock. The POST is captured by the append-only audit_log (tamper-evident hash chain) with the
  // actor + reason, so every reopen is attributable.
  async reopenPeriod(dto: { closeRunId: number; reopenedBy: string; reason: string }) {
    const db = this.db;
    const tenantId = this.tenantId();
    const run = await this.getRun(dto.closeRunId);
    if (run.status !== 'Locked') {
      throw new BadRequestException({ code: 'NOT_LOCKED', message: `Period ${run.period} is not locked`, messageTh: `งวดบัญชี ${run.period} ยังไม่ถูกล็อก` });
    }
    if (!dto.reason || !dto.reason.trim()) {
      throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'A reason is required to reopen a locked period', messageTh: 'ต้องระบุเหตุผลในการเปิดงวดที่ล็อกแล้ว' });
    }
    if (run.lockedBy === dto.reopenedBy) {
      throw new BadRequestException({ code: 'SELF_REOPEN', message: 'Maker-checker: the user who locked the period cannot reopen it', messageTh: 'ผู้ที่ล็อกงวดเปิดงวดเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    const [reopened] = await db.update(closeRuns).set({
      status: 'ReadyToLock',
      lockedBy: null,
      lockedAt: null,
      note: `REOPENED by ${dto.reopenedBy}: ${dto.reason.trim()}`,
    }).where(eq(closeRuns.id, dto.closeRunId)).returning();
    // Unlock the fiscal period so postEntry accepts corrective postings again.
    await db.update(fiscalPeriods).set({ status: 'Open' })
      .where(and(eq(fiscalPeriods.tenantId, tenantId as number), eq(fiscalPeriods.code, run.period)));
    return this.shape(reopened, await this.stepsFor(dto.closeRunId));
  }

  // ───────────────────── Read ─────────────────────
  async status(period: string) {
    const tenantId = this.tenantId();
    const run = await this.findRunByPeriod(period, tenantId);
    if (!run) throw new NotFoundException({ code: 'CLOSE_RUN_NOT_FOUND', message: `No close run for period ${period}`, messageTh: 'ไม่พบการปิดงวด' });
    return this.shape(run, await this.stepsFor(run.id));
  }

  async list() {
    const db = this.db;
    const tenantId = this.tenantId();
    const rows = await db.select().from(closeRuns)
      .where(tenantId == null ? undefined : eq(closeRuns.tenantId, tenantId))
      .orderBy(desc(closeRuns.id));
    return { runs: rows.map((r: any) => this.shape(r, [])), count: rows.length };
  }

  // ───────────────────── Pre-lock validation (GL-19) ─────────────────────
  // Read-only programmatic readiness for the period — the books-are-clean checks the checklist sign-off can't
  // assert by itself: (1) no unposted Draft JEs in the period, (2) posted entries balance in aggregate, (3)
  // every posted entry is individually balanced, and (4) suspense/clearing accounts net to ~zero (advisory).
  // `ready` is false only when a HARD blocker fails (advisory checks raise warnings, not blockers). Posts
  // nothing — a detective gate surfaced in the period-close UI before the maker-checker lock.
  async validate(period: string) {
    if (!/^\d{4}-\d{2}$/.test(period ?? '')) throw new BadRequestException({ code: 'BAD_PERIOD', message: 'period must be YYYY-MM', messageTh: 'งวดต้องเป็น YYYY-MM' });
    const db = this.db;
    const tenantId = this.tenantId();
    const start = `${period}-01`;
    const end = this.periodEndDate(period);
    const inPeriod = (extra: any[]) => {
      const c = [gte(journalEntries.entryDate, start), lte(journalEntries.entryDate, end), ...extra];
      if (tenantId != null) c.push(eq(journalEntries.tenantId, tenantId));
      return and(...c);
    };

    // 1. Unposted draft JEs dated in the period.
    const draftRows = await db.select({ entry_no: journalEntries.entryNo, entry_date: journalEntries.entryDate })
      .from(journalEntries).where(inPeriod([eq(journalEntries.status, 'Draft')])).limit(50);
    const drafts = { key: 'unposted_drafts', title: 'No unposted draft journal entries in the period', ok: draftRows.length === 0, count: draftRows.length, entries: draftRows.map((r: any) => r.entry_no) };

    // 2 + 3. Aggregate + per-entry balance of POSTED entries in the period.
    const lineRows = await db.select({ entryId: journalLines.entryId, entryNo: journalEntries.entryNo, debit: journalLines.debit, credit: journalLines.credit })
      .from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(inPeriod([eq(journalEntries.status, 'Posted')]));
    let totDr = 0, totCr = 0;
    const byEntry = new Map<string, { dr: number; cr: number; no: string }>();
    for (const l of lineRows) {
      const dr = num(l.debit), cr = num(l.credit);
      totDr += dr; totCr += cr;
      const k = String(l.entryId);
      const e = byEntry.get(k) ?? { dr: 0, cr: 0, no: l.entryNo };
      e.dr += dr; e.cr += cr; byEntry.set(k, e);
    }
    const aggDiff = r2(totDr - totCr);
    const periodBalanced = { key: 'period_balanced', title: 'Posted entries balance in aggregate (Σdebit = Σcredit)', ok: Math.abs(aggDiff) < 0.01, debit: r2(totDr), credit: r2(totCr), diff: aggDiff };
    const unbalanced = [...byEntry.values()].filter((e) => Math.abs(e.dr - e.cr) > 0.01).map((e) => ({ entry_no: e.no, debit: r2(e.dr), credit: r2(e.cr), diff: r2(e.dr - e.cr) }));
    const entriesBalanced = { key: 'unbalanced_entries', title: 'Every posted entry is individually balanced', ok: unbalanced.length === 0, count: unbalanced.length, entries: unbalanced.slice(0, 20) };

    // 4. Suspense/clearing balance through period end (advisory — these accounts may legitimately carry WIP).
    const susConds: any[] = [lte(journalEntries.entryDate, end), eq(journalEntries.status, 'Posted'), inArray(journalLines.accountCode, SUSPENSE_ACCOUNTS)];
    if (tenantId != null) susConds.push(eq(journalEntries.tenantId, tenantId));
    const susRows = await db.select({ account: journalLines.accountCode, dr: sql<string>`coalesce(sum(${journalLines.debit}),0)`, cr: sql<string>`coalesce(sum(${journalLines.credit}),0)` })
      .from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id)).where(and(...susConds)).groupBy(journalLines.accountCode);
    const susAccts = susRows.map((r: any) => ({ account: r.account, balance: r2(num(r.dr) - num(r.cr)) })).filter((a: any) => Math.abs(a.balance) > 0.01);
    const suspense = { key: 'suspense_clearing', title: 'Suspense/clearing accounts net to zero (advisory)', ok: susAccts.length === 0, advisory: true, accounts: susAccts };

    // 5. GL-20 (docs/27 R1-2) — the gl_period_balances snapshot reconciles to the raw ledger for this
    // period, per account. The snapshot is maintained transactionally at posting, so ANY mismatch means a
    // write path bypassed LedgerService (direct SQL/ETL) — a hard blocker until resynced (re-run the 0212
    // backfill recompute), because the trial balance reads the snapshot.
    const rawConds: any[] = [sql`${journalEntries.period} = ${period}`, eq(journalEntries.status, 'Posted')];
    if (tenantId != null) rawConds.push(eq(journalEntries.tenantId, tenantId));
    const rawAgg = await db.select({ account: journalLines.accountCode, dr: sql<string>`coalesce(sum(${journalLines.debit}),0)`, cr: sql<string>`coalesce(sum(${journalLines.credit}),0)` })
      .from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(...rawConds)).groupBy(journalLines.accountCode);
    const snapConds: any[] = [eq(glPeriodBalances.period, period)];
    if (tenantId != null) snapConds.push(eq(glPeriodBalances.tenantId, tenantId));
    const snapAgg = await db.select({ account: glPeriodBalances.accountCode, dr: sql<string>`coalesce(sum(${glPeriodBalances.debit}),0)`, cr: sql<string>`coalesce(sum(${glPeriodBalances.credit}),0)` })
      .from(glPeriodBalances).where(and(...snapConds)).groupBy(glPeriodBalances.accountCode);
    const rawBy = new Map<string, { dr: number; cr: number }>(rawAgg.map((r: any) => [r.account, { dr: num(r.dr), cr: num(r.cr) }]));
    const snapBy = new Map<string, { dr: number; cr: number }>(snapAgg.map((r: any) => [r.account, { dr: num(r.dr), cr: num(r.cr) }]));
    const driftAccts: { account: string; raw_debit: number; snapshot_debit: number; raw_credit: number; snapshot_credit: number }[] = [];
    for (const acct of new Set([...rawBy.keys(), ...snapBy.keys()])) {
      const raw = rawBy.get(acct) ?? { dr: 0, cr: 0 };
      const snap = snapBy.get(acct) ?? { dr: 0, cr: 0 };
      if (Math.abs(raw.dr - snap.dr) > 0.005 || Math.abs(raw.cr - snap.cr) > 0.005) {
        driftAccts.push({ account: acct, raw_debit: r2(raw.dr), snapshot_debit: r2(snap.dr), raw_credit: r2(raw.cr), snapshot_credit: r2(snap.cr) });
      }
    }
    const snapshotRecon = { key: 'gl_snapshot_drift', title: 'Period-balance snapshot reconciles to the raw ledger (GL-20)', ok: driftAccts.length === 0, count: driftAccts.length, accounts: driftAccts.slice(0, 20) };

    const checks = [drafts, periodBalanced, entriesBalanced, suspense, snapshotRecon];
    const blockers = checks.filter((c: any) => !c.ok && !c.advisory).map((c) => c.key);
    const warnings = checks.filter((c: any) => !c.ok && c.advisory).map((c) => c.key);
    return { period, ready: blockers.length === 0, blockers, warnings, checks };
  }

  // ───────────────────── helpers ─────────────────────
  private async getRun(id: number) {
    const db = this.db;
    const [run] = await db.select().from(closeRuns).where(eq(closeRuns.id, id)).limit(1);
    if (!run) throw new NotFoundException({ code: 'CLOSE_RUN_NOT_FOUND', message: `Close run ${id} not found`, messageTh: 'ไม่พบการปิดงวด' });
    return run;
  }

  private async findRunByPeriod(period: string, tenantId: number | null) {
    const db = this.db;
    const conds = [eq(closeRuns.period, period)];
    if (tenantId != null) conds.push(eq(closeRuns.tenantId, tenantId));
    const [run] = await db.select().from(closeRuns).where(and(...conds)).limit(1);
    return run ?? null;
  }

  private async stepsFor(closeRunId: number) {
    const db = this.db;
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
    const last = new Date(Date.UTC(y!, m, 0)).getUTCDate();
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
