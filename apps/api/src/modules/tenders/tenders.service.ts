import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { projectTenders, tenderBoqLines } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { ProjectsService } from '../projects/projects.service';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
const r4 = (x: unknown) => Math.round((Number(x) || 0) * 10000) / 10000;
const n = (x: unknown) => Number(x ?? 0);

export interface TenderLineDto { category?: 'material' | 'labor' | 'subcon' | 'other'; description?: string; uom?: string; qty: number; unit_cost: number; markup_pct?: number }
export interface CreateTenderDto { crm_opp_no?: string; title: string; customer_name?: string; project_code?: string; markup_pct?: number; lines?: TenderLineDto[] }
export interface OutcomeDto { outcome: 'won' | 'lost'; reason?: string }
export interface AwardDto { project_code?: string }

// Tender / estimating → award (docs/35 P3, PROJ-17). The pre-award bridge between the CRM pipeline and the
// BoQ: build a priced estimate (cost build-up per line), track estimating → submitted → won/lost, and on a
// WIN seed a project + a DRAFT BoQ from the tender lines in one authorised step (the seeded BoQ enters draft
// → the existing maker-checker approve, so the budget baseline stays controlled). Reuses ProjectsService for
// the project + BoQ creation; no GL impact (a modelling surface). Standalone module (imports ProjectsModule
// — one-way, no cycle).
@Injectable()
export class TendersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly projects: ProjectsService,
  ) {}

  private async tenderRow(tenderNo: string) {
    const [t] = await this.db.select().from(projectTenders).where(eq(projectTenders.tenderNo, tenderNo)).limit(1);
    if (!t) throw new NotFoundException({ code: 'TENDER_NOT_FOUND', message: `Tender ${tenderNo} not found`, messageTh: 'ไม่พบใบประมูล' });
    return t;
  }

  private lineValues(tenderId: number, tenantId: number | null, lineNo: number, l: TenderLineDto, defMarkup: number) {
    const qty = r4(l.qty);
    const unitCost = r2(l.unit_cost);
    const markup = Math.max(0, l.markup_pct != null ? n(l.markup_pct) : defMarkup);
    const bidRate = r2(unitCost * (1 + markup / 100));
    return {
      tenantId, tenderId, lineNo, category: l.category ?? 'material', description: l.description ?? null, uom: l.uom ?? null,
      qty: String(qty), unitCost: String(unitCost), markupPct: String(markup), bidRate: String(bidRate),
      costAmount: String(r2(qty * unitCost)), bidAmount: String(r2(qty * bidRate)),
    };
  }

  // Recompute + persist the tender's estimated_cost / bid_price from its lines.
  private async retotal(tenderId: number) {
    const lines = await this.db.select().from(tenderBoqLines).where(eq(tenderBoqLines.tenderId, tenderId));
    const estimated = r2(lines.reduce((a: number, l: any) => a + n(l.costAmount), 0));
    const bid = r2(lines.reduce((a: number, l: any) => a + n(l.bidAmount), 0));
    await this.db.update(projectTenders).set({ estimatedCost: String(estimated), bidPrice: String(bid), updatedAt: new Date() }).where(eq(projectTenders.id, tenderId));
    return { estimated, bid };
  }

  async createTender(dto: CreateTenderDto, user: JwtUser) {
    const tenantId = user.tenantId ?? null;
    const defMarkup = Math.max(0, n(dto.markup_pct));
    const tenderNo = await this.docNo.nextDaily('TND');
    const [h] = await this.db.insert(projectTenders).values({
      tenantId, tenderNo, crmOppNo: dto.crm_opp_no ?? null, title: dto.title, customerName: dto.customer_name ?? null,
      projectCodeHint: dto.project_code ?? null, markupPct: String(defMarkup), status: 'estimating', createdBy: user.username,
    }).returning({ id: projectTenders.id });
    const tenderId = Number(h!.id);
    const lines = dto.lines ?? [];
    for (let i = 0; i < lines.length; i++) await this.db.insert(tenderBoqLines).values(this.lineValues(tenderId, tenantId, i + 1, lines[i]!, defMarkup));
    await this.retotal(tenderId);
    return this.get(tenderNo);
  }

  async addLine(tenderNo: string, l: TenderLineDto, user: JwtUser) {
    const t = await this.tenderRow(tenderNo);
    if (t.status !== 'estimating') throw new BadRequestException({ code: 'TENDER_NOT_ESTIMATING', message: `Tender ${tenderNo} is ${t.status}; lines can only be added while estimating`, messageTh: 'เพิ่มรายการได้เฉพาะระหว่างประเมินราคา' });
    const existing = await this.db.select({ id: tenderBoqLines.id }).from(tenderBoqLines).where(eq(tenderBoqLines.tenderId, Number(t.id)));
    await this.db.insert(tenderBoqLines).values(this.lineValues(Number(t.id), t.tenantId ?? user.tenantId ?? null, existing.length + 1, l, n(t.markupPct)));
    await this.retotal(Number(t.id));
    return this.get(tenderNo);
  }

  async submit(tenderNo: string, user: JwtUser) {
    const t = await this.tenderRow(tenderNo);
    if (t.status !== 'estimating') throw new BadRequestException({ code: 'TENDER_NOT_ESTIMATING', message: `Only an estimating tender can be submitted (status=${t.status})`, messageTh: 'ยื่นประมูลได้เฉพาะใบที่กำลังประเมินราคา' });
    if (n(t.bidPrice) <= 0) throw new BadRequestException({ code: 'EMPTY_TENDER', message: 'Cannot submit a tender with no priced lines', messageTh: 'ยื่นประมูลไม่ได้เพราะยังไม่มีรายการราคา' });
    await this.db.update(projectTenders).set({ status: 'submitted', submittedAt: new Date(), updatedAt: new Date() }).where(eq(projectTenders.id, Number(t.id)));
    return this.get(tenderNo);
  }

  async setOutcome(tenderNo: string, dto: OutcomeDto, user: JwtUser) {
    const t = await this.tenderRow(tenderNo);
    if (dto.outcome !== 'won' && dto.outcome !== 'lost') throw new BadRequestException({ code: 'BAD_OUTCOME', message: 'outcome must be won or lost', messageTh: 'ผลการประมูลต้องเป็น won หรือ lost' });
    if (t.status === 'won' || t.status === 'lost') throw new BadRequestException({ code: 'TENDER_DECIDED', message: `Tender ${tenderNo} is already ${t.status}`, messageTh: 'ใบประมูลนี้มีผลแล้ว' });
    if (dto.outcome === 'lost' && !dto.reason?.trim()) throw new BadRequestException({ code: 'LOSS_REASON_REQUIRED', message: 'A lost tender requires a reason', messageTh: 'ต้องระบุเหตุผลเมื่อแพ้ประมูล' });
    await this.db.update(projectTenders).set({ status: dto.outcome, outcomeReason: dto.reason ?? null, updatedAt: new Date() }).where(eq(projectTenders.id, Number(t.id)));
    return this.get(tenderNo);
  }

  // Award a WON tender → seed a project + a DRAFT BoQ from the tender lines (bid_rate → BoQ rate). Idempotent
  // (one project per tender). The seeded BoQ is draft → the existing maker-checker approve controls the budget
  // baseline (PROJ-17). Authorised act (proj_tender/exec at the controller).
  async award(tenderNo: string, dto: AwardDto, user: JwtUser) {
    const t = await this.tenderRow(tenderNo);
    if (t.status !== 'won') throw new BadRequestException({ code: 'TENDER_NOT_WON', message: `Only a won tender can be awarded (status=${t.status})`, messageTh: 'มอบงานได้เฉพาะใบที่ชนะประมูลแล้ว' });
    if (t.awardedProjectCode) return { already: true, tender_no: tenderNo, project_code: t.awardedProjectCode };
    const lines = await this.db.select().from(tenderBoqLines).where(eq(tenderBoqLines.tenderId, Number(t.id))).orderBy(tenderBoqLines.lineNo);
    if (!lines.length) throw new BadRequestException({ code: 'EMPTY_TENDER', message: 'Cannot award a tender with no lines', messageTh: 'มอบงานไม่ได้เพราะไม่มีรายการ' });
    const code = (dto.project_code ?? t.projectCodeHint ?? `PRJ-${tenderNo}`).trim();

    // 1) create the project (Fixed-price, contract = bid price), 2) seed the DRAFT BoQ from the tender lines.
    await this.projects.create({ project_code: code, name: t.title, customer_name: t.customerName ?? undefined, billing_type: 'Fixed', contract_amount: n(t.bidPrice) }, user);
    const boq = await this.projects.createBoq(code, {
      title: `BoQ (from tender ${tenderNo})`,
      lines: lines.map((l: any) => ({ category: l.category, description: l.description, uom: l.uom, budget_qty: n(l.qty), rate: n(l.bidRate) })),
    }, user);
    await this.db.update(projectTenders).set({ awardedProjectCode: code, awardedAt: new Date(), updatedAt: new Date() }).where(eq(projectTenders.id, Number(t.id)));
    return { tender_no: tenderNo, project_code: code, boq_status: boq.boq?.status ?? 'draft', boq_budget_total: boq.budget_total, contract_amount: n(t.bidPrice) };
  }

  async get(tenderNo: string) {
    const t = await this.tenderRow(tenderNo);
    const lines = await this.db.select().from(tenderBoqLines).where(eq(tenderBoqLines.tenderId, Number(t.id))).orderBy(tenderBoqLines.lineNo);
    const bid = r2(n(t.bidPrice));
    const est = r2(n(t.estimatedCost));
    return {
      tender_no: t.tenderNo, crm_opp_no: t.crmOppNo, title: t.title, customer_name: t.customerName, status: t.status,
      markup_pct: n(t.markupPct), estimated_cost: est, bid_price: bid, overall_markup_pct: est > 0 ? r2(((bid - est) / est) * 100) : 0,
      outcome_reason: t.outcomeReason, submitted_at: t.submittedAt, awarded_project_code: t.awardedProjectCode, awarded_at: t.awardedAt,
      created_by: t.createdBy,
      lines: lines.map((l: any) => ({
        line_no: l.lineNo, category: l.category, description: l.description, uom: l.uom, qty: n(l.qty),
        unit_cost: n(l.unitCost), markup_pct: n(l.markupPct), bid_rate: n(l.bidRate), cost_amount: n(l.costAmount), bid_amount: n(l.bidAmount),
      })),
    };
  }

  async list() {
    const rows = await this.db.select().from(projectTenders).orderBy(desc(projectTenders.id));
    const decided = rows.filter((r: any) => r.status === 'won' || r.status === 'lost').length;
    const won = rows.filter((r: any) => r.status === 'won').length;
    return {
      count: rows.length,
      win_rate_pct: decided > 0 ? r2((won / decided) * 100) : 0,
      pipeline_bid_value: r2(rows.filter((r: any) => r.status === 'estimating' || r.status === 'submitted').reduce((a: number, r: any) => a + n(r.bidPrice), 0)),
      tenders: rows.map((r: any) => ({
        tender_no: r.tenderNo, title: r.title, customer_name: r.customerName, status: r.status,
        estimated_cost: n(r.estimatedCost), bid_price: n(r.bidPrice), awarded_project_code: r.awardedProjectCode,
      })),
    };
  }
}
