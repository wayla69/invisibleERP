import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../database/database.module';
import { docCounters, docCountersTenant } from '../database/schema';
import { bizYmdCompact, bizStamp, bizHourMin } from './bizdate';

type DailyType = 'PO' | 'GR' | 'ST' | 'PR' | 'DO' | 'RCP' | 'GRC' | 'AP' | 'RTN' | 'JE' | 'PAY' | 'REF' | 'TILL' | 'DIN' | 'TS' | 'FA' | 'DEP' | 'SPLIT' | 'CASHMOV' | 'BANKSTMT' | 'BANKADJ' | 'DEFREV' | 'REVREC' | 'IC' | 'GC' | 'GCT' | 'RFQ' | 'QTE' | 'MAT' | 'WAVE' | 'PICK' | 'SHP' | 'RPL' | 'RMA' | 'MI' | 'WO' | 'HOLD' | 'OVR' | 'PTI' | 'STL' | 'HA' | 'HAE' | 'RWD' | 'RDM' | 'CPN' | 'MSN' | 'RFL' | 'WHL' | 'SPN' | 'CMP' | 'PTR' | 'PRV' | 'APP' | 'DUN' | 'MWO' | 'ADV' | 'PPD' | 'LSE' | 'FAR' | 'PEX' | 'PCF' | 'TIP' | 'CUS' | 'WASTE' | 'LEAD' | 'OPP' | 'BDEP' | 'REVC' | 'JNY' | 'AINV' | 'PMR' | 'BQR' | 'FAC' | 'AUD' | 'PC' | 'SC' | 'SV' | 'TND' | 'BKG' | 'REC' | 'AGE' | 'MDI' | 'VBC' | 'VCH' | 'ACC' | 'APL';
type MonthlyTenantType = 'TIV' | 'ATV' | 'WHT' | 'CN' | 'DN'; // tax invoice / abbreviated / WHT / credit note / debit note

/**
 * เลขเอกสาร — คงรูปแบบแสดงผลเดิม แต่ atomic (upsert-returning บน doc_counters)
 * แก้ race ของ V1 ที่ใช้ COUNT(*)+1.
 */
@Injectable()
export class DocNumberService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // {PFX}-YYYYMMDD-NNN  (PO/GR/ST/PR/DO/RCP/GRC/AP/RTN) — day in business TZ
  async nextDaily(type: DailyType): Promise<string> {
    const day = bizYmdCompact();
    const seq = await this.bump(type, day);
    return `${type}-${day}-${String(seq).padStart(3, '0')}`;
  }

  // SO-YYYYMMDD-HHMM (legacy format; uniqueness บังคับโดย orders.order_no UNIQUE)
  nextSalesOrder(d = new Date()): string {
    return `SO-${bizYmdCompact(d)}-${bizHourMin(d)}`;
  }

  // {PFX}-{tenant[:n]}-YYYYMMDDHHMMSS  (SALE/PRD/PND/MPO)
  nextTenantStamped(type: 'SALE' | 'PRD' | 'PND' | 'MPO', tenantCode: string, d = new Date()): string {
    const n = type === 'MPO' ? 3 : type === 'PND' ? 6 : 4;
    return `${type}-${(tenantCode || '').replace(/\s/g, '').slice(0, n).toUpperCase()}-${bizStamp(d)}`;
  }

  // {PFX}-YYYYMMDDHHMMSS  (TRF/SCAN/ADJ)
  nextStamped(type: 'TRF' | 'SCAN' | 'ADJ', d = new Date()): string {
    return `${type}-${bizStamp(d)}`;
  }

  invoiceFromOrder(orderNo: string): string {
    return `INV-${orderNo}`;
  }

  // {PFX}-YYYYMM-NNNN — SEQUENTIAL PER SELLER (tenant), monthly reset. Atomic upsert-returning on
  // doc_counters_tenant (race-safe). Used for tax-doc numbers that must be legally sequential per seller.
  async nextMonthlyTenant(type: MonthlyTenantType, tenantId: number): Promise<string> {
    const period = bizYmdCompact().slice(0, 6); // YYYYMM (business TZ)
    const r = await this.db
      .insert(docCountersTenant)
      .values({ docType: type, tenantId, period, n: 1 })
      .onConflictDoUpdate({
        target: [docCountersTenant.docType, docCountersTenant.tenantId, docCountersTenant.period],
        set: { n: sql`${docCountersTenant.n} + 1` },
      })
      .returning({ n: docCountersTenant.n });
    return `${type}-${period}-${String(Number(r[0]!.n)).padStart(4, '0')}`;
  }

  private async bump(docType: string, day: string): Promise<number> {
    const r = await this.db
      .insert(docCounters)
      .values({ docType, day, n: 1 })
      .onConflictDoUpdate({ target: [docCounters.docType, docCounters.day], set: { n: sql`${docCounters.n} + 1` } })
      .returning({ n: docCounters.n });
    return Number(r[0]!.n);
  }
}
