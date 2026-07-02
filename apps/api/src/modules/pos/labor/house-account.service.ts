import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq, and, desc, ne } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { arInvoices } from '../../../database/schema';
import { n, ymd } from '../../../database/queries';
import type { JwtUser } from '../../../common/decorators';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// P2c — house accounts: an on-account POS tender becomes an open AR invoice (settled later via AR).
@Injectable()
export class HouseAccountService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async charge(dto: { sale_no: string; amount: number; due_date?: string }, user: JwtUser) {
    if (!(dto.amount > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'amount must be > 0', messageTh: 'จำนวนเงินไม่ถูกต้อง' });
    const db = this.db as any;
    const invoiceNo = `HA-${dto.sale_no}`;
    const [dup] = await db.select().from(arInvoices).where(eq(arInvoices.invoiceNo, invoiceNo)).limit(1);
    if (dup) return { invoice_no: invoiceNo, amount: n(dup.amount), status: dup.status, idempotent: true };
    await db.insert(arInvoices).values({ invoiceNo, invoiceDate: ymd(), dueDate: dto.due_date ?? null, tenantId: user.tenantId ?? null, orderNo: dto.sale_no, amount: String(round2(dto.amount)), paidAmount: '0', status: 'Unpaid', createdBy: user.username });
    return { invoice_no: invoiceNo, amount: round2(dto.amount), status: 'Unpaid' };
  }

  async openBalance() {
    const db = this.db as any;
    const rows = await db.select().from(arInvoices).where(and(ne(arInvoices.status, 'Paid'), ne(arInvoices.status, 'Cancelled'))).orderBy(desc(arInvoices.id)).limit(200);
    const outstanding = round2(rows.reduce((a: number, r: any) => a + (n(r.amount) - n(r.paidAmount)), 0));
    return { invoices: rows.map((r: any) => ({ invoice_no: r.invoiceNo, order_no: r.orderNo, amount: n(r.amount), paid: n(r.paidAmount), status: r.status })), outstanding, count: rows.length };
  }
}
