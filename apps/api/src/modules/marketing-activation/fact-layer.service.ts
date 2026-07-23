import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { customerProfiles, posMembers } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { MarketingIntelService } from '../marketing-intel/marketing-intel.service';

// Marketing Activation — the shared FACT LAYER (docs/61 Phase 0). A single READ-ONLY aggregator that
// COMPOSES facts the ERP already captures — per customer and per segment — into one governed shape every
// activation tool (①–⑤) consumes, so they all speak the same facts and never drift. It computes nothing
// new; it reads customer_profiles (the marketing-intel-owned mi_* columns live there) + pos_members in a
// SEPARATE query (no cross-domain SQL join, arch rule 3) and reuses MarketingIntelService.getSummary for the
// pushed MMM channel-ROI + sentiment. Tenant-scoped by RLS; a read model — no GL posting, no contact, no spend.

const num = (v: unknown): number | null => (v == null ? null : Number(v));

@Injectable()
export class FactLayerService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly mi: MarketingIntelService,
  ) {}

  // Per-customer fact sheet: identity + reach, RFM + both segmentations, value (ERP + platform CLV), risk
  // (ERP + platform churn), the platform next-best-action, favourites and recency. The single source every
  // tool reads for "what do we know about this customer, on the record".
  async customerFacts(user: JwtUser, code: string): Promise<Record<string, unknown>> {
    const tenantId = this.assertTenant(user);
    const memberCode = (code ?? '').trim();
    if (!memberCode) throw new BadRequestException({ code: 'NO_CUSTOMER', message: 'customer_no required', messageTh: 'ต้องระบุรหัสลูกค้า' });
    const [mem] = await this.db.select({ id: posMembers.id, name: posMembers.name, tier: posMembers.tier, active: posMembers.active, optIn: posMembers.marketingOptIn })
      .from(posMembers).where(and(eq(posMembers.tenantId, tenantId), eq(posMembers.memberCode, memberCode))).limit(1);
    if (!mem) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: `customer ${memberCode} not found`, messageTh: `ไม่พบลูกค้า ${memberCode}` });
    const [p] = await this.db.select().from(customerProfiles)
      .where(and(eq(customerProfiles.tenantId, tenantId), eq(customerProfiles.memberId, Number(mem.id)))).limit(1);

    return {
      customer_no: memberCode,
      name: mem.name ?? null,
      tier: mem.tier ?? null,
      active: mem.active !== false,
      marketing_opt_in: mem.optIn !== false, // consent gate for any contact a tool proposes
      has_profile: !!p,
      rfm: {
        recency_days: p?.rfmRecency ?? null,
        frequency: p?.rfmFrequency ?? null,
        monetary: num(p?.rfmMonetary),
        segment: p?.rfmSegment ?? null,          // the ERP's own RFM
        mi_segment: p?.miRfmSegment ?? null,     // the platform's sentiment-weighted RFM
      },
      value: {
        predicted_ltv_own: num(p?.predictedLtv), // ERP explainable (Growth Engine G3)
        clv_platform: num(p?.miClv),             // platform CLV (docs/60 Phase 2)
        total_spend: num(p?.totalSpend),
        avg_order_value: num(p?.avgOrderValue),
        total_orders: p?.totalOrders ?? null,
        visit_count: p?.visitCount ?? null,
      },
      risk: {
        churn_risk_own: p?.churnRisk ?? null,      // ERP 0..100 explainable
        churn_risk_platform: num(p?.miChurnRisk),  // platform probability [0,1]
      },
      next_best_action: p?.miNba ?? null,          // platform NBA (advisory)
      reach: {
        preferred_channel: p?.preferredChannel ?? null,
        preferred_hour: p?.preferredHour ?? null,  // 0..23 Asia/Bangkok
      },
      favorite_item_ids: p?.favoriteItemIds ?? null,
      last_order_at: p?.lastOrderAt ?? null,
      first_order_at: p?.firstOrderAt ?? null,
    };
  }

  // Per-segment fact sheet: the size + value + risk + dominant next-best-action of a pushed mi_segment, plus
  // the tenant's best channel (by MMM ROI) and headline sentiment — the "fact sheet" the AI Campaign Studio (①)
  // and the Segment×Channel ROI command (⑤) are grounded in.
  async segmentFacts(user: JwtUser, segment: string): Promise<Record<string, unknown>> {
    const tenantId = this.assertTenant(user);
    const seg = (segment ?? '').trim();
    if (!seg) throw new BadRequestException({ code: 'NO_SEGMENT', message: 'segment required', messageTh: 'ต้องระบุกลุ่ม' });

    const rows = await this.db.select({
      miClv: customerProfiles.miClv, miChurnRisk: customerProfiles.miChurnRisk, miNba: customerProfiles.miNba,
      totalSpend: customerProfiles.totalSpend, monetary: customerProfiles.rfmMonetary,
    }).from(customerProfiles).where(and(eq(customerProfiles.tenantId, tenantId), eq(customerProfiles.miRfmSegment, seg)));

    const count = rows.length;
    const avg = (vals: (number | null)[]): number | null => {
      const v = vals.filter((x): x is number => x != null);
      return v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 100) / 100 : null;
    };
    const nbaMix: Record<string, number> = {};
    for (const r of rows) { const k = r.miNba ?? '—'; nbaMix[k] = (nbaMix[k] ?? 0) + 1; }
    const dominantNba = Object.entries(nbaMix).filter(([k]) => k !== '—').sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    // Best channel by MMM ROI + headline sentiment from the latest pushed MMM/TOWS (via marketing-intel).
    const summary: any = await this.mi.getSummary(user);
    const channels: any[] = Array.isArray(summary?.mmm?.payload?.channels) ? summary.mmm.payload.channels : [];
    const bestChannel = channels.length ? [...channels].sort((a, b) => (Number(b?.roi) || 0) - (Number(a?.roi) || 0))[0] : null;

    return {
      segment: seg,
      count,
      value: {
        avg_clv_platform: avg(rows.map((r) => num(r.miClv))),
        total_spend: rows.reduce((s, r) => s + (num(r.totalSpend) ?? 0), 0),
        avg_monetary: avg(rows.map((r) => num(r.monetary))),
      },
      risk: { avg_churn_risk_platform: avg(rows.map((r) => num(r.miChurnRisk))) },
      next_best_action: { dominant: dominantNba, mix: nbaMix },
      best_channel: bestChannel ? { channel: String(bestChannel.channel), roi: num(bestChannel.roi) } : null,
      mmm_basis: summary?.mmm?.model_run_ref ?? null,
      has_mmm: channels.length > 0,
    };
  }

  private assertTenant(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'no tenant', messageTh: 'ไม่มีผู้เช่า' });
    return user.tenantId;
  }
}
