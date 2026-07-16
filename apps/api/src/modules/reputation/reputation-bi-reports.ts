import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { externalReviews, analyticsDailySnapshots, reputationConnections } from '../../database/schema';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import type { JwtUser } from '../../common/decorators';
import { ReputationReviewSyncService } from './reputation-review-sync.service';
import { ReputationAnalyticsSyncService } from './reputation-analytics-sync.service';
import { ReputationSlaService } from './reputation-sla.service';

// docs/47 — module-owned BI report generators. Two are idempotent "action" jobs that ride the scheduler
// (a tenant admin creates a `daily` subscription on /scheduled-reports, same shape as ar_collections_dunning
// / eam_pm_generate); the third is a read-only dashboard aggregate (same shape as marketing_roi), also
// exposed as a live read via BiService.reputationSummaryLive() → GET /api/bi/reputation-summary.
@Injectable()
export class ReputationBiReports implements BiReportSource {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly reviewSync: ReputationReviewSyncService,
    private readonly analyticsSync: ReputationAnalyticsSyncService,
    private readonly sla: ReputationSlaService,
  ) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'reputation_review_sync',
        generate: async (_f, user) => {
          const r = await this.reviewSync.syncTenant(user);
          return { data: r, summary: `Google review sync: ${r.reviews_synced} review(s) across ${r.locations} location(s)`, summaryTh: `ซิงก์รีวิว Google: ${r.reviews_synced} รีวิว จาก ${r.locations} สาขา` };
        },
      },
      {
        type: 'reputation_ga4_sync',
        generate: async (f, user) => {
          const r = await this.analyticsSync.syncTenant(user, f?.days ?? 7);
          return { data: r, summary: `GA4 sync: ${r.days_synced} day(s) across ${r.properties} propert${r.properties === 1 ? 'y' : 'ies'}`, summaryTh: `ซิงก์ GA4: ${r.days_synced} วัน จาก ${r.properties} พร็อพเพอร์ตี้` };
        },
      },
      {
        type: 'reputation_summary',
        generate: async (f, user) => {
          const data = await this.summary(user, f?.days ?? 30);
          return { data, summary: `Reputation: avg rating ${data.avg_rating ?? '–'} (${data.review_count} reviews), ${data.needs_attention} need a reply`, summaryTh: `คะแนนเฉลี่ย ${data.avg_rating ?? '–'} (${data.review_count} รีวิว) ต้องตอบกลับ ${data.needs_attention} รายการ` };
        },
      },
      {
        // MKT-16 — the review-response SLA breach digest. Idempotent detective read (no writes): surfaces
        // negative reviews left unanswered past the tenant's SLA so they can be actioned before the window
        // damages the public rating. Same schedulable shape as ar_collections_dunning.
        type: 'reputation_response_sla',
        generate: async (_f, user) => {
          const data = await this.sla.responseSla(user);
          return {
            data,
            summary: `Review-response SLA: ${data.breach_count} breached (≤${data.settings.sla_rating_threshold}★ unreplied past ${data.settings.sla_hours}h), ${data.open_count} open`,
            summaryTh: `SLA การตอบรีวิว: เกินกำหนด ${data.breach_count} รายการ (≤${data.settings.sla_rating_threshold}★ ยังไม่ตอบเกิน ${data.settings.sla_hours} ชม.), ค้าง ${data.open_count} รายการ`,
          };
        },
      },
    ];
  }

  async summary(user: JwtUser, days: number) {
    const tenantId = user.tenantId!;
    const since = new Date(Date.now() - days * 86400_000);

    const reviewAgg = await this.db.select({
      count: sql<number>`count(*)`.mapWith(Number),
      avgRating: sql<number | null>`avg(${externalReviews.rating})`.mapWith((v: string | null) => (v == null ? null : Number(v))),
      needsAttention: sql<number>`count(*) filter (where ${externalReviews.rating} <= 3 and ${externalReviews.replyComment} is null)`.mapWith(Number),
    }).from(externalReviews).where(and(eq(externalReviews.tenantId, tenantId), gte(externalReviews.syncedAt, since)));

    const recentReviews = await this.db.select().from(externalReviews)
      .where(and(eq(externalReviews.tenantId, tenantId), gte(externalReviews.syncedAt, since)))
      .orderBy(desc(externalReviews.reviewCreateTime)).limit(10);

    const analyticsAgg = await this.db.select({
      sessions: sql<number>`coalesce(sum(${analyticsDailySnapshots.sessions}), 0)`.mapWith(Number),
      conversions: sql<number>`coalesce(sum(${analyticsDailySnapshots.conversions}), 0)`.mapWith(Number),
      revenue: sql<number>`coalesce(sum(${analyticsDailySnapshots.totalRevenue}), 0)`.mapWith(Number),
    }).from(analyticsDailySnapshots).where(and(eq(analyticsDailySnapshots.tenantId, tenantId), gte(analyticsDailySnapshots.metricDate, since.toISOString().slice(0, 10))));

    const conns = await this.db.select().from(reputationConnections).where(eq(reputationConnections.tenantId, tenantId));

    return {
      window_days: days,
      review_count: reviewAgg[0]?.count ?? 0,
      avg_rating: reviewAgg[0]?.avgRating != null ? Math.round(reviewAgg[0].avgRating * 10) / 10 : null,
      needs_attention: reviewAgg[0]?.needsAttention ?? 0,
      recent_reviews: recentReviews.map((r) => ({ id: r.id, author_name: r.authorName, rating: r.rating, comment: r.comment, review_create_time: r.reviewCreateTime, has_reply: !!r.replyComment })),
      analytics: { sessions: analyticsAgg[0]?.sessions ?? 0, conversions: analyticsAgg[0]?.conversions ?? 0, revenue: analyticsAgg[0]?.revenue ?? 0 },
      connections: conns.map((c) => ({ platform: c.platform, status: c.status, last_synced_at: c.lastSyncedAt, last_error: c.lastError })),
    };
  }
}
