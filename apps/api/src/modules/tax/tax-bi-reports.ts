import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { TaxJobsService } from './tax-jobs.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical). Tax automation action jobs
// (docs/33 PR4, TAX-03/TAX-05) — each run is idempotent per period.
@Injectable()
export class TaxBiReports implements BiReportSource {
  constructor(private readonly taxJobs: TaxJobsService) {}

  biReports(): BiReportGenerator[] {
    const filingDraft = (which: 'tax_pp30_draft' | 'tax_pnd_draft') => async (f: any, user: any) => {
      const type = which === 'tax_pp30_draft' ? 'PP30' : (f.pnd_type || 'PND53');
      const r = await this.taxJobs.runFilingDraft(user, type, f.month ? Number(f.month) : undefined, f.year ? Number(f.year) : undefined); // idempotent per (tenant,type,period)
      return { data: r, summary: `Draft filing ${type} ${r.period}: status ${r.status}${r.already_filed ? ' (already filed)' : ''}`, summaryTh: `จัดทำแบบ ${type} ${r.period}: สถานะ ${r.status}` };
    };
    return [
      {
        type: 'tax_wht_cert_batch',
        generate: async (f, user) => {
          const r = await this.taxJobs.runWhtCertBatch(user, f.month ? Number(f.month) : undefined, f.year ? Number(f.year) : undefined); // idempotent: skips already-certificated payments
          return { data: r, summary: `WHT certificates ${r.period}: issued ${r.issued} of ${r.scanned} (${r.skipped} skipped)`, summaryTh: `หนังสือรับรองหัก ณ ที่จ่าย ${r.period}: ออก ${r.issued} จาก ${r.scanned} รายการ (ข้าม ${r.skipped})` };
        },
      },
      { type: 'tax_pp30_draft', generate: filingDraft('tax_pp30_draft') },
      { type: 'tax_pnd_draft', generate: filingDraft('tax_pnd_draft') },
      {
        type: 'tax_remittance_reminder',
        generate: async (f, user) => {
          const r = await this.taxJobs.remittanceReminder(user, f.month ? Number(f.month) : undefined, f.year ? Number(f.year) : undefined);
          return { data: r, summary: `Remittance ${r.period}: PP30 net VAT ฿${r.pp30.net_vat_payable} (due ${r.pp30.deadline}); WHT ฿${r.pnd.wht_withheld} (due ${r.pnd.deadline}), un-certificated ฿${r.pnd.uncertificated_wht}`, summaryTh: `นำส่งภาษี ${r.period}: VAT สุทธิ ฿${r.pp30.net_vat_payable} (ครบกำหนด ${r.pp30.deadline}); หัก ณ ที่จ่าย ฿${r.pnd.wht_withheld} (ครบกำหนด ${r.pnd.deadline})` };
        },
      },
      {
        type: 'etax_submission_retry',
        generate: async (f, user) => {
          const r = await this.taxJobs.runEtaxSubmissionRetry(user, f.limit ? Number(f.limit) : undefined); // idempotent: only the latest non-Accepted attempt per doc_no is retried
          return { data: r, summary: `e-Tax retry: ${r.succeeded} of ${r.scanned} succeeded (${r.failed} still failed)`, summaryTh: `ลองส่ง e-Tax ซ้ำ: สำเร็จ ${r.succeeded} จาก ${r.scanned} (ยังล้มเหลว ${r.failed})` };
        },
      },
    ];
  }
}
