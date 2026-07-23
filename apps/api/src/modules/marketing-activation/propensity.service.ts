import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { customerProfiles } from '../../database/schema';
import { ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { MenuEngineeringService } from '../analytics/menu-engineering.service';
import { FoodCostService } from '../menu/food-cost.service';
import { FactLayerService } from './fact-layer.service';
import {
  rankNextOffers, rankBestAudiences, rankSegmentOffers, type AffinityPair, type SkuMargin, type SegmentOffer,
} from './propensity-scoring';

// Propensity & Cross-Sell Targeting (docs/61 Phase 1, control MKT-23) — "who should we sell what to next?",
// fact-ranked not guessed. It COMBINES three existing, owning-module reads through their public APIs (arch
// rule 2 — no direct cross-domain queries): association rules over real co-purchase (the analytics
// menu-affinity engine), per-customer favourites + CLV (the Fact Layer), and per-item margin (the menu
// food-cost layer). The scoring itself is the pure, deterministic `propensity-scoring.ts` (unit-tested).
//
// ADVISORY ONLY (MKT-23): every endpoint is read-only and returns a ranked list — it NEVER contacts a
// customer or posts spend. The sole contact path stays the existing consent-gated campaign DRAFT
// (`activateSegment`), so a human still edits + sends and PDPA consent is honoured at send time.

const DEFAULT_WINDOW_DAYS = 90;
const shiftYmd = (base: string, days: number): string => ymd(new Date(new Date(`${base}T00:00:00Z`).getTime() + days * 86400000));

@Injectable()
export class PropensityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly menuEng: MenuEngineeringService,
    private readonly foodCost: FoodCostService,
    private readonly facts: FactLayerService,
  ) {}

  // The customer's affinity window + the shared margin map + the pairs, resolved once and reused.
  private async loadBasis(user: JwtUser, opts?: { from?: string; to?: string }): Promise<{ pairs: AffinityPair[]; marginBySku: Map<string, SkuMargin>; from: string; to: string }> {
    const to = opts?.to ?? ymd();
    const from = opts?.from ?? shiftYmd(to, -DEFAULT_WINDOW_DAYS);
    const affinity: any = await this.menuEng.menuAffinity(user, { from, to, min_pair_count: 1, top: 200 });
    const pairs: AffinityPair[] = Array.isArray(affinity?.pairs) ? affinity.pairs : [];
    const margins: any = await this.foodCost.menuMargins(user);
    const marginBySku = new Map<string, SkuMargin>();
    for (const m of (Array.isArray(margins?.items) ? margins.items : [])) {
      marginBySku.set(String(m.sku), { name: m.name, margin: m.margin ?? null, margin_pct: m.margin_pct ?? null });
    }
    return { pairs, marginBySku, from, to };
  }

  // Per customer → a ranked "next product to offer" (likely-to-buy-next, EXCLUDING what they already buy,
  // weighted by confidence × lift × margin). The single-customer offer list every downstream tool consumes.
  async nextBestOffers(user: JwtUser, code: string, opts?: { from?: string; to?: string; top?: number }): Promise<Record<string, unknown>> {
    const f = await this.facts.customerFacts(user, code); // 404s if the member is not this tenant's
    const owned = Array.isArray(f.favorite_item_ids) ? (f.favorite_item_ids as unknown[]).map(String) : [];
    const value = (f.value ?? {}) as Record<string, unknown>;
    const clv = value.clv_platform ?? value.predicted_ltv_own ?? null;
    const { pairs, marginBySku, from, to } = await this.loadBasis(user, opts);
    const offers = rankNextOffers(owned, pairs, marginBySku, { top: opts?.top ?? 10 });
    return {
      customer_no: code,
      marketing_opt_in: f.marketing_opt_in === true, // the consent gate any contact tool must honour
      clv,
      window: { from, to },
      owned_count: owned.length,
      offers,
      note: 'Advisory scoring only (MKT-23). To contact, open a consent-gated campaign draft — nothing auto-sends.',
    };
  }

  // Per product → "best audiences to push it to": the segments whose members most plausibly buy it next
  // (a driver of the product sits in their favourites, and they don't already buy it), ranked by reach ×
  // value. Feeds the AI Campaign Studio (①) and the Segment×Channel ROI command (⑤) a concrete target.
  async bestAudiences(user: JwtUser, itemId: string, opts?: { from?: string; to?: string; top?: number }): Promise<Record<string, unknown>> {
    const tenantId = this.assertTenant(user);
    const product = (itemId ?? '').trim();
    if (!product) throw new BadRequestException({ code: 'NO_ITEM', message: 'item id required', messageTh: 'ต้องระบุรหัสสินค้า' });
    const { pairs, marginBySku, from, to } = await this.loadBasis(user, opts);

    // Drivers = the affinity antecedents whose purchase implies this product (either direction, lift > 1).
    const drivers = new Set<string>();
    for (const p of pairs) {
      if (p.lift <= 1) continue;
      if (p.item_b === product) drivers.add(p.item_a);
      if (p.item_a === product) drivers.add(p.item_b);
    }

    const rows = await this.db.select({
      segment: customerProfiles.miRfmSegment, favorites: customerProfiles.favoriteItemIds, clv: customerProfiles.miClv,
    }).from(customerProfiles).where(and(eq(customerProfiles.tenantId, tenantId)));
    const members = rows.map((r) => {
      const fav = Array.isArray(r.favorites) ? (r.favorites as unknown[]).map(String) : [];
      return { segment: r.segment ?? null, favorites: fav, owns_product: fav.includes(product), clv: r.clv == null ? null : Number(r.clv) };
    });
    const audiences = rankBestAudiences(product, drivers, members, { top: opts?.top ?? 20 });

    const m = marginBySku.get(product);
    return {
      item_id: product,
      item_name: m?.name ?? product,
      unit_margin: m?.margin ?? null,
      window: { from, to },
      driver_item_ids: Array.from(drivers),
      candidate_members: members.filter((x) => !x.owns_product && x.favorites.some((ff) => drivers.has(ff))).length,
      audiences,
      note: 'Advisory scoring only (MKT-23). Contact any ranked segment via a consent-gated campaign draft.',
    };
  }

  // BATCHED per-segment ranked top un-bought products (docs/62 Phase 2 offer-level ⑤): ONE profiles read +
  // ONE affinity/margin basis load for any number of segments, then the pure rankSegmentOffers per segment
  // (majority-owned staples excluded, reach-weighted, strongest driver per candidate). Advisory read only.
  async topOffersForSegments(user: JwtUser, segments: string[], opts?: { from?: string; to?: string; top?: number }): Promise<Map<string, SegmentOffer[]>> {
    const tenantId = this.assertTenant(user);
    const out = new Map<string, SegmentOffer[]>();
    const segs = [...new Set(segments.map((s) => (s ?? '').trim()).filter(Boolean))];
    if (!segs.length) return out;
    const rows = await this.db.select({ segment: customerProfiles.miRfmSegment, favorites: customerProfiles.favoriteItemIds })
      .from(customerProfiles)
      .where(and(eq(customerProfiles.tenantId, tenantId), inArray(customerProfiles.miRfmSegment, segs)));
    const membersBySeg = new Map<string, { favorites: string[] }[]>();
    for (const r of rows) {
      const seg = String(r.segment ?? '');
      if (!seg) continue;
      const list = membersBySeg.get(seg) ?? [];
      list.push({ favorites: Array.isArray(r.favorites) ? (r.favorites as unknown[]).map(String) : [] });
      membersBySeg.set(seg, list);
    }
    const { pairs, marginBySku } = await this.loadBasis(user, opts);
    for (const seg of segs) {
      const members = membersBySeg.get(seg) ?? [];
      out.set(seg, members.length ? rankSegmentOffers(members, pairs, marginBySku, { top: opts?.top ?? 3 }) : []);
    }
    return out;
  }

  // Per SEGMENT → the ranked list (single-segment convenience over the batched read).
  async topSegmentOffers(user: JwtUser, segment: string, opts?: { from?: string; to?: string; top?: number }): Promise<SegmentOffer[]> {
    const seg = (segment ?? '').trim();
    if (!seg) return [];
    return (await this.topOffersForSegments(user, [seg], opts)).get(seg) ?? [];
  }

  // The single top un-bought product (the ③→① Studio hook) — the head of the ranked list.
  async topSegmentOffer(user: JwtUser, segment: string, opts?: { from?: string; to?: string }): Promise<SegmentOffer | null> {
    return (await this.topSegmentOffers(user, segment, { ...opts, top: 1 }))[0] ?? null;
  }

  private assertTenant(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'no tenant', messageTh: 'ไม่มีผู้เช่า' });
    return user.tenantId;
  }
}
