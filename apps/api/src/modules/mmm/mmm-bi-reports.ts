import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import type { JwtUser } from '../../common/decorators';
import { MmmModelService } from './mmm-model.service';

// docs/48 — module-owned BI report generators (docs/46 Phase 1 registry pattern). `mmm_run` is a scheduled
// "action" job (same shape as ar_collections_dunning / reputation_ga4_sync — a tenant admin schedules it via
// /scheduled-reports) that refreshes the channel model from the latest ingested data; `mmm_summary` is a
// read-only dashboard aggregate also exposed live via GET /api/bi/mmm-summary (same shape as marketing_roi).
@Injectable()
export class MmmBiReports implements BiReportSource {
  constructor(private readonly model: MmmModelService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'mmm_run',
        generate: async (f, user) => {
          const r = await this.model.runModel(user, { windowDays: f?.window_days, spendByChannel: f?.spend_by_channel });
          return {
            data: r,
            summary: `MMM run ${r.run_no}: ${r.channels} channel(s), spend ${r.total_spend.toLocaleString()} THB over ${r.window_days}d`,
            summaryTh: `รันโมเดล MMM ${r.run_no}: ${r.channels} ช่องทาง งบ ${r.total_spend.toLocaleString()} บาท ${r.window_days} วัน`,
          };
        },
      },
      {
        type: 'mmm_summary',
        generate: async (_f, user) => {
          const data = await this.model.latestSummary(user);
          const top = data.results.slice().sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))[0];
          return {
            data,
            summary: data.has_run ? `MMM ${data.run_no}: ${data.results.length} channel(s), best ROI ${top?.channel ?? '–'} (${top?.roi ?? '–'})` : 'MMM: no model run yet',
            summaryTh: data.has_run ? `MMM ${data.run_no}: ${data.results.length} ช่องทาง ROI สูงสุด ${top?.channel ?? '–'} (${top?.roi ?? '–'})` : 'MMM: ยังไม่มีการรันโมเดล',
          };
        },
      },
    ];
  }
}
