import { Inject, Injectable } from '@nestjs/common';
import { and, eq, lte, isNull, asc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { externalReviews, reputationResponseSettings } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// docs/47 next-level (MKT-16) — review-response SLA governance. A per-tenant policy defines WHICH external
// reviews need a timely response (rating <= threshold) and HOW FAST (sla_hours from the review's create
// time); the detective worklist computes, over the existing external_reviews rows, which negative reviews
// are still unreplied and by how long — splitting them into BREACHED (past the SLA) and OPEN (within it).
// Read/aggregate only — no GL posting, no review data written.

const DEFAULT_THRESHOLD = 3;
const DEFAULT_HOURS = 48;
const clampThreshold = (n: number) => Math.min(Math.max(Math.trunc(n), 1), 5);
const clampHours = (n: number) => Math.min(Math.max(Math.trunc(n), 1), 720); // ≤ 30 days

export interface ResponseSettingsInput {
  slaRatingThreshold?: number;
  slaHours?: number;
}

@Injectable()
export class ReputationSlaService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // GET /api/reputation/response-settings — the policy (defaults when unset).
  async getSettings(user: JwtUser) {
    const tenantId = user.tenantId!;
    const rows = await this.db.select().from(reputationResponseSettings)
      .where(eq(reputationResponseSettings.tenantId, tenantId)).limit(1);
    const row = rows[0];
    return {
      sla_rating_threshold: row?.slaRatingThreshold ?? DEFAULT_THRESHOLD,
      sla_hours: row?.slaHours ?? DEFAULT_HOURS,
      updated_by: row?.updatedBy ?? null,
      updated_at: row?.updatedAt ?? null,
      is_default: !row,
    };
  }

  // PUT /api/reputation/response-settings — upsert the per-tenant policy (change gated marketing/exec).
  async putSettings(user: JwtUser, input: ResponseSettingsInput) {
    const tenantId = user.tenantId!;
    const current = await this.getSettings(user);
    const threshold = clampThreshold(input.slaRatingThreshold ?? current.sla_rating_threshold);
    const hours = clampHours(input.slaHours ?? current.sla_hours);
    await this.db.insert(reputationResponseSettings)
      .values({ tenantId, slaRatingThreshold: threshold, slaHours: hours, updatedBy: user.username })
      .onConflictDoUpdate({
        target: reputationResponseSettings.tenantId,
        set: { slaRatingThreshold: threshold, slaHours: hours, updatedBy: user.username, updatedAt: sql`now()` },
      });
    return this.getSettings(user);
  }

  // GET /api/reputation/response-sla — the detective worklist: unreplied reviews at/below the rating
  // threshold, split into breached (past sla_hours) vs still-open (within the window), newest breach first.
  async responseSla(user: JwtUser) {
    const tenantId = user.tenantId!;
    const settings = await this.getSettings(user);
    const rows = await this.db.select().from(externalReviews)
      .where(and(
        eq(externalReviews.tenantId, tenantId),
        lte(externalReviews.rating, settings.sla_rating_threshold),
        isNull(externalReviews.replyComment),
      ))
      .orderBy(asc(externalReviews.reviewCreateTime));

    const now = Date.now();
    const items = rows
      .filter((r) => r.reviewCreateTime != null)
      .map((r) => {
        const ageHours = (now - new Date(r.reviewCreateTime!).getTime()) / 3_600_000;
        return {
          id: r.id, platform: r.platform, location_ref: r.locationRef,
          author_name: r.authorName, rating: r.rating, comment: r.comment,
          review_create_time: r.reviewCreateTime,
          age_hours: Math.round(ageHours * 10) / 10,
          breached: ageHours >= settings.sla_hours,
        };
      });

    const breaches = items.filter((i) => i.breached).sort((a, b) => b.age_hours - a.age_hours);
    const open = items.filter((i) => !i.breached).sort((a, b) => b.age_hours - a.age_hours);
    return {
      settings: { sla_rating_threshold: settings.sla_rating_threshold, sla_hours: settings.sla_hours },
      breach_count: breaches.length,
      open_count: open.length,
      breaches,
      open,
      generated_at: new Date(now).toISOString(),
    };
  }
}
