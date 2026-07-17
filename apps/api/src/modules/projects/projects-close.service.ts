import { eq, and, desc, sql } from 'drizzle-orm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DrizzleDb } from '../../database/database.module';
import { projects, projectCloseReviews } from '../../database/schema';
import type { LedgerReadService } from '../ledger/ledger-read.service';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';
import { r2 } from './projects.helpers';

// PROJ-03 period-end project-close review sub-service — a PLAIN class built in the ProjectsService ctor
// body (not a DI provider), extracted from the facade in the docs/46 Phase-4 projects round. Preparer
// snapshots unbilled-WIP (GL 1260) + the applied-costs clearing balance (GL 2390) + open-project count and
// signs; an independent checker approves (SoD). GL balances come through LedgerReadService (docs/46 Phase 3
// boundary) so this file never joins the journal tables directly.
export class ProjectsCloseService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly ledgerRead: LedgerReadService,
  ) {}

  // Snapshot unbilled-WIP (GL 1260, Σdebit−Σcredit) + the clearing balance (GL 2390, Σcredit−Σdebit) +
  // open-project count. No tenant filter here (matches the pre-extraction behaviour) — the caller's RLS
  // session scopes the rows, and accountNet without tenantId applies no extra filter.
  private async closeSnapshot() {
    const wip = await this.ledgerRead.accountNet(['1260']);
    const clr = -(await this.ledgerRead.accountNet(['2390']));
    const [op] = await this.db.select({ c: sql<string>`count(*)` }).from(projects).where(sql`${projects.status} not in ('Closed','Completed','Cancelled')`);
    return { wipTotal: r2(wip), clearingBalance: r2(clr), openProjects: Number(op?.c ?? 0) };
  }

  // Preparer: snapshot + sign the period's WIP/clearing review (upsert per tenant/period; a prior
  // Rejected/Prepared is refreshed). A control account that gets reviewed at close (PROJ-03, detective).
  async prepareCloseReview(period: string, user: JwtUser) {
    if (!/^\d{4}-\d{2}$/.test(period)) throw new BadRequestException({ code: 'BAD_PERIOD', message: 'period must be YYYY-MM', messageTh: 'งวดต้องเป็น YYYY-MM' });
    const db = this.db;
    const snap = await this.closeSnapshot();
    const [existing] = await db.select().from(projectCloseReviews).where(and(eq(projectCloseReviews.tenantId, user.tenantId!), eq(projectCloseReviews.period, period))).limit(1);
    if (existing?.status === 'Approved') throw new BadRequestException({ code: 'ALREADY_APPROVED', message: `Project close review for ${period} is already approved`, messageTh: 'งวดนี้อนุมัติแล้ว' });
    const values: any = {
      tenantId: user.tenantId ?? null, period, status: 'Prepared',
      wipTotal: String(snap.wipTotal), clearingBalance: String(snap.clearingBalance), openProjects: snap.openProjects,
      preparedBy: user.username, preparedAt: new Date(), approvedBy: null, approvedAt: null, rejectionReason: null,
    };
    if (existing) await db.update(projectCloseReviews).set(values).where(eq(projectCloseReviews.id, existing.id));
    else await db.insert(projectCloseReviews).values(values);
    return this.getCloseReview(period, user);
  }

  // Checker: sign off (SoD — approver ≠ preparer). Detective review, so no hard numeric gate; the independent
  // sign-off IS the control.
  async approveCloseReview(period: string, user: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const [rp] = await db.select().from(projectCloseReviews).where(and(eq(projectCloseReviews.tenantId, user.tenantId!), eq(projectCloseReviews.period, period))).limit(1);
    if (!rp) throw new NotFoundException({ code: 'NOT_PREPARED', message: `Project close review for ${period} has not been prepared`, messageTh: 'ยังไม่ได้จัดทำการสอบทาน' });
    if (rp.status !== 'Prepared') throw new BadRequestException({ code: 'NOT_PREPARED', message: `Project close review is ${rp.status}, not Prepared`, messageTh: 'สถานะไม่ใช่ Prepared' });
    await assertMakerChecker(db, { user, maker: rp.preparedBy, event: 'proj.close-review.approve', ref: period, reason: selfApprovalReason, code: 'SOD_VIOLATION', message: 'Maker-checker: the approver must differ from the preparer', messageTh: 'ผู้อนุมัติต้องไม่ใช่ผู้จัดทำ (แบ่งแยกหน้าที่)' });
    await db.update(projectCloseReviews).set({ status: 'Approved', approvedBy: user.username, approvedAt: new Date() }).where(eq(projectCloseReviews.id, rp.id));
    return this.getCloseReview(period, user);
  }

  async rejectCloseReview(period: string, reason: string, user: JwtUser) {
    const db = this.db;
    const [rp] = await db.select().from(projectCloseReviews).where(and(eq(projectCloseReviews.tenantId, user.tenantId!), eq(projectCloseReviews.period, period))).limit(1);
    if (!rp) throw new NotFoundException({ code: 'NOT_PREPARED', message: 'Project close review has not been prepared', messageTh: 'ยังไม่ได้จัดทำ' });
    if (rp.status !== 'Prepared') throw new BadRequestException({ code: 'NOT_PREPARED', message: `Project close review is ${rp.status}, not Prepared`, messageTh: 'สถานะไม่ใช่ Prepared' });
    await db.update(projectCloseReviews).set({ status: 'Rejected', rejectionReason: reason ?? null }).where(eq(projectCloseReviews.id, rp.id));
    return this.getCloseReview(period, user);
  }

  async getCloseReview(period: string, user: JwtUser) {
    const db = this.db;
    const [rp] = await db.select().from(projectCloseReviews).where(and(eq(projectCloseReviews.tenantId, user.tenantId!), eq(projectCloseReviews.period, period))).limit(1);
    if (!rp) return { period, status: 'None' };
    return this.shapeCloseReview(rp);
  }

  async listCloseReviews(user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(projectCloseReviews).where(user.tenantId != null ? eq(projectCloseReviews.tenantId, user.tenantId) : undefined).orderBy(desc(projectCloseReviews.period)).limit(60);
    return { reviews: rows.map((r: any) => this.shapeCloseReview(r)), count: rows.length };
  }

  private shapeCloseReview(r: any) {
    return {
      period: r.period, status: r.status, wip_total: n(r.wipTotal), clearing_balance: n(r.clearingBalance), open_projects: Number(r.openProjects ?? 0),
      prepared_by: r.preparedBy, prepared_at: r.preparedAt, approved_by: r.approvedBy, approved_at: r.approvedAt, rejection_reason: r.rejectionReason,
    };
  }
}
