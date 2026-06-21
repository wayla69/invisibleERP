import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { sql, eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { accounts, journalEntries, journalLines } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { ymd, n } from '../../database/queries';

// minimal Chart of Accounts (code, name, type)
const COA: { code: string; name: string; type: 'Asset' | 'Liability' | 'Equity' | 'Revenue' | 'Expense' }[] = [
  { code: '1000', name: 'Cash', type: 'Asset' },
  { code: '1100', name: 'Accounts Receivable', type: 'Asset' },
  { code: '1200', name: 'Inventory', type: 'Asset' },
  { code: '2000', name: 'Accounts Payable', type: 'Liability' },
  { code: '2100', name: 'Tax Payable', type: 'Liability' },
  { code: '3000', name: 'Equity', type: 'Equity' },
  { code: '4000', name: 'Sales Revenue', type: 'Revenue' },
  { code: '5000', name: 'COGS', type: 'Expense' },
  { code: '5100', name: 'Operating Expense', type: 'Expense' },
];

export interface JournalLineDto { account_code: string; debit?: number; credit?: number; memo?: string }
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

    const totalDebit = round4(lines.reduce((a, l) => a + n(l.debit), 0));
    const totalCredit = round4(lines.reduce((a, l) => a + n(l.credit), 0));
    if (totalDebit !== totalCredit) {
      throw new BadRequestException({
        code: 'UNBALANCED',
        message: `Entry not balanced: debit ${totalDebit} != credit ${totalCredit}`,
        messageTh: 'รายการไม่สมดุล (เดบิตไม่เท่าเครดิต)',
      });
    }

    const entryDate = dto.date ?? ymd();
    const period = entryDate.slice(0, 7); // 'YYYY-MM'
    const currency = dto.currency ?? 'THB';
    const entryNo = await this.docNo.nextDaily('JE');

    const inserted = await db.transaction(async (tx: any) => {
      const [h] = await tx.insert(journalEntries).values({
        entryNo, entryDate, period, memo: dto.memo ?? null,
        source: dto.source ?? 'Manual', sourceRef: dto.sourceRef ?? null,
        tenantId: dto.tenantId ?? null, currency, status: 'Posted', createdBy: dto.createdBy,
      }).returning({ id: journalEntries.id });
      await tx.insert(journalLines).values(lines.map((l) => ({
        entryId: Number(h.id), accountCode: l.account_code,
        debit: String(n(l.debit)), credit: String(n(l.credit)),
        currency, memo: l.memo ?? null, tenantId: dto.tenantId ?? null,
      })));
      return lines.map((l) => ({ account_code: l.account_code, debit: n(l.debit), credit: n(l.credit), memo: l.memo ?? null }));
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
  async trialBalance(period?: string) {
    const db = this.db as any;
    const where = period
      ? and(eq(journalEntries.status, 'Posted'), sql`${journalEntries.period} = ${period}`)
      : eq(journalEntries.status, 'Posted');
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
    return { period: period ?? null, rows: out, totals: { debit: totalDebit, credit: totalCredit, balanced: totalDebit === totalCredit } };
  }

  // ───────────────────── Income Statement ─────────────────────
  // Revenue − Expense = net income, over [from,to] (entry_date inclusive)
  async incomeStatement(from: string, to: string) {
    const db = this.db as any;
    const rows = await this.aggregateByType(db, from, to);
    const revenue = round4(typeTotal(rows, 'Revenue', 'credit') - typeTotal(rows, 'Revenue', 'debit'));
    const expense = round4(typeTotal(rows, 'Expense', 'debit') - typeTotal(rows, 'Expense', 'credit'));
    const netIncome = round4(revenue - expense);
    return {
      from, to,
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
    const equity = round4(typeTotal(rows, 'Equity', 'credit') - typeTotal(rows, 'Equity', 'debit'));
    const netIncome = round4(
      (typeTotal(rows, 'Revenue', 'credit') - typeTotal(rows, 'Revenue', 'debit')) -
      (typeTotal(rows, 'Expense', 'debit') - typeTotal(rows, 'Expense', 'credit')),
    );
    const liabilitiesEquity = round4(liabilities + equity + netIncome);
    return {
      as_of: asOf,
      assets, liabilities, equity, net_income: netIncome,
      liabilities_plus_equity: liabilitiesEquity,
      balanced: assets === liabilitiesEquity,
    };
  }

  // group Posted journal_lines by account type within optional date window
  private async aggregateByType(db: any, from: string | null, to: string) {
    const conds = [eq(journalEntries.status, 'Posted'), sql`${journalEntries.entryDate} <= ${to}`];
    if (from) conds.push(sql`${journalEntries.entryDate} >= ${from}`);
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
