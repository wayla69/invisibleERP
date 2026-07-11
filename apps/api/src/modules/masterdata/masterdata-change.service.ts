import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { and, eq, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { masterdataChangeRequests, vendors } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import type { JwtUser } from '../../common/decorators';

// ── GRC-3 — Sensitive master-data single-record maker-checker (control MDM-01) ──
// A change to a SENSITIVE master-data field (esp. a vendor's payee bank details, its credit limit, or its
// payment terms) is NOT written to the master directly: it is STAGED as a `pending` masterdata_change_requests
// row and applied to the entity ONLY when a DISTINCT user approves it (approved_by ≠ requested_by → 403
// SOD_SELF_APPROVAL, binds even Admin). Reject discards it; the master is untouched. Non-sensitive fields keep
// their existing direct-edit paths (this service refuses them → FIELD_NOT_SENSITIVE, pointing back there).
//
// Generic by design. The registry below is the single source of truth for which (entity, field) pairs are
// sensitive and how each maps to a real column. Vendor is wired today; customer/item are schema-supported
// (entity_type enum) for future extension — a new entry here is all that is needed.

type FieldSpec = { column: string; numeric?: boolean; label: string };
type EntitySpec = { table: any; label: string; fields: Record<string, FieldSpec> };

const REGISTRY: Record<string, EntitySpec> = {
  vendor: {
    table: vendors,
    label: 'Vendor',
    fields: {
      // Payment-redirection-sensitive (BEC / disbursement fraud). bank_name/bank_account ALSO have the
      // dedicated 0270 vendor-bank flow; here they are governed generically alongside the account-holder name.
      bank_account: { column: 'bankAccount', label: 'Bank account no.' },
      bank_name: { column: 'bankName', label: 'Bank name' },
      bank_account_name: { column: 'bankAccountName', label: 'Bank account name' },
      // Credit / terms authority — a change that alters exposure or the payment schedule.
      credit_limit: { column: 'creditLimit', numeric: true, label: 'Credit limit' },
      payment_terms: { column: 'paymentTerms', label: 'Payment terms' },
    },
  },
};

@Injectable()
export class MasterdataChangeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
  ) {}

  private specOrThrow(entityType: string, field: string) {
    const ent = REGISTRY[entityType];
    if (!ent) throw new BadRequestException({ code: 'UNKNOWN_ENTITY', message: `Unknown entity type '${entityType}'`, messageTh: 'ไม่รู้จักประเภทข้อมูลหลักนี้' });
    const fs = ent.fields[field];
    if (!fs) throw new BadRequestException({ code: 'FIELD_NOT_SENSITIVE', message: `Field '${field}' is not a maker-checked sensitive field for ${entityType} — use its direct-edit endpoint`, messageTh: 'ฟิลด์นี้ไม่ใช่ฟิลด์ที่ต้องอนุมัติ ใช้ช่องทางแก้ไขปกติ' });
    return { ent, fs };
  }

  private async entityRow(ent: EntitySpec, entityId: number): Promise<Record<string, unknown>> {
    const [row] = await this.db.select().from(ent.table).where(eq(ent.table.id, entityId)).limit(1);
    if (!row) throw new NotFoundException({ code: 'ENTITY_NOT_FOUND', message: `${ent.label} ${entityId} not found`, messageTh: `ไม่พบข้อมูล${ent.label}` });
    return row as Record<string, unknown>;
  }

  private normalizeValue(fs: FieldSpec, raw: unknown): string {
    const s = raw == null ? '' : String(raw).trim();
    if (fs.numeric) {
      if (s === '') return '';
      if (!Number.isFinite(Number(s))) throw new BadRequestException({ code: 'BAD_NUMBER', message: `'${fs.label}' must be a number`, messageTh: 'ต้องเป็นตัวเลข' });
    }
    return s;
  }

  // ── Maker: stage a sensitive-field change (NO write to the master) ──
  async stageChange(dto: { entity_type: string; entity_id: number; field: string; new_value?: unknown; reason?: string }, user: JwtUser) {
    const { ent, fs } = this.specOrThrow(dto.entity_type, dto.field);
    const row = await this.entityRow(ent, dto.entity_id);
    const oldValue = row[fs.column] ?? null;
    const newValue = this.normalizeValue(fs, dto.new_value);
    if (String(oldValue ?? '') === newValue) {
      throw new BadRequestException({ code: 'NO_CHANGE', message: 'The requested value equals the current value', messageTh: 'ค่าที่ขอเปลี่ยนเท่ากับค่าเดิม' });
    }
    // Supersede any earlier still-pending request for the SAME (entity, field) so the queue holds the latest.
    await this.db.update(masterdataChangeRequests).set({ status: 'superseded' })
      .where(and(
        eq(masterdataChangeRequests.entityType, dto.entity_type),
        eq(masterdataChangeRequests.entityId, dto.entity_id),
        eq(masterdataChangeRequests.field, dto.field),
        eq(masterdataChangeRequests.status, 'pending'),
      ));
    const reqNo = await this.docNo.nextDaily('MDC');
    await this.db.insert(masterdataChangeRequests).values({
      tenantId: (row.tenantId as number | null | undefined) ?? user.tenantId ?? null,
      reqNo, entityType: dto.entity_type, entityId: dto.entity_id, field: dto.field,
      oldValue: oldValue == null ? null : String(oldValue), newValue: newValue || null,
      status: 'pending', reason: dto.reason ?? null, requestedBy: user.username,
    });
    return { req_no: reqNo, entity_type: dto.entity_type, entity_id: dto.entity_id, field: dto.field, status: 'pending' as const };
  }

  // ── The pending queue (reviewer worklist) ──
  async listPending(status?: string) {
    const rows = await this.db.select().from(masterdataChangeRequests)
      .where(eq(masterdataChangeRequests.status, status || 'pending'))
      .orderBy(desc(masterdataChangeRequests.id)).limit(200);
    return {
      requests: rows.map((r: any) => {
        const label = REGISTRY[r.entityType]?.fields[r.field]?.label ?? r.field;
        return {
          req_no: r.reqNo, entity_type: r.entityType, entity_id: Number(r.entityId), field: r.field, field_label: label,
          old_value: r.oldValue, new_value: r.newValue, status: r.status, reason: r.reason,
          requested_by: r.requestedBy, requested_at: r.requestedAt, approved_by: r.approvedBy, approved_at: r.approvedAt, reject_reason: r.rejectReason,
        };
      }),
      count: rows.length,
    };
  }

  private async pendingByNo(reqNo: string) {
    const [r] = await this.db.select().from(masterdataChangeRequests)
      .where(and(eq(masterdataChangeRequests.reqNo, reqNo), eq(masterdataChangeRequests.status, 'pending'))).limit(1);
    if (!r) throw new NotFoundException({ code: 'NOT_PENDING', message: `No master-data change pending approval for ${reqNo}`, messageTh: 'ไม่พบคำขอเปลี่ยนข้อมูลหลักที่รออนุมัติ' });
    return r;
  }

  // ── Checker: a DISTINCT user applies the staged change to the master ──
  async approve(reqNo: string, approver: JwtUser) {
    const r = await this.pendingByNo(reqNo);
    if (r.requestedBy && r.requestedBy === approver.username) {
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: you cannot approve a master-data change you requested', messageTh: 'ผู้ขอไม่สามารถอนุมัติคำขอของตนเองได้ (แบ่งแยกหน้าที่)' });
    }
    const { ent, fs } = this.specOrThrow(r.entityType, r.field);
    // Apply to the entity — the DB trigger trg_dcl_<table> (0116/0274) captures the before/after field-level
    // audit on the master row itself; this row records the full staging trail (who requested / who released).
    const value = fs.numeric ? (r.newValue == null || r.newValue === '' ? null : String(r.newValue)) : (r.newValue ?? null);
    await this.db.update(ent.table).set({ [fs.column]: value }).where(eq(ent.table.id, Number(r.entityId)));
    await this.db.update(masterdataChangeRequests).set({ status: 'approved', approvedBy: approver.username, approvedAt: new Date() }).where(eq(masterdataChangeRequests.id, Number(r.id)));
    return { req_no: reqNo, status: 'approved' as const, approved_by: approver.username, requested_by: r.requestedBy, entity_type: r.entityType, entity_id: Number(r.entityId), field: r.field };
  }

  // ── Checker: reject (discard) — the master is never touched ──
  async reject(reqNo: string, approver: JwtUser, reason?: string) {
    const r = await this.pendingByNo(reqNo);
    if (r.requestedBy && r.requestedBy === approver.username) {
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: you cannot reject a master-data change you requested', messageTh: 'ผู้ขอไม่สามารถปฏิเสธคำขอของตนเองได้ (แบ่งแยกหน้าที่)' });
    }
    await this.db.update(masterdataChangeRequests).set({ status: 'rejected', approvedBy: approver.username, approvedAt: new Date(), rejectReason: reason ?? null }).where(eq(masterdataChangeRequests.id, Number(r.id)));
    return { req_no: reqNo, status: 'rejected' as const, rejected_by: approver.username };
  }
}
