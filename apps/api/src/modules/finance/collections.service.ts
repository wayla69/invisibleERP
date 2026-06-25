import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { sql, eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { arInvoices, arDunningLog, tenants } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { MessagingService } from '../messaging/messaging.service';
import { ymd, n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// The dunning ladder — escalating, ordered. The worklist recommends the next rung from days-overdue.
export const DUNNING_STAGES = ['reminder', 'first_notice', 'second_notice', 'final_notice', 'legal'] as const;
export type DunningStage = (typeof DUNNING_STAGES)[number];
const STAGE_INDEX = new Map<string, number>(DUNNING_STAGES.map((s, i) => [s, i]));

export interface DunningDto { stage: DunningStage; channel?: string; promise_to_pay_date?: string; notes?: string }

// Channels the dunning notice can actually be DISPATCHED on (others — phone/letter — are recorded as a
// manual contact). Matches the messaging gateway's MessageChannel set.
const DISPATCH_CHANNELS = new Set(['email', 'sms', 'line']);

// Per-stage dunning notice (TH primary, EN secondary). Escalating tone; legal = final demand.
function dunningMessage(stage: DunningStage, ctx: { party: string; invoiceNo: string; outstanding: number; daysOverdue: number; dueDate: string | null }): string {
  const amt = ctx.outstanding.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const head = `เรียน ${ctx.party} | ใบแจ้งหนี้ ${ctx.invoiceNo} ยอดค้างชำระ ${amt} บาท (เกินกำหนด ${ctx.daysOverdue} วัน)`;
  const tail: Record<DunningStage, string> = {
    reminder: 'ขอเรียนเตือนการชำระเงิน หากชำระแล้วขออภัยมา ณ ที่นี้ / Friendly reminder — please disregard if already paid.',
    first_notice: 'กรุณาดำเนินการชำระโดยเร็ว / Please arrange payment at your earliest convenience.',
    second_notice: 'บัญชีของท่านเกินกำหนดชำระ กรุณาชำระทันที / Your account is overdue — immediate payment is requested.',
    final_notice: 'หนังสือทวงถามครั้งสุดท้าย กรุณาชำระภายใน 7 วัน เพื่อหลีกเลี่ยงการระงับเครดิต / FINAL NOTICE — pay within 7 days to avoid a credit hold.',
    legal: 'ยอดค้างชำระเกินกำหนดอย่างมีนัยสำคัญ บัญชีอาจถูกส่งดำเนินคดี / Seriously overdue — this account may be referred for legal collection.',
  };
  return `${head}. ${tail[stage]}`;
}

// Pick the channel + recipient for a dunning notice from the customer's contact details. 'auto' (used by
// the sweep) prefers email, then SMS. Explicit channels resolve their own contact; phone/letter carry the
// phone for the agent but are not auto-dispatched.
function resolveChannel(req: string, cust: { email?: string | null; phone?: string | null } | undefined): { channel: string; recipient: string | null } {
  if (req === 'email') return { channel: 'email', recipient: cust?.email ?? null };
  if (req === 'sms') return { channel: 'sms', recipient: cust?.phone ?? null };
  if (req === 'line') return { channel: 'line', recipient: null }; // no LINE id on the customer master
  if (req === 'phone' || req === 'letter') return { channel: req, recipient: cust?.phone ?? null };
  // 'auto' / unknown → best deliverable channel
  if (cust?.email) return { channel: 'email', recipient: cust.email };
  if (cust?.phone) return { channel: 'sms', recipient: cust.phone };
  return { channel: 'email', recipient: null };
}

// Days-past-due beyond which a customer is in default and put on credit hold. Single-sourced here so the
// collections `on_hold` decision and the order-entry credit gate (pos.service) never drift apart.
export const SERIOUS_OVERDUE_DAYS = 90;
export function isSeriousOverdue(maxOverdueDays: number): boolean { return maxOverdueDays > SERIOUS_OVERDUE_DAYS; }

// Recommended dunning rung for an overdue age (Asia/Bangkok business day). null ⇒ not yet due.
function recommendedStage(daysOverdue: number): DunningStage | null {
  if (daysOverdue <= 0) return null;
  if (daysOverdue <= 15) return 'reminder';
  if (daysOverdue <= 30) return 'first_notice';
  if (daysOverdue <= 60) return 'second_notice';
  if (daysOverdue <= 90) return 'final_notice';
  return 'legal';
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86400000);
}

@Injectable()
export class CollectionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    // Optional so the writeflow/partial harnesses can construct without the messaging graph; the full app
    // always provides it (MessagingModule) so dunning notices are actually dispatched.
    @Optional() private readonly messaging?: MessagingService,
  ) {}

  // ───────────────────── Collections worklist ─────────────────────
  // Open AR invoices with aging, the current dunning stage (latest action) and the next recommended rung.
  async worklist(opts: { onlyOverdue?: boolean } = {}) {
    const db = this.db as any;
    const today = ymd();
    const rows = await db.select({
      invoice_no: arInvoices.invoiceNo, tenant_id: arInvoices.tenantId, party: tenants.code,
      due_date: arInvoices.dueDate, amount: arInvoices.amount, status: arInvoices.status,
      outstanding: sql<string>`${arInvoices.amount} - coalesce(${arInvoices.paidAmount},0)`,
    }).from(arInvoices).leftJoin(tenants, eq(arInvoices.tenantId, tenants.id))
      .where(sql`${arInvoices.status}::text <> 'Paid'`);

    // Latest dunning action per invoice (history reduced in JS — small open-AR set).
    const logs = await db.select().from(arDunningLog).orderBy(desc(arDunningLog.createdAt), desc(arDunningLog.id));
    const latest = new Map<string, any>();
    for (const l of logs) if (!latest.has(l.invoiceNo)) latest.set(l.invoiceNo, l);

    const out = rows
      .map((r: any) => {
        const outstanding = n(r.outstanding);
        const daysOverdue = r.due_date ? Math.max(0, daysBetween(String(r.due_date), today)) : 0;
        const last = latest.get(r.invoice_no);
        const currentStage: DunningStage | null = last?.stage ?? null;
        const recommended = recommendedStage(daysOverdue);
        const curIdx = currentStage ? (STAGE_INDEX.get(currentStage) ?? -1) : -1;
        const recIdx = recommended ? (STAGE_INDEX.get(recommended) ?? -1) : -1;
        return {
          invoice_no: r.invoice_no, tenant_id: r.tenant_id, party: r.party, due_date: r.due_date,
          amount: n(r.amount), outstanding, days_overdue: daysOverdue,
          current_stage: currentStage, last_action_date: last?.createdAt ?? null,
          promise_to_pay_date: last?.promiseToPayDate ?? null,
          recommended_stage: recommended, escalate: recIdx > curIdx,
        };
      })
      .filter((r: any) => (outstandingFilter(r) && (!opts.onlyOverdue || r.days_overdue > 0)))
      .sort((a: any, b: any) => b.days_overdue - a.days_overdue || b.outstanding - a.outstanding);

    const totalOverdue = out.filter((r: any) => r.days_overdue > 0).reduce((a: number, r: any) => a + r.outstanding, 0);
    return { rows: out, count: out.length, total_overdue: round2(totalOverdue), as_of: today };
  }

  // ───────────────────── Record a dunning action ─────────────────────
  async recordDunning(invoiceNo: string, dto: DunningDto, user: JwtUser) {
    const db = this.db as any;
    if (!STAGE_INDEX.has(dto.stage)) {
      throw new BadRequestException({ code: 'INVALID_STAGE', message: `Unknown dunning stage ${dto.stage}`, messageTh: 'ขั้นการทวงถามไม่ถูกต้อง' });
    }
    const [inv] = await db.select().from(arInvoices).where(eq(arInvoices.invoiceNo, invoiceNo)).limit(1);
    if (!inv) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invoice not found', messageTh: 'ไม่พบใบแจ้งหนี้' });
    if (String(inv.status) === 'Paid') {
      throw new BadRequestException({ code: 'ALREADY_PAID', message: `Invoice ${invoiceNo} is already paid`, messageTh: 'ใบแจ้งหนี้นี้ชำระครบแล้ว' });
    }
    const outstanding = round2(n(inv.amount) - n(inv.paidAmount));
    const daysOverdue = inv.dueDate ? Math.max(0, daysBetween(String(inv.dueDate), ymd())) : 0;

    // Resolve the customer contact + channel, then dispatch the dunning notice (best-effort). Dispatchable
    // channels (email/sms/line) go through the messaging gateway and capture a delivery status; phone/letter
    // are recorded as a manual contact for the agent to action offline.
    const [cust] = inv.tenantId != null
      ? await db.select({ code: tenants.code, email: tenants.email, phone: tenants.phone }).from(tenants).where(eq(tenants.id, inv.tenantId)).limit(1)
      : [undefined];
    const { channel, recipient } = resolveChannel(dto.channel ?? 'auto', cust);
    let messageStatus = 'not_sent';
    let messageRecipient: string | null = null;
    if (DISPATCH_CHANNELS.has(channel) && this.messaging) {
      const body = dunningMessage(dto.stage, { party: cust?.code ?? `tenant ${inv.tenantId}`, invoiceNo, outstanding, daysOverdue, dueDate: inv.dueDate ?? null });
      const res: any = await this.messaging.send({ to: recipient ?? undefined, channel: channel as any, body, campaign: `dunning:${dto.stage}` }, user);
      messageStatus = res?.status ?? 'failed';
      messageRecipient = res?.recipient ?? recipient ?? null;
    } else if (channel === 'phone' || channel === 'letter') {
      messageStatus = 'manual';
      messageRecipient = recipient;
    }

    const dunningNo = await this.docNo.nextDaily('DUN');
    await db.insert(arDunningLog).values({
      dunningNo, tenantId: inv.tenantId ?? null, invoiceNo, stage: dto.stage,
      channel, daysOverdue, outstanding: String(outstanding),
      promiseToPayDate: dto.promise_to_pay_date ?? null, notes: dto.notes ?? null,
      messageStatus, messageRecipient, actionedBy: user.username,
    });
    return { dunning_no: dunningNo, invoice_no: invoiceNo, stage: dto.stage, days_overdue: daysOverdue, outstanding, channel, message_status: messageStatus, recipient: messageRecipient };
  }

  // ───────────────────── Automated dunning sweep (cron-callable) ─────────────────────
  // Walks the collections worklist and auto-records the next dunning rung on every overdue invoice whose
  // recommended stage has overtaken its current stage. System-actioned, idempotent across runs: once an
  // invoice is dunned at its recommended stage it stops escalating (escalate=false) until aging advances it.
  async runDunningSweep(user: JwtUser) {
    const wl = await this.worklist({ onlyOverdue: true });
    const actor = { ...user, username: user?.username ? `${user.username} (sweep)` : 'system' } as JwtUser;
    const advanced: { invoice_no: string; stage: DunningStage; dunning_no: string; channel: string; message_status: string }[] = [];
    for (const r of wl.rows) {
      if (!r.escalate || !r.recommended_stage) continue;
      const res = await this.recordDunning(r.invoice_no, { stage: r.recommended_stage, channel: 'auto', notes: 'Auto-advanced by dunning sweep' }, actor);
      advanced.push({ invoice_no: r.invoice_no, stage: r.recommended_stage, dunning_no: res.dunning_no, channel: res.channel, message_status: res.message_status });
    }
    const sent = advanced.filter((a) => a.message_status === 'sent').length;
    return { as_of: wl.as_of, scanned: wl.rows.length, advanced: advanced.length, notices_sent: sent, actions: advanced };
  }

  // Full dunning history for one invoice (newest first).
  async history(invoiceNo: string) {
    const db = this.db as any;
    const rows = await db.select().from(arDunningLog).where(eq(arDunningLog.invoiceNo, invoiceNo)).orderBy(desc(arDunningLog.createdAt), desc(arDunningLog.id));
    return {
      invoice_no: invoiceNo, count: rows.length,
      actions: rows.map((r: any) => ({ dunning_no: r.dunningNo, stage: r.stage, channel: r.channel, days_overdue: r.daysOverdue, outstanding: n(r.outstanding), promise_to_pay_date: r.promiseToPayDate, notes: r.notes, message_status: r.messageStatus, recipient: r.messageRecipient, actioned_by: r.actionedBy, created_at: r.createdAt })),
    };
  }

  // ───────────────────── Credit management ─────────────────────
  // Exposure vs the customer's credit limit + overdue position → a hold decision the order-entry flow
  // (POS / portal / sales order) consults before extending further credit. The hold control addresses
  // SoD risk R09 (raise credit then sell): the limit is master data, the check is enforced at the txn.
  async creditStatus(tenantId: number) {
    const db = this.db as any;
    const [t] = await db.select({ code: tenants.code, creditLimit: tenants.creditLimit, creditTerm: tenants.creditTerm })
      .from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Customer not found', messageTh: 'ไม่พบลูกค้า' });
    const today = ymd();
    const open = await db.select({ due_date: arInvoices.dueDate, outstanding: sql<string>`${arInvoices.amount} - coalesce(${arInvoices.paidAmount},0)` })
      .from(arInvoices).where(and(eq(arInvoices.tenantId, tenantId), sql`${arInvoices.status}::text <> 'Paid'`));
    let exposure = 0, overdue = 0, maxOverdueDays = 0;
    for (const r of open) {
      const o = n(r.outstanding);
      if (o <= 0.0001) continue;
      exposure += o;
      const d = r.due_date ? daysBetween(String(r.due_date), today) : 0;
      if (d > 0) { overdue += o; maxOverdueDays = Math.max(maxOverdueDays, d); }
    }
    const limit = n(t.creditLimit);
    const overLimit = limit > 0 && round2(exposure) > limit;
    const seriousOverdue = isSeriousOverdue(maxOverdueDays); // 90+ past due ⇒ default territory
    const onHold = overLimit || seriousOverdue;
    return {
      tenant_id: tenantId, customer: t.code, credit_term: t.creditTerm ?? null,
      credit_limit: limit, exposure: round2(exposure), overdue: round2(overdue), max_overdue_days: maxOverdueDays,
      available_credit: limit > 0 ? round2(limit - exposure) : null,
      over_limit: overLimit, serious_overdue: seriousOverdue, on_hold: onHold,
    };
  }

  // Decision endpoint for order entry: may this customer take on `amount` more credit right now?
  async creditCheck(tenantId: number, amount: number) {
    const s = await this.creditStatus(tenantId);
    const wouldExceed = s.credit_limit > 0 && round2(s.exposure + amount) > s.credit_limit;
    const approved = !s.on_hold && !wouldExceed;
    const reason = s.on_hold
      ? (s.over_limit ? 'CREDIT_LIMIT_EXCEEDED' : 'SERIOUS_OVERDUE')
      : wouldExceed ? 'WOULD_EXCEED_LIMIT' : null;
    return { ...s, requested_amount: round2(amount), would_exceed_limit: wouldExceed, approved, reason };
  }
}

function round2(x: number) { return Math.round(x * 100) / 100; }
// A worklist row is in scope while it still has an open balance.
function outstandingFilter(r: { outstanding: number }) { return r.outstanding > 0.0001; }
