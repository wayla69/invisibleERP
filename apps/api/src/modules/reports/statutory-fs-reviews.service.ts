import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { fsStatementReviews } from '../../database/schema';
import { currentTenantStore } from '../../common/tenant-context';
import { assertMakerChecker } from '../../common/control-profile';
import type { JwtUser } from '../../common/decorators';
import { LedgerService } from '../ledger/ledger.service';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// ── FIN-4 GL-29: financial-statement issuance review & approval (maker-checker) ──
// A preparer SUBMITS a fiscal year's statutory statements for review — the key figures (assets / liabilities /
// equity / revenue / net income) are snapshotted with a hash as the "as-issued" record. A DIFFERENT user
// APPROVES it (self-approval → SOD_VIOLATION). The formatted FS pack (P9) then reads the latest Approved review
// to stamp "reviewed & approved" instead of "unaudited", and flags a re-review when the live figures drift from
// the approved hash. Read/compute over the audited GL — the control is the sign-off, not a new posting.
@Injectable()
export class StatutoryFsReviewsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly ledger: LedgerService,
  ) {}

  private tid(): number {
    const t = currentTenantStore()?.tenantId ?? null;
    if (t == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'a tenant context is required for statement review', messageTh: 'ต้องระบุกิจการสำหรับการสอบทานงบการเงิน' });
    return t;
  }

  // The as-issued key figures for a fiscal year + ledger, plus a stable hash for tamper detection.
  private async figuresFor(fiscalYear: number, ledger: string | null) {
    const fy = fiscalYear;
    const bs = await this.ledger.balanceSheet(`${fy}-12-31`, ledger);
    const is = await this.ledger.incomeStatement(`${fy}-01-01`, `${fy}-12-31`, undefined, ledger, ['CLOSE']);
    const f = {
      total_assets: round2(bs.assets),
      total_liabilities: round2(bs.liabilities),
      total_equity: round2(bs.equity + bs.net_income), // post-result equity (retained earnings after close)
      revenue: round2(is.revenue),
      net_income: round2(is.net_income),
    };
    const hash = createHash('sha256')
      .update(`${fy}|${ledger ?? 'LEADING'}|${f.total_assets}|${f.total_liabilities}|${f.total_equity}|${f.revenue}|${f.net_income}`)
      .digest('hex');
    return { figures: f, hash };
  }

  // Preparer stages a review for a period. Captures the current figures + hash as the as-issued snapshot.
  async submit(params: { fiscalYear: number; ledger?: string | null; industry?: string | null }, user: JwtUser) {
    const fy = params.fiscalYear;
    if (!fy || fy < 2000 || fy > 3000) throw new BadRequestException({ code: 'FS_BAD_FISCAL_YEAR', message: 'fiscal_year required (YYYY)', messageTh: 'ต้องระบุปีบัญชี (YYYY)' });
    const ledger = params.ledger ?? 'LEADING';
    const { figures, hash } = await this.figuresFor(fy, ledger);
    const [row] = await this.db.insert(fsStatementReviews).values({
      tenantId: this.tid(), fiscalYear: fy, ledger, industry: params.industry ?? null,
      status: 'PendingApproval',
      totalAssets: String(figures.total_assets), totalLiabilities: String(figures.total_liabilities),
      totalEquity: String(figures.total_equity), revenue: String(figures.revenue), netIncome: String(figures.net_income),
      figuresHash: hash, preparedBy: user.username,
    }).returning();
    return this.shape(row);
  }

  // A DIFFERENT user approves the staged review (maker-checker; self-approval → SOD_VIOLATION).
  async approve(id: number, user: JwtUser, body?: { self_approval_reason?: string }) {
    const [row] = await this.db.select().from(fsStatementReviews).where(and(eq(fsStatementReviews.id, id), eq(fsStatementReviews.tenantId, this.tid())));
    if (!row) throw new NotFoundException({ code: 'FS_REVIEW_NOT_FOUND', message: `statement review ${id} not found`, messageTh: `ไม่พบรายการสอบทานงบการเงิน ${id}` });
    if (row.status === 'Approved') throw new BadRequestException({ code: 'FS_REVIEW_NOT_PENDING', message: 'this review is already approved', messageTh: 'รายการนี้อนุมัติแล้ว' });
    await assertMakerChecker(this.db, {
      user, maker: row.preparedBy, event: 'gl.fs.review.approve', ref: `FSR-${id}`,
      reason: body?.self_approval_reason, code: 'SOD_VIOLATION',
      message: 'Maker-checker: you cannot approve financial statements you prepared for issuance',
      messageTh: 'ผู้จัดทำอนุมัติงบการเงินของตนเองไม่ได้ (แบ่งแยกหน้าที่)',
    });
    const [updated] = await this.db.update(fsStatementReviews)
      .set({ status: 'Approved', approvedBy: user.username, approvedAt: new Date() })
      .where(and(eq(fsStatementReviews.id, id), eq(fsStatementReviews.tenantId, this.tid())))
      .returning();
    return this.shape(updated);
  }

  // The latest Approved review for a period/ledger, with a live tamper check. Feeds the P9 pack's issuance
  // stamp. Returns null when the period has no approved review (the pack then stays "unaudited").
  async latestApproved(fiscalYear: number, ledger: string | null) {
    const [row] = await this.db.select().from(fsStatementReviews)
      .where(and(eq(fsStatementReviews.tenantId, this.tid()), eq(fsStatementReviews.fiscalYear, fiscalYear), eq(fsStatementReviews.ledger, ledger ?? 'LEADING'), eq(fsStatementReviews.status, 'Approved')))
      .orderBy(desc(fsStatementReviews.approvedAt)).limit(1);
    if (!row) return null;
    const { hash } = await this.figuresFor(fiscalYear, ledger ?? 'LEADING');
    return { ...this.shape(row), figures_changed: hash !== row.figuresHash };
  }

  async list(fiscalYear?: number) {
    const conds = [eq(fsStatementReviews.tenantId, this.tid())];
    if (fiscalYear) conds.push(eq(fsStatementReviews.fiscalYear, fiscalYear));
    const rows = await this.db.select().from(fsStatementReviews).where(and(...conds)).orderBy(desc(fsStatementReviews.preparedAt));
    return rows.map((r) => this.shape(r));
  }

  private shape(r: any) {
    return {
      id: Number(r.id), fiscal_year: r.fiscalYear, ledger: r.ledger, industry: r.industry ?? null,
      status: r.status,
      figures: {
        total_assets: r.totalAssets == null ? null : Number(r.totalAssets),
        total_liabilities: r.totalLiabilities == null ? null : Number(r.totalLiabilities),
        total_equity: r.totalEquity == null ? null : Number(r.totalEquity),
        revenue: r.revenue == null ? null : Number(r.revenue),
        net_income: r.netIncome == null ? null : Number(r.netIncome),
      },
      prepared_by: r.preparedBy ?? null, prepared_at: r.preparedAt ?? null,
      approved_by: r.approvedBy ?? null, approved_at: r.approvedAt ?? null,
    };
  }
}
