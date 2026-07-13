import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { BudgetService } from './budget.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class BudgetBiReports implements BiReportSource {
  constructor(private readonly budget: BudgetService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'budget_variance',
        generate: async (f) => {
          const fy = Number(f.fiscal_year) || new Date().getFullYear();
          const r = await this.budget.budgetVsActual({ fiscal_year: fy, period: f.period, cost_center: f.cost_center });
          return { data: r, summary: `Budget ${fy}: net variance ${r.rollup.net.variance} (${r.rollup.net.favorable ? 'favorable' : 'unfavorable'}); ${r.review.requires_review_count} item(s) need review`, summaryTh: `งบประมาณ ${fy}: ผลต่างสุทธิ ${r.rollup.net.variance} · ต้องทบทวน ${r.review.requires_review_count} รายการ` };
        },
      },
    ];
  }
}
