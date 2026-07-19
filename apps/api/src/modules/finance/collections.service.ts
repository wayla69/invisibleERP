import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { sql, eq, and, desc, inArray } from 'drizzle-orm';
import { assertMakerChecker } from '../../common/control-profile';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { arInvoices, arReceipts, arDunningLog, creditEvents, tenants } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { MessagingService } from '../messaging/messaging.service';
import { FinanceDocsPdfService, type DunningLetterPrintData } from './finance-docs-pdf.service';
import { DocEmailService } from '../mail/doc-email.service';
import { sellerParty } from '../../common/doc-party';
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
    @Optional() private readonly finDocsPdf?: FinanceDocsPdfService, // dunning-letter renderer
    @Optional() private readonly docEmail?: DocEmailService,          // @Global MailModule
  ) {}

  // ── หนังสือทวงถามหนี้ (Dunning / collection letter) — a printable/emailable letter over the latest
  // dunning action on an invoice. Read-only presentation; recording a dunning action stays recordDunning(). ──
  async getDunningLetterForPrint(invoiceNo: string, user: JwtUser): Promise<DunningLetterPrintData> {
    const db = this.db;
    const [inv] = await db.select().from(arInvoices).where(eq(arInvoices.invoiceNo, invoiceNo)).limit(1);
    if (!inv) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invoice not found', messageTh: 'ไม่พบใบแจ้งหนี้' });
    const [last] = await db.select().from(arDunningLog).where(eq(arDunningLog.invoiceNo, invoiceNo)).orderBy(desc(arDunningLog.createdAt), desc(arDunningLog.id)).limit(1);
    const [cust] = inv.tenantId != null ? await db.select().from(tenants).where(eq(tenants.id, Number(inv.tenantId))).limit(1) : [null];
    const [seller] = user.tenantId != null ? await db.select().from(tenants).where(eq(tenants.id, Number(user.tenantId))).limit(1) : [null];
    const outstanding = Number(last?.outstanding ?? (n(inv.amount) - n(inv.paidAmount)));
    const daysOverdue = Number(last?.daysOverdue ?? 0);
    return {
      dunning_no: last?.dunningNo ?? invoiceNo, date: last?.createdAt ? new Date(last.createdAt).toISOString().slice(0, 10) : ymd(),
      stage: last?.stage ?? 'reminder', invoice_no: invoiceNo, invoice_date: inv.invoiceDate ?? null,
      outstanding, days_overdue: daysOverdue, promise_to_pay_date: last?.promiseToPayDate ?? null, currency: inv.currency ?? 'THB',
      customer: cust ? sellerParty(cust) : { name: 'ลูกค้า', address: '-', tax_id: null, branch_label: null, phone: null, email: null },
      seller: sellerParty(seller),
    };
  }
  dunningLetterHtml(d: DunningLetterPrintData): string {
    if (!this.finDocsPdf) throw new NotFoundException({ code: 'RENDERER_UNAVAILABLE', message: 'Dunning renderer not wired' });
    return this.finDocsPdf.dunningLetterHtml(d);
  }
  renderDunningPdf(d: DunningLetterPrintData): Promise<Buffer | null> { return this.finDocsPdf ? this.finDocsPdf.renderToPdf(this.finDocsPdf.dunningLetterHtml(d)) : Promise.resolve(null); }
  async emailDunningLetter(invoiceNo: string, toEmail: string | undefined, user: JwtUser) {
    if (!this.docEmail) throw new NotFoundException({ code: 'EMAIL_UNAVAILABLE', message: 'Email path not wired' });
    const d = await this.getDunningLetterForPrint(invoiceNo, user);
    // Default the recipient to the customer's email on file (master data) when to_email is omitted.
    const res = await this.docEmail.sendDocument({
      to: toEmail?.trim() || d.customer.email || '', from: d.seller.email ?? undefined, filename: d.dunning_no,
      subject: `หนังสือทวงถามหนี้ ${d.invoice_no} จาก ${d.seller.name}`,
      text: `แนบหนังสือทวงถามหนี้สำหรับใบแจ้งหนี้ ${d.invoice_no} ยอดค้าง ${d.outstanding.toLocaleString()} ${d.currency}\n\n${d.seller.name}`,
      html: this.dunningLetterHtml(d),
    });
    return { ...res, invoice_no: d.invoice_no };
  }

  // ───────────────────── Collections worklist ─────────────────────
  // Open AR invoices with aging, the current dunning stage (latest action) and the next recommended rung.
  async worklist(opts: { onlyOverdue?: boolean } = {}) {
    const db = this.db;
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

    // REV-21 — a customer's on-account (unapplied) cash: applied receipts already reduced each invoice's
    // outstanding, but parked cash means the collector should APPLY before dunning — surfaced per row.
    const uaRows = await db.select({ tenantId: arReceipts.tenantId, v: sql<string>`coalesce(sum(${arReceipts.unappliedAmount}),0)` })
      .from(arReceipts).groupBy(arReceipts.tenantId);
    const onAccountBy = new Map<number, number>(uaRows.filter((r: any) => n(r.v) > 0.0001).map((r: any) => [Number(r.tenantId), round2(n(r.v))]));

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
          on_account: r.tenant_id != null ? (onAccountBy.get(Number(r.tenant_id)) ?? 0) : 0, // customer-level unapplied cash (REV-21)
          current_stage: currentStage, last_action_date: last?.createdAt ?? null,
          promise_to_pay_date: last?.promiseToPayDate ?? null,
          recommended_stage: recommended, escalate: recIdx > curIdx,
        };
      })
      .filter((r: any) => (outstandingFilter(r) && (!opts.onlyOverdue || r.days_overdue > 0)))
      .sort((a: any, b: any) => b.days_overdue - a.days_overdue || b.outstanding - a.outstanding);

    const totalOverdue = out.filter((r: any) => r.days_overdue > 0).reduce((a: number, r: any) => a + r.outstanding, 0);
    const onAccountTotal = round2([...onAccountBy.values()].reduce((a, v) => a + v, 0));
    return { rows: out, count: out.length, total_overdue: round2(totalOverdue), on_account_total: onAccountTotal, as_of: today };
  }

  // ───────────────────── Record a dunning action ─────────────────────
  async recordDunning(invoiceNo: string, dto: DunningDto, user: JwtUser) {
    const db = this.db;
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
      const res: any = await this.messaging.send({ to: recipient ?? undefined, channel: channel as 'line' | 'sms' | 'email', body, campaign: `dunning:${dto.stage}` }, user);
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
    const db = this.db;
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
    const db = this.db;
    const [t] = await db.select({ code: tenants.code, creditLimit: tenants.creditLimit, creditTerm: tenants.creditTerm, creditHold: tenants.creditHold })
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
    const manualHold = t.creditHold === true; // credit-manager placed hold (master flag)
    const onHold = manualHold || overLimit || seriousOverdue;
    // latest manual-hold reason, if currently held
    let holdReason: string | null = null;
    if (manualHold) {
      const [h] = await db.select({ reason: creditEvents.reason }).from(creditEvents)
        .where(and(eq(creditEvents.tenantId, tenantId), eq(creditEvents.eventType, 'hold'))).orderBy(desc(creditEvents.id)).limit(1);
      holdReason = h?.reason ?? null;
    }
    return {
      tenant_id: tenantId, customer: t.code, credit_term: t.creditTerm ?? null,
      credit_limit: limit, exposure: round2(exposure), overdue: round2(overdue), max_overdue_days: maxOverdueDays,
      available_credit: limit > 0 ? round2(limit - exposure) : null,
      over_limit: overLimit, serious_overdue: seriousOverdue, manual_hold: manualHold, hold_reason: holdReason, on_hold: onHold,
    };
  }

  // ───────────────────── Credit-manager workflow (hold / release / limit change) ─────────────────────
  // Place a manual credit hold on a customer — blocks new credit orders at order entry (CREDIT_HOLD).
  async placeHold(tenantId: number, reason: string | undefined, user: JwtUser) {
    const db = this.db;
    const [t] = await db.select({ id: tenants.id, code: tenants.code }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Customer not found', messageTh: 'ไม่พบลูกค้า' });
    await db.update(tenants).set({ creditHold: true }).where(eq(tenants.id, tenantId));
    await db.insert(creditEvents).values({ tenantId, eventType: 'hold', reason: reason ?? null, actionedBy: user.username });
    return { tenant_id: tenantId, customer: t.code, credit_hold: true, by: user.username };
  }

  // Release a manual hold. SoD: the releaser must differ from whoever placed the active hold (maker-checker).
  async releaseHold(tenantId: number, reason: string | undefined, user: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const [t] = await db.select({ id: tenants.id, code: tenants.code, creditHold: tenants.creditHold }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Customer not found', messageTh: 'ไม่พบลูกค้า' });
    if (t.creditHold !== true) throw new BadRequestException({ code: 'NOT_ON_HOLD', message: 'Customer is not on credit hold', messageTh: 'ลูกค้าไม่ได้ถูกระงับเครดิต' });
    const [lastHold] = await db.select({ by: creditEvents.actionedBy }).from(creditEvents)
      .where(and(eq(creditEvents.tenantId, tenantId), eq(creditEvents.eventType, 'hold'))).orderBy(desc(creditEvents.id)).limit(1);
    await assertMakerChecker(db, { user, maker: lastHold?.by, event: 'ar.credit-hold.release', ref: String(tenantId), reason: selfApprovalReason, code: 'SOD_SELF_RELEASE', message: 'You cannot release a hold you placed — release requires an independent approver', messageTh: 'ผู้ตั้งระงับเครดิตปลดระงับเองไม่ได้ (ต้องให้ผู้อื่นอนุมัติ)', httpStatus: 400 });
    await db.update(tenants).set({ creditHold: false }).where(eq(tenants.id, tenantId));
    await db.insert(creditEvents).values({ tenantId, eventType: 'release', reason: reason ?? null, actionedBy: user.username });
    return { tenant_id: tenantId, customer: t.code, credit_hold: false, by: user.username };
  }

  // Request a customer credit-limit change (audit G7 / REV-08, SoD R09). A limit change — raise the ceiling,
  // then sell on credit — is fraud-relevant, so it is no longer applied by the requester: it is STAGED as a
  // PendingApproval credit_events row (recording old→new for the credit-change report) and applied only when
  // a DIFFERENT user approves it via approveLimitChange (self-approval → 403 SOD_VIOLATION).
  async changeLimit(tenantId: number, newLimit: number, reason: string | undefined, user: JwtUser) {
    const db = this.db;
    const [t] = await db.select({ id: tenants.id, code: tenants.code, creditLimit: tenants.creditLimit }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Customer not found', messageTh: 'ไม่พบลูกค้า' });
    const oldLimit = n(t.creditLimit);
    const reqNo = await this.docNo.nextDaily('CUS');
    await db.insert(creditEvents).values({ tenantId, eventType: 'limit_change', oldLimit: String(oldLimit), newLimit: String(round2(newLimit)), reason: reason ?? null, actionedBy: user.username, status: 'PendingApproval', reqNo });
    return { tenant_id: tenantId, customer: t.code, old_limit: oldLimit, new_limit: round2(newLimit), req_no: reqNo, status: 'PendingApproval', pending: true, requested_by: user.username };
  }

  // Approve a staged credit-limit change — a DIFFERENT user than the requester applies the new limit
  // (self-approval → 403 SOD_VIOLATION). Only on approval does the customer's ceiling actually move.
  async approveLimitChange(reqNo: string, user: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const [ev] = await db.select().from(creditEvents).where(and(eq(creditEvents.reqNo, reqNo), eq(creditEvents.status, 'PendingApproval'))).limit(1);
    if (!ev) throw new NotFoundException({ code: 'NOT_PENDING', message: `No credit-limit change pending approval for ${reqNo}`, messageTh: 'ไม่มีคำขอเปลี่ยนวงเงินที่รออนุมัติ' });
    await assertMakerChecker(db, { user, maker: ev.actionedBy, event: 'ar.credit-limit.approve', ref: reqNo, amount: n(ev.newLimit), reason: selfApprovalReason, code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve a credit-limit change you requested', messageTh: 'ผู้ขอเปลี่ยนวงเงินอนุมัติเองไม่ได้ (แบ่งแยกหน้าที่)' });
    const newLimit = round2(n(ev.newLimit));
    await db.update(tenants).set({ creditLimit: String(newLimit) }).where(eq(tenants.id, Number(ev.tenantId)));
    await db.update(creditEvents).set({ status: 'Approved', approvedBy: user.username, approvedAt: new Date() }).where(eq(creditEvents.id, Number(ev.id)));
    const [t] = await db.select({ code: tenants.code }).from(tenants).where(eq(tenants.id, Number(ev.tenantId))).limit(1);
    return { req_no: reqNo, tenant_id: Number(ev.tenantId), customer: t?.code ?? null, old_limit: n(ev.oldLimit), new_limit: newLimit, status: 'Approved', approved_by: user.username, requested_by: ev.actionedBy };
  }

  async rejectLimitChange(reqNo: string, user: JwtUser, reason?: string) {
    const db = this.db;
    const [ev] = await db.select().from(creditEvents).where(and(eq(creditEvents.reqNo, reqNo), eq(creditEvents.status, 'PendingApproval'))).limit(1);
    if (!ev) throw new NotFoundException({ code: 'NOT_PENDING', message: `No credit-limit change pending approval for ${reqNo}`, messageTh: 'ไม่มีคำขอเปลี่ยนวงเงินที่รออนุมัติ' });
    await db.update(creditEvents).set({ status: 'Rejected', approvedBy: user.username, approvedAt: new Date(), reason: reason ?? ev.reason }).where(eq(creditEvents.id, Number(ev.id)));
    return { req_no: reqNo, status: 'Rejected', rejected_by: user.username };
  }

  async listPendingLimitChanges() {
    const db = this.db;
    const rows = await db.select({ reqNo: creditEvents.reqNo, tenantId: creditEvents.tenantId, code: tenants.code, oldLimit: creditEvents.oldLimit, newLimit: creditEvents.newLimit, reason: creditEvents.reason, requestedBy: creditEvents.actionedBy, requestedAt: creditEvents.createdAt })
      .from(creditEvents).leftJoin(tenants, eq(creditEvents.tenantId, tenants.id))
      .where(and(eq(creditEvents.eventType, 'limit_change'), eq(creditEvents.status, 'PendingApproval'))).orderBy(desc(creditEvents.id)).limit(200);
    return { requests: rows.map((r: any) => ({ req_no: r.reqNo, tenant_id: Number(r.tenantId), customer: r.code, old_limit: n(r.oldLimit), new_limit: n(r.newLimit), reason: r.reason, requested_by: r.requestedBy, requested_at: r.requestedAt })), count: rows.length };
  }

  // Credit-change audit for a customer (holds, releases, limit changes) — newest first.
  async creditEventsFor(tenantId: number) {
    const db = this.db;
    const rows = await db.select().from(creditEvents).where(eq(creditEvents.tenantId, tenantId)).orderBy(desc(creditEvents.id));
    return { tenant_id: tenantId, count: rows.length, events: rows.map((e: any) => ({ event_type: e.eventType, old_limit: e.oldLimit != null ? n(e.oldLimit) : null, new_limit: e.newLimit != null ? n(e.newLimit) : null, reason: e.reason, actioned_by: e.actionedBy, created_at: e.createdAt })) };
  }

  // All-customer credit-position summary — aggregate exposure/overdue/hold state across every customer
  // with open AR. Used by the credit-hold management dashboard to show the full book at a glance.
  async creditPositions() {
    const db = this.db;
    const today = ymd();
    const openAr = await db.select({
      tenant_id: arInvoices.tenantId,
      due_date: arInvoices.dueDate,
      outstanding: sql<string>`${arInvoices.amount} - coalesce(${arInvoices.paidAmount},0)`,
    }).from(arInvoices).where(sql`${arInvoices.status}::text <> 'Paid'`);

    const byTenant = new Map<number, { exposure: number; overdue: number; maxOverdueDays: number }>();
    for (const r of openAr) {
      if (r.tenant_id == null) continue;
      const o = n(r.outstanding);
      if (o <= 0.0001) continue;
      const d = r.due_date ? Math.max(0, daysBetween(String(r.due_date), today)) : 0;
      const cur = byTenant.get(r.tenant_id) ?? { exposure: 0, overdue: 0, maxOverdueDays: 0 };
      cur.exposure += o;
      if (d > 0) { cur.overdue += o; cur.maxOverdueDays = Math.max(cur.maxOverdueDays, d); }
      byTenant.set(r.tenant_id, cur);
    }

    if (byTenant.size === 0) return { positions: [], count: 0, on_hold_count: 0, as_of: today };

    const tenantIds = Array.from(byTenant.keys());
    const tenantRows: any[] = await db.select({
      id: tenants.id, code: tenants.code, creditLimit: tenants.creditLimit,
      creditTerm: tenants.creditTerm, creditHold: tenants.creditHold,
    }).from(tenants).where(inArray(tenants.id, tenantIds));

    const positions = tenantRows.map((t) => {
      const ar = byTenant.get(t.id) ?? { exposure: 0, overdue: 0, maxOverdueDays: 0 };
      const limit = n(t.creditLimit);
      const overLimit = limit > 0 && round2(ar.exposure) > limit;
      const seriousOverdue = isSeriousOverdue(ar.maxOverdueDays);
      const manualHold = t.creditHold === true;
      const onHold = manualHold || overLimit || seriousOverdue;
      return {
        tenant_id: t.id, customer: t.code, credit_term: t.creditTerm ?? null,
        credit_limit: limit, exposure: round2(ar.exposure), overdue: round2(ar.overdue),
        max_overdue_days: ar.maxOverdueDays,
        available_credit: limit > 0 ? round2(limit - ar.exposure) : null,
        over_limit: overLimit, serious_overdue: seriousOverdue, manual_hold: manualHold, on_hold: onHold,
      };
    }).sort((a, b) => (b.on_hold ? 1 : 0) - (a.on_hold ? 1 : 0) || b.max_overdue_days - a.max_overdue_days || b.exposure - a.exposure);

    return { positions, count: positions.length, on_hold_count: positions.filter((p) => p.on_hold).length, as_of: today };
  }

  // Decision endpoint for order entry: may this customer take on `amount` more credit right now?
  async creditCheck(tenantId: number, amount: number) {
    const s = await this.creditStatus(tenantId);
    const wouldExceed = s.credit_limit > 0 && round2(s.exposure + amount) > s.credit_limit;
    const approved = !s.on_hold && !wouldExceed;
    const reason = s.on_hold
      ? (s.manual_hold ? 'CREDIT_HOLD' : s.over_limit ? 'CREDIT_LIMIT_EXCEEDED' : 'SERIOUS_OVERDUE')
      : wouldExceed ? 'WOULD_EXCEED_LIMIT' : null;
    return { ...s, requested_amount: round2(amount), would_exceed_limit: wouldExceed, approved, reason };
  }
}

function round2(x: number) { return Math.round(x * 100) / 100; }
// A worklist row is in scope while it still has an open balance.
function outstandingFilter(r: { outstanding: number }) { return r.outstanding > 0.0001; }
