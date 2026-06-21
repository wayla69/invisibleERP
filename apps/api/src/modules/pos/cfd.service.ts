import { Injectable } from '@nestjs/common';
import { DineInService } from '../restaurant/dine-in.service';
import { PaymentService } from '../payments/payments.service';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// Customer-facing display (จอลูกค้า) — a live cart snapshot for a second screen. Reuses the dine-in order
// view + adds amount_due (total minus captured tenders) so the customer sees what is left to pay.
@Injectable()
export class CfdService {
  constructor(private readonly dineIn: DineInService, private readonly payments: PaymentService) {}

  async byOrder(orderNo: string, user: JwtUser) {
    const v: any = await this.dineIn.getOrder(orderNo, user); // viewOrder: subtotal/vat/total/items/status/sale_no
    let captured = 0;
    if (v.sale_no) { const paid: any = await this.payments.listPaymentsForSale(v.sale_no); captured = n(paid.total_captured); }
    const total = n(v.total);
    const amountDue = Math.max(0, Math.round((total - captured) * 100) / 100);
    const statusTh: Record<string, string> = { open: 'กำลังสั่ง', sent_to_kitchen: 'ส่งครัวแล้ว', bill_requested: 'เรียกเก็บเงิน', paying: 'กำลังชำระ', partially_paid: 'ชำระบางส่วน', paid: 'ชำระแล้ว', closed: 'ปิดโต๊ะ', cancelled: 'ยกเลิก' };
    return {
      order_no: v.order_no, table_id: v.table_id, status: v.status, status_th: statusTh[String(v.status)] ?? v.status, currency: 'THB',
      items: (v.items ?? []).map((i: any) => ({ name: i.name, qty: n(i.qty), unit_price: n(i.unit_price), amount: n(i.amount) })),
      subtotal: n(v.subtotal), vat: n(v.vat), total, amount_due: amountDue, paid: amountDue <= 0.005, updated_at: new Date().toISOString(),
    };
  }
}
