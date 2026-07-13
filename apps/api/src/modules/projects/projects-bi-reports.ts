import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { ProjectsService } from './projects.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class ProjectsBiReports implements BiReportSource {
  constructor(private readonly projects: ProjectsService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'project_evm',
        generate: async (_f, user) => {
          const r = await this.projects.portfolioEvm(user);
          return { data: r, summary: `Portfolio EVM: ${r.count} project(s), CPI ${r.totals.cpi ?? '—'}, ${r.at_risk.length} at risk`, summaryTh: `EVM พอร์ตโครงการ: ${r.count} โครงการ · CPI ${r.totals.cpi ?? '—'} · เสี่ยง ${r.at_risk.length}` };
        },
      },
      {
        type: 'project_health_capture',
        generate: async (_f, user) => {
          const r = await this.projects.captureAllHealth(user); // idempotent per (project, date)
          return { data: r, summary: `Project health: captured ${r.captured} of ${r.scanned} project(s) for ${r.as_of}`, summaryTh: `บันทึกสุขภาพโครงการ: ${r.captured} จาก ${r.scanned} โครงการ` };
        },
      },
      {
        type: 'project_governance_pack',
        generate: async (f, user) => {
          const r: any = await this.projects.governancePack(user, { period: f.period }); // portfolio scope
          return { data: r, summary: `Governance pack ${r.period}: ${r.count} project(s) — ${r.summary.red} red, ${r.summary.unmitigated_high} unmitigated-high risk(s), ${r.summary.overdue_milestones} overdue milestone(s), ${r.summary.pending_change_orders} pending change order(s)`, summaryTh: `รายงานสถานะ ${r.period}: ${r.count} โครงการ · แดง ${r.summary.red} · เสี่ยงสูงยังไม่รับมือ ${r.summary.unmitigated_high} · หมุดหมายเลยกำหนด ${r.summary.overdue_milestones} · ใบเปลี่ยนแปลงรออนุมัติ ${r.summary.pending_change_orders}` };
        },
      },
    ];
  }
}
