import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { projects, projectBoq, projectBoqLines, projectMaterialRequisitions, pmrLines, items } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { CommitmentsService } from '../commitments/commitments.service';
import { ProcurementService } from '../procurement/procurement.service';
import { WorkflowService } from '../workflow/workflow.service';
import { LineNotifyService, buildApproveCard } from '../messaging/line-notify.service';
import { ReservationsService } from '../reservations/reservations.service';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
const n = (x: unknown) => Number(x ?? 0);
const EPS = 0.005;

export interface PmrLineDto { boq_line_id: number; item_no?: string; qty: number; unit_cost: number }
export interface PmrSubmitDto { project_code: string; items: PmrLineDto[]; vendor_name?: string }
// A shoppable BoQ line for the project-shop shelf (approved-budget material line + remaining budget).
export interface ShelfLine { boq_line_id: number; item_no: string; item_description: string | null; uom: string | null; rate: number; budget: number; committed: number; remaining: number; image_key: string | null }

// Project Material Requisition (PMR) — M2, docs/32, PROJ-13. The one document by which site staff draw
// material against a project's BoQ. Decision tree on submit:
//   WITHIN budget  → a project-tagged PR is raised for procurement to buy (route 'pr', status 'routed').
//   OVER  budget   → parked 'pending' + an authoriser is asked to approve (maker-checker + one-tap LINE card).
//                    On approval the overage is AUTHORISED and a project-tagged Draft PO is auto-drafted
//                    (route 'po') for procurement — the authorised over-budget commitment is booked.
@Injectable()
export class PmrService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly commitments: CommitmentsService,
    private readonly procurement: ProcurementService,
    @Optional() private readonly workflow?: WorkflowService,       // optional so partial harnesses still build
    @Optional() private readonly lineNotify?: LineNotifyService,   // best-effort LINE approval card
    @Optional() private readonly reservations?: ReservationsService, // FU2 — within-budget: prefer on-hand stock
  ) {}

  // FU2 (docs/32) — try to fulfil a within-budget requisition from ON-HAND STOCK before buying: if EVERY line's
  // item has enough available stock (on_hand − held) at the default location, reserve all lines then issue them
  // to the project (→ project WIP). All-or-nothing: on any shortfall/failure it releases holds and returns false
  // so the caller falls back to raising a PR. Never throws.
  private async tryStockFulfil(projectCode: string, items: PmrLineDto[], user: JwtUser): Promise<{ ok: boolean; moves: string[] }> {
    if (!this.reservations) return { ok: false, moves: [] };
    const loc = 'WH-MAIN';
    const need = new Map<string, number>();
    for (const it of items) {
      if (!it.item_no) return { ok: false, moves: [] };   // a line with no item can't come from stock
      need.set(it.item_no, r2((need.get(it.item_no) ?? 0) + n(it.qty)));
    }
    for (const [itemNo, qty] of need) {
      const av = await this.reservations.available(user, itemNo, loc).catch(() => null);
      if (!av || av.available + EPS < qty) return { ok: false, moves: [] };
    }
    const holds: number[] = [];
    try {
      for (const it of items) {
        const r = await this.reservations.reserve({ project_code: projectCode, item_id: it.item_no!, location_id: loc, qty: n(it.qty), boq_line_id: it.boq_line_id }, user);
        holds.push(r.reservation_id);
      }
      const moves: string[] = [];
      for (const id of holds) { const m = await this.reservations.issueToProject(id, user); moves.push(m.move_no); }
      return { ok: true, moves };
    } catch {
      for (const id of holds) { try { await this.reservations.release(id, user); } catch { /* best-effort */ } }
      return { ok: false, moves: [] };
    }
  }

  private async projectRow(code: string) {
    const [p] = await this.db.select().from(projects).where(eq(projects.projectCode, code)).limit(1);
    if (!p) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: `Project ${code} not found`, messageTh: 'ไม่พบโครงการ' });
    return p;
  }

  private async pmrRow(pmrNo: string) {
    const [m] = await this.db.select().from(projectMaterialRequisitions).where(eq(projectMaterialRequisitions.pmrNo, pmrNo)).limit(1);
    if (!m) throw new NotFoundException({ code: 'PMR_NOT_FOUND', message: `PMR ${pmrNo} not found`, messageTh: 'ไม่พบใบขอเบิกวัสดุ' });
    return m;
  }

  async submit(dto: PmrSubmitDto, user: JwtUser) {
    if (!dto.items?.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No items', messageTh: 'ไม่มีรายการ' });
    const p = await this.projectRow(dto.project_code);
    const projectId = Number(p.id);
    const tenantId = p.tenantId ?? user.tenantId ?? null;

    // Load the referenced BoQ lines (must belong to this project) + their committed totals → remaining budget.
    const lineIds = [...new Set(dto.items.map((it) => Number(it.boq_line_id)))];
    const boqRows = await this.db.select().from(projectBoqLines).where(inArray(projectBoqLines.id, lineIds));
    const boqById = new Map<number, any>(boqRows.map((l: any) => [Number(l.id), l]));
    for (const id of lineIds) {
      const l = boqById.get(id);
      if (!l || Number(l.projectId) !== projectId) throw new BadRequestException({ code: 'BOQ_LINE_NOT_IN_PROJECT', message: `BoQ line ${id} is not on project ${dto.project_code}`, messageTh: 'รายการ BoQ ไม่ได้อยู่ในโครงการนี้' });
    }
    const committedByLine = await this.commitments.committedByLine(lineIds);
    const committedRun = new Map<number, number>(lineIds.map((id) => [id, committedByLine.get(id) ?? 0]));
    // FU1 (docs/32) — a draw is "over budget" (needs approval) only if it exceeds the BoQ line's TOLERANCE
    // ceiling (budget × (1 + project tolerance %)); a small overage within tolerance auto-proceeds.
    const tolPct = Math.max(0, n(p.budgetTolerancePct));

    // Evaluate each requested line against the remaining budget (+ tolerance headroom) of its BoQ line.
    let estTotal = 0, overAmount = 0, anyOver = false;
    const evaluated = dto.items.map((it) => {
      const est = r2(n(it.qty) * n(it.unit_cost));
      const id = Number(it.boq_line_id);
      const budget = r2(n(boqById.get(id).budgetAmount));
      const committed = committedRun.get(id) ?? 0;
      const remaining = r2(budget - committed);                 // vs budget (reported on the line)
      const headroom = r2(budget * (1 + tolPct / 100) - committed); // vs the tolerance ceiling
      const over = est > headroom + EPS;
      const lineOver = over ? r2(est - Math.max(0, headroom)) : 0;
      estTotal = r2(estTotal + est); overAmount = r2(overAmount + lineOver); anyOver = anyOver || over;
      committedRun.set(id, r2(committed + est));                // cumulative for repeated lines
      return { it, est, remaining, over };
    });

    const pmrNo = await this.docNo.nextDaily('PMR');
    const [h] = await this.db.insert(projectMaterialRequisitions).values({
      projectId, tenantId, pmrNo, status: anyOver ? 'pending' : 'routed', route: anyOver ? 'po' : 'pr',
      overBudget: anyOver, estCost: String(estTotal), overAmount: String(overAmount), requestedBy: user.username,
    }).returning({ id: projectMaterialRequisitions.id });
    for (const e of evaluated) {
      await this.db.insert(pmrLines).values({
        pmrId: Number(h!.id), boqLineId: Number(e.it.boq_line_id), tenantId, itemNo: e.it.item_no ?? null,
        qty: String(n(e.it.qty)), unitCost: String(n(e.it.unit_cost)), estCost: String(e.est), remaining: String(e.remaining), overBudget: e.over,
      });
    }

    if (!anyOver) {
      // FU2 — within budget: prefer fulfilling from ON-HAND STOCK (reserve → issue to project WIP). Only if the
      // stock isn't there do we raise a project-tagged PR for procurement to buy (the ordinary path).
      const stock = await this.tryStockFulfil(dto.project_code, dto.items, user);
      if (stock.ok) {
        await this.db.update(projectMaterialRequisitions).set({ route: 'issue', linkedDocNo: stock.moves.filter(Boolean).join(',') || null }).where(eq(projectMaterialRequisitions.id, Number(h!.id)));
      } else {
        const pr = await this.procurement.createPr({
          project_code: dto.project_code, remarks: `PMR ${pmrNo}`, amount: estTotal,
          items: dto.items.map((it) => ({ item_id: it.item_no ?? 'MATERIAL', request_qty: n(it.qty), boq_line_id: Number(it.boq_line_id), reason: `PMR ${pmrNo}` })),
        }, user);
        await this.db.update(projectMaterialRequisitions).set({ linkedDocNo: pr.pr_no }).where(eq(projectMaterialRequisitions.id, Number(h!.id)));
      }
    } else {
      // Over budget → route to an authoriser: open a workflow instance (if a PMR definition is configured) and
      // push the one-tap LINE approval card to permission holders (best-effort; the maker is excluded, SoD).
      await this.workflow?.start({ docType: 'PMR', docNo: pmrNo, amount: overAmount, createdBy: user.username, tenantId: tenantId ?? null });
      const text = `🔔 ใบขอเบิกวัสดุ ${pmrNo} เกินงบ BoQ ${overAmount.toLocaleString()} บาท — รออนุมัติ (โครงการ ${dto.project_code})`;
      await this.lineNotify?.notifyPermissionHolders(['procurement', 'exec'], tenantId, text, user.username, 20, buildApproveCard('PMR', pmrNo, user.username));
    }
    return this.get(pmrNo);
  }

  // Approve an over-budget PMR (maker-checker: approver ≠ requester → SOD_SELF_APPROVAL). On approval the
  // overage is authorised and a project-tagged Draft PO is auto-drafted (procurement then reviews + buys).
  async approve(pmrNo: string, user: JwtUser) {
    const m = await this.pmrRow(pmrNo);
    if (m.status !== 'pending') throw new BadRequestException({ code: 'PMR_NOT_PENDING', message: `PMR is ${m.status}, not pending`, messageTh: 'ใบขอเบิกไม่ได้อยู่สถานะรออนุมัติ' });
    if (m.requestedBy && m.requestedBy === user.username) throw new BadRequestException({ code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: you cannot approve a PMR you requested', messageTh: 'ผู้ขอเบิกอนุมัติเองไม่ได้ (แบ่งแยกหน้าที่)' });
    // Route the decision through the engine when a PMR workflow instance is live (multi-step/SoD enforced there).
    if (this.workflow) {
      const inst = await this.workflow.pendingInstanceFor('PMR', pmrNo);
      if (inst) await this.workflow.act(Number(inst.id), { decision: 'approve' }, user);
    }
    const [proj] = await this.db.select().from(projects).where(eq(projects.id, Number(m.projectId))).limit(1);
    const lines = await this.db.select().from(pmrLines).where(eq(pmrLines.pmrId, Number(m.id)));
    // Auto-draft a project-tagged PO (Draft) — authorised to exceed the BoQ line budget (the approval IS the
    // authorisation). Procurement reviews the Draft and submits it into the normal PO approval to actually buy.
    const po = await this.procurement.createPo({
      project_id: Number(m.projectId), draft: true, authorized_over_budget: true, remarks: `PMR ${pmrNo} (อนุมัติเกินงบ)`,
      items: lines.map((l: any) => ({ item_id: l.itemNo ?? 'MATERIAL', order_qty: n(l.qty), unit_price: n(l.unitCost), boq_line_id: Number(l.boqLineId) })),
    }, user);
    await this.db.update(projectMaterialRequisitions).set({ status: 'approved', approvedBy: user.username, approvedAt: new Date(), linkedDocNo: po.po_no }).where(eq(projectMaterialRequisitions.id, Number(m.id)));
    await this.lineNotify?.notifyUser(m.requestedBy ?? '', m.tenantId ?? null, `✅ ใบขอเบิกวัสดุ ${pmrNo} อนุมัติแล้ว — ร่างใบสั่งซื้อ ${po.po_no} ให้ฝ่ายจัดซื้อดำเนินการ`);
    return this.get(pmrNo);
  }

  async reject(pmrNo: string, reason: string, user: JwtUser) {
    const m = await this.pmrRow(pmrNo);
    if (m.status !== 'pending') throw new BadRequestException({ code: 'PMR_NOT_PENDING', message: `PMR is ${m.status}, not pending`, messageTh: 'ใบขอเบิกไม่ได้อยู่สถานะรออนุมัติ' });
    if (m.requestedBy && m.requestedBy === user.username) throw new BadRequestException({ code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: you cannot reject a PMR you requested', messageTh: 'ผู้ขอเบิกปฏิเสธเองไม่ได้' });
    if (this.workflow) {
      const inst = await this.workflow.pendingInstanceFor('PMR', pmrNo);
      if (inst) await this.workflow.act(Number(inst.id), { decision: 'reject' }, user);
      else await this.workflow.cancel('PMR', pmrNo);
    }
    await this.db.update(projectMaterialRequisitions).set({ status: 'rejected', approvedBy: user.username, approvedAt: new Date(), rejectionReason: reason || null }).where(eq(projectMaterialRequisitions.id, Number(m.id)));
    await this.lineNotify?.notifyUser(m.requestedBy ?? '', m.tenantId ?? null, `❌ ใบขอเบิกวัสดุ ${pmrNo} ถูกปฏิเสธ${reason ? ` — ${reason}` : ''}`);
    return this.get(pmrNo);
  }

  async get(pmrNo: string) {
    const m = await this.pmrRow(pmrNo);
    const [proj] = await this.db.select({ c: projects.projectCode }).from(projects).where(eq(projects.id, Number(m.projectId))).limit(1);
    const lines = await this.db.select().from(pmrLines).where(eq(pmrLines.pmrId, Number(m.id)));
    return {
      pmr_no: m.pmrNo, project_code: proj?.c ?? null, status: m.status, route: m.route, over_budget: m.overBudget,
      est_cost: n(m.estCost), over_amount: n(m.overAmount), linked_doc_no: m.linkedDocNo,
      requested_by: m.requestedBy, approved_by: m.approvedBy, rejection_reason: m.rejectionReason, created_at: m.createdAt,
      lines: lines.map((l: any) => ({ id: Number(l.id), boq_line_id: Number(l.boqLineId), item_no: l.itemNo, qty: n(l.qty), unit_cost: n(l.unitCost), est_cost: n(l.estCost), remaining: n(l.remaining), over_budget: l.overBudget })),
    };
  }

  // ── Shop-for-a-project read model (pr_raise-safe) ────────────────────────────────────────────────
  // The requisition-raiser (`pr_raise`) can browse WHAT a project's approved budget allows, and only that —
  // the projects/BoQ endpoints proper are exec/planner/ar-gated, so these two thin reads expose ONLY the
  // shoppable slice (project code+name, and the approved BoQ's material lines with remaining budget). No
  // financials/EVM leak. A requester cannot cart an item that is not on the approved BoQ (see PROJ-12/13,
  // enforced on submit() above), so the shop restricts them to exactly these lines.

  // Active projects whose latest BoQ is approved/locked — i.e. the projects a requester can shop into.
  async shoppableProjects() {
    const rows = await this.db
      .select({ code: projects.projectCode, name: projects.name, status: projects.status, boqStatus: projectBoq.status })
      .from(projects)
      .innerJoin(projectBoq, eq(projectBoq.projectId, projects.id))
      .where(and(inArray(projectBoq.status, ['approved', 'locked']), sql`${projects.status} <> 'Closed'`));
    // A project can carry several approved BoQ versions — one shoppable entry per project code.
    const seen = new Map<string, { code: string; name: string; status: string }>();
    for (const r of rows) if (!seen.has(r.code)) seen.set(r.code, { code: r.code, name: r.name, status: r.status });
    const list = [...seen.values()].sort((a, b) => a.code.localeCompare(b.code));
    return { projects: list, count: list.length };
  }

  // The approved BoQ's material lines (itemNo set) for a project, each with budget / committed / remaining —
  // the "shelf" a requester shops from. Falls back to an empty shelf (no approved BoQ ⇒ nothing shoppable).
  async shoppableBoq(code: string) {
    const p = await this.projectRow(code);
    const [boq] = await this.db.select().from(projectBoq)
      .where(and(eq(projectBoq.projectId, Number(p.id)), inArray(projectBoq.status, ['approved', 'locked'])))
      .orderBy(desc(projectBoq.id)).limit(1);
    if (!boq) return { project_code: code, project_name: p.name, boq_no: null as string | null, boq_status: null as string | null, tolerance_pct: r2(n(p.budgetTolerancePct)), lines: [] as ShelfLine[], budget_total: 0, committed_total: 0, remaining_total: 0 };
    const rawLines = await this.db.select().from(projectBoqLines)
      .where(and(eq(projectBoqLines.boqId, Number(boq.id)), sql`${projectBoqLines.itemNo} is not null`))
      .orderBy(projectBoqLines.lineNo);
    const lineIds = rawLines.map((l: any) => Number(l.id));
    const committedByLine = await this.commitments.committedByLine(lineIds);
    // Enrich each line with the item master (description / uom / image) for a Grab/Shopee-style card.
    const itemNos = [...new Set(rawLines.map((l: any) => l.itemNo).filter(Boolean) as string[])];
    const itemRows = itemNos.length
      ? await this.db.select({ itemId: items.itemId, desc: items.itemDescription, uom: items.uom, imageKey: items.imageKey }).from(items).where(inArray(items.itemId, itemNos))
      : [];
    const itemBy = new Map(itemRows.map((r: any) => [r.itemId, r]));
    let bt = 0, ct = 0;
    const lines = rawLines.map((l: any) => {
      const budget = r2(l.budgetAmount);
      const committed = r2(committedByLine.get(Number(l.id)) ?? 0);
      const remaining = r2(budget - committed);
      bt = r2(bt + budget); ct = r2(ct + committed);
      const im = itemBy.get(l.itemNo);
      return {
        boq_line_id: Number(l.id), item_no: l.itemNo as string,
        item_description: l.description ?? im?.desc ?? l.itemNo, uom: l.uom ?? im?.uom ?? '',
        rate: r2(l.rate), budget, committed, remaining, image_key: im?.imageKey ?? null,
      };
    });
    return { project_code: code, project_name: p.name, boq_no: boq.boqNo, boq_status: boq.status, tolerance_pct: r2(n(p.budgetTolerancePct)), lines, budget_total: bt, committed_total: ct, remaining_total: r2(bt - ct) };
  }

  // PMRs for a project (newest first) — the requisition list / approval inbox feed.
  async listForProject(code: string) {
    const p = await this.projectRow(code);
    const rows = await this.db.select().from(projectMaterialRequisitions).where(eq(projectMaterialRequisitions.projectId, Number(p.id))).orderBy(desc(projectMaterialRequisitions.id));
    return {
      project_code: code,
      pmrs: rows.map((m: any) => ({ pmr_no: m.pmrNo, status: m.status, route: m.route, over_budget: m.overBudget, est_cost: n(m.estCost), over_amount: n(m.overAmount), linked_doc_no: m.linkedDocNo, requested_by: m.requestedBy, approved_by: m.approvedBy, created_at: m.createdAt })),
      count: rows.length,
      pending: rows.filter((m: any) => m.status === 'pending').length,
    };
  }
}
