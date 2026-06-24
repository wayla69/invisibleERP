import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { and, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { custPosSales } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// Governed semantic layer (Platform Phase 14 — A5). A CURATED whitelist of measures × dimensions over the
// POS-sales fact. Callers pick a dimension to group by + optional date filters; the engine builds a safe,
// RLS-scoped aggregate (the measure/dimension keys map to fixed SQL — user input never reaches the SQL text;
// only filter VALUES are parameterized). Read-only; never posts to the GL. Reused by NL-analytics (B3).
const MEASURES = [
  { key: 'sales_total', label: 'ยอดขายรวม', label_en: 'Total sales', unit: 'baht' },
  { key: 'orders', label: 'จำนวนบิล', label_en: 'Orders', unit: 'count' },
  { key: 'avg_order', label: 'เฉลี่ยต่อบิล', label_en: 'Avg order value', unit: 'baht' },
  { key: 'discount_total', label: 'ส่วนลดรวม', label_en: 'Total discount', unit: 'baht' },
  { key: 'tax_total', label: 'ภาษีรวม (VAT)', label_en: 'Total VAT', unit: 'baht' },
] as const;
const DIMENSIONS = [
  { key: 'period_month', label: 'เดือน', label_en: 'Month' },
  { key: 'period_day', label: 'รายวัน', label_en: 'Day' },
  { key: 'branch', label: 'สาขา', label_en: 'Branch' },
  { key: 'payment_method', label: 'วิธีชำระเงิน', label_en: 'Payment method' },
] as const;
const DIM_KEYS = DIMENSIONS.map((d) => d.key) as readonly string[];

@Injectable()
export class QueryService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  model() {
    return { fact: 'pos_sales', label: 'การขายหน้าร้าน (POS sales)', measures: MEASURES.map((m) => ({ ...m })), dimensions: DIMENSIONS.map((d) => ({ ...d })) };
  }

  measureKeys() { return MEASURES.map((m) => m.key); }
  dimensionKeys() { return [...DIM_KEYS]; }

  private dimExpr(dim: string) {
    switch (dim) {
      case 'period_month': return sql`to_char(date_trunc('month', ${custPosSales.saleDate}::timestamp), 'YYYY-MM')`;
      case 'period_day': return sql`${custPosSales.saleDate}::text`;
      case 'branch': return sql`coalesce(${custPosSales.branchId}::text, '-')`;
      case 'payment_method': default: return sql`coalesce(${custPosSales.paymentMethod}, '-')`;
    }
  }

  // Run one grouped aggregate. dimension is whitelisted; date filters are parameterized; RLS scopes the tenant.
  async run(spec: { dimension: string; date_from?: string; date_to?: string; limit?: number }, _user: JwtUser) {
    if (!DIM_KEYS.includes(spec.dimension)) {
      throw new BadRequestException({ code: 'BAD_DIMENSION', message: `dimension must be one of ${DIM_KEYS.join(', ')}`, messageTh: 'มิติข้อมูลไม่ถูกต้อง' });
    }
    const db = this.db as any;
    const dim = this.dimExpr(spec.dimension);
    const conds: any[] = [sql`coalesce(${custPosSales.status}::text, '') <> 'Voided'`];
    if (spec.date_from) conds.push(sql`${custPosSales.saleDate} >= ${spec.date_from}`);
    if (spec.date_to) conds.push(sql`${custPosSales.saleDate} <= ${spec.date_to}`);
    const limit = Math.min(Math.max(Number(spec.limit) || 100, 1), 1000);
    const rows = await db.select({
      dim: dim.as('dim'),
      sales_total: sql<string>`coalesce(sum(${custPosSales.total}), 0)`,
      orders: sql<string>`count(*)`,
      avg_order: sql<string>`coalesce(avg(${custPosSales.total}), 0)`,
      discount_total: sql<string>`coalesce(sum(${custPosSales.discount}), 0)`,
      tax_total: sql<string>`coalesce(sum(${custPosSales.taxAmount}), 0)`,
    }).from(custPosSales).where(and(...conds)).groupBy(dim).orderBy(sql`coalesce(sum(${custPosSales.total}), 0) desc`).limit(limit);
    return {
      fact: 'pos_sales',
      dimension: spec.dimension,
      measures: MEASURES.map((m) => m.key),
      rows: rows.map((r: any) => ({
        dim: r.dim,
        sales_total: Number(r.sales_total), orders: Number(r.orders),
        avg_order: Math.round(Number(r.avg_order) * 100) / 100,
        discount_total: Number(r.discount_total), tax_total: Number(r.tax_total),
      })),
    };
  }
}
