import { BadRequestException, Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { cdpConfigured, pushToCdp } from '../../common/cdp-sync';
import { CrmService } from './crm.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class CrmBiReports implements BiReportSource {
  constructor(private readonly crmMembers: CrmService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'crm_profile_refresh',
        generate: async (_f, user) => {
          const r = await this.crmMembers.refreshAllProfiles(user); // idempotent: a pure profile upsert per member
          return { data: r, summary: `RFM refresh: profiled ${r.profiled} members, ${r.segment_changes} segment change(s)`, summaryTh: `รีเฟรช RFM: ${r.profiled} สมาชิก เปลี่ยนกลุ่ม ${r.segment_changes} ราย` };
        },
      },
      {
        type: 'cdp_export_sync',
        generate: async (_f, user) => {
          const target = cdpConfigured() ? 'cdp' : 'mock';
          // Push the whole member base in batches (idempotent full snapshot on member_code); consent flags ride
          // each row so the CDP honours opt-outs. A batch failure stops the run and is reported in the summary.
          const BATCH = 500; let offset = 0, pushed = 0, total = 0, ok = true;
          for (let i = 0; i < 200; i++) { // safety cap: 200 batches (100k members)
            const exp: any = await this.crmMembers.exportForCdp(user, { limit: BATCH, offset });
            if (exp?.error) throw new BadRequestException(exp.error);
            total = exp.total;
            if (!exp.members?.length) break;
            const r = await pushToCdp({ tenant_id: exp.tenant_id, batch: i, offset, count: exp.members.length, total, members: exp.members });
            if (!r.ok) { ok = false; break; }
            pushed += exp.members.length;
            offset += exp.members.length;
            if (exp.members.length < BATCH) break;
          }
          return { data: { pushed, total, target, ok }, summary: `CDP sync: pushed ${pushed}/${total} members to ${target}${ok ? '' : ' (stopped on error)'}`, summaryTh: `ซิงก์ CDP: ส่ง ${pushed}/${total} สมาชิกไปยัง ${target}${ok ? '' : ' (หยุดเพราะข้อผิดพลาด)'}` };
        },
      },
    ];
  }
}
