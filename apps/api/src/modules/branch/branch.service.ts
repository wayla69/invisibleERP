import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { eq, and, ne, sql, gte, lte, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { branches, custPosSales, customerItems, priceList, promotions } from '../../database/schema';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { isUniqueViolation } from '../../common/db-error';

export interface CreateBranchDto { code: string; name: string; is_hq?: boolean; address?: string; phone?: string }
export interface UpdateBranchDto { name?: string; active?: boolean; is_hq?: boolean; address?: string; phone?: string }

@Injectable()
export class BranchService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // The acting user's tenant — the "HQ" of its branches. Every branch op is scoped to it (mantra #10:
  // thread an explicit tenant_id even under Admin RLS-bypass, so HQ can't accidentally span tenants).
  private tenantId(user: JwtUser): number {
    if (user.tenantId == null) {
      throw new BadRequestException({ code: 'NO_TENANT', message: 'User is not bound to a tenant', messageTh: 'ผู้ใช้ไม่ได้ผูกกับร้าน/บริษัท' });
    }
    return Number(user.tenantId);
  }

  private fmt(b: any) {
    return {
      id: Number(b.id), code: b.code, name: b.name, is_hq: !!b.isHq,
      address: b.address ?? null, phone: b.phone ?? null, active: !!b.active,
      created_at: b.createdAt ?? null,
    };
  }

  async createBranch(dto: CreateBranchDto, user: JwtUser) {
    const t = this.tenantId(user);
    const code = (dto.code ?? '').trim();
    if (!code || !(dto.name ?? '').trim()) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'code and name are required', messageTh: 'ต้องระบุรหัสและชื่อสาขา' });
    }
    const db = this.db as any;
    try {
      const [b] = await db.insert(branches).values({
        tenantId: t, code, name: dto.name.trim(), isHq: !!dto.is_hq,
        address: dto.address ?? null, phone: dto.phone ?? null, active: true, createdBy: user.username,
      }).returning();
      return this.fmt(b);
    } catch (e: any) {
      if (isUniqueViolation(e)) {
        throw new ConflictException({ code: 'BRANCH_EXISTS', message: `Branch code '${code}' already exists`, messageTh: `รหัสสาขา '${code}' มีอยู่แล้ว` });
      }
      throw e;
    }
  }

  async listBranches(user: JwtUser) {
    const t = this.tenantId(user);
    const db = this.db as any;
    const rows = await db.select().from(branches)
      .where(eq(branches.tenantId, t))
      .orderBy(desc(branches.isHq), branches.code);
    return { branches: rows.map((b: any) => this.fmt(b)), count: rows.length };
  }

  async updateBranch(id: number, dto: UpdateBranchDto, user: JwtUser) {
    const t = this.tenantId(user);
    const db = this.db as any;
    const patch: any = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.active !== undefined) patch.active = !!dto.active;
    if (dto.is_hq !== undefined) patch.isHq = !!dto.is_hq;
    if (dto.address !== undefined) patch.address = dto.address;
    if (dto.phone !== undefined) patch.phone = dto.phone;
    if (!Object.keys(patch).length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No fields to update', messageTh: 'ไม่มีข้อมูลให้แก้ไข' });
    const [b] = await db.update(branches).set(patch)
      .where(and(eq(branches.id, Number(id)), eq(branches.tenantId, t))).returning();
    if (!b) throw new NotFoundException({ code: 'BRANCH_NOT_FOUND', message: 'Branch not found', messageTh: 'ไม่พบสาขา' });
    return this.fmt(b);
  }

  // HQ consolidation — per-branch POS totals for the tenant. Untagged sales surface as branch "(none)".
  async consolidatedSales(user: JwtUser, from?: string, to?: string) {
    const t = this.tenantId(user);
    const db = this.db as any;
    const conds = [eq(custPosSales.tenantId, t), ne(custPosSales.status, 'Voided')];
    if (from) conds.push(gte(custPosSales.saleDate, from));
    if (to) conds.push(lte(custPosSales.saleDate, to));

    const rows = await db.select({
      branch_id: custPosSales.branchId,
      code: branches.code,
      name: branches.name,
      is_hq: branches.isHq,
      orders: sql<number>`count(*)`,
      subtotal: sql<string>`coalesce(sum(${custPosSales.subtotal}),0)`,
      tax: sql<string>`coalesce(sum(${custPosSales.taxAmount}),0)`,
      total_sales: sql<string>`coalesce(sum(${custPosSales.total}),0)`,
    }).from(custPosSales)
      .leftJoin(branches, eq(custPosSales.branchId, branches.id))
      .where(and(...conds))
      .groupBy(custPosSales.branchId, branches.code, branches.name, branches.isHq);

    const branchesOut = rows.map((r: any) => ({
      branch_id: r.branch_id != null ? Number(r.branch_id) : null,
      code: r.code ?? '(none)',
      name: r.name ?? 'Untagged / ไม่ระบุสาขา',
      is_hq: !!r.is_hq,
      orders: Number(r.orders),
      subtotal: n(r.subtotal),
      tax: n(r.tax),
      total_sales: n(r.total_sales),
    })).sort((a: any, b: any) => b.total_sales - a.total_sales);

    const totals = branchesOut.reduce(
      (acc: any, b: any) => ({ orders: acc.orders + b.orders, total_sales: acc.total_sales + b.total_sales }),
      { orders: 0, total_sales: 0 },
    );
    return { from: from ?? null, to: to ?? null, branches: branchesOut, totals };
  }

  // HQ → branch master data: the catalog an offline POS caches so it can sell while disconnected.
  // RLS already scopes every row to this tenant.
  async masterBundle(user: JwtUser) {
    const t = this.tenantId(user);
    const db = this.db as any;
    const items = await db.select().from(customerItems).where(eq(customerItems.tenantId, t));
    const prices = await db.select().from(priceList).where(and(eq(priceList.tenantId, t), eq(priceList.active, true)));
    const promos = await db.select().from(promotions).where(and(eq(promotions.tenantId, t), eq(promotions.active, true)));
    return {
      generated_at: new Date().toISOString(),
      items: items.map((i: any) => ({ item_id: i.itemId, item_name: i.itemName, category: i.category, unit_price: n(i.unitPrice), uom: i.uom })),
      price_list: prices.map((p: any) => ({ item_id: p.itemId, base_price: n(p.basePrice), special_price: n(p.specialPrice), discount_pct: n(p.discountPct), min_qty: n(p.minQty) })),
      promotions: promos.map((p: any) => ({ promo_id: p.promoId, promo_name: p.promoName, promo_type: p.promoType, discount_pct: n(p.discountPct), discount_amt: n(p.discountAmt), min_amount: n(p.minAmount) })),
      counts: { items: items.length, price_list: prices.length, promotions: promos.length },
    };
  }
}
