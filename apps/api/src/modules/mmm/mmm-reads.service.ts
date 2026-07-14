import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { mmmSalesDaily, mmmSentimentTrends } from '../../database/schema';
import { bizYmdDash } from '../../common/bizdate';
import type { JwtUser } from '../../common/decorators';

// docs/48 — plain detail-view reads for the /mmm dashboard (ingested sales-by-channel + sentiment series).
// Kept separate from the ingest write path and the model/BI aggregate path. Every read is tenant-filtered
// (RLS + explicit eq) — a tenant only ever sees its own staging rows.
@Injectable()
export class MmmReadsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // GET /api/mmm/sales-daily?days=30 — revenue/units per channel over the window.
  async salesDaily(user: JwtUser, days = 30) {
    const tenantId = user.tenantId!;
    const since = bizYmdDash(new Date(Date.now() - Math.min(Math.max(days, 1), 365) * 86400_000));
    const rows = await this.db
      .select({
        channel: mmmSalesDaily.utmSource,
        revenue: sql<number>`sum(${mmmSalesDaily.revenue})`.mapWith(Number),
        units: sql<number>`sum(${mmmSalesDaily.unitsSold})`.mapWith(Number),
      })
      .from(mmmSalesDaily)
      .where(and(eq(mmmSalesDaily.tenantId, tenantId), gte(mmmSalesDaily.bizDate, since)))
      .groupBy(mmmSalesDaily.utmSource)
      .orderBy(desc(sql`sum(${mmmSalesDaily.revenue})`));
    return {
      window_days: days,
      channels: rows.map((r) => ({ channel: r.channel === '' ? '(organic)' : r.channel, revenue: r.revenue ?? 0, units: r.units ?? 0 })),
    };
  }

  // GET /api/mmm/sentiment?days=30 — per-platform mention volume + avg sentiment over the window.
  async sentiment(user: JwtUser, days = 30) {
    const tenantId = user.tenantId!;
    const since = bizYmdDash(new Date(Date.now() - Math.min(Math.max(days, 1), 365) * 86400_000));
    const rows = await this.db
      .select({
        platform: mmmSentimentTrends.platform,
        mentions: sql<number>`sum(${mmmSentimentTrends.mentionCount})`.mapWith(Number),
        avgSentiment: sql<number | null>`avg(${mmmSentimentTrends.sentimentScore})`.mapWith((v: string | null) => (v == null ? null : Number(v))),
      })
      .from(mmmSentimentTrends)
      .where(and(eq(mmmSentimentTrends.tenantId, tenantId), gte(mmmSentimentTrends.bizDate, since)))
      .groupBy(mmmSentimentTrends.platform)
      .orderBy(desc(sql`sum(${mmmSentimentTrends.mentionCount})`));
    return {
      window_days: days,
      platforms: rows.map((r) => ({
        platform: r.platform,
        mentions: r.mentions ?? 0,
        avg_sentiment: r.avgSentiment != null ? Math.round(r.avgSentiment * 100) / 100 : null,
      })),
    };
  }
}
