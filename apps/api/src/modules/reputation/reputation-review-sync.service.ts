import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { externalReviews, reputationConnections } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { GoogleOAuthService } from './google-oauth.service';
import { ReputationConnectionsService } from './reputation-connections.service';

// docs/47 — polls Google Business Profile reviews per tracked location and upserts them (idempotent on
// (tenant_id, platform, external_review_id)). Rides the BI report scheduler (reputation-bi-reports.ts) —
// a tenant admin schedules this daily on /scheduled-reports, exactly like ar_collections_dunning.
@Injectable()
export class ReputationReviewSyncService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly oauth: GoogleOAuthService,
    private readonly connections: ReputationConnectionsService,
  ) {}

  async syncTenant(user: JwtUser): Promise<{ connections: number; locations: number; reviews_synced: number; errors: string[] }> {
    const tenantId = user.tenantId;
    if (tenantId == null) return { connections: 0, locations: 0, reviews_synced: 0, errors: ['NO_TENANT'] };
    const conns = await this.connections.activeFor(tenantId, 'google_maps');
    let locations = 0, reviewsSynced = 0;
    const errors: string[] = [];
    for (const conn of conns) {
      const refs = Array.isArray(conn.externalRefs) ? (conn.externalRefs as { ref: string }[]) : [];
      try {
        const accessToken = await this.oauth.freshAccessToken(conn);
        for (const target of refs) {
          locations++;
          reviewsSynced += await this.syncLocation(tenantId, target.ref, accessToken);
        }
        await this.db.update(reputationConnections)
          .set({ lastSyncedAt: new Date(), lastError: null, updatedAt: new Date() })
          .where(eq(reputationConnections.id, conn.id));
      } catch (e: any) {
        const msg = e?.message ?? 'sync failed';
        errors.push(msg);
        await this.db.update(reputationConnections)
          .set({ lastError: msg, updatedAt: new Date() })
          .where(eq(reputationConnections.id, conn.id));
      }
    }
    return { connections: conns.length, locations, reviews_synced: reviewsSynced, errors };
  }

  private async syncLocation(tenantId: number, locationRef: string, accessToken: string): Promise<number> {
    let pageToken: string | undefined;
    let synced = 0;
    do {
      const url = new URL(`https://mybusiness.googleapis.com/v4/${locationRef}/reviews`);
      url.searchParams.set('pageSize', '50');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error(`GBP reviews.list failed (${res.status}) for ${locationRef}`);
      const json: any = await res.json().catch(() => ({}));
      for (const rev of json.reviews ?? []) {
        await this.db.insert(externalReviews).values({
          tenantId, platform: 'google_maps', locationRef, externalReviewId: rev.reviewId,
          authorName: rev.reviewer?.displayName ?? null, authorPhotoUrl: rev.reviewer?.profilePhotoUrl ?? null,
          rating: starRatingToInt(rev.starRating), comment: rev.comment ?? null,
          reviewCreateTime: rev.createTime ? new Date(rev.createTime) : null,
          reviewUpdateTime: rev.updateTime ? new Date(rev.updateTime) : null,
          replyComment: rev.reviewReply?.comment ?? null,
          replyUpdateTime: rev.reviewReply?.updateTime ? new Date(rev.reviewReply.updateTime) : null,
          syncedAt: new Date(),
        }).onConflictDoUpdate({
          target: [externalReviews.tenantId, externalReviews.platform, externalReviews.externalReviewId],
          set: {
            rating: starRatingToInt(rev.starRating), comment: rev.comment ?? null,
            reviewUpdateTime: rev.updateTime ? new Date(rev.updateTime) : null,
            replyComment: rev.reviewReply?.comment ?? null,
            replyUpdateTime: rev.reviewReply?.updateTime ? new Date(rev.reviewReply.updateTime) : null,
            syncedAt: new Date(),
          },
        });
        synced++;
      }
      pageToken = json.nextPageToken;
    } while (pageToken);
    return synced;
  }

  // POST /api/reputation/reviews/:id/reply — reply to a review via the Business Profile API.
  async reply(user: JwtUser, reviewId: number, comment: string): Promise<{ ok: true }> {
    const tenantId = user.tenantId!;
    const [review] = await this.db.select().from(externalReviews)
      .where(and(eq(externalReviews.id, reviewId), eq(externalReviews.tenantId, tenantId))).limit(1);
    if (!review) throw new Error('REVIEW_NOT_FOUND');
    const conns = await this.connections.activeFor(tenantId, 'google_maps');
    const conn = conns.find((c) => (Array.isArray(c.externalRefs) ? (c.externalRefs as { ref: string }[]) : []).some((t) => t.ref === review.locationRef));
    if (!conn) throw new Error('CONNECTION_NOT_FOUND');
    const accessToken = await this.oauth.freshAccessToken(conn);
    const res = await fetch(`https://mybusiness.googleapis.com/v4/${review.locationRef}/reviews/${review.externalReviewId}/reply`, {
      method: 'PUT', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ comment }),
    });
    if (!res.ok) throw new Error(`GBP updateReply failed (${res.status})`);
    await this.db.update(externalReviews).set({ replyComment: comment, replyUpdateTime: new Date(), syncedAt: new Date() }).where(eq(externalReviews.id, reviewId));
    return { ok: true };
  }
}

function starRatingToInt(v: string | undefined): number | null {
  // Business Profile API returns an enum: ONE..FIVE (or a bare number in some SDK shapes).
  const map: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  if (v == null) return null;
  if (map[v] != null) return map[v];
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
