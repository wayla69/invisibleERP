import { NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, desc, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { employeeAdvances, projects } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import { postingDefault } from '../ledger/posting-events';
import { CommitmentsService } from '../commitments/commitments.service';
import { ymd, n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import type { AdvanceDto, SettleAdvanceDto } from './finance.service';

const round2 = (x: number) => Math.round(x * 100) / 100;

// docs/46 Phase 4a cut 2 — petty-cash / employee cash advances (EXP-07), moved VERBATIM out of
// finance.service.ts. A plain class constructed in the FinanceService constructor BODY (writeflow builds
// the facade positionally — sub-services are never DI params); the facade keeps thin delegators, so the
// public API is byte-identical. Issue: Dr 1180 Employee Advances / Cr 1000 Cash — the 1180 balance is the
// outstanding float; it clears on settlement. DTO types imported type-only from the facade (no runtime cycle).
export class FinanceAdvancesService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly ledger?: LedgerService,
    private readonly commitments?: CommitmentsService,
  ) {}

  // M4 (docs/32) — resolve an optional project_code to its id (nullable). Unknown code → 404 so a typo can't
  // silently drop the project dimension on site cash.
  private async resolveProjectId(code?: string): Promise<number | null> {
    const c = code?.trim();
    if (!c) return null;
    const [p] = await this.db.select({ id: projects.id }).from(projects).where(eq(projects.projectCode, c)).limit(1);
    if (!p) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: `Project ${c} not found`, messageTh: 'ไม่พบโครงการ' });
    return Number(p.id);
  }

  async issueAdvance(dto: AdvanceDto, user: JwtUser) {
    const amount = round2(dto.amount);
    if (!(amount > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'amount must be > 0', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });
    const db = this.db;
    const tenantId = dto.tenant_id ?? user.tenantId ?? null;
    const projectId = await this.resolveProjectId(dto.project_code); // M4 — project dimension (nullable)
    const advanceNo = await this.docNo.nextDaily('ADV');
    const today = ymd();
    await db.insert(employeeAdvances).values({
      advanceNo, tenantId, payee: dto.payee, purpose: dto.purpose ?? null, amount: String(amount), status: 'open',
      projectId, boqLineId: dto.boq_line_id ?? null, expenseAccount: dto.expense_account ?? '5100', issuedBy: user.username, issuedDate: today,
    });
    if (this.ledger) await this.ledger.postEntry({ date: today, source: 'ADV', sourceRef: advanceNo, tenantId, memo: `Cash advance ${advanceNo} — ${dto.payee}`, createdBy: user.username, lines: [{ account_code: '1180', debit: amount, project_id: projectId }, { account_code: '1000', credit: amount }] });
    return { advance_no: advanceNo, payee: dto.payee, amount, status: 'open', project_id: projectId };
  }

  // Settle an advance: the employee's actual spend posts to the expense account, any unused cash is returned.
  // settled_expense + returned_cash must equal the advance — Dr expense + Dr 1000 / Cr 1180 (clears the float).
  async settleAdvance(advanceNo: string, dto: SettleAdvanceDto, user: JwtUser) {
    const db = this.db;
    const [a] = await db.select().from(employeeAdvances).where(eq(employeeAdvances.advanceNo, advanceNo)).limit(1);
    if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Advance not found', messageTh: 'ไม่พบเงินทดรองจ่าย' });
    if (a.status === 'settled') throw new BadRequestException({ code: 'ALREADY_SETTLED', message: 'Advance already settled', messageTh: 'เงินทดรองจ่ายนี้เคลียร์แล้ว' });
    const spent = round2(dto.settled_expense);
    const returned = round2(dto.returned_cash ?? 0);
    if (round2(spent + returned) !== round2(n(a.amount))) throw new BadRequestException({ code: 'SETTLE_MISMATCH', message: `settled_expense + returned_cash (${round2(spent + returned)}) must equal the advance (${n(a.amount)})`, messageTh: 'ยอดใช้จ่ายรวมเงินคืนต้องเท่ากับเงินทดรองจ่าย' });
    // docs/43 PR-2: dto ?? advance-row ?? tenant posting-rule ?? registry default (ADVANCE.SETTLE.expense)
    const advOvr = this.ledger ? await this.ledger.postingOverrides('ADVANCE.SETTLE', a.tenantId ?? null) : {};
    const expAcct = dto.expense_account ?? a.expenseAccount ?? advOvr.expense ?? postingDefault('ADVANCE.SETTLE', 'expense');
    const projectId = a.projectId ?? null; // M4 — settled site-cash spend carries the project dimension
    const lines: any[] = [];
    if (spent > 0) lines.push({ account_code: expAcct, debit: spent, project_id: projectId });
    if (returned > 0) lines.push({ account_code: '1000', debit: returned });
    lines.push({ account_code: '1180', credit: round2(n(a.amount)), project_id: projectId });
    if (this.ledger) await this.ledger.postEntry({ date: ymd(), source: 'ADV-STL', sourceRef: advanceNo, tenantId: a.tenantId ?? null, memo: `Settle advance ${advanceNo}`, createdBy: user.username, lines });
    await db.update(employeeAdvances).set({ status: 'settled', settledExpense: String(spent), returnedCash: String(returned), settledBy: user.username, settledDate: ymd() }).where(eq(employeeAdvances.id, a.id));
    // FU1 (docs/32) — when the advance is tagged to a project + BoQ line, the settled spend CONSUMES that
    // line's budget (a consumed commitment, allowOver so site cash never blocks — it records against remaining).
    if (this.commitments && projectId != null && a.boqLineId != null && spent > 0) {
      try {
        await db.transaction(async (tx: any) => {
          const c = await this.commitments!.reserve(tx, { projectId, boqLineId: Number(a.boqLineId), amount: spent, qty: 0, sourceDocType: 'ADV', sourceDocNo: advanceNo, createdBy: user.username, tenantId: a.tenantId ?? null, allowOver: true });
          await this.commitments!.consume(tx, 'ADV', advanceNo);
          void c;
        });
      } catch { /* best-effort — the settlement already posted */ }
    }
    return { advance_no: advanceNo, status: 'settled', settled_expense: spent, returned_cash: returned };
  }

  async listAdvances(tenantId?: number, status?: string) {
    const db = this.db;
    const conds: SQL[] = [];
    if (tenantId != null) conds.push(eq(employeeAdvances.tenantId, tenantId));
    if (status) conds.push(eq(employeeAdvances.status, status));
    const rows = await db.select().from(employeeAdvances).where(conds.length ? and(...conds) : undefined).orderBy(desc(employeeAdvances.id));
    return { advances: rows.map((r: any) => ({ advance_no: r.advanceNo, payee: r.payee, purpose: r.purpose, amount: n(r.amount), status: r.status, settled_expense: n(r.settledExpense), returned_cash: n(r.returnedCash), issued_by: r.issuedBy, issued_date: r.issuedDate, settled_date: r.settledDate })), count: rows.length, outstanding: round2(rows.filter((r: any) => r.status === 'open').reduce((s: number, r: any) => s + n(r.amount), 0)) };
  }
}
