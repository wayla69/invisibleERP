import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { JwtUser } from '../../common/decorators';
import type { DrizzleDb } from '../../database/database.module';
import { accounts, journalEntries, journalLines, fiscalPeriods, glAuditLog } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { currentTenantStore } from '../../common/tenant-context';
import { ymd, n, fx } from '../../database/queries';
import { toMinor4, minorToNumber4 } from '../../common/money';
import type { PostEntryDto, JournalLineDto } from './ledger.service';

// Posting sub-service (docs/38 §3 ledger decomposition, PR-3 — the FINAL prescribed cut, GL-05/GL-17,
// the most SoD-sensitive): postEntry (balanced-by-construction in bigint minor units, period
// LOCKED/CLOSED gates, WS1.1 control-account guard, ux_je_idem dedupe, R1-2 period-balance snapshot
// bump + GL-17 POST audit row in the SAME transaction), the maker-checker approve/reject (approver ≠
// preparer even for Admin), the GL-17 contra reversal + immutability guard, the journal listings and
// the audit trail — moved VERBATIM. A PLAIN class constructed in the LedgerService ctor BODY (harnesses
// construct the facade positionally with (db, docNo)). Fully self-contained: no callback ports — the
// cluster needs only the injected db + docNo.
export class LedgerPostingService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
  ) {}

  // ───────────────────── GL period-balance snapshot (docs/27 R1-2 / AUD-ARC-02) ─────────────────────
  // Apply one posted entry's lines to gl_period_balances INSIDE the same transaction as the posting.
  // Posting is the only balance-affecting event (Drafts are excluded from balances, Posted entries are
  // DB-immutable per 0165, corrections are contra reversals that post normally), so the snapshot cannot
  // drift from a mutation this service can see; GL-20 re-verifies it against the raw ledger at close.
  private async bumpPeriodBalances(
    tx: any,
    hdr: { tenantId: number | null; ledgerCode: string | null; period: string | null },
    lines: { account_code: string; debit?: unknown; credit?: unknown; cost_center?: string | null }[],
  ): Promise<void> {
    // Aggregate per (account, cost-center) first — an entry rarely has more than a handful of rows.
    const agg = new Map<string, { account: string; cc: string; debit: number; credit: number }>();
    for (const l of lines) {
      const cc = (l.cost_center ?? '') as string;
      const k = `${l.account_code}|${cc}`;
      const cur = agg.get(k) ?? { account: l.account_code, cc, debit: 0, credit: 0 };
      cur.debit += n(l.debit); cur.credit += n(l.credit);
      agg.set(k, cur);
    }
    const ledgerCode = hdr.ledgerCode ?? '';
    const period = hdr.period ?? '';
    // Round-2 ARC NEW-2 (write amplification): ONE multi-row upsert per entry instead of one round-trip
    // per (account, cost-center) group — bulk imports and reversals stop paying N sequential awaits, and
    // the row locks for all touched balance rows are taken in a single statement. Safe for ON CONFLICT:
    // `agg` already dedupes the conflict key, so no two VALUES rows can hit the same target row.
    const rows = [...agg.values()];
    if (!rows.length) return;
    const values = rows.map((r) => sql`(${hdr.tenantId}, ${ledgerCode}, ${period}, ${r.cc}, ${r.account}, ${fx(r.debit, 4)}, ${fx(r.credit, 4)})`);
    // ON CONFLICT targets the ux_gl_period_balances expression index (0218): atomic accumulate.
    await tx.execute(sql`
      INSERT INTO gl_period_balances (tenant_id, ledger_code, period, cost_center_code, account_code, debit, credit)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (coalesce(tenant_id, 0), ledger_code, period, cost_center_code, account_code)
      DO UPDATE SET debit = gl_period_balances.debit + excluded.debit, credit = gl_period_balances.credit + excluded.credit`);
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

    // Exact scale-4 balance check (docs/27 R1-4): accumulate in bigint minor units — float sums that are
    // then rounded can drift across a rounding boundary and are not a ledger-grade invariant.
    const totalDebitM = nzLines.reduce((a, l) => a + toMinor4(n(l.debit)), 0n);
    const totalCreditM = nzLines.reduce((a, l) => a + toMinor4(n(l.credit)), 0n);
    const totalDebit = minorToNumber4(totalDebitM);
    const totalCredit = minorToNumber4(totalCreditM);
    if (totalDebitM !== totalCreditM) {
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
    // WS2.1 hard gate (GL-15/GL-16): a LOCKED period rejects ALL postings regardless of allowClosedPeriod —
    // the new irreversible hard close. The ONLY exception is the system year-end closing entry (source
    // 'CLOSE'), which must still be able to post into the period it closes. lockPeriod() writes 'Locked'
    // into fiscal_periods.status, so this is authoritative and strictly stronger than the soft 'Closed' gate.
    if (pp && pp.status === 'Locked' && dto.source !== 'CLOSE') {
      throw new BadRequestException({ code: 'PERIOD_LOCKED', message: `Period ${period} is locked (hard close)`, messageTh: `งวดบัญชี ${period} ถูกล็อก (ปิดงวดถาวร)` });
    }
    if (pp && pp.status === 'Closed' && !dto.allowClosedPeriod) {
      // a year-end closing journal legitimately posts INTO the period it closes; everything else is blocked
      throw new BadRequestException({ code: 'PERIOD_CLOSED', message: `Period ${period} is closed`, messageTh: `งวดบัญชี ${period} ถูกปิดแล้ว` });
    }
    // Account-universe guard (GL-21 fail-closed, extended to EVERY posting — docs/42 step 1): each line
    // must reference a REAL, postable account. Without this, a posting to an unknown/retired code lands
    // silently and then VANISHES from every typed report (they INNER JOIN accounts) — the classic
    // "balance disappears after a CoA cleanup" defect. Runs for subledger postings too: viaSubledger
    // only relaxes the control-account rule below, never existence/postability.
    type AccRow = {
      code: string; isPostable: boolean | null; isControl: boolean | null; controlSubledger: string | null;
      effectiveFrom: string | null; effectiveTo: string | null; requireDimension: Record<string, boolean> | null;
    };
    const lineCodes = [...new Set(nzLines.map((l) => l.account_code))];
    const accRows: AccRow[] = await db.select({
      code: accounts.code, isPostable: accounts.isPostable,
      isControl: accounts.isControl, controlSubledger: accounts.controlSubledger,
      effectiveFrom: accounts.effectiveFrom, effectiveTo: accounts.effectiveTo,
      requireDimension: accounts.requireDimension,
    }).from(accounts).where(inArray(accounts.code, lineCodes));
    const accByCode = new Map<string, AccRow>(accRows.map((r) => [r.code, r]));
    for (const c of lineCodes) {
      const acc = accByCode.get(c);
      if (!acc) {
        throw new BadRequestException({
          code: 'INVALID_POSTING_ACCOUNT',
          message: `Account '${c}' does not exist in the chart of accounts`,
          messageTh: `บัญชี '${c}' ไม่มีอยู่ในผังบัญชี`,
        });
      }
      if (acc.isPostable === false) {
        throw new BadRequestException({
          code: 'INVALID_POSTING_ACCOUNT',
          message: `Account '${c}' is not postable (a header account or deactivated)`,
          messageTh: `บัญชี '${c}' ไม่สามารถบันทึกรายการได้ (เป็นบัญชีหัวหรือถูกปิดใช้งาน)`,
        });
      }
      // COA-D2 (GL-21): effective-date window — enforced ONLY when declared, so the (unset) universe is
      // byte-identical. ISO yyyy-mm-dd strings compare lexicographically. This is what makes the manual's
      // "use an effective-to date instead of flipping postability" advice actually bind.
      if ((acc.effectiveFrom && entryDate < acc.effectiveFrom) || (acc.effectiveTo && entryDate > acc.effectiveTo)) {
        throw new BadRequestException({
          code: 'ACCOUNT_NOT_EFFECTIVE',
          message: `Account '${c}' is not effective on ${entryDate} (window ${acc.effectiveFrom ?? '…'} → ${acc.effectiveTo ?? '…'})`,
          messageTh: `บัญชี '${c}' ไม่อยู่ในช่วงวันที่มีผล (${acc.effectiveFrom ?? '…'} → ${acc.effectiveTo ?? '…'})`,
        });
      }
    }
    // COA-D2 (GL-21): required dimensions — an account flagged {"branch":true,...} rejects a line that
    // omits that dimension (fail-closed at posting, so multi-dim reports on the account are complete).
    // Key → line-field mapping mirrors the journal_lines dimension stamps below.
    const DIM_FIELD: Record<string, (l: JournalLineDto) => unknown> = {
      branch: (l) => l.branch_id, project: (l) => l.project_id,
      department: (l) => l.dept_id, cost_center: (l) => l.cost_center,
    };
    for (const l of nzLines) {
      const req = accByCode.get(l.account_code)?.requireDimension;
      if (!req) continue;
      for (const [dim, on] of Object.entries(req)) {
        const get = DIM_FIELD[dim];
        if (!on || !get) continue;
        const v = get(l);
        if (v == null || v === '') {
          throw new BadRequestException({
            code: 'REQUIRED_DIMENSION_MISSING',
            message: `Account '${l.account_code}' requires the '${dim}' dimension on every line`,
            messageTh: `บัญชี '${l.account_code}' ต้องระบุมิติ '${dim}' ในทุกรายการ`,
          });
        }
      }
    }
    // Control-account guard (WS1.1): reject direct postings to control accounts unless
    // the caller explicitly marks viaSubledger:true (only AR/AP/INV/FA service methods do this).
    if (!dto.viaSubledger) {
      const hit = accRows.find((r: any) => r.isControl === true);
      if (hit) {
        throw new BadRequestException({
          code: 'CONTROL_ACCOUNT',
          message: `Account ${hit.code} is a ${hit.controlSubledger} control account; post via its sub-ledger only`,
          messageTh: `บัญชี ${hit.code} เป็นบัญชีคุมลูกหนี้/เจ้าหนี้ ต้องโพสต์ผ่านระบบย่อยเท่านั้น`,
        });
      }
    }
    const currency = dto.currency ?? 'THB';
    const entryNo = await this.docNo.nextDaily('JE');

    const doInsert = async (tx: any) => {
      // ON CONFLICT DO NOTHING backstops the pre-check (alreadyPosted): if a concurrent caller already
      // posted this (tenant, source, source_ref, ledger), the header insert no-ops and `h` is undefined,
      // so we skip the lines and report a dedupe instead of double-posting the GL. ux_je_idem enforces it.
      const willPost = !dto.pendingApproval;
      const [h] = await tx.insert(journalEntries).values({
        entryNo, entryDate, period, memo: dto.memo ?? null,
        source: dto.source ?? 'Manual', sourceRef: dto.sourceRef ?? null, ledgerCode: dto.ledgerCode ?? null,
        tenantId: entryTenantId, currency, status: willPost ? 'Posted' : 'Draft', createdBy: dto.createdBy,
        // GL-17: stamp the posting moment for entries that reach Posted immediately (Drafts get it on approve).
        postedAt: willPost ? new Date() : null,
        reversalOf: dto._reversalOf ?? null,
      }).onConflictDoNothing().returning({ id: journalEntries.id });
      if (!h) return null;
      await tx.insert(journalLines).values(nzLines.map((l) => ({
        entryId: Number(h.id), accountCode: l.account_code,
        debit: fx(l.debit, 4), credit: fx(l.credit, 4),
        currency, memo: l.memo ?? null, costCenterCode: l.cost_center ?? null, tenantId: entryTenantId,
        branchId: l.branch_id ?? null, projectId: l.project_id ?? null, departmentId: l.dept_id ?? null,
      })));
      // R1-2: a posting that lands Posted updates the period-balance snapshot in the SAME transaction.
      if (willPost) await this.bumpPeriodBalances(tx, { tenantId: entryTenantId, ledgerCode: dto.ledgerCode ?? null, period }, nzLines);
      // GL-17: record a POST audit-trail row for entries that land Posted (skip Drafts — APPROVE logs them).
      if (willPost) {
        await tx.insert(glAuditLog).values({
          tenantId: entryTenantId, entryId: Number(h.id), action: 'POST', actor: dto.createdBy ?? null,
          detail: { entry_no: entryNo, source: dto.source ?? 'Manual', reversal_of: dto._reversalOf ?? null },
        });
      }
      return nzLines.map((l) => ({ account_code: l.account_code, debit: n(l.debit), credit: n(l.credit), memo: l.memo ?? null }));
    };
    // Reuse the caller's tx when nested; else open our own.
    const inserted = outerTx ? await doInsert(outerTx) : await this.db.transaction(doInsert);

    // Lost the race to a concurrent identical posting → the entry already exists, do not double-count.
    if (inserted === null) return { entry_no: null, balanced: true, deduped: true, lines: [] };
    const status = dto.pendingApproval ? 'Draft' : 'Posted';
    return { entry_no: entryNo, balanced: true, status, pending: !!dto.pendingApproval, lines: inserted };
  }
  // ───────────────────── Journal listing ─────────────────────
  private async entriesList(limit: number, status?: 'Draft' | 'Posted' | 'Voided') {
    const db = this.db;
    const where = status ? eq(journalEntries.status, status) : undefined;
    const heads = await db.select().from(journalEntries).where(where).orderBy(desc(journalEntries.id)).limit(limit);
    if (!heads.length) return { entries: [], count: 0 };
    // Batch every line for the page in ONE query (was a query per header → N+1), then group by entry.
    const ids = heads.map((h: any) => Number(h.id));
    const allLines = await db.select({
      entryId: journalLines.entryId, account_code: journalLines.accountCode, debit: journalLines.debit, credit: journalLines.credit, memo: journalLines.memo,
    }).from(journalLines).where(inArray(journalLines.entryId, ids));
    const byEntry = new Map<number, any[]>();
    for (const l of allLines) {
      const arr = byEntry.get(Number(l.entryId)) ?? [];
      arr.push({ account_code: l.account_code, debit: n(l.debit), credit: n(l.credit), memo: l.memo });
      byEntry.set(Number(l.entryId), arr);
    }
    const out = heads.map((h: any) => ({
      entry_no: h.entryNo, entry_date: h.entryDate, period: h.period, source: h.source, source_ref: h.sourceRef,
      memo: h.memo, currency: h.currency, status: h.status, created_by: h.createdBy, created_at: h.createdAt,
      lines: byEntry.get(Number(h.id)) ?? [],
    }));
    return { entries: out, count: out.length };
  }
  async listJournal(limit: number) { return this.entriesList(limit); }
  // GL-05: journal entries awaiting maker-checker approval (Draft).
  async pendingJournal(limit: number) { return this.entriesList(limit, 'Draft'); }

  // GL-05 maker-checker: approve a Draft JE → Posted. The approver MUST differ from the preparer
  // (segregation of duties) regardless of permissions held — even an Admin cannot approve their own.
  async approveEntry(entryNo: string, approver: JwtUser) {
    const db = this.db;
    const [e] = await db.select().from(journalEntries).where(eq(journalEntries.entryNo, entryNo)).limit(1);
    if (!e) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Journal entry not found', messageTh: 'ไม่พบรายการบัญชี' });
    if (e.status !== 'Draft') throw new BadRequestException({ code: 'NOT_PENDING', message: `Entry ${entryNo} is ${e.status}, not pending approval`, messageTh: 'รายการนี้ไม่ได้รออนุมัติ' });
    if (e.createdBy && e.createdBy === approver.username) {
      throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve a journal entry you prepared', messageTh: 'ผู้บันทึกอนุมัติรายการของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    // Re-check the period is still open at approval time (it may have closed since the draft was prepared).
    const [pp] = e.tenantId == null ? [undefined]
      : await db.select({ status: fiscalPeriods.status }).from(fiscalPeriods).where(and(eq(fiscalPeriods.code, e.period!), eq(fiscalPeriods.tenantId, e.tenantId))).limit(1);
    if (pp && pp.status === 'Closed') throw new BadRequestException({ code: 'PERIOD_CLOSED', message: `Period ${e.period} is closed`, messageTh: `งวดบัญชี ${e.period} ถูกปิดแล้ว` });
    // GL-17: a Draft → Posted transition is the moment of posting; stamp postedAt and log the APPROVE.
    // R1-2: the transition + audit row + period-balance snapshot commit ATOMICALLY.
    await db.transaction(async (tx: any) => {
      await tx.update(journalEntries).set({ status: 'Posted', postedAt: new Date() }).where(eq(journalEntries.id, e.id));
      await tx.insert(glAuditLog).values({
        tenantId: e.tenantId ?? null, entryId: Number(e.id), action: 'APPROVE', actor: approver.username,
        detail: { entry_no: entryNo, prepared_by: e.createdBy },
      });
      const drLines = await tx.select({ account_code: journalLines.accountCode, debit: journalLines.debit, credit: journalLines.credit, cost_center: journalLines.costCenterCode })
        .from(journalLines).where(eq(journalLines.entryId, Number(e.id)));
      await this.bumpPeriodBalances(tx, { tenantId: e.tenantId ?? null, ledgerCode: e.ledgerCode ?? null, period: e.period ?? null }, drLines);
    });
    return { entry_no: entryNo, status: 'Posted', approved_by: approver.username, prepared_by: e.createdBy };
  }

  // GL-05: reject a Draft JE → Voided (with a reason appended to the memo).
  async rejectEntry(entryNo: string, approver: JwtUser, reason?: string) {
    const db = this.db;
    const [e] = await db.select().from(journalEntries).where(eq(journalEntries.entryNo, entryNo)).limit(1);
    if (!e) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Journal entry not found', messageTh: 'ไม่พบรายการบัญชี' });
    if (e.status !== 'Draft') throw new BadRequestException({ code: 'NOT_PENDING', message: `Entry ${entryNo} is ${e.status}, not pending approval`, messageTh: 'รายการนี้ไม่ได้รออนุมัติ' });
    const memo = `${e.memo ?? ''} [REJECTED by ${approver.username}${reason ? `: ${reason}` : ''}]`.trim();
    await db.update(journalEntries).set({ status: 'Voided', memo }).where(eq(journalEntries.id, e.id));
    return { entry_no: entryNo, status: 'Voided', rejected_by: approver.username };
  }

  // ───────────────────── GL immutability + reversal (WS2.2, GL-17) ─────────────────────
  // A Posted journal entry is IMMUTABLE — never edited or deleted (DB trigger in prod + this app guard).
  // The ONLY correction is a contra REVERSAL: a new, immediately-Posted entry that swaps every line's
  // debit/credit so original + reversal net to zero on every affected account. The original is flagged
  // is_reversed (the one column the DB trigger permits changing on a posted entry). Every action is logged.
  async reverseEntry(dto: { entryId: number; reversedBy: string; reason?: string; date?: string; requireDistinctApprover?: boolean }) {
    const db = this.db;
    const [orig] = await db.select().from(journalEntries).where(eq(journalEntries.id, dto.entryId)).limit(1);
    if (!orig) throw new NotFoundException({ code: 'ENTRY_NOT_FOUND', message: `Journal entry ${dto.entryId} not found`, messageTh: `ไม่พบรายการบัญชี ${dto.entryId}` });
    if (orig.status !== 'Posted') throw new BadRequestException({ code: 'NOT_POSTED', message: `Entry ${orig.entryNo} is ${orig.status}; only Posted entries can be reversed`, messageTh: 'กลับรายการได้เฉพาะรายการที่ผ่านรายการแล้ว' });
    if (orig.isReversed) throw new BadRequestException({ code: 'ALREADY_REVERSED', message: `Entry ${orig.entryNo} has already been reversed`, messageTh: 'รายการนี้ถูกกลับรายการไปแล้ว' });
    // GL-05 (audit G2): a Posted JE cleared GL-05 maker-checker, so a reversal must not silently undo that
    // second-person check. On the MANUAL reversal path (requireDistinctApprover, set by the controller) the
    // reverser must differ from the original preparer — the original preparer cannot unilaterally reverse
    // their own (independently-approved) entry. System/internal callers (e.g. FX reval) do not set the flag.
    if (dto.requireDistinctApprover && orig.createdBy && orig.createdBy === dto.reversedBy) {
      throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot reverse a journal entry you prepared', messageTh: 'ผู้บันทึกกลับรายการของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }

    const lines = await db.select().from(journalLines).where(eq(journalLines.entryId, orig.id));
    if (!lines.length) throw new BadRequestException({ code: 'NOT_POSTED', message: `Entry ${orig.entryNo} has no lines to reverse`, messageTh: 'ไม่มีรายการบัญชีให้กลับรายการ' });

    // Swap Dr/Cr on every line; carry dimensions over. Post through the normal posting path so the period
    // gates (PERIOD_LOCKED/PERIOD_CLOSED), balance invariant and idempotency all still apply.
    const reversalLines: JournalLineDto[] = lines.map((l: any) => ({
      account_code: l.accountCode,
      debit: n(l.credit), credit: n(l.debit),
      memo: `Reversal of ${orig.entryNo}${l.memo ? ` — ${l.memo}` : ''}`,
      cost_center: l.costCenterCode ?? null,
      branch_id: l.branchId ?? null, project_id: l.projectId ?? null, dept_id: l.departmentId ?? null,
    }));
    const date = dto.date ?? ymd();
    const res = await this.postEntry({
      date, source: 'REVERSAL', sourceRef: `REV-${Number(orig.id)}`,
      tenantId: orig.tenantId ?? null, currency: orig.currency ?? 'THB',
      memo: `Reversal of ${orig.entryNo}${dto.reason ? ` — ${dto.reason}` : ''}`,
      lines: reversalLines, createdBy: dto.reversedBy, ledgerCode: orig.ledgerCode ?? null,
      // a posted contra account leg may legitimately touch a control account (it mirrors the original)
      viaSubledger: true, _reversalOf: Number(orig.id),
    });

    // Resolve the new entry's id (postEntry returns entry_no; could be a dedupe on a same-source re-run).
    const [rev] = await db.select({ id: journalEntries.id }).from(journalEntries)
      .where(eq(journalEntries.sourceRef, `REV-${Number(orig.id)}`)).orderBy(desc(journalEntries.id)).limit(1);
    const reversalId = rev ? Number(rev.id) : null;

    // Flag the original reversed — ONLY is_reversed changes, so the DB trigger permits this UPDATE.
    await db.update(journalEntries).set({ isReversed: true }).where(eq(journalEntries.id, orig.id));
    await db.insert(glAuditLog).values({
      tenantId: orig.tenantId ?? null, entryId: Number(orig.id), action: 'REVERSE', actor: dto.reversedBy,
      detail: { originalId: Number(orig.id), original_entry_no: orig.entryNo, reversalId, reversal_entry_no: res.entry_no, reason: dto.reason ?? null },
    });
    return { reversalId, originalId: Number(orig.id), reversal_entry_no: res.entry_no, original_entry_no: orig.entryNo };
  }

  // GL-17 app-level immutability guard (complements the prod DB trigger; harness-verifiable). There is no
  // edit/delete endpoint for a posted JE — this method DEMONSTRATES the guard: it refuses to mutate a Posted
  // entry, records a MUTATE_BLOCKED audit row, and signals the block. It returns a discriminated result
  // (rather than throwing) so the audit row commits with the request tx; the controller renders the block
  // as HTTP 400 GL_IMMUTABLE. A thrown exception would roll the whole request tx back and discard the audit
  // row, because each request runs in a single tenant-scoped transaction (see TenantTxInterceptor).
  async attemptVoidPosted(entryId: number, actor: string) {
    const db = this.db;
    const [e] = await db.select().from(journalEntries).where(eq(journalEntries.id, entryId)).limit(1);
    if (!e) throw new NotFoundException({ code: 'ENTRY_NOT_FOUND', message: `Journal entry ${entryId} not found`, messageTh: `ไม่พบรายการบัญชี ${entryId}` });
    if (e.status === 'Posted') {
      await db.insert(glAuditLog).values({
        tenantId: e.tenantId ?? null, entryId: Number(e.id), action: 'MUTATE_BLOCKED', actor,
        detail: { entry_no: e.entryNo, attempted: 'void/delete', message: 'posted entry is immutable; correct via reversal' },
      });
      return { blocked: true as const, code: 'GL_IMMUTABLE' as const, entry_id: entryId, entry_no: e.entryNo, status: e.status, immutable: true,
        message: `Posted journal entry ${e.entryNo} is immutable; correct it via a reversal`, messageTh: 'รายการที่ผ่านรายการแล้วแก้ไข/ลบไม่ได้ ต้องกลับรายการเท่านั้น' };
    }
    // Non-posted (Draft) entries are not GL-17-protected; nothing to block here.
    return { blocked: false as const, entry_id: entryId, status: e.status, immutable: false };
  }

  // GL-17: the GL audit trail (optionally filtered to one entry), scoped to the caller's tenant by RLS.
  async listGlAudit(entryId?: number, limit = 100) {
    const db = this.db;
    const where = entryId != null ? eq(glAuditLog.entryId, entryId) : undefined;
    const rows = await db.select().from(glAuditLog).where(where).orderBy(desc(glAuditLog.id)).limit(limit);
    return { audit: rows.map((r: any) => ({ id: Number(r.id), entry_id: r.entryId != null ? Number(r.entryId) : null, action: r.action, actor: r.actor, detail: r.detail, at: r.at })), count: rows.length };
  }
}
