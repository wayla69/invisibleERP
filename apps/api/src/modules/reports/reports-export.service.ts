import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { orders, orderLines, tenants } from '../../database/schema';
import { n } from '../../database/queries';

const VAT_RATE = 0.07;

// Express accounting import — "ใบสั่งขาย" fixed-width TXT
// คืนค่าเป็น utf-8 string (caller เติม BOM เอง)
@Injectable()
export class ReportExportService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async expressTxt(orderNo: string): Promise<string> {
    const db = this.db;
    const [order] = await db.select().from(orders).where(eq(orders.orderNo, orderNo)).limit(1);
    if (!order) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found', messageTh: 'ไม่พบคำสั่งซื้อ' });

    let tenant: any = null;
    if (order.tenantId != null) {
      [tenant] = await db.select().from(tenants).where(eq(tenants.id, order.tenantId)).limit(1);
    }
    const lines = await db.select().from(orderLines).where(eq(orderLines.orderId, order.id));

    const subtotal = lines.reduce((a: number, l: any) => a + n(l.totalPrice), 0);
    const vat = round2(subtotal * VAT_RATE);
    const grand = round2(subtotal + vat);

    // Fixed-width record layout for Express (best-effort parity with legacy export).
    // Express ingests a flat header line + one line per item, '|' separated logical
    // sections, fields space-padded to fixed widths. Document of field widths below.
    //
    // HEADER  : DocType(8) DocNo(20) Date(10) CustCode(15) CustName(40) TaxId(13)
    // ITEM    : Seq(4) ItemId(15) Desc(40) Qty(12,r) Uom(8) UnitPrice(14,r) Amount(16,r)
    // FOOTER  : 'SUBTOTAL'(?) ... VAT ... GRAND ... + baht-in-words
    const out: string[] = [];

    out.push(
      [
        padR('ORDER', 8),
        padR(order.orderNo ?? '', 20),
        padR(String(order.orderDate ?? ''), 10),
        padR(tenant?.code ?? '', 15),
        padR(tenant?.name ?? '', 40),
        padR(tenant?.taxId ?? '', 13),
      ].join('|'),
    );

    lines.forEach((l: any, i: number) => {
      out.push(
        [
          padL(String(i + 1), 4),
          padR(l.itemId ?? '', 15),
          padR(l.itemDescription ?? '', 40),
          padL(fmtNum(n(l.orderQty)), 12),
          padR(l.stockUom ?? '', 8),
          padL(fmtNum(n(l.unitPrice)), 14),
          padL(fmtNum(n(l.totalPrice)), 16),
        ].join('|'),
      );
    });

    out.push([padR('SUBTOTAL', 12), padL(fmtNum(subtotal), 16)].join('|'));
    out.push([padR('VAT7', 12), padL(fmtNum(vat), 16)].join('|'));
    out.push([padR('GRANDTOTAL', 12), padL(fmtNum(grand), 16)].join('|'));
    out.push([padR('BAHTTEXT', 12), bahtWords(grand)].join('|'));

    // CRLF line endings — Express import expects DOS line endings
    return out.join('\r\n') + '\r\n';
  }
}

// ── helpers ─────────────────────────────────────────────────────────────
function padR(v: unknown, width: number): string {
  const s = String(v ?? '');
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}
function padL(v: unknown, width: number): string {
  const s = String(v ?? '');
  return s.length >= width ? s.slice(0, width) : ' '.repeat(width - s.length) + s;
}
function fmtNum(x: number): string {
  return (Math.round(x * 100) / 100).toFixed(2);
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function bahtWords(amount: number): string {
  try {
    // bahttext exports the function directly (module.exports = bahttext)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('bahttext');
    const fn = typeof mod === 'function' ? mod : mod.bahttext ?? mod.default;
    return fn(amount);
  } catch {
    return `${fmtNum(amount)} บาทถ้วน`;
  }
}
