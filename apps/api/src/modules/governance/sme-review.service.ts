import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { and, eq, gte, lt, desc, ilike, or, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { selfApprovals, smeReviewSignoffs } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { isPlatformAdmin } from '../../common/decorators';
import { bizYm } from '../../common/bizdate';
import { appendAuditMeta } from '../../common/tenant-context';

export interface RegistryFilters { from?: string; to?: string; event?: string; q?: string; limit?: number }

// SME-02 (docs/49) — attestation that the SME-01 self-approval review was OPERATED. SME-01
// (sme_self_approval_review) surfaces every allowed self-approval; SME-02 records that an independent
// reviewer actually reviewed a period. Two legs (owner decision 2026-07-15 — SME-01 goes to BOTH):
//   • 'accountant' — a tenant-side independent reviewer (a user holding the `sme_review` duty; typically the
//     company's external accountant given a limited login so the review stays independent of the operator).
//   • 'platform'   — the platform owner (god), acting-as the tenant.
// The caller's leg is DERIVED from the principal (never client input): a platform owner ⇒ 'platform', any
// other tenant user ⇒ 'accountant'. Idempotent per (tenant, period, kind): re-signing refreshes the snapshot.
export const SME_REVIEW_KINDS = ['accountant', 'platform'] as const;
export type SmeReviewKind = (typeof SME_REVIEW_KINDS)[number];

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** [start, end) UTC instants bounding a 'YYYY-MM' BUSINESS month (Asia/Bangkok), for a timestamptz filter. */
function periodWindow(period: string): { start: Date; end: Date } {
  const y = Number(period.slice(0, 4));
  const mo = Number(period.slice(5, 7)); // 1-12 (period already validated by PERIOD_RE)
  const offMin = Number(process.env.BUSINESS_TZ_OFFSET_MIN ?? 420);
  const start = new Date(Date.UTC(y, mo - 1, 1, 0, 0, 0) - offMin * 60_000);
  const end = new Date(Date.UTC(y, mo, 1, 0, 0, 0) - offMin * 60_000);
  return { start, end };
}

@Injectable()
export class SmeReviewService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  /** The reviewer leg for this principal — platform owner ⇒ 'platform', else 'accountant'. */
  private kindOf(user: JwtUser): SmeReviewKind {
    return isPlatformAdmin(user.username) ? 'platform' : 'accountant';
  }

  private assertPeriod(period: string): string {
    if (!PERIOD_RE.test(period)) {
      throw new BadRequestException({ code: 'BAD_PERIOD', message: 'period must be YYYY-MM', messageTh: 'รูปแบบงวดต้องเป็น ปปปป-ดด (YYYY-MM)' });
    }
    return period;
  }

  private assertTenant(user: JwtUser): number {
    if (user.tenantId == null) {
      throw new BadRequestException({ code: 'NO_TENANT_CONTEXT', message: 'A tenant context is required to sign off a review (a platform owner must act-as the company).', messageTh: 'ต้องอยู่ในบริบทบริษัท (god ต้องเลือกบริษัทก่อนลงนาม)' });
    }
    return user.tenantId;
  }

  /** Snapshot: self-approvals recorded within the business month, scoped to the tenant. */
  private async periodSnapshot(tenantId: number, period: string): Promise<{ count: number; total: number }> {
    const { start, end } = periodWindow(period);
    const rows = await this.db
      .select({ amount: selfApprovals.amount })
      .from(selfApprovals)
      .where(and(eq(selfApprovals.tenantId, tenantId), gte(selfApprovals.createdAt, start), lt(selfApprovals.createdAt, end)));
    const total = rows.reduce((s: number, r: any) => s + (r.amount != null ? Number(r.amount) : 0), 0);
    return { count: rows.length, total: Math.round(total * 100) / 100 };
  }

  /**
   * Record (or refresh) the current principal's attestation for a period. Snapshots the self-approval
   * count/amount reviewed. Idempotent: re-signing the same (tenant, period, kind) updates the snapshot,
   * note and timestamp rather than duplicating — the audit_log marker captures each attestation event.
   */
  async signoff(user: JwtUser, body: { period?: string; note?: string }) {
    const tenantId = this.assertTenant(user);
    const period = this.assertPeriod(body.period?.trim() || bizYm());
    const kind = this.kindOf(user);
    const note = (body.note ?? '').trim() || null;
    const snap = await this.periodSnapshot(tenantId, period);

    await this.db
      .insert(smeReviewSignoffs)
      .values({ tenantId, period, reviewerKind: kind, reviewerUsername: user.username, itemCount: snap.count, totalAmount: String(snap.total), note })
      .onConflictDoUpdate({
        target: [smeReviewSignoffs.tenantId, smeReviewSignoffs.period, smeReviewSignoffs.reviewerKind],
        set: { reviewerUsername: user.username, itemCount: snap.count, totalAmount: String(snap.total), note, signedAt: new Date() },
      });
    appendAuditMeta({ sme_review_signoff: { period, kind, item_count: snap.count } });
    return this.status(user, period);
  }

  /** Per-period attestation status: the reviewed count + who signed which leg + which legs are outstanding. */
  async status(user: JwtUser, periodArg?: string) {
    const tenantId = this.assertTenant(user);
    const period = this.assertPeriod(periodArg?.trim() || bizYm());
    const snap = await this.periodSnapshot(tenantId, period);
    const rows = await this.db
      .select()
      .from(smeReviewSignoffs)
      .where(and(eq(smeReviewSignoffs.tenantId, tenantId), eq(smeReviewSignoffs.period, period)));
    const signoffs = rows.map((r: any) => ({
      kind: r.reviewerKind as SmeReviewKind, username: r.reviewerUsername,
      item_count: r.itemCount, total_amount: Number(r.totalAmount), note: r.note, signed_at: r.signedAt,
    }));
    const signedKinds = new Set(signoffs.map((s) => s.kind));
    const outstanding = SME_REVIEW_KINDS.filter((k) => !signedKinds.has(k));
    return {
      period,
      item_count: snap.count,
      total_amount: snap.total,
      signoffs,
      outstanding,
      // "fully attested" once BOTH independent legs have signed a period that has items to review; a period
      // with zero self-approvals needs no attestation (nothing was operated) — complete by definition.
      complete: snap.count === 0 || outstanding.length === 0,
    };
  }

  /** The self-approvals in a period (what a reviewer signs off) — so the review screen shows the evidence. */
  async items(user: JwtUser, periodArg?: string) {
    const tenantId = this.assertTenant(user);
    const period = this.assertPeriod(periodArg?.trim() || bizYm());
    const { start, end } = periodWindow(period);
    const rows = await this.db
      .select()
      .from(selfApprovals)
      .where(and(eq(selfApprovals.tenantId, tenantId), gte(selfApprovals.createdAt, start), lt(selfApprovals.createdAt, end)))
      .orderBy(desc(selfApprovals.createdAt))
      .limit(1000);
    return {
      period,
      items: rows.map((r: any) => ({
        at: r.createdAt, event: r.event, ref: r.ref, username: r.username,
        amount: r.amount != null ? Number(r.amount) : null, reason: r.reason,
      })),
    };
  }

  /** Build the WHERE conditions for a registry query (tenant-scoped + optional date/event/text filters). */
  private registryConds(tenantId: number, f: RegistryFilters): SQL[] {
    const conds: SQL[] = [eq(selfApprovals.tenantId, tenantId)];
    if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) {
      const offMin = Number(process.env.BUSINESS_TZ_OFFSET_MIN ?? 420);
      conds.push(gte(selfApprovals.createdAt, new Date(new Date(`${f.from}T00:00:00Z`).getTime() - offMin * 60_000)));
    }
    if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) {
      const offMin = Number(process.env.BUSINESS_TZ_OFFSET_MIN ?? 420);
      // inclusive end-of-day: < the next day's Bangkok midnight
      conds.push(lt(selfApprovals.createdAt, new Date(new Date(`${f.to}T00:00:00Z`).getTime() + 86_400_000 - offMin * 60_000)));
    }
    if (f.event) conds.push(eq(selfApprovals.event, f.event));
    if (f.q && f.q.trim()) {
      const like = `%${f.q.trim()}%`;
      const m = or(ilike(selfApprovals.reason, like), ilike(selfApprovals.ref, like), ilike(selfApprovals.username, like), ilike(selfApprovals.event, like));
      if (m) conds.push(m);
    }
    return conds;
  }

  /**
   * The self-approval REGISTRY — a cross-period, filterable browse of every allowed self-approval for the
   * tenant (the SME owner + external auditor's evidence view). Returns the filtered rows plus a summary
   * (by event, and by business month WITH that month's attestation completeness) so an auditor can see at a
   * glance which periods are signed off. Tenant-scoped by RLS + the explicit filter.
   */
  async registry(user: JwtUser, f: RegistryFilters) {
    const tenantId = this.assertTenant(user);
    const conds = this.registryConds(tenantId, f);
    const limit = Math.min(Math.max(Number(f.limit) || 500, 1), 5000);
    const rows = await this.db.select().from(selfApprovals).where(and(...conds)).orderBy(desc(selfApprovals.createdAt)).limit(limit);

    const byEvent = new Map<string, number>();
    const byPeriod = new Map<string, { count: number; total: number }>();
    let total = 0;
    for (const r of rows) {
      const amt = r.amount != null ? Number(r.amount) : 0;
      total += amt;
      byEvent.set(r.event, (byEvent.get(r.event) ?? 0) + 1);
      const period = bizYm(new Date(r.createdAt ?? Date.now()));
      const p = byPeriod.get(period) ?? { count: 0, total: 0 };
      p.count += 1; p.total += amt;
      byPeriod.set(period, p);
    }
    // Attestation completeness per period in view: a period is complete when BOTH legs have signed.
    const periods = [...byPeriod.keys()];
    const signRows = periods.length
      ? await this.db.select().from(smeReviewSignoffs).where(and(eq(smeReviewSignoffs.tenantId, tenantId)))
      : [];
    const legsByPeriod = new Map<string, Set<string>>();
    for (const s of signRows) {
      if (!legsByPeriod.has(s.period)) legsByPeriod.set(s.period, new Set());
      legsByPeriod.get(s.period)!.add(s.reviewerKind);
    }

    return {
      count: rows.length,
      total_amount: Math.round(total * 100) / 100,
      by_event: [...byEvent.entries()].map(([event, count]) => ({ event, count })).sort((a, b) => b.count - a.count),
      by_period: periods.sort().reverse().map((period) => ({
        period,
        count: byPeriod.get(period)!.count,
        total_amount: Math.round(byPeriod.get(period)!.total * 100) / 100,
        complete: SME_REVIEW_KINDS.every((k) => legsByPeriod.get(period)?.has(k)),
      })),
      items: rows.map((r) => ({
        at: r.createdAt, period: bizYm(new Date(r.createdAt ?? Date.now())), event: r.event, ref: r.ref,
        username: r.username, amount: r.amount != null ? Number(r.amount) : null, reason: r.reason,
      })),
    };
  }

  /** The registry as a CSV string (auditor export). Same filters as registry(). */
  async registryCsv(user: JwtUser, f: RegistryFilters): Promise<string> {
    const tenantId = this.assertTenant(user);
    const conds = this.registryConds(tenantId, f);
    const rows = await this.db.select().from(selfApprovals).where(and(...conds)).orderBy(desc(selfApprovals.createdAt)).limit(5000);
    const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = ['at,period,event,ref,username,amount,reason'];
    for (const r of rows) {
      lines.push([r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt, bizYm(new Date(r.createdAt ?? Date.now())), r.event, r.ref, r.username, r.amount ?? '', r.reason].map(esc).join(','));
    }
    return lines.join('\n');
  }

  /** Recent attestations for the tenant (audit browse), newest first. */
  async list(user: JwtUser, limit = 100) {
    const tenantId = this.assertTenant(user);
    const rows = await this.db
      .select()
      .from(smeReviewSignoffs)
      .where(eq(smeReviewSignoffs.tenantId, tenantId))
      .orderBy(desc(smeReviewSignoffs.signedAt))
      .limit(Math.min(Math.max(Number(limit) || 100, 1), 500));
    return {
      signoffs: rows.map((r: any) => ({
        period: r.period, kind: r.reviewerKind, username: r.reviewerUsername,
        item_count: r.itemCount, total_amount: Number(r.totalAmount), note: r.note, signed_at: r.signedAt,
      })),
    };
  }
}
