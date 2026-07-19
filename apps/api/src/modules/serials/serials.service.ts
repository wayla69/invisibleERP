import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq, and, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { itemSerials } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// docs/52 Phase 3b — serial/IMEI unit tracking. A serial-tracked item (electronics) is sold as a SPECIFIC
// physical unit: the exact serial/IMEI moves InStock → Sold, stamped with the sale, so warranty / returns /
// theft-recovery key on it. Distinct business responsibility from lot/batch tracking → its own service
// (bounded context), tenant-scoped (`item_serials`, RLS).
@Injectable()
export class SerialsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Register serial/IMEI units into stock (InStock). Idempotent per (tenant,item,serial) — a duplicate is
  // skipped (already registered), not an error. Returns how many were newly added.
  async addSerials(itemId: string, serialNos: string[], user: JwtUser) {
    const tenantId = user.tenantId as number;
    const clean = [...new Set((serialNos ?? []).map((s) => String(s).trim()).filter(Boolean))];
    if (!clean.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No serials supplied', messageTh: 'ไม่มีหมายเลขซีเรียล' });
    const inserted = await this.db.insert(itemSerials)
      .values(clean.map((serialNo) => ({ tenantId, itemId, serialNo, status: 'InStock', createdBy: user.username })))
      .onConflictDoNothing().returning({ id: itemSerials.id });
    return { item_id: itemId, requested: clean.length, added: inserted.length };
  }

  async listSerials(itemId: string, status: string | undefined, _user: JwtUser) {
    const conds = [eq(itemSerials.itemId, itemId)];
    if (status) conds.push(eq(itemSerials.status, status));
    const rows = await this.db.select().from(itemSerials).where(and(...conds)).orderBy(itemSerials.serialNo);
    return { item_id: itemId, count: rows.length, serials: rows.map((r: any) => ({ serial_no: r.serialNo, status: r.status, sale_no: r.saleNo, sold_at: r.soldAt })) };
  }

  // docs/52 Phase 3b — consume the exact serial(s) for a POS sale line (transaction-aware). The count must
  // equal the line qty and each serial must be InStock for this tenant+item; they are marked Sold + stamped
  // with the sale. Fail-closed — SERIAL_REQUIRED / SERIAL_COUNT_MISMATCH / SERIAL_NOT_FOUND / SERIAL_NOT_AVAILABLE.
  async consumeForSale(tx: any, p: { tenantId: number; itemId: string; serialNos: string[]; qty: number; saleNo: string; createdBy: string }): Promise<string[]> {
    const db = tx ?? this.db;
    const serials = [...new Set((p.serialNos ?? []).map((s) => String(s).trim()).filter(Boolean))];
    if (!serials.length) throw new BadRequestException({ code: 'SERIAL_REQUIRED', message: `Item ${p.itemId} requires a serial/IMEI per unit`, messageTh: `สินค้า ${p.itemId} ต้องระบุซีเรียลทุกหน่วย` });
    if (serials.length !== p.qty) throw new BadRequestException({ code: 'SERIAL_COUNT_MISMATCH', message: `Expected ${p.qty} serial(s) for ${p.itemId}, got ${serials.length}`, messageTh: `ต้องระบุซีเรียล ${p.qty} หมายเลข (ได้ ${serials.length})` });
    const rows = await db.select().from(itemSerials)
      .where(and(eq(itemSerials.tenantId, p.tenantId), eq(itemSerials.itemId, p.itemId), inArray(itemSerials.serialNo, serials)));
    const byNo = new Map(rows.map((r: any) => [String(r.serialNo), r]));
    for (const sn of serials) {
      const r: any = byNo.get(sn);
      if (!r) throw new BadRequestException({ code: 'SERIAL_NOT_FOUND', message: `Serial ${sn} not found for ${p.itemId}`, messageTh: `ไม่พบซีเรียล ${sn} ของสินค้านี้` });
      if (r.status !== 'InStock') throw new BadRequestException({ code: 'SERIAL_NOT_AVAILABLE', message: `Serial ${sn} is ${r.status}, not available`, messageTh: `ซีเรียล ${sn} ไม่พร้อมขาย (${r.status})` });
    }
    const now = new Date();
    for (const sn of serials) {
      await db.update(itemSerials).set({ status: 'Sold', saleNo: p.saleNo, soldAt: now })
        .where(and(eq(itemSerials.tenantId, p.tenantId), eq(itemSerials.itemId, p.itemId), eq(itemSerials.serialNo, sn), eq(itemSerials.status, 'InStock')));
    }
    return serials;
  }
}
