import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { miAnalyticsSnapshots, customerProfiles, posMembers } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { CampaignsService } from '../campaigns/campaigns.service';

// Marketing Intelligence push-back store (docs/48 phase 3). The standalone Python platform computes
// advanced MMM / Sentiment-Weighted RFM / TOWS in its own warehouse and PUSHES the results into the ERP
// over the public API (scope analytics:write); the ERP owns the data it renders at /marketing-intel and
// never joins across databases. This service owns mi_analytics_snapshots (append-only history) and the
// per-customer mi_rfm_segment column, and turns an RFM segment into an ERP campaign (the action loop).
export const MI_SNAPSHOT_KINDS = ['mmm', 'rfm', 'tows'] as const;
export type MiSnapshotKind = (typeof MI_SNAPSHOT_KINDS)[number];

// An rfm snapshot MAY carry per-customer assignments (customer_no ⇒ segment) so the ERP can act on them
// (campaign targeting). Bounded so a runaway push can't balloon the request.
const RfmMember = z.object({ customer_no: z.string().min(1).max(120), segment: z.string().min(1).max(80) });
export const PushSnapshotsBody = z.object({
  snapshots: z.array(z.object({
    kind: z.enum(MI_SNAPSHOT_KINDS),
    payload: z.record(z.any()),
    model_run_ref: z.string().max(120).optional(),
    members: z.array(RfmMember).max(100_000).optional(), // rfm only — ignored for mmm/tows
  })).min(1).max(MI_SNAPSHOT_KINDS.length),
});
export type PushSnapshotsDto = z.infer<typeof PushSnapshotsBody>;

@Injectable()
export class MarketingIntelService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly campaigns: CampaignsService,
  ) {}

  // WRITE (public API, scope analytics:write). APPEND-only snapshot + (for rfm) the per-customer segment
  // assignment into customer_profiles.mi_rfm_segment (a column SEPARATE from the ERP's own rfm_segment).
  async pushSnapshots(body: PushSnapshotsDto, user: JwtUser) {
    const tenantId = user.tenantId;
    if (tenantId == null) {
      throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'API key is not bound to a tenant', messageTh: 'คีย์ API ไม่ได้ผูกกับผู้เช่า' });
    }
    const principal = user.apiKeyPrefix ?? user.username ?? 'apikey';
    const written: string[] = [];
    let membersApplied = 0;
    for (const s of body.snapshots) {
      await this.db.insert(miAnalyticsSnapshots)
        .values({ tenantId, kind: s.kind, payload: s.payload, modelRunRef: s.model_run_ref ?? null, source: 'mi-platform', pushedBy: principal });
      if (s.kind === 'rfm' && s.members?.length) membersApplied += await this.applyRfmMembers(tenantId, s.members);
      written.push(s.kind);
    }
    return { pushed: written.length, kinds: written, members_applied: membersApplied };
  }

  // Map the pushed customer_no (== pos_members.member_code) to member_id and stamp mi_rfm_segment on the
  // profile. Reset the tenant's assignments first so a customer dropped from a segment is cleared, then
  // set the current membership one UPDATE per segment.
  private async applyRfmMembers(tenantId: number, members: { customer_no: string; segment: string }[]): Promise<number> {
    const codes = [...new Set(members.map((m) => m.customer_no))];
    const rows = await this.db.select({ id: posMembers.id, code: posMembers.memberCode })
      .from(posMembers).where(and(eq(posMembers.tenantId, tenantId), inArray(posMembers.memberCode, codes)));
    const idByCode = new Map(rows.map((r) => [r.code as string, Number(r.id)]));

    await this.db.update(customerProfiles).set({ miRfmSegment: null }).where(eq(customerProfiles.tenantId, tenantId));

    const idsBySegment = new Map<string, number[]>();
    for (const m of members) {
      const id = idByCode.get(m.customer_no);
      if (id == null) continue;
      (idsBySegment.get(m.segment) ?? idsBySegment.set(m.segment, []).get(m.segment)!).push(id);
    }
    let applied = 0;
    for (const [segment, ids] of idsBySegment) {
      if (!ids.length) continue;
      await this.db.update(customerProfiles).set({ miRfmSegment: segment })
        .where(and(eq(customerProfiles.tenantId, tenantId), inArray(customerProfiles.memberId, ids)));
      applied += ids.length;
    }
    return applied;
  }

  // READ (internal, /marketing-intel page). RLS scopes to the caller's tenant; returns the latest snapshot
  // per kind (append-only ⇒ pick the newest) + a freshness stamp for the "last updated" / empty state.
  async getSummary(_user: JwtUser) {
    const rows = await this.db.select({
      kind: miAnalyticsSnapshots.kind,
      payload: miAnalyticsSnapshots.payload,
      modelRunRef: miAnalyticsSnapshots.modelRunRef,
      source: miAnalyticsSnapshots.source,
      pushedAt: miAnalyticsSnapshots.pushedAt,
    }).from(miAnalyticsSnapshots)
      .where(inArray(miAnalyticsSnapshots.kind, [...MI_SNAPSHOT_KINDS]))
      .orderBy(desc(miAnalyticsSnapshots.pushedAt));

    const latest: Record<string, unknown> = {};
    let updatedAt: Date | null = null;
    for (const r of rows) {
      if (!(r.kind in latest)) latest[r.kind] = { payload: r.payload, model_run_ref: r.modelRunRef, source: r.source, pushed_at: r.pushedAt };
      if (r.pushedAt && (updatedAt === null || r.pushedAt > updatedAt)) updatedAt = r.pushedAt;
    }
    return {
      mmm: latest.mmm ?? null,
      rfm: latest.rfm ?? null,
      tows: latest.tows ?? null,
      updated_at: updatedAt,
      has_data: rows.length > 0,
    };
  }

  // READ — the MMM trend: the recent runs' headline metrics (R², spend, top channel) for period comparison.
  async getMmmHistory(_user: JwtUser, limit = 12) {
    const rows = await this.db.select({ payload: miAnalyticsSnapshots.payload, modelRunRef: miAnalyticsSnapshots.modelRunRef, pushedAt: miAnalyticsSnapshots.pushedAt })
      .from(miAnalyticsSnapshots)
      .where(eq(miAnalyticsSnapshots.kind, 'mmm'))
      .orderBy(desc(miAnalyticsSnapshots.pushedAt))
      .limit(Math.min(Math.max(limit, 1), 60));
    return {
      runs: rows.map((r) => {
        const p: any = r.payload ?? {};
        const channels: any[] = Array.isArray(p.channels) ? p.channels : [];
        const top = channels.length ? [...channels].sort((a, b) => (Number(b?.roi) || 0) - (Number(a?.roi) || 0))[0] : null;
        return {
          pushed_at: r.pushedAt,
          model_run_ref: r.modelRunRef,
          r2: p.r2 ?? null,
          total_spend: p.total_spend ?? null,
          top_channel: top ? String(top.channel) : null,
          top_channel_roi: top?.roi ?? null,
        };
      }),
    };
  }

  // How many members currently carry each pushed segment (for the "activate" affordance on the page).
  async segmentCounts(user: JwtUser) {
    const tenantId = user.tenantId;
    if (tenantId == null) return { segments: [] };
    const rows = await this.db.select({ segment: customerProfiles.miRfmSegment, count: customerProfiles.memberId })
      .from(customerProfiles)
      .where(and(eq(customerProfiles.tenantId, tenantId)));
    const counts = new Map<string, number>();
    for (const r of rows) { if (r.segment) counts.set(r.segment as string, (counts.get(r.segment as string) ?? 0) + 1); }
    return { segments: [...counts.entries()].map(([segment, members]) => ({ segment, members })).sort((a, b) => b.members - a.members) };
  }

  // ACTION LOOP — turn a pushed RFM segment into a DRAFT ERP campaign (audience=mi_segment). It reuses the
  // existing consent-gated campaign delivery; a human edits the body + sends (never auto-blasts).
  async activateSegment(dto: { segment: string; channel?: 'sms' | 'email' | 'line'; body?: string }, user: JwtUser) {
    const tenantId = user.tenantId;
    if (tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'no tenant', messageTh: 'ไม่มีผู้เช่า' });
    const seg = (dto.segment ?? '').trim();
    if (!seg) throw new BadRequestException({ code: 'NO_SEGMENT', message: 'segment required', messageTh: 'ต้องระบุกลุ่ม' });
    const present = await this.db.select({ id: customerProfiles.memberId }).from(customerProfiles)
      .where(and(eq(customerProfiles.tenantId, tenantId), eq(customerProfiles.miRfmSegment, seg))).limit(1);
    if (!present.length) throw new BadRequestException({ code: 'EMPTY_SEGMENT', message: `no members in segment "${seg}" — push RFM first`, messageTh: 'ไม่มีสมาชิกในกลุ่มนี้ (ยังไม่ push RFM)' });
    return this.campaigns.upsertCampaign(user, {
      name: `MI · ${seg}`,
      channel: dto.channel ?? 'sms',
      audience: 'mi_segment',
      segment: seg,
      body: dto.body ?? `ข้อความถึงกลุ่ม ${seg} (แก้ไขก่อนส่ง)`,
    });
  }
}
