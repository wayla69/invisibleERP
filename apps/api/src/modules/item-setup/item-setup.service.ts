import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { and, asc, desc, eq, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { itemCategories, taxCodes, items, accounts, locations, itemRelationships } from '../../database/schema';
import { isUniqueViolation } from '../../common/db-error';
import type { JwtUser } from '../../common/decorators';

// Item-posting SETUP master data (docs/33 PR3, GL-21). Maintains the account/tax profile that the
// AccountDeterminationService resolves at posting time: item categories, tax codes, and the per-item override.
// All writes validate any GL account against the canonical CoA (postable) up front — the same fail-closed
// guard GL-21 enforces at posting, surfaced here so misconfiguration is caught at setup, not at month-end.

export interface CategoryDto {
  code: string; name?: string; name_th?: string;
  revenue_account?: string | null; cogs_account?: string | null;
  inventory_account?: string | null; valuation_account?: string | null;
  vat_code?: string | null; wht_income_type?: string | null; default_location_id?: string | null;
  active?: boolean;
}
export interface TaxCodeDto {
  code: string; name?: string; name_th?: string; kind?: 'vat' | 'wht'; rate?: number;
  output_account?: string | null; input_account?: string | null; wht_account?: string | null;
  wht_income_type?: string | null; inclusive?: boolean; active?: boolean;
}
export interface ItemProfileDto {
  category_id?: number | null;
  revenue_account?: string | null; cogs_account?: string | null;
  inventory_account?: string | null; valuation_account?: string | null;
  vat_code?: string | null; wht_income_type?: string | null; default_location_id?: string | null;
  // Item-master fields (docs master-data audit Phase 2) — exist on `items` since earlier phases (barcode
  // scan-to-add, MRP lot-sizing, FA-10 capital routing) but had no maintenance surface on this screen.
  barcode?: string | null; uom?: string | null; base_uom?: string | null; conversion_factor?: number | null;
  unit_price?: number | null; temperature_type?: string | null; bu_id?: string | null;
  min_stock?: number | null; max_stock?: number | null; avg_daily_usage?: number | null; lead_time_days?: number | null;
  min_order_qty?: number | null; order_multiple?: number | null; order_cost?: number | null; holding_cost?: number | null;
  is_fixed_asset?: boolean; default_asset_category_id?: number | null;
}
export interface WarehouseAccountsDto {
  location_name?: string | null; zone?: string | null; type?: string | null;
  capacity?: number | null; temperature?: string | null; active?: boolean; notes?: string | null;
  inventory_account?: string | null; adjustment_account?: string | null;
}

@Injectable()
export class ItemSetupService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private tenant(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'A tenant context is required', messageTh: 'ต้องอยู่ในบริบทผู้เช่า' });
    return user.tenantId;
  }

  // Fail-closed at setup: every non-null GL account must exist in the canonical CoA and be postable.
  private async assertPostable(codes: (string | null | undefined)[]) {
    const wanted = [...new Set(codes.filter((c): c is string => !!c))];
    if (!wanted.length) return;
    const rows = await this.db.select({ code: accounts.code, isPostable: accounts.isPostable }).from(accounts);
    const byCode = new Map(rows.map(r => [r.code, r.isPostable]));
    for (const c of wanted) {
      if (!byCode.has(c) || byCode.get(c) === false) {
        throw new BadRequestException({
          code: 'INVALID_POSTING_ACCOUNT',
          message: `Account '${c}' does not exist in the chart of accounts or is not postable`,
          messageTh: `บัญชี '${c}' ไม่มีอยู่ในผังบัญชีหรือไม่สามารถบันทึกรายการได้`,
        });
      }
    }
  }

  // ── Item categories ───────────────────────────────────────────────────────────────────────
  async listCategories(user: JwtUser) {
    const t = this.tenant(user);
    const rows = await this.db.select().from(itemCategories).where(eq(itemCategories.tenantId, t)).orderBy(asc(itemCategories.code));
    return { categories: rows.map(shapeCategory), count: rows.length };
  }

  async createCategory(dto: CategoryDto, user: JwtUser) {
    const t = this.tenant(user);
    if (!dto.code?.trim()) throw new BadRequestException({ code: 'CODE_REQUIRED', message: 'A category code is required', messageTh: 'ต้องระบุรหัสหมวด' });
    await this.assertPostable([dto.revenue_account, dto.cogs_account, dto.inventory_account, dto.valuation_account]);
    const [row] = await this.db.insert(itemCategories).values({
      tenantId: t, code: dto.code.trim(), name: dto.name ?? null, nameTh: dto.name_th ?? null,
      revenueAccount: dto.revenue_account ?? null, cogsAccount: dto.cogs_account ?? null,
      inventoryAccount: dto.inventory_account ?? null, valuationAccount: dto.valuation_account ?? null,
      vatCode: dto.vat_code ?? null, whtIncomeType: dto.wht_income_type ?? null,
      defaultLocationId: dto.default_location_id ?? null, active: dto.active ?? true,
    }).onConflictDoNothing().returning();
    if (!row) throw new BadRequestException({ code: 'CATEGORY_EXISTS', message: `Item category ${dto.code} already exists`, messageTh: 'มีหมวดสินค้านี้แล้ว' });
    return shapeCategory(row);
  }

  async updateCategory(code: string, dto: Partial<CategoryDto>, user: JwtUser) {
    const t = this.tenant(user);
    await this.assertPostable([dto.revenue_account, dto.cogs_account, dto.inventory_account, dto.valuation_account]);
    const [row] = await this.db.update(itemCategories).set({
      name: dto.name, nameTh: dto.name_th,
      revenueAccount: dto.revenue_account, cogsAccount: dto.cogs_account,
      inventoryAccount: dto.inventory_account, valuationAccount: dto.valuation_account,
      vatCode: dto.vat_code, whtIncomeType: dto.wht_income_type,
      defaultLocationId: dto.default_location_id, active: dto.active, updatedAt: new Date(),
    }).where(and(eq(itemCategories.tenantId, t), eq(itemCategories.code, code))).returning();
    if (!row) throw new NotFoundException({ code: 'CATEGORY_NOT_FOUND', message: `Item category ${code} not found`, messageTh: 'ไม่พบหมวดสินค้า' });
    return shapeCategory(row);
  }

  // ── Tax codes ─────────────────────────────────────────────────────────────────────────────
  async listTaxCodes(user: JwtUser) {
    const t = this.tenant(user);
    const rows = await this.db.select().from(taxCodes).where(eq(taxCodes.tenantId, t)).orderBy(asc(taxCodes.code));
    return { tax_codes: rows.map(shapeTaxCode), count: rows.length };
  }

  async createTaxCode(dto: TaxCodeDto, user: JwtUser) {
    const t = this.tenant(user);
    if (!dto.code?.trim()) throw new BadRequestException({ code: 'CODE_REQUIRED', message: 'A tax code is required', messageTh: 'ต้องระบุรหัสภาษี' });
    this.assertRate(dto.rate);
    await this.assertPostable([dto.output_account, dto.input_account, dto.wht_account]);
    const [row] = await this.db.insert(taxCodes).values({
      tenantId: t, code: dto.code.trim(), name: dto.name ?? null, nameTh: dto.name_th ?? null,
      kind: dto.kind ?? 'vat', rate: String(dto.rate ?? 0),
      outputAccount: dto.output_account ?? null, inputAccount: dto.input_account ?? null,
      whtAccount: dto.wht_account ?? null, whtIncomeType: dto.wht_income_type ?? null,
      inclusive: dto.inclusive ?? false, active: dto.active ?? true,
    }).onConflictDoNothing().returning();
    if (!row) throw new BadRequestException({ code: 'TAX_CODE_EXISTS', message: `Tax code ${dto.code} already exists`, messageTh: 'มีรหัสภาษีนี้แล้ว' });
    return shapeTaxCode(row);
  }

  async updateTaxCode(code: string, dto: Partial<TaxCodeDto>, user: JwtUser) {
    const t = this.tenant(user);
    this.assertRate(dto.rate);
    await this.assertPostable([dto.output_account, dto.input_account, dto.wht_account]);
    const [row] = await this.db.update(taxCodes).set({
      name: dto.name, nameTh: dto.name_th, kind: dto.kind, rate: dto.rate != null ? String(dto.rate) : undefined,
      outputAccount: dto.output_account, inputAccount: dto.input_account, whtAccount: dto.wht_account,
      whtIncomeType: dto.wht_income_type, inclusive: dto.inclusive, active: dto.active, updatedAt: new Date(),
    }).where(and(eq(taxCodes.tenantId, t), eq(taxCodes.code, code))).returning();
    if (!row) throw new NotFoundException({ code: 'TAX_CODE_NOT_FOUND', message: `Tax code ${code} not found`, messageTh: 'ไม่พบรหัสภาษี' });
    return shapeTaxCode(row);
  }

  private assertRate(rate?: number) {
    if (rate == null) return;
    if (!(rate >= 0 && rate <= 1)) throw new BadRequestException({ code: 'BAD_RATE', message: 'rate must be between 0 and 1 (e.g. 0.07 for 7%)', messageTh: 'อัตราต้องอยู่ระหว่าง 0 ถึง 1 (เช่น 0.07 = 7%)' });
  }

  // ── Per-item posting profile (override) ─────────────────────────────────────────────────────
  async getItem(itemId: string, _user: JwtUser) {
    const [it] = await this.db.select().from(items).where(eq(items.itemId, itemId)).limit(1);
    if (!it) throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: `Item ${itemId} not found`, messageTh: 'ไม่พบสินค้า' });
    return shapeItem(it);
  }

  async updateItemProfile(itemId: string, dto: ItemProfileDto, _user: JwtUser) {
    await this.assertPostable([dto.revenue_account, dto.cogs_account, dto.inventory_account, dto.valuation_account]);
    const num = (v?: number | null) => (v != null ? String(v) : undefined);
    const [row] = await this.db.update(items).set({
      categoryId: dto.category_id, revenueAccount: dto.revenue_account, cogsAccount: dto.cogs_account,
      inventoryAccount: dto.inventory_account, valuationAccount: dto.valuation_account,
      vatCode: dto.vat_code, whtIncomeType: dto.wht_income_type, defaultLocationId: dto.default_location_id,
      barcode: dto.barcode, uom: dto.uom, baseUom: dto.base_uom, conversionFactor: num(dto.conversion_factor),
      unitPrice: num(dto.unit_price), temperatureType: dto.temperature_type, buId: dto.bu_id,
      minStock: num(dto.min_stock), maxStock: num(dto.max_stock), avgDailyUsage: num(dto.avg_daily_usage), leadTimeDays: num(dto.lead_time_days),
      minOrderQty: num(dto.min_order_qty), orderMultiple: num(dto.order_multiple), orderCost: num(dto.order_cost), holdingCost: num(dto.holding_cost),
      isFixedAsset: dto.is_fixed_asset, defaultAssetCategoryId: dto.default_asset_category_id,
    }).where(eq(items.itemId, itemId)).returning();
    if (!row) throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: `Item ${itemId} not found`, messageTh: 'ไม่พบสินค้า' });
    return shapeItem(row);
  }

  // ── Item lifecycle + relationships (master-data audit Phase 10) ─────────────────────────────────
  private async itemRow(itemId: string) {
    const [it] = await this.db.select().from(items).where(eq(items.itemId, itemId)).limit(1);
    if (!it) throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: `Item ${itemId} not found`, messageTh: 'ไม่พบสินค้า' });
    return it;
  }

  // Lifecycle: active | inactive | discontinued (+ an optional replacement pointer). `items` is a shared
  // master, so status is tenant-neutral (a discontinued item is discontinued for everyone).
  async setItemStatus(itemId: string, dto: { status: string; superseded_by?: string | null }, _user: JwtUser) {
    await this.itemRow(itemId);
    const set: Record<string, unknown> = { status: dto.status };
    if (dto.superseded_by !== undefined) set.supersededBy = dto.superseded_by ? Number((await this.itemRow(dto.superseded_by)).id) : null;
    const [row] = await this.db.update(items).set(set).where(eq(items.itemId, itemId)).returning();
    return shapeItem(row);
  }

  async addItemRelationship(itemId: string, dto: { to_item_id: string; rel_type: string; note?: string }, user: JwtUser) {
    const from = await this.itemRow(itemId);
    if (dto.to_item_id === itemId) throw new BadRequestException({ code: 'SELF_RELATION', message: 'An item cannot relate to itself', messageTh: 'สินค้าไม่สามารถเชื่อมโยงกับตัวเองได้' });
    const to = await this.itemRow(dto.to_item_id);
    try {
      const [row] = await this.db.insert(itemRelationships).values({
        tenantId: user.tenantId ?? null, fromItemId: Number(from.id), toItemId: Number(to.id),
        relType: dto.rel_type, note: dto.note ?? null, createdBy: user.username,
      }).returning();
      return shapeItemRel(row, { item_id: to.itemId, description: to.itemDescription ?? null }, 'outgoing');
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException({ code: 'RELATION_EXISTS', message: 'This relationship already exists', messageTh: 'มีความสัมพันธ์นี้อยู่แล้ว' });
      throw e;
    }
  }

  async listItemRelationships(itemId: string, _user: JwtUser) {
    const from = await this.itemRow(itemId);
    const fid = Number(from.id);
    const toI = alias(items, 'to_i');
    const fromI = alias(items, 'from_i');
    const outgoing = await this.db.select({ r: itemRelationships, code: toI.itemId, desc: toI.itemDescription })
      .from(itemRelationships).innerJoin(toI, eq(itemRelationships.toItemId, toI.id))
      .where(eq(itemRelationships.fromItemId, fid)).orderBy(desc(itemRelationships.id));
    const incoming = await this.db.select({ r: itemRelationships, code: fromI.itemId, desc: fromI.itemDescription })
      .from(itemRelationships).innerJoin(fromI, eq(itemRelationships.fromItemId, fromI.id))
      .where(eq(itemRelationships.toItemId, fid)).orderBy(desc(itemRelationships.id));
    return {
      item_id: itemId,
      relationships: [
        ...outgoing.map((x: any) => shapeItemRel(x.r, { item_id: x.code, description: x.desc ?? null }, 'outgoing')),
        ...incoming.map((x: any) => shapeItemRel(x.r, { item_id: x.code, description: x.desc ?? null }, 'incoming')),
      ],
    };
  }

  async deleteItemRelationship(itemId: string, relId: number, _user: JwtUser) {
    const from = await this.itemRow(itemId);
    const fid = Number(from.id);
    const del = await this.db.delete(itemRelationships)
      .where(and(eq(itemRelationships.id, relId), or(eq(itemRelationships.fromItemId, fid), eq(itemRelationships.toItemId, fid))))
      .returning({ id: itemRelationships.id });
    if (!del.length) throw new NotFoundException({ code: 'RELATION_NOT_FOUND', message: 'Relationship not found', messageTh: 'ไม่พบความสัมพันธ์นี้' });
    return { deleted: true };
  }

  // ── Warehouse (location) account defaults — the lowest determination tier (docs/33 PR5) ──
  async listWarehouses(_user: JwtUser) {
    const rows = await this.db.select().from(locations).orderBy(asc(locations.locationId));
    return { warehouses: rows.map(shapeWarehouse), count: rows.length };
  }

  async updateWarehouseAccounts(locationId: string, dto: WarehouseAccountsDto, _user: JwtUser) {
    await this.assertPostable([dto.inventory_account, dto.adjustment_account]);
    const [row] = await this.db.update(locations).set({
      locationName: dto.location_name, zone: dto.zone, type: dto.type,
      capacity: dto.capacity != null ? String(dto.capacity) : undefined, temperature: dto.temperature, active: dto.active, notes: dto.notes,
      inventoryAccount: dto.inventory_account, adjustmentAccount: dto.adjustment_account,
    }).where(eq(locations.locationId, locationId)).returning();
    if (!row) throw new NotFoundException({ code: 'LOCATION_NOT_FOUND', message: `Warehouse ${locationId} not found`, messageTh: 'ไม่พบคลังสินค้า' });
    return shapeWarehouse(row);
  }
}

function shapeWarehouse(l: any) {
  return {
    location_id: l.locationId, location_name: l.locationName, zone: l.zone, type: l.type,
    capacity: l.capacity != null ? Number(l.capacity) : null, temperature: l.temperature, active: l.active, notes: l.notes,
    inventory_account: l.inventoryAccount, adjustment_account: l.adjustmentAccount,
  };
}

function shapeCategory(c: any) {
  return {
    id: Number(c.id), code: c.code, name: c.name, name_th: c.nameTh,
    revenue_account: c.revenueAccount, cogs_account: c.cogsAccount,
    inventory_account: c.inventoryAccount, valuation_account: c.valuationAccount,
    vat_code: c.vatCode, wht_income_type: c.whtIncomeType, default_location_id: c.defaultLocationId, active: c.active,
  };
}
function shapeTaxCode(c: any) {
  return {
    id: Number(c.id), code: c.code, name: c.name, name_th: c.nameTh, kind: c.kind, rate: Number(c.rate),
    output_account: c.outputAccount, input_account: c.inputAccount, wht_account: c.whtAccount,
    wht_income_type: c.whtIncomeType, inclusive: c.inclusive, active: c.active,
  };
}
function shapeItem(i: any) {
  const n = (v: any) => (v != null ? Number(v) : null);
  return {
    item_id: i.itemId, item_description: i.itemDescription, category: i.category, category_id: i.categoryId != null ? Number(i.categoryId) : null,
    revenue_account: i.revenueAccount, cogs_account: i.cogsAccount, inventory_account: i.inventoryAccount,
    valuation_account: i.valuationAccount, vat_code: i.vatCode, wht_income_type: i.whtIncomeType, default_location_id: i.defaultLocationId,
    barcode: i.barcode, uom: i.uom, base_uom: i.baseUom, conversion_factor: n(i.conversionFactor),
    unit_price: n(i.unitPrice), temperature_type: i.temperatureType, bu_id: i.buId,
    min_stock: n(i.minStock), max_stock: n(i.maxStock), avg_daily_usage: n(i.avgDailyUsage), lead_time_days: n(i.leadTimeDays),
    min_order_qty: n(i.minOrderQty), order_multiple: n(i.orderMultiple), order_cost: n(i.orderCost), holding_cost: n(i.holdingCost),
    is_fixed_asset: i.isFixedAsset === true, default_asset_category_id: i.defaultAssetCategoryId != null ? Number(i.defaultAssetCategoryId) : null,
    status: i.status ?? 'active', superseded_by: i.supersededBy != null ? Number(i.supersededBy) : null,
  };
}

function shapeItemRel(r: any, other: { item_id: string; description: string | null }, direction: 'outgoing' | 'incoming') {
  // `party` shape mirrors the customer/vendor relationships so the shared web section renders it uniformly.
  return { id: Number(r.id), rel_type: r.relType, direction, party: { item_id: other.item_id, name: other.description || other.item_id }, note: r.note ?? null, created_by: r.createdBy, created_at: r.createdAt };
}
