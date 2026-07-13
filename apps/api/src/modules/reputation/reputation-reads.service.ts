import { Inject, Injectable } from '@nestjs/common';
import { and, eq, lte, desc, asc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { externalReviews, analyticsDailySnapshots } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// docs/47 — plain list reads for the /reputation UI (reviews table, analytics series). Kept separate from
// the sync services (which own the write path) and from ReputationBiReports (which owns the aggregate
// dashboard read) — this is the paginated/filterable detail-view read path.
@Injectable()
export class ReputationReadsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // GET /api/reputation/reviews?needs_attention=1&limit=50
  async reviews(user: JwtUser, opts: { needsAttention?: boolean; limit?: number }) {
    const tenantId = user.tenantId!;
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = await this.db.select().from(externalReviews)
      .where(eq(externalReviews.tenantId, tenantId))
      .orderBy(desc(externalReviews.reviewCreateTime)).limit(limit);
    const filtered = opts.needsAttention ? rows.filter((r) => (r.rating ?? 5) <= 3 && !r.replyComment) : rows;
    return {
      count: filtered.length,
      reviews: filtered.map((r) => ({
        id: r.id, location_ref: r.locationRef, author_name: r.authorName, author_photo_url: r.authorPhotoUrl,
        rating: r.rating, comment: r.comment, review_create_time: r.reviewCreateTime,
        reply_comment: r.replyComment, reply_update_time: r.replyUpdateTime,
      })),
    };
  }

  // GET /api/reputation/analytics?property_ref=&days=30
  async analytics(user: JwtUser, opts: { propertyRef?: string; days?: number }) {
    const tenantId = user.tenantId!;
    const since = new Date(Date.now() - (opts.days ?? 30) * 86400_000).toISOString().slice(0, 10);
    const rows = await this.db.select().from(analyticsDailySnapshots)
      .where(and(
        eq(analyticsDailySnapshots.tenantId, tenantId),
        lte(analyticsDailySnapshots.metricDate, new Date().toISOString().slice(0, 10)),
        ...(opts.propertyRef ? [eq(analyticsDailySnapshots.propertyRef, opts.propertyRef)] : []),
      ))
      .orderBy(asc(analyticsDailySnapshots.metricDate));
    const filtered = rows.filter((r) => r.metricDate >= since);
    return {
      count: filtered.length,
      days: filtered.map((r) => ({
        property_ref: r.propertyRef, metric_date: r.metricDate, sessions: r.sessions, active_users: r.activeUsers,
        conversions: r.conversions, total_revenue: r.totalRevenue, engagement_rate: r.engagementRate, top_channel_group: r.topChannelGroup,
      })),
    };
  }
}
