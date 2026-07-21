import { Inject, Injectable, Optional } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DRIZZLE, runGlobalDb, type DrizzleDb } from '../../database/database.module';
import { plans, saasLifecycleEvents, subscriptions, tenants } from '../../database/schema';
import { logger } from '../../observability/logger';
import { PlatformNotificationsService } from '../platform-notifications/platform-notifications.module';
import { MailerService } from '../mailer/mailer.service';

// ── A2: SaaS trial/dunning lifecycle automation ─────────────────────────────────────────────────────────
// The daily 'saas_lifecycle' job (BI scheduler action job + god POST /api/admin/saas-lifecycle/run) walks
// every live subscription and takes the real-world operator actions god used to do by hand:
//   Trialing, ends in ≤7d / ≤1d  → trial_reminder email (T-7 and T-1, one each per trial end date)
//   Trialing, ended, paid plan   → grace window (SAAS_TRIAL_GRACE_DAYS, default 7) → auto-suspend
//                                  (company_suspended email + god inbox), reason 'trial expired'
//   Trialing, ended, ฿0 plan     → activate (free tier simply continues; enterprise-custom also flags
//                                  the god inbox — sales follows up, nothing is suspended)
//   PastDue                      → dunning ladder: payment_failed email at first detection, day ≥7 and
//                                  day ≥14; auto-suspend at ≥ SAAS_PASTDUE_SUSPEND_DAYS (default 21)
//   Active with an open cycle    → dunning_cleared (closes the ladder so a later PastDue restarts it)
// Every side effect is anchored on an idempotent saas_lifecycle_events row (unique dedup_key, insert
// ON CONFLICT DO NOTHING → the effect fires only when the insert landed), so overlapping schedules,
// manual sweeps, and re-runs can never double-remind or double-suspend. The decision logic is the pure
// planSaasLifecycle() below — unit-tested without a database.

export interface LifecycleSubRow {
  tenantId: number;
  tenantName: string;
  status: string | null;
  planCode: string;
  priceMonthly: number;
  trialEndsAt: Date | null;
  suspendedAt: Date | null;
  deleted: boolean;
  adminEmail: string | null;
}
export interface LifecycleEventRow { event: string; aboutTenantId: number; createdAt: Date }
export interface LifecycleAction {
  tenantId: number;
  event: 'trial_reminder_7' | 'trial_reminder_1' | 'trial_expired' | 'trial_free_activated' | 'trial_suspended' | 'dunning_1' | 'dunning_2' | 'dunning_3' | 'pastdue_suspended' | 'dunning_cleared';
  dedupKey: string;
  daysLeft?: number;
}
export interface LifecycleConfig { trialGraceDays: number; pastDueSuspendDays: number }

export const lifecycleConfigFromEnv = (): LifecycleConfig => ({
  trialGraceDays: Math.max(0, Number(process.env.SAAS_TRIAL_GRACE_DAYS ?? 7)),
  pastDueSuspendDays: Math.max(1, Number(process.env.SAAS_PASTDUE_SUSPEND_DAYS ?? 21)),
});

const DAY_MS = 86_400_000;
const ymdUtc = (d: Date): string => d.toISOString().slice(0, 10);

/** Pure planner: which lifecycle actions are due NOW for these subscriptions, given the event history.
 *  Dedup keys anchor on the trial end date / the dunning cycle start, so the same reminder can never fire
 *  twice for one trial, while a NEW trial end date (extended trial) legitimately re-arms the reminders. */
export function planSaasLifecycle(
  rows: LifecycleSubRow[],
  events: LifecycleEventRow[],
  now: Date,
  cfg: LifecycleConfig,
): LifecycleAction[] {
  const actions: LifecycleAction[] = [];
  const byTenant = new Map<number, LifecycleEventRow[]>();
  for (const e of events) {
    const list = byTenant.get(e.aboutTenantId) ?? [];
    list.push(e);
    byTenant.set(e.aboutTenantId, list);
  }
  for (const r of rows) {
    if (r.deleted || r.suspendedAt) continue; // already out of service — nothing to automate
    const tenantEvents = (byTenant.get(r.tenantId) ?? []).slice().sort((a, b) => +a.createdAt - +b.createdAt);
    if (r.status === 'Trialing' && r.trialEndsAt) {
      const endKey = ymdUtc(r.trialEndsAt);
      const daysLeft = Math.ceil((+r.trialEndsAt - +now) / DAY_MS);
      if (daysLeft > 0) {
        if (daysLeft <= 7) actions.push({ tenantId: r.tenantId, event: 'trial_reminder_7', dedupKey: `trial7:${r.tenantId}:${endKey}`, daysLeft });
        if (daysLeft <= 1) actions.push({ tenantId: r.tenantId, event: 'trial_reminder_1', dedupKey: `trial1:${r.tenantId}:${endKey}`, daysLeft });
      } else {
        const daysOver = Math.floor((+now - +r.trialEndsAt) / DAY_MS);
        if (r.priceMonthly <= 0) {
          // ฿0 plans have nothing to collect: free continues as Active; enterprise-custom is flagged to sales.
          actions.push({ tenantId: r.tenantId, event: 'trial_free_activated', dedupKey: `trialfree:${r.tenantId}:${endKey}` });
        } else if (daysOver >= cfg.trialGraceDays) {
          actions.push({ tenantId: r.tenantId, event: 'trial_suspended', dedupKey: `trialsuspend:${r.tenantId}:${endKey}` });
        } else {
          actions.push({ tenantId: r.tenantId, event: 'trial_expired', dedupKey: `trialexpired:${r.tenantId}:${endKey}` });
        }
      }
    }
    if (r.status === 'PastDue') {
      const lastStart = tenantEvents.filter((e) => e.event === 'dunning_1').pop();
      const lastClear = tenantEvents.filter((e) => e.event === 'dunning_cleared').pop();
      const cycleOpen = !!lastStart && (!lastClear || +lastClear.createdAt < +lastStart.createdAt);
      if (!cycleOpen) {
        actions.push({ tenantId: r.tenantId, event: 'dunning_1', dedupKey: `dun1:${r.tenantId}:${ymdUtc(now)}` });
      } else {
        const anchor = ymdUtc(lastStart!.createdAt);
        const daysIn = Math.floor((+now - +lastStart!.createdAt) / DAY_MS);
        if (daysIn >= cfg.pastDueSuspendDays) actions.push({ tenantId: r.tenantId, event: 'pastdue_suspended', dedupKey: `pdsuspend:${r.tenantId}:${anchor}` });
        else if (daysIn >= 14) actions.push({ tenantId: r.tenantId, event: 'dunning_3', dedupKey: `dun3:${r.tenantId}:${anchor}` });
        else if (daysIn >= 7) actions.push({ tenantId: r.tenantId, event: 'dunning_2', dedupKey: `dun2:${r.tenantId}:${anchor}` });
      }
    }
    if (r.status === 'Active') {
      const lastStart = tenantEvents.filter((e) => e.event === 'dunning_1').pop();
      const lastClear = tenantEvents.filter((e) => e.event === 'dunning_cleared').pop();
      if (lastStart && (!lastClear || +lastClear.createdAt < +lastStart.createdAt)) {
        actions.push({ tenantId: r.tenantId, event: 'dunning_cleared', dedupKey: `dunclear:${r.tenantId}:${ymdUtc(now)}` });
      }
    }
  }
  return actions;
}

@Injectable()
export class SaasLifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Optional() private readonly mailer?: MailerService,
    @Optional() private readonly platformNotifs?: PlatformNotificationsService,
  ) {}

  /** The daily sweep. Cross-tenant by nature → runs under the global-db scope (like seedPlans). */
  async runDaily(now = new Date()) {
    return runGlobalDb('saas-lifecycle:run', async () => {
      const cfg = lifecycleConfigFromEnv();
      const rows = await this.loadSubscriptions();
      const events = (await this.db.select({
        event: saasLifecycleEvents.event, aboutTenantId: saasLifecycleEvents.aboutTenantId, createdAt: saasLifecycleEvents.createdAt,
      }).from(saasLifecycleEvents)) as LifecycleEventRow[];
      const actions = planSaasLifecycle(rows, events, now, cfg);
      const byTenant = new Map(rows.map((r) => [r.tenantId, r]));
      const counts: Record<string, number> = {};
      for (const a of actions) {
        // Idempotency gate: the event row IS the lock — only the run that lands the insert acts.
        const inserted = await this.db.insert(saasLifecycleEvents)
          .values({ event: a.event, dedupKey: a.dedupKey, aboutTenantId: a.tenantId, detail: { days_left: a.daysLeft ?? null } })
          .onConflictDoNothing({ target: saasLifecycleEvents.dedupKey })
          .returning({ id: saasLifecycleEvents.id });
        if (!inserted.length) continue;
        const row = byTenant.get(a.tenantId);
        if (row) await this.performSideEffect(a, row, now);
        counts[a.event] = (counts[a.event] ?? 0) + 1;
      }
      const summary = { ran_at: now.toISOString(), subscriptions: rows.length, actions: counts, total_actions: Object.values(counts).reduce((s, n) => s + n, 0) };
      logger.info(summary, 'saas_lifecycle run complete');
      return summary;
    });
  }

  private async loadSubscriptions(): Promise<LifecycleSubRow[]> {
    // The recipient is the company's own contact email (tenants.email — stamped from the signup request);
    // absent ⇒ the action still runs, only the customer email is skipped (the god inbox always fires).
    const raw = await this.db.select({
      tenantId: subscriptions.tenantId, status: subscriptions.status, planCode: subscriptions.planCode,
      trialEndsAt: subscriptions.trialEndsAt, priceMonthly: plans.priceMonthly,
      tenantName: tenants.name, tenantEmail: tenants.email, suspendedAt: tenants.suspendedAt, deletedAt: tenants.deletedAt,
    }).from(subscriptions)
      .innerJoin(tenants, eq(tenants.id, subscriptions.tenantId))
      .innerJoin(plans, eq(plans.code, subscriptions.planCode));
    return raw.map((r) => ({
      tenantId: Number(r.tenantId), tenantName: r.tenantName, status: r.status, planCode: r.planCode,
      priceMonthly: Number(r.priceMonthly ?? 0), trialEndsAt: r.trialEndsAt ?? null,
      suspendedAt: r.suspendedAt ?? null, deleted: !!r.deletedAt, adminEmail: r.tenantEmail ?? null,
    }));
  }

  private async performSideEffect(a: LifecycleAction, row: LifecycleSubRow, now: Date): Promise<void> {
    const billingUrl = `${(process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '')}/billing`;
    const mail = (template: 'trial_reminder' | 'payment_failed' | 'company_suspended', vars: Record<string, string | number | null>) => {
      if (!row.adminEmail) return Promise.resolve(undefined);
      return this.mailer?.send({ template, to: row.adminEmail, aboutTenantId: row.tenantId, vars })
        .catch((e) => logger.warn({ tenant_id: row.tenantId, template, err: (e as Error)?.message }, 'lifecycle email enqueue failed'));
    };
    switch (a.event) {
      case 'trial_reminder_7':
      case 'trial_reminder_1':
        await mail('trial_reminder', { company: row.tenantName, days_left: a.daysLeft ?? 0, trial_ends_at: row.trialEndsAt ? ymdUtc(row.trialEndsAt) : '', billing_url: billingUrl });
        return;
      case 'trial_expired':
        await this.platformNotifs?.emit({ type: 'trial_expired', title: `หมดช่วงทดลองใช้: ${row.tenantName}`, body: `แพ็กเกจ ${row.planCode} — อยู่ในช่วงผ่อนผันก่อนระงับอัตโนมัติ`, tenantId: row.tenantId, refType: 'tenant', refId: String(row.tenantId) });
        return;
      case 'trial_free_activated':
        await this.db.update(subscriptions).set({ status: 'Active' }).where(eq(subscriptions.tenantId, row.tenantId));
        if (row.planCode === 'enterprise') {
          await this.platformNotifs?.emit({ type: 'trial_expired', title: `Enterprise trial หมดอายุ: ${row.tenantName}`, body: 'แพ็กเกจ custom — ฝ่ายขายติดตามการทำสัญญา (ไม่ระงับอัตโนมัติ)', tenantId: row.tenantId, refType: 'tenant', refId: String(row.tenantId) });
        }
        return;
      case 'trial_suspended':
      case 'pastdue_suspended': {
        const reason = a.event === 'trial_suspended' ? 'trial expired (no payment)' : 'payment past due (dunning exhausted)';
        await this.db.update(tenants).set({ suspendedAt: now, suspendedBy: 'saas_lifecycle (auto)', suspendReason: reason }).where(eq(tenants.id, row.tenantId));
        await mail('company_suspended', { company: row.tenantName, reason });
        await this.platformNotifs?.emit({ type: 'tenant_suspended', title: `ระงับอัตโนมัติ: ${row.tenantName}`, body: reason, tenantId: row.tenantId, refType: 'tenant', refId: String(row.tenantId) });
        return;
      }
      case 'dunning_1':
      case 'dunning_2':
      case 'dunning_3':
        await mail('payment_failed', { company: row.tenantName, billing_url: billingUrl });
        if (a.event === 'dunning_1') {
          await this.platformNotifs?.emit({ type: 'payment_dunning', title: `ค้างชำระ: ${row.tenantName}`, body: `เริ่มรอบติดตามการชำระเงิน (ระงับอัตโนมัติเมื่อครบ ${lifecycleConfigFromEnv().pastDueSuspendDays} วัน)`, tenantId: row.tenantId, refType: 'tenant', refId: String(row.tenantId) });
        }
        return;
      case 'dunning_cleared':
        return; // the event row itself closes the ladder — no outward side effect
    }
  }

  /** Recent lifecycle event feed (god console/debugging). */
  async listEvents(limit = 200) {
    const rows = await this.db.select().from(saasLifecycleEvents).orderBy(desc(saasLifecycleEvents.id)).limit(Math.min(Math.max(limit, 1), 500));
    return {
      events: rows.map((r: any) => ({
        id: Number(r.id), event: r.event, dedup_key: r.dedupKey,
        about_tenant_id: Number(r.aboutTenantId), detail: r.detail ?? null, created_at: r.createdAt,
      })),
    };
  }
}
