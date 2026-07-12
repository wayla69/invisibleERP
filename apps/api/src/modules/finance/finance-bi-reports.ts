import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { CollectionsService } from './collections.service';
import { FinanceMetricsService } from './finance-metrics.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical). Covers the AR dunning action job
// and the docs/35 Phase 6 schedulable finance packs (the summary carries the MD&A headline).
@Injectable()
export class FinanceBiReports implements BiReportSource {
  constructor(private readonly collections: CollectionsService, private readonly financeMetrics: FinanceMetricsService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'ar_collections_dunning',
        generate: async (_f, user) => {
          const r = await this.collections.runDunningSweep(user); // idempotent: re-runs the same day advance nothing
          return { data: r, summary: `Dunning sweep: advanced ${r.advanced} of ${r.scanned} overdue invoices`, summaryTh: `ทวงถามอัตโนมัติ: เลื่อนขั้น ${r.advanced} จาก ${r.scanned} รายการค้างชำระ` };
        },
      },
      {
        type: 'cfo_kpi_pack',
        generate: async (_f, user) => {
          const r: any = await this.financeMetrics.pack({}, user);
          const reds = r.kpis.filter((k: any) => k.rag === 'red').length;
          return { data: r, summary: `CFO KPIs (${r.as_of}): ${r.narrative?.headline_en ?? ''} — ${reds} red`, summaryTh: `ตัวชี้วัด CFO (${r.as_of}): ${r.narrative?.headline_th ?? ''}` };
        },
      },
      {
        type: 'cash_position_pack',
        generate: async (_f, user) => {
          const r: any = await this.financeMetrics.cashPosition({ weeks: 13 }, user);
          return { data: r, summary: `Cash ${r.total_cash}; projected close ${r.forecast?.projected_closing_cash}; trough ${r.forecast?.min_balance} at wk+${r.forecast?.min_week}`, summaryTh: `เงินสด ${r.total_cash} · คาดการณ์ปลายช่วง ${r.forecast?.projected_closing_cash} · จุดต่ำสุด ${r.forecast?.min_balance} สัปดาห์ +${r.forecast?.min_week}` };
        },
      },
      {
        type: 'close_status_pack',
        generate: async (_f, user) => {
          const r: any = await this.financeMetrics.closeStatus({}, user);
          return { data: r, summary: `Close ${r.period}: overall ${r.rag?.overall}; tie-out exceptions ${r.tie_out?.exceptions ?? '—'}; days-to-close ${r.days_to_close}`, summaryTh: `ปิดงวด ${r.period}: สถานะ ${r.rag?.overall} · รายการไม่ตรง ${r.tie_out?.exceptions ?? '—'} · จำนวนวันปิดงวด ${r.days_to_close}` };
        },
      },
    ];
  }
}
