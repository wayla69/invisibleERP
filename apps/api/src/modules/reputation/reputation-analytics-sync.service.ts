import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { analyticsDailySnapshots, reputationConnections } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { GoogleOAuthService } from './google-oauth.service';
import { ReputationConnectionsService } from './reputation-connections.service';

const RUN_REPORT_URL = (propertyRef: string) => `https://analyticsdata.googleapis.com/v1beta/${propertyRef}:runReport`;

// docs/47 — polls the GA4 Data API for daily sessions/users/conversions/revenue per tracked property and
// upserts them (idempotent on (tenant_id, property_ref, metric_date)). Rides the BI report scheduler.
@Injectable()
export class ReputationAnalyticsSyncService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly oauth: GoogleOAuthService,
    private readonly connections: ReputationConnectionsService,
  ) {}

  async syncTenant(user: JwtUser, lookbackDays = 7): Promise<{ connections: number; properties: number; days_synced: number; errors: string[] }> {
    const tenantId = user.tenantId;
    if (tenantId == null) return { connections: 0, properties: 0, days_synced: 0, errors: ['NO_TENANT'] };
    const conns = await this.connections.activeFor(tenantId, 'google_analytics');
    let properties = 0, daysSynced = 0;
    const errors: string[] = [];
    for (const conn of conns) {
      const refs = Array.isArray(conn.externalRefs) ? (conn.externalRefs as { ref: string }[]) : [];
      try {
        const accessToken = await this.oauth.freshAccessToken(conn);
        for (const target of refs) {
          properties++;
          daysSynced += await this.syncProperty(tenantId, target.ref, accessToken, lookbackDays);
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
    return { connections: conns.length, properties, days_synced: daysSynced, errors };
  }

  private async syncProperty(tenantId: number, propertyRef: string, accessToken: string, lookbackDays: number): Promise<number> {
    const body = {
      dateRanges: [{ startDate: `${lookbackDays}daysAgo`, endDate: 'yesterday' }],
      dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'conversions' }, { name: 'totalRevenue' }, { name: 'engagementRate' }],
    };
    const res = await fetch(RUN_REPORT_URL(propertyRef), {
      method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GA4 runReport failed (${res.status}) for ${propertyRef}`);
    const json: any = await res.json().catch(() => ({}));
    // Aggregate rows by date (GA4 returns one row per date × channel-group; roll up to a daily total, and
    // keep the top channel group by sessions for the day as a coarse "where traffic came from" signal).
    const byDate = new Map<string, { sessions: number; activeUsers: number; conversions: number; totalRevenue: number; engagementRateSum: number; rows: number; topChannel: string; topChannelSessions: number }>();
    for (const row of json.rows ?? []) {
      const date = row.dimensionValues?.[0]?.value as string; // YYYYMMDD
      const channel = row.dimensionValues?.[1]?.value as string;
      const [sessions, activeUsers, conversions, totalRevenue, engagementRate] = (row.metricValues ?? []).map((m: any) => Number(m.value) || 0);
      const agg = byDate.get(date) ?? { sessions: 0, activeUsers: 0, conversions: 0, totalRevenue: 0, engagementRateSum: 0, rows: 0, topChannel: channel, topChannelSessions: 0 };
      agg.sessions += sessions; agg.activeUsers += activeUsers; agg.conversions += conversions; agg.totalRevenue += totalRevenue;
      agg.engagementRateSum += engagementRate; agg.rows++;
      if (sessions > agg.topChannelSessions) { agg.topChannel = channel; agg.topChannelSessions = sessions; }
      byDate.set(date, agg);
    }
    let synced = 0;
    for (const [ymd, agg] of byDate) {
      const metricDate = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
      await this.db.insert(analyticsDailySnapshots).values({
        tenantId, propertyRef, metricDate,
        sessions: agg.sessions, activeUsers: agg.activeUsers, conversions: agg.conversions,
        totalRevenue: agg.totalRevenue.toFixed(2), engagementRate: (agg.engagementRateSum / agg.rows).toFixed(4),
        topChannelGroup: agg.topChannel, raw: {}, syncedAt: new Date(),
      }).onConflictDoUpdate({
        target: [analyticsDailySnapshots.tenantId, analyticsDailySnapshots.propertyRef, analyticsDailySnapshots.metricDate],
        set: {
          sessions: agg.sessions, activeUsers: agg.activeUsers, conversions: agg.conversions,
          totalRevenue: agg.totalRevenue.toFixed(2), engagementRate: (agg.engagementRateSum / agg.rows).toFixed(4),
          topChannelGroup: agg.topChannel, syncedAt: new Date(),
        },
      });
      synced++;
    }
    return synced;
  }
}
