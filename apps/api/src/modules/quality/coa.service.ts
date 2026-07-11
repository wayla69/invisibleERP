import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { qualitySpecs, coaCertificates, coaResults } from '../../database/schema/quality-coa';
import { docCountersTenant } from '../../database/schema/system';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const round4 = (x: unknown) => Math.round((Number(x) || 0) * 10000) / 10000;

// QMS-3 — Certificate of Analysis (CoA) capture + out-of-spec release approval (QC-03). CoA attaches to a lot
// (text lot_no ref — the read-only lot_ledger is NOT rewritten). On evaluate, overall_result = fail if any
// characteristic's actual is outside its [min,max]. A pass CoA can be released by its recorder; a FAIL
// (out-of-spec) CoA can be released ONLY by a DIFFERENT user (released_by ≠ created_by → SOD_SELF_APPROVAL)
// WITH a mandatory deviation_reason (DEVIATION_REASON_REQUIRED) — the documented deviation approval.
@Injectable()
export class CoaService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private async nextNo(tenantId: number, docType: string, prefix: string) {
    const r = await this.db.insert(docCountersTenant)
      .values({ docType, tenantId, period: 'all', n: 1 })
      .onConflictDoUpdate({
        target: [docCountersTenant.docType, docCountersTenant.tenantId, docCountersTenant.period],
        set: { n: sql`${docCountersTenant.n} + 1` },
      }).returning({ n: docCountersTenant.n });
    return `${prefix}-${String(Number(r[0]!.n)).padStart(5, '0')}`;
  }

  // ── Quality specs (per-item acceptable range for a characteristic) ──
  async createSpec(dto: { item_id: string; characteristic: string; uom?: string; min_value?: number; max_value?: number; target_value?: number; active?: boolean }, user: JwtUser) {
    const tenantId = user.tenantId!;
    if (!dto.item_id || !dto.characteristic)
      throw new BadRequestException({ code: 'SPEC_INCOMPLETE', message: 'item_id and characteristic are required', messageTh: 'ต้องระบุรหัสสินค้าและคุณลักษณะที่ตรวจวัด' });
    const min = dto.min_value != null ? round4(dto.min_value) : null;
    const max = dto.max_value != null ? round4(dto.max_value) : null;
    if (min != null && max != null && min > max)
      throw new BadRequestException({ code: 'SPEC_RANGE_INVALID', message: 'min_value cannot exceed max_value', messageTh: 'ค่าต่ำสุดต้องไม่มากกว่าค่าสูงสุด' });
    const specNo = await this.nextNo(tenantId, 'QSPEC', 'QSPEC');
    const [row] = await this.db.insert(qualitySpecs).values({
      tenantId, specNo, itemId: dto.item_id, characteristic: dto.characteristic, uom: dto.uom ?? null,
      minValue: min != null ? fx(min, 4) : null, maxValue: max != null ? fx(max, 4) : null,
      targetValue: dto.target_value != null ? fx(round4(dto.target_value), 4) : null,
      active: dto.active ?? true, createdBy: user.username,
    }).returning();
    return this.fmtSpec(row!);
  }

  async listSpecs(user: JwtUser, itemId?: string) {
    const conds = [eq(qualitySpecs.tenantId, user.tenantId!)];
    if (itemId) conds.push(eq(qualitySpecs.itemId, itemId));
    const rows = await this.db.select().from(qualitySpecs).where(and(...conds)).orderBy(sql`${qualitySpecs.id} DESC`);
    return { specs: rows.map((r: any) => this.fmtSpec(r)), count: rows.length };
  }

  // ── CoA lifecycle ──
  async createCoa(dto: { lot_no: string; item_id: string; source?: 'incoming' | 'production' }, user: JwtUser) {
    const tenantId = user.tenantId!;
    if (!dto.lot_no || !dto.item_id)
      throw new BadRequestException({ code: 'COA_INCOMPLETE', message: 'lot_no and item_id are required', messageTh: 'ต้องระบุเลขล็อตและรหัสสินค้า' });
    const source = dto.source ?? 'incoming';
    if (!['incoming', 'production'].includes(source))
      throw new BadRequestException({ code: 'SOURCE_INVALID', message: 'source must be incoming or production', messageTh: 'แหล่งที่มาต้องเป็น incoming หรือ production' });
    const coaNo = await this.nextNo(tenantId, 'COA', 'COA');
    const [row] = await this.db.insert(coaCertificates).values({
      tenantId, coaNo, lotNo: dto.lot_no, itemId: dto.item_id, source,
      overallResult: 'pending', released: false, releaseStatus: 'held', createdBy: user.username,
    }).returning();
    return this.fmtCoa(row!);
  }

  private async assertCoa(id: number, tenantId: number) {
    const [c] = await this.db.select().from(coaCertificates)
      .where(and(eq(coaCertificates.id, id), eq(coaCertificates.tenantId, tenantId))).limit(1);
    if (!c) throw new NotFoundException({ code: 'COA_NOT_FOUND', message: `CoA ${id} not found`, messageTh: `ไม่พบใบรับรองผลวิเคราะห์ ${id}` });
    return c;
  }

  // Add measured results (each row's pass/fail computed vs its [spec_min, spec_max] window).
  async addResults(id: number, dto: { results: { characteristic: string; uom?: string; spec_min?: number; spec_max?: number; actual_value: number }[] }, user: JwtUser) {
    const tenantId = user.tenantId!;
    const coa = await this.assertCoa(id, tenantId);
    if (coa.releaseStatus !== 'held')
      throw new BadRequestException({ code: 'COA_NOT_HELD', message: `CoA ${coa.coaNo} is ${coa.releaseStatus}; results are locked`, messageTh: `ใบรับรอง ${coa.coaNo} อยู่ในสถานะ ${coa.releaseStatus} แก้ไขผลไม่ได้` });
    const rows = dto.results ?? [];
    if (!rows.length)
      throw new BadRequestException({ code: 'RESULTS_REQUIRED', message: 'at least one measured result is required', messageTh: 'ต้องระบุผลการตรวจวัดอย่างน้อยหนึ่งรายการ' });
    const inserted = [];
    for (const r of rows) {
      const min = r.spec_min != null ? round4(r.spec_min) : null;
      const max = r.spec_max != null ? round4(r.spec_max) : null;
      const actual = round4(r.actual_value);
      const outOfSpec = (min != null && actual < min) || (max != null && actual > max);
      const [ins] = await this.db.insert(coaResults).values({
        tenantId, coaId: id, characteristic: r.characteristic, uom: r.uom ?? null,
        specMin: min != null ? fx(min, 4) : null, specMax: max != null ? fx(max, 4) : null,
        actualValue: fx(actual, 4), result: outOfSpec ? 'fail' : 'pass',
      }).returning();
      inserted.push(this.fmtResult(ins!));
    }
    return { coa_no: coa.coaNo, results: inserted, count: inserted.length };
  }

  // Evaluate — overall_result = fail if ANY characteristic is out of spec, else pass. Requires results.
  async evaluate(id: number, user: JwtUser) {
    const tenantId = user.tenantId!;
    const coa = await this.assertCoa(id, tenantId);
    if (coa.releaseStatus !== 'held')
      throw new BadRequestException({ code: 'COA_NOT_HELD', message: `CoA ${coa.coaNo} is ${coa.releaseStatus}; cannot re-evaluate`, messageTh: `ใบรับรอง ${coa.coaNo} อยู่ในสถานะ ${coa.releaseStatus} ประเมินซ้ำไม่ได้` });
    const results = await this.db.select().from(coaResults).where(eq(coaResults.coaId, id));
    if (!results.length)
      throw new BadRequestException({ code: 'RESULTS_REQUIRED', message: 'record measured results before evaluating', messageTh: 'ต้องบันทึกผลการตรวจวัดก่อนประเมิน' });
    const failed = results.filter((r: any) => r.result === 'fail');
    const overall = failed.length ? 'fail' : 'pass';
    const [updated] = await this.db.update(coaCertificates)
      .set({ overallResult: overall })
      .where(eq(coaCertificates.id, id)).returning();
    return { ...this.fmtCoa(updated!), failed_count: failed.length, out_of_spec: overall === 'fail' };
  }

  // Release — QC-03 gate. A pass CoA can be released by its recorder. A FAIL (out-of-spec) CoA can be released
  // ONLY by a DIFFERENT user (SOD_SELF_APPROVAL) WITH a mandatory deviation_reason (DEVIATION_REASON_REQUIRED).
  async release(id: number, dto: { deviation_reason?: string }, user: JwtUser) {
    const tenantId = user.tenantId!;
    const coa = await this.assertCoa(id, tenantId);
    if (coa.releaseStatus !== 'held')
      throw new BadRequestException({ code: 'COA_NOT_HELD', message: `CoA ${coa.coaNo} is already ${coa.releaseStatus}`, messageTh: `ใบรับรอง ${coa.coaNo} ถูก ${coa.releaseStatus} ไปแล้ว` });
    if (coa.overallResult === 'pending')
      throw new BadRequestException({ code: 'COA_NOT_EVALUATED', message: `CoA ${coa.coaNo} must be evaluated before release`, messageTh: `ต้องประเมินใบรับรอง ${coa.coaNo} ก่อนปล่อยล็อต` });

    const outOfSpec = coa.overallResult === 'fail';
    let deviationReason: string | null = null;
    if (outOfSpec) {
      // QC-03 deviation approval: the deviation approver duty (quality_approve/exec), recorder ≠ release
      // approver, and a mandatory documented reason. A plain `quality` recorder cannot release a fail.
      const perms = user.permissions ?? [];
      if (!perms.includes('quality_approve') && !perms.includes('exec'))
        throw new ForbiddenException({ code: 'DEVIATION_APPROVER_REQUIRED', message: 'releasing an out-of-spec lot requires the quality-approver duty (quality_approve/exec)', messageTh: 'การปล่อยล็อตที่ไม่ผ่านสเปกต้องมีสิทธิ์ผู้อนุมัติการเบี่ยงเบน (quality_approve/exec)' });
      if (coa.createdBy && coa.createdBy === user.username)
        throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: an out-of-spec lot must be released by a different user than the CoA recorder', messageTh: 'แบ่งแยกหน้าที่: ล็อตที่ไม่ผ่านสเปกต้องปล่อยโดยผู้ใช้ที่ต่างจากผู้บันทึกใบรับรอง' });
      deviationReason = (dto.deviation_reason ?? '').trim();
      if (!deviationReason)
        throw new BadRequestException({ code: 'DEVIATION_REASON_REQUIRED', message: 'a deviation_reason is required to release an out-of-spec lot', messageTh: 'ต้องระบุเหตุผลการเบี่ยงเบนเพื่อปล่อยล็อตที่ไม่ผ่านสเปก' });
    }

    const [updated] = await this.db.update(coaCertificates)
      .set({ released: true, releaseStatus: 'released', releasedBy: user.username, deviationReason, decidedAt: new Date() })
      .where(eq(coaCertificates.id, id)).returning();
    return { ...this.fmtCoa(updated!), deviation_release: outOfSpec };
  }

  // Reject — hold the lot as rejected (never released). Available regardless of pass/fail.
  async reject(id: number, dto: { reason?: string }, user: JwtUser) {
    const tenantId = user.tenantId!;
    const coa = await this.assertCoa(id, tenantId);
    if (coa.releaseStatus !== 'held')
      throw new BadRequestException({ code: 'COA_NOT_HELD', message: `CoA ${coa.coaNo} is already ${coa.releaseStatus}`, messageTh: `ใบรับรอง ${coa.coaNo} ถูก ${coa.releaseStatus} ไปแล้ว` });
    const [updated] = await this.db.update(coaCertificates)
      .set({ released: false, releaseStatus: 'rejected', releasedBy: user.username, deviationReason: dto.reason ?? coa.deviationReason ?? null, decidedAt: new Date() })
      .where(eq(coaCertificates.id, id)).returning();
    return { ...this.fmtCoa(updated!), rejected: true };
  }

  // ── Reads ──
  async listCoa(user: JwtUser, filter?: { release_status?: string; overall_result?: string }) {
    const conds = [eq(coaCertificates.tenantId, user.tenantId!)];
    if (filter?.release_status) conds.push(eq(coaCertificates.releaseStatus, filter.release_status));
    if (filter?.overall_result) conds.push(eq(coaCertificates.overallResult, filter.overall_result));
    const rows = await this.db.select().from(coaCertificates).where(and(...conds)).orderBy(sql`${coaCertificates.id} DESC`);
    return { coa: rows.map((r: any) => this.fmtCoa(r)), count: rows.length };
  }

  async getCoa(id: number, user: JwtUser) {
    const coa = await this.assertCoa(id, user.tenantId!);
    const results = await this.db.select().from(coaResults).where(eq(coaResults.coaId, id)).orderBy(coaResults.id);
    return { ...this.fmtCoa(coa), results: results.map((r: any) => this.fmtResult(r)) };
  }

  // Detective (QC-03): the deviation register — CoAs that FAILED spec yet were released. The audit sample.
  async outOfSpecRegister(user: JwtUser) {
    const rows = await this.db.select().from(coaCertificates)
      .where(and(
        eq(coaCertificates.tenantId, user.tenantId!),
        eq(coaCertificates.overallResult, 'fail'),
        eq(coaCertificates.releaseStatus, 'released'),
      )).orderBy(sql`${coaCertificates.id} DESC`);
    return { deviations: rows.map((r: any) => this.fmtCoa(r)), count: rows.length };
  }

  private fmtSpec(r: any) {
    return { id: Number(r.id), spec_no: r.specNo, item_id: r.itemId, characteristic: r.characteristic, uom: r.uom ?? null, min_value: r.minValue != null ? n(r.minValue) : null, max_value: r.maxValue != null ? n(r.maxValue) : null, target_value: r.targetValue != null ? n(r.targetValue) : null, active: r.active, created_by: r.createdBy ?? null };
  }
  private fmtCoa(r: any) {
    return { id: Number(r.id), coa_no: r.coaNo, lot_no: r.lotNo, item_id: r.itemId, source: r.source, overall_result: r.overallResult, released: r.released, release_status: r.releaseStatus, released_by: r.releasedBy ?? null, deviation_reason: r.deviationReason ?? null, created_by: r.createdBy ?? null };
  }
  private fmtResult(r: any) {
    return { id: Number(r.id), characteristic: r.characteristic, uom: r.uom ?? null, spec_min: r.specMin != null ? n(r.specMin) : null, spec_max: r.specMax != null ? n(r.specMax) : null, actual_value: r.actualValue != null ? n(r.actualValue) : null, result: r.result };
  }
}
