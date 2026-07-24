import { Inject, Injectable } from '@nestjs/common';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { journalEntries, journalLines, postingRules, coaChangeRequests, closeRuns, closeRunSteps } from '../../database/schema';
import { n, ymd } from '../../database/queries';
import { approvalAgeDays as ageDays, type ApprovalQueue, type ApprovalQueueSource, type PendingApprovalItem } from '../../common/approval-queues';

// docs/46 Phase 2 — the ledger's GOV-01 approval queues (discovered by ApprovalQueueRegistrarService;
// moved verbatim out of finance.service.ts pendingApprovals, behaviour identical).
@Injectable()
export class LedgerApprovalQueues implements ApprovalQueueSource {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  approvalQueues(): ApprovalQueue[] {
    const db = this.db;
    return [
      {
        // GL-05 — manual journals posted as Draft, awaiting approval. Amount = Σ debit of the entry's lines.
        // A Draft JE from another maker-checker that posts via ledger.postEntry (e.g. a bank fee/interest
        // adjustment, source BANKADJ → BANK-02) is tagged to its own control here.
        source: 'gl_drafts',
        pending: async () => {
          const items: PendingApprovalItem[] = [];
          const JE_CONTROL: Record<string, { control: string; type: string }> = { BANKADJ: { control: 'BANK-02', type: 'bank_adjustment' } };
          const drafts = await db.select().from(journalEntries).where(eq(journalEntries.status, 'Draft'));
          if (drafts.length) {
            const ids = drafts.map((e: any) => Number(e.id));
            const sums = await db.select({ entryId: journalLines.entryId, dr: sql<string>`coalesce(sum(${journalLines.debit}),0)` }).from(journalLines).where(inArray(journalLines.entryId, ids)).groupBy(journalLines.entryId);
            const byId = new Map<number, number>(sums.map((s: any) => [Number(s.entryId), n(s.dr)]));
            for (const e of drafts) {
              const meta = JE_CONTROL[String(e.source ?? '')] ?? { control: 'GL-05', type: 'journal' };
              items.push({ type: meta.type, control: meta.control, ref: e.entryNo, label: e.memo ?? 'Manual journal', amount: byId.get(Number(e.id)) ?? 0, requested_by: e.createdBy ?? null, requested_at: e.createdAt ?? null, age_days: ageDays(e.createdAt) });
            }
          }
          return items;
        },
      },
      {
        // GL-24 — tenant posting-rule overrides awaiting a DIFFERENT user's approval (COA-D1: the override
        // is inert until approved, but it used to wait invisibly on /setup/posting-rules — now it ages here too).
        source: 'posting_rule',
        pending: async () => {
          const items: PendingApprovalItem[] = [];
          for (const r of await db.select().from(postingRules).where(and(eq(postingRules.status, 'PendingApproval'), eq(postingRules.active, true))))
            items.push({ type: 'posting_rule', control: 'GL-24', ref: `PRULE-${Number(r.id)}`, label: `กฎการลงบัญชี ${r.eventType} · ${r.role} → ${r.accountCode}`, amount: 0, requested_by: r.createdBy ?? null, requested_at: r.createdAt ?? null, age_days: ageDays(r.createdAt) });
          return items;
        },
      },
      {
        // GL-15 (Close Manager v2, docs/50 follow-up) — OVERDUE close tasks: a checklist step in an ACTIVE
        // (not Locked) close run that is past its B1 due date and not Done ages in the GOV-01 center, so a
        // slipping close surfaces where the controller already looks instead of silently drifting. Age is
        // measured from the DUE date (days overdue), and the owner role rides requested_by so the worklist
        // shows who the task is waiting on. Detective/read-only — the sign-off itself stays on the
        // period-close screen (GL-15/GL-16 unchanged).
        source: 'close_task_overdue',
        pending: async () => {
          const items: PendingApprovalItem[] = [];
          const today = ymd();
          const rows = await db.select({
            period: closeRuns.period, stepKey: closeRunSteps.stepKey, title: closeRunSteps.title,
            ownerRole: closeRunSteps.ownerRole, dueDate: closeRunSteps.dueDate, required: closeRunSteps.required,
          }).from(closeRunSteps).innerJoin(closeRuns, eq(closeRunSteps.closeRunId, closeRuns.id))
            .where(and(sql`${closeRunSteps.status} <> 'Done'`, sql`${closeRunSteps.dueDate} IS NOT NULL`,
              sql`${closeRunSteps.dueDate} < ${today}`, sql`${closeRuns.status} <> 'Locked'`));
          for (const r of rows) {
            items.push({
              type: 'close_task_overdue', control: 'GL-15', ref: `CLOSE-${r.period}:${r.stepKey}`,
              label: `งานปิดงวด ${r.period} เลยกำหนด: ${r.title}${r.ownerRole ? ` (${r.ownerRole})` : ''}${r.required ? '' : ' [advisory]'}`,
              amount: 0, requested_by: r.ownerRole ?? null, requested_at: r.dueDate ?? null, age_days: ageDays(r.dueDate),
            });
          }
          return items;
        },
      },
      {
        // GL-27 — canonical CoA change requests awaiting a DIFFERENT Admin (platform-level: the canonical
        // chart is global, so these rows are not tenant-scoped; approval still requires platform Admin).
        source: 'coa_change',
        pending: async () => {
          const items: PendingApprovalItem[] = [];
          for (const c of await db.select().from(coaChangeRequests).where(eq(coaChangeRequests.status, 'PendingApproval')))
            items.push({ type: 'coa_change', control: 'GL-27', ref: `COA-${Number(c.id)}`, label: `${c.action === 'create' ? 'สร้างบัญชี' : c.action === 'deactivate' ? 'ปิดใช้บัญชี' : 'แก้ไขบัญชี'} ${c.accountCode}`, amount: 0, requested_by: c.createdBy ?? null, requested_at: c.createdAt ?? null, age_days: ageDays(c.createdAt) });
          return items;
        },
      },
    ];
  }
}
