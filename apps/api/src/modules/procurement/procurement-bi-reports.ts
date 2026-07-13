import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { ProcurementService } from './procurement.service';

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class ProcurementBiReports implements BiReportSource {
  constructor(private readonly procurement: ProcurementService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'low_stock_reorder_alert',
        generate: async (_f, user) => {
          // D1 — read-only: reuse feature-C's low-stock computation (items.min_stock vs summed inv_balances)
          // so the alert matches exactly what `reorder`/เปิด PR เติมของ will order. Delivery + one-tap button
          // are formatted per recipient in executeSubscription; here we just carry the list + a count.
          const { items: low, count } = await this.procurement.lowStock(user, { limit: 20 });
          return {
            data: { count, items: low },
            summary: `Low-stock reorder alert: ${count} item(s) at/below reorder point`,
            summaryTh: count ? `สินค้าใกล้หมด ${count} รายการ (ถึง/ต่ำกว่าจุดสั่งซื้อ)` : 'สินค้าใกล้หมด: ไม่มี',
          };
        },
      },
      {
        type: 'purchase_spend',
        generate: async (f, user) => {
          // D3 — read-only: reuse ProcurementService.purchaseSpend (total + top vendors + most-bought items).
          const sp = await this.procurement.purchaseSpend(user, { period: f.period || undefined });
          const topV = sp.by_vendor[0];
          return {
            data: sp,
            summary: `Purchase spend ${sp.period}: ${sp.total.toLocaleString()} across ${sp.po_count} PO(s)${topV ? `; top vendor ${topV.vendor} ${topV.total.toLocaleString()}` : ''}`,
            summaryTh: `ยอดซื้อเดือน ${sp.period}: ฿${sp.total.toLocaleString('th-TH', { maximumFractionDigits: 2 })} · ${sp.po_count} ใบสั่งซื้อ${topV ? ` · ผู้ขายสูงสุด ${topV.vendor}` : ''}`,
          };
        },
      },
      {
        type: 'supplier_scorecard',
        generate: async (f, user) => {
          const r = await this.procurement.listScorecards({ period: f.period, limit: f.limit }, user);
          return { data: r, summary: `Suppliers: ${r.count} scored, avg ${r.avg_score}, ${r.underperformers} underperformer(s) (<70)`, summaryTh: `ผู้ขาย: ให้คะแนน ${r.count} ราย · เฉลี่ย ${r.avg_score} · ต่ำกว่าเกณฑ์ ${r.underperformers} ราย` };
        },
      },
    ];
  }
}
