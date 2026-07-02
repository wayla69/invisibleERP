import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq, or, and, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { promotions, promotionItems } from '../../database/schema';
import { n, ymd } from '../../database/queries';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
// normalize a date column (string 'YYYY-MM-DD' or a Date object) to a comparable 'YYYY-MM-DD'
const d10 = (v: any) => { const x = String(v); return /^\d{4}-\d{2}-\d{2}/.test(x) ? x.slice(0, 10) : new Date(v).toISOString().slice(0, 10); };

export interface PromoApplyInput {
  code: string;
  subtotalNet: number;
  itemIds: string[];
  customerGroup?: string;
  tenantId: number | null;
}
export interface PromoApplyResult { ok: boolean; promoRowId: number | null; promoCode: string | null; discount: number; }

// Validates a promo code at checkout and computes the order-level discount. Throws 400 on hard failures.
@Injectable()
export class PromoEngineService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async applyPromo(input: PromoApplyInput): Promise<PromoApplyResult> {
    const db = this.db;
    const bad = (code: string, message: string, messageTh: string) => { throw new BadRequestException({ code, message, messageTh }); };
    // Tenant-scope the lookup: a sale in tenant T only sees T's own promos (legacy null-tenant promos
    // stay global). Belt-and-suspenders with RLS — also correct when an Admin/HQ caller bypasses RLS.
    const ownScope = input.tenantId != null ? eq(promotions.tenantId, input.tenantId) : isNull(promotions.tenantId);
    const [p] = await db.select().from(promotions)
      .where(and(or(eq(promotions.promoId, input.code), eq(promotions.promoName, input.code)), ownScope))
      .limit(1);
    if (!p) bad('PROMO_NOT_FOUND', `Promo ${input.code} not found`, 'ไม่พบโปรโมชัน');
    if (p!.active === false) bad('PROMO_INACTIVE', 'Promo is inactive', 'โปรโมชันปิดใช้งาน');
    const today = ymd();
    if (p!.startDate && d10(p!.startDate) > today) bad('PROMO_NOT_STARTED', 'Promo has not started', 'โปรโมชันยังไม่เริ่ม');
    if (p!.endDate && d10(p!.endDate) < today) bad('PROMO_EXPIRED', 'Promo has expired', 'โปรโมชันหมดอายุ');
    const grp = p!.customerGroup ?? 'All';
    if (grp !== 'All' && grp !== (input.customerGroup ?? 'All')) bad('PROMO_GROUP_MISMATCH', 'Promo not for this customer group', 'โปรโมชันไม่ตรงกลุ่มลูกค้า');
    if (p!.maxUses != null && Number(p!.usedCount ?? 0) >= Number(p!.maxUses)) bad('PROMO_EXHAUSTED', 'Promo usage limit reached', 'โปรโมชันถูกใช้ครบจำนวนแล้ว');
    if (p!.minAmount != null && input.subtotalNet < n(p!.minAmount)) bad('PROMO_MIN_SPEND', `Min spend ${n(p!.minAmount)} not met`, `ยอดซื้อขั้นต่ำ ${n(p!.minAmount)} บาท`);

    const links = await db.select({ itemId: promotionItems.itemId }).from(promotionItems).where(eq(promotionItems.promoId, Number(p!.id)));
    if (links.length) {
      const allowed = new Set(links.map((l: any) => String(l.itemId)));
      if (!input.itemIds.some((i) => allowed.has(String(i)))) bad('PROMO_ITEMS_NOT_APPLICABLE', 'No eligible items for this promo', 'ไม่มีสินค้าที่เข้าร่วมโปรโมชัน');
    }

    let discount = 0;
    if (p!.promoType === 'Percent') discount = round2(input.subtotalNet * n(p!.discountPct) / 100);
    else if (p!.promoType === 'Amount' || p!.promoType === 'MinSpend') discount = round2(n(p!.discountAmt));
    // FreeGift/Bundle/BuyXGetY → item-grant promos, no monetary order discount at Tier-1
    discount = Math.min(discount, input.subtotalNet);
    return { ok: true, promoRowId: Number(p!.id), promoCode: p!.promoId ?? p!.promoName, discount };
  }
}
