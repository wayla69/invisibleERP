import { NotFoundException, BadRequestException } from '@nestjs/common';
import { sql, eq, and, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { arInvoices, arReceipts, orders, orderLines, tenants } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import { LedgerService } from '../ledger/ledger.service';
import { postingDefault } from '../ledger/posting-events';
import { AccountDeterminationService } from '../ledger/account-determination.service';
import { ymd, n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import type { ReceiptDto } from './finance.service';
import type { VatSplitFn, VatLegFromCodeFn } from './finance-ap.service';

const round2 = (x: number) => Math.round(x * 100) / 100;
function addDays(dateStr: string | null, days: number): string {
  const d = dateStr ? new Date(dateStr) : new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export type ResolveOrderProfileFn = (tenantId: number, itemIds: string[]) => Promise<{ vatCode: string | null; revenueAccount: string | null }>;

// docs/46 Phase 4a cut 4 — the AR WRITE side of finance (order→invoice sync with output-VAT/revenue
// determination, cash receipts with idempotency + FOR UPDATE concurrency, and the REV-14 bad-debt
// write-off maker-checker), moved VERBATIM out of finance.service.ts. A plain class constructed in the
// FinanceService constructor BODY (writeflow builds the facade positionally with 3 args); the facade keeps
// thin delegators, so the public API is byte-identical. The shared VAT/item-profile helpers stay on the
// facade and arrive as callback ports (docs/38 pattern). The write-off REGISTER (listWriteOffs) stays on
// the facade — it reads the journal tables, which the ledger import-boundary ratchet grandfathers there.
export class FinanceArService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly statusLog: StatusLogService,
    private readonly vatSplit: VatSplitFn,
    private readonly vatLegFromCode: VatLegFromCodeFn,
    private readonly resolveOrderProfile: ResolveOrderProfileFn,
    private readonly ledger?: LedgerService,
    private readonly determination?: AccountDeterminationService,
  ) {}

  // POST /api/finance/ar/sync — สร้าง INV-{order_no} จาก order ที่ Shipped/Completed ที่ยังไม่มี invoice
  async syncArInvoices(user: JwtUser) {
    const db = this.db;
    const candidates = await db.select({ id: orders.id, orderNo: orders.orderNo, orderDate: orders.orderDate, tenantId: orders.tenantId })
      .from(orders).where(sql`${orders.status}::text in ('Shipped','Completed')`);
    const existing = new Set((await db.select({ no: arInvoices.orderNo }).from(arInvoices)).map((r: any) => r.no));
    const todo = candidates.filter((o: any) => !existing.has(o.orderNo));
    if (!todo.length) return { created: 0 };
    // Batch the per-order line-sum + tenant credit-term lookups (was 2 queries per order → N+1).
    const orderIds = todo.map((o: any) => Number(o.id));
    const sumRows = await db.select({ orderId: orderLines.orderId, a: sql<string>`coalesce(sum(${orderLines.totalPrice}),0)` })
      .from(orderLines).where(inArray(orderLines.orderId, orderIds)).groupBy(orderLines.orderId);
    const sumMap = new Map<number, string>(sumRows.map((r: any) => [Number(r.orderId), r.a]));
    const tenantIds = [...new Set(todo.map((o: any) => o.tenantId).filter((v: any) => v != null))] as number[];
    const termRows = tenantIds.length ? await db.select({ id: tenants.id, ct: tenants.creditTerm }).from(tenants).where(inArray(tenants.id, tenantIds)) : [];
    const termMap = new Map<number, string>(termRows.map((t: any) => [Number(t.id), t.ct]));
    // docs/33 PR6 — output-VAT determination: only tenants that opted into posting_determination get the
    // per-item VAT account (else parity — flat 7/107 → 2100). Prefetch each order's item ids for the lookup.
    const enabledTenants = new Set<number>();
    if (this.determination) for (const t of tenantIds) if (await this.determination.enabled(t)) enabledTenants.add(t);
    const itemsByOrder = new Map<number, string[]>();
    if (enabledTenants.size) {
      const lineRows = await db.select({ orderId: orderLines.orderId, itemId: orderLines.itemId })
        .from(orderLines).where(inArray(orderLines.orderId, orderIds));
      for (const r of lineRows) if (r.itemId) { const a = itemsByOrder.get(Number(r.orderId)) ?? []; a.push(r.itemId); itemsByOrder.set(Number(r.orderId), a); }
    }
    let created = 0;
    for (const o of todo) {
      const amtA = sumMap.get(Number(o.id)) ?? '0';
      let termDays = 30;
      if (o.tenantId != null) termDays = parseInt(String(termMap.get(Number(o.tenantId)) ?? '').replace(/\D/g, ''), 10) || 30;
      const invoiceNo = this.docNo.invoiceFromOrder(o.orderNo);
      await db.insert(arInvoices).values({
        invoiceNo, invoiceDate: o.orderDate, dueDate: addDays(o.orderDate, termDays),
        tenantId: o.tenantId, orderNo: o.orderNo, amount: amtA, paidAmount: '0', status: 'Unpaid', createdBy: 'system',
      }).onConflictDoNothing();
      // GL: recognize receivable + revenue + output VAT (Dr 1100 / Cr <revenue> net / Cr <output-vat> vat).
      // The VAT account/rate AND the revenue account come from the order's uniform item profile when the
      // tenant opted in (docs/33 PR6/PR7); else the flat 7/107 → 2100 and revenue 4000 default. The receivable
      // (grossAmt) is fixed, so VAT is always backed out.
      const grossAmt = n(amtA);
      if (this.ledger && grossAmt > 0 && !(await this.ledger.alreadyPosted('AR', invoiceNo))) {
        let net: number, vat: number, vatAccount = '2100';
        const prof = o.tenantId != null && enabledTenants.has(Number(o.tenantId))
          ? await this.resolveOrderProfile(Number(o.tenantId), itemsByOrder.get(Number(o.id)) ?? []) : { vatCode: null, revenueAccount: null };
        const leg = await this.vatLegFromCode(o.tenantId ?? null, prof.vatCode, grossAmt, 'output', { forceInclusive: true });
        if (leg) { net = leg.net; vat = leg.vat; vatAccount = leg.account; }
        else ({ net, vat } = this.vatSplit(grossAmt));
        const revenueAccount = prof.revenueAccount ?? '4000';
        await this.ledger.postEntry({
          date: o.orderDate ?? undefined, source: 'AR', sourceRef: invoiceNo, tenantId: o.tenantId ?? null,
          memo: `AR invoice ${invoiceNo}`, createdBy: 'system',
          lines: [{ account_code: '1100', debit: grossAmt }, { account_code: revenueAccount, credit: net }, { account_code: vatAccount, credit: vat }],
        });
      }
      created++;
    }
    return { created };
  }

  // POST /api/finance/ar/receipts — RCP- + อัปเดต paid/status
  async createReceipt(dto: ReceiptDto, user: JwtUser) {
    const db = this.db;
    const [inv] = await db.select().from(arInvoices).where(eq(arInvoices.invoiceNo, dto.invoice_no)).limit(1);
    if (!inv) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invoice not found', messageTh: 'ไม่พบใบแจ้งหนี้' });
    // Idempotency: a retried request carrying the same key returns the original receipt instead of
    // minting a new one + re-posting cash + re-incrementing paidAmount (double-collection).
    if (dto.idempotency_key) {
      const [ex] = await db.select().from(arReceipts).where(and(eq(arReceipts.invoiceNo, dto.invoice_no), eq(arReceipts.idempotencyKey, dto.idempotency_key))).limit(1);
      if (ex) { const [cur] = await db.select().from(arInvoices).where(eq(arInvoices.id, inv.id)).limit(1); return { receipt_no: ex.receiptNo, invoice_no: dto.invoice_no, paid_amount: n(cur?.paidAmount), status: cur?.status, idempotent: true }; }
    }
    const receiptNo = await this.docNo.nextDaily('RCP');
    let newPaid = 0; let status = '';
    await db.transaction(async (tx: any) => {
      // Concurrency: lock the invoice row and recompute paidAmount from the LOCKED current value.
      // Without the lock, two concurrent receipts on the same invoice both read the old paidAmount and
      // write absolute totals → the last writer wins and one collection silently vanishes (AR sub-ledger
      // overstated, control account 1100 ≠ cash collected). FOR UPDATE serializes them.
      const [locked] = await tx.select().from(arInvoices).where(eq(arInvoices.id, inv.id)).for('update').limit(1);
      newPaid = n(locked.paidAmount) + n(dto.amount);
      status = newPaid >= n(locked.amount) ? 'Paid' : 'Partial';
      await tx.insert(arReceipts).values({
        receiptNo, receiptDate: ymd(), tenantId: inv.tenantId, invoiceNo: dto.invoice_no, amount: String(n(dto.amount)),
        method: dto.method ?? 'Transfer', refNo: dto.ref_no ?? null, remarks: dto.remarks ?? null, idempotencyKey: dto.idempotency_key ?? null, createdBy: user.username,
      });
      await tx.update(arInvoices).set({ paidAmount: String(newPaid), status }).where(eq(arInvoices.id, inv.id));
    });
    // GL: collect cash against the receivable (Dr 1000 Cash / Cr 1100 AR). Guarded so a same-receipt re-run posts once.
    if (this.ledger && n(dto.amount) > 0 && !(await this.ledger.alreadyPosted('RCP', receiptNo, inv.tenantId ?? null))) {
      await this.ledger.postEntry({
        date: ymd(), source: 'RCP', sourceRef: receiptNo, tenantId: inv.tenantId ?? null,
        memo: `Receipt ${receiptNo} for ${dto.invoice_no}`, createdBy: user.username,
        lines: [{ account_code: '1000', debit: n(dto.amount) }, { account_code: '1100', credit: n(dto.amount) }],
      });
    }
    await this.statusLog.log('INV', dto.invoice_no, inv.status ?? '', status, user.username, `Receipt ${receiptNo}`);
    return { receipt_no: receiptNo, invoice_no: dto.invoice_no, paid_amount: newPaid, status };
  }

  // ── AR bad-debt write-off (REV-14, maker-checker) ──
  // An uncollectible receivable is written off as bad debt — Dr 5720 Bad Debt Expense / Cr 1100 AR. It posts
  // as a DRAFT via the ledger maker-checker (GL-05): excluded from balances until a DIFFERENT user approves
  // (POST /api/ledger/journal/:entryNo/approve), so one person can't both declare a receivable uncollectible
  // and post the write-off (concealing a misappropriated collection). It appears in the pending-approvals
  // monitor automatically (it is a Draft JE).
  async writeOffAr(dto: { tenant_id?: number | null; customer_name?: string; amount: number; reason: string }, user: JwtUser) {
    if (!this.ledger) throw new BadRequestException({ code: 'LEDGER_UNAVAILABLE', message: 'Ledger not available', messageTh: 'ระบบบัญชีไม่พร้อมใช้งาน' });
    const amount = round2(Number(dto.amount) || 0);
    if (!(amount > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'Write-off amount must be positive', messageTh: 'จำนวนหนี้สูญต้องมากกว่า 0' });
    if (!dto.reason || !dto.reason.trim()) throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'A write-off reason is required', messageTh: 'ต้องระบุเหตุผลการตัดหนี้สูญ' });
    const tenantId = user.tenantId ?? (dto.tenant_id != null ? Number(dto.tenant_id) : null);
    const who = dto.customer_name?.trim() ? ` — ${dto.customer_name.trim()}` : (dto.tenant_id != null ? ` — ลูกค้า #${dto.tenant_id}` : '');
    // docs/43 PR-2: the expense leg follows the tenant posting-rule (BADDEBT.WRITEOFF.bad_debt_exp);
    // the AR control leg stays pinned (Tier C).
    const wovr = await this.ledger.postingOverrides('BADDEBT.WRITEOFF', tenantId);
    const je: any = await this.ledger.postEntry({
      date: ymd(), source: 'AR-WRITEOFF', sourceRef: `${dto.tenant_id ?? 'NA'}:${new Date().toISOString()}`, tenantId,
      memo: `ตัดหนี้สูญ${who}: ${dto.reason.trim()}`, createdBy: user.username, pendingApproval: true,
      lines: [
        { account_code: wovr.bad_debt_exp ?? postingDefault('BADDEBT.WRITEOFF', 'bad_debt_exp'), debit: amount, memo: `Bad debt write-off${who}` },
        { account_code: '1100', credit: amount, memo: 'AR written off' },
      ],
    });
    return { entry_no: je.entry_no, status: je.status, pending: !!je.pending, amount, reason: dto.reason.trim(), customer_tenant_id: dto.tenant_id ?? null };
  }
}
