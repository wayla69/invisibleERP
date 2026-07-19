import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException, ForbiddenException } from '@nestjs/common';
import { and, asc, desc, eq, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { itemCategories, taxCodes, items, accounts, locations, itemRelationships } from '../../database/schema';
import { isUniqueViolation } from '../../common/db-error';
import { nameSimilarity, normalizeKey } from '../../common/text-similarity';
import { isPlatformAdmin, type JwtUser } from '../../common/decorators';
import { logger } from '../../observability/logger';
import { previewUnusedItems as previewUnusedItemsQuery, purgeUnusedItems as purgeUnusedItemsQuery, forcePurgePreview as forcePurgePreviewQuery, forcePurgeItems as forcePurgeItemsQuery } from './item-cleanup';

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
  supply_type?: string | null; // 'goods' | 'service' — a service item sells with no stock move / no COGS (docs/52 Phase 2a)
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
      unitPrice: num(dto.unit_price), temperatureType: dto.temperature_type, buId: dto.bu_id, supplyType: dto.supply_type ?? undefined,
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

  // ── Match-merge / DQM (master-data audit Phase 11) ───────────────────────────────────────────────
  // Detect probable duplicate items in the shared catalogue: exact barcode match plus fuzzy description
  // similarity (app-side trigram — pg_trgm isn't enabled here). `items` is a global master (no tenant_id),
  // so this scans the whole catalogue. Read-only review queue for the merge step below.
  async findDuplicateItems(_user: JwtUser) {
    const rows = await this.db.select().from(items).where(ne(items.status, 'merged')).orderBy(desc(items.id)).limit(2000);
    const used = new Set<number>();
    const groups: any[] = [];
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i]; if (!a || used.has(Number(a.id))) continue;
      const dups: any[] = [];
      for (let j = i + 1; j < rows.length; j++) {
        const b = rows[j]; if (!b || used.has(Number(b.id))) continue;
        const reasons: string[] = [];
        if (a.barcode && b.barcode && normalizeKey(a.barcode) === normalizeKey(b.barcode)) reasons.push('barcode');
        const score = nameSimilarity(a.itemDescription, b.itemDescription);
        if (score >= 0.6) reasons.push('description');
        if (reasons.length) { dups.push({ ...shapeItem(b), score: Math.round(score * 100) / 100, reasons }); used.add(Number(b.id)); }
      }
      if (dups.length) { used.add(Number(a.id)); groups.push({ primary: shapeItem(a), duplicates: dups }); }
    }
    return { groups, count: groups.length };
  }

  // Merge a duplicate item INTO a survivor: repoint the duplicate's child rows (by the TEXT item_id key) to
  // the survivor, drop the duplicate's advisory relationships, fill any blank survivor field from the
  // duplicate (survivorship), and soft-retire the duplicate (status='merged' + merged_into/by/at). Atomic — a
  // unique-key collision rolls back and surfaces MERGE_CONFLICT. Because a merge rewrites transactions across
  // EVERY tenant (items are shared), it is gated to the platform owner (god); a per-tenant Admin is rejected.
  async mergeItems(survivorItemId: string, duplicateItemId: string, user: JwtUser) {
    if (!isPlatformAdmin(user.username)) throw new ForbiddenException({ code: 'ITEM_MERGE_HQ_ONLY', message: 'Items are a shared master — only the platform owner may merge them', messageTh: 'สินค้าเป็นข้อมูลกลาง — เฉพาะผู้ดูแลแพลตฟอร์มเท่านั้นที่รวมได้' });
    if (survivorItemId === duplicateItemId) throw new BadRequestException({ code: 'SELF_MERGE', message: 'Cannot merge an item into itself', messageTh: 'ไม่สามารถรวมสินค้าเข้ากับตัวเองได้' });
    const survivor = await this.itemRow(survivorItemId);
    const dup = await this.itemRow(duplicateItemId);
    if (dup.status === 'merged') throw new BadRequestException({ code: 'ALREADY_MERGED', message: 'Duplicate is already merged', messageTh: 'สินค้ารายการนี้ถูกรวมไปแล้ว' });
    try {
      await this.db.transaction(async (tx: any) => {
        await tx.execute(sql`SELECT md_merge_repoint_text('item_id', 'items', ${survivor.itemId}, ${dup.itemId})`);
        // re-parent any successor pointers that named the duplicate as their replacement
        await tx.update(items).set({ supersededBy: Number(survivor.id) }).where(eq(items.supersededBy, Number(dup.id)));
        // drop the duplicate's advisory relationships (bigint item refs, so untouched by the text repoint)
        await tx.delete(itemRelationships).where(or(eq(itemRelationships.fromItemId, Number(dup.id)), eq(itemRelationships.toItemId, Number(dup.id))));
        const fill: Record<string, unknown> = {};
        const pick = (k: string, s: unknown, d: unknown) => { if ((s === null || s === undefined || s === '') && d !== null && d !== undefined && d !== '') fill[k] = d; };
        pick('itemDescription', survivor.itemDescription, dup.itemDescription); pick('barcode', survivor.barcode, dup.barcode);
        pick('uom', survivor.uom, dup.uom); pick('baseUom', survivor.baseUom, dup.baseUom); pick('category', survivor.category, dup.category);
        pick('categoryId', survivor.categoryId, dup.categoryId); pick('temperatureType', survivor.temperatureType, dup.temperatureType);
        if (Object.keys(fill).length) await tx.update(items).set(fill).where(eq(items.id, Number(survivor.id)));
        await tx.update(items).set({ status: 'merged', mergedInto: Number(survivor.id), mergedBy: user.username, mergedAt: new Date() }).where(eq(items.id, Number(dup.id)));
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException({ code: 'MERGE_CONFLICT', message: 'Survivor and duplicate both own a row with the same key — resolve manually', messageTh: 'สินค้าทั้งสองมีรายการที่ซ้ำกัน กรุณาแก้ไขก่อนรวม' });
      throw e;
    }
    return { survivor_item_id: survivorItemId, merged_item_id: duplicateItemId, merged: true };
  }

  // ── Global item-master garbage collection (god-only) ─────────────────────────────────────────────────
  // `items` is a SHARED master (no tenant_id), so the tenant factory-reset/purge — which clear only
  // tenant_id-scoped tables — leave a wiped company's catalogue rows behind, and they keep appearing in every
  // tenant's /shop. These two ops let the platform owner delete exactly the items NO tenant references any
  // more, keeping items another company still uses. Gated to the platform owner here (defence in depth) AND
  // exposed only on @PlatformAdmin routes (which keep the full cross-tenant RLS bypass even when a god is
  // scoped to one company via act-as) — so "unreferenced" is computed across EVERY tenant, never per-company.
  private assertItemGcAllowed(user: JwtUser) {
    if (!isPlatformAdmin(user.username)) {
      throw new ForbiddenException({ code: 'ITEM_PURGE_HQ_ONLY', message: 'Items are a shared master — only the platform owner may purge unused items', messageTh: 'สินค้าเป็นข้อมูลกลาง — เฉพาะผู้ดูแลแพลตฟอร์มเท่านั้นที่ล้างสินค้าที่ไม่มีใครใช้ได้' });
    }
  }

  // Dry-run: how many items would be collected (+ a bounded sample), without deleting anything.
  async previewUnusedItems(user: JwtUser) {
    this.assertItemGcAllowed(user);
    return previewUnusedItemsQuery(this.db);
  }

  // Destructive purge — requires typing the exact confirm phrase. Idempotent (a second run collects nothing).
  async purgeUnusedItems(user: JwtUser, confirm: string) {
    this.assertItemGcAllowed(user);
    if ((confirm ?? '').trim() !== 'PURGE-UNUSED-ITEMS') {
      throw new BadRequestException({ code: 'CONFIRM_MISMATCH', message: 'Type PURGE-UNUSED-ITEMS to confirm the purge', messageTh: 'พิมพ์ PURGE-UNUSED-ITEMS เพื่อยืนยันการล้างสินค้า' });
    }
    const result = await purgeUnusedItemsQuery(this.db);
    logger.warn({ event: 'items_unused_purged', by: user.username, items: result.items_deleted, images: result.images_deleted }, 'unused shared-catalogue items purged (god)');
    return { status: 'purged', ...result };
  }

  // FORCE purge (god-only, DANGEROUS) — deletes items EVEN IF a company still references them, wiping those
  // references across every tenant. `item_ids` targets specific products; omitted ⇒ the whole catalogue. The
  // preview is a read-only blast-radius report (which companies lose how many referencing rows) — always show
  // it before the destructive call. The purge needs a distinct strong confirm so it can't be a normal-purge slip.
  async forcePurgePreview(user: JwtUser, itemIds?: string[]) {
    this.assertItemGcAllowed(user);
    return forcePurgePreviewQuery(this.db, itemIds);
  }

  async forcePurgeItems(user: JwtUser, itemIds: string[] | undefined, confirm: string) {
    this.assertItemGcAllowed(user);
    if ((confirm ?? '').trim() !== 'FORCE-PURGE-ITEMS') {
      throw new BadRequestException({ code: 'CONFIRM_MISMATCH', message: 'Type FORCE-PURGE-ITEMS to confirm the forced deletion', messageTh: 'พิมพ์ FORCE-PURGE-ITEMS เพื่อยืนยันการลบแบบบังคับ' });
    }
    const result = await forcePurgeItemsQuery(this.db, itemIds);
    logger.warn({ event: 'items_force_purged', by: user.username, items: result.items_deleted, ref_rows: result.ref_rows_deleted, scoped: !!(itemIds && itemIds.length), blocked: result.blocked }, 'FORCE-purged shared-catalogue items incl. cross-tenant references (god)');
    return { status: 'force_purged', ...result };
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
    unit_price: n(i.unitPrice), temperature_type: i.temperatureType, bu_id: i.buId, supply_type: i.supplyType ?? 'goods',
    min_stock: n(i.minStock), max_stock: n(i.maxStock), avg_daily_usage: n(i.avgDailyUsage), lead_time_days: n(i.leadTimeDays),
    min_order_qty: n(i.minOrderQty), order_multiple: n(i.orderMultiple), order_cost: n(i.orderCost), holding_cost: n(i.holdingCost),
    is_fixed_asset: i.isFixedAsset === true, default_asset_category_id: i.defaultAssetCategoryId != null ? Number(i.defaultAssetCategoryId) : null,
    status: i.status ?? 'active', superseded_by: i.supersededBy != null ? Number(i.supersededBy) : null,
    merged_into: i.mergedInto != null ? Number(i.mergedInto) : null,
  };
}

function shapeItemRel(r: any, other: { item_id: string; description: string | null }, direction: 'outgoing' | 'incoming') {
  // `party` shape mirrors the customer/vendor relationships so the shared web section renders it uniformly.
  return { id: Number(r.id), rel_type: r.relType, direction, party: { item_id: other.item_id, name: other.description || other.item_id }, note: r.note ?? null, created_by: r.createdBy, created_at: r.createdAt };
}
