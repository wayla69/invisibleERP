import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, sql, lte } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { serviceContracts, slaEvents, serviceSubscriptions, serviceSubscriptionInvoices } from '../../database/schema/service';
import { docCountersTenant } from '../../database/schema/system';
import { n, fx } from '../../database/queries';
import { LedgerService } from '../ledger/ledger.service';
import type { JwtUser } from '../../common/decorators';

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

// Tier → response/resolution hours
const SLA_TIERS: Record<string, { responseHours: number; resolutionHours: number }> = {
  Bronze:   { responseHours: 8,  resolutionHours: 72 },
  Silver:   { responseHours: 4,  resolutionHours: 24 },
  Gold:     { responseHours: 2,  resolutionHours: 8  },
  Platinum: { responseHours: 1,  resolutionHours: 4  },
};

// Billing cycle → months to advance
const CYCLE_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, annual: 12 };

@Injectable()
export class ServiceService {
  // @Optional ledger so the standalone service harness (constructs with 1 arg) still compiles;
  // when present, subscription billing + payment post to the GL.
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Optional() private readonly ledger?: LedgerService,
  ) {}

  // ── Service Contracts ──

  private async nextContractNo(tenantId: number) {
    const db = this.db as any;
    const r = await db.insert(docCountersTenant)
      .values({ docType: 'SVC', tenantId, period: 'all', n: 1 })
      .onConflictDoUpdate({
        target: [docCountersTenant.docType, docCountersTenant.tenantId, docCountersTenant.period],
        set: { n: sql`${docCountersTenant.n} + 1` },
      }).returning({ n: docCountersTenant.n });
    return `SVC-${String(Number(r[0].n)).padStart(5, '0')}`;
  }

  async createContract(dto: { customer_name: string; sla_tier?: string; start_date: string; end_date: string; monthly_value?: number }, user: JwtUser) {
    const db = this.db as any;
    const tenantId = user.tenantId!;
    const tier = dto.sla_tier ?? 'Silver';
    const sla = SLA_TIERS[tier] ?? SLA_TIERS.Silver;
    const contractNo = await this.nextContractNo(tenantId);

    const [c] = await db.insert(serviceContracts).values({
      tenantId, contractNo, customerName: dto.customer_name, slaTier: tier,
      responseHours: sla.responseHours, resolutionHours: sla.resolutionHours,
      startDate: dto.start_date, endDate: dto.end_date,
      status: 'Active', monthlyValue: fx(dto.monthly_value ?? 0, 4), currency: 'THB',
      createdBy: user.username,
    }).returning();
    return this.fmtContract(c);
  }

  async listContracts(user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(serviceContracts).where(eq(serviceContracts.tenantId, user.tenantId!)).orderBy(sql`${serviceContracts.id} DESC`);
    return { contracts: rows.map((c: any) => this.fmtContract(c)), count: rows.length };
  }

  // ── SLA Events ──

  private async nextEventNo(tenantId: number) {
    const db = this.db as any;
    const r = await db.insert(docCountersTenant)
      .values({ docType: 'INC', tenantId, period: 'all', n: 1 })
      .onConflictDoUpdate({
        target: [docCountersTenant.docType, docCountersTenant.tenantId, docCountersTenant.period],
        set: { n: sql`${docCountersTenant.n} + 1` },
      }).returning({ n: docCountersTenant.n });
    return `INC-${String(Number(r[0].n)).padStart(5, '0')}`;
  }

  async logEvent(contractId: number, dto: { title: string; priority?: string; notes?: string; opened_at?: string }, user: JwtUser) {
    const db = this.db as any;
    const contract = await this.assertContract(contractId);
    const sla = SLA_TIERS[contract.slaTier] ?? SLA_TIERS.Silver;
    const eventNo = await this.nextEventNo(user.tenantId!);

    const openedAt = dto.opened_at ? new Date(dto.opened_at) : new Date();
    const responseDueAt = new Date(openedAt.getTime() + sla.responseHours * 3600000);
    const resolutionDueAt = new Date(openedAt.getTime() + sla.resolutionHours * 3600000);

    const [ev] = await db.insert(slaEvents).values({
      contractId, eventNo, title: dto.title, priority: dto.priority ?? 'P3',
      openedAt, responseDueAt, resolutionDueAt, status: 'Open',
      notes: dto.notes ?? null, createdBy: user.username,
    }).returning();
    return this.fmtEvent(ev);
  }

  async resolveEvent(eventId: number, dto: { responded_at?: string; resolved_at?: string; notes?: string }, user: JwtUser) {
    const db = this.db as any;
    const [ev] = await db.select().from(slaEvents).where(eq(slaEvents.id, eventId)).limit(1);
    if (!ev) throw new NotFoundException({ code: 'EVENT_NOT_FOUND', message: `SLA event ${eventId} not found` });

    const resolvedAt = dto.resolved_at ? new Date(dto.resolved_at) : new Date();
    const respondedAt = dto.responded_at ? new Date(dto.responded_at) : resolvedAt;

    const responseBreached = ev.responseDueAt ? respondedAt > new Date(ev.responseDueAt) : false;
    const resolutionBreached = ev.resolutionDueAt ? resolvedAt > new Date(ev.resolutionDueAt) : false;

    const [updated] = await db.update(slaEvents).set({
      respondedAt, resolvedAt, status: 'Resolved',
      responseBreached, resolutionBreached, notes: dto.notes ?? ev.notes,
    }).where(eq(slaEvents.id, eventId)).returning();
    return this.fmtEvent(updated);
  }

  async listEvents(contractId: number) {
    const db = this.db as any;
    const rows = await db.select().from(slaEvents).where(eq(slaEvents.contractId, contractId)).orderBy(sql`${slaEvents.id} DESC`);
    return { events: rows.map((e: any) => this.fmtEvent(e)), count: rows.length };
  }

  // ── Subscriptions ──

  private async nextSubNo(tenantId: number) {
    const db = this.db as any;
    const r = await db.insert(docCountersTenant)
      .values({ docType: 'SUB', tenantId, period: 'all', n: 1 })
      .onConflictDoUpdate({
        target: [docCountersTenant.docType, docCountersTenant.tenantId, docCountersTenant.period],
        set: { n: sql`${docCountersTenant.n} + 1` },
      }).returning({ n: docCountersTenant.n });
    return `SUB-${String(Number(r[0].n)).padStart(5, '0')}`;
  }

  async createSubscription(dto: { customer_name: string; product_code: string; description?: string; billing_cycle?: string; unit_price: number; qty?: number; start_date: string }, user: JwtUser) {
    const db = this.db as any;
    const tenantId = user.tenantId!;
    const subNo = await this.nextSubNo(tenantId);
    const cycle = dto.billing_cycle ?? 'monthly';

    const [sub] = await db.insert(serviceSubscriptions).values({
      tenantId, subNo, customerName: dto.customer_name, productCode: dto.product_code,
      description: dto.description ?? null, billingCycle: cycle,
      unitPrice: fx(dto.unit_price, 4), qty: dto.qty ?? 1, currency: 'THB',
      startDate: dto.start_date, nextBillingDate: dto.start_date,
      status: 'Active', createdBy: user.username,
    }).returning();
    return this.fmtSub(sub);
  }

  async updateSubscriptionStatus(subId: number, status: 'Active' | 'Paused' | 'Cancelled', user: JwtUser) {
    const db = this.db as any;
    await this.assertSub(subId);
    const [updated] = await db.update(serviceSubscriptions).set({ status }).where(eq(serviceSubscriptions.id, subId)).returning();
    return this.fmtSub(updated);
  }

  // ── Billing Run ──
  // Generates invoices for all Active serviceSubscriptions whose next_billing_date <= today

  async runBilling(dto: { as_of_date?: string }, user: JwtUser) {
    const db = this.db as any;
    const tenantId = user.tenantId!;
    const asOf = dto.as_of_date ?? new Date().toISOString().slice(0, 10);

    const dueSubs = await db.select().from(serviceSubscriptions)
      .where(and(
        eq(serviceSubscriptions.tenantId, tenantId),
        eq(serviceSubscriptions.status, 'Active'),
        lte(serviceSubscriptions.nextBillingDate, asOf),
      ));

    const invoiceValues: any[] = [];
    const subUpdates: Array<{ id: number; nextBillingDate: string }> = [];

    for (const sub of dueSubs) {
      const amount = round4(n(sub.unitPrice) * Number(sub.qty));
      const billingPeriod = sub.nextBillingDate.slice(0, 7); // YYYY-MM

      const r = await db.insert(docCountersTenant)
        .values({ docType: 'INV', tenantId, period: 'all', n: 1 })
        .onConflictDoUpdate({
          target: [docCountersTenant.docType, docCountersTenant.tenantId, docCountersTenant.period],
          set: { n: sql`${docCountersTenant.n} + 1` },
        }).returning({ n: docCountersTenant.n });
      const invoiceNo = `INV-${String(Number(r[0].n)).padStart(5, '0')}`;

      // Compute next billing date by advancing months
      const months = CYCLE_MONTHS[sub.billingCycle] ?? 1;
      const curr = new Date(sub.nextBillingDate + 'T00:00:00Z');
      curr.setMonth(curr.getMonth() + months);
      const nextDate = curr.toISOString().slice(0, 10);

      // Due date = 30 days after billing
      const due = new Date(sub.nextBillingDate + 'T00:00:00Z');
      due.setDate(due.getDate() + 30);
      const dueDate = due.toISOString().slice(0, 10);

      invoiceValues.push({ subscriptionId: Number(sub.id), invoiceNo, billingPeriod, amount: fx(amount, 4), currency: sub.currency, status: 'Draft', dueDate });
      subUpdates.push({ id: Number(sub.id), nextBillingDate: nextDate });
    }

    let posted = 0;
    if (invoiceValues.length) {
      await db.insert(serviceSubscriptionInvoices).values(invoiceValues);
      for (const u of subUpdates) {
        await db.update(serviceSubscriptions).set({ nextBillingDate: u.nextBillingDate }).where(eq(serviceSubscriptions.id, u.id));
      }
      // recognize subscription revenue on the GL: Dr 1100 AR / Cr 4300 Subscription Revenue (idempotent per invoice)
      if (this.ledger) {
        for (const iv of invoiceValues) {
          if (await this.ledger.alreadyPosted('SUB-INV', iv.invoiceNo, tenantId)) continue;
          await this.ledger.postEntry({
            source: 'SUB-INV', sourceRef: iv.invoiceNo, tenantId, memo: `Subscription billing ${iv.invoiceNo} (${iv.billingPeriod})`, createdBy: user.username,
            lines: [
              { account_code: '1100', debit: n(iv.amount), memo: 'AR — subscription' },
              { account_code: '4300', credit: n(iv.amount), memo: 'Subscription revenue' },
            ],
          });
          posted++;
        }
      }
    }

    return { invoices_created: invoiceValues.length, serviceSubscriptions_billed: dueSubs.length, gl_entries_posted: posted };
  }

  async payInvoice(invoiceId: number, user: JwtUser) {
    const db = this.db as any;
    const [inv] = await db.select().from(serviceSubscriptionInvoices).where(eq(serviceSubscriptionInvoices.id, invoiceId)).limit(1);
    if (!inv) throw new NotFoundException({ code: 'INVOICE_NOT_FOUND', message: `Invoice ${invoiceId} not found` });
    if (inv.status === 'Paid') throw new BadRequestException({ code: 'ALREADY_PAID', message: 'Invoice already paid' });
    const [updated] = await db.update(serviceSubscriptionInvoices).set({ status: 'Paid' }).where(eq(serviceSubscriptionInvoices.id, invoiceId)).returning();
    // settle on the GL: Dr 1000 Cash / Cr 1100 AR (idempotent per invoice)
    let entryNo: string | null = null;
    if (this.ledger && !(await this.ledger.alreadyPosted('SUB-PAY', updated.invoiceNo, user.tenantId ?? null))) {
      const je: any = await this.ledger.postEntry({
        source: 'SUB-PAY', sourceRef: updated.invoiceNo, tenantId: user.tenantId ?? null, memo: `Subscription payment ${updated.invoiceNo}`, createdBy: user.username,
        lines: [
          { account_code: '1000', debit: n(updated.amount), memo: 'Cash — subscription' },
          { account_code: '1100', credit: n(updated.amount), memo: 'AR cleared' },
        ],
      });
      entryNo = je.entry_no;
    }
    return { id: Number(updated.id), invoice_no: updated.invoiceNo, status: updated.status, amount: n(updated.amount), entry_no: entryNo };
  }

  async listInvoices(subId: number) {
    const db = this.db as any;
    const rows = await db.select().from(serviceSubscriptionInvoices).where(eq(serviceSubscriptionInvoices.subscriptionId, subId)).orderBy(sql`${serviceSubscriptionInvoices.id} DESC`);
    return { invoices: rows.map((i: any) => ({ id: Number(i.id), invoice_no: i.invoiceNo, billing_period: i.billingPeriod, amount: n(i.amount), status: i.status, due_date: i.dueDate })) };
  }

  async listSubscriptions(user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(serviceSubscriptions).where(eq(serviceSubscriptions.tenantId, user.tenantId!)).orderBy(sql`${serviceSubscriptions.id} DESC`);
    return { serviceSubscriptions: rows.map((s: any) => this.fmtSub(s)), count: rows.length };
  }

  // ── Helpers ──

  private async assertContract(id: number) {
    const db = this.db as any;
    const [c] = await db.select().from(serviceContracts).where(eq(serviceContracts.id, id)).limit(1);
    if (!c) throw new NotFoundException({ code: 'CONTRACT_NOT_FOUND', message: `Service contract ${id} not found` });
    return c;
  }

  private async assertSub(id: number) {
    const db = this.db as any;
    const [s] = await db.select().from(serviceSubscriptions).where(eq(serviceSubscriptions.id, id)).limit(1);
    if (!s) throw new NotFoundException({ code: 'SUB_NOT_FOUND', message: `Subscription ${id} not found` });
    return s;
  }

  private fmtContract(c: any) { return { id: Number(c.id), contract_no: c.contractNo, customer_name: c.customerName, sla_tier: c.slaTier, response_hours: c.responseHours, resolution_hours: c.resolutionHours, start_date: c.startDate, end_date: c.endDate, status: c.status, monthly_value: n(c.monthlyValue) }; }
  private fmtEvent(e: any) { return { id: Number(e.id), event_no: e.eventNo, title: e.title, priority: e.priority, opened_at: e.openedAt, response_due_at: e.responseDueAt, responded_at: e.respondedAt, resolved_at: e.resolvedAt, resolution_due_at: e.resolutionDueAt, response_breached: e.responseBreached, resolution_breached: e.resolutionBreached, status: e.status }; }
  private fmtSub(s: any) { return { id: Number(s.id), sub_no: s.subNo, customer_name: s.customerName, product_code: s.productCode, billing_cycle: s.billingCycle, unit_price: n(s.unitPrice), qty: s.qty, next_billing_date: s.nextBillingDate, status: s.status }; }
}
