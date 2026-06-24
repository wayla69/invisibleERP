import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { sql, eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { arInvoices, arDunningLog, tenants } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { ymd, n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// The dunning ladder — escalating, ordered. The worklist recommends the next rung from days-overdue.
export const DUNNING_STAGES = ['reminder', 'first_notice', 'second_notice', 'final_notice', 'legal'] as const;
export type DunningStage = (typeof DUNNING_STAGES)[number];
const STAGE_INDEX = new Map<string, number>(DUNNING_STAGES.map((s, i) => [s, i]));

export interface DunningDto { stage: DunningStage; channel?: string; promise_to_pay_date?: string; notes?: string }

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
    const outstanding = n(inv.amount) - n(inv.paidAmount);
    const daysOverdue = inv.dueDate ? Math.max(0, daysBetween(String(inv.dueDate), ymd())) : 0;
    const dunningNo = await this.docNo.nextDaily('DUN');
    await db.insert(arDunningLog).values({
      dunningNo, tenantId: inv.tenantId ?? null, invoiceNo, stage: dto.stage,
      channel: dto.channel ?? 'email', daysOverdue, outstanding: String(round2(outstanding)),
      promiseToPayDate: dto.promise_to_pay_date ?? null, notes: dto.notes ?? null, actionedBy: user.username,
    });
    return { dunning_no: dunningNo, invoice_no: invoiceNo, stage: dto.stage, days_overdue: daysOverdue, outstanding: round2(outstanding) };
  }

  // Full dunning history for one invoice (newest first).
  async history(invoiceNo: string) {
    const db = this.db as any;
    const rows = await db.select().from(arDunningLog).where(eq(arDunningLog.invoiceNo, invoiceNo)).orderBy(desc(arDunningLog.createdAt), desc(arDunningLog.id));
    return {
      invoice_no: invoiceNo, count: rows.length,
      actions: rows.map((r: any) => ({ dunning_no: r.dunningNo, stage: r.stage, channel: r.channel, days_overdue: r.daysOverdue, outstanding: n(r.outstanding), promise_to_pay_date: r.promiseToPayDate, notes: r.notes, actioned_by: r.actionedBy, created_at: r.createdAt })),
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
    const seriousOverdue = maxOverdueDays > 90; // 90+ past due ⇒ default territory
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
