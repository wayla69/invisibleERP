import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { nonConformances, defectCodes, qualityInspections } from '../../database/schema';
import { docCountersTenant } from '../../database/schema/system';
import { LedgerService } from '../ledger/ledger.service';
import { StatusLogService } from '../../common/status-log.service';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
const FINANCIAL_DISPOSITIONS = ['scrap', 'use_as_is', 'return'] as const;
const ALL_DISPOSITIONS = ['scrap', 'use_as_is', 'return', 'rework'] as const;
type Disposition = (typeof ALL_DISPOSITIONS)[number];

export interface RaiseNcrDto {
  source?: 'incoming' | 'in_process' | 'customer' | 'supplier';
  ref_type?: string;
  ref_doc?: string;
  item_id?: string;
  item_description?: string;
  defect_code?: string;
  severity?: 'minor' | 'major' | 'critical';
  qty?: number;
  unit_cost?: number;
  description?: string;
  proposed_disposition?: Disposition;
}
export interface DispositionDto { disposition?: Disposition; notes?: string }
export interface DefectCodeDto { code: string; name?: string; category?: string; active?: boolean }

// QMS-1 (QC-01) — Non-Conformance (NCR) register with maker-checker disposition. A failed inspection or a
// customer/supplier complaint is raised as an NCR. A financial disposition (scrap / use-as-is / return) is
// proposed as `pending_disposition` and applied — and any GL write-off posted (scrap → Dr 5810 / Cr the source
// inventory account, the SAME posting mfg-depth's QA scrap uses) — ONLY when a DIFFERENT user approves
// (dispositioned_by ≠ raised_by → 403 SOD_SELF_APPROVAL). Reject returns the NCR to `open`.
@Injectable()
export class NcrService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly ledger: LedgerService,
    private readonly statusLog: StatusLogService,
  ) {}

  private async nextNcrNo(tenantId: number) {
    const r = await this.db.insert(docCountersTenant)
      .values({ docType: 'NCR', tenantId, period: 'all', n: 1 })
      .onConflictDoUpdate({
        target: [docCountersTenant.docType, docCountersTenant.tenantId, docCountersTenant.period],
        set: { n: sql`${docCountersTenant.n} + 1` },
      }).returning({ n: docCountersTenant.n });
    return `NCR-${String(Number(r[0]!.n)).padStart(5, '0')}`;
  }

  // ── Defect-code lookup ──
  async listDefectCodes(user: JwtUser) {
    const rows = await this.db.select().from(defectCodes)
      .where(eq(defectCodes.tenantId, user.tenantId!)).orderBy(defectCodes.code);
    return { defect_codes: rows.map((d: any) => ({ id: Number(d.id), code: d.code, name: d.name, category: d.category, active: d.active })), count: rows.length };
  }

  async createDefectCode(dto: DefectCodeDto, user: JwtUser) {
    const tenantId = user.tenantId!;
    const code = (dto.code ?? '').trim();
    if (!code) throw new BadRequestException({ code: 'BAD_DEFECT_CODE', message: 'code is required', messageTh: 'ต้องระบุรหัสข้อบกพร่อง' });
    const [existing] = await this.db.select().from(defectCodes).where(and(eq(defectCodes.tenantId, tenantId), eq(defectCodes.code, code))).limit(1);
    if (existing) throw new BadRequestException({ code: 'DEFECT_CODE_EXISTS', message: `Defect code ${code} already exists`, messageTh: `รหัสข้อบกพร่อง ${code} มีอยู่แล้ว` });
    await this.db.insert(defectCodes).values({ tenantId, code, name: dto.name ?? null, category: dto.category ?? null, active: dto.active ?? true, createdBy: user.username });
    return this.listDefectCodes(user);
  }

  // ── Raise an NCR (a financial proposed disposition parks it pending_disposition) ──
  async raiseNcr(dto: RaiseNcrDto, user: JwtUser) {
    const tenantId = user.tenantId!;
    const qty = r2(dto.qty ?? 0);
    if (qty < 0) throw new BadRequestException({ code: 'BAD_QTY', message: 'qty cannot be negative', messageTh: 'จำนวนติดลบไม่ได้' });
    const proposed = dto.proposed_disposition;
    if (proposed && !ALL_DISPOSITIONS.includes(proposed))
      throw new BadRequestException({ code: 'BAD_DISPOSITION', message: `disposition must be one of ${ALL_DISPOSITIONS.join('/')}`, messageTh: 'การจัดการต้องเป็น scrap/use_as_is/return/rework' });
    // A financial disposition (scrap/use_as_is/return) parks the NCR pending a different approver (QC-01).
    const status = proposed && (FINANCIAL_DISPOSITIONS as readonly string[]).includes(proposed) ? 'pending_disposition' : 'open';
    const ncrNo = await this.nextNcrNo(tenantId);
    const [row] = await this.db.insert(nonConformances).values({
      tenantId, ncrNo,
      source: dto.source ?? 'in_process',
      refType: dto.ref_type ?? null, refDoc: dto.ref_doc ?? null,
      itemId: dto.item_id ?? null, itemDescription: dto.item_description ?? null,
      defectCode: dto.defect_code ?? null, severity: dto.severity ?? 'minor',
      qty: fx(qty, 3), unitCost: fx(n(dto.unit_cost), 4),
      description: dto.description ?? null, proposedDisposition: proposed ?? null,
      status, raisedBy: user.username,
    }).returning();
    await this.statusLog.log('NCR', ncrNo, '', status, user.username, `raised (${dto.source ?? 'in_process'})`);
    return this.fmt(row);
  }

  // ── Promote a failed quality_inspection into an NCR ──
  async promoteInspection(inspId: number, dto: RaiseNcrDto, user: JwtUser) {
    const [insp] = await this.db.select().from(qualityInspections).where(eq(qualityInspections.id, inspId)).limit(1);
    if (!insp) throw new NotFoundException({ code: 'INSPECTION_NOT_FOUND', message: `Inspection ${inspId} not found`, messageTh: `ไม่พบผลตรวจ ${inspId}` });
    if (n(insp.qtyFailed) <= 0) throw new BadRequestException({ code: 'INSPECTION_NOT_FAILED', message: `Inspection ${insp.inspNo} has no failed quantity to raise`, messageTh: `ผลตรวจ ${insp.inspNo} ไม่มีจำนวนที่ไม่ผ่านให้ออก NCR` });
    return this.raiseNcr({
      source: insp.refType === 'GR' ? 'incoming' : 'in_process',
      ref_type: insp.refType === 'GR' ? 'GR' : insp.refType === 'WO' ? 'WO' : 'INSP',
      ref_doc: insp.refDoc ?? insp.inspNo,
      item_id: insp.itemId ?? undefined, item_description: insp.itemDescription ?? undefined,
      defect_code: dto.defect_code, severity: dto.severity ?? 'major',
      qty: dto.qty ?? n(insp.qtyFailed),
      unit_cost: dto.unit_cost ?? n(insp.scrapValue) / (n(insp.qtyFailed) || 1),
      description: dto.description ?? `จากผลตรวจ ${insp.inspNo}`,
      proposed_disposition: dto.proposed_disposition,
    }, user);
  }

  private async assertNcr(id: number) {
    const [row] = await this.db.select().from(nonConformances).where(eq(nonConformances.id, id)).limit(1);
    if (!row) throw new NotFoundException({ code: 'NCR_NOT_FOUND', message: `NCR ${id} not found`, messageTh: `ไม่พบ NCR ${id}` });
    return row;
  }

  // ── Approve & apply the disposition (QC-01 maker-checker: approver ≠ raiser) ──
  async disposition(id: number, dto: DispositionDto, user: JwtUser) {
    const ncr = await this.assertNcr(id);
    if (ncr.status !== 'pending_disposition')
      throw new BadRequestException({ code: 'NCR_NOT_PENDING', message: `NCR ${ncr.ncrNo} is ${ncr.status}, not pending_disposition`, messageTh: `NCR ${ncr.ncrNo} ไม่ได้อยู่ในสถานะรอจัดการ` });
    if (ncr.raisedBy && ncr.raisedBy === user.username)
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: you cannot disposition an NCR you raised', messageTh: 'ผู้ออก NCR อนุมัติการจัดการเองไม่ได้ (แบ่งแยกหน้าที่)' });

    const disposition = (dto.disposition ?? ncr.proposedDisposition) as Disposition | null;
    if (!disposition || !(FINANCIAL_DISPOSITIONS as readonly string[]).includes(disposition))
      throw new BadRequestException({ code: 'BAD_DISPOSITION', message: `disposition must be one of ${FINANCIAL_DISPOSITIONS.join('/')}`, messageTh: 'การจัดการต้องเป็น scrap/use_as_is/return' });

    // Only a scrap disposition posts the inventory write-off (Dr 5810 / Cr the source inventory account —
    // the SAME posting mfg-depth's QA scrap uses: WO→1250 WIP, GR→1200 raw materials, else→1210 finished goods).
    let entryNo: string | null = null;
    let writeOff = 0;
    if (disposition === 'scrap') {
      writeOff = r2(n(ncr.qty) * n(ncr.unitCost));
      if (writeOff > 0) {
        const creditAcct = ncr.refType === 'WO' ? '1250' : ncr.refType === 'GR' ? '1200' : '1210';
        const je: any = await this.ledger.postEntry({
          source: 'QA-NCR', sourceRef: ncr.ncrNo, tenantId: ncr.tenantId ?? null,
          memo: `NCR scrap ${ncr.itemId ?? ''} ${ncr.ncrNo}`, createdBy: user.username,
          lines: [
            { account_code: '5810', debit: writeOff, memo: 'NCR scrap write-off' },
            { account_code: creditAcct, credit: writeOff, memo: `NCR scrap from ${ncr.refType ?? 'stock'}` },
          ],
        });
        entryNo = je.entry_no;
      }
    }

    const [updated] = await this.db.update(nonConformances).set({
      status: 'dispositioned', proposedDisposition: disposition,
      dispositionedBy: user.username, dispositionNotes: dto.notes ?? ncr.dispositionNotes,
      writeOffValue: fx(writeOff, 2), entryNo, decidedAt: new Date(),
    }).where(eq(nonConformances.id, id)).returning();
    await this.statusLog.log('NCR', ncr.ncrNo, ncr.status, 'dispositioned', user.username, `${disposition}${entryNo ? ` → ${entryNo}` : ''}`);
    return this.fmt(updated);
  }

  // ── Reject the proposed disposition → back to open ──
  async reject(id: number, dto: DispositionDto, user: JwtUser) {
    const ncr = await this.assertNcr(id);
    if (ncr.status !== 'pending_disposition')
      throw new BadRequestException({ code: 'NCR_NOT_PENDING', message: `NCR ${ncr.ncrNo} is ${ncr.status}, not pending_disposition`, messageTh: `NCR ${ncr.ncrNo} ไม่ได้อยู่ในสถานะรอจัดการ` });
    if (ncr.raisedBy && ncr.raisedBy === user.username)
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: you cannot reject an NCR you raised', messageTh: 'ผู้ออก NCR ปฏิเสธการจัดการเองไม่ได้ (แบ่งแยกหน้าที่)' });
    const [updated] = await this.db.update(nonConformances).set({
      status: 'open', proposedDisposition: null,
      dispositionNotes: dto.notes ?? ncr.dispositionNotes,
    }).where(eq(nonConformances.id, id)).returning();
    await this.statusLog.log('NCR', ncr.ncrNo, ncr.status, 'open', user.username, `rejected: ${dto.notes ?? ''}`.trim());
    return this.fmt(updated);
  }

  // ── Close a dispositioned NCR ──
  async close(id: number, user: JwtUser) {
    const ncr = await this.assertNcr(id);
    if (ncr.status !== 'dispositioned')
      throw new BadRequestException({ code: 'NCR_NOT_DISPOSITIONED', message: `NCR ${ncr.ncrNo} is ${ncr.status}, not dispositioned`, messageTh: `NCR ${ncr.ncrNo} ยังไม่ได้จัดการ` });
    const [updated] = await this.db.update(nonConformances).set({ status: 'closed' }).where(eq(nonConformances.id, id)).returning();
    await this.statusLog.log('NCR', ncr.ncrNo, ncr.status, 'closed', user.username);
    return this.fmt(updated);
  }

  // ── Reads ──
  async list(user: JwtUser, status?: string) {
    const conds = [eq(nonConformances.tenantId, user.tenantId!)];
    if (status) conds.push(eq(nonConformances.status, status));
    const rows = await this.db.select().from(nonConformances).where(and(...conds)).orderBy(desc(nonConformances.id)).limit(200);
    return { ncrs: rows.map((r: any) => this.fmt(r)), count: rows.length };
  }

  async get(id: number, _user: JwtUser) {
    return this.fmt(await this.assertNcr(id));
  }

  private fmt(r: any) {
    return {
      id: Number(r.id), ncr_no: r.ncrNo, source: r.source,
      ref_type: r.refType ?? null, ref_doc: r.refDoc ?? null,
      item_id: r.itemId ?? null, item_description: r.itemDescription ?? null,
      defect_code: r.defectCode ?? null, severity: r.severity,
      qty: n(r.qty), unit_cost: n(r.unitCost), description: r.description ?? null,
      proposed_disposition: r.proposedDisposition ?? null, status: r.status,
      write_off_value: n(r.writeOffValue), entry_no: r.entryNo ?? null,
      raised_by: r.raisedBy ?? null, dispositioned_by: r.dispositionedBy ?? null,
      disposition_notes: r.dispositionNotes ?? null,
      created_at: r.createdAt, decided_at: r.decidedAt ?? null,
    };
  }
}
