import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { LedgerService } from './ledger.service';
import { FxRevalService } from './fx-reval.service';
import { ymd } from '../../database/queries';

// B3 (docs/50 Wave 2): the business month the period-end jobs target by default — the JUST-ENDED month
// (a monthly schedule fires at the turn of the month to stage the closing period's run).
export const prevBizMonth = (): string => {
  const [y, m] = ymd().slice(0, 7).split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical). The scheduled GL action jobs
// (GL-08 recurring, GL-09 prepaid, GL-23 allocations) ride the facade's delegators.
@Injectable()
export class LedgerBiReports implements BiReportSource {
  constructor(private readonly ledger: LedgerService, private readonly fxReval: FxRevalService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'gl_recurring_journals',
        generate: async (_f, user) => {
          const r = await this.ledger.runDueRecurring(user); // idempotent: next_run_date advanced + ux_je_idem
          return { data: r, summary: `Recurring journals: posted ${r.posted} of ${r.scanned} due templates`, summaryTh: `ลงรายการบัญชีตั้งเวลา: ${r.posted} จาก ${r.scanned} แม่แบบ` };
        },
      },
      {
        type: 'gl_prepaid_amortize',
        generate: async (_f, user) => {
          const r = await this.ledger.runDuePrepaid(user); // idempotent per (schedule, period)
          return { data: r, summary: `Prepaid amortization: posted ${r.posted} of ${r.scanned} due schedules`, summaryTh: `ตัดจ่ายค่าใช้จ่ายล่วงหน้า: ${r.posted} จาก ${r.scanned} รายการ` };
        },
      },
      {
        type: 'gl_allocation_run',
        generate: async (_f, user) => {
          const r = await this.ledger.runDueAllocations(user); // idempotent per period: next_run_date advanced + ux_je_idem
          return { data: r, summary: `Allocation cycles: posted ${r.posted} of ${r.scanned} due cycles`, summaryTh: `ปันส่วนต้นทุน: ${r.posted} จาก ${r.scanned} รอบ` };
        },
      },
      {
        // B3 (docs/50 Wave 2) — schedulable FX revaluation STAGING (GL-18). Auto-DRAFT only: the run
        // stages/refreshes the period's Open run (idempotent per period — runReval recomputes an Open
        // run in place); POSTING stays a maker-checker human act (SELF_POST unchanged). An
        // already-posted period is a graceful no-op, so a monthly schedule never errors after close.
        type: 'gl_fx_reval_run',
        generate: async (f, user) => {
          const period = typeof f?.period === 'string' && /^\d{4}-\d{2}$/.test(f.period) ? f.period : prevBizMonth();
          try {
            const r = await this.fxReval.runReval({ period, runBy: `${user?.username ?? 'system'} (scheduled)`, tenantId: user.tenantId ?? null });
            return { data: r, summary: `FX revaluation ${period}: staged run #${(r as { id?: number }).id ?? '?'} (Open — awaiting maker-checker post)`, summaryTh: `ปรับปรุงอัตราแลกเปลี่ยนงวด ${period}: เตรียมรายการแล้ว (รอผู้อนุมัติโพสต์)` };
          } catch (e: any) {
            const code = e?.response?.code ?? (typeof e?.getResponse === 'function' ? (e.getResponse() as { code?: string })?.code : undefined);
            if (code === 'ALREADY_POSTED') return { data: { period, outcome: 'already_posted' }, summary: `FX revaluation ${period}: already posted — no-op`, summaryTh: `งวด ${period} โพสต์แล้ว — ไม่มีการเปลี่ยนแปลง` };
            throw e;
          }
        },
      },
    ];
  }
}
