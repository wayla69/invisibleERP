import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../../bi/report-registry';
import { CrmPipelineService } from './crm-pipeline.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical). CRM-5 analytics that answer
// "why" — win/loss, funnel + velocity, source ROI, forecast categories — plus the CRM-4 follow-up
// digest (detective control REV-22). All read-only except the digest's automation events.
@Injectable()
export class CrmPipelineBiReports implements BiReportSource {
  constructor(private readonly crm: CrmPipelineService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'crm_followup_digest',
        generate: async (_f, user) => {
          const r = await this.crm.runFollowUpSweep(user); // read-only: fires lead.stagnant + a rail notification
          return { data: r, summary: `Follow-up digest: ${r.total} item(s) — ${r.sla_breaches} SLA-breached lead(s), ${r.overdue_activities} overdue task(s), ${r.rotting_deals} rotting deal(s)`, summaryTh: `สรุปการติดตาม: ${r.total} รายการ — ลีดเกิน SLA ${r.sla_breaches} · งานเลยกำหนด ${r.overdue_activities} · ดีลค้าง ${r.rotting_deals}` };
        },
      },
      {
        type: 'crm_win_loss',
        generate: async (f, user) => {
          const r = await this.crm.winLoss(user, { months: f.months });
          return { data: r, summary: `Win/loss: win rate ${r.summary.win_rate}, won ${r.summary.won_amount}, lost ${r.summary.lost_amount}, ${r.loss_reasons.length} loss reason(s)`, summaryTh: `Win/Loss: อัตราชนะ ${r.summary.win_rate} · ชนะ ${r.summary.won_amount} · แพ้ ${r.summary.lost_amount}` };
        },
      },
      {
        type: 'crm_funnel',
        generate: async (f, user) => {
          const r = await this.crm.funnel(user, { months: f.months });
          const slowest = r.velocity[0];
          return { data: r, summary: `Funnel (${r.window_months}m): ${r.funnel[0]?.count ?? 0} lead(s) → ${r.funnel[3]?.count ?? 0} won (${r.overall_conversion_pct}% end-to-end); avg cycle ${r.avg_sales_cycle_days}d${slowest ? `; slowest stage ${slowest.stage} ${slowest.avg_days_in_stage}d` : ''}`, summaryTh: `กรวยการขาย (${r.window_months} เดือน): ${r.funnel[0]?.count ?? 0} lead → ชนะ ${r.funnel[3]?.count ?? 0} (${r.overall_conversion_pct}%) · รอบขายเฉลี่ย ${r.avg_sales_cycle_days} วัน` };
        },
      },
      {
        type: 'crm_source_roi',
        generate: async (f, user) => {
          const r = await this.crm.sourceRoi(user, { months: f.months });
          const top = r.sources[0];
          return { data: r, summary: `Source ROI (${r.window_months}m): ${r.sources.length} source(s), won ${r.total_won}${top ? `; top ${top.source} ${top.won_amount} (${top.win_rate_pct}% win)` : ''}`, summaryTh: `ROI ตามแหล่งที่มา (${r.window_months} เดือน): ${r.sources.length} แหล่ง · ยอดชนะ ${r.total_won}${top ? ` · สูงสุด ${top.source} ${top.won_amount}` : ''}` };
        },
      },
      {
        type: 'crm_forecast',
        generate: async (f, user) => {
          const r = await this.crm.forecast(user, { months: f.months, quotas: f.quotas });
          return { data: r, summary: `Forecast: commit ${r.categories.commit.amount}, best-case ${r.categories.best_case.amount}, pipeline ${r.categories.pipeline.amount}; weighted forecast ${r.forecast_amount}; ${r.quota_attainment.length} owner(s)`, summaryTh: `พยากรณ์: commit ${r.categories.commit.amount} · best-case ${r.categories.best_case.amount} · pipeline ${r.categories.pipeline.amount} · ถ่วงน้ำหนัก ${r.forecast_amount}` };
        },
      },
    ];
  }
}
