import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, or, inArray, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { crmActivities, crmStageHistory, crmFeedPosts, crmOpportunities, crmLeads, crmAccounts, notifications } from '../../../database/schema';
import { quotes } from '../../../database/schema/cpq';
import { users } from '../../../database/schema/users';
import { n } from '../../../database/queries';
import type { JwtUser } from './../../../common/decorators';

// CRM-8 unified activity timeline + collaboration feed (control CRM-14, migration 0407).
//
// ONE canonical, tenant-scoped, chronological record of every touch on a customer record — so a deal's full
// interaction history (calls/emails/meetings/notes, outbound + inbound comms, cadence touches, stage
// transitions, linked quotes) plus the internal collaboration feed is auditable in one place, nothing siloed.
// The feed (crm_feed_posts) is APPEND-ONLY: a posted note is immutable, so the decision/collaboration trail
// cannot be silently rewritten; @-mentions are validated against the tenant's active users and each mentioned
// user is routed a directed notification (notifications.target_username).
//
// Read-only over the CRM spine (+ the linked CPQ quotes, mirroring getOpportunity) except the one append-only
// feed insert. Entities are existence-checked against the caller's tenant before any read/write (BOLA-safe).
type Entity = { type: 'lead' | 'opportunity' | 'account'; no: string };
type TimelineItem = { kind: 'activity' | 'stage' | 'quote' | 'feed'; at: string | Date | null; [k: string]: unknown };

const MENTION_RE = /@([A-Za-z0-9_.\-]{2,40})/g;
const MAX_ITEMS = 500;

@Injectable()
export class CrmTimelineService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private assertEntityType(t: string): asserts t is Entity['type'] {
    if (t !== 'lead' && t !== 'opportunity' && t !== 'account')
      throw new BadRequestException({ code: 'BAD_ENTITY_TYPE', message: 'entity_type must be lead | opportunity | account', messageTh: 'ประเภทเอนทิตีไม่ถูกต้อง' });
  }

  private tenantCond<T extends { tenantId: any }>(col: T['tenantId'], user: JwtUser) {
    return user.tenantId != null ? eq(col, user.tenantId) : undefined;
  }

  // Resolve + existence-check the entity in the caller's tenant. Returns the opportunity row (for stage/quote
  // reads) or null, and the account id when the entity is an account (to roll its opportunities up).
  private async resolveOpp(oppNo: string, user: JwtUser) {
    const [o] = await this.db.select().from(crmOpportunities)
      .where(and(eq(crmOpportunities.oppNo, oppNo), this.tenantCond(crmOpportunities.tenantId, user))).limit(1);
    return o;
  }

  private async oppsOfAccount(accountId: number, user: JwtUser) {
    return this.db.select().from(crmOpportunities)
      .where(and(eq(crmOpportunities.accountId, accountId), this.tenantCond(crmOpportunities.tenantId, user)));
  }

  private async requireEntity(entity: Entity, user: JwtUser): Promise<{ accountId?: number }> {
    if (entity.type === 'opportunity') {
      if (!(await this.resolveOpp(entity.no, user))) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Opportunity not found', messageTh: 'ไม่พบโอกาสการขาย' });
      return {};
    }
    if (entity.type === 'lead') {
      const [l] = await this.db.select({ id: crmLeads.id }).from(crmLeads)
        .where(and(eq(crmLeads.leadNo, entity.no), this.tenantCond(crmLeads.tenantId, user))).limit(1);
      if (!l) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Lead not found', messageTh: 'ไม่พบลีด' });
      return {};
    }
    const [a] = await this.db.select({ id: crmAccounts.id }).from(crmAccounts)
      .where(and(eq(crmAccounts.accountNo, entity.no), this.tenantCond(crmAccounts.tenantId, user))).limit(1);
    if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Account not found', messageTh: 'ไม่พบบัญชีลูกค้า' });
    return { accountId: Number(a.id) };
  }

  // Every activity/stage/quote/feed item touching ONE opportunity (and its originating lead's activities).
  private async collectForOpp(o: any, items: TimelineItem[]) {
    const db = this.db;
    const actConds = [and(eq(crmActivities.entityType, 'opportunity'), eq(crmActivities.entityNo, o.oppNo))];
    if (o.leadNo) actConds.push(and(eq(crmActivities.entityType, 'lead'), eq(crmActivities.entityNo, o.leadNo)));
    const acts = await db.select().from(crmActivities).where(or(...actConds)).orderBy(desc(crmActivities.id)).limit(300);
    for (const a of acts) items.push(this.shapeActivity(a));

    const hist = await db.select().from(crmStageHistory).where(eq(crmStageHistory.opportunityId, Number(o.id)));
    for (const h of hist) items.push({ kind: 'stage', at: h.changedAt, id: Number(h.id), from_stage: h.fromStage, to_stage: h.toStage, changed_by: h.changedBy });

    const qs = await db.select().from(quotes).where(eq(quotes.crmOpportunityId, Number(o.id))).limit(100);
    for (const q of qs) items.push({ kind: 'quote', at: q.createdAt, id: Number(q.id), quote_no: q.quoteNo, status: q.status, total: n(q.total) });

    await this.collectFeed('opportunity', o.oppNo, items);
  }

  private async collectFeed(entityType: string, entityNo: string, items: TimelineItem[]) {
    const posts = await this.db.select().from(crmFeedPosts)
      .where(and(eq(crmFeedPosts.entityType, entityType), eq(crmFeedPosts.entityNo, entityNo)))
      .orderBy(desc(crmFeedPosts.id)).limit(200);
    for (const p of posts) items.push(this.shapeFeed(p));
  }

  private shapeActivity(a: any): TimelineItem {
    return { kind: 'activity', at: a.createdAt, id: Number(a.id), entity_type: a.entityType, entity_no: a.entityNo, type: a.type, subject: a.subject, notes: a.notes, source: a.source ?? null, owner: a.owner, done: a.done === true };
  }
  private shapeFeed(p: any): TimelineItem {
    return { kind: 'feed', at: p.createdAt, id: Number(p.id), body: p.body, author: p.author, mentions: Array.isArray(p.mentions) ? p.mentions : [] };
  }

  // GET /api/crm/timeline?entity_type=&entity_no= — the unified, newest-first stream.
  async timeline(entityType: string, entityNo: string, user: JwtUser) {
    this.assertEntityType(entityType);
    if (!entityNo) throw new BadRequestException({ code: 'ENTITY_NO_REQUIRED', message: 'entity_no is required', messageTh: 'ต้องระบุหมายเลขเอนทิตี' });
    const entity: Entity = { type: entityType, no: entityNo };
    const { accountId } = await this.requireEntity(entity, user);
    const items: TimelineItem[] = [];

    if (entity.type === 'opportunity') {
      const o = await this.resolveOpp(entityNo, user);
      if (o) await this.collectForOpp(o, items);
    } else if (entity.type === 'lead') {
      const acts = await this.db.select().from(crmActivities)
        .where(and(eq(crmActivities.entityType, 'lead'), eq(crmActivities.entityNo, entityNo))).orderBy(desc(crmActivities.id)).limit(300);
      for (const a of acts) items.push(this.shapeActivity(a));
      await this.collectFeed('lead', entityNo, items);
    } else { // account — roll up its opportunities + account-level feed
      await this.collectFeed('account', entityNo, items);
      if (accountId != null) {
        const opps = await this.oppsOfAccount(accountId, user);
        for (const o of opps) await this.collectForOpp(o, items);
      }
    }

    items.sort((a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime());
    return { entity_type: entity.type, entity_no: entityNo, items: items.slice(0, MAX_ITEMS), count: Math.min(items.length, MAX_ITEMS) };
  }

  // GET /api/crm/feed?entity_type=&entity_no= — just the collaboration posts, newest-first.
  async listFeed(entityType: string, entityNo: string, user: JwtUser) {
    this.assertEntityType(entityType);
    await this.requireEntity({ type: entityType, no: entityNo }, user);
    const posts = await this.db.select().from(crmFeedPosts)
      .where(and(eq(crmFeedPosts.entityType, entityType), eq(crmFeedPosts.entityNo, entityNo), this.tenantCond(crmFeedPosts.tenantId, user)))
      .orderBy(desc(crmFeedPosts.id)).limit(200);
    return { entity_type: entityType, entity_no: entityNo, posts: posts.map((p) => this.shapeFeed(p)), count: posts.length };
  }

  // Validate @-mentions in a body against the tenant's ACTIVE users (unknown / other-tenant handles are dropped).
  private async validateMentions(body: string, user: JwtUser): Promise<string[]> {
    const handles = [...new Set([...body.matchAll(MENTION_RE)].map((m) => m[1]!))];
    if (!handles.length || user.tenantId == null) return [];
    const rows = await this.db.select({ username: users.username }).from(users)
      .where(and(inArray(users.username, handles), eq(users.tenantId, user.tenantId), eq(users.isActive, true)));
    return rows.map((r) => r.username);
  }

  // POST /api/crm/feed — append an immutable collaboration note; route each valid @mention a directed
  // notification (best-effort — a notification failure never blocks the post).
  async postFeed(dto: { entity_type: string; entity_no: string; body: string }, user: JwtUser) {
    this.assertEntityType(dto.entity_type);
    const body = (dto.body ?? '').trim();
    if (!body) throw new BadRequestException({ code: 'EMPTY_BODY', message: 'body is required', messageTh: 'ต้องระบุข้อความ' });
    if (body.length > 5000) throw new BadRequestException({ code: 'BODY_TOO_LONG', message: 'body exceeds 5000 chars', messageTh: 'ข้อความยาวเกินไป' });
    await this.requireEntity({ type: dto.entity_type as Entity['type'], no: dto.entity_no }, user);

    const mentions = await this.validateMentions(body, user);
    const [post] = await this.db.insert(crmFeedPosts)
      .values({ tenantId: user.tenantId ?? null, entityType: dto.entity_type, entityNo: dto.entity_no, body, mentions, author: user.username })
      .returning({ id: crmFeedPosts.id, createdAt: crmFeedPosts.createdAt });

    const label = `${dto.entity_type} ${dto.entity_no}`;
    const snippet = body.length > 120 ? `${body.slice(0, 117)}…` : body;
    for (const mentioned of mentions) {
      if (mentioned === user.username) continue; // don't self-notify
      try {
        await this.db.insert(notifications).values({
          targetTenantId: user.tenantId ?? null, targetRole: null, targetUsername: mentioned,
          message: `${user.username} กล่าวถึงคุณใน ${label}: ${snippet}`,
          messageEn: `${user.username} mentioned you on ${label}: ${snippet}`,
        });
      } catch { /* the notification rail must never block the post */ }
    }
    return { id: Number(post!.id), entity_type: dto.entity_type, entity_no: dto.entity_no, body, mentions, author: user.username, created_at: post!.createdAt };
  }
}

// zod-free body shape (the controller validates the wire body; this types the service boundary).
export type FeedPostBody = { entity_type: string; entity_no: string; body: string };
