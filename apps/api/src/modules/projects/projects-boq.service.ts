import { eq, desc, sql } from 'drizzle-orm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DrizzleDb } from '../../database/database.module';
import { projects, projectBoq, projectBoqLines, projectChangeOrders, employeeAdvances, expenseClaims, expenseRequests } from '../../database/schema';
import type { CommitmentsService } from '../commitments/commitments.service';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';
import { r2 } from './projects.helpers';
import { shapeBoqLine, shapeChangeOrder } from './projects.shapes';
import type { BoqDto, BoqLineDto, RemeasureDto, ChangeOrderDto } from './projects.service';

// BoQ / change-order / site-cash sub-service (docs/32 M0–M4, PROJ-10/12/14) — a PLAIN class built in the
// ProjectsService ctor body (not a DI provider), mirroring ProjectsGateService, extracted from the facade
// in the docs/46 Phase-4 projects round. Owns the measured-works budget baseline (BoQ author → independent
// approve syncs the project budget; lock freezes it), the governed contract amendments (change orders,
// maker-checker, auto re-baseline on approval), and the project site-cash / commitments read models.
export class ProjectsBoqService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly rowOf: (code: string) => Promise<any>,
    // Change-order approval re-baselines through the EVM sub-service via the facade delegator (PROJ-07).
    private readonly captureBaselineFn: (code: string, dto: { label?: string; reason?: string }, user: JwtUser) => Promise<any>,
    // M1 (PROJ-12) — the BoQ-line encumbrance ledger; absent in partial harnesses ⇒ committed/remaining omitted.
    private readonly commitments?: CommitmentsService,
  ) {}

  // ── Bill of Quantities (BoQ) — M0, docs/32 ────────────────────────────────
  // The project's measured-works requirement & budget baseline. A draft BoQ is authored with rate-built
  // lines (budget_amount = budget_qty × rate); an independent approver signs it off (maker-checker) — on
  // approval the project's budget_amount is synced to the sum of line budgets (the enforceable baseline that
  // M1's commitment ledger draws against). A locked BoQ is frozen. Line amount computed server-side.
  private boqLineAmount(dto: BoqLineDto) {
    return dto.budget_amount != null ? r2(dto.budget_amount) : r2(n(dto.budget_qty) * n(dto.rate));
  }

  async createBoq(code: string, dto: BoqDto, user: JwtUser) {
    const db = this.db;
    const p = await this.rowOf(code);
    const tenantId = p.tenantId ?? user.tenantId ?? null;
    const boqNo = dto.boq_no?.trim() || `BOQ${String(Date.now()).slice(-8)}`;
    const [h] = await db.insert(projectBoq).values({
      projectId: Number(p.id), tenantId, boqNo, title: dto.title ?? null, status: 'draft', createdBy: user.username,
    }).returning({ id: projectBoq.id });
    const lines = dto.lines ?? [];
    for (let i = 0; i < lines.length; i++) {
      const it = lines[i]!;
      await db.insert(projectBoqLines).values({
        boqId: Number(h!.id), projectId: Number(p.id), tenantId, lineNo: i + 1,
        category: it.category ?? 'material', itemNo: it.item_no ?? null, taskId: it.task_id ?? null, wbsCode: it.wbs_code ?? null,
        description: it.description ?? null, uom: it.uom ?? null,
        budgetQty: fx(it.budget_qty ?? 0, 4), rate: fx(it.rate ?? 0, 2), budgetAmount: fx(this.boqLineAmount(it), 2),
      });
    }
    return this.getBoq(code);
  }

  // Latest BoQ for a project + its lines + budget rollup (total, by category, count).
  async getBoq(code: string) {
    const db = this.db;
    const p = await this.rowOf(code);
    const [boq] = await db.select().from(projectBoq).where(eq(projectBoq.projectId, Number(p.id))).orderBy(desc(projectBoq.id)).limit(1);
    if (!boq) return { project_code: code, boq: null, lines: [], count: 0, budget_total: 0, by_category: {} };
    const lines = await db.select().from(projectBoqLines).where(eq(projectBoqLines.boqId, Number(boq.id))).orderBy(projectBoqLines.lineNo);
    const budgetTotal = r2(lines.reduce((s: number, l: any) => s + n(l.budgetAmount), 0));
    const byCategory: Record<string, number> = {};
    for (const l of lines) byCategory[l.category] = r2((byCategory[l.category] ?? 0) + n(l.budgetAmount));
    // M1 (PROJ-12) — per-line committed (open+consumed encumbrance) and remaining = budget − committed.
    const committedByLine = this.commitments ? await this.commitments.committedByLine(lines.map((l: any) => Number(l.id))) : new Map<number, number>();
    const shaped = lines.map((l: any) => {
      const committed = committedByLine.get(Number(l.id)) ?? 0;
      return { ...shapeBoqLine(l), committed, remaining: r2(n(l.budgetAmount) - committed) };
    });
    const committedTotal = r2(shaped.reduce((s: number, l: any) => s + n(l.committed), 0));
    return {
      project_code: code,
      boq: { id: Number(boq.id), boq_no: boq.boqNo, version: boq.version, title: boq.title, status: boq.status, budget_total: n(boq.budgetTotal), approved_by: boq.approvedBy, approved_at: boq.approvedAt, created_by: boq.createdBy },
      lines: shaped, count: lines.length, budget_total: budgetTotal,
      committed_total: committedTotal, remaining_total: r2(budgetTotal - committedTotal),
      by_category: byCategory,
    };
  }

  // Project site-cash (M4, docs/32, PROJ-14) — the advances, expense-reimbursement claims and petty-cash
  // requests raised AGAINST this project, so site cash is managed on the project. Read-only rollup.
  async siteCash(code: string) {
    const db = this.db;
    const p = await this.rowOf(code);
    const pid = Number(p.id);
    const advances = await db.select().from(employeeAdvances).where(eq(employeeAdvances.projectId, pid)).orderBy(desc(employeeAdvances.id));
    const claims = await db.select().from(expenseClaims).where(eq(expenseClaims.projectId, pid)).orderBy(desc(expenseClaims.id));
    const petty = await db.select().from(expenseRequests).where(eq(expenseRequests.projectId, pid)).orderBy(desc(expenseRequests.id));
    const sum = (rows: any[]) => r2(rows.reduce((s: number, r: any) => s + n(r.amount), 0));
    const advTotal = sum(advances), claimTotal = sum(claims), pettyTotal = sum(petty);
    return {
      project_code: code,
      advances: advances.map((a: any) => ({ advance_no: a.advanceNo, payee: a.payee, amount: n(a.amount), status: a.status, settled_expense: n(a.settledExpense), issued_date: a.issuedDate })),
      reimbursements: claims.map((c: any) => ({ id: Number(c.id), category: c.category, amount: n(c.amount), status: c.status, entry_no: c.entryNo, ap_txn_no: c.apTxnNo, claim_date: c.claimDate })),
      petty_cash: petty.map((r: any) => ({ req_no: r.reqNo, kind: r.kind, payee: r.payee, amount: n(r.amount), status: r.status, gl_ref: r.glRef })),
      totals: { advances: advTotal, reimbursements: claimTotal, petty_cash: pettyTotal, total: r2(advTotal + claimTotal + pettyTotal) },
      count: advances.length + claims.length + petty.length,
    };
  }

  // Project commitments read model (M1, PROJ-12) — the encumbrance ledger for a project + a status summary.
  async listCommitments(code: string) {
    const p = await this.rowOf(code);
    if (!this.commitments) return { project_code: code, commitments: [], count: 0, summary: { open: 0, consumed: 0, released: 0, committed: 0 } };
    return { project_code: code, ...(await this.commitments.listForProject(Number(p.id))) };
  }

  private async boqRow(boqId: number) {
    const [boq] = await this.db.select().from(projectBoq).where(eq(projectBoq.id, Number(boqId))).limit(1);
    if (!boq) throw new NotFoundException({ code: 'BOQ_NOT_FOUND', message: `BoQ ${boqId} not found`, messageTh: 'ไม่พบ BoQ' });
    return boq;
  }

  // Append a line to a DRAFT BoQ (an approved/locked BoQ is frozen — change it via a change order in M1+).
  async addBoqLine(boqId: number, dto: BoqLineDto, user: JwtUser) {
    const db = this.db;
    const boq = await this.boqRow(boqId);
    if (boq.status !== 'draft') throw new BadRequestException({ code: 'BOQ_NOT_DRAFT', message: `BoQ is ${boq.status}; only a draft BoQ accepts new lines`, messageTh: 'เพิ่มรายการได้เฉพาะ BoQ สถานะร่าง' });
    const [mx] = await db.select({ m: sql<string>`coalesce(max(${projectBoqLines.lineNo}),0)` }).from(projectBoqLines).where(eq(projectBoqLines.boqId, Number(boqId)));
    await db.insert(projectBoqLines).values({
      boqId: Number(boqId), projectId: Number(boq.projectId), tenantId: boq.tenantId ?? user.tenantId ?? null, lineNo: Number(mx?.m ?? 0) + 1,
      category: dto.category ?? 'material', itemNo: dto.item_no ?? null, taskId: dto.task_id ?? null, wbsCode: dto.wbs_code ?? null,
      description: dto.description ?? null, uom: dto.uom ?? null,
      budgetQty: fx(dto.budget_qty ?? 0, 4), rate: fx(dto.rate ?? 0, 2), budgetAmount: fx(this.boqLineAmount(dto), 2),
    });
    const [proj] = await db.select({ c: projects.projectCode }).from(projects).where(eq(projects.id, Number(boq.projectId))).limit(1);
    return this.getBoq(proj!.c);
  }

  // Approve a BoQ (maker-checker: approver ≠ author, SOD_SELF_APPROVAL). On approval the sum of line budgets
  // is snapshotted onto the BoQ and synced to the project's budget_amount — the enforceable material budget
  // baseline (M1's commitment ledger draws remaining = budget − actual − commitments against it).
  async approveBoq(boqId: number, user: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const boq = await this.boqRow(boqId);
    if (boq.status !== 'draft') throw new BadRequestException({ code: 'BOQ_NOT_DRAFT', message: `BoQ is already ${boq.status}`, messageTh: 'BoQ ถูกดำเนินการแล้ว' });
    await assertMakerChecker(db, { user, maker: boq.createdBy, event: 'proj.boq.approve', ref: String(boqId), reason: selfApprovalReason, code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: you cannot approve a BoQ you authored', messageTh: 'ผู้จัดทำ BoQ อนุมัติเองไม่ได้ (แบ่งแยกหน้าที่)', httpStatus: 400 });
    const [tot] = await db.select({ v: sql<string>`coalesce(sum(${projectBoqLines.budgetAmount}),0)` }).from(projectBoqLines).where(eq(projectBoqLines.boqId, Number(boqId)));
    const budgetTotal = r2(n(tot?.v));
    await db.update(projectBoq).set({ status: 'approved', budgetTotal: fx(budgetTotal, 2), approvedBy: user.username, approvedAt: new Date() }).where(eq(projectBoq.id, Number(boqId)));
    // Sync the project's budget baseline to the approved BoQ total (the material/works budget).
    await db.update(projects).set({ budgetAmount: fx(budgetTotal, 2) }).where(eq(projects.id, Number(boq.projectId)));
    const [proj] = await db.select({ c: projects.projectCode }).from(projects).where(eq(projects.id, Number(boq.projectId))).limit(1);
    return { ...(await this.getBoq(proj!.c)), budget_synced: budgetTotal };
  }

  // Lock an approved BoQ — freeze it (no further re-measurement edits; the definitive baseline of record).
  async lockBoq(boqId: number, user: JwtUser) {
    const db = this.db;
    const boq = await this.boqRow(boqId);
    if (boq.status !== 'approved') throw new BadRequestException({ code: 'BOQ_NOT_APPROVED', message: `Only an approved BoQ can be locked (is ${boq.status})`, messageTh: 'ล็อกได้เฉพาะ BoQ ที่อนุมัติแล้ว' });
    await db.update(projectBoq).set({ status: 'locked' }).where(eq(projectBoq.id, Number(boqId)));
    const [proj] = await db.select({ c: projects.projectCode }).from(projects).where(eq(projects.id, Number(boq.projectId))).limit(1);
    return this.getBoq(proj!.c);
  }

  // Record the actual measured quantity for a line (re-measurement). Allowed while the BoQ is approved (not
  // yet locked); records remeasured_qty vs the budgeted qty — the basis for re-measurement variance.
  async remeasureBoqLine(lineId: number, dto: RemeasureDto, user: JwtUser) {
    const db = this.db;
    const [line] = await db.select().from(projectBoqLines).where(eq(projectBoqLines.id, Number(lineId))).limit(1);
    if (!line) throw new NotFoundException({ code: 'BOQ_LINE_NOT_FOUND', message: `BoQ line ${lineId} not found`, messageTh: 'ไม่พบรายการ BoQ' });
    const boq = await this.boqRow(Number(line.boqId));
    if (boq.status === 'draft') throw new BadRequestException({ code: 'BOQ_NOT_APPROVED', message: 'Re-measure an approved BoQ, not a draft', messageTh: 're-measure ได้เมื่อ BoQ อนุมัติแล้ว' });
    if (boq.status === 'locked') throw new BadRequestException({ code: 'BOQ_LOCKED', message: 'BoQ is locked — re-measurement is frozen', messageTh: 'BoQ ถูกล็อก แก้ไขไม่ได้' });
    await db.update(projectBoqLines).set({ remeasuredQty: fx(dto.remeasured_qty, 4) }).where(eq(projectBoqLines.id, Number(lineId)));
    const [proj] = await db.select({ c: projects.projectCode }).from(projects).where(eq(projects.id, Number(line.projectId))).limit(1);
    return this.getBoq(proj!.c);
  }

  // ── Change orders / contract variations (PROJ-10) ────────────────────────
  // Request a change order — a governed amendment to the contract value / budget / EAC. Posts/applies NOTHING;
  // it stays `pending` until a DIFFERENT user approves it (maker-checker), so a project can't move its
  // contract goalposts unilaterally.
  async createChangeOrder(code: string, dto: ChangeOrderDto, user: JwtUser) {
    const db = this.db;
    const p = await this.rowOf(code);
    const contractDelta = r2(dto.contract_delta ?? 0), budgetDelta = r2(dto.budget_delta ?? 0), estDelta = r2(dto.estimated_cost_delta ?? 0);
    if (contractDelta === 0 && budgetDelta === 0 && estDelta === 0) throw new BadRequestException({ code: 'EMPTY_CHANGE_ORDER', message: 'A change order must change the contract, budget, or estimated cost', messageTh: 'ใบเปลี่ยนแปลงต้องเปลี่ยนมูลค่าสัญญา งบประมาณ หรือประมาณการต้นทุน' });
    const coNo = `CO${String(Date.now()).slice(-8)}`;
    await db.insert(projectChangeOrders).values({
      projectId: Number(p.id), tenantId: p.tenantId ?? user.tenantId ?? null, coNo, description: dto.description ?? null,
      contractDelta: fx(contractDelta, 2), budgetDelta: fx(budgetDelta, 2), estimatedCostDelta: fx(estDelta, 2),
      reason: dto.reason ?? null, status: 'pending', requestedBy: user.username,
    });
    return this.listChangeOrders(code);
  }

  // Approve a change order (maker-checker): the approver MUST differ from the requester (SOD_SELF_APPROVAL).
  // On approval the contract/budget/EAC deltas are applied to the project AND a new baseline is auto-captured
  // (reason = the CO), so the scope/contract change is authorised, segregated, and re-baselined (ties to PROJ-07).
  async approveChangeOrder(coId: number, user: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const [co] = await db.select().from(projectChangeOrders).where(eq(projectChangeOrders.id, Number(coId))).limit(1);
    if (!co) throw new NotFoundException({ code: 'CHANGE_ORDER_NOT_FOUND', message: `Change order ${coId} not found`, messageTh: 'ไม่พบใบเปลี่ยนแปลง' });
    if (co.status !== 'pending') throw new BadRequestException({ code: 'CHANGE_ORDER_DECIDED', message: `Change order is already ${co.status}`, messageTh: 'ใบเปลี่ยนแปลงถูกตัดสินแล้ว' });
    await assertMakerChecker(db, { user, maker: co.requestedBy, event: 'proj.change-order.approve', ref: String(coId), reason: selfApprovalReason, code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: you cannot approve a change order you requested', messageTh: 'ผู้ขอเปลี่ยนแปลงอนุมัติเองไม่ได้ (แบ่งแยกหน้าที่)', httpStatus: 400 });
    const [proj] = await db.select().from(projects).where(eq(projects.id, Number(co.projectId))).limit(1);
    const newContract = r2(Math.max(0, n(proj!.contractAmount) + n(co.contractDelta)));
    const newBudget = r2(Math.max(0, n(proj!.budgetAmount) + n(co.budgetDelta)));
    const newEst = r2(Math.max(0, n(proj!.estimatedCost) + n(co.estimatedCostDelta)));
    await db.update(projects).set({ contractAmount: fx(newContract, 2), budgetAmount: fx(newBudget, 2), estimatedCost: fx(newEst, 2) }).where(eq(projects.id, Number(proj!.id)));
    await db.update(projectChangeOrders).set({ status: 'approved', approvedBy: user.username, approvedAt: new Date() }).where(eq(projectChangeOrders.id, Number(coId)));
    // Re-baseline so the variance trail records the authorised change (PROJ-07). Best-effort.
    let baseline: any = null;
    try { baseline = await this.captureBaselineFn(proj!.projectCode, { label: `Change order ${co.coNo}`, reason: `Change order ${co.coNo}` }, user); } catch { /* baseline optional */ }
    return { change_order: co.coNo, project_code: proj!.projectCode, status: 'approved', contract_amount: newContract, budget_amount: newBudget, estimated_cost: newEst, baseline: baseline?.baseline ?? null };
  }

  async rejectChangeOrder(coId: number, user: JwtUser) {
    const db = this.db;
    const [co] = await db.select().from(projectChangeOrders).where(eq(projectChangeOrders.id, Number(coId))).limit(1);
    if (!co) throw new NotFoundException({ code: 'CHANGE_ORDER_NOT_FOUND', message: `Change order ${coId} not found`, messageTh: 'ไม่พบใบเปลี่ยนแปลง' });
    if (co.status !== 'pending') throw new BadRequestException({ code: 'CHANGE_ORDER_DECIDED', message: `Change order is already ${co.status}`, messageTh: 'ใบเปลี่ยนแปลงถูกตัดสินแล้ว' });
    const [proj] = await db.select().from(projects).where(eq(projects.id, Number(co.projectId))).limit(1);
    await db.update(projectChangeOrders).set({ status: 'rejected', approvedBy: user.username, approvedAt: new Date() }).where(eq(projectChangeOrders.id, Number(coId)));
    return this.listChangeOrders(proj!.projectCode);
  }

  async listChangeOrders(code: string) {
    const db = this.db;
    const p = await this.rowOf(code);
    const rows = await db.select().from(projectChangeOrders).where(eq(projectChangeOrders.projectId, Number(p.id))).orderBy(desc(projectChangeOrders.id));
    const approved = rows.filter((r: any) => r.status === 'approved');
    return {
      project_code: code, change_orders: rows.map(shapeChangeOrder), count: rows.length,
      summary: {
        pending: rows.filter((r: any) => r.status === 'pending').length,
        approved: approved.length,
        approved_contract_delta: r2(approved.reduce((s: number, r: any) => s + n(r.contractDelta), 0)),
      },
    };
  }
}
