import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { mmmSocialRawFeeds, mmmSalesDaily, mmmSentimentTrends, mmmCustomerBehavior } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// docs/48 — the STAGING/CORE write path. External marketing signals are pushed IN via explicit ingest
// endpoints (the warehouse pattern) — MMM never reaches across a bounded context to join the sales/customer
// tables directly. Every write carries the caller's tenant_id (RLS + explicit filter), and the aggregate
// tables (sales-daily/sentiment/customer-behavior) upsert on their grain key so re-ingesting a period is
// idempotent (bounded-context rule 7: core mutations are idempotent).

export interface SalesDailyRow {
  bizDate: string;            // YYYY-MM-DD
  productSku?: string;
  revenue: number;
  unitsSold?: number;
  utmSource?: string;         // the attributed channel ('' = organic)
  promoCode?: string;
}

export interface SentimentRow {
  bizDate: string;            // YYYY-MM-DD
  platform: string;
  keywordOrTopic?: string;
  mentionCount: number;
  sentimentScore?: number;    // -1 … 1
}

export interface CustomerBehaviorRow {
  customerNo: string;
  lastPurchaseDate?: string;  // YYYY-MM-DD
  totalOrders?: number;
  totalSpend?: number;
  avgSocialSentimentInteraction?: number;
}

@Injectable()
export class MmmIngestService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Raw social payloads — append-only (kept for replay/re-derivation of sentiment trends).
  async ingestSocialFeed(user: JwtUser, platform: string, rawPayload: unknown): Promise<{ id: number }> {
    const tenantId = user.tenantId!;
    const r = await this.db.insert(mmmSocialRawFeeds)
      .values({ tenantId, platform, rawPayload: rawPayload as object })
      .returning({ id: mmmSocialRawFeeds.id });
    return { id: r[0]!.id };
  }

  // Per-channel daily sales — idempotent upsert on (tenant, day, sku, utm, promo).
  async ingestSalesDaily(user: JwtUser, rows: SalesDailyRow[]): Promise<{ upserted: number }> {
    const tenantId = user.tenantId!;
    let upserted = 0;
    for (const row of rows) {
      await this.db.insert(mmmSalesDaily)
        .values({
          tenantId,
          bizDate: row.bizDate,
          productSku: row.productSku ?? '',
          revenue: String(row.revenue ?? 0),
          unitsSold: row.unitsSold ?? 0,
          utmSource: row.utmSource ?? '',
          promoCode: row.promoCode ?? '',
        })
        .onConflictDoUpdate({
          target: [mmmSalesDaily.tenantId, mmmSalesDaily.bizDate, mmmSalesDaily.productSku, mmmSalesDaily.utmSource, mmmSalesDaily.promoCode],
          set: { revenue: String(row.revenue ?? 0), unitsSold: row.unitsSold ?? 0, ingestedAt: sql`now()` },
        });
      upserted++;
    }
    return { upserted };
  }

  // Cleaned daily sentiment — idempotent upsert on (tenant, day, platform, keyword).
  async ingestSentiment(user: JwtUser, rows: SentimentRow[]): Promise<{ upserted: number }> {
    const tenantId = user.tenantId!;
    let upserted = 0;
    for (const row of rows) {
      await this.db.insert(mmmSentimentTrends)
        .values({
          tenantId,
          bizDate: row.bizDate,
          platform: row.platform,
          keywordOrTopic: row.keywordOrTopic ?? '',
          mentionCount: row.mentionCount ?? 0,
          sentimentScore: row.sentimentScore != null ? String(row.sentimentScore) : null,
        })
        .onConflictDoUpdate({
          target: [mmmSentimentTrends.tenantId, mmmSentimentTrends.bizDate, mmmSentimentTrends.platform, mmmSentimentTrends.keywordOrTopic],
          set: {
            mentionCount: row.mentionCount ?? 0,
            sentimentScore: row.sentimentScore != null ? String(row.sentimentScore) : null,
            processedAt: sql`now()`,
          },
        });
      upserted++;
    }
    return { upserted };
  }

  // Derived per-customer behavioural roll-up — idempotent upsert on (tenant, customer_no).
  async upsertCustomerBehavior(user: JwtUser, rows: CustomerBehaviorRow[]): Promise<{ upserted: number }> {
    const tenantId = user.tenantId!;
    let upserted = 0;
    for (const row of rows) {
      await this.db.insert(mmmCustomerBehavior)
        .values({
          tenantId,
          customerNo: row.customerNo,
          lastPurchaseDate: row.lastPurchaseDate ?? null,
          totalOrders: row.totalOrders ?? 0,
          totalSpend: String(row.totalSpend ?? 0),
          avgSocialSentimentInteraction: row.avgSocialSentimentInteraction != null ? String(row.avgSocialSentimentInteraction) : null,
        })
        .onConflictDoUpdate({
          target: [mmmCustomerBehavior.tenantId, mmmCustomerBehavior.customerNo],
          set: {
            lastPurchaseDate: row.lastPurchaseDate ?? null,
            totalOrders: row.totalOrders ?? 0,
            totalSpend: String(row.totalSpend ?? 0),
            avgSocialSentimentInteraction: row.avgSocialSentimentInteraction != null ? String(row.avgSocialSentimentInteraction) : null,
            refreshedAt: sql`now()`,
          },
        });
      upserted++;
    }
    return { upserted };
  }
}
