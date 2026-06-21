import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { sql, eq, ne, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import {
  custPosSales, custPosItems, customerInventory, custStockLog,
  loyaltyConfig, loyaltyPoints, loyaltyTxn,
} from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { ymd, n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { PortalService } from './portal.service';
import { TaxService } from '../tax/tax.service';
import { PaymentService } from '../payments/payments.service';
import { LedgerService } from '../ledger/ledger.service';

export interface PortalSaleDto {
  items: { item_id: string; item_description?: string; qty: number; unit_price: number; uom?: string; discount_pct?: number }[];
  discount?: number;
  payment_method?: string;
  notes?: string;
}

@Injectable()
export class PortalPosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly portal: PortalService,
    private readonly tax: TaxService,
    private readonly payments: PaymentService,
    private readonly ledger: LedgerService,
  ) {}

  // POST /api/portal/pos/sales — retail sale (SALE-) + stock decrement + loyalty earn
  async createSale(dto: PortalSaleDto, user: JwtUser) {
    const t = await this.portal.tenantId(user);
    const db = this.db as any;
    if (!dto.items?.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No items', messageTh: 'ไม่มีรายการสินค้า' });

    const lines = dto.items.map((it) => {
      const gross = n(it.qty) * n(it.unit_price);
      const lineDisc = gross * (n(it.discount_pct) / 100);
      return { ...it, amount: Math.round((gross - lineDisc) * 100) / 100 };
    });
    const subtotal = Math.round(lines.reduce((a, l) => a + l.amount, 0) * 100) / 100;
    const discount = Math.round(n(dto.discount) * 100) / 100;
    const taxable = Math.max(0, subtotal - discount);
    // pluggable tax (move #5) — no more hard-coded VAT 7%
    const taxCalc = this.tax.calcTax({ net: taxable, country: 'TH' });
    const vat = taxCalc.tax;
    const total = Math.round((taxable + vat) * 100) / 100;

    const saleNo = this.docNo.nextTenantStamped('SALE', t.code);
    const today = ymd();
    const now = new Date();

    // loyalty earn (parity with central POS)
    let pointsEarned = 0;
    const [cfg] = await db.select().from(loyaltyConfig).where(eq(loyaltyConfig.id, 1)).limit(1);
    if (cfg?.enabled) pointsEarned = Math.round(total * n(cfg.pointsPerBaht) * 100) / 100;

    await db.transaction(async (tx: any) => {
      const [h] = await tx.insert(custPosSales).values({
        saleNo, saleDate: today, tenantId: t.id, subtotal: String(subtotal), discount: String(discount),
        taxAmount: String(vat), total: String(total), paymentMethod: dto.payment_method ?? 'Cash',
        pointsUsed: '0', pointsEarned: String(pointsEarned), status: 'Completed', notes: dto.notes ?? null, createdBy: user.username,
      }).returning({ id: custPosSales.id });

      await tx.insert(custPosItems).values(lines.map((l) => ({
        saleId: Number(h.id), itemId: l.item_id, itemDescription: l.item_description ?? null,
        qty: String(n(l.qty)), uom: l.uom ?? null, unitPrice: String(n(l.unit_price)),
        discountPct: String(n(l.discount_pct)), amount: String(l.amount), isCustom: false,
      })));

      // decrement customer inventory (MAX(0,...)) + stock log
      for (const l of lines) {
        const [inv] = await tx.select().from(customerInventory)
          .where(and(eq(customerInventory.tenantId, t.id), eq(customerInventory.itemId, l.item_id))).limit(1);
        if (inv) {
          const newStock = Math.max(0, n(inv.currentStock) - n(l.qty));
          await tx.update(customerInventory).set({ currentStock: String(newStock), lastUpdated: now }).where(eq(customerInventory.id, inv.id));
          await tx.insert(custStockLog).values({
            tenantId: t.id, itemId: l.item_id, itemDescription: inv.itemDescription, logDate: now, logType: 'Sale',
            qtyChange: String(-n(l.qty)), balanceAfter: String(newStock), refDoc: saleNo, notes: null, createdBy: user.username,
          });
        }
      }

      // loyalty accrual
      if (pointsEarned > 0) {
        const [lp] = await tx.select().from(loyaltyPoints).where(eq(loyaltyPoints.tenantId, t.id)).limit(1);
        const newBalance = n(lp?.balance) + pointsEarned;
        const newLifetime = n(lp?.lifetime) + pointsEarned;
        await tx.insert(loyaltyPoints).values({ tenantId: t.id, balance: String(newBalance), lifetime: String(newLifetime), lastUpdated: now })
          .onConflictDoUpdate({ target: loyaltyPoints.tenantId, set: { balance: String(newBalance), lifetime: String(newLifetime), lastUpdated: now } });
        await tx.insert(loyaltyTxn).values({ tenantId: t.id, txnDate: now, txnType: 'Earn', points: String(pointsEarned), balanceAfter: String(newBalance), refDoc: saleNo });
      }
    });

    // Tender (move #3) + GL posting (move #2) are part of the sale's atomicity — same request tx.
    // We do NOT swallow their errors: a swallowed DB failure here poisons the request tx (Postgres
    // aborts it), so the interceptor's COMMIT becomes a ROLLBACK and we'd return 200 + sale_no for a
    // sale that was never persisted (phantom sale). Letting them propagate rolls the whole sale back
    // atomically — no sale without its money + books.
    const tender: any = await this.payments.recordTender(
      { sale_no: saleNo, tenant_id: t.id, method: dto.payment_method ?? 'Cash', amount: total, currency: 'THB', gateway: 'mock' },
      user,
    );
    const je: any = await this.ledger.postEntry({
      source: 'POS', sourceRef: saleNo, tenantId: t.id, memo: `Retail sale ${saleNo}`, createdBy: user.username,
      lines: [
        { account_code: '1000', debit: total },   // Dr Cash
        { account_code: '4000', credit: taxable }, // Cr Sales Revenue
        { account_code: '2100', credit: vat },     // Cr Tax Payable
      ],
    });

    return { sale_no: saleNo, subtotal, discount, vat, total, points_earned: pointsEarned, lines: lines.length, payment_no: tender?.payment_no ?? null, journal_no: je?.entry_no ?? null };
  }

  // GET /api/portal/pos/sales — history (this tenant)
  async listSales(user: JwtUser, limit: number, offset: number) {
    const t = await this.portal.tenantId(user);
    const db = this.db as any;
    const rows = await db.select({
      sale_no: custPosSales.saleNo, sale_date: custPosSales.saleDate, subtotal: custPosSales.subtotal,
      discount: custPosSales.discount, tax_amount: custPosSales.taxAmount, total: custPosSales.total,
      payment_method: custPosSales.paymentMethod, points_earned: custPosSales.pointsEarned,
      status: custPosSales.status, cashier: custPosSales.createdBy,
    }).from(custPosSales)
      .where(and(eq(custPosSales.tenantId, t.id), ne(custPosSales.status, 'Voided')))
      .orderBy(desc(custPosSales.saleNo)).limit(limit).offset(offset);
    return {
      sales: rows.map((r: any) => ({
        ...r, subtotal: n(r.subtotal), discount: n(r.discount), tax_amount: n(r.tax_amount),
        total: n(r.total), points_earned: n(r.points_earned),
      })),
      count: rows.length,
    };
  }
}
