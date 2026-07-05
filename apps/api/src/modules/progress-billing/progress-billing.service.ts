import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { projects, projectBoqLines, projectProgressClaims, progressClaimLines } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import { RetentionService } from '../retention/retention.service';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
const n = (x: unknown) => Number(x ?? 0);
const EPS = 0.005;

export interface ClaimLineDto { boq_line_id: number; pct_complete_to_date: number }
export interface CreateClaimDto { project_code: string; period?: string; retention_pct?: number; lines: ClaimLineDto[] }

// Progress billing / งวดงาน (docs/35 P1, PROJ-15). The customer-side revenue engine of a construction
// contract: a periodic CLAIM values work done to date by BoQ line (cumulative % → value-to-date), bills the
// movement since the last certified claim, withholds RETENTION per the retention %, and invoices the NET.
// Certification is maker-checker (raise ≠ certify → PROJ-15). On certify it posts the billing JE (Dr 1100 AR
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

    const [h] = await this.db.insert(projectProgressClaims).values({
      tenantId, projectId, claimNo, seq, period: dto.period ?? null, status: 'draft',
      grossThisClaim: String(gross), prevCertified: String(prevCertified), cumulativeCertified: String(r2(prevCertified + gross)),
      retentionPct: String(retentionPct), retentionAmount: String(retentionAmount), netPayable: String(r2(gross - retentionAmount)),
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

  // Certify a draft claim (maker-checker: certifier ≠ preparer → PROJ-15) → post the billing JE + withhold
  // retention into the shared sub-ledger, atomically. Fixed-price contracts can't be certified beyond contract.
  async certifyClaim(claimNo: string, user: JwtUser) {
    const c = await this.claimRow(claimNo);
    if (c.status !== 'draft') throw new BadRequestException({ code: 'CLAIM_NOT_DRAFT', message: `Claim ${claimNo} is ${c.status}, not draft`, messageTh: 'งวดงานไม่ได้อยู่ในสถานะร่าง' });
    if (user.username && c.createdBy && user.username === c.createdBy)
      throw new BadRequestException({ code: 'SOD_SELF_APPROVAL', message: 'The claim preparer cannot certify their own claim (SoD)', messageTh: 'ผู้จัดทำงวดงานรับรองงวดของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });

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
    const lines: any[] = [
      { account_code: '1100', debit: net, memo: `AR ${claimNo}`, project_id: projectId },
      { account_code: '4200', credit: gross, memo: `Progress billing ${claimNo}`, project_id: projectId },
    ];
    if (retention > 0) lines.splice(1, 0, { account_code: '1170', debit: retention, memo: `Retention receivable ${claimNo}`, project_id: projectId });
    if (relieve > 0) {
      lines.push({ account_code: '5800', debit: relieve, memo: 'Project cost of services', project_id: projectId });
      lines.push({ account_code: '1260', credit: relieve, memo: `WIP relieved ${claimNo}`, project_id: projectId });
    }

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
        retentionAmount: String(retention), netPayable: String(net), costRecognized: String(relieve), entryNo: je.entry_no, updatedAt: new Date(),
      }).where(eq(projectProgressClaims.id, Number(c.id)));
      await tx.update(projects).set({
        billedToDate: String(newBilled), recognizedCost: String(r2(n(p.recognizedCost) + relieve)),
      }).where(eq(projects.id, projectId));
      return je.entry_no;
    });

    return { claim_no: claimNo, entry_no: entryNo, status: 'certified', gross, retention, retention_pct: retentionPct, net_payable: net, cost_recognized: relieve };
  }

  async get(claimNo: string) {
    const c = await this.claimRow(claimNo);
    const lines = await this.db.select().from(progressClaimLines).where(eq(progressClaimLines.claimId, Number(c.id))).orderBy(progressClaimLines.id);
    return {
      claim_no: c.claimNo, seq: c.seq, period: c.period, status: c.status,
      gross_this_claim: n(c.grossThisClaim), prev_certified: n(c.prevCertified), cumulative_certified: n(c.cumulativeCertified),
      retention_pct: n(c.retentionPct), retention_amount: n(c.retentionAmount), net_payable: n(c.netPayable), cost_recognized: n(c.costRecognized),
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
}
