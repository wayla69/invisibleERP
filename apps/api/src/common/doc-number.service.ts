import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../database/database.module';
import { docCounters } from '../database/schema';

type DailyType = 'PO' | 'GR' | 'ST' | 'PR' | 'DO' | 'RCP' | 'GRC' | 'AP' | 'RTN' | 'JE' | 'PAY' | 'REF' | 'TILL';

/**
 * เลขเอกสาร — คงรูปแบบแสดงผลเดิม แต่ atomic (upsert-returning บน doc_counters)
 * แก้ race ของ V1 ที่ใช้ COUNT(*)+1.
 */
@Injectable()
export class DocNumberService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // {PFX}-YYYYMMDD-NNN  (PO/GR/ST/PR/DO/RCP/GRC/AP/RTN)
  async nextDaily(type: DailyType): Promise<string> {
    const day = yyyymmdd();
    const seq = await this.bump(type, day);
    return `${type}-${day}-${String(seq).padStart(3, '0')}`;
  }

  // SO-YYYYMMDD-HHMM (legacy format; uniqueness บังคับโดย orders.order_no UNIQUE)
  nextSalesOrder(d = new Date()): string {
    return `SO-${yyyymmdd(d)}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  // {PFX}-{tenant[:n]}-YYYYMMDDHHMMSS  (SALE/PRD/PND/MPO)
  nextTenantStamped(type: 'SALE' | 'PRD' | 'PND' | 'MPO', tenantCode: string, d = new Date()): string {
    const n = type === 'MPO' ? 3 : type === 'PND' ? 6 : 4;
    return `${type}-${(tenantCode || '').replace(/\s/g, '').slice(0, n).toUpperCase()}-${stamp(d)}`;
  }

  // {PFX}-YYYYMMDDHHMMSS  (TRF/SCAN/ADJ)
  nextStamped(type: 'TRF' | 'SCAN' | 'ADJ', d = new Date()): string {
    return `${type}-${stamp(d)}`;
  }

  invoiceFromOrder(orderNo: string): string {
    return `INV-${orderNo}`;
  }

  private async bump(docType: string, day: string): Promise<number> {
    const r = await (this.db as any)
      .insert(docCounters)
      .values({ docType, day, n: 1 })
      .onConflictDoUpdate({ target: [docCounters.docType, docCounters.day], set: { n: sql`${docCounters.n} + 1` } })
      .returning({ n: docCounters.n });
    return Number(r[0].n);
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
const yyyymmdd = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const stamp = (d = new Date()) => `${yyyymmdd(d)}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
