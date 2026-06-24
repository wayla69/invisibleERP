import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { sql, eq, and, desc, notInArray, gt, lte } from 'drizzle-orm';
import type { JwtUser } from '../../common/decorators';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { accounts, journalEntries, journalLines, fiscalPeriods, ledgers, posMembers, posMemberLedger, loyaltyConfig, loyaltyPostingRuns } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { currentTenantStore } from '../../common/tenant-context';
import { ymd, n, fx } from '../../database/queries';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// Resolve the tenant a period/close operation belongs to: explicit arg wins, else the request's
// own tenant (the interceptor's ALS). null only when called outside any request (bootstrap/seed).
function resolveTenantId(explicit?: number | null): number | null {
  if (explicit !== undefined && explicit !== null) return explicit;
  return currentTenantStore()?.tenantId ?? null;
}

// Parallel sets of books. The LEADING ledger is the statutory/primary book — reports default to it, and a
// journal with ledger_code = NULL is shared by every ledger (so all existing postings are universal).
const LEADING = 'TFRS';
const LEDGERS: { code: string; name: string; gaap: string; isLeading: boolean; description: string }[] = [
  { code: 'TFRS', name: 'TFRS (งบตามกฎหมาย)', gaap: 'TFRS', isLeading: true, description: 'Thai Financial Reporting Standards — statutory financial statements' },
  { code: 'TAX', name: 'ฐานภาษีสรรพากร', gaap: 'TAX', isLeading: false, description: 'Revenue Department basis — depreciation/expenses per the Revenue Code (book-tax differences)' },
  { code: 'IFRS', name: 'IFRS (กลุ่มบริษัท)', gaap: 'IFRS', isLeading: false, description: 'IFRS basis for group consolidation' },
];

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
  { code: '2400', name: 'Unearned Revenue', type: 'Liability' }, // รายได้รอตัดบัญชี — deferred revenue
  { code: '5400', name: 'FX Gain/Loss (Unrealized)', type: 'Expense' }, // กำไร/ขาดทุนอัตราแลกเปลี่ยน — loss=debit, gain=credit
  { code: '1150', name: 'Intercompany Receivable', type: 'Asset' },     // Due From group company
  { code: '2150', name: 'Intercompany Payable', type: 'Liability' },    // Due To group company
  { code: '5300', name: 'Recipe COGS', type: 'Expense' },               // ตัดวัตถุดิบตามสูตร (recipe ingredient COGS)
  { code: '2200', name: 'Customer Deposits', type: 'Liability' },       // gift cards / store credit (unredeemed) — บัตรของขวัญ/เครดิตร้านค้า
  { code: '2300', name: 'Tips Payable', type: 'Liability' },            // staff tip pass-through (not revenue, not VATable) — ทิปพนักงาน
  { code: '4100', name: 'Delivery Income', type: 'Revenue' },           // รายได้ค่าจัดส่ง (VATable, separate from food sales 4000)
  { code: '5500', name: 'Purchase Price Variance', type: 'Expense' },   // STD costing PPV — unfavorable=debit, favorable=credit
  { code: '5600', name: 'Salaries & Wages', type: 'Expense' },          // เงินเดือน — payroll gross
  { code: '5610', name: 'Social Security (Employer)', type: 'Expense' }, // เงินสมทบประกันสังคมส่วนนายจ้าง
  { code: '2350', name: 'Social Security Payable', type: 'Liability' }, // ประกันสังคมค้างจ่าย (ลูกจ้าง+นายจ้าง)
  { code: '2360', name: 'Payroll WHT Payable (PND1)', type: 'Liability' }, // ภาษีหัก ณ ที่จ่ายเงินเดือน (ภ.ง.ด.1) ค้างจ่าย
  { code: '1250', name: 'Work-in-Process', type: 'Asset' },             // งานระหว่างทำ (WIP) — manufacturing
  { code: '1210', name: 'Finished Goods', type: 'Asset' },              // สินค้าสำเร็จรูป — จากใบสั่งผลิต
  { code: '2380', name: 'Manufacturing Costs Applied', type: 'Liability' }, // ค่าแรง/โสหุ้ยการผลิตที่คิดเข้างาน (clearing)
  { code: '1260', name: 'Project WIP / Unbilled Cost', type: 'Asset' },  // ต้นทุนงานโครงการที่ยังไม่รับรู้
  { code: '2390', name: 'Project Costs Applied', type: 'Liability' },    // ต้นทุนโครงการคิดเข้างาน (clearing)
  { code: '4200', name: 'Project Revenue', type: 'Revenue' },            // รายได้งานโครงการ
  { code: '5800', name: 'Project Cost of Services', type: 'Expense' },   // ต้นทุนงานบริการโครงการ
  { code: '5810', name: 'Scrap / Rework Loss', type: 'Expense' },        // ผลขาดทุนจากของเสีย/แก้ไขงาน (QA)
  { code: '5620', name: 'Provident Fund (Employer)', type: 'Expense' },  // เงินสมทบกองทุนสำรองเลี้ยงชีพส่วนนายจ้าง
  { code: '2370', name: 'Provident Fund Payable', type: 'Liability' },   // กองทุนสำรองเลี้ยงชีพค้างจ่าย (ลูกจ้าง+นายจ้าง)
  { code: '4300', name: 'Subscription & Service Revenue', type: 'Revenue' }, // รายได้ค่าบริการ/สมาชิกแบบเรียกเก็บประจำ
  { code: '4400', name: 'Service Charge Income', type: 'Revenue' },          // รายได้ค่าบริการ (เซอร์วิสชาร์จ) — VATable, auto for large parties
  { code: '4900', name: 'Rounding Adjustment', type: 'Revenue' },            // ปัดเศษสตางค์ — rounded up=credit (gain), down=debit (loss)
  { code: '2210', name: 'Customer Deposits — Prepaid', type: 'Liability' },  // มัดจำ/เงินรับล่วงหน้า (booking/tab) — recognised to revenue on apply
  { code: '4500', name: 'Card Surcharge Income', type: 'Revenue' },          // รายได้ค่าธรรมเนียมบัตร — VATable card surcharge
  { code: '5410', name: 'FX Gain/Loss (Realized)', type: 'Expense' },        // กำไร/ขาดทุนอัตราแลกเปลี่ยนที่เกิดขึ้นจริง — loss=debit, gain=credit (settlement)
  { code: '2250', name: 'Loyalty Points Liability', type: 'Liability' },      // หนี้สินแต้มสะสม — TFRS 15 contract liability for outstanding loyalty points (control acct)
  { code: '5700', name: 'Loyalty Points Expense', type: 'Expense' },          // ค่าใช้จ่ายแต้มสะสม — provision for loyalty points granted (offsets 2250)
  { code: '5710', name: 'Repairs & Maintenance', type: 'Expense' },           // ค่าซ่อมแซมและบำรุงรักษา — EAM maintenance work-order cost
];

// ───────────────────── Statement of Cash Flows (indirect method) classification ─────────────────────
// Cash & cash-equivalents — the accounts the statement EXPLAINS (movement is the bottom line, not a flow).
const CASH_ACCOUNTS = ['1000', '1010', '1020'];
type CfBucket = 'addback' | 'operating' | 'investing' | 'financing';
// Maps every NON-cash balance-sheet account to a cash-flow section. The indirect method starts operating
// cash from net income, then layers (a) non-cash add-backs and (b) working-capital movements. Every
// balance-sheet account is bucketed exactly once so the statement reconciles to the change in cash by
// double-entry construction (Σ all accounts' debit−credit = 0). Accounts absent here fall back by type.
const CF_CLASSIFY: Record<string, { bucket: CfBucket; label: string }> = {
  // Non-cash add-backs (P&L charge that consumed no cash) — accumulated depreciation (contra-asset, credit-normal).
  '1590': { bucket: 'addback', label: 'ค่าเสื่อมราคาและค่าตัดจำหน่าย (Depreciation & amortization)' },
  // Operating — current assets (an increase ties up cash)
  '1100': { bucket: 'operating', label: 'ลูกหนี้การค้า (Accounts receivable)' },
  '1150': { bucket: 'operating', label: 'ลูกหนี้ระหว่างบริษัท (Intercompany receivable)' },
  '1200': { bucket: 'operating', label: 'สินค้าคงเหลือ (Inventory)' },
  '1210': { bucket: 'operating', label: 'สินค้าสำเร็จรูป (Finished goods)' },
  '1250': { bucket: 'operating', label: 'งานระหว่างทำ (Work-in-process)' },
  '1260': { bucket: 'operating', label: 'ต้นทุนโครงการที่ยังไม่เรียกเก็บ (Unbilled project cost)' },
  // Operating — current liabilities (an increase releases cash)
  '2000': { bucket: 'operating', label: 'เจ้าหนี้การค้า (Accounts payable)' },
  '2100': { bucket: 'operating', label: 'ภาษีค้างจ่าย (Tax payable)' },
  '2150': { bucket: 'operating', label: 'เจ้าหนี้ระหว่างบริษัท (Intercompany payable)' },
  '2200': { bucket: 'operating', label: 'เงินมัดจำลูกค้า/บัตรของขวัญ (Customer deposits)' },
  '2210': { bucket: 'operating', label: 'เงินรับล่วงหน้า (Customer deposits — prepaid)' },
  '2300': { bucket: 'operating', label: 'ทิปค้างจ่าย (Tips payable)' },
  '2350': { bucket: 'operating', label: 'ประกันสังคมค้างจ่าย (Social security payable)' },
  '2360': { bucket: 'operating', label: 'ภาษีหัก ณ ที่จ่ายเงินเดือนค้างจ่าย (Payroll WHT payable)' },
  '2370': { bucket: 'operating', label: 'กองทุนสำรองเลี้ยงชีพค้างจ่าย (Provident fund payable)' },
  '2380': { bucket: 'operating', label: 'ค่าใช้จ่ายการผลิตรอปันส่วน (Manufacturing costs applied)' },
  '2390': { bucket: 'operating', label: 'ต้นทุนโครงการรอปันส่วน (Project costs applied)' },
  '2400': { bucket: 'operating', label: 'รายได้รับล่วงหน้า (Unearned revenue)' },
  // Investing — property, plant & equipment (gross)
  '1500': { bucket: 'investing', label: 'ซื้อ/จำหน่ายสินทรัพย์ถาวร (Purchase/disposal of fixed assets)' },
  // Financing — owners' equity & dividends
  '3000': { bucket: 'financing', label: 'ส่วนทุน/เงินลงทุนจากเจ้าของ (Owner capital contributions)' },
  '3100': { bucket: 'financing', label: 'เงินปันผลจ่าย / กำไรสะสม (Dividends paid)' },
};

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
  ledgerCode?: string | null; // NULL/undefined = shared (all ledgers); a code = adjustment to that ledger only
  allowClosedPeriod?: boolean; // only the year-end CLOSE may post into the period it is closing
  pendingApproval?: boolean; // GL-05: post as DRAFT (excluded from balances) until a different user approves
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

  // ───────────────────── Ledgers (multi-GAAP) ─────────────────────
  // idempotent seed of the parallel ledgers (TFRS leading + TAX + IFRS).
  async seedLedgers() {
    const db = this.db as any;
    await db.insert(ledgers).values(LEDGERS).onConflictDoNothing({ target: ledgers.code });
    return { seeded: LEDGERS.length };
  }

  async listLedgers() {
    const db = this.db as any;
    const rows = await db.select().from(ledgers).orderBy(desc(ledgers.isLeading), ledgers.code);
    return { ledgers: rows.map((l: any) => ({ code: l.code, name: l.name, gaap: l.gaap, is_leading: !!l.isLeading, currency: l.currency, description: l.description, active: l.active })), count: rows.length, leading: LEADING };
  }

  // assert a ledger exists + is a real (non-shared) ledger for adjustment postings
  private async assertLedger(code: string) {
    const db = this.db as any;
    const [l] = await db.select().from(ledgers).where(eq(ledgers.code, code)).limit(1);
    if (!l) throw new NotFoundException({ code: 'LEDGER_NOT_FOUND', message: `Ledger ${code} not found`, messageTh: `ไม่พบสมุดบัญชี ${code}` });
    return l;
  }

  // SQL predicate selecting the rows that belong to ledger `code` = shared (NULL) OR that ledger's own
  // adjustments. Defaults to the LEADING book so existing (all-NULL) data + callers are unchanged.
  private ledgerCond(code?: string | null) {
    const c = code ?? LEADING;
    return sql`(${journalEntries.ledgerCode} IS NULL OR ${journalEntries.ledgerCode} = ${c})`;
  }

  // ───────────────────── Post a balanced entry ─────────────────────
  // BALANCED BY CONSTRUCTION — throw UNBALANCED if Σdebit !== Σcredit (round 4) or empty.
  // `outerTx` lets a caller post this entry INSIDE its own transaction (e.g. a return reversing money +
  // stock + GL atomically). When present, the header/lines insert on that tx and roll back with it;
  // otherwise postEntry owns its own transaction as before.
  async postEntry(dto: PostEntryDto, outerTx?: any) {
    const db = (outerTx ?? this.db) as any;
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

    // An entry belongs to its explicit tenant, else the poster's own tenant (ALS). Avoid NULL-tenant
    // entries in a multi-tenant SaaS — they'd escape both RLS scoping and the per-tenant close calendar.
    const entryTenantId = dto.tenantId ?? currentTenantStore()?.tenantId ?? null;
    const entryDate = dto.date ?? ymd();
    const period = entryDate.slice(0, 7); // 'YYYY-MM'
    // Period guard: a CLOSED fiscal period (this entry's tenant calendar, per 0043) rejects new postings.
    // A missing period row defaults OPEN (existing flows post into the current month without pre-seeding).
    const [pp] = entryTenantId == null
      ? [undefined]
      : await db.select({ status: fiscalPeriods.status }).from(fiscalPeriods)
          .where(and(eq(fiscalPeriods.code, period), eq(fiscalPeriods.tenantId, entryTenantId))).limit(1);
    if (pp && pp.status === 'Closed' && !dto.allowClosedPeriod) {
      // a year-end closing journal legitimately posts INTO the period it closes; everything else is blocked
      throw new BadRequestException({ code: 'PERIOD_CLOSED', message: `Period ${period} is closed`, messageTh: `งวดบัญชี ${period} ถูกปิดแล้ว` });
    }
    const currency = dto.currency ?? 'THB';
    const entryNo = await this.docNo.nextDaily('JE');

    const doInsert = async (tx: any) => {
      // ON CONFLICT DO NOTHING backstops the pre-check (alreadyPosted): if a concurrent caller already
      // posted this (tenant, source, source_ref, ledger), the header insert no-ops and `h` is undefined,
      // so we skip the lines and report a dedupe instead of double-posting the GL. ux_je_idem enforces it.
      const [h] = await tx.insert(journalEntries).values({
        entryNo, entryDate, period, memo: dto.memo ?? null,
        source: dto.source ?? 'Manual', sourceRef: dto.sourceRef ?? null, ledgerCode: dto.ledgerCode ?? null,
        tenantId: entryTenantId, currency, status: dto.pendingApproval ? 'Draft' : 'Posted', createdBy: dto.createdBy,
      }).onConflictDoNothing().returning({ id: journalEntries.id });
      if (!h) return null;
      await tx.insert(journalLines).values(nzLines.map((l) => ({
        entryId: Number(h.id), accountCode: l.account_code,
        debit: fx(l.debit, 4), credit: fx(l.credit, 4),
        currency, memo: l.memo ?? null, costCenterCode: l.cost_center ?? null, tenantId: entryTenantId,
      })));
      return nzLines.map((l) => ({ account_code: l.account_code, debit: n(l.debit), credit: n(l.credit), memo: l.memo ?? null }));
    };
    // Reuse the caller's tx when nested; else open our own.
    const inserted = outerTx ? await doInsert(outerTx) : await (this.db as any).transaction(doInsert);

    // Lost the race to a concurrent identical posting → the entry already exists, do not double-count.
    if (inserted === null) return { entry_no: null, balanced: true, deduped: true, lines: [] };
    const status = dto.pendingApproval ? 'Draft' : 'Posted';
    return { entry_no: entryNo, balanced: true, status, pending: !!dto.pendingApproval, lines: inserted };
  }

  // ───────────────────── Journal listing ─────────────────────
  private async entriesList(limit: number, status?: 'Draft' | 'Posted' | 'Voided') {
    const db = this.db as any;
    const where = status ? eq(journalEntries.status, status) : undefined;
    const heads = await db.select().from(journalEntries).where(where).orderBy(desc(journalEntries.id)).limit(limit);
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
  async listJournal(limit: number) { return this.entriesList(limit); }
  // GL-05: journal entries awaiting maker-checker approval (Draft).
  async pendingJournal(limit: number) { return this.entriesList(limit, 'Draft'); }

  // GL-05 maker-checker: approve a Draft JE → Posted. The approver MUST differ from the preparer
  // (segregation of duties) regardless of permissions held — even an Admin cannot approve their own.
  async approveEntry(entryNo: string, approver: JwtUser) {
    const db = this.db as any;
    const [e] = await db.select().from(journalEntries).where(eq(journalEntries.entryNo, entryNo)).limit(1);
    if (!e) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Journal entry not found', messageTh: 'ไม่พบรายการบัญชี' });
    if (e.status !== 'Draft') throw new BadRequestException({ code: 'NOT_PENDING', message: `Entry ${entryNo} is ${e.status}, not pending approval`, messageTh: 'รายการนี้ไม่ได้รออนุมัติ' });
    if (e.createdBy && e.createdBy === approver.username) {
      throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve a journal entry you prepared', messageTh: 'ผู้บันทึกอนุมัติรายการของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    // Re-check the period is still open at approval time (it may have closed since the draft was prepared).
    const [pp] = e.tenantId == null ? [undefined]
      : await db.select({ status: fiscalPeriods.status }).from(fiscalPeriods).where(and(eq(fiscalPeriods.code, e.period), eq(fiscalPeriods.tenantId, e.tenantId))).limit(1);
    if (pp && pp.status === 'Closed') throw new BadRequestException({ code: 'PERIOD_CLOSED', message: `Period ${e.period} is closed`, messageTh: `งวดบัญชี ${e.period} ถูกปิดแล้ว` });
    await db.update(journalEntries).set({ status: 'Posted' }).where(eq(journalEntries.id, e.id));
    return { entry_no: entryNo, status: 'Posted', approved_by: approver.username, prepared_by: e.createdBy };
  }

  // GL-05: reject a Draft JE → Voided (with a reason appended to the memo).
  async rejectEntry(entryNo: string, approver: JwtUser, reason?: string) {
    const db = this.db as any;
    const [e] = await db.select().from(journalEntries).where(eq(journalEntries.entryNo, entryNo)).limit(1);
    if (!e) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Journal entry not found', messageTh: 'ไม่พบรายการบัญชี' });
    if (e.status !== 'Draft') throw new BadRequestException({ code: 'NOT_PENDING', message: `Entry ${entryNo} is ${e.status}, not pending approval`, messageTh: 'รายการนี้ไม่ได้รออนุมัติ' });
    const memo = `${e.memo ?? ''} [REJECTED by ${approver.username}${reason ? `: ${reason}` : ''}]`.trim();
    await db.update(journalEntries).set({ status: 'Voided', memo }).where(eq(journalEntries.id, e.id));
    return { entry_no: entryNo, status: 'Voided', rejected_by: approver.username };
  }

  // ───────────────────── Trial Balance ─────────────────────
  // group journal_lines by account_code (joined to accounts) — Σdebit, Σcredit, balance
  async trialBalance(period?: string, costCenter?: string | null, ledgerCode?: string | null) {
    const db = this.db as any;
    const conds = [eq(journalEntries.status, 'Posted'), this.ledgerCond(ledgerCode)];
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
    return { period: period ?? null, cost_center: costCenter ?? null, ledger: ledgerCode ?? LEADING, rows: out, totals: { debit: totalDebit, credit: totalCredit, balanced: totalDebit === totalCredit } };
  }

  // ───────────────────── Income Statement ─────────────────────
  // Revenue − Expense = net income, over [from,to] (entry_date inclusive)
  async incomeStatement(from: string, to: string, costCenter?: string | null, ledgerCode?: string | null) {
    const db = this.db as any;
    const rows = await this.aggregateByType(db, from, to, costCenter, ledgerCode);
    const revenue = round4(typeTotal(rows, 'Revenue', 'credit') - typeTotal(rows, 'Revenue', 'debit'));
    const expense = round4(typeTotal(rows, 'Expense', 'debit') - typeTotal(rows, 'Expense', 'credit'));
    const netIncome = round4(revenue - expense);
    return {
      from, to, cost_center: costCenter ?? null, ledger: ledgerCode ?? LEADING,
      revenue, expense, net_income: netIncome,
      lines: rows.filter((r: any) => r.account_type === 'Revenue' || r.account_type === 'Expense'),
    };
  }

  // ───────────────────── Balance Sheet ─────────────────────
  // Assets = Liabilities + Equity + retained net income (as of date, inclusive)
  async balanceSheet(asOf: string, ledgerCode?: string | null) {
    const db = this.db as any;
    const rows = await this.aggregateByType(db, null, asOf, undefined, ledgerCode);
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
      as_of: asOf, ledger: ledgerCode ?? LEADING,
      assets, liabilities, equity, retained_earnings: retainedEarnings, net_income: netIncome,
      liabilities_plus_equity: liabilitiesEquity,
      balanced: assets === liabilitiesEquity,
    };
  }

  // ───────────────────── Statement of Cash Flows (indirect method) ─────────────────────
  // Reconstructs operating cash from net income + non-cash add-backs + working-capital movements, then
  // investing & financing — all off the posted GL over [from,to]. Year-end CLOSE entries are excluded
  // (they reclassify P&L into retained earnings and carry no cash). Reconciles to the change in the cash
  // accounts (1000/1010/1020) by double-entry construction: Σ(every account's debit−credit)=0, so
  // Σ(non-cash credit−debit) ≡ Σ(cash debit−credit) = net change in cash.
  async cashFlowStatement(from: string, to: string, ledgerCode?: string | null) {
    const db = this.db as any;
    const rows = await this.aggregateByType(db, from, to, undefined, ledgerCode, undefined, ['CLOSE']);
    const move = (r: any) => round4(n(r.credit) - n(r.debit)); // cash effect of a balance-sheet account's movement

    // Net income over the window = Σ P&L (credit−debit). Equals the income statement on an unclosed window.
    const netIncome = round4(rows.filter((r: any) => r.account_type === 'Revenue' || r.account_type === 'Expense').reduce((a: number, r: any) => a + move(r), 0));

    const addbacks: any[] = [], operating: any[] = [], investing: any[] = [], financing: any[] = [], unclassified: any[] = [];
    for (const r of rows) {
      const t = r.account_type;
      if (t === 'Revenue' || t === 'Expense') continue;        // already captured in net income
      if (CASH_ACCOUNTS.includes(r.account_code)) continue;    // the cash being explained
      const amount = move(r);
      if (Math.abs(amount) < 1e-9) continue;
      const line = { account_code: r.account_code, account_name: r.account_name, amount };
      const cls = CF_CLASSIFY[r.account_code];
      const bucket = cls?.bucket ?? (t === 'Asset' ? 'operating' : t === 'Liability' ? 'operating' : t === 'Equity' ? 'financing' : 'operating');
      const label = cls?.label ?? r.account_name ?? r.account_code;
      const entry = { ...line, label };
      if (bucket === 'addback') addbacks.push(entry);
      else if (bucket === 'investing') investing.push(entry);
      else if (bucket === 'financing') financing.push(entry);
      else operating.push(entry);
      if (!cls) unclassified.push(r.account_code); // surfaced for transparency (still bucketed by type)
    }

    const sum = (xs: any[]) => round4(xs.reduce((a, x) => a + x.amount, 0));
    const netOperating = round4(netIncome + sum(addbacks) + sum(operating));
    const netInvesting = sum(investing);
    const netFinancing = sum(financing);
    const netChange = round4(netOperating + netInvesting + netFinancing);

    // Actual cash balances bracketing the window (full books incl. opening/close — CLOSE never hits cash).
    const cashBeginning = await this.cashBalanceAsOf(prevDay(from), ledgerCode);
    const cashEnding = await this.cashBalanceAsOf(to, ledgerCode);

    return {
      from, to, ledger: ledgerCode ?? LEADING, method: 'indirect',
      operating: { net_income: netIncome, adjustments: addbacks, working_capital: operating, net: netOperating },
      investing: { lines: investing, net: netInvesting },
      financing: { lines: financing, net: netFinancing },
      net_change_in_cash: netChange,
      cash_beginning: cashBeginning,
      cash_ending: cashEnding,
      // Independent tie-out: the activity sections must equal the movement in the cash accounts.
      reconciled: Math.abs(round4(cashEnding - cashBeginning) - netChange) < 0.01,
      unclassified_accounts: [...new Set(unclassified)],
    };
  }

  // Net debit balance of the cash accounts (1000/1010/1020) as of a date, in one ledger.
  private async cashBalanceAsOf(asOf: string, ledgerCode?: string | null): Promise<number> {
    const db = this.db as any;
    const rows = await this.aggregateByType(db, null, asOf, undefined, ledgerCode);
    return round4(rows.filter((r: any) => CASH_ACCOUNTS.includes(r.account_code)).reduce((a: number, r: any) => a + (n(r.debit) - n(r.credit)), 0));
  }

  // ───────────────────── GAAP adjustment posting ─────────────────────
  // Post a balanced entry to ONE ledger only (e.g. a tax-depreciation delta, an IFRS lease adjustment).
  // The shared books are untouched; only this ledger's reports pick it up.
  async postAdjustment(ledgerCode: string, dto: Omit<PostEntryDto, 'ledgerCode'>) {
    await this.assertLedger(ledgerCode);
    return this.postEntry({ ...dto, ledgerCode, source: dto.source ?? 'GAAP-ADJ' });
  }

  // ───────────────────── Book-tax difference (ผลต่างทางบัญชี-ภาษี) ─────────────────────
  // Compares two ledgers' P&L over a window — the temporary/permanent differences that feed deferred tax
  // (TAS 12) and the ภ.ง.ด.50 reconciliation. Since shared entries are identical in both books, the
  // difference comes entirely from each ledger's own adjustments.
  async gaapComparison(from: string, to: string, base = LEADING, compare = 'TAX') {
    await this.assertLedger(base);
    await this.assertLedger(compare);
    const b = await this.incomeStatement(from, to, undefined, base);
    const c = await this.incomeStatement(from, to, undefined, compare);
    const pnl = (l: any) => l.account_type === 'Revenue' ? round4(n(l.credit) - n(l.debit)) : round4(n(l.debit) - n(l.credit)); // revenue +, expense as cost +
    const map = new Map<string, any>();
    for (const l of b.lines) map.set(l.account_code, { account_code: l.account_code, account_name: l.account_name, account_type: l.account_type, base: pnl(l), compare: 0 });
    for (const l of c.lines) {
      const e = map.get(l.account_code) ?? { account_code: l.account_code, account_name: l.account_name, account_type: l.account_type, base: 0, compare: 0 };
      e.compare = pnl(l); map.set(l.account_code, e);
    }
    const lines = [...map.values()]
      .map((e) => ({ ...e, difference: round4(e.compare - e.base) }))
      .filter((e) => Math.abs(e.difference) > 1e-9)
      .sort((a, b2) => a.account_code.localeCompare(b2.account_code));
    return {
      from, to, base_ledger: base, compare_ledger: compare,
      base_net_income: b.net_income, compare_net_income: c.net_income,
      difference: round4(c.net_income - b.net_income),
      lines,
    };
  }

  // ───────────────────── Idempotency + Fiscal periods ─────────────────────
  // has a GL entry already been posted for this source+ref? (used by AR/AP hooks + closeYear)
  // tenantId scopes the check so two tenants can share a ref (e.g. 'FY2026') without colliding.
  async alreadyPosted(source: string, sourceRef: string, tenantId?: number | null, outerTx?: any): Promise<boolean> {
    const db = (outerTx ?? this.db) as any;
    const conds = [eq(journalEntries.source, source), eq(journalEntries.sourceRef, sourceRef)];
    if (tenantId !== undefined && tenantId !== null) conds.push(eq(journalEntries.tenantId, tenantId));
    const [r] = await db.select({ id: journalEntries.id }).from(journalEntries).where(and(...conds)).limit(1);
    return !!r;
  }

  private periodBounds(period: string) {
    const [y, m] = period.split('-').map(Number);
    const start = `${period}-01`;
    const endDate = m < 12 ? `${y}-${String(m + 1).padStart(2, '0')}-01` : `${y}-12-31`;
    return { start, endDate };
  }

  // All period ops are per-tenant (0043). tenantId defaults to the request's own tenant (ALS),
  // so the existing controller endpoints scope correctly with no signature change.
  async ensurePeriod(period: string, tenantId?: number | null) {
    const db = this.db as any;
    const tid = resolveTenantId(tenantId);
    const { start, endDate } = this.periodBounds(period);
    await db.insert(fiscalPeriods).values({ code: period, startDate: start, endDate, status: 'Open', tenantId: tid })
      .onConflictDoNothing({ target: [fiscalPeriods.tenantId, fiscalPeriods.code] });
  }

  async listPeriods(tenantId?: number | null) {
    const db = this.db as any;
    const tid = resolveTenantId(tenantId);
    const rows = await db.select().from(fiscalPeriods)
      .where(tid == null ? undefined : eq(fiscalPeriods.tenantId, tid))
      .orderBy(fiscalPeriods.code);
    return { periods: rows.map((p: any) => ({ code: p.code, status: p.status, start_date: p.startDate, end_date: p.endDate })), count: rows.length };
  }

  async setPeriodStatus(period: string, status: 'Open' | 'Closed', tenantId?: number | null) {
    const db = this.db as any;
    const tid = resolveTenantId(tenantId);
    await this.ensurePeriod(period, tid);
    await db.update(fiscalPeriods).set({ status })
      .where(tid == null ? eq(fiscalPeriods.code, period) : and(eq(fiscalPeriods.code, period), eq(fiscalPeriods.tenantId, tid)));
    return { period, status };
  }
  // Last calendar day of a 'YYYY-MM' period (period close dates the loyalty accrual inside the period).
  private periodEndDate(period: string): string {
    const [y, m] = period.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month = last day of this month
    return `${period}-${String(last).padStart(2, '0')}`;
  }

  // ── Loyalty points-liability accrual (TFRS 15) ─────────────────────────────
  // Reconciles GL control account 2250 to outstanding points × fair value by posting the delta since the
  // last run (provision model: net grant ⇒ Dr 5700 / Cr 2250; net redeem/forfeit/expiry ⇒ Dr 2250 / Cr 5700).
  // Watermarked on pos_member_ledger.id + idempotent (deterministic sourceRef + ux_je_idem + unique run).
  // Lives here (not in the loyalty module) so the GL period-close can call it without a module cycle; it
  // reads the loyalty sub-ledger tables directly and posts via this.postEntry.
  async accrueLiability(ctx: { tenantId: number; createdBy: string; asOfDate?: string }) {
    const db = this.db as any;
    const tenantId = ctx.tenantId;
    const [cfg] = await db.select().from(loyaltyConfig).limit(1);
    const fairValue = cfg ? n(cfg.bahtPerPoint) : 0;
    return await db.transaction(async (tx: any) => {
      const [last] = await tx.select({
        wm: sql`coalesce(max(${loyaltyPostingRuns.watermarkId}), 0)`,
        posted: sql`coalesce(sum(${loyaltyPostingRuns.liabilityDelta}), 0)`,
      }).from(loyaltyPostingRuns).where(eq(loyaltyPostingRuns.tenantId, tenantId));
      const lastWm = Number(last?.wm ?? 0);
      const priorLiability = round2(n(last?.posted));
      const [hi] = await tx.select({ hi: sql`coalesce(max(${posMemberLedger.id}), 0)` }).from(posMemberLedger).where(eq(posMemberLedger.tenantId, tenantId));
      const newHigh = Number(hi?.hi ?? 0);
      const [agg] = await tx.select({ pts: sql`coalesce(sum(${posMembers.balance}), 0)` }).from(posMembers).where(eq(posMembers.tenantId, tenantId));
      const outstanding = n(agg?.pts);
      const target = round2(outstanding * fairValue);
      if (newHigh <= lastWm) {
        return { posted: false, reason: 'up_to_date', watermark: lastWm, outstanding_points: outstanding, fair_value_per_point: fairValue, target_liability: target, posted_liability: priorLiability, liability_delta: 0 };
      }
      const [stat] = await tx.select({
        earn: sql`coalesce(sum(case when ${posMemberLedger.points} > 0 then ${posMemberLedger.points} else 0 end), 0)`,
        redeem: sql`coalesce(sum(case when ${posMemberLedger.points} < 0 then -${posMemberLedger.points} else 0 end), 0)`,
      }).from(posMemberLedger).where(and(eq(posMemberLedger.tenantId, tenantId), gt(posMemberLedger.id, lastWm), lte(posMemberLedger.id, newHigh)));
      const delta = round2(target - priorLiability);
      let journalNo: string | null = null;
      if (Math.abs(delta) >= 0.005) {
        const lines = delta > 0
          ? [{ account_code: '5700', debit: delta }, { account_code: '2250', credit: delta }]
          : [{ account_code: '2250', debit: -delta }, { account_code: '5700', credit: -delta }];
        const je: any = await this.postEntry({
          ...(ctx.asOfDate ? { date: ctx.asOfDate } : {}),
          source: 'LOYALTY', sourceRef: `${tenantId}:upto-${newHigh}`, tenantId,
          memo: `Loyalty points liability accrual (tenant ${tenantId})`, createdBy: ctx.createdBy, lines,
        }, tx);
        journalNo = je?.entry_no ?? null;
        if (journalNo == null) {
          return { posted: false, reason: 'deduped', watermark: newHigh, outstanding_points: outstanding, fair_value_per_point: fairValue, target_liability: target, posted_liability: priorLiability, liability_delta: 0 };
        }
      }
      await tx.insert(loyaltyPostingRuns).values({
        tenantId, runNo: `LOY-${tenantId}-${newHigh}`, watermarkId: newHigh,
        outstandingPoints: String(outstanding), fairValuePerPoint: String(fairValue), targetLiability: String(target),
        priorLiability: String(priorLiability), liabilityDelta: String(delta),
        earnedPoints: String(n(stat?.earn)), redeemedPoints: String(n(stat?.redeem)), journalNo, createdBy: ctx.createdBy,
      }).onConflictDoNothing();
      return {
        posted: journalNo != null, reason: journalNo != null ? 'posted' : 'no_change', journal_no: journalNo,
        watermark: newHigh, outstanding_points: outstanding, fair_value_per_point: fairValue,
        target_liability: target, posted_liability: round2(priorLiability + delta), liability_delta: delta,
      };
    });
  }

  // Close a period. Before locking it, accrue the loyalty points liability to date (dated inside the period)
  // so the period's books carry the up-to-date liability — best-effort: a loyalty hiccup must not block the
  // financial close. `accrue:false` is passed by closeYear, which runs the accrual once before its P&L sweep.
  async closePeriod(period: string, tenantId?: number | null, opts?: { accrue?: boolean }) {
    const tid = resolveTenantId(tenantId);
    let loyaltyAccrual: any = null;
    if (opts?.accrue !== false && tid != null) {
      try { loyaltyAccrual = await this.accrueLiability({ tenantId: tid, createdBy: 'system:period-close', asOfDate: this.periodEndDate(period) }); }
      catch (e: any) { loyaltyAccrual = { posted: false, reason: 'error', error: String(e?.message ?? e) }; }
    }
    const res = await this.setPeriodStatus(period, 'Closed', tid);
    return { ...res, loyalty_accrual: loyaltyAccrual };
  }
  async openPeriod(period: string, tenantId?: number | null) { return this.setPeriodStatus(period, 'Open', tenantId); }

  // Provision all 12 (Open) periods of a fiscal year for a tenant — called at signup so a new tenant
  // can post immediately into the current year. Idempotent.
  async provisionFiscalYear(year: number, tenantId: number) {
    for (let m = 1; m <= 12; m++) await this.ensurePeriod(`${year}-${String(m).padStart(2, '0')}`, tenantId);
    return { year, tenant_id: tenantId, provisioned: 12 };
  }

  // Opening balances → ONE balanced journal entry for the tenant (cutover from a prior system).
  // rows: {account_code, debit?, credit?}. Any net imbalance posts to 3000 (Opening Balance Equity).
  // Idempotent on (tenant, OPENING, batchRef). Invalid rows are reported, not silently dropped.
  async postOpeningBalances(rows: { account_code: string; debit?: number; credit?: number }[], batchRef: string | undefined, createdBy: string, tenantId?: number | null) {
    const tid = resolveTenantId(tenantId);
    const ref = (batchRef?.trim()) || `OPENING-${ymd().slice(0, 7)}`;
    if (await this.alreadyPosted('OPENING', ref, tid)) return { already: true, batch_ref: ref };

    const lines: JournalLineDto[] = [];
    const rowErrors: { row: number; error: string }[] = [];
    let netDebit = 0;
    rows.forEach((r, i) => {
      const acct = String(r.account_code ?? '').trim();
      const d = n(r.debit), c = n(r.credit);
      if (!acct) { rowErrors.push({ row: i + 1, error: 'account_code required' }); return; }
      if (d === 0 && c === 0) { rowErrors.push({ row: i + 1, error: 'debit or credit required' }); return; }
      lines.push({ account_code: acct, debit: d || undefined, credit: c || undefined });
      netDebit += d - c;
    });
    if (!lines.length) throw new BadRequestException({ code: 'NO_VALID_ROWS', message: 'No valid opening-balance rows', messageTh: 'ไม่มีรายการยอดยกมาที่ถูกต้อง' });

    const bal = round4(netDebit); // balance against 3000 Equity (Opening Balance Equity)
    if (bal > 0) lines.push({ account_code: '3000', credit: bal });
    else if (bal < 0) lines.push({ account_code: '3000', debit: -bal });

    const je = await this.postEntry({ date: ymd(), source: 'OPENING', sourceRef: ref, tenantId: tid, memo: `Opening balances ${ref}`, createdBy, lines });
    return { batch_ref: ref, entry_no: je.entry_no, balanced: true, lines_posted: lines.length, row_errors: rowErrors };
  }

  // Year-end close: post a closing journal zeroing Revenue & Expense into 3100 Retained Earnings,
  // then close all 12 months. Idempotent (skips if FY already closed).
  async closeYear(fiscalYear: number, createdBy: string, ledgerCode: string = LEADING, tenantId?: number | null) {
    const db = this.db as any;
    const tid = resolveTenantId(tenantId);
    // per-ledger idempotency: the leading book keeps the legacy 'FY{y}' ref; non-leading books are suffixed.
    // Scoped to THIS tenant so each tenant closes its own FY independently (shared 'FY2026' ref is fine).
    const closeRef = ledgerCode === LEADING ? `FY${fiscalYear}` : `FY${fiscalYear}-${ledgerCode}`;
    if (await this.alreadyPosted('CLOSE', closeRef, tid)) {
      return { closed: true, fiscal_year: fiscalYear, ledger: ledgerCode, already: true };
    }
    const from = `${fiscalYear}-01-01`, to = `${fiscalYear}-12-31`;
    // Accrue the loyalty points liability up to year-end BEFORE the P&L sweep, so the 5700 expense it books
    // is zeroed into Retained Earnings by this close (the 2250 liability stays on the balance sheet). Once,
    // on the leading book only; best-effort so a loyalty hiccup never blocks the year-end close.
    if (ledgerCode === LEADING && tid != null) {
      try { await this.accrueLiability({ tenantId: tid, createdBy, asOfDate: to }); } catch { /* best-effort */ }
    }
    const rows = await this.aggregateByType(db, from, to, undefined, ledgerCode, tid);
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
    if (!lines.length) return { closed: true, fiscal_year: fiscalYear, ledger: ledgerCode, net_income: 0, entry_no: null, note: 'no P&L activity' };

    await this.ensurePeriod(`${fiscalYear}-12`, tid);
    // tag the closing entry to its ledger + tenant so it zeroes only that book's P&L (each GAAP has its own result).
    const je = await this.postEntry({ date: to, source: 'CLOSE', sourceRef: closeRef, ledgerCode, tenantId: tid, allowClosedPeriod: true, memo: `Year-end close FY${fiscalYear} (${ledgerCode})`, createdBy, lines });
    // the tenant's fiscal calendar has no ledger dimension — only the LEADING close locks the months,
    // so non-leading ledgers can still post their own closing entry into December.
    if (ledgerCode === LEADING) for (let m = 1; m <= 12; m++) await this.closePeriod(`${fiscalYear}-${String(m).padStart(2, '0')}`, tid, { accrue: false });
    return { closed: true, fiscal_year: fiscalYear, ledger: ledgerCode, net_income: netIncome, entry_no: je.entry_no };
  }

  // group Posted journal_lines by account type within optional date window.
  // excludeSources drops whole entries by source (e.g. CLOSE) — used by the cash-flow statement so a
  // year-end closing reclassification doesn't masquerade as P&L/working-capital movement.
  private async aggregateByType(db: any, from: string | null, to: string, costCenter?: string | null, ledgerCode?: string | null, tenantId?: number | null, excludeSources?: string[]) {
    const conds = [eq(journalEntries.status, 'Posted'), sql`${journalEntries.entryDate} <= ${to}`, this.ledgerCond(ledgerCode)];
    if (from) conds.push(sql`${journalEntries.entryDate} >= ${from}`);
    // Explicit tenant scope for writes like closeYear (which may run under HQ/bypass where RLS won't narrow).
    if (tenantId !== undefined && tenantId !== null) conds.push(eq(journalEntries.tenantId, tenantId));
    if (excludeSources && excludeSources.length) conds.push(notInArray(journalEntries.source, excludeSources));
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
// Calendar day before an ISO date (YYYY-MM-DD) — the day the opening cash balance is struck.
function prevDay(ymdStr: string): string {
  const d = new Date(`${ymdStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function typeTotal(rows: any[], type: string, side: 'debit' | 'credit'): number {
  return rows.filter((r) => r.account_type === type).reduce((a, r) => a + n(r[side]), 0);
}
