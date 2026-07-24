import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { MiBacktestService } from './mi-backtest.service';

// docs/62 Phase 2 — marketing-intel's BI report provider (discovered by BiReportRegistrarService; the
// registry-first pattern — never a new branch/ctor param in bi-generate). One DETECTIVE report:
// `mkt_plan_backtest` (control MKT-26) reconciles every APPROVED budget plan against actual per-channel
// marketing spend and surfaces the flagged variances. Read-only + trivially idempotent (a pure
// recomputation); schedule it monthly so misallocation cannot age silently.
@Injectable()
export class MarketingIntelBiReports implements BiReportSource {
  constructor(private readonly backtest: MiBacktestService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'mkt_plan_backtest',
        generate: async (_f, user) => {
          const r: any = await this.backtest.backtestAllApproved(user);
          return {
            data: r,
            summary: `Plan-vs-actual backtest: ${r.plans} approved plan(s) reconciled, ${r.flagged} flagged${r.flagged ? ` (${(r.flagged_plans ?? []).join(', ')})` : ''}${r.skipped ? `, ${r.skipped} skipped (no actuals)` : ''}`,
            summaryTh: `ตรวจสอบแผนงบเทียบจ่ายจริง: ${r.plans} แผน, ผิดปกติ ${r.flagged} แผน${r.skipped ? `, ข้าม ${r.skipped} (ไม่มีข้อมูลจ่ายจริง)` : ''}`,
          };
        },
      },
    ];
  }
}
