import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, ne, gt, gte, lt, lte, ilike, and, or, sql, desc, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { savedSegments, customerProfiles } from '../../database/schema/crm';
import { posMembers } from '../../database/schema/loyalty-members';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// Phase D1 — reusable, tenant-defined customer segments: a named set of rules (field/op/value) over member +
// RFM-profile fields, combined all/any, resolved to matching members on demand. The rule→SQL translation is
// SAFE by construction: only WHITELISTED fields map to a column, only known operators are used, and every
// value is BOUND by drizzle (no string interpolation of user input).

type Kind = 'num' | 'text' | 'bool';
// field name (API) → { column, kind }. posMembers + customerProfiles (left-joined) are the only sources.
const FIELDS: Record<string, { col: any; kind: Kind }> = {
  balance:          { col: posMembers.balance,          kind: 'num' },
  lifetime:         { col: posMembers.lifetime,         kind: 'num' },
  tier:             { col: posMembers.tier,             kind: 'text' },
  marketing_opt_in: { col: posMembers.marketingOptIn,   kind: 'bool' },
  segment:          { col: customerProfiles.rfmSegment, kind: 'text' },
  total_orders:     { col: customerProfiles.totalOrders, kind: 'num' },
  total_spend:      { col: customerProfiles.totalSpend,  kind: 'num' },
  recency:          { col: customerProfiles.rfmRecency,  kind: 'num' },
  frequency:        { col: customerProfiles.rfmFrequency, kind: 'num' },
  monetary:         { col: customerProfiles.rfmMonetary, kind: 'num' },
  preferred_channel:{ col: customerProfiles.preferredChannel, kind: 'text' },
  visit_count:      { col: customerProfiles.visitCount,  kind: 'num' },
  avg_order_value:  { col: customerProfiles.avgOrderValue, kind: 'num' },
  // G3 predictive scores — null until the member has a paid order (null never matches a rule).
  churn_risk:       { col: customerProfiles.churnRisk,    kind: 'num' },
  predicted_ltv:    { col: customerProfiles.predictedLtv, kind: 'num' },
};
const OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains'] as const;
type Op = (typeof OPS)[number];
export interface SegmentRule { field: string; op: Op; value: any }

@Injectable()
export class SavedSegmentsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  catalog() {
    return { fields: Object.entries(FIELDS).map(([key, v]) => ({ key, kind: v.kind })), operators: [...OPS], match_modes: ['all', 'any'] };
  }

  // Validate a rules array (whitelist fields + ops); throws BadRequest on anything unknown.
  private validate(rules: SegmentRule[]) {
    if (!Array.isArray(rules)) throw new BadRequestException({ code: 'BAD_RULES', message: 'rules must be an array', messageTh: 'กฎต้องเป็นรายการ' });
    for (const r of rules) {
      if (!FIELDS[r?.field]) throw new BadRequestException({ code: 'BAD_FIELD', message: `Unknown field '${r?.field}'`, messageTh: `ไม่รู้จักฟิลด์ '${r?.field}'` });
      if (!OPS.includes(r?.op)) throw new BadRequestException({ code: 'BAD_OP', message: `op must be one of ${OPS.join(', ')}`, messageTh: 'ตัวดำเนินการไม่ถูกต้อง' });
    }
  }

  // Build a single bound SQL condition for one rule (value always bound by drizzle).
  private cond(r: SegmentRule): SQL | undefined {
    const f = FIELDS[r.field];
    const col = f!.col;
    if (r.op === 'contains') return ilike(col, `%${String(r.value ?? '')}%`);
    const v = f!.kind === 'bool' ? (r.value === true || r.value === 'true') : f!.kind === 'num' ? String(r.value) : r.value;
    switch (r.op) {
      case 'eq': return eq(col, v);
      case 'ne': return ne(col, v);
      case 'gt': return gt(col, v);
      case 'gte': return gte(col, v);
      case 'lt': return lt(col, v);
      case 'lte': return lte(col, v);
    }
    return undefined;
  }

  // Combine a segment's rules into one WHERE (all ⇒ AND, any ⇒ OR). Empty ⇒ undefined (matches everyone).
  private where(rules: SegmentRule[], matchMode: string): SQL | undefined {
    const conds = rules.map((r) => this.cond(r)).filter((c): c is SQL => !!c);
    if (!conds.length) return undefined;
    return matchMode === 'any' ? or(...conds) : and(...conds);
  }

  async list(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(savedSegments).orderBy(desc(savedSegments.id));
    return { segments: rows.map(shape) };
  }

  async create(dto: { name: string; match_mode?: string; rules: SegmentRule[] }, user: JwtUser) {
    const name = (dto.name ?? '').trim();
    if (!name) throw new BadRequestException({ code: 'NAME_REQUIRED', message: 'name required', messageTh: 'ต้องระบุชื่อ' });
    const matchMode = dto.match_mode === 'any' ? 'any' : 'all';
    this.validate(dto.rules ?? []);
    const db = this.db;
    const [row] = await db.insert(savedSegments).values({ tenantId: user.tenantId, name, matchMode, rules: dto.rules ?? [], createdBy: user.username, updatedAt: new Date() }).returning();
    return shape(row);
  }

  async update(id: number, dto: { name?: string; match_mode?: string; rules?: SegmentRule[] }, user: JwtUser) {
    const db = this.db;
    const set: any = { updatedAt: new Date() };
    if (dto.name != null) set.name = dto.name.trim();
    if (dto.match_mode != null) set.matchMode = dto.match_mode === 'any' ? 'any' : 'all';
    if (dto.rules != null) { this.validate(dto.rules); set.rules = dto.rules; }
    const [row] = await db.update(savedSegments).set(set).where(eq(savedSegments.id, id)).returning();
    if (!row) throw new NotFoundException({ code: 'SEGMENT_NOT_FOUND', message: 'Segment not found', messageTh: 'ไม่พบเซกเมนต์' });
    return shape(row);
  }

  async remove(id: number, _user: JwtUser) {
    const db = this.db;
    const [row] = await db.delete(savedSegments).where(eq(savedSegments.id, id)).returning({ id: savedSegments.id });
    if (!row) throw new NotFoundException({ code: 'SEGMENT_NOT_FOUND', message: 'Segment not found', messageTh: 'ไม่พบเซกเมนต์' });
    return { id, deleted: true };
  }

  // Resolve a saved segment to its matching ACTIVE member rows for one tenant — the send-loop variant used
  // by campaign/blast delivery (Phase F1). EXPLICITLY tenant-scoped on both the segment and the members
  // (campaign sends also run from the Admin/cron path where RLS is bypassed). Returns full pos_members rows.
  async membersForSend(tx: any, tenantId: number, segmentId: number): Promise<any[]> {
    const [seg] = await tx.select().from(savedSegments).where(and(eq(savedSegments.id, segmentId), eq(savedSegments.tenantId, tenantId))).limit(1);
    if (!seg) throw new NotFoundException({ code: 'SEGMENT_NOT_FOUND', message: 'Segment not found', messageTh: 'ไม่พบเซกเมนต์' });
    const rules = (Array.isArray(seg.rules) ? seg.rules : []) as SegmentRule[];
    const w = this.where(rules, seg.matchMode);
    const cond = and(eq(posMembers.tenantId, tenantId), eq(posMembers.active, true), ...(w ? [w] : []));
    const rows = await tx.select({ m: posMembers }).from(posMembers)
      .leftJoin(customerProfiles, eq(customerProfiles.memberId, posMembers.id)).where(cond);
    return rows.map((r: any) => r.m);
  }

  // Does ONE member match a single rule? (Phase G1 journey skip-rules.) Same whitelist + bound values as
  // segment resolution — an unknown field/op throws BAD_FIELD/BAD_OP, never reaches SQL. Tenant-scoped.
  async memberMatchesRule(tx: any, tenantId: number, memberId: number, rule: SegmentRule): Promise<boolean> {
    this.validate([rule]);
    const w = this.cond(rule);
    const cond = and(eq(posMembers.tenantId, tenantId), eq(posMembers.id, memberId), ...(w ? [w] : []));
    const [row] = await tx.select({ id: posMembers.id }).from(posMembers)
      .leftJoin(customerProfiles, eq(customerProfiles.memberId, posMembers.id)).where(cond).limit(1);
    return !!row;
  }

  // Resolve a saved segment to its matching active members (paginated) + a total count.
  async resolve(id: number, opts: { limit?: number; offset?: number }, user: JwtUser) {
    const db = this.db;
    const [seg] = await db.select().from(savedSegments).where(eq(savedSegments.id, id)).limit(1);
    if (!seg) throw new NotFoundException({ code: 'SEGMENT_NOT_FOUND', message: 'Segment not found', messageTh: 'ไม่พบเซกเมนต์' });
    const rules = (Array.isArray(seg.rules) ? seg.rules : []) as SegmentRule[];
    const w = this.where(rules, seg.matchMode);
    const cond = w ? and(eq(posMembers.active, true), w) : eq(posMembers.active, true);
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);

    const base = db.select({
      id: posMembers.id, memberCode: posMembers.memberCode, name: posMembers.name, phone: posMembers.phone,
      tier: posMembers.tier, balance: posMembers.balance, segment: customerProfiles.rfmSegment,
    }).from(posMembers).leftJoin(customerProfiles, eq(customerProfiles.memberId, posMembers.id)).where(cond);
    const rows = await base.orderBy(desc(posMembers.id)).limit(limit).offset(offset);
    const [tot] = await db.select({ c: sql<number>`count(*)` }).from(posMembers).leftJoin(customerProfiles, eq(customerProfiles.memberId, posMembers.id)).where(cond);
    return {
      segment_id: id, name: seg.name, total: Number(tot?.c ?? 0), count: rows.length, limit, offset,
      members: rows.map((r: any) => ({ id: Number(r.id), member_code: r.memberCode, name: r.name, phone: r.phone, tier: r.tier, balance: n(r.balance), rfm_segment: r.segment ?? null })),
    };
  }
}

function shape(r: any) {
  return { id: Number(r.id), name: r.name, match_mode: r.matchMode, rules: Array.isArray(r.rules) ? r.rules : [], updated_at: r.updatedAt, created_by: r.createdBy };
}
