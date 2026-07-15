import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, desc, eq, lte } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { scheduledMasterChanges, items, tenants } from '../../database/schema';
import { bizYmdDash } from '../../common/bizdate';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';

// Date-effective (future-dated) master-data changes (master-data audit Phase 12). A steward schedules a change
// to a supported master field to take effect on a future business date; the idempotent daily job applyDue
// (BI scheduler action `apply_scheduled_master_changes`) writes it onto the master once the date arrives.
//
// Supported entity:field targets and how each is applied. A SENSITIVE (fraud-relevant) field is staged for a
// second approver before it is even eligible to apply — a future-dated credit-limit bump cannot bypass the
// maker-checker (audit G7 / SoD R09). Extend this registry to cover more fields; the mechanism is generic.
const SUPPORTED = new Set(['item:unit_price', 'item:status', 'customer:credit_limit']);
const SENSITIVE = new Set(['customer:credit_limit']);

export interface ScheduleDto { entity: string; entity_key: string; field: string; new_value: string; effective_date: string; note?: string }

@Injectable()
export class ScheduledChangesService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async schedule(dto: ScheduleDto, user: JwtUser) {
    const key = `${dto.entity}:${dto.field}`;
    if (!SUPPORTED.has(key)) throw new BadRequestException({ code: 'UNSUPPORTED_FIELD', message: `Scheduling is not supported for ${key}`, messageTh: 'ยังไม่รองรับการตั้งเวลาสำหรับฟิลด์นี้' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dto.effective_date)) throw new BadRequestException({ code: 'BAD_DATE', message: 'effective_date must be YYYY-MM-DD', messageTh: 'รูปแบบวันที่ไม่ถูกต้อง (YYYY-MM-DD)' });
    await this.assertTargetExists(dto.entity, dto.entity_key, user);
    const sensitive = SENSITIVE.has(key);
    const [row] = await this.db.insert(scheduledMasterChanges).values({
      tenantId: user.tenantId ?? null, entity: dto.entity, entityKey: dto.entity_key, field: dto.field,
      newValue: String(dto.new_value), effectiveDate: dto.effective_date, sensitive,
      status: sensitive ? 'pending_approval' : 'scheduled', requestedBy: user.username, note: dto.note ?? null,
    }).returning();
    return shape(row);
  }

  // A sensitive scheduled change is released by a DIFFERENT user (maker ≠ checker) — only then does it become
  // eligible for the daily apply. Self-approval → 403 SOD_VIOLATION.
  async approve(id: number, user: JwtUser, selfApprovalReason?: string | null) {
    const [row] = await this.db.select().from(scheduledMasterChanges).where(and(eq(scheduledMasterChanges.id, id), eq(scheduledMasterChanges.status, 'pending_approval'))).limit(1);
    if (!row) throw new NotFoundException({ code: 'NOT_PENDING', message: 'No scheduled change pending approval', messageTh: 'ไม่มีคำขอที่รออนุมัติ' });
    await assertMakerChecker(this.db, { user, maker: row.requestedBy, event: 'md.scheduled-change.approve', ref: String(id), reason: selfApprovalReason, code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve a change you scheduled', messageTh: 'ผู้ขอตั้งเวลาอนุมัติเองไม่ได้ (แบ่งแยกหน้าที่)' });
    const [up] = await this.db.update(scheduledMasterChanges).set({ status: 'scheduled', approvedBy: user.username }).where(eq(scheduledMasterChanges.id, id)).returning();
    return shape(up);
  }

  async cancel(id: number, _user: JwtUser) {
    const del = await this.db.update(scheduledMasterChanges).set({ status: 'cancelled' })
      .where(and(eq(scheduledMasterChanges.id, id), eq(scheduledMasterChanges.status, 'scheduled'))).returning({ id: scheduledMasterChanges.id });
    if (!del.length) {
      const alt = await this.db.update(scheduledMasterChanges).set({ status: 'cancelled' })
        .where(and(eq(scheduledMasterChanges.id, id), eq(scheduledMasterChanges.status, 'pending_approval'))).returning({ id: scheduledMasterChanges.id });
      if (!alt.length) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No open scheduled change with that id', messageTh: 'ไม่พบรายการตั้งเวลาที่เปิดอยู่' });
    }
    return { cancelled: true };
  }

  async list(status: string | undefined, _user: JwtUser) {
    const base = this.db.select().from(scheduledMasterChanges);
    const filtered = status ? base.where(eq(scheduledMasterChanges.status, status)) : base;
    const rows = await filtered.orderBy(desc(scheduledMasterChanges.id)).limit(500);
    return { changes: rows.map(shape), count: rows.length };
  }

  // Idempotent daily apply: write every `scheduled` change whose effective date has arrived onto its master,
  // then mark it `applied`. Re-running the same day advances nothing (applied rows are no longer `scheduled`).
  // Runs in the caller's tenant/RLS context (the BI scheduler action or a manual run-due).
  async applyDue(user: JwtUser) {
    const asOf = bizYmdDash();
    const due = await this.db.select().from(scheduledMasterChanges)
      .where(and(eq(scheduledMasterChanges.status, 'scheduled'), lte(scheduledMasterChanges.effectiveDate, asOf)));
    let applied = 0;
    for (const row of due) {
      await this.applyOne(row);
      await this.db.update(scheduledMasterChanges).set({ status: 'applied', appliedAt: new Date() }).where(eq(scheduledMasterChanges.id, Number(row.id)));
      applied++;
    }
    return { applied, scanned: due.length, as_of: asOf };
  }

  private async assertTargetExists(entity: string, entityKey: string, _user: JwtUser) {
    if (entity === 'item') {
      const [it] = await this.db.select({ id: items.id }).from(items).where(eq(items.itemId, entityKey)).limit(1);
      if (!it) throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: `Item ${entityKey} not found`, messageTh: 'ไม่พบสินค้า' });
    } else if (entity === 'customer') {
      const [t] = await this.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, entityKey)).limit(1);
      if (!t) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: `Customer ${entityKey} not found`, messageTh: 'ไม่พบลูกค้า' });
    }
  }

  private async applyOne(row: typeof scheduledMasterChanges.$inferSelect) {
    const key = `${row.entity}:${row.field}`;
    if (key === 'item:unit_price') {
      await this.db.update(items).set({ unitPrice: String(row.newValue) }).where(eq(items.itemId, row.entityKey));
    } else if (key === 'item:status') {
      await this.db.update(items).set({ status: row.newValue }).where(eq(items.itemId, row.entityKey));
    } else if (key === 'customer:credit_limit') {
      await this.db.update(tenants).set({ creditLimit: String(row.newValue) }).where(eq(tenants.code, row.entityKey));
    }
  }
}

function shape(r: any) {
  return {
    id: Number(r.id), entity: r.entity, entity_key: r.entityKey, field: r.field, new_value: r.newValue,
    effective_date: r.effectiveDate, status: r.status, sensitive: r.sensitive === true,
    requested_by: r.requestedBy, approved_by: r.approvedBy, note: r.note ?? null, applied_at: r.appliedAt ?? null,
  };
}
