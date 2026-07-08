import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { reportSubscriptions, reportRuns } from '../../database/schema/bi';
import { notifications } from '../../database/schema/system';
import { n } from '../../database/queries';
import { MessagingService } from '../messaging/messaging.service';
import { LineNotifyService } from '../messaging/line-notify.service';
import { JobQueueService } from '../jobs/job-queue.service';
import { SchedulerHeartbeatService } from '../jobs/scheduler-heartbeat.service';
import { DIGEST_KPIS, DEFAULT_DIGEST_KPIS, allowedDigestKpis } from './digest-kpis';
import { REPORT_TYPES, FREQUENCIES } from './report-registry';
import { REPORT_SUBSCRIPTION_JOB } from './bi.service';
import { BiGenerateService, type BiReadPort } from './bi-generate.service';
import { runInTenantContext } from '../../common/tenant-run';
import { captureOpsAlert } from '../../observability/instrumentation';
import type { JwtUser } from '../../common/decorators';

// Subscription scheduler (docs/38 §3 bi pilot, extraction PR-3). The create/list/delete + due-sweep +
// execute/deliver lifecycle moved VERBATIM out of bi.service.ts. The facade keeps every public method as a
// thin delegator passing `this` as the BiReadPort (generation needs the cached read core, which stays on
// BiService), and keeps the worker onModuleInit registration (one-directional ports — no forwardRef).
@Injectable()
export class BiScheduleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly messaging: MessagingService,
    @Optional() private readonly lineNotify?: LineNotifyService,
    @Optional() private readonly jobs?: JobQueueService,
    @Optional() private readonly schedHeartbeat?: SchedulerHeartbeatService,
    @Optional() private readonly generate?: BiGenerateService,
  ) {}

  private generateOrThrow(): BiGenerateService {
    if (!this.generate) throw new BadRequestException({ code: 'GENERATE_UNAVAILABLE', message: 'Report generation service not available', messageTh: 'ระบบสร้างรายงานไม่พร้อมใช้งาน' });
    return this.generate;
  }

  // Async scheduler: enqueue each DUE subscription as a background job (returns immediately) instead of
  // running them inline. Heavy action jobs (dunning, recurring GL, lease/rev-rec runs) then execute on the
  // worker with retry/backoff, off the cron request path. Falls back to inline runDue if the queue is absent.
  async runDueAsync(user: JwtUser, reads: BiReadPort) {
    if (!this.jobs) return { ...(await this.runDue(user, reads)), mode: 'inline (queue unavailable)' };
    const db = this.db;
    const now = Date.now();
    const subs = await db.select().from(reportSubscriptions)
      .where(and(eq(reportSubscriptions.tenantId, user.tenantId!), eq(reportSubscriptions.isActive, true)));
    const due = subs.filter((s: any) => !s.lastRunAt || (s.nextRunAt && new Date(s.nextRunAt).getTime() <= now));
    const enqueued: number[] = [];
    for (const sub of due) {
      const jobId = await this.jobs.enqueue({ jobType: REPORT_SUBSCRIPTION_JOB, payload: { subscriptionId: Number(sub.id) }, tenantId: user.tenantId ?? null, actor: user.username, bypass: user.role === 'Admin' });
      enqueued.push(jobId);
    }
    await this.schedHeartbeat?.beat('bi_scheduler', 'runDueAsync', { due: due.length });
    return { due: due.length, enqueued: enqueued.length, job_ids: enqueued, mode: 'queued' };
  }

  // 2.7 — the CROSS-TENANT due sweep. runDue/runDueAsync are scoped to the CALLER's tenant, so on a
  // multi-company deploy the nightly cron (authenticated as one service account) only ever swept its own
  // tenant — every other tenant's subscriptions silently never fired. This sweep runs under a bypass
  // context, selects every active due subscription platform-wide, and enqueues each one under ITS OWN
  // tenant (the worker executes it RLS-scoped there, exactly like a request from that tenant). Counts
  // only in the response — no cross-tenant row data leaves this method. Inline fallback without the queue.
  async runDueAllAsync(reads: BiReadPort, actor = 'system:scheduler') {
    return runInTenantContext(this.db, { tenantId: null, bypass: true, actor }, async () => {
      const db = this.db;
      const now = Date.now();
      const subs = await db.select().from(reportSubscriptions).where(eq(reportSubscriptions.isActive, true));
      const due = subs.filter((s: any) => !s.lastRunAt || (s.nextRunAt && new Date(s.nextRunAt).getTime() <= now));
      let enqueued = 0, ranInline = 0;
      for (const sub of due) {
        if (this.jobs) {
          await this.jobs.enqueue({ jobType: REPORT_SUBSCRIPTION_JOB, payload: { subscriptionId: Number(sub.id) }, tenantId: sub.tenantId ?? null, actor, bypass: false });
          enqueued++;
        } else {
          const user = { username: actor, role: 'Sales', tenantId: sub.tenantId, permissions: [], customerName: null } as unknown as JwtUser;
          await this.executeSubscription(sub, user, reads);
          ranInline++;
        }
      }
      await this.schedHeartbeat?.beat('bi_scheduler', 'runDueAllAsync', { due: due.length });
      return { due: due.length, enqueued, ran_inline: ranInline, mode: this.jobs ? 'queued' : 'inline (queue unavailable)' };
    });
  }

  async createSubscription(dto: { name: string; report_type: string; frequency: string; filters?: object; recipients?: object[] }, user: JwtUser) {
    const db = this.db;
    if (!REPORT_TYPES[dto.report_type]) throw new BadRequestException({ code: 'BAD_REPORT_TYPE', message: `Unknown report type '${dto.report_type}'`, messageTh: 'ไม่รู้จักประเภทรายงานนี้' });
    if (!(FREQUENCIES as readonly string[]).includes(dto.frequency)) throw new BadRequestException({ code: 'BAD_FREQUENCY', message: 'frequency must be daily|weekly|monthly', messageTh: 'ความถี่ต้องเป็น รายวัน/รายสัปดาห์/รายเดือน' });
    const nextRun = this.nextRunDate(dto.frequency);
    const [sub] = await db.insert(reportSubscriptions).values({
      tenantId: user.tenantId!, name: dto.name, reportType: dto.report_type,
      frequency: dto.frequency, filters: dto.filters ?? {}, recipients: dto.recipients ?? [],
      isActive: true, nextRunAt: nextRun, createdBy: user.username,
    }).returning();
    return this.fmtSub(sub);
  }

  async listSubscriptions(user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(reportSubscriptions)
      .where(and(eq(reportSubscriptions.tenantId, user.tenantId!), eq(reportSubscriptions.isActive, true)))
      .orderBy(desc(reportSubscriptions.createdAt));
    return { subscriptions: rows.map((s: any) => this.fmtSub(s)), count: rows.length };
  }

  async deleteSubscription(id: number, user: JwtUser) {
    const db = this.db;
    await db.update(reportSubscriptions).set({ isActive: false })
      .where(and(eq(reportSubscriptions.id, id), eq(reportSubscriptions.tenantId, user.tenantId!)));
    return { deleted: id };
  }

  // Execute one subscription: generate → deliver (email recipients + in-app notification) → log a run →
  // advance the schedule. Delivery is best-effort; the run is always recorded.
  async executeSubscription(sub: any, user: JwtUser, reads: BiReadPort) {
    const db = this.db;
    try {
      const report = await this.generateOrThrow().generateReport(sub.reportType, sub.filters, user, reads);
      const recipients = Array.isArray(sub.recipients) ? sub.recipients : [];
      let delivered = 0;
      for (const r of recipients) {
        // LC-4: {line_user:'<username>'} delivers a compact summary to that staff user's LINKED LINE
        // (resolution follows the link registry; unlinked users silently receive nothing).
        if (r?.line_user && this.lineNotify) {
          try {
            const tenantIdN = sub.tenantId != null ? Number(sub.tenantId) : null;
            if (sub.reportType === 'line_daily_digest') {
              // LP-3: per-recipient KPI selection ∩ effective permissions AT SEND TIME — a perm revoked
              // after subscribing silently drops that KPI from this person's message. Flex card + altText.
              const perms = await this.lineNotify.effectivePermsOf(String(r.line_user));
              const chosen: string[] = Array.isArray(r?.kpis) && r.kpis.length ? r.kpis.map(String) : DEFAULT_DIGEST_KPIS;
              const visible = chosen.filter((k) => allowedDigestKpis(perms).includes(k));
              const fmt = (k: string) => {
                const v = (report.data as Record<string, unknown> | undefined)?.[k];
                if (v == null) return '—'; // zero-data honesty: missing ≠ 0
                return DIGEST_KPIS[k]?.money ? Number(v).toLocaleString('th-TH', { maximumFractionDigits: 2 }) : String(v);
              };
              const rows = visible.map((k) => ({ th: DIGEST_KPIS[k]!.th, val: fmt(k) }));
              const text = `📊 ${sub.name}: ` + (rows.length ? rows.map((x) => `${x.th} ${x.val}`).join(' · ') : 'ไม่มีรายการที่คุณมีสิทธิ์เห็น') + '\nดูรายงานเต็มที่หน้า /bi';
              const flex = {
                type: 'bubble',
                body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
                  { type: 'text', text: `📊 ${sub.name}`, weight: 'bold', size: 'md' },
                  ...rows.map((x) => ({ type: 'box', layout: 'horizontal', contents: [
                    { type: 'text', text: x.th, size: 'sm', color: '#666666', flex: 5 },
                    { type: 'text', text: x.val, size: 'sm', weight: 'bold', align: 'end', flex: 4 },
                  ] })),
                  { type: 'text', text: 'ดูรายงานเต็มที่หน้า /bi', size: 'xs', color: '#888888' },
                ] },
              };
              await this.lineNotify.notifyUser(String(r.line_user), tenantIdN, text, flex);
            } else if (sub.reportType === 'low_stock_reorder_alert') {
              // D1 — list the low-stock items + a one-tap [สั่งเติมทั้งหมด] postback ({a:'reorder'}). Only
              // pushed when something is actually low, so quiet mornings stay silent (no noise).
              const d = (report.data ?? {}) as { count?: number; items?: Array<{ item_id: string; on_hand: number; min_stock: number; uom: string | null; suggested_qty: number }> };
              const low = d.items ?? [];
              if (!low.length) { continue; }
              const total = d.count ?? low.length;
              const rows = low.slice(0, 10).map((x) => `• ${x.item_id} — เหลือ ${x.on_hand}${x.uom ? ` ${x.uom}` : ''} (จุดสั่งซื้อ ${x.min_stock}) → แนะนำ ${x.suggested_qty}`);
              const more = low.length > 10 ? `\n…และอีก ${low.length - 10} รายการ` : '';
              const text = `🛒 สินค้าใกล้หมด ${total} รายการ\n${rows.join('\n')}${more}\nพิมพ์ reorder หรือกดปุ่มเพื่อเปิด PR เติมทั้งหมด`;
              const flex = {
                type: 'bubble',
                body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
                  { type: 'text', text: `🛒 สินค้าใกล้หมด (${total})`, weight: 'bold', size: 'md', wrap: true },
                  ...low.slice(0, 10).map((x) => ({ type: 'box', layout: 'horizontal', contents: [
                    { type: 'text', text: x.item_id, size: 'sm', color: '#666666', flex: 6, wrap: true },
                    { type: 'text', text: `เหลือ ${x.on_hand}`, size: 'sm', weight: 'bold', align: 'end', flex: 4 },
                  ] })),
                  ...(low.length > 10 ? [{ type: 'text', text: `…และอีก ${low.length - 10} รายการ`, size: 'xs', color: '#888888' }] : []),
                ] },
                footer: { type: 'box', layout: 'vertical', contents: [
                  { type: 'button', style: 'primary', height: 'sm', action: { type: 'postback', label: '🛒 สั่งเติมทั้งหมด', data: JSON.stringify({ a: 'reorder' }), displayText: 'reorder' } },
                ] },
              };
              await this.lineNotify.notifyUser(String(r.line_user), tenantIdN, text, flex);
            } else {
              await this.lineNotify.notifyUser(String(r.line_user), tenantIdN, `📊 ${sub.name}: ${report.summaryTh ?? report.summary}\nดูรายงานเต็มที่หน้า /bi`);
            }
            delivered++;
          } catch { /* best-effort */ }
          continue;
        }
        const to = r?.email;
        if (!to) continue;
        try { const res: any = await this.messaging.send({ to, channel: 'email', body: `${sub.name}: ${report.summary}`, campaign: 'report' }, user); if (res?.status === 'sent') delivered++; } catch { /* best-effort */ }
      }
      // in-app notification to the tenant
      await db.insert(notifications).values({ targetTenantId: sub.tenantId, targetRole: null, message: `รายงาน ${sub.name}: ${report.summaryTh}`, messageEn: `Report ${sub.name}: ${report.summary}` });
      const [run] = await db.insert(reportRuns).values({
        tenantId: sub.tenantId, subscriptionId: Number(sub.id), name: sub.name, reportType: sub.reportType,
        frequency: sub.frequency, status: 'success', recipientsCount: delivered, summary: report.data,
      }).returning({ id: reportRuns.id });
      await db.update(reportSubscriptions).set({ lastRunAt: new Date(), nextRunAt: this.nextRunDate(sub.frequency) }).where(eq(reportSubscriptions.id, sub.id));
      return { run_id: Number(run!.id), subscription_id: Number(sub.id), name: sub.name, report_type: sub.reportType, status: 'success', delivered, summary: report.summary };
    } catch (e: any) {
      const errMsg = String(e?.message ?? e);
      // ITGC-OP-04 — a scheduled (often FINANCIAL) job that fails must never be SILENT. executeSubscription
      // swallows the error (returns status:'failed' instead of throwing) so the failure would otherwise be
      // invisible at the alerting layer — and when run async via the worker, the swallowed error would mark
      // the background job 'done'. So we (a) emit an ops alert (structured log + Sentry — routes to on-call,
      // reusing the #264 sink) and (b) raise an operator-facing in-app notification, in addition to recording
      // the failed run for review (GET /api/bi/runs). Both are best-effort and never mask the original failure.
      captureOpsAlert('scheduled_job_failed', { subscriptionId: Number(sub.id), reportType: sub.reportType, tenantId: sub.tenantId, name: sub.name }, e);
      try {
        await db.insert(notifications).values({
          targetTenantId: sub.tenantId, targetRole: 'Admin',
          message: `งานตั้งเวลาล้มเหลว: ${sub.name} (${sub.reportType}) — ${errMsg}`,
          messageEn: `Scheduled job failed: ${sub.name} (${sub.reportType}) — ${errMsg}`,
        });
      } catch { /* operator alert is best-effort — never mask the original failure */ }
      const [run] = await db.insert(reportRuns).values({
        tenantId: sub.tenantId, subscriptionId: Number(sub.id), name: sub.name, reportType: sub.reportType,
        frequency: sub.frequency, status: 'failed', recipientsCount: 0, summary: {}, error: errMsg,
      }).returning({ id: reportRuns.id });
      await db.update(reportSubscriptions).set({ lastRunAt: new Date(), nextRunAt: this.nextRunDate(sub.frequency) }).where(eq(reportSubscriptions.id, sub.id));
      return { run_id: Number(run!.id), subscription_id: Number(sub.id), name: sub.name, report_type: sub.reportType, status: 'failed', delivered: 0, error: errMsg };
    }
  }

  // Cron-callable sweep: run every active subscription that is due (never run yet, or next_run_at has passed).
  async runDue(user: JwtUser, reads: BiReadPort) {
    const db = this.db;
    const now = Date.now();
    const subs = await db.select().from(reportSubscriptions)
      .where(and(eq(reportSubscriptions.tenantId, user.tenantId!), eq(reportSubscriptions.isActive, true)));
    const due = subs.filter((s: any) => !s.lastRunAt || (s.nextRunAt && new Date(s.nextRunAt).getTime() <= now));
    const runs: any[] = [];
    for (const sub of due) runs.push(await this.executeSubscription(sub, user, reads));
    await this.schedHeartbeat?.beat('bi_scheduler', 'runDue', { due: due.length });
    return { due: due.length, ran_count: runs.length, delivered: runs.reduce((a, r) => a + (r.delivered ?? 0), 0), runs };
  }

  // Run one subscription on demand (ignores the schedule) — the "Run now" button.
  async runSubscriptionNow(id: number, user: JwtUser, reads: BiReadPort) {
    const db = this.db;
    const [sub] = await db.select().from(reportSubscriptions)
      .where(and(eq(reportSubscriptions.id, id), eq(reportSubscriptions.tenantId, user.tenantId!)));
    if (!sub) throw new NotFoundException({ code: 'SUB_NOT_FOUND', message: 'Subscription not found', messageTh: 'ไม่พบการสมัครรับรายงาน' });
    return this.executeSubscription(sub, user, reads);
  }

  async listRuns(user: JwtUser, limit = 100) {
    const db = this.db;
    const rows = await db.select().from(reportRuns)
      .where(eq(reportRuns.tenantId, user.tenantId!))
      .orderBy(desc(reportRuns.ranAt)).limit(limit);
    return { runs: rows.map((r: any) => ({ id: Number(r.id), subscription_id: r.subscriptionId != null ? Number(r.subscriptionId) : null, name: r.name, report_type: r.reportType, frequency: r.frequency, status: r.status, recipients_count: Number(r.recipientsCount ?? 0), error: r.error, ran_at: r.ranAt })) };
  }

  private nextRunDate(frequency: string): Date {
    const d = new Date();
    if (frequency === 'daily')   d.setDate(d.getDate() + 1);
    if (frequency === 'weekly')  d.setDate(d.getDate() + 7);
    if (frequency === 'monthly') d.setMonth(d.getMonth() + 1);
    return d;
  }

  private fmtSub(s: any) {
    return {
      id: Number(s.id), name: s.name, report_type: s.reportType,
      frequency: s.frequency, filters: s.filters, recipients: s.recipients,
      is_active: s.isActive, next_run_at: s.nextRunAt, created_by: s.createdBy,
    };
  }
}
