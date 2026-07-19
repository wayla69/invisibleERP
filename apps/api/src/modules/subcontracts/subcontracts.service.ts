import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { projects, projectBoqLines, projectSubcontracts, subcontractScope, subcontractValuations, tenants, stockReservations, projectMaterialReturns } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import { RetentionService } from '../retention/retention.service';
import { CommitmentsService } from '../commitments/commitments.service';
import { SubcontractValuationPdfService, type SubcontractValuationPrintData } from './subcontract-valuation-pdf.service';
import { DocEmailService } from '../mail/doc-email.service';
import { sellerParty } from '../../common/doc-party';
import type { DocParty } from '../../common/doc-html';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
const n = (x: unknown) => Number(x ?? 0);
const EPS = 0.005;

export interface ScopeDto { boq_line_id: number; amount: number; description?: string }
export interface CreateSubcontractDto { project_code: string; vendor_name?: string; title?: string; retention_pct?: number; wht_pct?: number; vat_pct?: number; scope: ScopeDto[]; allow_over?: boolean }
export interface CreateValuationDto { period?: string; pct_complete: number; back_charge?: number }

// Subcontractor management (docs/35 P2, PROJ-17). A subcontract is a priced scope against BoQ lines; on
// creation it REGISTERS a commitment on each scoped BoQ line (docs/32 CommitmentsService, source SUBCON) so it
// counts against the works budget like a PO (over-budget → BUDGET_EXCEEDED unless allow_over). The
// subcontractor's periodic VALUATIONS are certified maker-checker (PROJ-17); each certifies the % complete,
// withholds retention PAYABLE (2440, shared sub-ledger), deducts back-charges, and posts the certified NET to
// AP (2000) with the works cost capitalised into project WIP (1260) — atomically. Standalone module (imports
// Ledger + Retention + Commitments; none imports this → no DI cycle).
@Injectable()
export class SubcontractsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly ledger: LedgerService,
    private readonly retention: RetentionService,
    private readonly commitments: CommitmentsService,
    // Printable ใบรับรองผลงานผู้รับเหมาช่วง + document email. @Optional so hand-constructed harnesses build.
    @Optional() private readonly valuationPdf?: SubcontractValuationPdfService,
    @Optional() private readonly docEmail?: DocEmailService,
  ) {}

  private async projectRow(code: string) {
    const [p] = await this.db.select().from(projects).where(eq(projects.projectCode, code)).limit(1);
    if (!p) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: `Project ${code} not found`, messageTh: 'ไม่พบโครงการ' });
    return p;
  }
  private async subRow(subNo: string) {
    const [s] = await this.db.select().from(projectSubcontracts).where(eq(projectSubcontracts.subcontractNo, subNo)).limit(1);
    if (!s) throw new NotFoundException({ code: 'SUBCONTRACT_NOT_FOUND', message: `Subcontract ${subNo} not found`, messageTh: 'ไม่พบสัญญาผู้รับเหมาช่วง' });
    return s;
  }
  private async valRow(valNo: string) {
    const [v] = await this.db.select().from(subcontractValuations).where(eq(subcontractValuations.valuationNo, valNo)).limit(1);
    if (!v) throw new NotFoundException({ code: 'VALUATION_NOT_FOUND', message: `Valuation ${valNo} not found`, messageTh: 'ไม่พบงวดงานผู้รับเหมาช่วง' });
    return v;
  }

  async createSubcontract(dto: CreateSubcontractDto, user: JwtUser) {
    if (!dto.scope?.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No scope lines', messageTh: 'ไม่มีขอบเขตงาน' });
    const p = await this.projectRow(dto.project_code);
    const projectId = Number(p.id);
    const tenantId = p.tenantId ?? user.tenantId ?? null;
    const retentionPct = Math.max(0, n(dto.retention_pct));

    const lineIds = [...new Set(dto.scope.map((s) => Number(s.boq_line_id)))];
    const boqRows = await this.db.select().from(projectBoqLines).where(inArray(projectBoqLines.id, lineIds));
    const boqById = new Map<number, any>(boqRows.map((l: any) => [Number(l.id), l]));
    for (const s of dto.scope) {
      const l = boqById.get(Number(s.boq_line_id));
      if (!l || Number(l.projectId) !== projectId) throw new BadRequestException({ code: 'BOQ_LINE_NOT_IN_PROJECT', message: `BoQ line ${s.boq_line_id} is not on project ${dto.project_code}`, messageTh: 'รายการ BoQ ไม่ได้อยู่ในโครงการนี้' });
      if (n(s.amount) <= 0) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'Scope amount must be positive', messageTh: 'มูลค่าขอบเขตงานต้องมากกว่าศูนย์' });
    }
    const contractValue = r2(dto.scope.reduce((a, s) => a + n(s.amount), 0));
    const subNo = await this.docNo.nextDaily('SC');

    return this.db.transaction(async (tx) => {
      const [h] = await tx.insert(projectSubcontracts).values({
        tenantId, projectId, subcontractNo: subNo, vendorName: dto.vendor_name ?? null, title: dto.title ?? null,
        contractValue: String(contractValue), retentionPct: String(retentionPct), whtPct: String(Math.max(0, n(dto.wht_pct))), vatPct: String(Math.max(0, n(dto.vat_pct))), status: 'active', createdBy: user.username,
      }).returning({ id: projectSubcontracts.id });
      const subId = Number(h!.id);
      for (const s of dto.scope) {
        await tx.insert(subcontractScope).values({ tenantId, subcontractId: subId, boqLineId: Number(s.boq_line_id), description: s.description ?? null, amount: String(r2(n(s.amount))) });
        // Register the commitment against the BoQ line — a subcontract counts against the works budget like a
        // PO (PROJ-12). Over budget → BUDGET_EXCEEDED (rolls the whole subcontract back) unless allow_over.
        await this.commitments.reserve(tx, {
          projectId, boqLineId: Number(s.boq_line_id), amount: r2(n(s.amount)), sourceDocType: 'SUBCON', sourceDocNo: subNo,
          createdBy: user.username, tenantId, allowOver: !!dto.allow_over,
        });
      }
      return this.getWithin(tx, subNo);
    });
  }

  async createValuation(subNo: string, dto: CreateValuationDto, user: JwtUser) {
    const s = await this.subRow(subNo);
    const pct = n(dto.pct_complete);
    if (pct < 0 || pct > 100) throw new BadRequestException({ code: 'BAD_PERCENT', message: `pct_complete must be 0..100 (got ${pct})`, messageTh: 'เปอร์เซ็นต์ความคืบหน้าต้องอยู่ระหว่าง 0 ถึง 100' });
    const contractValue = r2(n(s.contractValue));
    const valueToDate = r2((contractValue * pct) / 100);
    const [prior] = await this.db.select({ v: sql<string>`coalesce(sum(${subcontractValuations.grossThisVal}),0)`, c: sql<string>`count(*)` })
      .from(subcontractValuations).where(and(eq(subcontractValuations.subcontractId, Number(s.id)), eq(subcontractValuations.status, 'certified')));
    const prevCertified = r2(n(prior?.v));
    const gross = r2(valueToDate - prevCertified);
    if (gross <= EPS) throw new BadRequestException({ code: 'NOTHING_TO_CERTIFY', message: 'Valuation has no positive progress to certify', messageTh: 'ไม่มีความคืบหน้าเพิ่มให้รับรองในงวดนี้' });
    const backCharge = r2(Math.max(0, n(dto.back_charge)));
    const retentionPct = n(s.retentionPct);
    const retention = r2((gross * retentionPct) / 100);
    if (backCharge > gross - retention + EPS) throw new BadRequestException({ code: 'BAD_BACK_CHARGE', message: `Back-charge ${backCharge} exceeds the net (gross ${gross} − retention ${retention})`, messageTh: 'ยอดหักกลบเกินมูลค่าสุทธิ' });
    const net = r2(gross - retention - backCharge);

    const [countRow] = await this.db.select({ c: sql<string>`count(*)` }).from(subcontractValuations).where(eq(subcontractValuations.subcontractId, Number(s.id)));
    const valNo = await this.docNo.nextDaily('SV');
    await this.db.insert(subcontractValuations).values({
      tenantId: s.tenantId ?? user.tenantId ?? null, subcontractId: Number(s.id), valuationNo: valNo, seq: Number(countRow?.c ?? 0) + 1,
      period: dto.period ?? null, status: 'draft', pctComplete: String(pct), valueToDate: String(valueToDate), prevCertified: String(prevCertified),
      grossThisVal: String(gross), retentionPct: String(retentionPct), retentionAmount: String(retention), backCharge: String(backCharge), netCertified: String(net),
      createdBy: user.username,
    });
    return this.getValuation(valNo);
  }

  // Certify a draft valuation (maker-checker: certifier ≠ preparer → PROJ-17) → post the AP/WIP/retention JE
  // + withhold retention payable into the shared sub-ledger, atomically. Capped at the subcontract value.
  async certifyValuation(valNo: string, user: JwtUser, selfApprovalReason?: string | null) {
    const v = await this.valRow(valNo);
    if (v.status !== 'draft') throw new BadRequestException({ code: 'VALUATION_NOT_DRAFT', message: `Valuation ${valNo} is ${v.status}, not draft`, messageTh: 'งวดงานไม่ได้อยู่ในสถานะร่าง' });
    await assertMakerChecker(this.db, { user, maker: v.createdBy, event: 'proj.subcon.certify', ref: valNo, amount: n(v.grossThisVal), reason: selfApprovalReason, code: 'SOD_SELF_APPROVAL', message: 'The valuation preparer cannot certify their own valuation (SoD)', messageTh: 'ผู้จัดทำงวดงานรับรองงวดของตนเองไม่ได้ (แบ่งแยกหน้าที่)', httpStatus: 400 });
    const s = await this.subRow((await this.db.select({ no: projectSubcontracts.subcontractNo }).from(projectSubcontracts).where(eq(projectSubcontracts.id, Number(v.subcontractId))).limit(1))[0]!.no as string);
    const projectId = Number(s.projectId);
    const tenantId = v.tenantId ?? s.tenantId ?? user.tenantId ?? null;
    const gross = r2(n(v.grossThisVal));
    const retention = r2(n(v.retentionAmount));
    const backCharge = r2(n(v.backCharge));
    const net = r2(n(v.netCertified));
    const wipCost = r2(gross - backCharge); // works cost capitalised into project WIP (back-charge recovers our cost)
    // Depth-2 — Thai construction WHT (ภ.ง.ด.53, 3%): withheld from the subcontractor's payment on the certified
    // service value and remitted to the RD, so what we owe the subcontractor is net − WHT (retention already out).
    const wht = r2((gross * n(s.whtPct)) / 100);
    // Depth — recoverable INPUT VAT (ภาษีซื้อ) on the subcontractor's invoice: we pay it (raising AP) and
    // reclaim it (Dr 1300). AP = net service − WHT + input VAT.
    const vat = r2((gross * n(s.vatPct)) / 100);
    const ap = r2(net - wht + vat);
    if (r2(net - wht) < -EPS) throw new BadRequestException({ code: 'BAD_WHT', message: `WHT ${wht} + retention leaves a negative payable`, messageTh: 'ภาษีหัก ณ ที่จ่ายทำให้ยอดจ่ายติดลบ' });

    const newCertified = r2(n(s.certifiedToDate) + gross);
    if (newCertified > n(s.contractValue) + 0.01)
      throw new BadRequestException({ code: 'VAL_EXCEEDS_SUBCONTRACT', message: `Certifying ${gross} would exceed the subcontract ${n(s.contractValue)} (already certified ${n(s.certifiedToDate)})`, messageTh: 'รับรองงวดเกินมูลค่าสัญญาผู้รับเหมาช่วง' });
    // PROJ-28 (free-issue custody clearance, migration 0427): the FINAL valuation — the one that certifies
    // the subcontract out to its full contract value — is blocked while company material free-issued to
    // this subcontractor is still unaccounted (neither returned to stock via the governed MRET path nor
    // acknowledged consumed in the works). A plain filtered read of the custody register (reservations owns
    // the write paths; subcontracts must never import reservations — the commitments-service precedent).
    if (newCertified >= n(s.contractValue) - 0.01) {
      const fiRows = await this.db.select().from(stockReservations)
        .where(and(eq(stockReservations.subcontractId, Number(s.id)), eq(stockReservations.status, 'consumed')));
      if (fiRows.length) {
        const retRows = await this.db.select({ rid: projectMaterialReturns.reservationId, v: sql<string>`coalesce(sum(${projectMaterialReturns.qty}),0)` })
          .from(projectMaterialReturns)
          .where(and(inArray(projectMaterialReturns.reservationId, fiRows.map((r: any) => Number(r.id))), eq(projectMaterialReturns.status, 'Posted')))
          .groupBy(projectMaterialReturns.reservationId);
        const retBy = new Map<number, number>(retRows.map((r: any) => [Number(r.rid), n(r.v)]));
        const open = fiRows
          .map((r: any) => ({ reservation_id: Number(r.id), item_id: r.itemId, in_custody: r2(n(r.qtyReserved) - (retBy.get(Number(r.id)) ?? 0) - n(r.custodyAckQty)) }))
          .filter((x: any) => x.in_custody > EPS);
        if (open.length) {
          throw new BadRequestException({
            code: 'FREE_ISSUE_CUSTODY_OPEN',
            message: `Final certification blocked: ${open.length} free-issue reservation(s) still hold unaccounted material — return it (MRET) or acknowledge consumption first`,
            messageTh: 'รับรองงวดสุดท้ายไม่ได้: ยังมีวัสดุฝากผู้รับเหมาช่วงที่ยังไม่คืน/ยังไม่รับรู้การใช้',
            details: { open },
          });
        }
      }
    }
    if (await this.ledger.alreadyPosted('PRJ-SUBVAL', valNo, tenantId)) return { already: true, valuation_no: valNo };

    const lines: any[] = [];
    if (wipCost > 0) lines.push({ account_code: '1260', debit: wipCost, memo: `Subcontract WIP ${valNo}`, project_id: projectId });
    if (vat > 0) lines.push({ account_code: '1300', debit: vat, memo: `Input VAT ${valNo}`, project_id: projectId });
    lines.push({ account_code: '2000', credit: ap, memo: `Subcontractor AP ${valNo}`, project_id: projectId });
    if (retention > 0) lines.push({ account_code: '2440', credit: retention, memo: `Retention payable ${valNo}`, project_id: projectId });
    if (wht > 0) lines.push({ account_code: '2361', credit: wht, memo: `Vendor WHT (PND53) ${valNo}`, project_id: projectId });
    // Dr [1260 (gross−back) + 1300 VAT] = Cr [AP (net−wht+vat) + retention + wht] → both = gross − back + vat. ✓

    const entryNo = await this.db.transaction(async (tx) => {
      const je: any = await this.ledger.postEntry({ source: 'PRJ-SUBVAL', sourceRef: valNo, tenantId, memo: `Subcontract valuation ${valNo}`, createdBy: user.username, lines }, tx);
      if (retention > 0) {
        await this.retention.withhold({
          partyType: 'subcontractor', projectId, partyRef: s.vendorName ?? undefined, sourceDocType: 'SUBVAL', sourceDocNo: valNo,
          amount: retention, tenantId, createdBy: user.username,
        }, tx);
      }
      await tx.update(subcontractValuations).set({ status: 'certified', certifiedBy: user.username, certifiedAt: new Date(), whtAmount: String(wht), vatAmount: String(vat), entryNo: je.entry_no, updatedAt: new Date() }).where(eq(subcontractValuations.id, Number(v.id)));
      await tx.update(projectSubcontracts).set({ certifiedToDate: String(newCertified), updatedAt: new Date() }).where(eq(projectSubcontracts.id, Number(s.id)));
      // The certified works cost lands in project WIP → keep the project's cost_to_date consistent so progress
      // billing (P1) relieves it correctly.
      const [proj] = await tx.select({ c: projects.costToDate }).from(projects).where(eq(projects.id, projectId)).limit(1);
      await tx.update(projects).set({ costToDate: String(r2(n(proj?.c) + wipCost)) }).where(eq(projects.id, projectId));
      return je.entry_no;
    });
    return { valuation_no: valNo, entry_no: entryNo, status: 'certified', gross, retention, back_charge: backCharge, wht, vat, net_certified: net, ap_payable: ap, wip_cost: wipCost };
  }

  private async getWithin(runner: any, subNo: string) {
    const [s] = await runner.select().from(projectSubcontracts).where(eq(projectSubcontracts.subcontractNo, subNo)).limit(1);
    const scope = await runner.select().from(subcontractScope).where(eq(subcontractScope.subcontractId, Number(s.id))).orderBy(subcontractScope.id);
    return {
      subcontract_no: s.subcontractNo, vendor_name: s.vendorName, title: s.title, status: s.status,
      contract_value: n(s.contractValue), retention_pct: n(s.retentionPct), certified_to_date: n(s.certifiedToDate),
      remaining: r2(n(s.contractValue) - n(s.certifiedToDate)),
      scope: scope.map((x: any) => ({ boq_line_id: Number(x.boqLineId), description: x.description, amount: n(x.amount) })),
    };
  }
  async getSubcontract(subNo: string) { await this.subRow(subNo); return this.getWithin(this.db, subNo); }

  async getValuation(valNo: string) {
    const v = await this.valRow(valNo);
    return {
      valuation_no: v.valuationNo, seq: v.seq, period: v.period, status: v.status, pct_complete: n(v.pctComplete),
      value_to_date: n(v.valueToDate), prev_certified: n(v.prevCertified), gross_this_val: n(v.grossThisVal),
      retention_pct: n(v.retentionPct), retention_amount: n(v.retentionAmount), back_charge: n(v.backCharge), net_certified: n(v.netCertified),
      entry_no: v.entryNo, created_by: v.createdBy, certified_by: v.certifiedBy, certified_at: v.certifiedAt,
    };
  }

  async listForProject(code: string) {
    const p = await this.projectRow(code);
    const subs = await this.db.select().from(projectSubcontracts).where(eq(projectSubcontracts.projectId, Number(p.id))).orderBy(desc(projectSubcontracts.id));
    const subIds = subs.map((x: any) => Number(x.id));
    const vals = subIds.length ? await this.db.select().from(subcontractValuations).where(inArray(subcontractValuations.subcontractId, subIds)) : [];
    const retentionHeld = r2(vals.filter((x: any) => x.status === 'certified').reduce((a: number, x: any) => a + n(x.retentionAmount), 0));
    return {
      project_code: code,
      subcontract_value: r2(subs.reduce((a: number, x: any) => a + n(x.contractValue), 0)),
      certified_to_date: r2(subs.reduce((a: number, x: any) => a + n(x.certifiedToDate), 0)),
      retention_payable: retentionHeld,
      subcontracts: subs.map((x: any) => ({
        subcontract_no: x.subcontractNo, vendor_name: x.vendorName, title: x.title, status: x.status,
        contract_value: n(x.contractValue), certified_to_date: n(x.certifiedToDate), retention_pct: n(x.retentionPct),
        remaining: r2(n(x.contractValue) - n(x.certifiedToDate)),
      })),
    };
  }

  // Resolve the caller's own tenant profile as the document issuer (main-contractor header).
  private async sellerFor(user: JwtUser): Promise<DocParty> {
    const [t] = user.tenantId != null ? await this.db.select().from(tenants).where(eq(tenants.id, Number(user.tenantId))).limit(1) : [null];
    return sellerParty(t);
  }

  // Assemble the printable ใบรับรองผลงานผู้รับเหมาช่วง (subcontract valuation certificate, docs/35 P2). Seller =
  // the main contractor (caller's company); subcontractor = the vendor on the subcontract. Retention/back-charge/
  // WHT/VAT/AP mirror the certification JE.
  async getValuationForPrint(valNo: string, user: JwtUser): Promise<SubcontractValuationPrintData> {
    const v = await this.valRow(valNo);
    const [s] = await this.db.select().from(projectSubcontracts).where(eq(projectSubcontracts.id, Number(v.subcontractId))).limit(1);
    const [p] = s ? await this.db.select().from(projects).where(eq(projects.id, Number(s.projectId))).limit(1) : [null];
    const scope = s ? await this.db.select().from(subcontractScope).where(eq(subcontractScope.subcontractId, Number(s.id))).orderBy(subcontractScope.id) : [];
    const gross = r2(n(v.grossThisVal));
    const retentionPct = n(v.retentionPct);
    const retention = r2(n(v.retentionAmount));
    const backCharge = r2(n(v.backCharge));
    const net = r2(n(v.netCertified));
    const whtPct = n(s?.whtPct);
    const wht = r2(n(v.whtAmount) || (gross * whtPct) / 100);
    const vatPct = n(s?.vatPct);
    const vat = r2(n(v.vatAmount) || (gross * vatPct) / 100);
    return {
      valuation_no: v.valuationNo, seq: Number(v.seq), period: v.period, status: String(v.status),
      certified_by: v.certifiedBy ?? null, certified_at: v.certifiedAt,
      seller: await this.sellerFor(user),
      subcontractor: { name: s?.vendorName || 'ผู้รับเหมาช่วง', address: '-', tax_id: null, branch_label: null, phone: null, email: null },
      project_code: p?.projectCode ?? '', project_name: p?.name ?? null,
      subcontract_no: s?.subcontractNo ?? '', subcontract_title: s?.title ?? null,
      contract_value: n(s?.contractValue), pct_complete: n(v.pctComplete), value_to_date: n(v.valueToDate), prev_certified: n(v.prevCertified),
      scope: scope.map((x: any) => ({ description: x.description, amount: n(x.amount) })),
      gross, retention_pct: retentionPct, retention, back_charge: backCharge, wht_pct: whtPct, wht, vat_pct: vatPct, vat,
      net_certified: net, ap_payable: r2(net - wht + vat),
    };
  }

  valuationHtml(data: SubcontractValuationPrintData): string {
    if (!this.valuationPdf) throw new NotFoundException({ code: 'RENDERER_UNAVAILABLE', message: 'Valuation certificate renderer not wired' });
    return this.valuationPdf.valuationHtml(data);
  }

  async renderValuationPdf(data: SubcontractValuationPrintData): Promise<Buffer | null> {
    return this.valuationPdf ? this.valuationPdf.renderToPdf(this.valuationPdf.valuationHtml(data)) : null;
  }

  // Email the ใบรับรองผลงานผู้รับเหมาช่วง to the subcontractor as a PDF attachment (HTML fallback when Chromium absent).
  async emailValuation(valNo: string, toEmail: string | undefined, user: JwtUser) {
    if (!this.docEmail) throw new NotFoundException({ code: 'EMAIL_UNAVAILABLE', message: 'Email path not wired' });
    const data = await this.getValuationForPrint(valNo, user);
    const res = await this.docEmail.sendDocument({
      to: toEmail?.trim() || data.subcontractor.email || '', from: data.seller.email ?? undefined, filename: data.valuation_no,
      subject: `ใบรับรองผลงานผู้รับเหมาช่วง ${data.valuation_no} จาก ${data.seller.name}`,
      text: `เรียน ${data.subcontractor.name},\n\nแนบใบรับรองผลงานงวดที่ ${data.seq} เลขที่ ${data.valuation_no} จำนวนเงินที่ต้องจ่าย ${data.ap_payable.toLocaleString()} บาท\n\nขอบคุณครับ\n${data.seller.name}`,
      html: this.valuationHtml(data),
    });
    return { ...res, valuation_no: data.valuation_no };
  }
}
