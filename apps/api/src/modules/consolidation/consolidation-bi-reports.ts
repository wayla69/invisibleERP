import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { prevBizMonth } from '../ledger/ledger-bi-reports';
import { ConsolidationService } from './consolidation.service';

// B3 (docs/50 Wave 2) — schedulable consolidation STAGING (CON-01). Auto-DRAFT only: each group's run is
// staged/recomputed for the target period (idempotent — a prior Draft/Final run for the period is
// superseded, a Posted one is frozen); POSTING stays a maker-checker human act (CON-03 unchanged). The
// sweep is fault-isolated per group: a group whose gates aren't met yet (IC recon not approved, no
// entities, already posted, not HQ) records its outcome and never poisons the other groups' staging —
// exactly what the close cockpit wants to see the morning after month turn.
@Injectable()
export class ConsolidationBiReports implements BiReportSource {
  constructor(private readonly consolidation: ConsolidationService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'consolidation_run',
        generate: async (f, user) => {
          const period = typeof f?.period === 'string' && /^\d{4}-\d{2}$/.test(f.period) ? f.period : prevBizMonth();
          const groups: { id: number; name?: string }[] = f?.group_id
            ? [{ id: Number(f.group_id) }]
            : ((await this.consolidation.listGroups(user)).groups ?? []).map((g: any) => ({ id: Number(g.id), name: g.name }));
          const results: any[] = [];
          for (const g of groups) {
            try {
              const r: any = await this.consolidation.runConsolidation(Number(g.id), { period }, user);
              results.push({ group_id: g.id, name: g.name, outcome: 'staged', run_id: r.run_id, status: r.status, balanced: r.balanced });
            } catch (e: any) {
              const code = e?.response?.code ?? (typeof e?.getResponse === 'function' ? (e.getResponse() as { code?: string })?.code : undefined) ?? 'ERROR';
              results.push({ group_id: g.id, name: g.name, outcome: code });
            }
          }
          const staged = results.filter((r) => r.outcome === 'staged').length;
          const skipped = results.filter((r) => r.outcome !== 'staged').map((r) => `${r.group_id}:${r.outcome}`);
          return {
            data: { period, results },
            summary: `Consolidation ${period}: staged ${staged} of ${results.length} group(s)${skipped.length ? ` — skipped ${skipped.join(', ')}` : ''} (posting stays maker-checker)`,
            summaryTh: `รวมงบงวด ${period}: เตรียม ${staged} จาก ${results.length} กลุ่ม${skipped.length ? ` (ข้าม ${skipped.length} กลุ่ม)` : ''} — รอผู้อนุมัติโพสต์`,
          };
        },
      },
    ];
  }
}
