import { Optional, Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { automationRules, automationExecutions, notifications } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { MessagingService } from '../messaging/messaging.service';
import { JourneysService } from '../journeys/journeys.service';

// Event catalog — the business events the app already emits (via the webhook dispatcher). New events can be
// added here as more emit-sites are wired; an unknown incoming event is ignored (forward-compatible).
const EVENTS = [
  { key: 'po.approved', label: 'ใบสั่งซื้อได้รับอนุมัติ', label_en: 'Purchase order approved', fields: ['po_no', 'vendor', 'total_amount', 'status', 'decided_by'] },
  { key: 'po.rejected', label: 'ใบสั่งซื้อถูกปฏิเสธ', label_en: 'Purchase order rejected', fields: ['po_no', 'vendor', 'total_amount', 'status', 'reason'] },
  { key: 'alert.fired', label: 'การแจ้งเตือนทำงาน', label_en: 'Alert rule fired', fields: ['rule_id', 'name', 'metric', 'value', 'threshold', 'severity'] },
  { key: 'loyalty.enrolled', label: 'สมัครสมาชิกใหม่', label_en: 'Loyalty member enrolled', fields: ['member_id', 'member_code', 'phone'] },
  { key: 'loyalty.earned', label: 'สะสมแต้ม', label_en: 'Loyalty points earned', fields: ['member_id', 'points_earned', 'balance', 'ref_doc'] },
  { key: 'loyalty.redeemed', label: 'แลกแต้ม', label_en: 'Loyalty points redeemed', fields: ['member_id', 'points_redeemed', 'redeem_value', 'balance', 'ref_doc'] },
  // W1 (docs/27): fired by the maintenance sweep's look-ahead, once per member × expire-by date.
  { key: 'loyalty.points_expiring', label: 'แต้มใกล้หมดอายุ', label_en: 'Loyalty points expiring soon', fields: ['member_id', 'expiring_points', 'days_left', 'expire_by'] },
  // W3 (docs/27): fired when an NPS answer scores ≤ 6 — wire to a service-recovery journey/notification.
  { key: 'loyalty.nps_detractor', label: 'ลูกค้าให้คะแนน NPS ต่ำ', label_en: 'NPS detractor response (≤6)', fields: ['member_id', 'score', 'comment', 'sale_ref'] },
] as const;
const EVENT_KEYS = EVENTS.map((e) => e.key) as readonly string[];
const ACTION_TYPES = ['notification', 'message', 'log', 'enroll_journey'] as const;
const OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'contains'] as const;

// Automation rules (Phase 13 — A4). A no-code "when EVENT [and CONDITION] then ACTION" engine. Rules are
// evaluated by runEvent() (called by the webhook dispatcher when an event fires, or on demand). Actions are
// non-GL, non-destructive side effects. RLS isolates every rule + execution to the caller's tenant.
@Injectable()
export class AutomationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly messaging: MessagingService,
    // Journey entry action (Phase G1); optional so partial harnesses still construct.
    @Optional() private readonly journeys?: JourneysService,
  ) {}

  catalog() {
    return { events: EVENTS.map((e) => ({ ...e })), action_types: [...ACTION_TYPES], operators: [...OPS] };
  }

  private shape = (r: any) => ({ id: Number(r.id), name: r.name, event_type: r.eventType, condition: r.condition ?? null, action: r.action ?? {}, active: r.active, last_fired_at: r.lastFiredAt, created_at: r.createdAt });

  // condition: null/empty = always; else { field, op, value } compared against the event payload.
  private matches(cond: any, payload: any): boolean {
    if (!cond || typeof cond !== 'object' || !cond.field) return true;
    const actual = payload?.[cond.field];
    const v = cond.value;
    switch (cond.op) {
      case 'gt': return Number(actual) > Number(v);
      case 'gte': return Number(actual) >= Number(v);
      case 'lt': return Number(actual) < Number(v);
      case 'lte': return Number(actual) <= Number(v);
      case 'ne': return String(actual) !== String(v);
      case 'contains': return String(actual ?? '').includes(String(v));
      case 'eq': default: return String(actual) === String(v);
    }
  }

  private async execAction(rule: any, payload: any, user: JwtUser): Promise<string> {
    const db = this.db as any;
    const a = rule.action || {};
    if (a.type === 'notification') {
      await db.insert(notifications).values({
        targetTenantId: rule.tenantId ?? user.tenantId ?? null,
        targetRole: a.target_role ?? null,
        message: a.message ?? `กฎอัตโนมัติ: ${rule.name}`,
        messageEn: a.message_en ?? `Automation: ${rule.name}`,
      });
      return 'notification';
    }
    if (a.type === 'enroll_journey') {
      // Enrol the event's member into a journey (Phase G1). Once-per-member (unique key) — a repeat event
      // is a no-op. Requires a member_id on the payload (loyalty.* events carry it).
      if (!this.journeys) throw new Error('journeys service unavailable');
      const memberId = Number(payload?.member_id);
      if (!memberId) throw new Error('enroll_journey requires payload.member_id');
      const r = await this.journeys.enroll(Number(a.journey_id), memberId, user, rule.tenantId ?? user.tenantId ?? undefined);
      return `enroll_journey:${a.journey_id}:${r.enrolled ? 'enrolled' : 'already'}`;
    }
    if (a.type === 'message') {
      if (!a.to || !a.channel) throw new Error('message action requires to + channel');
      await this.messaging.send({ to: a.to, channel: a.channel, body: a.message ?? rule.name, campaign: 'automation' }, user);
      return `message:${a.channel}`;
    }
    return `log:${rule.eventType}`;
  }

  // Evaluate every active rule for an event against the payload; execute matching rules' actions; log each.
  // Called by the webhook dispatcher (real events) and the /run-event endpoint (manual/test). Never throws.
  async runEvent(event: string, payload: any, user: JwtUser): Promise<{ event: string; matched: number; executed: number }> {
    const db = this.db as any;
    if (!EVENT_KEYS.includes(event)) return { event, matched: 0, executed: 0 };
    let rules: any[] = [];
    try { rules = await db.select().from(automationRules).where(and(eq(automationRules.eventType, event), eq(automationRules.active, true))); } catch { return { event, matched: 0, executed: 0 }; }
    let executed = 0;
    for (const rule of rules) {
      if (!this.matches(rule.condition, payload)) {
        await db.insert(automationExecutions).values({ tenantId: rule.tenantId, ruleId: rule.id, eventType: event, status: 'skipped', detail: 'condition not met' });
        continue;
      }
      try {
        const res = await this.execAction(rule, payload, user);
        await db.insert(automationExecutions).values({ tenantId: rule.tenantId, ruleId: rule.id, eventType: event, status: 'executed', detail: res });
        await db.update(automationRules).set({ lastFiredAt: new Date() }).where(eq(automationRules.id, rule.id));
        executed++;
      } catch (e: any) {
        await db.insert(automationExecutions).values({ tenantId: rule.tenantId, ruleId: rule.id, eventType: event, status: 'failed', detail: String(e?.message ?? e).slice(0, 200) });
      }
    }
    return { event, matched: rules.length, executed };
  }

  // ── CRUD ──
  async listRules(_user: JwtUser) {
    const rows = await (this.db as any).select().from(automationRules).where(eq(automationRules.active, true)).orderBy(desc(automationRules.id));
    return { rules: rows.map(this.shape) };
  }

  async createRule(dto: { name: string; event_type: string; condition?: any; action: any }, user: JwtUser) {
    const db = this.db as any;
    const name = (dto.name ?? '').trim();
    if (!name) throw new BadRequestException({ code: 'NAME_REQUIRED', message: 'name required', messageTh: 'ต้องระบุชื่อกฎ' });
    if (!EVENT_KEYS.includes(dto.event_type)) throw new BadRequestException({ code: 'BAD_EVENT', message: `Unknown event '${dto.event_type}'`, messageTh: 'เหตุการณ์ไม่ถูกต้อง' });
    const action = dto.action && typeof dto.action === 'object' ? dto.action : null;
    if (!action || !ACTION_TYPES.includes(action.type)) throw new BadRequestException({ code: 'BAD_ACTION', message: `action.type must be one of ${ACTION_TYPES.join(', ')}`, messageTh: 'ประเภทการกระทำไม่ถูกต้อง' });
    if (dto.condition && dto.condition.op && !OPS.includes(dto.condition.op)) throw new BadRequestException({ code: 'BAD_OPERATOR', message: `op must be one of ${OPS.join(', ')}`, messageTh: 'ตัวดำเนินการไม่ถูกต้อง' });
    const [row] = await db.insert(automationRules).values({
      tenantId: user.tenantId ?? null, name, eventType: dto.event_type,
      condition: dto.condition ?? null, action, active: true, createdBy: user.username, updatedBy: user.username,
    }).returning({ id: automationRules.id });
    return { id: Number(row.id), name, event_type: dto.event_type };
  }

  async updateRule(id: number, dto: { name?: string; condition?: any; action?: any; active?: boolean }, user: JwtUser) {
    const db = this.db as any;
    const [row] = await db.select().from(automationRules).where(eq(automationRules.id, id)).limit(1);
    if (!row) throw new NotFoundException({ code: 'RULE_NOT_FOUND', message: 'Rule not found', messageTh: 'ไม่พบกฎ' });
    const patch: any = { updatedBy: user.username, updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.condition !== undefined) patch.condition = dto.condition;
    if (dto.action !== undefined) {
      if (!dto.action || !ACTION_TYPES.includes(dto.action.type)) throw new BadRequestException({ code: 'BAD_ACTION', message: 'bad action', messageTh: 'ประเภทการกระทำไม่ถูกต้อง' });
      patch.action = dto.action;
    }
    if (dto.active !== undefined) patch.active = dto.active;
    await db.update(automationRules).set(patch).where(eq(automationRules.id, id));
    return { id, updated: true };
  }

  async removeRule(id: number, _user: JwtUser) {
    const upd = await (this.db as any).update(automationRules).set({ active: false }).where(eq(automationRules.id, id)).returning({ id: automationRules.id });
    if (!upd.length) throw new NotFoundException({ code: 'RULE_NOT_FOUND', message: 'Rule not found', messageTh: 'ไม่พบกฎ' });
    return { id, active: false };
  }

  async listExecutions(_user: JwtUser, limit = 50) {
    const rows = await (this.db as any).select().from(automationExecutions).orderBy(desc(automationExecutions.id)).limit(limit);
    return { executions: rows.map((r: any) => ({ id: Number(r.id), rule_id: r.ruleId != null ? Number(r.ruleId) : null, event_type: r.eventType, status: r.status, detail: r.detail, fired_at: r.firedAt })) };
  }
}
