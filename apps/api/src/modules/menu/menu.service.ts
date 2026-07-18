import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, asc, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { menuCategories, menuItems, modifierGroups, modifierOptions, menuItemModifierGroups } from '../../database/schema';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import type { CreateCategoryDto, CreateItemDto, UpdateItemDto, CreateModifierGroupDto, ResolveLineDto } from './dto';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// Day-parting: is the item sellable right now on Asia/Bangkok business time (UTC+7, no DST)?
// null window/day-mask ⇒ always available; a start>end window wraps past midnight.
function availableNow(it: any, atMs = Date.now()): boolean {
  const bkk = new Date(atMs + 7 * 3600 * 1000);
  const day = bkk.getUTCDay();                          // 0=Sun..6=Sat (Bangkok)
  const minOfDay = bkk.getUTCHours() * 60 + bkk.getUTCMinutes();
  if (typeof it.availDays === 'string' && it.availDays.length === 7 && it.availDays[day] !== '1') return false;
  const s = it.availStartMin, e = it.availEndMin;
  if (s == null && e == null) return true;
  const start = s ?? 0, end = e ?? 1440;
  return start <= end ? (minOfDay >= start && minOfDay < end) : (minOfDay >= start || minOfDay < end);
}

@Injectable()
export class MenuService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // ── categories ──
  async createCategory(dto: CreateCategoryDto, user: JwtUser) {
    const db = this.db;
    const [c] = await db.insert(menuCategories).values({ tenantId: user.tenantId ?? null, code: dto.code, name: dto.name, nameEn: dto.name_en ?? null, color: dto.color ?? null, sort: dto.sort ?? 0 }).onConflictDoNothing().returning();
    return c ? shapeCat(c) : { code: dto.code, note: 'exists' };
  }
  async listCategories(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(menuCategories).where(eq(menuCategories.active, true)).orderBy(asc(menuCategories.sort), asc(menuCategories.id));
    return { categories: rows.map(shapeCat), count: rows.length };
  }

  // ── items ──
  async createItem(dto: CreateItemDto, user: JwtUser) {
    const db = this.db;
    const [it] = await db.insert(menuItems).values({
      tenantId: user.tenantId ?? null, sku: dto.sku, name: dto.name, nameEn: dto.name_en ?? null, categoryId: dto.category_id ?? null,
      type: dto.type, price: fx(dto.price, 2), cost: dto.cost != null ? fx(dto.cost, 2) : null, stationCode: dto.station_code ?? 'main',
      prepMinutes: dto.prep_minutes ?? 10, taxType: dto.tax_type, trackStock: dto.track_stock ?? false, imageUrl: dto.image_url ?? null,
      description: dto.description ?? null, sort: dto.sort ?? 0,
      isRecommended: dto.is_recommended ?? false, kdsPriority: dto.kds_priority ?? 0,
      availDays: dto.avail_days ?? null, availStartMin: dto.avail_start_min ?? null, availEndMin: dto.avail_end_min ?? null,
    }).onConflictDoNothing().returning();
    if (!it) throw new BadRequestException({ code: 'SKU_EXISTS', message: 'SKU already exists', messageTh: 'รหัสสินค้าซ้ำ' });
    if (dto.modifier_group_ids?.length) for (const gid of dto.modifier_group_ids) await this.attachGroupRow(Number(it.id), gid, user);
    return this.getItem(dto.sku, user);
  }

  async updateItem(sku: string, dto: UpdateItemDto, user: JwtUser) {
    const db = this.db;
    const it = await this.loadItem(sku);
    const set: any = { updatedAt: new Date() };
    if (dto.name != null) set.name = dto.name;
    if (dto.name_en != null) set.nameEn = dto.name_en;
    if (dto.category_id != null) set.categoryId = dto.category_id;
    if (dto.price != null) set.price = fx(dto.price, 2);
    if (dto.cost != null) set.cost = fx(dto.cost, 2);
    if (dto.station_code != null) set.stationCode = dto.station_code;
    if (dto.prep_minutes != null) set.prepMinutes = dto.prep_minutes;
    if (dto.tax_type != null) set.taxType = dto.tax_type;
    if (dto.track_stock != null) set.trackStock = dto.track_stock;
    if (dto.image_url != null) set.imageUrl = dto.image_url;
    if (dto.description != null) set.description = dto.description;
    if (dto.sort != null) set.sort = dto.sort;
    if (dto.active != null) set.active = dto.active;
    if (dto.is_recommended != null) set.isRecommended = dto.is_recommended;
    if (dto.kds_priority != null) set.kdsPriority = dto.kds_priority;
    if (dto.avail_days !== undefined) set.availDays = dto.avail_days;
    if (dto.avail_start_min !== undefined) set.availStartMin = dto.avail_start_min;
    if (dto.avail_end_min !== undefined) set.availEndMin = dto.avail_end_min;
    await db.update(menuItems).set(set).where(eq(menuItems.id, it.id));
    return this.getItem(sku, user);
  }

  // 86 / un-86 a menu item
  async setAvailability(sku: string, available: boolean, user: JwtUser) {
    const db = this.db;
    const it = await this.loadItem(sku);
    await db.update(menuItems).set({ isAvailable: available, updatedAt: new Date() }).where(eq(menuItems.id, it.id));
    return { sku, is_available: available };
  }

  async getItem(sku: string, _user: JwtUser) {
    const db = this.db;
    const it = await this.loadItem(sku);
    const groups = await this.itemGroups(Number(it.id));
    return { ...shapeItem(it), modifier_groups: groups };
  }

  // full menu grouped by category (active + available flags) — what POS renders
  async listMenu(_user: JwtUser) {
    const db = this.db;
    const cats = await db.select().from(menuCategories).where(eq(menuCategories.active, true)).orderBy(asc(menuCategories.sort), asc(menuCategories.id));
    const items = await db.select().from(menuItems).where(eq(menuItems.active, true)).orderBy(asc(menuItems.sort), asc(menuItems.id));
    const linkRows = await db.select({ menuItemId: menuItemModifierGroups.menuItemId }).from(menuItemModifierGroups);
    const modCount = new Map<number, number>();
    for (const l of linkRows) modCount.set(Number(l.menuItemId), (modCount.get(Number(l.menuItemId)) ?? 0) + 1);
    const byCat = new Map<number | null, any[]>();
    for (const it of items) {
      const key = it.categoryId != null ? Number(it.categoryId) : null;
      if (!byCat.has(key)) byCat.set(key, []);
      byCat.get(key)!.push({ ...shapeItem(it), has_modifiers: (modCount.get(Number(it.id)) ?? 0) > 0 });
    }
    const categories = cats.map((c: any) => ({ ...shapeCat(c), items: byCat.get(Number(c.id)) ?? [] }));
    const uncategorized = byCat.get(null) ?? [];
    return { categories, uncategorized, item_count: items.length };
  }

  // full menu for the diner self-order UI: same as listMenu but each item carries its modifier groups +
  // options inlined, so the phone can render the modifier picker without a second (permissioned) round-trip.
  async listMenuForOrder(user: JwtUser) {
    const base = await this.listMenu(user);
    const augment = async (it: any) => ({ ...it, modifier_groups: it.has_modifiers ? await this.itemGroups(Number(it.id)) : [] });
    const categories = [];
    for (const c of base.categories) categories.push({ ...c, items: await Promise.all(c.items.map(augment)) });
    const uncategorized = await Promise.all(base.uncategorized.map(augment));
    return { categories, uncategorized, item_count: base.item_count };
  }

  // ── modifier groups + options ──
  async createModifierGroup(dto: CreateModifierGroupDto, user: JwtUser) {
    const db = this.db;
    if (dto.min_select > dto.max_select) throw new BadRequestException({ code: 'BAD_RANGE', message: 'min_select > max_select', messageTh: 'ขั้นต่ำมากกว่าขั้นสูง' });
    const [g] = await db.insert(modifierGroups).values({ tenantId: user.tenantId ?? null, code: dto.code, name: dto.name, minSelect: dto.min_select, maxSelect: dto.max_select, required: dto.required ?? dto.min_select > 0 }).onConflictDoNothing().returning();
    if (!g) throw new BadRequestException({ code: 'GROUP_EXISTS', message: 'Group code exists', messageTh: 'รหัสกลุ่มตัวเลือกซ้ำ' });
    if (dto.options?.length) await db.insert(modifierOptions).values(dto.options.map((o, i) => ({ tenantId: user.tenantId ?? null, groupId: Number(g.id), name: o.name, priceDelta: fx(o.price_delta, 2), cogsDelta: fx(o.cogs_delta ?? 0, 2), recipeRefId: o.recipe_ref_id ?? null, isDefault: o.is_default ?? false, sort: o.sort ?? i })));
    return this.getGroup(Number(g.id));
  }
  async addOption(groupId: number, opt: { name: string; price_delta: number; cogs_delta?: number; recipe_ref_id?: number; is_default?: boolean; sort?: number }, user: JwtUser) {
    const db = this.db;
    const [g] = await db.select().from(modifierGroups).where(eq(modifierGroups.id, groupId)).limit(1);
    if (!g) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Group not found', messageTh: 'ไม่พบกลุ่มตัวเลือก' });
    await db.insert(modifierOptions).values({ tenantId: user.tenantId ?? null, groupId, name: opt.name, priceDelta: fx(opt.price_delta, 2), cogsDelta: fx(opt.cogs_delta ?? 0, 2), recipeRefId: opt.recipe_ref_id ?? null, isDefault: opt.is_default ?? false, sort: opt.sort ?? 0 });
    return this.getGroup(groupId);
  }
  async listGroups(_user: JwtUser) {
    const db = this.db;
    const groups = await db.select().from(modifierGroups).where(eq(modifierGroups.active, true)).orderBy(asc(modifierGroups.sort), asc(modifierGroups.id));
    const out = [];
    for (const g of groups) out.push(await this.getGroup(Number(g.id)));
    return { groups: out, count: out.length };
  }
  async attachGroup(sku: string, groupId: number, user: JwtUser) {
    const it = await this.loadItem(sku);
    await this.attachGroupRow(Number(it.id), groupId, user);
    return this.getItem(sku, user);
  }
  private async attachGroupRow(menuItemId: number, groupId: number, user: JwtUser) {
    const db = this.db;
    const [g] = await db.select().from(modifierGroups).where(eq(modifierGroups.id, groupId)).limit(1);
    if (!g) throw new BadRequestException({ code: 'GROUP_NOT_FOUND', message: `Modifier group ${groupId} not found`, messageTh: 'ไม่พบกลุ่มตัวเลือก' });
    await db.insert(menuItemModifierGroups).values({ tenantId: user.tenantId ?? null, menuItemId, groupId }).onConflictDoNothing();
  }

  // ── resolve a priced order line (the contract POS / dine-in entry calls) ──
  async resolveLine(dto: ResolveLineDto, _user: JwtUser) {
    const db = this.db;
    const where = dto.item_id != null ? eq(menuItems.id, dto.item_id) : eq(menuItems.sku, dto.sku!);
    const [it] = await db.select().from(menuItems).where(and(where, eq(menuItems.active, true))).limit(1);
    if (!it) throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: 'Menu item not found', messageTh: 'ไม่พบเมนู' });
    if (!it.isAvailable) throw new BadRequestException({ code: 'ITEM_UNAVAILABLE', message: 'Item is unavailable (86)', messageTh: 'เมนูนี้หมด/ปิดการขาย' });
    if (!availableNow(it)) throw new BadRequestException({ code: 'OUTSIDE_HOURS', message: 'Item is not available at this time', messageTh: 'ยังไม่ถึงเวลาขายของเมนูนี้' });

    const groups = await this.itemGroups(Number(it.id));
    const optById = new Map<number, any>();
    for (const g of groups) for (const o of g.options) optById.set(o.option_id, { ...o, group_id: g.group_id, group_name: g.name, min: g.min_select, max: g.max_select, required: g.required });
    const selectedIds = dto.modifier_option_ids ?? [];
    const chosen: any[] = [];
    for (const oid of selectedIds) {
      const o = optById.get(oid);
      if (!o) throw new BadRequestException({ code: 'INVALID_MODIFIER', message: `Option ${oid} not valid for this item`, messageTh: 'ตัวเลือกไม่ถูกต้องสำหรับเมนูนี้' });
      chosen.push(o);
    }
    // per-group min/max enforcement
    for (const g of groups) {
      const count = chosen.filter((c) => c.group_id === g.group_id).length;
      const minReq = g.required ? Math.max(1, g.min_select) : g.min_select;
      if (count < minReq) throw new BadRequestException({ code: 'MODIFIER_REQUIRED', message: `Group "${g.name}" requires >= ${minReq} selection(s)`, messageTh: `ต้องเลือก "${g.name}" อย่างน้อย ${minReq}` });
      if (count > g.max_select) throw new BadRequestException({ code: 'TOO_MANY_MODIFIERS', message: `Group "${g.name}" allows <= ${g.max_select}`, messageTh: `เลือก "${g.name}" ได้ไม่เกิน ${g.max_select}` });
    }
    const unitPrice = round2(n(it.price) + chosen.reduce((a, c) => a + n(c.price_delta), 0));
    const qty = n(dto.qty) || 1;
    const amount = round2(unitPrice * qty);
    // modifier_cogs: standard COGS added by the chosen options for one unit — surfaced so the caller/UI
    // can show menu-engineering margin; the authoritative posting happens at checkout (portal.pos).
    const modifierUnitCogs = round2(chosen.reduce((a, c) => a + n(c.cogs_delta), 0));
    return {
      item_id: Number(it.id), sku: it.sku, name: it.name, qty, unit_price: unitPrice, amount,
      station_code: it.stationCode, prep_minutes: it.prepMinutes, kds_priority: it.kdsPriority ?? 0, tax_type: it.taxType, notes: dto.notes ?? null,
      modifier_option_ids: chosen.map((c) => c.option_id),
      modifier_cogs: modifierUnitCogs,
      modifiers: chosen.map((c) => ({ group_id: c.group_id, group_name: c.group_name, option_id: c.option_id, option_name: c.name, price_delta: n(c.price_delta), cogs_delta: n(c.cogs_delta) })),
    };
  }

  // ── helpers ──
  private async loadItem(sku: string) {
    const db = this.db;
    const [it] = await db.select().from(menuItems).where(eq(menuItems.sku, sku)).limit(1);
    if (!it) throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: 'Menu item not found', messageTh: 'ไม่พบเมนู' });
    return it;
  }
  private async itemGroups(menuItemId: number) {
    const db = this.db;
    const links = await db.select({ groupId: menuItemModifierGroups.groupId }).from(menuItemModifierGroups).where(eq(menuItemModifierGroups.menuItemId, menuItemId));
    const ids = links.map((l: any) => Number(l.groupId));
    if (!ids.length) return [];
    const groups = await db.select().from(modifierGroups).where(and(inArray(modifierGroups.id, ids), eq(modifierGroups.active, true))).orderBy(asc(modifierGroups.sort));
    const opts = await db.select().from(modifierOptions).where(and(inArray(modifierOptions.groupId, ids), eq(modifierOptions.active, true))).orderBy(asc(modifierOptions.sort));
    return groups.map((g: any) => ({
      group_id: Number(g.id), code: g.code, name: g.name, min_select: g.minSelect, max_select: g.maxSelect, required: g.required,
      options: opts.filter((o: any) => Number(o.groupId) === Number(g.id)).map((o: any) => ({ option_id: Number(o.id), name: o.name, price_delta: n(o.priceDelta), cogs_delta: n(o.cogsDelta), recipe_ref_id: o.recipeRefId ?? null, is_default: o.isDefault })),
    }));
  }
  private async getGroup(groupId: number) {
    const db = this.db;
    const [g] = await db.select().from(modifierGroups).where(eq(modifierGroups.id, groupId)).limit(1);
    if (!g) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Modifier group not found', messageTh: 'ไม่พบกลุ่มตัวเลือก' });
    const opts = await db.select().from(modifierOptions).where(and(eq(modifierOptions.groupId, groupId), eq(modifierOptions.active, true))).orderBy(asc(modifierOptions.sort));
    return { group_id: Number(g.id), code: g.code, name: g.name, min_select: g.minSelect, max_select: g.maxSelect, required: g.required, options: opts.map((o: any) => ({ option_id: Number(o.id), name: o.name, price_delta: n(o.priceDelta), cogs_delta: n(o.cogsDelta), recipe_ref_id: o.recipeRefId ?? null, is_default: o.isDefault })) };
  }
}

function shapeCat(c: any) { return { id: Number(c.id), code: c.code, name: c.name, name_en: c.nameEn, color: c.color, sort: c.sort }; }
function shapeItem(it: any) {
  return { id: Number(it.id), sku: it.sku, name: it.name, name_en: it.nameEn, category_id: it.categoryId != null ? Number(it.categoryId) : null, type: it.type, price: n(it.price), cost: it.cost != null ? n(it.cost) : null, station_code: it.stationCode, prep_minutes: it.prepMinutes, tax_type: it.taxType, track_stock: it.trackStock, is_available: it.isAvailable, is_recommended: !!it.isRecommended, kds_priority: it.kdsPriority ?? 0, avail_days: it.availDays ?? null, avail_start_min: it.availStartMin ?? null, avail_end_min: it.availEndMin ?? null, available_now: availableNow(it), image_url: it.imageUrl, description: it.description, sort: it.sort };
}
