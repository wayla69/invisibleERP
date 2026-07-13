import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { audienceExports, ropaActivities } from '../../database/schema';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { cdpConfigured, pushToCdp, audienceExportConfigured, pushHashedAudience } from '../../common/cdp-sync';
import { resolveAudienceProviders } from '../../common/audience-providers';
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
            const blockedTargets = [...resolveAudienceProviders().map((p) => p.name), ...(audienceExportConfigured() ? ['webhook'] : [])];
            await db.insert(audienceExports).values({ tenantId: Number(tenantId), target: blockedTargets.length ? blockedTargets.join('+') : 'mock', status: 'blocked', error: 'ROPA_MISSING', createdBy: user.username }).catch(() => null);
            throw new BadRequestException({ code: 'ROPA_MISSING', message: "Audience export is blocked: create an ACTIVE ROPA activity named 'audience_export' with legal_basis='consent' (POST /api/pdpa/ropa) first", messageTh: 'ยังส่งกลุ่มเป้าหมายไม่ได้: ต้องบันทึกกิจกรรม ROPA ชื่อ audience_export (ฐานความยินยอม) ก่อน' });
          }

          // Targets: every env-configured DIRECT adapter (meta/google) + the generic webhook; none ⇒ mock.
          // Each recipient gets its OWN append-only register row (per-recipient PDPA evidence).
          const providers = resolveAudienceProviders();
          const targets: string[] = [...providers.map((p) => p.name), ...(audienceExportConfigured() ? ['webhook'] : [])];
          const targetLabel = targets.length ? targets.join('+') : 'mock';
          const BATCH = 500;
          let consented = 0, considered = 0;
          const batches: any[] = [];
          let offset = 0;
          for (let i = 0; i < 200; i++) { // safety cap: 200 batches (100k members)
            const exp: any = await this.crmMembers.exportForCustomerMatch(user, { tenantId: Number(tenantId), limit: BATCH, offset });
            if (exp?.error) throw new BadRequestException(exp.error);
            considered = exp.total_active; consented = exp.consented;
            if (exp.members?.length) batches.push(exp);
            offset += exp.count;
            if (exp.count < BATCH) break;
          }
          const totalRows = batches.reduce((a, b) => a + b.members.length, 0);
          const sessionId = Date.now();
          // member_id is INTERNAL (manifest upkeep) — strip it from every wire payload
          const wireRows = (members: any[]) => members.map(({ member_id, ...hashes }: any) => hashes);

          const results: { target: string; ok: boolean; err: string | null; ref?: string }[] = [];
          // webhook / mock leg (unchanged contract: per-batch JSON POST via the SSRF-gated pushHashedAudience)
          if (!targets.length || targets.includes('webhook')) {
            let ok = true, err: string | null = null;
            for (let i = 0; i < batches.length; i++) {
              const exp = batches[i]!;
              const r = await pushHashedAudience({ tenant_id: exp.tenant_id, hash_alg: exp.hash_alg, consent_basis: exp.consent_basis, batch: i, offset: i * BATCH, count: exp.members.length, members: wireRows(exp.members) });
              if (!r.ok) { ok = false; err = r.error ?? `status ${r.status}`; break; }
            }
            results.push({ target: targets.length ? 'webhook' : 'mock', ok, err });
          }
          // direct adapters: each gets the full session (create → add per batch → finalize on the last batch)
          for (const provider of providers) {
            let ok = true, err: string | null = null, ref: string | undefined;
            for (let i = 0; i < batches.length; i++) {
              const r = await provider.push(wireRows(batches[i]!.members), { sessionId, batchSeq: i + 1, lastBatch: i === batches.length - 1, estimatedTotal: totalRows });
              ref = r.ref ?? ref;
              if (!r.ok) { ok = false; err = r.error ?? `status ${r.status}`; break; }
            }
            results.push({ target: provider.name, ok, err, ref });
          }

          // ── Withdrawal removal sync (extends PDPA-05): keep the EXTERNAL audience continuously consistent
          //    with the consent ledger. Only meaningful when at least one REAL target exists and its upload
          //    succeeded (a mock run maintains no external audience). Manifest first, then prune. ──
          const anyRealSuccess = results.some((r) => r.target !== 'mock' && r.ok);
          let removed = 0;
          let removalErr: string | null = null;
          if (anyRealSuccess && totalRows > 0) {
            const uploaded = batches.flatMap((b: any) => b.members);
            await this.crmMembers.upsertAudienceManifest(Number(tenantId), uploaded).catch(() => null);
          }
          if (anyRealSuccess) {
            const candidates = await this.crmMembers.audienceRemovalCandidates(Number(tenantId));
            if (candidates.length) {
              const removalSession = sessionId + 1; // its own adapter session (Google gets its own remove job)
              let allOk = true;
              if (targets.includes('webhook')) {
                const r = await pushHashedAudience({ tenant_id: Number(tenantId), action: 'remove', hash_alg: 'sha256', consent_basis: 'member_consents:marketing', count: candidates.length, members: wireRows(candidates) });
                if (!r.ok) { allOk = false; removalErr = r.error ?? `status ${r.status}`; }
              }
              for (const provider of providers) {
                const r = await provider.remove(wireRows(candidates), { sessionId: removalSession, batchSeq: 1, lastBatch: true, estimatedTotal: candidates.length });
                if (!r.ok) { allOk = false; removalErr = r.error ?? `status ${r.status}`; }
              }
              // stamp removed ONLY when every configured target accepted the removal — a partial removal must
              // stay a candidate next run (fail-visible, never fail-silent)
              if (allOk) { await this.crmMembers.markAudienceRemoved(Number(tenantId), candidates.map((c: any) => c.member_id)); removed = candidates.length; }
            }
          }

          for (const r of results) {
            await db.insert(audienceExports).values({
              tenantId: Number(tenantId), target: r.target, membersConsidered: considered, membersConsented: consented,
              rowsPushed: r.ok ? totalRows : 0, rowsRemoved: r.ok ? removed : 0, status: r.ok ? 'success' : 'failed', error: r.err ?? removalErr,
              ropaActivityId: Number(ropa.id), createdBy: user.username,
            }).catch(() => null);
          }
          const failed = results.filter((r) => !r.ok);
          if (failed.length) throw new BadRequestException({ code: 'AUDIENCE_PUSH_FAILED', message: `Audience push failed (${failed.map((r) => r.target).join(', ')}): ${failed[0]!.err}`, messageTh: 'ส่งกลุ่มเป้าหมายไม่สำเร็จ' });
          if (removalErr) throw new BadRequestException({ code: 'AUDIENCE_REMOVE_FAILED', message: `Audience removal failed: ${removalErr}`, messageTh: 'ถอนสมาชิกออกจากกลุ่มเป้าหมายไม่สำเร็จ' });

          return {
            data: { targets: results.map((r) => ({ target: r.target, ok: r.ok, ref: r.ref ?? null })), considered, consented, pushed: totalRows, removed, hash_alg: 'sha256', consent_basis: 'member_consents:marketing', ropa_activity_id: Number(ropa.id) },
            summary: `Audience export: ${totalRows} hashed row(s) from ${consented} consented (of ${considered} active) → ${targetLabel}${removed ? `; removed ${removed} withdrawn` : ''}; ROPA #${ropa.id}`,
            summaryTh: `ส่งกลุ่มเป้าหมายโฆษณา: ${totalRows} แถว (hash) จากสมาชิกยินยอม ${consented}/${considered} → ${targetLabel}${removed ? ` · ถอนผู้ถอนความยินยอม ${removed}` : ''} · ROPA #${ropa.id}`,
          };
        },
      },
    ];
  }
}
