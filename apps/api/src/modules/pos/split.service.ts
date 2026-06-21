import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq, and, ne } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { dineInOrders, dineInOrderItems, posCheckSplits, custPosSales } from '../../database/schema';
import { DineInService } from '../restaurant/dine-in.service';
import { PaymentService } from '../payments/payments.service';
import { TaxService } from '../tax/tax.service';
import { DocNumberService } from '../../common/doc-number.service';
import { roundCurrency } from '../tax/money';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import type { MultiTenderDto, SplitPreviewDto, SplitSettleDto } from './split.dto';

const SETTLED = ['paid', 'closed', 'cancelled', 'partially_paid'];

@Injectable()
export class SplitBillService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly dineIn: DineInService,
    private readonly payments: PaymentService,
    private readonly tax: TaxService,
    private readonly docNo: DocNumberService,
  ) {}

  // ── MULTI-TENDER: one bill, N tenders, GL posted once ──
  async payMulti(orderNo: string, dto: MultiTenderDto, user: JwtUser) {
    const o = await this.dineIn.loadOrderForUpdate(orderNo); // lock + re-check → no concurrent double-book
    if (SETTLED.includes(String(o.status))) throw new BadRequestException({ code: 'ALREADY_PAID', message: 'Order already settled', messageTh: 'ออเดอร์ชำระแล้ว' });
    const saleNo = await this.dineIn.mintSaleNo(o.tenantId);
    const built = await this.dineIn.buildSale(o, saleNo, dto.discount ?? 0, user, { tip: dto.tip }); // GL posted ONCE here
    // tenders must cover bill + tip (no tip → cash_due == total, so existing split behavior is unchanged).
    const due = roundCurrency(built.total_with_tip, 'THB');
    const sum = roundCurrency(dto.tenders.reduce((a, t) => a + n(t.amount), 0), 'THB');
    if (Math.abs(sum - due) > 0.01) throw new BadRequestException({ code: 'SPLIT_MISMATCH', message: `Tenders ${sum} != amount due ${due}`, messageTh: `ยอดชำระรวม (${sum}) ไม่เท่ายอดที่ต้องชำระ (${due})` });
    const tenders = [];
    let tipLeft = roundCurrency(built.tip, 'THB'); // attribute the whole tip to the first tender
    for (const t of dto.tenders) {
      const thisTip = tipLeft; tipLeft = 0;
      const r: any = await this.payments.recordTender({ sale_no: saleNo, tenant_id: o.tenantId ?? undefined, method: t.method, amount: roundCurrency(n(t.amount) - thisTip, 'THB'), tip: thisTip, gateway: t.gateway }, user);
      tenders.push({ payment_no: r.payment_no, method: t.method, amount: n(t.amount), status: r.status });
    }
    const captured = roundCurrency(tenders.filter((t) => t.status === 'Captured').reduce((a, t) => a + t.amount, 0), 'THB');
    const paid = captured >= built.total - 0.01;
    let taxInvoiceNo: string | null = null;
    if (paid) { taxInvoiceNo = await this.dineIn.markPaidAndInvoice(o, saleNo, user); }
    else { await (this.db as any).update(dineInOrders).set({ status: 'partially_paid', saleNo }).where(eq(dineInOrders.id, o.id)); }
    return { order_no: orderNo, sale_no: saleNo, total: built.total, tenders, captured, paid, payment_state: paid ? 'paid' : 'partially_paid', journal_no: built.journal_no, tax_invoice_no: taxInvoiceNo };
  }

  // finalize a partially_paid order once its Pending tenders have settled
  async finalize(orderNo: string, user: JwtUser) {
    const o = await this.dineIn.loadOrder(orderNo);
    if (String(o.status) === 'paid') return { order_no: orderNo, paid: true, already: true };
    if (String(o.status) !== 'partially_paid' || !o.saleNo) throw new BadRequestException({ code: 'NOT_PARTIAL', message: 'Order is not partially paid', messageTh: 'ออเดอร์ไม่ได้อยู่สถานะชำระบางส่วน' });
    const pays: any = await this.payments.listPaymentsForSale(o.saleNo);
    if (n(pays.total_captured) < n(o.total) - 0.01) throw new BadRequestException({ code: 'STILL_UNPAID', message: `Captured ${pays.total_captured} < total ${o.total}`, messageTh: 'ยังชำระไม่ครบ' });
    const inv = await this.dineIn.markPaidAndInvoice(o, o.saleNo, user);
    return { order_no: orderNo, paid: true, tax_invoice_no: inv };
  }

  // ── SPLIT preview (no writes) ──
  async previewSplit(orderNo: string, dto: SplitPreviewDto, user: JwtUser) {
    const o = await this.dineIn.loadOrder(orderNo);
    const slices = await this.computeSlices(o, dto);
    return { order_no: orderNo, method: dto.method, total: n(o.total), checks: slices.map((s) => ({ check: s.check, subtotal: s.subtotal, vat: s.vat, total: s.total, items: s.lines.map((l: any) => ({ item_id: Number(l.id), name: l.name, amount: n(l.amount) })) })), sum_total: roundCurrency(slices.reduce((a, s) => a + s.total, 0), 'THB') };
  }

  // ── SPLIT settle: N checks → N sales + N GL + N invoices ──
  async settleSplit(orderNo: string, dto: SplitSettleDto, user: JwtUser) {
    const o = await this.dineIn.loadOrderForUpdate(orderNo); // lock + re-check → no concurrent double-book
    if (SETTLED.includes(String(o.status))) throw new BadRequestException({ code: 'ALREADY_PAID', message: 'Order already settled', messageTh: 'ออเดอร์ชำระแล้ว' });
    const slices = await this.computeSlices(o, dto);
    const tenderBy = new Map<number, { method: string; gateway?: string }>();
    for (const t of (dto as any).tenders ?? []) tenderBy.set(t.check, { method: t.method, gateway: t.gateway });
    const groupNo = await this.docNo.nextDaily('SPLIT');
    const db = this.db as any;
    const checks = [];
    let allCaptured = true;
    for (const s of slices) {
      const saleNo = await this.dineIn.mintSaleNo(o.tenantId);
      const built: any = await this.dineIn.buildCheckSale(o, saleNo, s.lines.map((l: any) => ({ itemId: l.itemId ?? null, name: l.name, qty: n(l.qty ?? 1), unitPrice: n(l.unitPrice ?? l.amount), amount: n(l.amount) })), s.grossOverride != null ? { grossOverride: s.grossOverride } : { discount: s.discount }, user);
      const tk = tenderBy.get(s.check) ?? { method: 'Cash' };
      const pay: any = await this.payments.recordTender({ sale_no: saleNo, tenant_id: o.tenantId ?? undefined, method: tk.method, amount: built.total, gateway: tk.gateway }, user);
      if (pay.status !== 'Captured') allCaptured = false;
      const inv = await this.dineIn.issueAbbreviated(saleNo, user);
      await db.insert(posCheckSplits).values({ groupNo, tenantId: o.tenantId ?? null, orderNo, checkSeq: s.check, saleNo, method: dto.method, total: String(built.total), status: pay.status === 'Captured' ? 'Paid' : 'Pending', createdBy: user.username });
      checks.push({ check: s.check, sale_no: saleNo, total: built.total, payment_no: pay.payment_no, payment_status: pay.status, tax_invoice_no: inv, journal_no: built.journal_no });
    }
    if (allCaptured) await this.dineIn.markAllChecksPaid(o, user);
    else await db.update(dineInOrders).set({ status: 'partially_paid' }).where(eq(dineInOrders.id, o.id));
    return { order_no: orderNo, group_no: groupNo, checks, order_status: allCaptured ? 'paid' : 'partially_paid' };
  }

  // shared slicing math (equal back-out inclusive / by-items net+vat); used by preview + settle
  private async computeSlices(o: any, dto: SplitPreviewDto) {
    const db = this.db as any;
    const items = await db.select().from(dineInOrderItems).where(and(eq(dineInOrderItems.orderId, Number(o.id)), ne(dineInOrderItems.kdsStatus, 'voided')));
    if (dto.method === 'equal') {
      const gross = roundCurrency(n(o.total), 'THB');
      if (gross <= 0) throw new BadRequestException({ code: 'EMPTY_BILL', message: 'Nothing to split', messageTh: 'ไม่มียอดให้แบ่ง' });
      const ways = dto.ways!;
      const base = roundCurrency(gross / ways, 'THB');
      const slices = [];
      for (let k = 1; k <= ways; k++) {
        const share = k < ways ? base : roundCurrency(gross - base * (ways - 1), 'THB');
        const inc = this.tax.calcInclusive({ gross: share, country: 'TH' });
        slices.push({ check: k, subtotal: inc.net, vat: inc.tax, total: roundCurrency(share, 'THB'), grossOverride: roundCurrency(share, 'THB'), lines: [] as any[], discount: 0 });
      }
      return slices;
    }
    // by_items
    const assign = new Map<number, number>();
    for (const a of dto.assignments!) assign.set(a.item_id, a.check);
    const unassigned = items.filter((i: any) => !assign.has(Number(i.id)));
    if (unassigned.length) throw new BadRequestException({ code: 'SPLIT_INCOMPLETE', message: `${unassigned.length} item(s) not assigned to a check`, messageTh: 'มีรายการที่ยังไม่ถูกแบ่งเข้าบิล' });
    const byCheck = new Map<number, any[]>();
    for (const i of items) { const c = assign.get(Number(i.id))!; if (!byCheck.has(c)) byCheck.set(c, []); byCheck.get(c)!.push(i); }
    const slices = [];
    for (const c of [...byCheck.keys()].sort((a, b) => a - b)) {
      const lines = byCheck.get(c)!;
      const grossNet = roundCurrency(lines.reduce((a, l) => a + n(l.amount), 0), 'THB');
      const t = this.tax.calcTax({ net: grossNet, country: 'TH' });
      slices.push({ check: c, subtotal: grossNet, vat: t.tax, total: roundCurrency(grossNet + t.tax, 'THB'), grossOverride: undefined as any, lines, discount: 0 });
    }
    return slices;
  }
}
