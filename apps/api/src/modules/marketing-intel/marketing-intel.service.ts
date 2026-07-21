import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { miAnalyticsSnapshots } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// Marketing Intelligence push-back store (docs/48 phase 3). The standalone Python platform computes
// advanced MMM / Sentiment-Weighted RFM / TOWS in its own warehouse and PUSHES the results into the ERP
// over the public API (scope analytics:write); the ERP owns the data it renders at /marketing-intel and
// never joins across databases. This service owns the mi_analytics_snapshots table: the write (called
// from the public-API controller) and the read (called from the internal /marketing-intel page).
export const MI_SNAPSHOT_KINDS = ['mmm', 'rfm', 'tows'] as const;
export type MiSnapshotKind = (typeof MI_SNAPSHOT_KINDS)[number];

// The push body is validated at the public-API edge with this schema. payload is an opaque analytics blob
// (channels / segments / quadrants) — bounded to keep an abusive push from ballooning a row.
export const PushSnapshotsBody = z.object({
  snapshots: z.array(z.object({
    kind: z.enum(MI_SNAPSHOT_KINDS),
    payload: z.record(z.any()),
    model_run_ref: z.string().max(120).optional(),
  })).min(1).max(MI_SNAPSHOT_KINDS.length),
});
export type PushSnapshotsDto = z.infer<typeof PushSnapshotsBody>;

@Injectable()
export class MarketingIntelService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // WRITE (public API, scope analytics:write). Idempotent upsert of the LATEST snapshot per (tenant, kind).
  async pushSnapshots(body: PushSnapshotsDto, user: JwtUser) {
    const tenantId = user.tenantId;
    if (tenantId == null) {
      throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'API key is not bound to a tenant', messageTh: 'คีย์ API ไม่ได้ผูกกับผู้เช่า' });
    }
    const principal = user.apiKeyPrefix ?? user.username ?? 'apikey';
    const written: string[] = [];
    for (const s of body.snapshots) {
      await this.db.insert(miAnalyticsSnapshots)
        .values({ tenantId, kind: s.kind, payload: s.payload, modelRunRef: s.model_run_ref ?? null, source: 'mi-platform', pushedBy: principal })
        .onConflictDoUpdate({
          target: [miAnalyticsSnapshots.tenantId, miAnalyticsSnapshots.kind],
          set: { payload: s.payload, modelRunRef: s.model_run_ref ?? null, pushedBy: principal, pushedAt: new Date() },
        });
      written.push(s.kind);
    }
    return { pushed: written.length, kinds: written };
  }

  // READ (internal, /marketing-intel page). RLS scopes to the caller's tenant; returns the latest snapshot
  // per kind plus a freshness stamp so the UI can show "last updated" / a not-yet-pushed empty state.
  async getSummary(_user: JwtUser) {
    const rows = await this.db.select({
      kind: miAnalyticsSnapshots.kind,
      payload: miAnalyticsSnapshots.payload,
      modelRunRef: miAnalyticsSnapshots.modelRunRef,
      source: miAnalyticsSnapshots.source,
      pushedAt: miAnalyticsSnapshots.pushedAt,
    }).from(miAnalyticsSnapshots).where(inArray(miAnalyticsSnapshots.kind, [...MI_SNAPSHOT_KINDS]));

    const byKind: Record<string, unknown> = {};
    let updatedAt: Date | null = null;
    for (const r of rows) {
      byKind[r.kind] = { payload: r.payload, model_run_ref: r.modelRunRef, source: r.source, pushed_at: r.pushedAt };
      if (r.pushedAt && (updatedAt === null || r.pushedAt > updatedAt)) updatedAt = r.pushedAt;
    }
    return {
      mmm: byKind.mmm ?? null,
      rfm: byKind.rfm ?? null,
      tows: byKind.tows ?? null,
      updated_at: updatedAt,
      has_data: rows.length > 0,
    };
  }
}
