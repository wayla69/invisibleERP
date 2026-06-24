import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { alertRules, alertEvents, notifications, customerInventory, workflowInstances, purchaseRequests } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { MessagingService } from '../messaging/messaging.service';
import { WebhookService } from '../platform/webhook.service';

const n = (x: any) => Number(x) || 0;
const OPERATORS = ['gt', 'gte', 'lt', 'lte', 'eq'] as const;
type Operator = typeof OPERATORS[number];
const CHANNELS = ['notification', 'line', 'sms', 'email'] as const;

// Catalog of built-in metrics: each computes a single numeric value over the caller's tenant (RLS-scoped).
// Add to this map to expose a new metric to the rule builder — the engine + UI pick it up automatically.
const METRICS: Record<string, { label: string; labelEn: string; unit: string }> = {
  low_stock_count: { label: 'สินค้าต่ำกว่าจุดสั่งซื้อ', labelEn: 'Items below reorder point', unit: 'items' },
  approvals_overdue: { label: 'งานอนุมัติเกินกำหนด (SLA)', labelEn: 'Overdue approvals', unit: 'docs' },
  open_pr_count: { label: 'ใบขอซื้อรออนุมัติ', labelEn: 'Open purchase requisitions', unit: 'PRs' },
};

// Alert/notification rules engine. Tenant-defined rules over the metric catalog; the sweep evaluates each
// active rule and fires a notification (and optionally a LINE/SMS/email) when breached. No GL.
@Injectable()
export class AlertsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly messaging: MessagingService, @Optional() private readonly webhooks?: WebhookService) {}

  metrics() {
    return { metrics: Object.entries(METRICS).map(([key, m]) => ({ key, label: m.label, label_en: m.labelEn, unit: m.unit })), operators: OPERATORS, channels: CHANNELS };
  }

  // ── rule CRUD ──
  async createRule(dto: any, user: JwtUser) {
    const db = this.db as any;
    if (!METRICS[dto.metric]) throw new BadRequestException({ code: 'BAD_METRIC', message: `Unknown metric '${dto.metric}'`, messageTh: 'ไม่รู้จักตัวชี้วัดนี้' });
    if (!OPERATORS.includes(dto.operator)) throw new BadRequestException({ code: 'BAD_OPERATOR', message: 'Bad operator', messageTh: 'ตัวดำเนินการไม่ถูกต้อง' });
    if (!CHANNELS.includes(dto.channel)) throw new BadRequestException({ code: 'BAD_CHANNEL', message: 'Bad channel', messageTh: 'ช่องทางไม่ถูกต้อง' });
    if (dto.channel !== 'notification' && !dto.target_to) throw new BadRequestException({ code: 'NO_TARGET', message: 'target_to required for line/sms/email', messageTh: 'ต้องระบุผู้รับ' });
    const [r] = await db.insert(alertRules).values({
      tenantId: user.tenantId ?? null, name: dto.name, metric: dto.metric, operator: dto.operator, threshold: String(n(dto.threshold)),
      channel: dto.channel, targetRole: dto.target_role ?? null, targetTo: dto.target_to ?? null, severity: dto.severity ?? 'warning',
      cooldownHours: dto.cooldown_hours ?? 12, active: dto.active ?? true, createdBy: user.username,
    }).returning({ id: alertRules.id });
    return { id: Number(r.id), name: dto.name, metric: dto.metric };
  }

  async listRules(_user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(alertRules).orderBy(desc(alertRules.id));
    return { rules: rows.map((r: any) => ({ id: Number(r.id), name: r.name, metric: r.metric, operator: r.operator, threshold: n(r.threshold), channel: r.channel, target_role: r.targetRole, target_to: r.targetTo, severity: r.severity, cooldown_hours: r.cooldownHours, active: r.active, last_fired_at: r.lastFiredAt })) };
  }

  async setActive(id: number, active: boolean, user: JwtUser) {
    const db = this.db as any;
    const upd = await db.update(alertRules).set({ active }).where(and(eq(alertRules.tenantId, user.tenantId as any), eq(alertRules.id, id))).returning({ id: alertRules.id });
    if (!upd.length) throw new NotFoundException({ code: 'RULE_NOT_FOUND', message: 'Rule not found', messageTh: 'ไม่พบกฎ' });
    return { id, active };
  }
  async removeRule(id: number, user: JwtUser) {
    const db = this.db as any;
    await db.delete(alertRules).where(and(eq(alertRules.tenantId, user.tenantId as any), eq(alertRules.id, id)));
    return { id, deleted: true };
  }

  async events(_user: JwtUser, limit = 100) {
    const db = this.db as any;
    const rows = await db.select().from(alertEvents).orderBy(desc(alertEvents.id)).limit(limit);
    return { events: rows.map((e: any) => ({ id: Number(e.id), rule_id: e.ruleId != null ? Number(e.ruleId) : null, name: e.name, metric: e.metric, value: n(e.value), threshold: n(e.threshold), severity: e.severity, channel: e.channel, message: e.message, fired_at: e.firedAt })) };
  }

  // ── evaluation ──
  // Compute one metric's value over the caller's tenant (RLS-scoped).
  private async evaluateMetric(key: string): Promise<number> {
    const db = this.db as any;
    if (key === 'low_stock_count') {
      const [r] = await db.select({ c: sql<number>`count(*)` }).from(customerInventory).where(sql`coalesce(${customerInventory.currentStock},0) < coalesce(${customerInventory.reorderPoint},0)`);
      return Number(r?.c ?? 0);
    }
    if (key === 'approvals_overdue') {
      const [r] = await db.select({ c: sql<number>`count(*)` }).from(workflowInstances).where(and(eq(workflowInstances.status, 'pending'), sql`${workflowInstances.dueAt} is not null and ${workflowInstances.dueAt} < now()`));
      return Number(r?.c ?? 0);
    }
    if (key === 'open_pr_count') {
      const [r] = await db.select({ c: sql<number>`count(*)` }).from(purchaseRequests).where(eq(purchaseRequests.status, 'Pending'));
      return Number(r?.c ?? 0);
    }
    return 0;
  }

  private breached(value: number, operator: Operator, threshold: number): boolean {
    switch (operator) {
      case 'gt': return value > threshold;
      case 'gte': return value >= threshold;
      case 'lt': return value < threshold;
      case 'lte': return value <= threshold;
      case 'eq': return value === threshold;
    }
  }

  // Cron-callable: evaluate every active rule for the tenant, fire those breached (respecting cooldown).
  async run(user: JwtUser) {
    const db = this.db as any;
    const rules = await db.select().from(alertRules).where(eq(alertRules.active, true));
    const now = Date.now();
    const fired: any[] = [];
    let suppressed = 0;
    for (const rule of rules) {
      const value = await this.evaluateMetric(rule.metric);
      if (!this.breached(value, rule.operator, n(rule.threshold))) continue;
      // cooldown: skip if fired recently
      if (rule.lastFiredAt && (now - new Date(rule.lastFiredAt).getTime()) < n(rule.cooldownHours) * 3600 * 1000) { suppressed++; continue; }
      const m = METRICS[rule.metric];
      const message = `${rule.name}: ${m?.labelEn ?? rule.metric} = ${value} (${rule.operator} ${n(rule.threshold)})`;
      const messageTh = `${rule.name}: ${m?.label ?? rule.metric} = ${value}`;
      // deliver
      if (rule.channel === 'notification') {
        await db.insert(notifications).values({ targetTenantId: rule.tenantId, targetRole: rule.targetRole ?? null, message: messageTh, messageEn: message });
      } else {
        try { await this.messaging.send({ to: rule.targetTo, channel: rule.channel, body: messageTh, campaign: 'alert' }, user); } catch { /* delivery best-effort; the event is still logged */ }
      }
      await db.insert(alertEvents).values({ tenantId: rule.tenantId, ruleId: Number(rule.id), name: rule.name, metric: rule.metric, value: String(value), threshold: String(n(rule.threshold)), severity: rule.severity, channel: rule.channel, message });
      await db.update(alertRules).set({ lastFiredAt: new Date() }).where(eq(alertRules.id, rule.id));
      // also fan out to any subscribed outbound webhooks (best-effort, never blocks the sweep)
      await this.webhooks?.emit('alert.fired', { rule_id: Number(rule.id), name: rule.name, metric: rule.metric, value, threshold: n(rule.threshold), severity: rule.severity }, user);
      fired.push({ rule_id: Number(rule.id), name: rule.name, metric: rule.metric, value, threshold: n(rule.threshold), severity: rule.severity, channel: rule.channel });
    }
    return { evaluated: rules.length, fired_count: fired.length, suppressed, fired };
  }

  // Evaluate (no firing) — a preview for the builder so a user sees current metric values.
  async preview(user: JwtUser) {
    const out: Record<string, number> = {};
    for (const key of Object.keys(METRICS)) out[key] = await this.evaluateMetric(key);
    return { values: out };
  }
}
