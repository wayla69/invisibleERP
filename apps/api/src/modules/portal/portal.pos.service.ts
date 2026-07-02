import { Inject, Injectable, Optional, BadRequestException } from '@nestjs/common';
import { sql, eq, ne, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import {
  custPosSales, custPosItems, customerInventory, custStockLog, branchStock,
  loyaltyConfig, loyaltyPoints, loyaltyTxn, branches,
} from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { ymd, n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { PortalService } from './portal.service';
import { TaxService } from '../tax/tax.service';
import { roundCurrency } from '../tax/money';
import { PaymentService } from '../payments/payments.service';
import { LedgerService } from '../ledger/ledger.service';
import { RecipeService } from '../menu/recipe.service';
import { CostingService } from '../costing/costing.service';
import { PricingService } from '../pricing/pricing.service';
import { JournalService } from '../pos/fiscal/journal.service';
import { LockingService } from '../pos/scale/locking.service';

export interface PortalSaleDto {
  items: { item_id: string; item_description?: string; qty: number; unit_price: number; uom?: string; discount_pct?: number; modifier_option_ids?: number[] }[];
  discount?: number;
  payment_method?: string;
  notes?: string;
  apply_pricing?: boolean;   // opt-in: fold pricing-engine rule discounts into the order discount
  channel?: string;
  party_size?: number;
  service_charge_pct?: number;  // B4: auto service charge for large parties (VATable → acct 4400)
  service_min_party?: number;   // B4: party threshold for service charge (default 6)
  rounding?: number;            // B4: satang rounding step (0 = disabled) → acct 4900
  branch_id?: number;           // multi-branch: tag the sale to an outlet (must belong to this tenant)
}

@Injectable()
export class PortalPosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly portal: PortalService,
    private readonly tax: TaxService,
    private readonly payments: PaymentService,
    private readonly ledger: LedgerService,
    private readonly recipe: RecipeService,
    @Optional() private readonly costing?: CostingService, // Phase 17A — costed COGS for configured retail items
    @Optional() private readonly pricing?: PricingService,  // wiring: rule discounts at checkout (opt-in)
    @Optional() private readonly journal?: JournalService,  // wiring: append electronic journal per sale
    @Optional() private readonly locking?: LockingService,  // wiring: auto-86 recompute after stock decrement
  ) {}

  // POST /api/portal/pos/sales — retail sale (SALE-) + stock decrement + loyalty earn.
  // opts.saleDate (offline sync) books the sale + its GL on the original offline day, not today.
  async createSale(dto: PortalSaleDto, user: JwtUser, opts?: { saleDate?: string; branchId?: number }) {
    const t = await this.portal.tenantId(user);
    const db = this.db;
    if (!dto.items?.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No items', messageTh: 'ไม่มีรายการสินค้า' });

    // multi-branch tag: validate the outlet belongs to this tenant (explicit tenant predicate even under
    // Admin RLS-bypass) so a sale can't be mis-tagged to a foreign branch. NULL = untagged (backward-compat).
    const branchId = opts?.branchId ?? dto.branch_id ?? null;
    if (branchId != null) {
      const [br] = await db.select({ id: branches.id }).from(branches)
        .where(and(eq(branches.id, Number(branchId)), eq(branches.tenantId, t.id), eq(branches.active, true))).limit(1);
      if (!br) throw new BadRequestException({ code: 'BRANCH_NOT_FOUND', message: `Branch ${branchId} not found for this tenant`, messageTh: 'ไม่พบสาขาของร้านนี้' });
    }

    const lines = dto.items.map((it) => {
      const gross = n(it.qty) * n(it.unit_price);
      const lineDisc = gross * (n(it.discount_pct) / 100);
      return { ...it, amount: roundCurrency(gross - lineDisc, 'THB') };
    });
    const subtotal = roundCurrency(lines.reduce((a, l) => a + l.amount, 0), 'THB');
    // wiring: opt-in pricing engine — fold rule discounts (happy-hour/BOGO/qty-break/order) into the
    // order discount. GL stays balanced (cash leg = total = taxable + vat). Advisory: never block a sale.
    let pricingDiscount = 0;
    if (dto.apply_pricing && this.pricing) {
      try {
        const q = await this.pricing.quote({ channel: dto.channel, party_size: dto.party_size, lines: lines.map((l) => ({ sku: String(l.item_id), qty: n(l.qty), unit_price: n(l.unit_price) })) }, user);
        pricingDiscount = roundCurrency(n(q.line_discount_total) + n(q.order_discount), 'THB');
      } catch { /* pricing is advisory at checkout */ }
    }
    const discount = roundCurrency(n(dto.discount) + pricingDiscount, 'THB');
    const taxable = Math.max(0, subtotal - discount);
    // B4: auto service charge for large parties (VATable service income → acct 4400). Zero unless opted-in.
    const scPct = dto.apply_pricing ? (dto.service_charge_pct ?? 0) : 0;
    const minParty = dto.service_min_party ?? 6;
    const serviceCharge = scPct > 0 && (dto.party_size ?? 0) >= minParty ? roundCurrency(taxable * scPct / 100, 'THB') : 0;
    const taxableTotal = roundCurrency(taxable + serviceCharge, 'THB');
    // pluggable tax (move #5) — no more hard-coded VAT 7%
    const taxCalc = this.tax.calcTax({ net: taxableTotal, country: 'TH' });
    const vat = taxCalc.tax;
    // B4: satang rounding (→ acct 4900). Zero unless opted-in with rounding > 0.
    const roundTo = dto.apply_pricing ? (dto.rounding ?? 0) : 0;
    const preRoundTotal = roundCurrency(taxableTotal + vat, 'THB');
    const total = roundTo > 0 ? roundCurrency(Math.round(preRoundTotal / roundTo) * roundTo, 'THB') : preRoundTotal;
    const roundingAdj = roundCurrency(total - preRoundTotal, 'THB');

    // SALE- number, collision-safe: the second-precision stamp can clash for rapid sales → retry on a
    // bumped second until cust_pos_sales.sale_no (UNIQUE) is free.
    let saleNo = this.docNo.nextTenantStamped('SALE', t.code);
    for (let attempt = 1; attempt < 12; attempt++) {
      const [exists] = await this.db.select({ id: custPosSales.id }).from(custPosSales).where(eq(custPosSales.saleNo, saleNo)).limit(1);
      if (!exists) break;
      saleNo = this.docNo.nextTenantStamped('SALE', t.code, new Date(Date.now() + attempt * 1000));
    }
    const today = opts?.saleDate ?? ymd();
    const now = new Date();
    let recipeCogs = 0;
    const nonRecipeLines: { itemId: string; qty: number }[] = []; // Phase 17A — costed COGS for these

    // loyalty earn (parity with central POS)
    let pointsEarned = 0;
    const [cfg] = await db.select().from(loyaltyConfig).where(eq(loyaltyConfig.id, 1)).limit(1);
    if (cfg?.enabled) pointsEarned = roundCurrency(total * n(cfg.pointsPerBaht), 'THB');

    await db.transaction(async (tx: any) => {
      const [h] = await tx.insert(custPosSales).values({
        saleNo, saleDate: today, tenantId: t.id, branchId, subtotal: fx(subtotal, 2), discount: fx(discount, 2),
        taxAmount: fx(vat, 2), total: fx(total, 2), serviceCharge: fx(serviceCharge, 2), paymentMethod: dto.payment_method ?? 'Cash',
        pointsUsed: '0', pointsEarned: String(pointsEarned), status: 'Completed', notes: dto.notes ?? null, createdBy: user.username,
      }).returning({ id: custPosSales.id });

      await tx.insert(custPosItems).values(lines.map((l) => ({
        saleId: Number(h.id), itemId: l.item_id, itemDescription: l.item_description ?? null,
        qty: String(n(l.qty)), uom: l.uom ?? null, unitPrice: fx(l.unit_price, 2),
        discountPct: String(n(l.discount_pct)), amount: fx(l.amount, 2), isCustom: false,
      })));

      // decrement customer inventory (MAX(0,...)) + stock log
      for (const l of lines) {
        const [inv] = await tx.select().from(customerInventory)
          .where(and(eq(customerInventory.tenantId, t.id), eq(customerInventory.itemId, l.item_id))).limit(1);
        if (inv) {
          const newStock = Math.max(0, n(inv.currentStock) - n(l.qty));
          await tx.update(customerInventory).set({ currentStock: String(newStock), lastUpdated: now }).where(eq(customerInventory.id, inv.id));
          await tx.insert(custStockLog).values({
            tenantId: t.id, branchId, itemId: l.item_id, itemDescription: inv.itemDescription, logDate: now, logType: 'Sale',
            qtyChange: String(-n(l.qty)), balanceAfter: String(newStock), refDoc: saleNo, notes: null, createdBy: user.username,
          });
          // mirror into the per-branch ledger (branch-aware replenishment). Same MAX(0) clamp as the rollup above.
          if (branchId != null) {
            const [bs] = await tx.select().from(branchStock).where(and(eq(branchStock.tenantId, t.id), eq(branchStock.branchId, branchId), eq(branchStock.itemId, l.item_id))).for('update').limit(1);
            if (bs) await tx.update(branchStock).set({ onHand: String(Math.max(0, n(bs.onHand) - n(l.qty))), lastUpdated: now }).where(eq(branchStock.id, bs.id));
            else await tx.insert(branchStock).values({ tenantId: t.id, branchId, itemId: l.item_id, itemDescription: inv.itemDescription, uom: inv.uom ?? null, onHand: '0', lastUpdated: now });
          }
        }
        // recipe/BOM: deduct ingredients for a recipe-backed menu line (ingredient item_ids differ from the dish SKU)
        const ded = await this.recipe.applyDeduction(tx, t.id, String(l.item_id), n(l.qty), saleNo, user, branchId);
        recipeCogs = roundCurrency(recipeCogs + ded.cost, 'THB');
        if (!ded.deducted) nonRecipeLines.push({ itemId: String(l.item_id), qty: n(l.qty) }); // non-recipe → costed COGS
        // Step 1 — modifier COGS: chosen options ("extra patty") add their standard cost to the line's COGS
        // (Dr 5300 / Cr 1200), so menu modifiers no longer move price without moving cost of goods.
        const modCogs = await this.recipe.modifierCogs(tx, t.id, (l as any).modifier_option_ids ?? [], n(l.qty));
        recipeCogs = roundCurrency(recipeCogs + modCogs, 'THB');
      }

      // loyalty accrual
      if (pointsEarned > 0) {
        const [lp] = await tx.select().from(loyaltyPoints).where(eq(loyaltyPoints.tenantId, t.id)).limit(1);
        const newBalance = n(lp?.balance) + pointsEarned;
        const newLifetime = n(lp?.lifetime) + pointsEarned;
        await tx.insert(loyaltyPoints).values({ tenantId: t.id, balance: String(newBalance), lifetime: String(newLifetime), lastUpdated: now })
          .onConflictDoUpdate({ target: loyaltyPoints.tenantId, set: { balance: String(newBalance), lifetime: String(newLifetime), lastUpdated: now } });
        await tx.insert(loyaltyTxn).values({ tenantId: t.id, txnDate: now, txnType: 'Earn', points: String(pointsEarned), balanceAfter: String(newBalance), refDoc: saleNo });
      }
    });

    // Tender (move #3) + GL posting (move #2) are part of the sale's atomicity — same request tx.
    // We do NOT swallow their errors: a swallowed DB failure here poisons the request tx (Postgres
    // aborts it), so the interceptor's COMMIT becomes a ROLLBACK and we'd return 200 + sale_no for a
    // sale that was never persisted (phantom sale). Letting them propagate rolls the whole sale back
    // atomically — no sale without its money + books.
    // A zero-total sale (e.g. 100% comp/discount) has no money movement and no VAT — skip the tender
    // and the GL posting (recordTender rejects amount<=0 and an all-zero journal has nothing to post).
    let tender: any = null;
    let je: any = null;
    // recipe COGS (gated by post_cogs): Dr 5300 / Cr 1200 — posted alongside the sale's GL (same request tx)
    if (recipeCogs > 0 && !(await this.ledger.alreadyPosted('POS-COGS', saleNo))) {
      await this.ledger.postEntry({ date: today, source: 'POS-COGS', sourceRef: saleNo, tenantId: t.id, memo: `COGS ${saleNo}`, createdBy: user.username, lines: [{ account_code: '5300', debit: recipeCogs }, { account_code: '1200', credit: recipeCogs }] });
    }
    // Phase 17A — costed COGS (Dr 5000 / Cr 1200) for non-recipe lines whose item has a costing method
    if (this.costing && nonRecipeLines.length) await this.costing.onIssue({ tenantId: t.id, saleNo, date: today, lines: nonRecipeLines, createdBy: user.username });
    if (total > 0) {
      // Link this tender to the shop's open till (if any) so closeTill sees POS cash (move #5 reconciliation).
      const openTill = await this.payments.currentOpenTill(t.id);
      tender = await this.payments.recordTender(
        { sale_no: saleNo, tenant_id: t.id, method: dto.payment_method ?? 'Cash', amount: total, currency: 'THB', gateway: 'mock', till_session_id: openTill?.id },
        user,
      );
      je = await this.ledger.postEntry({
        date: today, source: 'POS', sourceRef: saleNo, tenantId: t.id, memo: `Retail sale ${saleNo}`, createdBy: user.username,
        lines: [
          { account_code: '1000', debit: total },    // Dr Cash (rounded total)
          ...(roundingAdj < 0 ? [{ account_code: '4900', debit: roundCurrency(-roundingAdj, 'THB') }] : []),
          { account_code: '4000', credit: taxable }, // Cr Sales Revenue (goods)
          ...(serviceCharge > 0 ? [{ account_code: '4400', credit: serviceCharge }] : []),
          { account_code: '2100', credit: vat },     // Cr Tax Payable
          ...(roundingAdj > 0 ? [{ account_code: '4900', credit: roundingAdj }] : []),
        ],
      });
    }

    // wiring (best-effort, never poison the sale): append the hash-chained electronic journal, then
    // recompute auto-86 in case this sale depleted a recipe ingredient.
    const ju = { ...user, tenantId: t.id };
    if (this.journal) { try { await this.journal.append({ doc_type: 'SALE', doc_no: saleNo, payload: { subtotal, discount, vat, total, lines: lines.length, payment_method: dto.payment_method ?? 'Cash' } }, ju); } catch { /* journal best-effort */ } }
    if (this.locking) { try { await this.locking.recomputeAvailability(); } catch { /* auto-86 best-effort */ } }

    return { sale_no: saleNo, branch_id: branchId, subtotal, discount, pricing_discount: pricingDiscount, service_charge: serviceCharge, rounding_adjustment: roundingAdj, vat, total, points_earned: pointsEarned, lines: lines.length, payment_no: tender?.payment_no ?? null, journal_no: je?.entry_no ?? null };
  }

  // GET /api/portal/pos/sales — history (this tenant)
  async listSales(user: JwtUser, limit: number, offset: number) {
    const t = await this.portal.tenantId(user);
    const db = this.db;
    const rows = await db.select({
      sale_no: custPosSales.saleNo, sale_date: custPosSales.saleDate, subtotal: custPosSales.subtotal,
      discount: custPosSales.discount, tax_amount: custPosSales.taxAmount, total: custPosSales.total,
      payment_method: custPosSales.paymentMethod, points_earned: custPosSales.pointsEarned,
      status: custPosSales.status, cashier: custPosSales.createdBy,
    }).from(custPosSales)
      .where(and(eq(custPosSales.tenantId, t.id), ne(custPosSales.status, 'Voided')))
      .orderBy(desc(custPosSales.saleNo)).limit(limit).offset(offset);
    return {
      sales: rows.map((r: any) => ({
        ...r, subtotal: n(r.subtotal), discount: n(r.discount), tax_amount: n(r.tax_amount),
        total: n(r.total), points_earned: n(r.points_earned),
      })),
      count: rows.length,
    };
  }
}
