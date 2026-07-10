import { Inject, Injectable, BadRequestException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import {
  projectBoqLines, projectCommitments, projects,
  budgets, budgetControlSettings, budgetCommitments,
  journalEntries, journalLines, items, itemCategories,
  purchaseRequests, prItems, purchaseOrders, poItems,
} from '../../database/schema';
import { ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
const n = (x: unknown) => Number(x ?? 0);
const EPS = 0.005; // half a cent — absorb numeric(16,2) rounding at the boundary

export interface ReserveDto {
  projectId: number;
  boqLineId: number;
  amount: number;
  qty?: number;
  sourceDocType: string;   // PO | PMR | PR | ADV | REIMB
  sourceDocNo: string;
  createdBy?: string;
  tenantId?: number | null;
  // When true (an AUTHORISED over-budget draw — e.g. a PMR the authoriser approved), record the commitment
  // WITHOUT the budget check, so an approved overage is allowed to exceed the line (remaining goes negative,
  // visibly over but authorised). Default false → the ordinary BUDGET_EXCEEDED enforcement applies.
  allowOver?: boolean;
}

// Commitment / encumbrance ledger (M1, docs/32, PROJ-12). The primitive that turns the BoQ-line material
// budget from *observed* into *enforced*: a draw is admitted only if it fits the line's remaining budget
// (`budget − Σ open+consumed commitments`), checked atomically under a FOR UPDATE row-lock on the BoQ line so
// two concurrent draws can't jointly overrun. Standalone (DRIZZLE only) so both procurement and projects can
// depend on it without a module cycle.
@Injectable()
export class CommitmentsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // The project's over-budget tolerance % (FU1). Defaults to 0 (strict) when the project is missing.
  private async tolerancePct(runner: any, projectId: number): Promise<number> {
    const [p] = await runner.select({ v: projects.budgetTolerancePct }).from(projects).where(eq(projects.id, Number(projectId))).limit(1);
    return Math.max(0, n(p?.v));
  }

  // BoQ-line budget picture including the tolerance ceiling (FU1) — used by the PMR routing to decide whether
  // a draw is within tolerance (auto-proceed) or over budget (needs approval). Returns budget / committed /
  // remaining (vs budget) / ceiling (budget × (1+tol%)) / headroom (ceiling − committed).
  async lineBudget(boqLineId: number, projectId: number, tolPctOverride?: number) {
    const [line] = await this.db.select().from(projectBoqLines).where(eq(projectBoqLines.id, Number(boqLineId))).limit(1);
    const budget = r2(n(line?.budgetAmount));
    const committed = await this.committedFor(this.db, Number(boqLineId));
    const tolPct = tolPctOverride != null ? Math.max(0, tolPctOverride) : await this.tolerancePct(this.db, Number(projectId));
    const ceiling = r2(budget * (1 + tolPct / 100));
    return { budget, committed, remaining: r2(budget - committed), tolerance_pct: tolPct, ceiling, headroom: r2(ceiling - committed) };
  }

  // Sum of amounts that count against a BoQ line's budget (open + consumed; released is freed).
  private async committedFor(runner: any, boqLineId: number): Promise<number> {
    const [row] = await runner.select({ v: sql<string>`coalesce(sum(${projectCommitments.amount}),0)` })
      .from(projectCommitments)
      .where(and(eq(projectCommitments.boqLineId, Number(boqLineId)), inArray(projectCommitments.status, ['open', 'consumed'])));
    return r2(n(row?.v));
  }

  // Atomically reserve budget against a BoQ line. MUST run inside a transaction (`runner` = the tx) so the
  // FOR UPDATE lock on the BoQ line serialises concurrent draws. Throws BUDGET_EXCEEDED (with the remaining)
  // when the draw would push open+consumed commitments past the line budget. Returns the new commitment id.
  async reserve(runner: any, dto: ReserveDto): Promise<{ id: number; remaining: number; budget: number; committed: number }> {
    // Lock the BoQ line row for the duration of the tx — no other draw can read-then-write the same line
    // concurrently, which is what closes the "two requests each pass the check then both insert" race.
    const [line] = await runner.select().from(projectBoqLines).where(eq(projectBoqLines.id, Number(dto.boqLineId))).for('update').limit(1);
    if (!line) throw new NotFoundException({ code: 'BOQ_LINE_NOT_FOUND', message: `BoQ line ${dto.boqLineId} not found`, messageTh: 'ไม่พบรายการ BoQ' });
    const budget = r2(n(line.budgetAmount));
    const committed = await this.committedFor(runner, Number(dto.boqLineId));
    const amount = r2(dto.amount);
    // FU1 (docs/32) — over-budget TOLERANCE: a draw may exceed the line budget by up to the project's
    // budget_tolerance_pct % of the line budget before it's blocked. Ceiling = budget × (1 + pct/100).
    const tolPct = await this.tolerancePct(runner, Number(line.projectId));
    const ceiling = r2(budget * (1 + tolPct / 100));
    if (!dto.allowOver && committed + amount > ceiling + EPS) {
      const remaining = r2(Math.max(0, budget - committed));
      throw new BadRequestException({
        code: 'BUDGET_EXCEEDED',
        message: `Draw ${amount} exceeds the BoQ line budget${tolPct > 0 ? ` (incl. ${tolPct}% tolerance → ${ceiling})` : ''}: remaining ${remaining} (budget ${budget}, committed ${committed})`,
        messageTh: `เกินงบรายการ BoQ: ขอเบิก ${amount} แต่คงเหลือ ${remaining} (งบ ${budget} ผูกพันแล้ว ${committed}${tolPct > 0 ? ` เผื่อ ${tolPct}%` : ''})`,
        remaining, budget, committed, tolerance_pct: tolPct, ceiling,
      });
    }
    const [ins] = await runner.insert(projectCommitments).values({
      projectId: Number(dto.projectId), boqLineId: Number(dto.boqLineId), tenantId: dto.tenantId ?? null,
      sourceDocType: dto.sourceDocType, sourceDocNo: dto.sourceDocNo, qty: String(n(dto.qty)), amount: String(amount),
      status: 'open', createdBy: dto.createdBy ?? null,
    }).returning({ id: projectCommitments.id });
    return { id: Number(ins!.id), remaining: r2(budget - committed - amount), budget, committed: r2(committed + amount) };
  }

  // Release every OPEN commitment for a source doc (e.g. a cancelled PO) → frees the budget it held.
  async release(runner: any, sourceDocType: string, sourceDocNo: string): Promise<number> {
    const rows = await runner.update(projectCommitments)
      .set({ status: 'released', updatedAt: new Date() })
      .where(and(eq(projectCommitments.sourceDocType, sourceDocType), eq(projectCommitments.sourceDocNo, sourceDocNo), eq(projectCommitments.status, 'open')))
      .returning({ id: projectCommitments.id });
    return rows.length;
  }

  // Mark a source doc's OPEN commitments consumed (e.g. goods received) — a lifecycle transition; open and
  // consumed both count against the budget, so this doesn't change the remaining.
  async consume(runner: any, sourceDocType: string, sourceDocNo: string): Promise<number> {
    const rows = await runner.update(projectCommitments)
      .set({ status: 'consumed', updatedAt: new Date() })
      .where(and(eq(projectCommitments.sourceDocType, sourceDocType), eq(projectCommitments.sourceDocNo, sourceDocNo), eq(projectCommitments.status, 'open')))
      .returning({ id: projectCommitments.id });
    return rows.length;
  }

  // Per-BoQ-line committed total (open+consumed) for a set of lines — feeds the budget/committed/remaining read
  // model on getBoq. Returns a map lineId → committed amount.
  async committedByLine(boqLineIds: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (!boqLineIds.length) return out;
    const rows = await this.db.select({ line: projectCommitments.boqLineId, v: sql<string>`coalesce(sum(${projectCommitments.amount}),0)` })
      .from(projectCommitments)
      .where(and(inArray(projectCommitments.boqLineId, boqLineIds.map(Number)), inArray(projectCommitments.status, ['open', 'consumed'])))
      .groupBy(projectCommitments.boqLineId);
    for (const r of rows) out.set(Number(r.line), r2(n(r.v)));
    return out;
  }

  // ══ FIN-3 (BUD-02) — GL-budget commitments / encumbrance for NON-project procurement ═══════════════════
  // The same engine philosophy as the BoQ commitments above, keyed on the GL budget line
  // (fiscal_year/period, account_code, cost_center) instead of a BoQ line. The PR/PO approval gate calls
  // glGate() (policy: off | advise | warn | block), the approval records a commitment via glReserve(), and
  // the doc lifecycle releases/consumes it (convert / cancel / close-short → glRelease; full receipt →
  // glConsume). Availability = approved budget (fiscal-YTD) − GL actuals (YTD) − open commitments.
  // Scope: only accounts WITH an approved budget for the fiscal year are enforced (unbudgeted accounts are
  // annotated, never blocked — unbudgeted spend is caught by the ELC-06 variance review); project/BoQ-tagged
  // lines are excluded (PROJ-12/13 already encumber them) as are is_capital lines (CAPEX ≠ opex budget).

  async glControlSettings(tenantId: number | null) {
    const [row] = tenantId != null
      ? await this.db.select().from(budgetControlSettings).where(eq(budgetControlSettings.tenantId, tenantId)).limit(1)
      : await this.db.select().from(budgetControlSettings).where(isNull(budgetControlSettings.tenantId)).limit(1);
    return {
      policy: (row?.policy ?? 'off') as 'off' | 'advise' | 'warn' | 'block',
      default_expense_account: row?.defaultExpenseAccount ?? '5000',
      updated_by: row?.updatedBy ?? null,
      updated_at: row?.updatedAt ?? null,
    };
  }

  // Change control mirrors receiving_settings/EXP-04: endpoint-gated to exec/gl_close; updated_by audited.
  async glUpdateControlSettings(dto: { policy?: string; default_expense_account?: string }, user: JwtUser) {
    if (dto.policy != null && !['off', 'advise', 'warn', 'block'].includes(dto.policy)) {
      throw new BadRequestException({ code: 'BAD_POLICY', message: `policy must be off|advise|warn|block`, messageTh: 'นโยบายต้องเป็น off|advise|warn|block' });
    }
    const [ex] = await this.db.select().from(budgetControlSettings)
      .where(user.tenantId != null ? eq(budgetControlSettings.tenantId, user.tenantId) : isNull(budgetControlSettings.tenantId)).limit(1);
    const vals: Record<string, unknown> = { updatedBy: user.username, updatedAt: new Date() };
    if (dto.policy != null) vals.policy = dto.policy;
    if (dto.default_expense_account != null && dto.default_expense_account.trim()) vals.defaultExpenseAccount = dto.default_expense_account.trim();
    if (ex) await this.db.update(budgetControlSettings).set(vals).where(eq(budgetControlSettings.id, ex.id));
    else await this.db.insert(budgetControlSettings).values({ tenantId: user.tenantId ?? null, ...vals });
    return this.glControlSettings(user.tenantId ?? null);
  }

  // Budget account per item: item.cogs_account → its category's cogs_account → the tenant default. This is
  // deliberately independent of the posting_determination feature flag — the budget-control policy is its
  // own switch; a tenant that turns the gate on gets the item/category mapping without opting into GL-21.
  async glResolveAccounts(itemIds: string[], defaultAccount: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ids = [...new Set(itemIds.filter(Boolean))];
    if (!ids.length) return out;
    const rows = await this.db.select({ itemId: items.itemId, own: items.cogsAccount, cat: itemCategories.cogsAccount })
      .from(items).leftJoin(itemCategories, eq(items.categoryId, itemCategories.id))
      .where(inArray(items.itemId, ids));
    for (const r of rows) out.set(String(r.itemId), r.own ?? r.cat ?? defaultAccount);
    return out;
  }

  // Availability for ONE budget key, fiscal-year-to-date through `period` (YYYY-MM, business calendar):
  // budget = Σ approved budget lines (year start … period); actual = Σ Posted journal lines (debit − credit,
  // expense natural balance) over the same window; open commitments = Σ open budget_commitments in the year
  // through the period. has_budget=false ⇒ no approved budget line exists for the year → not enforced.
  async glAvailability(tenantId: number | null, accountCode: string, costCenter: string | null, period: string) {
    const fiscalYear = Number(period.slice(0, 4));
    const yearStart = `${fiscalYear}-01`;
    const budConds = [eq(budgets.fiscalYear, fiscalYear), eq(budgets.accountCode, accountCode), eq(budgets.status, 'Approved'),
      costCenter ? eq(budgets.costCenterCode, costCenter) : isNull(budgets.costCenterCode)];
    const [yearBudget] = await this.db.select({ v: sql<string>`coalesce(sum(${budgets.amount}),0)`, c: sql<string>`count(*)` })
      .from(budgets).where(and(...budConds));
    const [ytdBudget] = await this.db.select({ v: sql<string>`coalesce(sum(${budgets.amount}),0)` })
      .from(budgets).where(and(...budConds, lte(budgets.period, period)));
    const hasBudget = Number(yearBudget?.c ?? 0) > 0;

    // Actuals: Posted journal lines, entry_date within [year start, end of the period month].
    const y = Number(period.slice(0, 4)), m = Number(period.slice(5, 7));
    const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const actConds = [eq(journalEntries.status, 'Posted'), eq(journalLines.accountCode, accountCode),
      gte(journalEntries.entryDate, `${fiscalYear}-01-01`), lt(journalEntries.entryDate, nextMonth)];
    if (costCenter) actConds.push(eq(journalLines.costCenterCode, costCenter));
    const [act] = await this.db.select({ d: sql<string>`coalesce(sum(${journalLines.debit}),0)`, c: sql<string>`coalesce(sum(${journalLines.credit}),0)` })
      .from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id)).where(and(...actConds));
    const actual = r2(n(act?.d) - n(act?.c)); // expense natural balance

    const commitConds = [eq(budgetCommitments.fiscalYear, fiscalYear), eq(budgetCommitments.accountCode, accountCode),
      eq(budgetCommitments.status, 'open'), lte(budgetCommitments.period, period),
      costCenter ? eq(budgetCommitments.costCenterCode, costCenter) : isNull(budgetCommitments.costCenterCode)];
    if (tenantId != null) commitConds.push(eq(budgetCommitments.tenantId, tenantId));
    const [com] = await this.db.select({ v: sql<string>`coalesce(sum(${budgetCommitments.amount}),0)` })
      .from(budgetCommitments).where(and(...commitConds));
    const openCommitments = r2(n(com?.v));

    const budgetYtd = r2(n(ytdBudget?.v));
    return {
      fiscal_year: fiscalYear, period, account_code: accountCode, cost_center: costCenter ?? null,
      has_budget: hasBudget, budget_year: r2(n(yearBudget?.v)), budget_ytd: budgetYtd,
      actual_ytd: actual, open_commitments: openCommitments, available: r2(budgetYtd - actual - openCommitments),
    };
  }

  // The gate. Called at PR/PO approval with the doc's gate-relevant lines (project/BoQ + capital lines
  // pre-filtered by the caller). Returns null when the policy is 'off' (zero behaviour change — the approve
  // response stays byte-identical) or nothing is gateable; otherwise returns the evaluation for the response
  // annotation + the later glReserve. Throws per policy: block → BUDGET_EXCEEDED (unless an exec override
  // with a reason — BUDGET_OVERRIDE_DENIED / BUDGET_OVERRIDE_REASON_REQUIRED); warn → BUDGET_CONFIRM_REQUIRED
  // unless the approver passed confirm_over_budget.
  async glGateForDoc(docType: 'PR' | 'PO', docNo: string, args: {
    tenantId: number | null; user: JwtUser; confirm?: boolean; override?: boolean; overrideReason?: string;
  }) {
    // Policy first — with the default 'off' the approval path does no further work (and no line loads).
    const settings = await this.glControlSettings(args.tenantId);
    if (settings.policy === 'off') return null;
    return this.glGate({ ...args, lines: await this.glGateLinesFor(docType, docNo) });
  }

  async glGate(args: {
    tenantId: number | null; lines: { item_id: string | null; amount: number }[]; user: JwtUser;
    confirm?: boolean; override?: boolean; overrideReason?: string;
  }) {
    const settings = await this.glControlSettings(args.tenantId);
    if (settings.policy === 'off') return null;
    const lines = args.lines.filter((l) => n(l.amount) > 0);
    if (!lines.length) return null;
    const period = ymd().slice(0, 7); // approval business month (Asia/Bangkok)
    const accounts = await this.glResolveAccounts(lines.map((l) => l.item_id ?? '').filter(Boolean), settings.default_expense_account);
    const byAccount = new Map<string, number>();
    for (const l of lines) {
      const acc = (l.item_id && accounts.get(l.item_id)) || settings.default_expense_account;
      byAccount.set(acc, r2((byAccount.get(acc) ?? 0) + n(l.amount)));
    }
    const checks: any[] = [];
    for (const [acc, docAmount] of byAccount) {
      const a = await this.glAvailability(args.tenantId, acc, null, period);
      checks.push({ ...a, doc_amount: docAmount, exceeded: a.has_budget && docAmount > a.available + EPS });
    }
    const exceeded = checks.some((c) => c.exceeded);
    let overridden = false;
    if (exceeded) {
      if (args.override) {
        // Exec override (BUD-02): a DISTINCT duty from the ordinary approver — reason required, audited on
        // the commitment row + doc status log. Mirrors PROJ-13's authorised over-budget draw.
        const isExec = args.user.role === 'Admin' || (args.user.permissions ?? []).includes('exec');
        if (!isExec) throw new ForbiddenException({ code: 'BUDGET_OVERRIDE_DENIED', message: 'Over-budget override requires the exec duty', messageTh: 'การอนุมัติเกินงบต้องใช้สิทธิ์ผู้บริหาร (exec)', checks });
        if (!args.overrideReason?.trim()) throw new BadRequestException({ code: 'BUDGET_OVERRIDE_REASON_REQUIRED', message: 'An override reason is required', messageTh: 'ต้องระบุเหตุผลการอนุมัติเกินงบ', checks });
        overridden = true;
      } else if (settings.policy === 'block') {
        throw new UnprocessableEntityException({ code: 'BUDGET_EXCEEDED', message: `Approval exceeds the available budget (${checks.filter((c) => c.exceeded).map((c) => `${c.account_code}: available ${c.available}, doc ${c.doc_amount}`).join('; ')})`, messageTh: 'ยอดอนุมัติเกินงบประมาณคงเหลือ — ต้องให้ผู้บริหาร (exec) อนุมัติเกินงบพร้อมเหตุผล', checks });
      } else if (settings.policy === 'warn' && !args.confirm) {
        throw new UnprocessableEntityException({ code: 'BUDGET_CONFIRM_REQUIRED', message: 'Approval exceeds the available budget — resubmit with confirm_over_budget:true to proceed', messageTh: 'ยอดอนุมัติเกินงบประมาณคงเหลือ — ยืนยันการอนุมัติเกินงบอีกครั้ง (confirm_over_budget)', checks });
      }
    }
    return {
      policy: settings.policy, period, exceeded, overridden,
      override_reason: overridden ? args.overrideReason!.trim() : null, checks,
    };
  }

  // Record the approved doc's commitments (one row per budget account). Runs AFTER the doc lands Approved.
  // Idempotent per source doc: a re-approval of an already-committed doc records nothing.
  async glReserve(runner: any, gate: NonNullable<Awaited<ReturnType<CommitmentsService['glGate']>>>, args: { docType: 'PR' | 'PO'; docNo: string; tenantId: number | null; user: JwtUser }) {
    const [dup] = await runner.select({ id: budgetCommitments.id }).from(budgetCommitments)
      .where(and(eq(budgetCommitments.sourceDocType, args.docType), eq(budgetCommitments.sourceDocNo, args.docNo), inArray(budgetCommitments.status, ['open', 'consumed']))).limit(1);
    if (dup) return 0;
    for (const c of gate.checks) {
      await runner.insert(budgetCommitments).values({
        tenantId: args.tenantId ?? null, fiscalYear: Number(c.fiscal_year), period: gate.period,
        accountCode: c.account_code, costCenterCode: null,
        sourceDocType: args.docType, sourceDocNo: args.docNo, amount: String(r2(c.doc_amount)),
        status: 'open', overBudget: c.exceeded === true,
        overrideBy: gate.overridden && c.exceeded ? args.user.username : null,
        overrideReason: gate.overridden && c.exceeded ? gate.override_reason : null,
        createdBy: args.user.username,
      });
    }
    return gate.checks.length;
  }

  // Lifecycle transitions (mirror release/consume above). No-ops when the doc has no GL commitment
  // (policy was off at approval time) — safe to call unconditionally from the procurement flows.
  async glRelease(runner: any, sourceDocType: string, sourceDocNo: string): Promise<number> {
    const rows = await runner.update(budgetCommitments)
      .set({ status: 'released', updatedAt: new Date() })
      .where(and(eq(budgetCommitments.sourceDocType, sourceDocType), eq(budgetCommitments.sourceDocNo, sourceDocNo), eq(budgetCommitments.status, 'open')))
      .returning({ id: budgetCommitments.id });
    return rows.length;
  }

  async glConsume(runner: any, sourceDocType: string, sourceDocNo: string): Promise<number> {
    const rows = await runner.update(budgetCommitments)
      .set({ status: 'consumed', updatedAt: new Date() })
      .where(and(eq(budgetCommitments.sourceDocType, sourceDocType), eq(budgetCommitments.sourceDocNo, sourceDocNo), eq(budgetCommitments.status, 'open')))
      .returning({ id: budgetCommitments.id });
    return rows.length;
  }

  // Read model for the approval-surface chip: evaluate a PR/PO's budget picture WITHOUT deciding anything.
  // PR lines are priced from the item master (requisitions carry no prices); PO lines use their amounts.
  // Project/BoQ-tagged and is_capital lines are excluded, mirroring the gate.
  async glDocPreview(docType: 'PR' | 'PO', docNo: string, tenantId: number | null) {
    const settings = await this.glControlSettings(tenantId);
    if (settings.policy === 'off') return { policy: 'off', checks: [], exceeded: false };
    const lines = await this.glGateLinesFor(docType, docNo);
    return this.glPreviewChecks(settings, tenantId, lines);
  }

  private async glPreviewChecks(settings: { policy: string; default_expense_account: string }, tenantId: number | null, lines: { item_id: string | null; amount: number }[]) {
    const period = ymd().slice(0, 7);
    const accounts = await this.glResolveAccounts(lines.map((l) => l.item_id ?? '').filter(Boolean), settings.default_expense_account);
    const byAccount = new Map<string, number>();
    for (const l of lines.filter((x) => n(x.amount) > 0)) {
      const acc = (l.item_id && accounts.get(l.item_id)) || settings.default_expense_account;
      byAccount.set(acc, r2((byAccount.get(acc) ?? 0) + n(l.amount)));
    }
    const checks: any[] = [];
    for (const [acc, docAmount] of byAccount) {
      const a = await this.glAvailability(tenantId, acc, null, period);
      checks.push({ ...a, doc_amount: docAmount, exceeded: a.has_budget && docAmount > a.available + EPS });
    }
    return { policy: settings.policy, checks, exceeded: checks.some((c) => c.exceeded) };
  }

  // The gate-relevant lines of a PR/PO (excludes BoQ-tagged + capital lines; PR lines priced from the item
  // master). Shared by the preview above; the approval path builds the same shape from the doc it loaded.
  async glGateLinesFor(docType: 'PR' | 'PO', docNo: string): Promise<{ item_id: string | null; amount: number }[]> {
    if (docType === 'PO') {
      const [po] = await this.db.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.poNo, docNo)).limit(1);
      if (!po) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found', messageTh: 'ไม่พบ PO' });
      const rows = await this.db.select().from(poItems).where(eq(poItems.poId, Number(po.id)));
      return rows.filter((l: any) => l.boqLineId == null && l.isCapital !== true)
        .map((l: any) => ({ item_id: l.itemId ?? null, amount: r2(l.amount != null ? n(l.amount) : n(l.orderQty) * n(l.unitPrice)) }));
    }
    const [pr] = await this.db.select({ id: purchaseRequests.id }).from(purchaseRequests).where(eq(purchaseRequests.prNo, docNo)).limit(1);
    if (!pr) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PR not found', messageTh: 'ไม่พบ PR' });
    const rows = await this.db.select().from(prItems).where(eq(prItems.prId, Number(pr.id)));
    const gateRows = rows.filter((l: any) => l.boqLineId == null);
    const ids = [...new Set(gateRows.map((l: any) => l.itemId).filter(Boolean) as string[])];
    const priceMap = new Map<string, number>();
    if (ids.length) {
      const im = await this.db.select({ itemId: items.itemId, price: items.unitPrice }).from(items).where(inArray(items.itemId, ids));
      for (const r of im) priceMap.set(String(r.itemId), n(r.price));
    }
    return gateRows.map((l: any) => ({ item_id: l.itemId ?? null, amount: r2(n(l.requestQty) * (priceMap.get(String(l.itemId)) ?? 0)) }));
  }

  // Commitment rows for a budget key (audit/read model — override evidence included).
  async glListCommitments(tenantId: number | null, q: { account?: string; period?: string; source_doc_no?: string; status?: string }) {
    const conds: any[] = [];
    if (tenantId != null) conds.push(eq(budgetCommitments.tenantId, tenantId));
    if (q.account) conds.push(eq(budgetCommitments.accountCode, q.account));
    if (q.period) conds.push(eq(budgetCommitments.period, q.period));
    if (q.source_doc_no) conds.push(eq(budgetCommitments.sourceDocNo, q.source_doc_no));
    if (q.status) conds.push(eq(budgetCommitments.status, q.status));
    const rows = await this.db.select().from(budgetCommitments).where(conds.length ? and(...conds) : undefined).orderBy(sql`${budgetCommitments.id} desc`).limit(200);
    return {
      commitments: rows.map((r: any) => ({
        id: Number(r.id), fiscal_year: Number(r.fiscalYear), period: r.period, account_code: r.accountCode,
        cost_center_code: r.costCenterCode, source_doc_type: r.sourceDocType, source_doc_no: r.sourceDocNo,
        amount: n(r.amount), status: r.status, over_budget: r.overBudget === true,
        override_by: r.overrideBy ?? null, override_reason: r.overrideReason ?? null,
        created_by: r.createdBy, created_at: r.createdAt,
      })),
      count: rows.length,
    };
  }

  // Commitment rows for a project (newest first) + a status summary — the project commitments read model.
  async listForProject(projectId: number) {
    const rows = await this.db.select().from(projectCommitments)
      .where(eq(projectCommitments.projectId, Number(projectId)))
      .orderBy(sql`${projectCommitments.id} desc`);
    const sum = (st: string) => r2(rows.filter((r: any) => r.status === st).reduce((s: number, r: any) => s + n(r.amount), 0));
    return {
      commitments: rows.map((r: any) => ({
        id: Number(r.id), boq_line_id: Number(r.boqLineId), source_doc_type: r.sourceDocType, source_doc_no: r.sourceDocNo,
        qty: n(r.qty), amount: n(r.amount), status: r.status, created_by: r.createdBy, created_at: r.createdAt,
      })),
      count: rows.length,
      summary: { open: sum('open'), consumed: sum('consumed'), released: sum('released'), committed: r2(sum('open') + sum('consumed')) },
    };
  }
}
