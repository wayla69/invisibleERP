import { Inject, Injectable } from '@nestjs/common';
import { eq, and, desc, asc, sql, gt } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { lotLedger } from '../../database/schema';
import { n, ymd } from '../../database/queries';

const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

// Read-only lot/batch views over lot_ledger (written by GR/WMS): ledger inquiry, expiry buckets, FEFO.
@Injectable()
export class LotsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async ledger(q: { item_id?: string; location?: string; status?: string; limit?: number }) {
    const db = this.db;
    const conds: any[] = [];
    if (q.item_id) conds.push(eq(lotLedger.itemId, q.item_id));
    if (q.location) conds.push(eq(lotLedger.locationId, q.location));
    if (q.status) conds.push(eq(lotLedger.status, q.status as any));
    const rows = await db.select().from(lotLedger).where(conds.length ? and(...conds) : undefined).orderBy(desc(lotLedger.id)).limit(q.limit ?? 200);
    return { lots: rows.map(shape), count: rows.length };
  }

  async expiry() {
    const db = this.db;
    const today = ymd();
    const rows = await db.select().from(lotLedger).where(and(sql`${lotLedger.expiryDate} is not null`, gt(lotLedger.balance, sql`0`))).orderBy(asc(lotLedger.expiryDate));
    const buckets = { expired: [] as any[], d0_7: [] as any[], d8_30: [] as any[], d31_plus: [] as any[] };
    for (const r of rows) {
      const days = daysBetween(today, String(r.expiryDate));
      const o = { ...shape(r), days_to_expiry: days };
      if (days < 0) buckets.expired.push(o);
      else if (days <= 7) buckets.d0_7.push(o);
      else if (days <= 30) buckets.d8_30.push(o);
      else buckets.d31_plus.push(o);
    }
    return {
      summary: { expired: buckets.expired.length, d0_7: buckets.d0_7.length, d8_30: buckets.d8_30.length, d31_plus: buckets.d31_plus.length },
      buckets,
    };
  }

  // First-Expired-First-Out pick suggestion: active lots with balance, soonest expiry first.
  async fefo(itemId: string) {
    const db = this.db;
    const rows = await db.select().from(lotLedger)
      .where(and(eq(lotLedger.itemId, itemId), eq(lotLedger.status, 'Active' as any), gt(lotLedger.balance, sql`0`)))
      .orderBy(asc(lotLedger.expiryDate));
    return { item_id: itemId, lots: rows.map(shape), count: rows.length, total_balance: rows.reduce((a: number, r: any) => a + n(r.balance), 0) };
  }
}

function shape(r: any) {
  return { lot_no: r.lotNo, item_id: r.itemId, item_description: r.itemDescription, uom: r.uom, location_id: r.locationId, gr_no: r.grNo, qty_in: n(r.qtyIn), qty_out: n(r.qtyOut), balance: n(r.balance), expiry_date: r.expiryDate, status: r.status, ref_doc: r.refDoc };
}
