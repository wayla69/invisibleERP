import { BadRequestException } from '@nestjs/common';
import { eq, and, inArray, ne, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import {
  dineInOrderItems, custPosSales, custPosItems, menuItems,
} from '../../database/schema';
import { TaxService } from '../tax/tax.service';
import { LedgerService } from '../ledger/ledger.service';
import { postingDefault } from '../ledger/posting-events';
import { RecipeService } from '../menu/recipe.service';
import { MemberService } from '../loyalty/member.service';
import { GiftCardService } from '../giftcards/gift-card.service';
import { PromoEngineService } from '../marketing/promo-engine.service';
import { VouchersService, type VoucherCheckoutPreview } from '../campaigns/vouchers.service';
import { PricingService } from '../pricing/pricing.service';
import { promotions, promoRedemptions } from '../../database/schema';
import { roundCurrency } from '../tax/money';
import { n, fx, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// Dine-in sale construction (checkout + split-bill) — extracted off DineInService (600-LOC service-size
// headroom round; ctor-body plain class, no DI). buildSale is the ONE place the POS food GL is posted
// (channel-order/qr/split all route through the facade delegators); ctor params are named exactly like
// the facade's fields so the method bodies moved verbatim.
export class DineInSaleService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly tax: TaxService,
    private readonly ledger: LedgerService,
    private readonly promo: PromoEngineService,
    private readonly vouchers: VouchersService,
    private readonly recipe: RecipeService,
    private readonly member: MemberService,
    private readonly gift: GiftCardService,
    private readonly pricing: PricingService,
  ) {}

  // shared: insert cust_pos_sales + items + GL from a dine-in order, applying line/order/promo discounts.
  // VAT is on the discounted base (Thai rule). opts is optional → no-discount path matches the old behavior.
  async buildSale(o: any, saleNo: string, discount: number, user: JwtUser, opts?: { orderDiscountPct?: number; promoCode?: string; voucherCode?: string; lineDiscounts?: Record<string, { discount_pct?: number; discount_amt?: number }>; maxDiscountPct?: number; memberId?: number; pointsRedeem?: { memberId: number; points: number; bahtPerPoint: number; redeemValue: number }; tip?: number; giftCardNo?: string; giftCardAmount?: number; applyPricingRules?: boolean; pricing?: { channel?: string; location?: string; partySize?: number; serviceChargePct?: number; serviceMinParty?: number; surchargePct?: number; rounding?: number; at?: string } }) {
    const db = this.db;
    const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
    const items = await db.select().from(dineInOrderItems).where(and(eq(dineInOrderItems.orderId, Number(o.id)), ne(dineInOrderItems.kdsStatus, 'voided')));
    // B4: opt-in pricing rules. Resolve each order line's sku/category, ask the pricing engine for the
    // time/day/BOGO/qty-break/item/category discounts, and MERGE them through the existing discount path
    // (explicit per-line overrides win). Default off ⇒ byte-identical to the prior behaviour.
    const lineDiscounts: Record<string, { discount_pct?: number; discount_amt?: number }> = { ...(opts?.lineDiscounts ?? {}) };
    let ruleOrderDiscount = 0; const appliedRules: string[] = [];
    if (opts?.applyPricingRules && items.length) {
      // dineInOrderItems.itemId holds the menu SKU (menu-driven lines) or a freeform ref. Resolve the
      // category from the catalog by SKU so category-scope rules apply.
      const skus = Array.from(new Set(items.map((i: any) => String(i.itemId ?? '')).filter((x: string) => x.length)));
      const menus = skus.length ? await db.select().from(menuItems).where(inArray(menuItems.sku, skus)) : [];
      const bySku = new Map<string, any>(menus.map((m: any) => [String(m.sku), m] as [string, any]));
      const rlines = items.map((l: any) => {
        const sku = String(l.itemId ?? l.name);
        const m = bySku.get(sku);
        return { sku, qty: n(l.qty), unit_price: n(l.unitPrice), category: m?.categoryId != null ? String(m.categoryId) : undefined };
      });
      const pr = await this.pricing.ruleDiscountsForLines(rlines, { channel: opts.pricing?.channel, location: opts.pricing?.location, at: opts.pricing?.at });
      items.forEach((l: any, i: number) => {
        const key = String(l.id);
        if (lineDiscounts[key] == null && pr.lineDiscounts[i]! > 0) { lineDiscounts[key] = { discount_amt: pr.lineDiscounts[i]! }; appliedRules.push(...pr!.lineRules[i]!); }
      });
      ruleOrderDiscount = roundCurrency(pr.orderDiscount, 'THB'); appliedRules.push(...pr.orderRules);
    }
    const maxPct = opts?.maxDiscountPct ?? 50;
    let subtotalNet = 0, grossSum = 0, lineDiscTotal = 0;
    const itemRows: any[] = [];
    for (const l of items) {
      const grossLine = roundCurrency(n(l.qty) * n(l.unitPrice), 'THB');
      const ld = lineDiscounts[String(l.id)] ?? lineDiscounts[Number(l.id)];
      let lineDisc = ld ? (ld.discount_amt != null ? roundCurrency(ld.discount_amt, 'THB') : roundCurrency(grossLine * n(ld.discount_pct) / 100, 'THB')) : 0;
      lineDisc = Math.min(lineDisc, grossLine);
      const netLine = roundCurrency(grossLine - lineDisc, 'THB');
      grossSum = roundCurrency(grossSum + grossLine, 'THB'); subtotalNet = roundCurrency(subtotalNet + netLine, 'THB'); lineDiscTotal = roundCurrency(lineDiscTotal + lineDisc, 'THB');
      itemRows.push({ itemId: l.itemId ?? l.name, itemDescription: l.name, qty: String(n(l.qty)), uom: 'จาน', unitPrice: fx(n(l.unitPrice), 2), discountPct: fx(grossLine > 0 ? r2(lineDisc / grossLine * 100) : 0, 2), amount: fx(netLine, 2), isCustom: false });
    }
    // order-level discount: explicit fixed amount, else percent
    if (discount > subtotalNet + 0.01) throw new BadRequestException({ code: 'DISCOUNT_EXCEEDS_SUBTOTAL', message: `Discount ${discount} exceeds subtotal ${subtotalNet}`, messageTh: `ส่วนลด (${discount}) เกินยอดรวม (${subtotalNet})` });
    let orderDisc = discount > 0 ? roundCurrency(discount, 'THB') : (opts?.orderDiscountPct ? roundCurrency(subtotalNet * opts.orderDiscountPct / 100, 'THB') : 0);
    if (ruleOrderDiscount > 0) orderDisc = roundCurrency(Math.max(orderDisc, ruleOrderDiscount), 'THB'); // rule order-discount (best, not stacked on explicit)
    let pe: any = null;
    if (opts?.promoCode) {
      pe = await this.promo.applyPromo({ code: opts.promoCode, subtotalNet, itemIds: items.map((i: any) => String(i.itemId ?? i.name)), tenantId: o.tenantId ?? null });
      orderDisc = Math.max(orderDisc, pe.discount); // promo takes over as the order discount
    }
    // POS-3: voucher/coupon code (campaign voucher OR loyalty member-coupon — one redemption surface).
    // Validation throws coded errors (VOUCHER_EXPIRED / VOUCHER_MIN_SPEND / VOUCHER_ALREADY_REDEEMED /
    // COUPON_EXPIRED / ALREADY_USED …) BEFORE any sale row exists. Like a promo it competes for the
    // order-discount slot (best wins, no stacking); the code is CONSUMED only when its discount actually
    // applies (a losing voucher is left intact — a single-use code must never be burned for nothing).
    let vres: VoucherCheckoutPreview | null = null; let voucherApplied = false;
    if (opts?.voucherCode) {
      vres = await this.vouchers.previewForCheckout(db, o.tenantId ?? null, opts.voucherCode, subtotalNet, { channel: opts?.pricing?.channel ?? 'dine_in', memberId: opts?.memberId });
      if (vres.discount > 0 && vres.discount >= orderDisc) { orderDisc = vres.discount; voucherApplied = true; }
    }
    orderDisc = roundCurrency(Math.min(orderDisc, subtotalNet), 'THB');
    const effTotalPct = grossSum > 0 ? (lineDiscTotal + orderDisc) / grossSum * 100 : 0;
    if (effTotalPct > maxPct + 0.001) throw new BadRequestException({ code: 'DISCOUNT_OVER_LIMIT', message: `Total discount ${r2(effTotalPct)}% exceeds limit ${maxPct}%`, messageTh: 'ส่วนลดเกินเพดานที่อนุญาต' });

    // loyalty points redemption — applied AFTER line+order discount, clamped to the remaining bill, and
    // EXEMPT from the markdown cap (a member spending their own points is a settlement, not a markdown).
    // VAT is charged on the post-redemption base (Thai-correct). actualRedeemPoints back-computes what the
    // bill could actually absorb so we never consume more points than the discount realized.
    let pointsDisc = 0, actualRedeemPoints = 0;
    if (opts?.pointsRedeem && opts.pointsRedeem.redeemValue > 0) {
      pointsDisc = roundCurrency(Math.min(opts.pointsRedeem.redeemValue, subtotalNet - orderDisc), 'THB');
      actualRedeemPoints = opts.pointsRedeem.bahtPerPoint > 0 ? Math.round(pointsDisc / opts.pointsRedeem.bahtPerPoint) : 0;
    }
    const taxable = Math.max(0, roundCurrency(subtotalNet - orderDisc - pointsDisc, 'THB'));
    // B4b: auto service charge for large parties — VATable service income (4400), added to the tax base.
    // Satang rounding adjusts the final bill to a cash-friendly multiple (rounding gain/loss → 4900).
    // Both are zero unless opted-in ⇒ taxable/vat/total stay identical to the prior behaviour.
    const scPct = opts?.pricing?.serviceChargePct ?? 0;
    const minParty = opts?.pricing?.serviceMinParty ?? 6;
    const partySize = opts?.pricing?.partySize ?? 0;
    const serviceCharge = opts?.applyPricingRules && scPct > 0 && partySize >= minParty ? roundCurrency(taxable * scPct / 100, 'THB') : 0;
    const taxableTotal = roundCurrency(taxable + serviceCharge, 'THB');
    const vat = this.tax.calcTax({ net: taxableTotal, country: 'TH' }).tax;
    const preRoundTotal = roundCurrency(taxableTotal + vat, 'THB');
    const roundTo = opts?.applyPricingRules ? (opts?.pricing?.rounding ?? 0) : 0;
    const total = roundTo > 0 ? roundCurrency(Math.round(preRoundTotal / roundTo) * roundTo, 'THB') : preRoundTotal;
    const roundingAdj = roundCurrency(total - preRoundTotal, 'THB');
    // tip (staff pass-through, liability 2300 — NOT in subtotal/VAT) + gift-card redemption (draws down the
    // 2200 deposit liability, reducing the cash leg). cashDue = bill+tip; cashLeg = what's actually tendered.
    const tip = roundCurrency(Math.max(0, opts?.tip ?? 0), 'THB');
    const cashDue = roundCurrency(total + tip, 'THB');
    let giftApplied = 0;
    if (opts?.giftCardNo) {
      const want = opts.giftCardAmount != null ? roundCurrency(opts.giftCardAmount, 'THB') : cashDue;
      const capped = Math.min(want, cashDue); // can't redeem more than the bill+tip
      const r = await this.gift.redeemForSale(opts.giftCardNo, capped, saleNo, o.tenantId, user, db);
      giftApplied = r.applied;
    }
    const cashLeg = roundCurrency(cashDue - giftApplied, 'THB');
    const [h] = await db.insert(custPosSales).values({
      saleNo, saleDate: ymd(), tenantId: o.tenantId, subtotal: fx(subtotalNet, 2), discount: fx(roundCurrency(orderDisc + pointsDisc, 'THB'), 2),
      taxAmount: fx(vat, 2), total: fx(total, 2), tip: fx(tip, 2), serviceCharge: fx(serviceCharge, 2), paymentMethod: 'Dine-in', pointsUsed: String(actualRedeemPoints), pointsEarned: '0',
      status: 'Completed', notes: `Dine-in ${o.orderNo}`, createdBy: user.username,
    }).returning({ id: custPosSales.id });
    await db.insert(custPosItems).values(itemRows.map((r) => ({ saleId: Number(h!.id), ...r })));
    // POS-3: consume the applied voucher/coupon ATOMICALLY inside the sale tx — a guarded UPDATE
    // (WHERE state='issued' / status='active') so a concurrent second redemption gets 0 rows → 409 and
    // this sale rolls back with it. sale_ref/used_ref records the redeeming sale. Refund/return policy:
    // consistent with promo usage, a returned sale does NOT auto-release the code (see PN-19 §7 item 34).
    if (vres && voucherApplied) await this.vouchers.redeemAtCheckout(db, vres, saleNo, user.username);
    // recipe/BOM: deduct ingredients per sold menu line (allows negative, logs Consume); accumulate COGS if post_cogs
    let recipeCogs = 0;
    for (const l of items) { const ded = await this.recipe.applyDeduction(db, o.tenantId, String(l.itemId ?? ''), n(l.qty), saleNo, user); recipeCogs = roundCurrency(recipeCogs + ded.cost, 'THB'); }
    let journalNo: string | null = null;
    if (cashDue > 0) {
      // Dr 1000 cash leg + Dr 2200 gift draw-down = Cr 4000 net + Cr 2100 vat + Cr 2300 tip (balanced;
      // zero legs auto-dropped by postEntry). VAT base excludes tip → tip never inflates 4000/2100.
      // docs/43 PR-6: revenue/service-charge/rounding legs follow the tenant posting-rules (ONE batched,
      // cached read — POS hot path); cash/gift/tip/VAT legs stay pinned/widen-gated.
      const ovr = await this.ledger.postingOverridesMany(['SALE.FOOD', 'SVC.CHARGE', 'POS.ROUNDING'], o.tenantId);
      const revAcct = ovr['SALE.FOOD']?.revenue ?? postingDefault('SALE.FOOD', 'revenue');
      const svcAcct = ovr['SVC.CHARGE']?.service_charge_income ?? postingDefault('SVC.CHARGE', 'service_charge_income');
      const rndAcct = ovr['POS.ROUNDING']?.rounding ?? postingDefault('POS.ROUNDING', 'rounding');
      const je: any = await this.ledger.postEntry({
        source: 'POS', sourceRef: saleNo, tenantId: o.tenantId, memo: `Dine-in ${o.orderNo}`, createdBy: user.username,
        lines: [
          ...(cashLeg > 0 ? [{ account_code: '1000', debit: cashLeg }] : []),
          ...(giftApplied > 0 ? [{ account_code: '2200', debit: giftApplied }] : []),
          ...(roundingAdj < 0 ? [{ account_code: rndAcct, debit: roundCurrency(-roundingAdj, 'THB') }] : []), // rounded down → expense
          { account_code: revAcct, credit: taxable },
          ...(serviceCharge > 0 ? [{ account_code: svcAcct, credit: serviceCharge }] : []),
          { account_code: '2100', credit: vat },
          ...(tip > 0 ? [{ account_code: '2300', credit: tip }] : []),
          ...(roundingAdj > 0 ? [{ account_code: rndAcct, credit: roundingAdj }] : []), // rounded up → income
        ],
      });
      journalNo = je?.entry_no ?? null;
      if (pe?.ok && pe.promoRowId) {
        // atomic cap: increment only while under max_uses (prevents read-then-increment over-redemption race)
        const upd = await db.update(promotions).set({ usedCount: sql`${promotions.usedCount} + 1` })
          .where(and(eq(promotions.id, pe.promoRowId), sql`(${promotions.maxUses} IS NULL OR ${promotions.usedCount} < ${promotions.maxUses})`))
          .returning({ id: promotions.id });
        if (!upd.length) throw new BadRequestException({ code: 'PROMO_EXHAUSTED', message: 'Promo usage limit reached', messageTh: 'โปรโมชันถูกใช้ครบจำนวนแล้ว' });
        await db.insert(promoRedemptions).values({ tenantId: o.tenantId ?? null, promoId: pe.promoRowId, promoCode: pe.promoCode, saleNo, orderNo: o.orderNo, discountAmount: fx(pe.discount, 2), appliedBy: user.username });
      }
    }
    // recipe COGS (gated by per-recipe post_cogs): Dr 5300 Recipe COGS / Cr 1200 Inventory
    if (recipeCogs > 0 && !(await this.ledger.alreadyPosted('POS-COGS', saleNo))) {
      await this.ledger.postEntry({ source: 'POS-COGS', sourceRef: saleNo, tenantId: o.tenantId, memo: `COGS ${saleNo}`, createdBy: user.username, lines: [{ account_code: '5300', debit: recipeCogs }, { account_code: '1200', credit: recipeCogs }] });
    }
    // loyalty member: earn on the net spend + redeem the actually-consumed points — both inside the request
    // tx so a rollback un-does the points sub-ledger too. Revenue-reduction model → no GL footprint here.
    let pointsEarned = 0;
    if (opts?.memberId) {
      pointsEarned = await this.member.earnInTx(db, o.tenantId, opts.memberId, taxable, saleNo, user.username);
      if (pointsEarned > 0) await db.update(custPosSales).set({ pointsEarned: String(pointsEarned) }).where(eq(custPosSales.id, h!.id));
      if (actualRedeemPoints > 0) await this.member.redeemInTx(db, o.tenantId, opts.memberId, actualRedeemPoints, pointsDisc, saleNo, user.username);
    }
    return { subtotal: subtotalNet, discount: roundCurrency(orderDisc + pointsDisc, 'THB'), vat, total, tip, total_with_tip: cashDue, gift_applied: giftApplied, cash_due: cashLeg, journal_no: journalNo, promo_code: pe?.promoCode ?? null, voucher_code: vres?.code ?? null, voucher_applied: voucherApplied, voucher_discount: voucherApplied ? vres!.discount : 0, line_discount_total: lineDiscTotal, points_used: actualRedeemPoints, points_earned: pointsEarned, service_charge: serviceCharge, rounding_adjustment: roundingAdj, applied_rules: Array.from(new Set(appliedRules)) };
  }

  // split bill: build a cust_pos_sales + items + ONE GL entry from a subset / pro-rated slice of an order.
  // grossOverride present (equal split) → the share is VAT-inclusive, back out net+vat; else compute from lines.
  async buildCheckSale(o: any, saleNo: string, lines: any[], opts: { grossOverride?: number; discount?: number }, user: JwtUser) {
    const db = this.db;
    const disc = roundCurrency(opts.discount ?? 0, 'THB');
    let subtotal: number, vat: number, total: number;
    if (opts.grossOverride != null) {
      total = roundCurrency(opts.grossOverride, 'THB');
      const inc = this.tax.calcInclusive({ gross: total, country: 'TH' });
      subtotal = inc.net; vat = inc.tax;
    } else {
      const gross = roundCurrency(lines.reduce((a, l) => a + n(l.amount), 0), 'THB');
      subtotal = Math.max(0, roundCurrency(gross - disc, 'THB'));
      const t = this.tax.calcTax({ net: subtotal, country: 'TH' });
      vat = t.tax; total = roundCurrency(subtotal + vat, 'THB');
    }
    const [h] = await db.insert(custPosSales).values({
      saleNo, saleDate: ymd(), tenantId: o.tenantId, subtotal: fx(subtotal, 2), discount: fx(disc, 2),
      taxAmount: fx(vat, 2), total: fx(total, 2), paymentMethod: 'Split', pointsUsed: '0', pointsEarned: '0',
      status: 'Completed', notes: `Split ${o.orderNo}`, createdBy: user.username,
    }).returning({ id: custPosSales.id });
    const itemRows = lines.length ? lines : [{ itemId: 'SPLIT', name: `แบ่งบิล ${o.orderNo}`, qty: 1, unitPrice: subtotal, amount: subtotal }];
    await db.insert(custPosItems).values(itemRows.map((l: any) => ({
      saleId: Number(h!.id), itemId: l.itemId ?? l.name, itemDescription: l.name, qty: String(n(l.qty ?? 1)), uom: 'จาน',
      unitPrice: fx(n(l.unitPrice ?? l.amount), 2), discountPct: '0', amount: fx(n(l.amount), 2), isCustom: l.itemId == null,
    })));
    let journalNo: string | null = null;
    if (total > 0) {
      const je: any = await this.ledger.postEntry({
        source: 'POS', sourceRef: saleNo, tenantId: o.tenantId, memo: `Split ${o.orderNo}`, createdBy: user.username,
        lines: [{ account_code: '1000', debit: total }, { account_code: '4000', credit: subtotal }, { account_code: '2100', credit: vat }],
      });
      journalNo = je?.entry_no ?? null;
    }
    return { sale_no: saleNo, subtotal, discount: disc, vat, total, journal_no: journalNo };
  }
}
