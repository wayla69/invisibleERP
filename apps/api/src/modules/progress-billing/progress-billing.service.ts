import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { projects, projectBoqLines, projectProgressClaims, progressClaimLines, tenants } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import { postingDefault } from '../ledger/posting-events';
import { RetentionService } from '../retention/retention.service';
import { ProgressClaimPdfService, type ProgressClaimPrintData } from './progress-claim-pdf.service';
import { DocEmailService } from '../mail/doc-email.service';
import { sellerParty } from '../../common/doc-party';
import type { DocParty } from '../../common/doc-html';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
const n = (x: unknown) => Number(x ?? 0);
const EPS = 0.005;

export interface ClaimLineDto { boq_line_id: number; pct_complete_to_date: number }
export interface CreateClaimDto { project_code: string; period?: string; retention_pct?: number; vat_pct?: number; lines: ClaimLineDto[] }

// Progress billing / งวดงาน (docs/35 P1, PROJ-16). The customer-side revenue engine of a construction
// contract: a periodic CLAIM values work done to date by BoQ line (cumulative % → value-to-date), bills the
// movement since the last certified claim, withholds RETENTION per the retention %, and invoices the NET.
// Certification is maker-checker (raise ≠ certify → PROJ-16). On certify it posts the billing JE (Dr 1100 AR
// net + Dr 1170 Retention Receivable + Cr 4200 Revenue gross; relieve WIP 1260 → COGS 5800) and withholds the
// retention into the shared retention sub-ledger (docs/35 P0) — atomically in one transaction. Reuses the
// LedgerService GL path and RetentionService sub-ledger; queries the project/BoQ tables directly (no
// ProjectsModule dependency → no DI cycle).
@Injectable()
export class ProgressBillingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly ledger: LedgerService,
    private readonly retention: RetentionService,
    // Printable ใบวางบิลงวดงาน / ใบกำกับภาษี + document email. @Optional so hand-constructed harnesses build.
    @Optional() private readonly claimPdf?: ProgressClaimPdfService,
    @Optional() private readonly docEmail?: DocEmailService,
  ) {}

  private async projectRow(code: string) {
    const [p] = await this.db.select().from(projects).where(eq(projects.projectCode, code)).limit(1);
    if (!p) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: `Project ${code} not found`, messageTh: 'ไม่พบโครงการ' });
    return p;
  }

  private async claimRow(claimNo: string) {
    const [c] = await this.db.select().from(projectProgressClaims).where(eq(projectProgressClaims.claimNo, claimNo)).limit(1);
    if (!c) throw new NotFoundException({ code: 'CLAIM_NOT_FOUND', message: `Progress claim ${claimNo} not found`, messageTh: 'ไม่พบงวดงาน' });
    return c;
  }

  // Σ value_this_claim already CERTIFIED on prior claims, per BoQ line (the "previously certified" baseline the
  // cumulative valuation subtracts from). Only certified claims count — a draft claim doesn't reserve value.
  private async certifiedByLine(projectId: number, boqLineIds: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (!boqLineIds.length) return out;
    const rows = await this.db.select({ line: progressClaimLines.boqLineId, v: sql<string>`coalesce(sum(${progressClaimLines.valueThisClaim}),0)` })
      .from(progressClaimLines)
      .innerJoin(projectProgressClaims, eq(progressClaimLines.claimId, projectProgressClaims.id))
      .where(and(eq(projectProgressClaims.projectId, Number(projectId)), eq(projectProgressClaims.status, 'certified'), inArray(progressClaimLines.boqLineId, boqLineIds.map(Number))))
      .groupBy(progressClaimLines.boqLineId);
    for (const r of rows) out.set(Number(r.line), r2(n(r.v)));
    return out;
  }

  async createClaim(dto: CreateClaimDto, user: JwtUser) {
    if (!dto.lines?.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No claim lines', messageTh: 'ไม่มีรายการงวดงาน' });
    const p = await this.projectRow(dto.project_code);
    const projectId = Number(p.id);
    const tenantId = p.tenantId ?? user.tenantId ?? null;
    const retentionPct = Math.max(0, n(dto.retention_pct));

    const lineIds = [...new Set(dto.lines.map((l) => Number(l.boq_line_id)))];
    const boqRows = await this.db.select().from(projectBoqLines).where(inArray(projectBoqLines.id, lineIds));
    const boqById = new Map<number, any>(boqRows.map((l: any) => [Number(l.id), l]));
    for (const id of lineIds) {
      const l = boqById.get(id);
      if (!l || Number(l.projectId) !== projectId) throw new BadRequestException({ code: 'BOQ_LINE_NOT_IN_PROJECT', message: `BoQ line ${id} is not on project ${dto.project_code}`, messageTh: 'รายการ BoQ ไม่ได้อยู่ในโครงการนี้' });
    }
    const prevByLine = await this.certifiedByLine(projectId, lineIds);

    let gross = 0;
    const evaluated = dto.lines.map((l) => {
      const id = Number(l.boq_line_id);
      const pct = n(l.pct_complete_to_date);
      if (pct < 0 || pct > 100) throw new BadRequestException({ code: 'BAD_PERCENT', message: `pct_complete_to_date must be 0..100 (got ${pct})`, messageTh: 'เปอร์เซ็นต์ความคืบหน้าต้องอยู่ระหว่าง 0 ถึง 100' });
      const budget = r2(n(boqById.get(id).budgetAmount));
      const valueToDate = r2((budget * pct) / 100);
      const prev = prevByLine.get(id) ?? 0;
      const valueThis = r2(valueToDate - prev);
      gross = r2(gross + valueThis);
      return { id, description: boqById.get(id).description ?? null, budget, pct, valueToDate, prev, valueThis };
    });
    if (gross <= EPS) throw new BadRequestException({ code: 'NOTHING_TO_BILL', message: 'Claim has no positive work movement to bill', messageTh: 'ไม่มีมูลค่างานเพิ่มให้วางบิลในงวดนี้' });

    // Project-level cumulative gross already certified (for the seq / งวดที่ and the prev_certified header).
    const priorClaims = await this.db.select({ v: sql<string>`coalesce(sum(${projectProgressClaims.grossThisClaim}),0)`, c: sql<string>`count(*)` })
      .from(projectProgressClaims).where(and(eq(projectProgressClaims.projectId, projectId), eq(projectProgressClaims.status, 'certified')));
    const prevCertified = r2(n(priorClaims[0]?.v));
    const seqRow = await this.db.select({ c: sql<string>`count(*)` }).from(projectProgressClaims).where(eq(projectProgressClaims.projectId, projectId));
    const seq = Number(seqRow[0]?.c ?? 0) + 1;
    const retentionAmount = r2((gross * retentionPct) / 100);
    const claimNo = await this.docNo.nextDaily('PC');

    const vatPct = Math.max(0, n(dto.vat_pct));
    const vatAmount = r2((gross * vatPct) / 100);
    const [h] = await this.db.insert(projectProgressClaims).values({
      tenantId, projectId, claimNo, seq, period: dto.period ?? null, status: 'draft',
      grossThisClaim: String(gross), prevCertified: String(prevCertified), cumulativeCertified: String(r2(prevCertified + gross)),
      retentionPct: String(retentionPct), retentionAmount: String(retentionAmount), netPayable: String(r2(gross - retentionAmount)),
      vatPct: String(vatPct), vatAmount: String(vatAmount), revMethod: p.revMethod === 'poc' ? 'poc' : 'billing',
      createdBy: user.username,
    }).returning({ id: projectProgressClaims.id });
    for (const e of evaluated) {
      await this.db.insert(progressClaimLines).values({
        tenantId, claimId: Number(h!.id), boqLineId: e.id, description: e.description, budgetAmount: String(e.budget),
        pctCompleteToDate: String(e.pct), valueToDate: String(e.valueToDate), previouslyCertified: String(e.prev), valueThisClaim: String(e.valueThis),
      });
    }
    return this.get(claimNo);
  }

  // Certify a draft claim (maker-checker: certifier ≠ preparer → PROJ-16) → post the billing JE + withhold
  // retention into the shared sub-ledger, atomically. Fixed-price contracts can't be certified beyond contract.
  async certifyClaim(claimNo: string, user: JwtUser, selfApprovalReason?: string | null) {
    const c = await this.claimRow(claimNo);
    if (c.status !== 'draft') throw new BadRequestException({ code: 'CLAIM_NOT_DRAFT', message: `Claim ${claimNo} is ${c.status}, not draft`, messageTh: 'งวดงานไม่ได้อยู่ในสถานะร่าง' });
    await assertMakerChecker(this.db, { user, maker: c.createdBy, event: 'proj.claim.certify', ref: claimNo, amount: n(c.grossThisClaim), reason: selfApprovalReason, code: 'SOD_SELF_APPROVAL', message: 'The claim preparer cannot certify their own claim (SoD)', messageTh: 'ผู้จัดทำงวดงานรับรองงวดของตนเองไม่ได้ (แบ่งแยกหน้าที่)', httpStatus: 400 });

    const p = await this.projectRow((await this.db.select({ code: projects.projectCode }).from(projects).where(eq(projects.id, Number(c.projectId))).limit(1))[0]!.code as string);
    const tenantId = c.tenantId ?? p.tenantId ?? user.tenantId ?? null;
    const gross = r2(n(c.grossThisClaim));
    const retentionPct = n(c.retentionPct);
    const retention = r2((gross * retentionPct) / 100);
    const net = r2(gross - retention);
    const relieve = r2(Math.max(0, n(p.costToDate) - n(p.recognizedCost)));

    const newBilled = r2(n(p.billedToDate) + gross);
    if (p.billingType === 'Fixed' && n(p.contractAmount) > 0 && newBilled > n(p.contractAmount) + 0.01)
      throw new BadRequestException({ code: 'BILL_EXCEEDS_CONTRACT', message: `Certifying ${gross} would exceed the contract ${n(p.contractAmount)} (already billed ${n(p.billedToDate)})`, messageTh: 'รับรองงวดงานเกินมูลค่าสัญญา' });
    if (await this.ledger.alreadyPosted('PRJ-PCLAIM', claimNo, tenantId)) return { already: true, claim_no: claimNo };

    const projectId = Number(c.projectId);
    const vatPct = n(c.vatPct);
    const vat = r2((gross * vatPct) / 100);       // Depth-2 — output VAT on the certified value
    const arTotal = r2(net + vat);                // what the customer owes now (net of retention, incl. VAT)
    const isPoc = c.revMethod === 'poc' || p.revMethod === 'poc'; // Depth-3 — reconcile with the POC engine

    // AR (net of retention + VAT) and the withheld retention are common to both revenue models.
    const lines: any[] = [{ account_code: '1100', debit: arTotal, memo: `AR ${claimNo}`, project_id: projectId }];
    if (retention > 0) lines.push({ account_code: '1170', debit: retention, memo: `Retention receivable ${claimNo}`, project_id: projectId });

    let costRecognized = 0, revenue = 0, contractAssetCleared = 0, billingsInExcess = 0;
    if (isPoc) {
      // POC project (PROJ-09): a progress claim is a BILLING event, NOT a revenue event — revenue is
      // recognised over time by recognizePoc. Clear the earned-but-unbilled contract asset (1265), park any
      // excess as a contract liability (2410, billings in excess). No 4200 revenue, no WIP relief here.
      const contractAsset = r2(Math.max(0, n(p.recognizedRevenue) - n(p.billedToDate)));
      contractAssetCleared = r2(Math.min(gross, contractAsset));
      billingsInExcess = r2(gross - contractAssetCleared);
      if (contractAssetCleared > 0) lines.push({ account_code: '1265', credit: contractAssetCleared, memo: `Contract asset billed ${claimNo}`, project_id: projectId });
      if (billingsInExcess > 0) lines.push({ account_code: '2410', credit: billingsInExcess, memo: `Billings in excess ${claimNo}`, project_id: projectId });
    } else {
      // Billing-method project: the claim recognises revenue and relieves unbilled WIP to COGS.
      revenue = gross; costRecognized = relieve;
      // docs/43 PR-4: revenue + COGS legs follow the tenant posting-rules (PROJECT.REVENUE) ?? defaults.
      const revOvr = await this.ledger.postingOverrides('PROJECT.REVENUE', tenantId);
      lines.push({ account_code: revOvr.project_revenue ?? postingDefault('PROJECT.REVENUE', 'project_revenue'), credit: gross, memo: `Progress billing ${claimNo}`, project_id: projectId });
      if (relieve > 0) {
        lines.push({ account_code: revOvr.project_cogs ?? postingDefault('PROJECT.REVENUE', 'project_cogs'), debit: relieve, memo: 'Project cost of services', project_id: projectId });
        lines.push({ account_code: '1260', credit: relieve, memo: `WIP relieved ${claimNo}`, project_id: projectId });
      }
    }
    if (vat > 0) lines.push({ account_code: '2100', credit: vat, memo: `Output VAT ${claimNo}`, project_id: projectId });

    const entryNo = await this.db.transaction(async (tx) => {
      const je: any = await this.ledger.postEntry({ source: 'PRJ-PCLAIM', sourceRef: claimNo, tenantId, memo: `Progress claim ${claimNo}`, createdBy: user.username, lines }, tx);
      if (retention > 0) {
        await this.retention.withhold({
          partyType: 'customer', projectId, partyRef: p.customerName ?? undefined, sourceDocType: 'CLAIM', sourceDocNo: claimNo,
          amount: retention, tenantId, createdBy: user.username,
        }, tx);
      }
      await tx.update(projectProgressClaims).set({
        status: 'certified', certifiedBy: user.username, certifiedAt: new Date(),
        retentionAmount: String(retention), netPayable: String(net), vatAmount: String(vat), costRecognized: String(costRecognized), entryNo: je.entry_no, updatedAt: new Date(),
      }).where(eq(projectProgressClaims.id, Number(c.id)));
      await tx.update(projects).set({
        billedToDate: String(newBilled), recognizedCost: String(r2(n(p.recognizedCost) + costRecognized)),
      }).where(eq(projects.id, projectId));
      return je.entry_no;
    });

    return { claim_no: claimNo, entry_no: entryNo, status: 'certified', gross, retention, retention_pct: retentionPct, net_payable: net, vat, vat_pct: vatPct, ar_total: arTotal, rev_method: isPoc ? 'poc' : 'billing', revenue, cost_recognized: costRecognized, contract_asset_cleared: contractAssetCleared, billings_in_excess: billingsInExcess };
  }

  async get(claimNo: string) {
    const c = await this.claimRow(claimNo);
    const lines = await this.db.select().from(progressClaimLines).where(eq(progressClaimLines.claimId, Number(c.id))).orderBy(progressClaimLines.id);
    return {
      claim_no: c.claimNo, seq: c.seq, period: c.period, status: c.status,
      gross_this_claim: n(c.grossThisClaim), prev_certified: n(c.prevCertified), cumulative_certified: n(c.cumulativeCertified),
      retention_pct: n(c.retentionPct), retention_amount: n(c.retentionAmount), net_payable: n(c.netPayable),
      vat_pct: n(c.vatPct), vat_amount: n(c.vatAmount), rev_method: c.revMethod, cost_recognized: n(c.costRecognized),
      entry_no: c.entryNo, created_by: c.createdBy, certified_by: c.certifiedBy, certified_at: c.certifiedAt,
      lines: lines.map((l: any) => ({
        boq_line_id: Number(l.boqLineId), description: l.description, budget_amount: n(l.budgetAmount),
        pct_complete_to_date: n(l.pctCompleteToDate), value_to_date: n(l.valueToDate), previously_certified: n(l.previouslyCertified), value_this_claim: n(l.valueThisClaim),
      })),
    };
  }

  async listForProject(code: string) {
    const p = await this.projectRow(code);
    const rows = await this.db.select().from(projectProgressClaims).where(eq(projectProgressClaims.projectId, Number(p.id))).orderBy(desc(projectProgressClaims.id));
    const certifiedGross = r2(rows.filter((r: any) => r.status === 'certified').reduce((s: number, r: any) => s + n(r.grossThisClaim), 0));
    const retentionHeld = r2(rows.filter((r: any) => r.status === 'certified').reduce((s: number, r: any) => s + n(r.retentionAmount), 0));
    return {
      project_code: code,
      contract_amount: n(p.contractAmount),
      certified_to_date: certifiedGross,
      retention_withheld: retentionHeld,
      claims: rows.map((r: any) => ({
        claim_no: r.claimNo, seq: r.seq, period: r.period, status: r.status,
        gross_this_claim: n(r.grossThisClaim), retention_amount: n(r.retentionAmount), net_payable: n(r.netPayable),
        cumulative_certified: n(r.cumulativeCertified), certified_by: r.certifiedBy, certified_at: r.certifiedAt,
      })),
    };
  }

  // Resolve the caller's own tenant profile as the document issuer (our-company header).
  private async sellerFor(user: JwtUser): Promise<DocParty> {
    const [t] = user.tenantId != null ? await this.db.select().from(tenants).where(eq(tenants.id, Number(user.tenantId))).limit(1) : [null];
    return sellerParty(t);
  }

  // Assemble the printable ใบวางบิลงวดงาน / ใบกำกับภาษี (progress-claim tax invoice, docs/35 P1). Seller = the
  // caller's company; customer = the project's employer (customer_name on the project); lines = the certified
  // BoQ movement on the claim. Retention/VAT/AR-total mirror the certification JE.
  async getClaimForPrint(claimNo: string, user: JwtUser): Promise<ProgressClaimPrintData> {
    const c = await this.claimRow(claimNo);
    const [p] = await this.db.select().from(projects).where(eq(projects.id, Number(c.projectId))).limit(1);
    const lines = await this.db.select().from(progressClaimLines).where(eq(progressClaimLines.claimId, Number(c.id))).orderBy(progressClaimLines.id);
    const gross = r2(n(c.grossThisClaim));
    const retentionPct = n(c.retentionPct);
    const retention = r2(n(c.retentionAmount));
    const net = r2(gross - retention);
    const vatPct = n(c.vatPct);
    const vat = r2(n(c.vatAmount));
    return {
      claim_no: c.claimNo, seq: Number(c.seq), period: c.period, status: String(c.status),
      certified_by: c.certifiedBy ?? null, certified_at: c.certifiedAt,
      seller: await this.sellerFor(user),
      customer: { name: p?.customerName || 'ผู้ว่าจ้าง', address: '-', tax_id: null, branch_label: null, phone: null, email: null },
      project_code: p?.projectCode ?? '', project_name: p?.name ?? null,
      lines: lines.map((l: any) => ({ description: l.description, pct: n(l.pctCompleteToDate), value_to_date: n(l.valueToDate), previously_certified: n(l.previouslyCertified), value_this_claim: n(l.valueThisClaim) })),
      gross, retention_pct: retentionPct, retention, net, vat_pct: vatPct, vat, ar_total: r2(net + vat),
    };
  }

  claimHtml(data: ProgressClaimPrintData): string {
    if (!this.claimPdf) throw new NotFoundException({ code: 'RENDERER_UNAVAILABLE', message: 'Progress claim renderer not wired' });
    return this.claimPdf.claimHtml(data);
  }

  async renderClaimPdf(data: ProgressClaimPrintData): Promise<Buffer | null> {
    return this.claimPdf ? this.claimPdf.renderToPdf(this.claimPdf.claimHtml(data)) : null;
  }

  // Email the ใบวางบิลงวดงาน to the employer as a PDF attachment (HTML fallback when Chromium absent).
  async emailClaim(claimNo: string, toEmail: string | undefined, user: JwtUser) {
    if (!this.docEmail) throw new NotFoundException({ code: 'EMAIL_UNAVAILABLE', message: 'Email path not wired' });
    const data = await this.getClaimForPrint(claimNo, user);
    const res = await this.docEmail.sendDocument({
      to: toEmail?.trim() || data.customer.email || '', from: data.seller.email ?? undefined, filename: data.claim_no,
      subject: `ใบวางบิลงวดงาน ${data.claim_no} จาก ${data.seller.name}`,
      text: `เรียน ${data.customer.name},\n\nแนบใบวางบิลงวดงานเลขที่ ${data.claim_no} (งวดที่ ${data.seq}) จำนวนเงินที่เรียกเก็บ ${data.ar_total.toLocaleString()} บาท\n\nขอบคุณครับ\n${data.seller.name}`,
      html: this.claimHtml(data),
    });
    return { ...res, claim_no: data.claim_no };
  }
}
