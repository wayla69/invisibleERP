import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { icTransactions, icSettlements, journalLines, journalEntries } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import { n, fx, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import type { CreateIcDto, SettleIcDto } from './dto';

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;
// category → (creditor credit account, debtor debit account)
const MAP: Record<string, { creditorCr: string; debtorDr: string }> = {
  'shared-cost': { creditorCr: '5100', debtorDr: '5100' },
  'transfer': { creditorCr: '4000', debtorDr: '5100' },
  'loan': { creditorCr: '1000', debtorDr: '1000' },
  // W2 (docs/27) coalition clearing: cross-shop loyalty point movements at fair value. Both legs ride
  // 5700 (loyalty points expense) — the debtor shop bears the cost it caused, the creditor shop recovers
  // it against the accrual its own ledger books (LYL-03 stays per-shop-true by construction). NOT exposed
  // on the manual /api/intercompany endpoint (dto enum unchanged) — only the coalition service (LYL-19)
  // creates these, via createIcInternal.
  'loyalty-clearing': { creditorCr: '5700', debtorDr: '5700' },
};

@Injectable()
export class IntercompanyService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly ledger: LedgerService,
  ) {}

  private hqOnly(user: JwtUser) {
    if (user.role !== 'Admin') throw new ForbiddenException({ code: 'IC_HQ_ONLY', message: 'Intercompany posting is HQ-only', messageTh: 'รายการระหว่างกิจการทำได้เฉพาะสำนักงานใหญ่' });
  }

  async createIcTransaction(dto: CreateIcDto, user: JwtUser) {
    this.hqOnly(user); // manual IC posting stays HQ-only; system flows (coalition clearing) use createIcInternal
    return this.createIcInternal(dto, user.username);
  }

  // Post an IC transaction WITHOUT the HQ-role guard — for system-generated clearing entries whose
  // authorization is enforced upstream (the coalition service validates active shared membership before
  // every cross-shop movement, control LYL-19). Never expose this on a controller directly.
  async createIcInternal(dto: Omit<CreateIcDto, 'category'> & { category: string }, username: string) {
    const db = this.db;
    const A = n(dto.amount); const date = dto.date ?? ymd(); const cat = dto.category; const m = MAP[cat];
    if (!m) throw new BadRequestException({ code: 'IC_BAD_CATEGORY', message: `Unknown IC category '${cat}'`, messageTh: 'ประเภทรายการระหว่างกิจการไม่ถูกต้อง' });
    const icNo = await this.docNo.nextDaily('IC');
    await db.insert(icTransactions).values({ icNo, tenantId: dto.from_tenant_id, fromTenantId: dto.from_tenant_id, toTenantId: dto.to_tenant_id, txnDate: date, amount: fx(A, 4), settledAmount: '0', currency: dto.currency ?? 'THB', category: cat as typeof icTransactions.$inferInsert.category, description: dto.description ?? null, status: 'Open', createdBy: username });
    // FROM (creditor): Dr 1150 Due-From / Cr recovery
    let fromJe: string | null = null;
    if (!(await this.ledger.alreadyPosted('IC', icNo))) {
      const je: any = await this.ledger.postEntry({ date, source: 'IC', sourceRef: icNo, tenantId: dto.from_tenant_id, currency: dto.currency, memo: `IC ${icNo} due-from`, createdBy: username, lines: [{ account_code: '1150', debit: A }, { account_code: m.creditorCr, credit: A }] });
      fromJe = je?.entry_no ?? null;
    }
    // TO (debtor): Dr expense/cash / Cr 2150 Due-To
    let toJe: string | null = null;
    if (!(await this.ledger.alreadyPosted('IC', `${icNo}:TO`))) {
      const je: any = await this.ledger.postEntry({ date, source: 'IC', sourceRef: `${icNo}:TO`, tenantId: dto.to_tenant_id, currency: dto.currency, memo: `IC ${icNo} due-to`, createdBy: username, lines: [{ account_code: m.debtorDr, debit: A }, { account_code: '2150', credit: A }] });
      toJe = je?.entry_no ?? null;
    }
    await db.update(icTransactions).set({ fromJournalNo: fromJe, toJournalNo: toJe }).where(eq(icTransactions.icNo, icNo));
    return { ic_no: icNo, from_journal_no: fromJe, to_journal_no: toJe, amount: A, category: cat, status: 'Open' };
  }

  async settleIc(icNo: string, dto: SettleIcDto, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db;
    const [ic] = await db.select().from(icTransactions).where(eq(icTransactions.icNo, icNo)).limit(1);
    if (!ic) throw new NotFoundException({ code: 'NOT_FOUND', message: 'IC transaction not found', messageTh: 'ไม่พบรายการระหว่างกิจการ' });
    const S = n(dto.amount); const outstanding = round4(n(ic.amount) - n(ic.settledAmount));
    if (S > outstanding + 1e-9) throw new BadRequestException({ code: 'IC_OVERPAY', message: `Settle ${S} exceeds outstanding ${outstanding}`, messageTh: `ยอดชำระเกินยอดคงค้าง (${outstanding})` });
    const newSettled = round4(n(ic.settledAmount) + S); const status = newSettled >= n(ic.amount) - 1e-9 ? 'Settled' : 'Partial';
    const date = dto.date ?? ymd();
    // debtor pays: Dr 2150 / Cr 1000
    const toJe: any = await this.ledger.postEntry({ date, source: 'IC-SETTLE', sourceRef: `${icNo}:TO:${newSettled}`, tenantId: ic.toTenantId, memo: `IC settle ${icNo} due-to`, createdBy: user.username, lines: [{ account_code: '2150', debit: S }, { account_code: '1000', credit: S }] });
    // creditor receives: Dr 1000 / Cr 1150
    const fromJe: any = await this.ledger.postEntry({ date, source: 'IC-SETTLE', sourceRef: `${icNo}:${newSettled}`, tenantId: ic.fromTenantId, memo: `IC settle ${icNo} due-from`, createdBy: user.username, lines: [{ account_code: '1000', debit: S }, { account_code: '1150', credit: S }] });
    await db.insert(icSettlements).values({ tenantId: ic.fromTenantId, icNo, settleDate: date, amount: fx(S, 4), fromJournalNo: fromJe?.entry_no ?? null, toJournalNo: toJe?.entry_no ?? null, createdBy: user.username });
    await db.update(icTransactions).set({ settledAmount: fx(newSettled, 4), status }).where(eq(icTransactions.icNo, icNo));
    return { ic_no: icNo, settled_amount: newSettled, status, from_journal_no: fromJe?.entry_no ?? null, to_journal_no: toJe?.entry_no ?? null };
  }

  async listIc(_user: JwtUser, status?: string) {
    const db = this.db;
    const rows = await db.select().from(icTransactions).where(status ? eq(icTransactions.status, status as typeof icTransactions.$inferSelect.status) : undefined).orderBy(icTransactions.id);
    return { ic_transactions: rows.map(shape), count: rows.length };
  }

  async getIc(icNo: string, _user: JwtUser) {
    const db = this.db;
    const [ic] = await db.select().from(icTransactions).where(eq(icTransactions.icNo, icNo)).limit(1);
    if (!ic) throw new NotFoundException({ code: 'NOT_FOUND', message: 'IC transaction not found', messageTh: 'ไม่พบรายการระหว่างกิจการ' });
    const settlements = await db.select().from(icSettlements).where(eq(icSettlements.icNo, icNo));
    return { ...shape(ic), settlements: settlements.map((s: any) => ({ amount: n(s.amount), settle_date: s.settleDate })) };
  }

  // elimination report — reads the GL (1150 due-from / 2150 due-to) + ic_transactions for pair detail
  async reconciliation(_user: JwtUser) {
    const db = this.db;
    const dueFrom = await db.select({ tenant: journalEntries.tenantId, bal: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}),0)` }).from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id)).where(sql`${journalLines.accountCode} = '1150' AND ${journalEntries.status} = 'Posted'`).groupBy(journalEntries.tenantId);
    const dueTo = await db.select({ tenant: journalEntries.tenantId, bal: sql<string>`coalesce(sum(${journalLines.credit} - ${journalLines.debit}),0)` }).from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id)).where(sql`${journalLines.accountCode} = '2150' AND ${journalEntries.status} = 'Posted'`).groupBy(journalEntries.tenantId);
    const totalDueFrom = round4(dueFrom.reduce((a: number, r: any) => a + n(r.bal), 0));
    const totalDueTo = round4(dueTo.reduce((a: number, r: any) => a + n(r.bal), 0));
    const byTenantMap = new Map<number, any>();
    for (const r of dueFrom) byTenantMap.set(Number(r.tenant), { tenant_id: Number(r.tenant), due_from: round4(n(r.bal)), due_to: 0 });
    for (const r of dueTo) { const e = byTenantMap.get(Number(r.tenant)) ?? { tenant_id: Number(r.tenant), due_from: 0, due_to: 0 }; e.due_to = round4(n(r.bal)); byTenantMap.set(Number(r.tenant), e); }
    const txns = await db.select().from(icTransactions);
    const pairMap = new Map<string, any>();
    for (const t of txns) {
      const key = `${t.fromTenantId}->${t.toTenantId}`;
      const e = pairMap.get(key) ?? { from_tenant_id: Number(t.fromTenantId), to_tenant_id: Number(t.toTenantId), gross: 0, settled: 0, outstanding: 0, count: 0 };
      e.gross = round4(e.gross + n(t.amount)); e.settled = round4(e.settled + n(t.settledAmount)); e.outstanding = round4(e.outstanding + (n(t.amount) - n(t.settledAmount))); e.count++;
      pairMap.set(key, e);
    }
    return { total_due_from: totalDueFrom, total_due_to: totalDueTo, eliminates: Math.abs(totalDueFrom - totalDueTo) < 0.01, difference: round4(totalDueFrom - totalDueTo), by_tenant: [...byTenantMap.values()], by_pair: [...pairMap.values()].filter((p) => p.outstanding > 0.001) };
  }
}

function shape(t: any) {
  return { ic_no: t.icNo, from_tenant_id: Number(t.fromTenantId), to_tenant_id: Number(t.toTenantId), amount: n(t.amount), settled_amount: n(t.settledAmount), outstanding: round4(n(t.amount) - n(t.settledAmount)), currency: t.currency, category: t.category, status: t.status, txn_date: t.txnDate, from_journal_no: t.fromJournalNo, to_journal_no: t.toJournalNo, description: t.description };
}
