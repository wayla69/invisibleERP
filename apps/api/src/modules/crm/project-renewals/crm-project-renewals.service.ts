import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { projects, projectPhaseGates, crmAccounts, crmOpportunities, projectRenewals } from '../../../database/schema';
import { n } from '../../../database/queries';
import type { JwtUser } from '../../../common/decorators';
import { CrmPipelineService } from '../pipeline/crm-pipeline.service';

// CRM↔PPM back-flow (control CRM-18, migration 0415). When a project is DELIVERED (status Closed), its customer
// represents a renewal / expansion motion — but nothing today ensures a renewal opportunity exists, so
// recurring revenue silently lapses. This service surfaces delivered projects that lack a renewal motion (a
// detective GAP list) and raises the renewal as a governed, idempotent action. It reads projects (a
// cross-domain READ, like account-health reads service_cases) but WRITES only CRM data — the renewal
// opportunity is created through CrmPipelineService (CRM-domain), and project_renewals is the CRM-owned link +
// idempotency key. No project row is mutated; the golden-master'd project-close path is untouched.
export interface RaiseRenewalDto { amount?: number; name?: string }

@Injectable()
export class CrmProjectRenewalsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly pipeline: CrmPipelineService,
  ) {}

  // "Delivered" = the project has passed its final phase gate to the 'closed' lifecycle phase (PROJ-26): the
  // current phase is the target of the latest GO gate. Read the go-gates and keep the projects whose latest
  // GO target is 'closed'. (Cross-domain READ of project_phase_gates, correlated in app code — no JOIN.)
  private async deliveredProjectIds(): Promise<Set<number>> {
    const goGates = await this.db.select().from(projectPhaseGates).where(eq(projectPhaseGates.status, 'go')).orderBy(asc(projectPhaseGates.id));
    const latestPhase = new Map<number, string>();
    for (const g of goGates) latestPhase.set(Number(g.projectId), g.targetPhase); // asc → last wins = latest GO
    return new Set([...latestPhase.entries()].filter(([, ph]) => ph === 'closed').map(([id]) => id));
  }

  // Delivered projects + whether each has a renewal motion; the gap list is the detective worklist.
  async listRenewals(_user: JwtUser) {
    const db = this.db;
    const deliveredIds = await this.deliveredProjectIds();
    const delivered = deliveredIds.size
      ? (await db.select().from(projects).orderBy(asc(projects.id))).filter((p: any) => deliveredIds.has(Number(p.id)))
      : [];
    const raised = await db.select().from(projectRenewals);
    const raisedByProject = new Map(raised.map((r: any) => [r.projectCode, r]));
    // Correlate a project to a CRM account by customer_no (read separately, correlate in app code — no
    // cross-domain JOIN in the query).
    const custNos = [...new Set(delivered.map((p: any) => p.customerNo).filter(Boolean))] as string[];
    const accts = custNos.length ? await db.select().from(crmAccounts).where(inArray(crmAccounts.customerNo, custNos)) : [];
    const acctByCust = new Map(accts.map((a: any) => [a.customerNo, a]));

    const rows = delivered.map((p: any) => {
      const link = raisedByProject.get(p.projectCode);
      const acct = p.customerNo ? acctByCust.get(p.customerNo) : undefined;
      return {
        project_code: p.projectCode, name: p.name, customer_no: p.customerNo,
        contract_amount: n(p.contractAmount), account_no: acct?.accountNo ?? null, account_name: acct?.name ?? null,
        renewal_raised: !!link, renewal_opp_no: link?.opportunityNo ?? null,
        // a gap = delivered, has a CRM account to renew on, and no renewal raised yet
        is_gap: !link && !!acct,
      };
    });
    const gaps = rows.filter((r) => r.is_gap);
    return {
      delivered: rows,
      gaps,
      counts: { delivered: rows.length, raised: rows.filter((r) => r.renewal_raised).length, gaps: gaps.length },
    };
  }

  // Raise a renewal opportunity from a delivered project. Idempotent (one per project). The opportunity is
  // created through the CRM pipeline service and tagged deal_type='renewal'; the link is recorded.
  async raiseRenewal(projectCode: string, dto: RaiseRenewalDto, user: JwtUser) {
    const db = this.db;
    const [proj] = await db.select().from(projects).where(eq(projects.projectCode, projectCode)).limit(1);
    if (!proj) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: `Project ${projectCode} not found`, messageTh: 'ไม่พบโครงการ' });
    const deliveredIds = await this.deliveredProjectIds();
    if (!deliveredIds.has(Number(proj.id))) throw new BadRequestException({ code: 'PROJECT_NOT_DELIVERED', message: "A renewal can be raised only from a delivered project (its phase gate must have reached the 'closed' phase)", messageTh: 'ยกเลิก: ต้องเป็นโครงการที่ผ่านเกตถึงเฟส closed แล้ว' });

    const [existing] = await db.select().from(projectRenewals).where(eq(projectRenewals.projectCode, projectCode)).limit(1);
    if (existing) throw new BadRequestException({ code: 'RENEWAL_EXISTS', message: `A renewal (${existing.opportunityNo}) was already raised for this project`, messageTh: 'ได้สร้างดีลต่ออายุสำหรับโครงการนี้แล้ว', details: { opportunity_no: existing.opportunityNo } });

    if (!proj.customerNo) throw new BadRequestException({ code: 'NO_CUSTOMER', message: 'The project has no customer-of-record to renew', messageTh: 'โครงการไม่มีลูกค้าที่บันทึกไว้' });
    const [acct] = await db.select().from(crmAccounts).where(eq(crmAccounts.customerNo, proj.customerNo)).limit(1);
    if (!acct) throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND', message: `No CRM account for customer ${proj.customerNo}`, messageTh: 'ไม่พบบัญชี CRM ของลูกค้ารายนี้' });

    const amount = dto.amount != null ? Math.max(0, n(dto.amount)) : n(proj.contractAmount);
    const name = (dto.name ?? '').trim() || `Renewal — ${proj.name}`;
    // CRM-domain write: create the opportunity through the pipeline service (opp_no, stage history, RLS).
    const created = await this.pipeline.createOpportunity({ name, account_no: acct.accountNo, customer_no: proj.customerNo, amount }, user);
    // Tag it a renewal (in-CRM-domain column update, RLS-scoped by opp_no).
    await db.update(crmOpportunities).set({ dealType: 'renewal' }).where(eq(crmOpportunities.oppNo, created.opp_no));
    await db.insert(projectRenewals).values({
      tenantId: user.tenantId ?? null, projectCode, opportunityNo: created.opp_no,
      accountNo: acct.accountNo, amount: amount.toFixed(2), raisedBy: user.username,
    });
    return { project_code: projectCode, opportunity_no: created.opp_no, account_no: acct.accountNo, amount, deal_type: 'renewal' };
  }
}
