import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { itemCategories, taxCodes, items, accounts } from '../../database/schema';
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
    const [row] = await this.db.update(items).set({
      categoryId: dto.category_id, revenueAccount: dto.revenue_account, cogsAccount: dto.cogs_account,
      inventoryAccount: dto.inventory_account, valuationAccount: dto.valuation_account,
      vatCode: dto.vat_code, whtIncomeType: dto.wht_income_type, defaultLocationId: dto.default_location_id,
    }).where(eq(items.itemId, itemId)).returning();
    if (!row) throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: `Item ${itemId} not found`, messageTh: 'ไม่พบสินค้า' });
    return shapeItem(row);
  }
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
  return {
    item_id: i.itemId, item_description: i.itemDescription, category: i.category, category_id: i.categoryId != null ? Number(i.categoryId) : null,
    revenue_account: i.revenueAccount, cogs_account: i.cogsAccount, inventory_account: i.inventoryAccount,
    valuation_account: i.valuationAccount, vat_code: i.vatCode, wht_income_type: i.whtIncomeType, default_location_id: i.defaultLocationId,
  };
}
