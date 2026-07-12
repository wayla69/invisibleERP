import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { FluxService } from './flux.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class FluxBiReports implements BiReportSource {
  constructor(private readonly flux: FluxService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'flux_analysis',
        generate: async (f, user) => {
          // Default the period to the prior month (last full close period) if the schedule didn't pin one.
          let period = f.period as string | undefined;
          if (!period || !/^\d{4}-\d{2}$/.test(period)) {
            const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
            period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
          }
          const r = await this.flux.generate({ period, basis: f.basis, comparative: f.comparative, threshold_abs: f.threshold_abs, threshold_pct: f.threshold_pct }, user);
          const a = r.analysis;
          return { data: r, summary: `Flux ${a.period} (${a.basis} vs ${a.comparative_period}): ${a.breached_count} line(s) breach threshold${a.breached_count ? ' — explanation required before sign-off' : ''}`, summaryTh: `วิเคราะห์ผลต่าง ${a.period} (${a.basis} เทียบ ${a.comparative_period}): เกินเกณฑ์ ${a.breached_count} รายการ${a.breached_count ? ' — ต้องอธิบายก่อนลงนามรับรอง' : ''}` };
        },
      },
    ];
  }
}
