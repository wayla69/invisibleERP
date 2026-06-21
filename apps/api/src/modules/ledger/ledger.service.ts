import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { sql, eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { accounts, journalEntries, journalLines, fiscalPeriods } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { ymd, n, fx } from '../../database/queries';

// minimal Chart of Accounts (code, name, type)
const COA: { code: string; name: string; type: 'Asset' | 'Liability' | 'Equity' | 'Revenue' | 'Expense' }[] = [
  { code: '1000', name: 'Cash', type: 'Asset' },
  { code: '1100', name: 'Accounts Receivable', type: 'Asset' },
  { code: '1200', name: 'Inventory', type: 'Asset' },
  { code: '2000', name: 'Accounts Payable', type: 'Liability' },
  { code: '2100', name: 'Tax Payable', type: 'Liability' },
  { code: '3000', name: 'Equity', type: 'Equity' },
  { code: '3100', name: 'Retained Earnings', type: 'Equity' },
  { code: '4000', name: 'Sales Revenue', type: 'Revenue' },
  { code: '5000', name: 'COGS', type: 'Expense' },
  { code: '5100', name: 'Operating Expense', type: 'Expense' },
  { code: '1500', name: 'Fixed Assets', type: 'Asset' },
  { code: '1590', name: 'Accumulated Depreciation', type: 'Asset' }, // contra-asset (normal credit bal)
  { code: '5200', name: 'Depreciation Expense', type: 'Expense' },
  { code: '1510', name: 'Gain/Loss on Disposal', type: 'Revenue' }, // gain=credit, loss=debit
  { code: '1010', name: 'Bank — Current', type: 'Asset' }, // house-bank GL accounts (bank reconciliation)
  { code: '1020', name: 'Bank — Savings', type: 'Asset' },
];

export interface JournalLineDto { account_code: string; debit?: number; credit?: number; memo?: string; cost_center?: string | null }
export interface PostEntryDto {
  date?: string;
  source: string;
  sourceRef?: string;
  tenantId?: number | null;
  currency?: string;
  memo?: string;
  lines: JournalLineDto[];
  createdBy: string;
}

@Injectable()
export class LedgerService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
  ) {}

  // ───────────────────── Chart of Accounts ─────────────────────
  // idempotent seed — onConflictDoNothing บน accounts.code (unique)
  async seedChartOfAccounts() {
    const db = this.db as any;
    await db.insert(accounts).values(COA).onConflictDoNothing({ target: accounts.code });
    return { seeded: COA.length };
  }

  async listAccounts() {
    const db = this.db as any;
    const rows = await db.select().from(accounts).orderBy(accounts.code);
    return { accounts: rows, count: rows.length };
  }

  // ───────────────────── Post a balanced entry ─────────────────────
  // BALANCED BY CONSTRUCTION — throw UNBALANCED if Σdebit !== Σcredit (round 4) or empty.
  async postEntry(dto: PostEntryDto) {
    const db = this.db as any;
    const lines = dto.lines ?? [];
    if (!lines.length) throw new BadRequestException({ code: 'UNBALANCED', message: 'No journal lines', messageTh: 'ไม่มีรายการบัญชี' });

    // Drop all-zero lines BEFORE validation/balance so a zero-rated leg (e.g. POS Cr Tax Payable
    // with vat=0) doesn't trip the per-line invariant. A sale with vat=0 still posts its other legs.
    const nzLines = lines.filter((l) => !(n(l.debit) === 0 && n(l.credit) === 0));
    if (!nzLines.length) throw new BadRequestException({ code: 'UNBALANCED', message: 'No non-zero journal lines', messageTh: 'ไม่มีรายการบัญชีที่มีมูลค่า' });

    // Per-line invariant (service-level — applies to internal callers like POS, not just the Zod controller):
    // each line is single-sided and non-negative.
    for (const l of nzLines) {
      const d = n(l.debit), c = n(l.credit);
      if (d < 0 || c < 0) {
        throw new BadRequestException({ code: 'INVALID_LINE', message: `Negative amount on ${l.account_code} (debit ${d}, credit ${c})`, messageTh: 'จำนวนเงินติดลบในรายการบัญชี' });
      }
      if (d > 0 && c > 0) {
        throw new BadRequestException({ code: 'INVALID_LINE', message: `Line ${l.account_code} has both debit ${d} and credit ${c}`, messageTh: 'รายการบัญชีมีทั้งเดบิตและเครดิต' });
      }
    }

    const totalDebit = round4(nzLines.reduce((a, l) => a + n(l.debit), 0));
    const totalCredit = round4(nzLines.reduce((a, l) => a + n(l.credit), 0));
    if (totalDebit !== totalCredit) {
      throw new BadRequestException({
        code: 'UNBALANCED',
        message: `Entry not balanced: debit ${totalDebit} != credit ${totalCredit}`,
        messageTh: 'รายการไม่สมดุล (เดบิตไม่เท่าเครดิต)',
      });
    }

    const entryDate = dto.date ?? ymd();
    const period = entryDate.slice(0, 7); // 'YYYY-MM'
    // Period guard: a CLOSED fiscal period rejects new postings. A missing period row defaults OPEN
    // (existing flows post into the current month without pre-seeding a period).
    const [pp] = await db.select({ status: fiscalPeriods.status }).from(fiscalPeriods).where(eq(fiscalPeriods.code, period)).limit(1);
    if (pp && pp.status === 'Closed') {
      throw new BadRequestException({ code: 'PERIOD_CLOSED', message: `Period ${period} is closed`, messageTh: `งวดบัญชี ${period} ถูกปิดแล้ว` });
    }
    const currency = dto.currency ?? 'THB';
    const entryNo = await this.docNo.nextDaily('JE');

    const inserted = await db.transaction(async (tx: any) => {
      const [h] = await tx.insert(journalEntries).values({
        entryNo, entryDate, period, memo: dto.memo ?? null,
        source: dto.source ?? 'Manual', sourceRef: dto.sourceRef ?? null,
        tenantId: dto.tenantId ?? null, currency, status: 'Posted', createdBy: dto.createdBy,
      }).returning({ id: journalEntries.id });
      await tx.insert(journalLines).values(nzLines.map((l) => ({
        entryId: Number(h.id), accountCode: l.account_code,
        debit: fx(l.debit, 4), credit: fx(l.credit, 4),
        currency, memo: l.memo ?? null, costCenterCode: l.cost_center ?? null, tenantId: dto.tenantId ?? null,
      })));
      return nzLines.map((l) => ({ account_code: l.account_code, debit: n(l.debit), credit: n(l.credit), memo: l.memo ?? null }));
    });

    return { entry_no: entryNo, balanced: true, lines: inserted };
  }

  // ───────────────────── Journal listing ─────────────────────
  async listJournal(limit: number) {
    const db = this.db as any;
    const heads = await db.select().from(journalEntries).orderBy(desc(journalEntries.id)).limit(limit);
    const out: any[] = [];
    for (const h of heads) {
      const lines = await db.select({
        account_code: journalLines.accountCode, debit: journalLines.debit, credit: journalLines.credit, memo: journalLines.memo,
      }).from(journalLines).where(eq(journalLines.entryId, h.id));
      out.push({
        entry_no: h.entryNo, entry_date: h.entryDate, period: h.period, source: h.source, source_ref: h.sourceRef,
        memo: h.memo, currency: h.currency, status: h.status, created_by: h.createdBy, created_at: h.createdAt,
        lines: lines.map((l: any) => ({ ...l, debit: n(l.debit), credit: n(l.credit) })),
      });
    }
    return { entries: out, count: out.length };
  }

  // ───────────────────── Trial Balance ─────────────────────
  // group journal_lines by account_code (joined to accounts) — Σdebit, Σcredit, balance
  async trialBalance(period?: string, costCenter?: string | null) {
    const db = this.db as any;
    const conds = [eq(journalEntries.status, 'Posted')];
    if (period) conds.push(sql`${journalEntries.period} = ${period}`);
    if (costCenter === '__UNASSIGNED__') conds.push(sql`${journalLines.costCenterCode} IS NULL`);
    else if (costCenter) conds.push(eq(journalLines.costCenterCode, costCenter));
    const where = and(...conds);
    const rows = await db
      .select({
        account_code: journalLines.accountCode,
        account_name: accounts.name,
        account_type: accounts.type,
        debit: sql<string>`coalesce(sum(${journalLines.debit}),0)`,
        credit: sql<string>`coalesce(sum(${journalLines.credit}),0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .leftJoin(accounts, eq(journalLines.accountCode, accounts.code))
      .where(where)
      .groupBy(journalLines.accountCode, accounts.name, accounts.type)
      .orderBy(journalLines.accountCode);

    const out = rows.map((r: any) => {
      const debit = round4(n(r.debit));
      const credit = round4(n(r.credit));
      return { account_code: r.account_code, account_name: r.account_name, account_type: r.account_type, debit, credit, balance: round4(debit - credit) };
    });
    const totalDebit = round4(out.reduce((a: number, r: any) => a + r.debit, 0));
    const totalCredit = round4(out.reduce((a: number, r: any) => a + r.credit, 0));
    return { period: period ?? null, cost_center: costCenter ?? null, rows: out, totals: { debit: totalDebit, credit: totalCredit, balanced: totalDebit === totalCredit } };
  }

  // ───────────────────── Income Statement ─────────────────────
  // Revenue − Expense = net income, over [from,to] (entry_date inclusive)
  async incomeStatement(from: string, to: string, costCenter?: string | null) {
    const db = this.db as any;
    const rows = await this.aggregateByType(db, from, to, costCenter);
    const revenue = round4(typeTotal(rows, 'Revenue', 'credit') - typeTotal(rows, 'Revenue', 'debit'));
    const expense = round4(typeTotal(rows, 'Expense', 'debit') - typeTotal(rows, 'Expense', 'credit'));
    const netIncome = round4(revenue - expense);
    return {
      from, to, cost_center: costCenter ?? null,
      revenue, expense, net_income: netIncome,
      lines: rows.filter((r: any) => r.account_type === 'Revenue' || r.account_type === 'Expense'),
    };
  }

  // ───────────────────── Balance Sheet ─────────────────────
  // Assets = Liabilities + Equity + retained net income (as of date, inclusive)
  async balanceSheet(asOf: string) {
    const db = this.db as any;
    const rows = await this.aggregateByType(db, null, asOf);
    const assets = round4(typeTotal(rows, 'Asset', 'debit') - typeTotal(rows, 'Asset', 'credit'));
    const liabilities = round4(typeTotal(rows, 'Liability', 'credit') - typeTotal(rows, 'Liability', 'debit'));
    // equity INCLUDES 3100 Retained Earnings (closed-year results carried here by closeYear)
    const equity = round4(typeTotal(rows, 'Equity', 'credit') - typeTotal(rows, 'Equity', 'debit'));
    // current UNCLOSED-period P&L still sits in Revenue/Expense (closed years were zeroed into 3100)
    const netIncome = round4(
      (typeTotal(rows, 'Revenue', 'credit') - typeTotal(rows, 'Revenue', 'debit')) -
      (typeTotal(rows, 'Expense', 'debit') - typeTotal(rows, 'Expense', 'credit')),
    );
    // retained_earnings is a DISPLAY sub-total of equity (the 3100 balance) — not added again
    const retainedEarnings = round4(rows.filter((r: any) => r.account_code === '3100').reduce((a: number, r: any) => a + (n(r.credit) - n(r.debit)), 0));
    const liabilitiesEquity = round4(liabilities + equity + netIncome);
    return {
      as_of: asOf,
      assets, liabilities, equity, retained_earnings: retainedEarnings, net_income: netIncome,
      liabilities_plus_equity: liabilitiesEquity,
      balanced: assets === liabilitiesEquity,
    };
  }

  // ───────────────────── Idempotency + Fiscal periods ─────────────────────
  // has a GL entry already been posted for this source+ref? (used by AR/AP hooks + closeYear)
  async alreadyPosted(source: string, sourceRef: string): Promise<boolean> {
    const db = this.db as any;
    const [r] = await db.select({ id: journalEntries.id }).from(journalEntries)
      .where(and(eq(journalEntries.source, source), eq(journalEntries.sourceRef, sourceRef))).limit(1);
    return !!r;
  }

  private periodBounds(period: string) {
    const [y, m] = period.split('-').map(Number);
    const start = `${period}-01`;
    const endDate = m < 12 ? `${y}-${String(m + 1).padStart(2, '0')}-01` : `${y}-12-31`;
    return { start, endDate };
  }

  async ensurePeriod(period: string) {
    const db = this.db as any;
    const { start, endDate } = this.periodBounds(period);
    await db.insert(fiscalPeriods).values({ code: period, startDate: start, endDate, status: 'Open' }).onConflictDoNothing({ target: fiscalPeriods.code });
  }

  async listPeriods() {
    const db = this.db as any;
    const rows = await db.select().from(fiscalPeriods).orderBy(fiscalPeriods.code);
    return { periods: rows.map((p: any) => ({ code: p.code, status: p.status, start_date: p.startDate, end_date: p.endDate })), count: rows.length };
  }

  async setPeriodStatus(period: string, status: 'Open' | 'Closed') {
    const db = this.db as any;
    await this.ensurePeriod(period);
    await db.update(fiscalPeriods).set({ status }).where(eq(fiscalPeriods.code, period));
    return { period, status };
  }
  async closePeriod(period: string) { return this.setPeriodStatus(period, 'Closed'); }
  async openPeriod(period: string) { return this.setPeriodStatus(period, 'Open'); }

  // Year-end close: post a closing journal zeroing Revenue & Expense into 3100 Retained Earnings,
  // then close all 12 months. Idempotent (skips if FY already closed).
  async closeYear(fiscalYear: number, createdBy: string) {
    const db = this.db as any;
    if (await this.alreadyPosted('CLOSE', `FY${fiscalYear}`)) {
      return { closed: true, fiscal_year: fiscalYear, already: true };
    }
    const from = `${fiscalYear}-01-01`, to = `${fiscalYear}-12-31`;
    const rows = await this.aggregateByType(db, from, to);
    const lines: JournalLineDto[] = [];
    let revTotal = 0, expTotal = 0;
    for (const r of rows) {
      if (r.account_type === 'Revenue') {
        const bal = round4(n(r.credit) - n(r.debit)); // revenue normal credit balance
        if (bal !== 0) { lines.push({ account_code: r.account_code, debit: bal }); revTotal += bal; }
      } else if (r.account_type === 'Expense') {
        const bal = round4(n(r.debit) - n(r.credit)); // expense normal debit balance
        if (bal !== 0) { lines.push({ account_code: r.account_code, credit: bal }); expTotal += bal; }
      }
    }
    const netIncome = round4(revTotal - expTotal);
    if (netIncome > 0) lines.push({ account_code: '3100', credit: netIncome });
    else if (netIncome < 0) lines.push({ account_code: '3100', debit: -netIncome });
    if (!lines.length) return { closed: true, fiscal_year: fiscalYear, net_income: 0, entry_no: null, note: 'no P&L activity' };

    await this.ensurePeriod(`${fiscalYear}-12`);
    const je = await this.postEntry({ date: to, source: 'CLOSE', sourceRef: `FY${fiscalYear}`, memo: `Year-end close FY${fiscalYear}`, createdBy, lines });
    for (let m = 1; m <= 12; m++) await this.closePeriod(`${fiscalYear}-${String(m).padStart(2, '0')}`);
    return { closed: true, fiscal_year: fiscalYear, net_income: netIncome, entry_no: je.entry_no };
  }

  // group Posted journal_lines by account type within optional date window
  private async aggregateByType(db: any, from: string | null, to: string, costCenter?: string | null) {
    const conds = [eq(journalEntries.status, 'Posted'), sql`${journalEntries.entryDate} <= ${to}`];
    if (from) conds.push(sql`${journalEntries.entryDate} >= ${from}`);
    if (costCenter === '__UNASSIGNED__') conds.push(sql`${journalLines.costCenterCode} IS NULL`);
    else if (costCenter) conds.push(eq(journalLines.costCenterCode, costCenter));
    const rows = await db
      .select({
        account_type: accounts.type,
        account_code: journalLines.accountCode,
        account_name: accounts.name,
        debit: sql<string>`coalesce(sum(${journalLines.debit}),0)`,
        credit: sql<string>`coalesce(sum(${journalLines.credit}),0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .leftJoin(accounts, eq(journalLines.accountCode, accounts.code))
      .where(and(...conds))
      .groupBy(accounts.type, journalLines.accountCode, accounts.name)
      .orderBy(journalLines.accountCode);
    return rows.map((r: any) => ({
      account_type: r.account_type, account_code: r.account_code, account_name: r.account_name,
      debit: round4(n(r.debit)), credit: round4(n(r.credit)),
    }));
  }
}

function round4(x: number): number { return Math.round(x * 10000) / 10000; }
function typeTotal(rows: any[], type: string, side: 'debit' | 'credit'): number {
  return rows.filter((r) => r.account_type === type).reduce((a, r) => a + n(r[side]), 0);
}
