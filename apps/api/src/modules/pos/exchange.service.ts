import { Injectable, BadRequestException } from '@nestjs/common';
import { DocNumberService } from '../../common/doc-number.service';
import type { JwtUser } from '../../common/decorators';
import { ReturnsService } from '../returns/returns.service';
import { PosSaleService } from './pos-sale.service';
import type { PortalSaleDto } from '../portal/portal.pos.service';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

export interface ExchangeDto {
  sale_no: string;
  return_items: { sale_item_id?: number; item_id?: string; qty: number }[];
  new_items: { item_id: string; item_description?: string; qty: number; unit_price: number; uom?: string; discount_pct?: number }[];
  reason: string;
  price_tier?: string;
  customer_code?: string;
  branch_id?: number;
}

// docs/52 Phase 4e — POS exchange (even / partial). An exchange is a RETURN of the original line(s) PLUS a
// linked NEW SALE of the replacement line(s), settled by NETTING: the return issues STORE CREDIT, and the new
// sale is paid from that store credit first (a 2200 deposit draw-down), so only the DIFFERENCE moves in cash.
//   • even exchange (new value == returned value) → the credit exactly covers it → NO cash changes hands.
//   • up-swap (new > returned) → the customer pays the cash difference.
//   • down-swap (new < returned) → the residual stays as store credit the customer keeps (no cash refund).
// The whole flow runs in ONE request transaction (the tenant-tx interceptor wraps the request), so the return
// and the new sale either both commit or both roll back — no refund without its replacement sale, and vice
// versa. The return auto-issues the ใบลดหนี้ (credit note) so output-VAT (ภ.พ.30) is reduced for the
// returned goods; the new sale posts its own output VAT — the net VAT effect is on the difference only.
// Reason-coded (a reason is required) and correlated across both documents by an EXC- id.
//
// This is an ORCHESTRATION over the existing, independently-controlled Return + Sale services (bounded-context
// clean: no return/sale posting logic is duplicated here) — the GL, stock, credit-note and store-credit
// mechanics are exactly those the return and sale already own and that the harnesses already lock.
@Injectable()
export class ExchangeService {
  constructor(
    private readonly docNo: DocNumberService,
    private readonly returns: ReturnsService,
    private readonly pos: PosSaleService,
  ) {}

  async createExchange(dto: ExchangeDto, user: JwtUser) {
    const reason = (dto.reason ?? '').trim();
    if (!reason) throw new BadRequestException({ code: 'EXCHANGE_REASON_REQUIRED', message: 'An exchange requires a reason', messageTh: 'การแลกเปลี่ยนต้องระบุเหตุผล' });
    if (!dto.return_items?.length) throw new BadRequestException({ code: 'EXCHANGE_NO_RETURN_ITEMS', message: 'No items to return', messageTh: 'ไม่มีสินค้าที่จะคืน' });
    if (!dto.new_items?.length) throw new BadRequestException({ code: 'EXCHANGE_NO_NEW_ITEMS', message: 'No replacement items', messageTh: 'ไม่มีสินค้าที่จะแลก' });

    const exchangeNo = await this.docNo.nextDaily('EXC');

    // 1. RETURN the original line(s) → STORE CREDIT (a gift card holds the returned value; NO cash out). This
    //    restocks, posts the GL reversal (Dr revenue+VAT / Cr 2200) and auto-issues the credit note.
    const ret: any = await this.returns.createReturn(
      { sale_no: dto.sale_no, items: dto.return_items, refund_method: 'StoreCredit', reason: `${exchangeNo}: ${reason}` },
      user,
    );
    const card: string | undefined = ret.store_credit_card_no ?? undefined;
    const returnedValue = round2(ret.total_returned);

    // 2. NEW SALE of the replacement line(s), paid from the store credit first (the 2200 draw-down); the
    //    remaining difference (if any) is collected as cash. Runs in the same request tx as the return.
    const saleDto: PortalSaleDto = {
      items: dto.new_items,
      store_credit_card_no: card,
      notes: `Exchange ${exchangeNo} of ${dto.sale_no} (return ${ret.return_no})`,
      payment_method: 'Cash',
      ...(dto.price_tier ? { price_tier: dto.price_tier } : {}),
      ...(dto.customer_code ? { customer_code: dto.customer_code } : {}),
      ...(dto.branch_id != null ? { branch_id: dto.branch_id } : {}),
    };
    const sale: any = await this.pos.createGenericSale(saleDto, user);
    const newValue = round2(sale.total);

    const creditApplied = round2(sale.store_credit_applied ?? 0);
    const netDifference = round2(newValue - returnedValue); // >0 customer paid extra; <0 residual credit; 0 even
    const cashCollected = round2(newValue - creditApplied);  // = max(0, new − returned)
    const residualStoreCredit = round2(returnedValue - creditApplied); // stays on the card (down-swap)

    return {
      exchange_no: exchangeNo,
      reason,
      sale_no: dto.sale_no,
      return_no: ret.return_no,
      credit_note_no: ret.credit_note_no ?? null,
      original_tax_invoice_no: ret.original_tax_invoice_no ?? null,
      returned_value: returnedValue,
      new_sale_no: sale.sale_no,
      new_value: newValue,
      store_credit_card_no: card ?? null,
      store_credit_applied: creditApplied,
      net_difference: netDifference,
      cash_collected: cashCollected,
      residual_store_credit: residualStoreCredit,
      even: Math.abs(netDifference) < 0.01,
    };
  }
}
