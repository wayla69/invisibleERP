import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { items, itemCategories, taxCodes, featureFlags, accounts, locations, assetCategories } from '../../database/schema';

// Item-posting account determination (docs/33, GL-21). Resolves the GL/VAT/WHT accounts a posting should use
// FROM THE ITEM, applying precedence: item column → its category (item_categories) → null (the caller then
// falls back to its hardcoded/global posting-rule default). Gated by the per-tenant `posting_determination`
// feature flag (default OFF) so an un-opted-in tenant behaves EXACTLY as before — every resolve returns nulls
// and the caller keeps its literals. When ON, a resolved override is validated to be a real, postable GL
// account (GL-21 fail-closed) before it can reach the ledger.

export interface ItemAccounts {
  revenueAccount: string | null;
  cogsAccount: string | null;
  inventoryAccount: string | null;
  valuationAccount: string | null;
  adjustmentAccount: string | null;
  vatCode: string | null;
  whtIncomeType: string | null;
}

const EMPTY: ItemAccounts = {
  revenueAccount: null, cogsAccount: null, inventoryAccount: null,
  valuationAccount: null, adjustmentAccount: null, vatCode: null, whtIncomeType: null,
};

@Injectable()
export class AccountDeterminationService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  /** Is item-posting determination opted in for this tenant? (default OFF → literal parity). */
  async enabled(tenantId: number | null | undefined): Promise<boolean> {
    if (tenantId == null) return false;
    const [f] = await this.db.select().from(featureFlags)
      .where(and(eq(featureFlags.tenantId, tenantId), eq(featureFlags.flagKey, 'posting_determination'))).limit(1);
    return !!f?.enabled;
  }

  /**
   * Resolve an item's account/tax overrides. Returns all-nulls when determination is off for the tenant or
   * nothing is configured, so the caller's `resolved.x ?? LITERAL` keeps today's behavior. Any non-null GL
   * account is validated to be a real postable account (GL-21) — a typo'd/unpostable override fails closed
   * rather than posting to a bad account.
   */
  async resolveItemAccounts(tenantId: number | null | undefined, itemId: string, locationId?: string | null): Promise<ItemAccounts> {
    if (!(await this.enabled(tenantId))) return { ...EMPTY };
    const [it] = await this.db.select().from(items).where(eq(items.itemId, itemId)).limit(1);
    if (!it) return { ...EMPTY };
    let cat: typeof itemCategories.$inferSelect | undefined;
    if (it.categoryId != null && tenantId != null) {
      [cat] = await this.db.select().from(itemCategories)
        .where(and(eq(itemCategories.id, it.categoryId), eq(itemCategories.tenantId, tenantId))).limit(1);
    }
    // Warehouse tier (lowest before the control literal): its default inventory/adjustment account.
    let loc: typeof locations.$inferSelect | undefined;
    if (locationId) [loc] = await this.db.select().from(locations).where(eq(locations.locationId, locationId)).limit(1);
    const pick = (...xs: (string | null | undefined)[]): string | null => xs.find((x) => x != null) ?? null;
    const resolved: ItemAccounts = {
      revenueAccount: pick(it.revenueAccount, cat?.revenueAccount),
      cogsAccount: pick(it.cogsAccount, cat?.cogsAccount),
      inventoryAccount: pick(it.inventoryAccount, cat?.inventoryAccount, loc?.inventoryAccount),
      valuationAccount: pick(it.valuationAccount, cat?.valuationAccount),
      adjustmentAccount: pick(loc?.adjustmentAccount),
      vatCode: pick(it.vatCode, cat?.vatCode),
      whtIncomeType: pick(it.whtIncomeType, cat?.whtIncomeType),
    };
    await this.assertPostable(`Item ${itemId}`, [
      resolved.revenueAccount, resolved.cogsAccount, resolved.inventoryAccount, resolved.valuationAccount, resolved.adjustmentAccount,
    ]);
    return resolved;
  }

  /**
   * docs/43 PR-3 (owner decision Q2) — asset-account determination at the asset_categories grain.
   * Mirrors resolveItemAccounts: gated by the SAME per-tenant `posting_determination` flag (default OFF →
   * all-nulls, callers keep their literal/posting-rule path), and any resolved account is GL-21-validated
   * postable. When ON, the category's asset / accum-dep / dep-expense columns drive acquisition and the
   * depreciation run for assets in that category; the DEPRECIATION.FA posting-rule stays the tenant-wide
   * fallback layer beneath it.
   */
  async resolveAssetCategoryAccounts(tenantId: number | null | undefined, categoryId: number | null | undefined):
    Promise<{ assetAccount: string | null; accumDepAccount: string | null; depExpenseAccount: string | null }> {
    const none = { assetAccount: null, accumDepAccount: null, depExpenseAccount: null };
    if (categoryId == null || !(await this.enabled(tenantId))) return none;
    const [cat] = await this.db.select().from(assetCategories).where(eq(assetCategories.id, categoryId)).limit(1);
    if (!cat) return none;
    const resolved = {
      assetAccount: cat.assetAccount ?? null,
      accumDepAccount: cat.accumDepAccount ?? null,
      depExpenseAccount: cat.depExpenseAccount ?? null,
    };
    await this.assertPostable(`asset category ${cat.code}`, [resolved.assetAccount, resolved.accumDepAccount, resolved.depExpenseAccount]);
    return resolved;
  }

  /** GL-21 fail-closed check for a set of account codes — exposed for setup-time validation (asset-category save). */
  async assertAccountsPostable(label: string, codes: (string | null | undefined)[]) {
    await this.assertPostable(label, codes.map((c) => c ?? null));
  }

  // GL-21: a resolved account override must exist in the canonical COA and be postable.
  // `subject` names the carrier of the bad account in the error (an item id, or "asset category X").
  private async assertPostable(subject: string, codes: (string | null)[]) {
    const wanted = [...new Set(codes.filter((c): c is string => !!c))];
    if (!wanted.length) return;
    const rows = await this.db.select({ code: accounts.code, isPostable: accounts.isPostable }).from(accounts);
    const byCode = new Map(rows.map(r => [r.code, r.isPostable]));
    for (const c of wanted) {
      if (!byCode.has(c)) {
        throw new BadRequestException({
          code: 'INVALID_POSTING_ACCOUNT',
          message: `${subject}: posting account '${c}' does not exist in the chart of accounts`,
          messageTh: `${subject}: บัญชี '${c}' ไม่มีอยู่ในผังบัญชี`,
        });
      }
      if (byCode.get(c) === false) {
        throw new BadRequestException({
          code: 'INVALID_POSTING_ACCOUNT',
          message: `${subject}: posting account '${c}' is not postable (a header/control account)`,
          messageTh: `${subject}: บัญชี '${c}' ไม่สามารถบันทึกรายการได้ (เป็นบัญชีหัว/คุม)`,
        });
      }
    }
  }

  /** Resolve a VAT tax-code to its rate + output/input accounts (null if unknown/disabled). */
  async resolveTaxCode(tenantId: number | null | undefined, code: string | null): Promise<typeof taxCodes.$inferSelect | null> {
    if (!code || tenantId == null) return null;
    const [tc] = await this.db.select().from(taxCodes)
      .where(and(eq(taxCodes.tenantId, tenantId), eq(taxCodes.code, code), eq(taxCodes.active, true))).limit(1);
    return tc ?? null;
  }

  /**
   * The item's default stock location (item → its category), or null when determination is off or none is set
   * — the caller then keeps its own default (WH-MAIN). docs/33 PR7.
   */
  async resolveDefaultLocation(tenantId: number | null | undefined, itemId: string): Promise<string | null> {
    if (!(await this.enabled(tenantId))) return null;
    const [it] = await this.db.select().from(items).where(eq(items.itemId, itemId)).limit(1);
    if (it?.defaultLocationId) return it.defaultLocationId;
    if (it?.categoryId != null && tenantId != null) {
      const [cat] = await this.db.select().from(itemCategories)
        .where(and(eq(itemCategories.id, it.categoryId), eq(itemCategories.tenantId, tenantId))).limit(1);
      return cat?.defaultLocationId ?? null;
    }
    return null;
  }
}
