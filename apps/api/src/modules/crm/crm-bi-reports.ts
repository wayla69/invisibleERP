import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { audienceExports, ropaActivities } from '../../database/schema';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { cdpConfigured, pushToCdp, audienceExportConfigured, pushHashedAudience } from '../../common/cdp-sync';
import { CrmService } from './crm.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class CrmBiReports implements BiReportSource {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly crmMembers: CrmService) {}

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
      {
        // G3 (docs/45) — PDPA-05: the consent-gated, hashed ads-audience activation job. FAIL-CLOSED twice over:
        // (1) it refuses to run without an ACTIVE ROPA activity named 'audience_export' with legal_basis='consent'
        // (the processing register IS the permission to process — ROPA_MISSING otherwise, recorded 'blocked');
        // (2) the payload builder (CrmService.exportForCustomerMatch) includes ONLY members with a live marketing
        // consent row and emits ONLY sha256 hashes — raw PII never reaches the wire. Every attempt lands in the
        // append-only audience_exports register; the push routes through the SSRF-gated pushHashedAudience.
        type: 'audience_export_sync',
        generate: async (f, user) => {
          const db = this.db;
          const tenantId = f.tenant_id ?? user.tenantId;
          if (tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'HQ/Admin must specify tenant_id', messageTh: 'สำนักงานใหญ่ต้องระบุ tenant_id' });

          const [ropa] = await db.select().from(ropaActivities).where(and(
            eq(ropaActivities.tenantId, Number(tenantId)), eq(ropaActivities.active, true),
            eq(ropaActivities.name, 'audience_export'), eq(ropaActivities.legalBasis, 'consent'),
          )).limit(1);
          if (!ropa) {
            await db.insert(audienceExports).values({ tenantId: Number(tenantId), target: audienceExportConfigured() ? 'webhook' : 'mock', status: 'blocked', error: 'ROPA_MISSING', createdBy: user.username }).catch(() => null);
            throw new BadRequestException({ code: 'ROPA_MISSING', message: "Audience export is blocked: create an ACTIVE ROPA activity named 'audience_export' with legal_basis='consent' (POST /api/pdpa/ropa) first", messageTh: 'ยังส่งกลุ่มเป้าหมายไม่ได้: ต้องบันทึกกิจกรรม ROPA ชื่อ audience_export (ฐานความยินยอม) ก่อน' });
          }

          const target = audienceExportConfigured() ? 'webhook' : 'mock';
          const BATCH = 500;
          let offset = 0, pushed = 0, consented = 0, considered = 0, ok = true, err: string | null = null;
          for (let i = 0; i < 200; i++) { // safety cap: 200 batches (100k members)
            const exp: any = await this.crmMembers.exportForCustomerMatch(user, { tenantId: Number(tenantId), limit: BATCH, offset });
            if (exp?.error) throw new BadRequestException(exp.error);
            considered = exp.total_active; consented = exp.consented;
            if (!exp.members?.length && offset > 0) break;
            if (exp.members?.length) {
              const r = await pushHashedAudience({ tenant_id: exp.tenant_id, hash_alg: exp.hash_alg, consent_basis: exp.consent_basis, batch: i, offset, count: exp.members.length, members: exp.members });
              if (!r.ok) { ok = false; err = r.error ?? `status ${r.status}`; break; }
              pushed += exp.members.length;
            }
            offset += exp.count;
            if (exp.count < BATCH) break;
          }

          await db.insert(audienceExports).values({
            tenantId: Number(tenantId), target, membersConsidered: considered, membersConsented: consented,
            rowsPushed: pushed, status: ok ? 'success' : 'failed', error: err, ropaActivityId: Number(ropa.id), createdBy: user.username,
          }).catch(() => null);
          if (!ok) throw new BadRequestException({ code: 'AUDIENCE_PUSH_FAILED', message: `Audience push failed: ${err}`, messageTh: 'ส่งกลุ่มเป้าหมายไม่สำเร็จ' });

          return {
            data: { target, considered, consented, pushed, hash_alg: 'sha256', consent_basis: 'member_consents:marketing', ropa_activity_id: Number(ropa.id) },
            summary: `Audience export: ${pushed} hashed row(s) from ${consented} consented (of ${considered} active) → ${target}; ROPA #${ropa.id}`,
            summaryTh: `ส่งกลุ่มเป้าหมายโฆษณา: ${pushed} แถว (hash) จากสมาชิกยินยอม ${consented}/${considered} → ${target} · ROPA #${ropa.id}`,
          };
        },
      },
    ];
  }
}
