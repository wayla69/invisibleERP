import { Inject, Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { desc, eq, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { platformEmails } from '../../database/schema';
import { logger } from '../../observability/logger';
import { JobQueueService } from '../jobs/job-queue.service';
import { JobWorkerService } from '../jobs/job-worker.service';
import { renderMail, type MailLang, type MailTemplateKey, type MailVars } from './mailer-templates';

export const PLATFORM_EMAIL_JOB = 'platform_email';

// Outbound transactional email (A1 — real-world Platform Console wave 1). Outbox-first: every send is a
// platform_emails row (Queued) plus a background job; delivery happens on the worker (retry/backoff for
// free) or via the god deliver-pending endpoint. Provider is env-selected the same way StripeBilling is:
// unset MAIL_PROVIDER ⇒ a mock that "delivers" without any network, so every harness/dev deploy works
// offline and the flow stays fully testable; 'resend' / 'postmark' call the real HTTP APIs via fetch
// (fixed hosts, bearer/token from MAIL_API_KEY, sender MAIL_FROM — fail-closed when missing).
@Injectable()
export class MailerService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Optional() private readonly queue?: JobQueueService,
    @Optional() private readonly worker?: JobWorkerService,
  ) {}

  onModuleInit(): void {
    this.worker?.register(PLATFORM_EMAIL_JOB, async (payload: { email_id: number }) => {
      return this.deliver(Number(payload.email_id));
    });
  }

  private get provider(): 'mock' | 'resend' | 'postmark' {
    const p = (process.env.MAIL_PROVIDER ?? '').trim().toLowerCase();
    return p === 'resend' || p === 'postmark' ? p : 'mock';
  }

  /** Queue a transactional email: record it in the outbox and hand delivery to the job worker. */
  async send(opts: { template: MailTemplateKey; to: string; vars: MailVars; lang?: MailLang; aboutTenantId?: number | null }): Promise<{ id: number; queued: boolean }> {
    const lang: MailLang = opts.lang === 'en' ? 'en' : 'th';
    const { subject } = renderMail(opts.template, opts.vars, lang);
    const [row] = await this.db.insert(platformEmails).values({
      template: opts.template, toEmail: opts.to, lang, subject,
      vars: opts.vars, status: 'Queued', aboutTenantId: opts.aboutTenantId ?? null,
    }).returning({ id: platformEmails.id });
    const id = Number(row!.id);
    try {
      await this.queue?.enqueue({ jobType: PLATFORM_EMAIL_JOB, payload: { email_id: id }, tenantId: null, actor: 'mailer', bypass: true });
    } catch (e) {
      // The outbox row is the source of truth — a failed enqueue leaves it Queued for deliverPending.
      logger.warn({ email_id: id, err: (e as Error)?.message }, 'platform_email enqueue failed; row stays Queued');
    }
    return { id, queued: true };
  }

  /** Deliver one outbox row now (job handler + deliver-pending path). Throws on provider failure so the
   *  job queue retries with backoff; the row keeps the last error for the god outbox view. */
  async deliver(id: number): Promise<{ id: number; status: string; provider: string }> {
    const [row] = await this.db.select().from(platformEmails).where(eq(platformEmails.id, id)).limit(1);
    if (!row) return { id, status: 'missing', provider: this.provider };
    if (row.status === 'Sent') return { id, status: 'Sent', provider: row.provider ?? this.provider }; // idempotent re-run
    const rendered = renderMail(row.template as MailTemplateKey, (row.vars ?? {}) as MailVars, (row.lang === 'en' ? 'en' : 'th'));
    try {
      const res = await this.dispatch(row.toEmail, rendered.subject, rendered.html, rendered.text);
      await this.db.update(platformEmails)
        .set({ status: 'Sent', provider: this.provider, providerMsgId: res.msgId ?? null, error: null, sentAt: new Date() })
        .where(eq(platformEmails.id, id));
      return { id, status: 'Sent', provider: this.provider };
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      await this.db.update(platformEmails).set({ status: 'Failed', provider: this.provider, error: msg.slice(0, 500) }).where(eq(platformEmails.id, id));
      logger.warn({ email_id: id, provider: this.provider, err: msg }, 'platform email delivery failed');
      throw e; // job queue retries with backoff
    }
  }

  /** Deliver every Queued/Failed row now (god ops endpoint + harness determinism). Never throws per-row. */
  async deliverPending(limit = 50): Promise<{ attempted: number; sent: number; failed: number }> {
    const rows = await this.db.select({ id: platformEmails.id }).from(platformEmails)
      .where(inArray(platformEmails.status, ['Queued', 'Failed']))
      .orderBy(platformEmails.id).limit(Math.min(Math.max(limit, 1), 200));
    let sent = 0; let failed = 0;
    for (const r of rows) {
      try { await this.deliver(Number(r.id)); sent += 1; } catch { failed += 1; }
    }
    return { attempted: rows.length, sent, failed };
  }

  /** Recent outbox for the Platform Console (god-only). */
  async list(limit = 200) {
    const rows = await this.db.select().from(platformEmails).orderBy(desc(platformEmails.id)).limit(Math.min(Math.max(limit, 1), 500));
    return {
      emails: rows.map((r: any) => ({
        id: Number(r.id), template: r.template, to_email: r.toEmail, lang: r.lang, subject: r.subject,
        status: r.status, provider: r.provider, provider_msg_id: r.providerMsgId, error: r.error,
        about_tenant_id: r.aboutTenantId != null ? Number(r.aboutTenantId) : null,
        created_at: r.createdAt, sent_at: r.sentAt ?? null,
      })),
    };
  }

  // ── Provider dispatch (fixed hosts only — never a caller-supplied URL) ──────────────────────────────
  private async dispatch(to: string, subject: string, html: string, text: string): Promise<{ msgId?: string }> {
    const provider = this.provider;
    if (provider === 'mock') {
      logger.info({ to, subject, provider }, 'platform email delivered (mock provider — no network)');
      return { msgId: `mock-${Date.now()}` };
    }
    const from = (process.env.MAIL_FROM ?? '').trim();
    if (!from) throw new Error('MAIL_FROM_MISSING: set MAIL_FROM to a verified sender for the configured MAIL_PROVIDER');
    const key = (process.env.MAIL_API_KEY ?? '').trim();
    if (!key) throw new Error('MAIL_API_KEY_MISSING: set MAIL_API_KEY for the configured MAIL_PROVIDER');
    const signal = AbortSignal.timeout(Number(process.env.MAIL_TIMEOUT_MS ?? 10_000));
    if (provider === 'resend') {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST', signal,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, html, text }),
      });
      if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = (await res.json().catch(() => ({}))) as { id?: string };
      return { msgId: j.id };
    }
    // postmark
    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST', signal,
      headers: { 'x-postmark-server-token': key, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ From: from, To: to, Subject: subject, HtmlBody: html, TextBody: text, MessageStream: 'outbound' }),
    });
    if (!res.ok) throw new Error(`postmark ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json().catch(() => ({}))) as { MessageID?: string };
    return { msgId: j.MessageID };
  }
}
