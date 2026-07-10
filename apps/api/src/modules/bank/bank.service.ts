import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, desc, asc, isNotNull, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { bankAccounts, bankStatements, bankStatementLines, journalLines, journalEntries, accounts, cashMovements, bankDeposits, apPaymentRuns, apPaymentRunLines } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import { n, fx } from '../../database/queries';
import { roundCurrency } from '../tax/money';
import type { JwtUser } from '../../common/decorators';
import type { CreateBankAccountDto, ImportStatementDto, AdjustmentDto, ImportStatementFileDto } from './dto';
import { normalizeStatementRows, StatementParseError } from './statement-file';
import { parseCsv, parseXlsx } from '../masterdata/masterdata.service';

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;
const days = (a: any, b: any) => Math.abs((new Date(String(a)).getTime() - new Date(String(b)).getTime()) / 86400000);
const TOLERANCE_DAYS = 5;

@Injectable()
export class BankService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly ledger: LedgerService,
  ) {}

  // ── REC-05: cash banking — batch till safe-drops into a bank deposit + reconcile ──

  // Till 'drop's not yet banked = cash still in the safe (deposit_id NULL). The detective exposure.
  async undepositedDrops(user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(cashMovements)
      .where(and(eq(cashMovements.tenantId, user.tenantId as number), sql`${cashMovements.type}::text = 'drop'`, sql`${cashMovements.depositId} is null`))
      .orderBy(asc(cashMovements.createdAt));
    const total = roundCurrency(rows.reduce((a: number, r: any) => a + n(r.amount), 0), 'THB');
    return { drops: rows.map((r: any) => ({ movement_no: r.movementNo, amount: n(r.amount), reason: r.reason, created_at: r.createdAt })), count: rows.length, total };
  }

  // Bank the safe cash: batch the unbanked drops (all, or a chosen set) into a deposit and post the GL
  // (Dr <bank account GL> / Cr 1000 Cash). SoD: banking is exec/ar — segregated from the cashier (pos_till).
  async createDeposit(dto: { bank_account_id: number; movement_nos?: string[]; deposit_date?: string }, user: JwtUser) {
    const db = this.db;
    const [bank] = await db.select().from(bankAccounts).where(and(eq(bankAccounts.id, dto.bank_account_id), eq(bankAccounts.tenantId, user.tenantId as number))).limit(1);
    if (!bank) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Bank account not found', messageTh: 'ไม่พบบัญชีธนาคาร' });
    // G9: a bank account still pending maker-checker approval cannot receive cash (it defines the GL mapping).
    if (bank.status !== 'Approved') throw new BadRequestException({ code: 'BANK_NOT_APPROVED', message: 'Bank account is pending approval and cannot be used yet', messageTh: 'บัญชีธนาคารรออนุมัติ ยังใช้งานไม่ได้' });
    const conds = [eq(cashMovements.tenantId, user.tenantId as number), sql`${cashMovements.type}::text = 'drop'`, sql`${cashMovements.depositId} is null`];
    const drops = await db.select().from(cashMovements).where(and(...conds));
    const chosen = dto.movement_nos?.length ? drops.filter((d: any) => dto.movement_nos!.includes(d.movementNo)) : drops;
    if (!chosen.length) throw new BadRequestException({ code: 'NO_DROPS', message: 'No undeposited cash drops to bank', messageTh: 'ไม่มีเงินสดฝากเซฟที่ยังไม่ได้นำฝากธนาคาร' });
    const amount = roundCurrency(chosen.reduce((a: number, d: any) => a + n(d.amount), 0), 'THB');
    const depositNo = await this.docNo.nextDaily('BDEP');

    return await db.transaction(async (tx: any) => {
      const je: any = await this.ledger.postEntry({ source: 'BDEP', sourceRef: depositNo, tenantId: user.tenantId ?? null, memo: `Bank deposit ${depositNo} → ${bank.bankName} ${bank.accountNo}`, createdBy: user.username, lines: [{ account_code: bank.glAccountCode, debit: amount }, { account_code: '1000', credit: amount }] }, tx);
      const [dep] = await tx.insert(bankDeposits).values({ tenantId: user.tenantId, depositNo, bankAccountId: dto.bank_account_id, amount: fx(amount, 4), status: 'Deposited', depositDate: dto.deposit_date ?? null, journalNo: je?.entry_no ?? null, createdBy: user.username }).returning({ id: bankDeposits.id });
      // Bind the chosen movement numbers as parameters (inArray) — never interpolate user-supplied
      // strings into a raw SQL ARRAY literal (was a SQLi sink: a crafted movementNo could break out).
      await tx.update(cashMovements).set({ depositId: Number(dep.id) }).where(and(eq(cashMovements.tenantId, user.tenantId as number), inArray(cashMovements.movementNo, chosen.map((c: any) => c.movementNo))));
      return { deposit_no: depositNo, bank: `${bank.bankName} ${bank.accountNo}`, amount, drops_banked: chosen.length, journal_no: je?.entry_no ?? null, status: 'Deposited' };
    });
  }

  // Mark a deposit reconciled to the bank statement (it appeared as a credit on the statement).
  async reconcileDeposit(depositId: number, user: JwtUser) {
    const db = this.db;
    const [dep] = await db.select().from(bankDeposits).where(and(eq(bankDeposits.id, depositId), eq(bankDeposits.tenantId, user.tenantId as number))).limit(1);
    if (!dep) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Deposit not found', messageTh: 'ไม่พบรายการนำฝาก' });
    if (String(dep.status) === 'Reconciled') throw new BadRequestException({ code: 'ALREADY_RECONCILED', message: 'Deposit already reconciled', messageTh: 'รายการนี้กระทบยอดแล้ว' });
    await db.update(bankDeposits).set({ status: 'Reconciled', reconciledBy: user.username, reconciledAt: new Date() }).where(eq(bankDeposits.id, depositId));
    return { deposit_no: dep.depositNo, status: 'Reconciled', reconciled_by: user.username };
  }

  async listDeposits(user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(bankDeposits).where(eq(bankDeposits.tenantId, user.tenantId as number)).orderBy(desc(bankDeposits.createdAt)).limit(300);
    const undep = await this.undepositedDrops(user);
    return {
      deposits: rows.map((r: any) => ({ id: Number(r.id), deposit_no: r.depositNo, bank_account_id: Number(r.bankAccountId), amount: n(r.amount), status: r.status, deposit_date: r.depositDate, journal_no: r.journalNo, created_by: r.createdBy, created_at: r.createdAt })),
      count: rows.length,
      unreconciled: rows.filter((r: any) => r.status !== 'Reconciled').length,
      cash_in_safe: undep.total, undeposited_drops: undep.count,
    };
  }

  // G9 (maker-checker): create the bank account 'PendingApproval' + inactive. It defines the account no,
  // the GL mapping deposits reconcile to, and the opening balance — a rogue mapping can misdirect cash — so
  // it must not be usable until a DISTINCT approver activates it (see approveBankAccount / createDeposit gate).
  async createBankAccount(dto: CreateBankAccountDto, user: JwtUser) {
    const db = this.db;
    const [acc] = await db.select({ code: accounts.code }).from(accounts).where(eq(accounts.code, dto.gl_account_code)).limit(1);
    if (!acc) throw new BadRequestException({ code: 'BAD_GL_ACCOUNT', message: `GL account ${dto.gl_account_code} not found`, messageTh: 'ไม่พบรหัสบัญชี GL' });
    const [b] = await db.insert(bankAccounts).values({ tenantId: user.tenantId ?? null, bankName: dto.bank_name, accountNo: dto.account_no, glAccountCode: dto.gl_account_code, currency: dto.currency, openingBalance: fx(dto.opening_balance, 4), active: 'false', status: 'PendingApproval', requestedBy: user.username, createdBy: user.username }).onConflictDoNothing().returning();
    if (!b) throw new BadRequestException({ code: 'BANK_EXISTS', message: 'Bank account already exists', messageTh: 'มีบัญชีธนาคารนี้แล้ว' });
    return { ...shapeAcct(b), status: 'PendingApproval', pending: true, requested_by: user.username };
  }

  // Checker queue — bank accounts awaiting activation.
  async listPendingBankAccounts(user: JwtUser) {
    const db = this.db;
    const conds = [eq(bankAccounts.status, 'PendingApproval')];
    if (user.tenantId != null) conds.push(eq(bankAccounts.tenantId, user.tenantId));
    const rows = await db.select().from(bankAccounts).where(and(...conds)).orderBy(asc(bankAccounts.id));
    return { pending: rows.map((b: any) => ({ ...shapeAcct(b), requested_by: b.requestedBy })), count: rows.length };
  }

  // Approve a pending bank account (checker; approver ≠ requester → 403 SOD_VIOLATION). Activates it for use.
  async approveBankAccount(id: number, user: JwtUser) {
    const db = this.db;
    const conds = [eq(bankAccounts.id, id)];
    if (user.tenantId != null) conds.push(eq(bankAccounts.tenantId, user.tenantId));
    const [b] = await db.select().from(bankAccounts).where(and(...conds)).limit(1);
    if (!b || b.status !== 'PendingApproval') throw new NotFoundException({ code: 'NO_PENDING_BANK_ACCOUNT', message: 'No bank account pending approval', messageTh: 'ไม่พบบัญชีธนาคารที่รออนุมัติ' });
    if (b.requestedBy && b.requestedBy === user.username) throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'The requester cannot approve their own bank account', messageTh: 'ผู้ขอไม่สามารถอนุมัติบัญชีธนาคารของตนเองได้' });
    const [u] = await db.update(bankAccounts).set({ status: 'Approved', active: 'true', approvedBy: user.username, approvedAt: new Date() }).where(eq(bankAccounts.id, id)).returning();
    return { ...shapeAcct(u), status: 'Approved', approved_by: user.username, requested_by: b.requestedBy };
  }

  // Reject a pending bank account (checker) — discards it.
  async rejectBankAccount(id: number, user: JwtUser) {
    const db = this.db;
    const conds = [eq(bankAccounts.id, id)];
    if (user.tenantId != null) conds.push(eq(bankAccounts.tenantId, user.tenantId));
    const [b] = await db.select().from(bankAccounts).where(and(...conds)).limit(1);
    if (!b || b.status !== 'PendingApproval') throw new NotFoundException({ code: 'NO_PENDING_BANK_ACCOUNT', message: 'No bank account pending approval', messageTh: 'ไม่พบบัญชีธนาคารที่รออนุมัติ' });
    await db.update(bankAccounts).set({ status: 'Rejected', active: 'false' }).where(eq(bankAccounts.id, id));
    return { id, status: 'Rejected', rejected_by: user.username };
  }

  async listBankAccounts(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(bankAccounts).orderBy(asc(bankAccounts.id));
    return { accounts: rows.map((b: any) => ({ ...shapeAcct(b), status: b.status })), count: rows.length };
  }

  async importStatement(bankAccountId: number, dto: ImportStatementDto, user: JwtUser) {
    const db = this.db;
    const acct = await this.loadAccount(bankAccountId);
    const statementNo = await this.docNo.nextDaily('BANKSTMT');
    const [h] = await db.insert(bankStatements).values({ tenantId: acct.tenantId ?? null, statementNo, bankAccountId, statementDate: dto.statement_date, openingBal: fx(dto.opening_bal, 4), closingBal: fx(dto.closing_bal, 4), lineCount: dto.lines.length, createdBy: user.username }).returning({ id: bankStatements.id });
    await db.insert(bankStatementLines).values(dto.lines.map((l) => ({ tenantId: acct.tenantId ?? null, statementId: Number(h!.id), bankAccountId, lineDate: l.date, description: l.description ?? null, amount: fx(l.amount, 4), runningBalance: l.balance != null ? fx(l.balance, 4) : null, reconciled: 'false' })));
    return { statement_no: statementNo, line_count: dto.lines.length, opening_bal: n(dto.opening_bal), closing_bal: n(dto.closing_bal) };
  }

  // File-based statement import: parse the bank's own CSV/XLSX export (KBank/SCB/BBL Thai or English
  // headers — see statement-file.ts) into the SAME importStatement pipeline, optionally auto-matching
  // immediately. A parse problem is a 400 with the header list — never a silent partial import.
  async importStatementFile(bankAccountId: number, dto: ImportStatementFileDto, user: JwtUser) {
    let rows: Record<string, string>[];
    try {
      rows = dto.xlsx ? await parseXlsx(Buffer.from(dto.xlsx, 'base64')) : parseCsv(dto.csv ?? '');
    } catch {
      throw new BadRequestException({ code: 'BAD_FILE', message: 'The file could not be parsed as CSV/XLSX', messageTh: 'อ่านไฟล์ไม่ได้ (ต้องเป็น CSV หรือ XLSX)' });
    }
    let norm;
    try {
      norm = normalizeStatementRows(rows, { opening_bal: dto.opening_bal, closing_bal: dto.closing_bal, statement_date: dto.statement_date });
    } catch (e) {
      if (e instanceof StatementParseError) throw new BadRequestException({ code: e.code, message: e.message, messageTh: e.messageTh });
      throw e;
    }
    const imported = await this.importStatement(bankAccountId, norm, user);
    const match = dto.auto_match ? await this.autoMatch(bankAccountId, user) : null;
    return { ...imported, skipped_rows: norm.skipped, detected_columns: norm.detected, auto_match: match ? { matched: match.matched, unmatched_statement: match.unmatched_statement.length, unmatched_book: match.unmatched_book.length } : null };
  }

  // auto-match unreconciled statement lines to unreconciled GL cash movements on the bank's gl account
  async autoMatch(bankAccountId: number, user: JwtUser) {
    const db = this.db;
    const acct = await this.loadAccount(bankAccountId);
    const bankGl = acct.glAccountCode;
    // Scope book lines to THIS account's tenant — the bank GL (e.g. 1010) is shared across tenants, so an
    // Admin caller (RLS-bypass) would otherwise match/aggregate another tenant's cash movements. (null
    // tenant = an HQ-level account → no scope predicate, by the HQ-sees-all model.)
    const tenantPred = acct.tenantId != null ? [eq(journalEntries.tenantId, acct.tenantId)] : [];
    const bookLines = await db.select({ id: journalLines.id, debit: journalLines.debit, credit: journalLines.credit, entryDate: journalEntries.entryDate, source: journalEntries.source, sourceRef: journalEntries.sourceRef })
      .from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(eq(journalLines.accountCode, bankGl), eq(journalEntries.status, 'Posted'), ...tenantPred));
    const matchedRows = await db.select({ jl: bankStatementLines.matchedJournalLineId }).from(bankStatementLines).where(and(eq(bankStatementLines.bankAccountId, bankAccountId), isNotNull(bankStatementLines.matchedJournalLineId)));
    const usedJl = new Set<number>(matchedRows.map((r: any) => Number(r.jl)));
    const stmtLines = await db.select().from(bankStatementLines).where(and(eq(bankStatementLines.bankAccountId, bankAccountId), eq(bankStatementLines.reconciled, 'false'))).orderBy(asc(bankStatementLines.lineDate));
    let matched = 0;
    const clearedGlRefs: string[] = []; // EXP-13 — PAY-AP journal lines matched to the statement clear their run lines
    const unmatchedStmt: typeof stmtLines = [];
    for (const sl of stmtLines) {
      const target = round4(n(sl.amount));
      const cand = bookLines.find((b: any) => !usedJl.has(Number(b.id)) && Math.abs(round4(n(b.debit) - n(b.credit)) - target) < 0.01 && days(b.entryDate, sl.lineDate) <= TOLERANCE_DAYS);
      if (cand) {
        usedJl.add(Number(cand.id));
        const payNo = (cand.source === 'Payment' || cand.source === 'POS') ? cand.sourceRef : null;
        await db.update(bankStatementLines).set({ reconciled: 'true', matchedJournalLineId: Number(cand.id), matchedPaymentNo: payNo }).where(eq(bankStatementLines.id, sl.id));
        matched++;
        if (cand.source === 'PAY-AP' && cand.sourceRef) clearedGlRefs.push(String(cand.sourceRef));
      } else {
        unmatchedStmt.push(sl);
      }
    }
    // ── EXP-13 clearing — mark executed payment-run lines confirmed by the bank statement ──
    // (1) Line-level: a statement line matched to a PAY-AP journal (sourceRef = the payment's gl_ref).
    let runLinesCleared = 0;
    if (clearedGlRefs.length) {
      const rows = await db.update(apPaymentRunLines).set({ cleared: true, clearedAt: new Date() })
        .where(and(inArray(apPaymentRunLines.glRef, clearedGlRefs), eq(apPaymentRunLines.cleared, false)))
        .returning({ id: apPaymentRunLines.id });
      runLinesCleared += rows.length;
    }
    // (2) Run-total level: banks often debit one BULK amount for the whole transfer file. A still-unmatched
    // statement line whose |amount| equals an EXECUTED run's net total (this bank account) clears every
    // Paid line of that run and reconciles the statement line against the run number.
    if (unmatchedStmt.length) {
      const conds = [eq(apPaymentRuns.bankAccountId, bankAccountId), eq(apPaymentRuns.status, 'Executed')];
      if (acct.tenantId != null) conds.push(eq(apPaymentRuns.tenantId, acct.tenantId));
      const runs = await db.select().from(apPaymentRuns).where(and(...conds)).orderBy(desc(apPaymentRuns.id)).limit(100);
      const usedRuns = new Set<number>();
      for (const sl of unmatchedStmt) {
        const target = round4(Math.abs(n(sl.amount)));
        const run = runs.find((r: any) => !usedRuns.has(Number(r.id)) && Math.abs(round4(n(r.totalNet)) - target) < 0.01 && (!r.executedAt || days(r.executedAt, sl.lineDate) <= TOLERANCE_DAYS));
        if (!run) continue;
        const rows = await db.update(apPaymentRunLines).set({ cleared: true, clearedAt: new Date() })
          .where(and(eq(apPaymentRunLines.runId, Number(run.id)), eq(apPaymentRunLines.status, 'Paid'), eq(apPaymentRunLines.cleared, false)))
          .returning({ id: apPaymentRunLines.id });
        if (!rows.length) continue; // fully cleared already — leave the statement line for another candidate
        usedRuns.add(Number(run.id));
        runLinesCleared += rows.length;
        await db.update(bankStatementLines).set({ reconciled: 'true', matchedPaymentNo: run.runNo }).where(eq(bankStatementLines.id, sl.id));
        matched++;
      }
    }
    const recon = await this.reconciliation(bankAccountId, undefined, user);
    return { matched, run_lines_cleared: runLinesCleared, unmatched_statement: recon.unmatched_statement, unmatched_book: recon.unmatched_book };
  }

  async manualMatch(statementLineId: number, journalLineId: number, _user: JwtUser) {
    const db = this.db;
    const [sl] = await db.select().from(bankStatementLines).where(eq(bankStatementLines.id, statementLineId)).limit(1);
    if (!sl) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Statement line not found', messageTh: 'ไม่พบรายการ statement' });
    const [jl] = await db.select({ id: journalLines.id }).from(journalLines).where(eq(journalLines.id, journalLineId)).limit(1);
    if (!jl) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Journal line not found', messageTh: 'ไม่พบรายการบัญชี' });
    await db.update(bankStatementLines).set({ reconciled: 'true', matchedJournalLineId: journalLineId }).where(eq(bankStatementLines.id, statementLineId));
    return { statement_line_id: statementLineId, journal_line_id: journalLineId, reconciled: true };
  }

  async unmatch(statementLineId: number, _user: JwtUser) {
    const db = this.db;
    await db.update(bankStatementLines).set({ reconciled: 'false', matchedJournalLineId: null, matchedPaymentNo: null }).where(eq(bankStatementLines.id, statementLineId));
    return { statement_line_id: statementLineId, reconciled: false };
  }

  // BANK-02 maker-checker — a fee/interest adjustment is a REQUEST that posts a DRAFT JE (no GL/balance impact;
  // the statement line stays UNreconciled) until a DIFFERENT user approves it. A single user can no longer post a
  // bank fee straight to the books (e.g. mis-booking an outflow as interest income). The Draft JE (source BANKADJ,
  // sourceRef STMTLN-<id>) is also surfaced, aged, by the pending-approvals monitor (GOV-01). The line carries the
  // Draft entry_no in adjustmentJournalNo while reconciled='false' (= pending); approval flips reconciled='true'.
  async requestAdjustment(statementLineId: number, dto: AdjustmentDto, user: JwtUser) {
    const db = this.db;
    const [sl] = await db.select().from(bankStatementLines).where(eq(bankStatementLines.id, statementLineId)).limit(1);
    if (!sl) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Statement line not found', messageTh: 'ไม่พบรายการ statement' });
    if (sl.reconciled === 'true') throw new BadRequestException({ code: 'ALREADY_RECONCILED', message: 'Line already reconciled', messageTh: 'รายการนี้กระทบยอดแล้ว' });
    if (sl.adjustmentJournalNo) throw new BadRequestException({ code: 'ADJUSTMENT_PENDING', message: 'An adjustment is already pending approval for this line', messageTh: 'มีคำขอปรับปรุงรออนุมัติสำหรับรายการนี้แล้ว' });
    const acct = await this.loadAccount(Number(sl.bankAccountId));
    const bankGl = acct.glAccountCode;
    const amt = round4(Math.abs(n(sl.amount)));
    const sourceRef = `STMTLN-${statementLineId}`;
    if (await this.ledger.alreadyPosted('BANKADJ', sourceRef)) return { statement_line_id: statementLineId, already: true };
    const lines = dto.kind === 'interest'
      ? [{ account_code: bankGl, debit: amt }, { account_code: '4000', credit: amt }]
      : [{ account_code: '5100', debit: amt }, { account_code: bankGl, credit: amt }];
    const je: any = await this.ledger.postEntry({ date: sl.lineDate, source: 'BANKADJ', sourceRef, tenantId: acct.tenantId ?? null, memo: `Bank ${dto.kind} ${sourceRef}${dto.memo ? ' ' + dto.memo : ''}`, createdBy: user.username, lines, pendingApproval: true });
    await db.update(bankStatementLines).set({ adjustmentJournalNo: je?.entry_no ?? null }).where(eq(bankStatementLines.id, statementLineId));
    return { statement_line_id: statementLineId, journal_no: je?.entry_no ?? null, kind: dto.kind, amount: amt, status: 'PendingApproval', requested_by: user.username };
  }

  // Checker queue — bank adjustments awaiting approval (Draft JE posted, line not yet reconciled).
  async listPendingAdjustments(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select({ id: bankStatementLines.id, bankAccountId: bankStatementLines.bankAccountId, lineDate: bankStatementLines.lineDate, description: bankStatementLines.description, amount: bankStatementLines.amount, journalNo: bankStatementLines.adjustmentJournalNo })
      .from(bankStatementLines).where(and(isNotNull(bankStatementLines.adjustmentJournalNo), eq(bankStatementLines.reconciled, 'false'))).orderBy(asc(bankStatementLines.lineDate));
    return { pending: rows.map((r: any) => ({ statement_line_id: Number(r.id), bank_account_id: Number(r.bankAccountId), date: r.lineDate, description: r.description, amount: round4(n(r.amount)), journal_no: r.journalNo })), count: rows.length };
  }

  // Approve a pending bank adjustment (checker; approver ≠ requester enforced by ledger.approveEntry, binds Admin).
  async approveAdjustment(statementLineId: number, user: JwtUser) {
    const db = this.db;
    const [sl] = await db.select().from(bankStatementLines).where(eq(bankStatementLines.id, statementLineId)).limit(1);
    if (!sl || sl.reconciled === 'true' || !sl.adjustmentJournalNo) throw new BadRequestException({ code: 'NO_PENDING_ADJUSTMENT', message: 'No bank adjustment pending approval for this line', messageTh: 'ไม่พบรายการปรับปรุงที่รออนุมัติ' });
    const acct = await this.loadAccount(Number(sl.bankAccountId));
    const bankGl = acct.glAccountCode;
    const sourceRef = `STMTLN-${statementLineId}`;
    const [draft] = await db.select({ entryNo: journalEntries.entryNo }).from(journalEntries).where(and(eq(journalEntries.source, 'BANKADJ'), eq(journalEntries.sourceRef, sourceRef), eq(journalEntries.status, 'Draft'))).orderBy(desc(journalEntries.id)).limit(1);
    if (!draft) throw new BadRequestException({ code: 'NO_PENDING_ADJUSTMENT', message: 'No draft adjustment entry for this line', messageTh: 'ไม่พบรายการบัญชีปรับปรุงที่รออนุมัติ' });
    const res: any = await this.ledger.approveEntry(draft.entryNo, user);
    const [jl] = await db.select({ id: journalLines.id }).from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id)).where(and(eq(journalEntries.source, 'BANKADJ'), eq(journalEntries.sourceRef, sourceRef), eq(journalLines.accountCode, bankGl))).limit(1);
    await db.update(bankStatementLines).set({ reconciled: 'true', matchedJournalLineId: jl ? Number(jl.id) : null }).where(eq(bankStatementLines.id, statementLineId));
    return { statement_line_id: statementLineId, journal_no: draft.entryNo, status: 'Posted', approved_by: user.username, prepared_by: res?.prepared_by ?? null };
  }

  // Reject a pending bank adjustment (checker) — voids the Draft JE and frees the line.
  async rejectAdjustment(statementLineId: number, user: JwtUser, reason?: string) {
    const db = this.db;
    const [sl] = await db.select().from(bankStatementLines).where(eq(bankStatementLines.id, statementLineId)).limit(1);
    if (!sl || sl.reconciled === 'true' || !sl.adjustmentJournalNo) throw new BadRequestException({ code: 'NO_PENDING_ADJUSTMENT', message: 'No bank adjustment pending approval for this line', messageTh: 'ไม่พบรายการปรับปรุงที่รออนุมัติ' });
    const sourceRef = `STMTLN-${statementLineId}`;
    const [draft] = await db.select({ entryNo: journalEntries.entryNo }).from(journalEntries).where(and(eq(journalEntries.source, 'BANKADJ'), eq(journalEntries.sourceRef, sourceRef), eq(journalEntries.status, 'Draft'))).orderBy(desc(journalEntries.id)).limit(1);
    if (!draft) throw new BadRequestException({ code: 'NO_PENDING_ADJUSTMENT', message: 'No draft adjustment entry for this line', messageTh: 'ไม่พบรายการบัญชีปรับปรุงที่รออนุมัติ' });
    await this.ledger.rejectEntry(draft.entryNo, user, reason);
    await db.update(bankStatementLines).set({ adjustmentJournalNo: null }).where(eq(bankStatementLines.id, statementLineId));
    return { statement_line_id: statementLineId, journal_no: draft.entryNo, status: 'Rejected', rejected_by: user.username };
  }

  async reconciliation(bankAccountId: number, asOf: string | undefined, _user: JwtUser) {
    const db = this.db;
    const acct = await this.loadAccount(bankAccountId);
    const bankGl = acct.glAccountCode;
    const cutoff = asOf ?? '9999-12-31';
    // Scope to this account's tenant (shared bank GL across tenants) — see autoMatch.
    const tenantPred = acct.tenantId != null ? [eq(journalEntries.tenantId, acct.tenantId)] : [];
    const bookLines = await db.select({ id: journalLines.id, debit: journalLines.debit, credit: journalLines.credit, entryNo: journalEntries.entryNo, entryDate: journalEntries.entryDate, memo: journalLines.memo })
      .from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(eq(journalLines.accountCode, bankGl), eq(journalEntries.status, 'Posted'), sql`${journalEntries.entryDate} <= ${cutoff}`, ...tenantPred));
    const glBalance = round4(n(acct.openingBalance) + bookLines.reduce((a: number, l: any) => a + (n(l.debit) - n(l.credit)), 0));
    const [stmt] = await db.select().from(bankStatements).where(and(eq(bankStatements.bankAccountId, bankAccountId), sql`${bankStatements.statementDate} <= ${cutoff}`)).orderBy(desc(bankStatements.statementDate), desc(bankStatements.id)).limit(1);
    const statementBalance = stmt ? round4(n(stmt.closingBal)) : round4(n(acct.openingBalance));
    const matchedRows = await db.select({ jl: bankStatementLines.matchedJournalLineId, amount: bankStatementLines.amount }).from(bankStatementLines).where(and(eq(bankStatementLines.bankAccountId, bankAccountId), eq(bankStatementLines.reconciled, 'true')));
    const usedJl = new Set<number>(matchedRows.filter((r: any) => r.jl != null).map((r: any) => Number(r.jl)));
    const matchedTotal = round4(matchedRows.reduce((a: number, r: any) => a + n(r.amount), 0));
    const unStmt = await db.select().from(bankStatementLines).where(and(eq(bankStatementLines.bankAccountId, bankAccountId), eq(bankStatementLines.reconciled, 'false'), sql`${bankStatementLines.lineDate} <= ${cutoff}`)).orderBy(asc(bankStatementLines.lineDate));
    const unmatchedStatement = unStmt.map((l: any) => ({ statement_line_id: Number(l.id), date: l.lineDate, description: l.description, amount: round4(n(l.amount)) }));
    const unmatchedBook = bookLines.filter((l: any) => !usedJl.has(Number(l.id))).map((l: any) => ({ journal_line_id: Number(l.id), entry_no: l.entryNo, entry_date: l.entryDate, amount: round4(n(l.debit) - n(l.credit)), memo: l.memo }));
    return { bank_account_id: bankAccountId, gl_account_code: bankGl, as_of: asOf ?? null, gl_balance: glBalance, statement_balance: statementBalance, matched_total: matchedTotal, unmatched_book: unmatchedBook, unmatched_statement: unmatchedStatement, difference: round4(glBalance - statementBalance) };
  }

  private async loadAccount(id: number) {
    const db = this.db;
    const [a] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, id)).limit(1);
    if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Bank account not found', messageTh: 'ไม่พบบัญชีธนาคาร' });
    return a;
  }
}

function shapeAcct(b: any) {
  return { id: Number(b.id), bank_name: b.bankName, account_no: b.accountNo, gl_account_code: b.glAccountCode, currency: b.currency, opening_balance: n(b.openingBalance), active: b.active };
}
