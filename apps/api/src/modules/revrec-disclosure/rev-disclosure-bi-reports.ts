import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { RevDisclosureService } from './rev-disclosure.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical). REV-27 (Track D Wave 4) —
// TFRS 15 §120 revenue disclosure pack, read-only detective aggregators.
@Injectable()
export class RevDisclosureBiReports implements BiReportSource {
  constructor(private readonly revDisclosure: RevDisclosureService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'contract_liability_rollforward',
        generate: async (f, user) => {
          // TFRS 15 §120(b) contract-liability rollforward for the caller's tenant. Read-only; ties to GL by construction.
          let period = f.period as string | undefined;
          if (!period || !/^\d{4}-\d{2}$/.test(period)) period = new Date().toISOString().slice(0, 7);
          const r = await this.revDisclosure.contractLiabilityRollforward(period, user, user.tenantId ?? null);
          const cl = r.contract_liability;
          return { data: r, summary: `Contract-liability rollforward ${period}: opening ${cl.opening} + billings ${cl.billings} − recognized ${cl.recognized} = closing ${cl.closing} (GL ${cl.gl_closing}, ${r.reconciled ? 'reconciled' : 'OUT OF BALANCE'})`, summaryTh: `กระทบยอดหนี้สินตามสัญญา ${period}: ยกมา ${cl.opening} + วางบิล ${cl.billings} − รับรู้ ${cl.recognized} = ยกไป ${cl.closing} (${r.reconciled ? 'กระทบยอดตรง' : 'ไม่ตรง'})` };
        },
      },
      {
        type: 'rpo_backlog',
        generate: async (f, user) => {
          // TFRS 15 §120(a) remaining performance obligation (backlog) for the caller's tenant. Read-only.
          const r = await this.revDisclosure.rpo(user, { asOf: f.period, explicitTenantId: user.tenantId ?? null });
          return { data: r, summary: `RPO / backlog: ${r.total_rpo} across ${r.count} contract(s) — ${r.within_12m} within 12m, ${r.beyond_12m} beyond`, summaryTh: `ภาระที่ยังไม่ปฏิบัติ (Backlog): ${r.total_rpo} จาก ${r.count} สัญญา — ภายใน 12 เดือน ${r.within_12m} · เกินกว่านั้น ${r.beyond_12m}` };
        },
      },
    ];
  }
}
