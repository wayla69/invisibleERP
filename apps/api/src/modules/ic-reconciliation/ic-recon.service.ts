import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, ne, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { icReconPeriods } from '../../database/schema/ic-recon';
import { consolidationGroups } from '../../database/schema/consolidation';
import { journalEntries, journalLines } from '../../database/schema/ledger';
import { icTransactions } from '../../database/schema/intercompany';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

// REC-03 — per-period intercompany reconciliation sign-off. Preparer reconciles (Prepared); an independent
// approver signs off (Approved). consolidation.runConsolidation() is gated on an Approved row for the period,
// so the group's IC balances are reconciled BEFORE consolidation eliminates them. HQ-only; maker-checker.
@Injectable()
export class IcReconService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private hqOnly(user: JwtUser) {
    if (user.role !== 'Admin') throw new ForbiddenException({ code: 'IC_RECON_HQ_ONLY', message: 'Intercompany reconciliation is HQ-only', messageTh: 'การกระทบยอดระหว่างกันทำได้เฉพาะสำนักงานใหญ่' });
  }

  private async assertGroup(groupId: number) {
    const db = this.db as any;
    const [g] = await db.select().from(consolidationGroups).where(eq(consolidationGroups.id, groupId)).limit(1);
    if (!g) throw new NotFoundException({ code: 'GROUP_NOT_FOUND', message: `Consolidation group ${groupId} not found`, messageTh: 'ไม่พบกลุ่มกิจการ' });
    return g;
  }

  // Snapshot the group's IC reconciliation: Due-From (1150) vs Due-To (2150) net balances + count of IC
  // items not yet settled. Mirrors consolidation.reconciliation() but self-contained (no service dependency).
  private async snapshot() {
    const db = this.db as any;
    const [df] = await db.select({ v: sql<string>`coalesce(sum(${journalLines.debit}) - sum(${journalLines.credit}),0)` })
      .from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(eq(journalLines.accountCode, '1150'), eq(journalEntries.status, 'Posted')));
    const [dt] = await db.select({ v: sql<string>`coalesce(sum(${journalLines.credit}) - sum(${journalLines.debit}),0)` })
      .from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(eq(journalLines.accountCode, '2150'), eq(journalEntries.status, 'Posted')));
    const [oc] = await db.select({ c: sql<string>`count(*)` }).from(icTransactions).where(ne(icTransactions.status, 'Settled'));
    const dueFrom = round4(n(df?.v)), dueTo = round4(n(dt?.v));
    return { dueFrom, dueTo, eliminates: Math.abs(dueFrom - dueTo) < 0.01, unmatched: Number(oc?.c ?? 0) };
  }

  // Preparer: reconcile + sign for the period (upsert per group/period; a prior Rejected/Prepared is refreshed).
  async preparePeriod(groupId: number, period: string, user: JwtUser) {
    this.hqOnly(user);
    await this.assertGroup(groupId);
    const db = this.db as any;
    const snap = await this.snapshot();
    const [existing] = await db.select().from(icReconPeriods).where(and(eq(icReconPeriods.groupId, groupId), eq(icReconPeriods.period, period))).limit(1);
    if (existing?.status === 'Approved') throw new BadRequestException({ code: 'ALREADY_APPROVED', message: `IC reconciliation for ${period} is already approved`, messageTh: 'งวดนี้อนุมัติแล้ว' });
    const values: any = {
      tenantId: user.tenantId ?? null, groupId, period, status: 'Prepared',
      totalDueFrom: String(snap.dueFrom), totalDueTo: String(snap.dueTo), eliminates: snap.eliminates, unmatchedCount: snap.unmatched,
      preparedBy: user.username, preparedAt: new Date(), approvedBy: null, approvedAt: null, rejectionReason: null,
    };
    if (existing) await db.update(icReconPeriods).set(values).where(eq(icReconPeriods.id, existing.id));
    else await db.insert(icReconPeriods).values(values);
    return this.getStatus(groupId, period, user);
  }

  // Checker: approve (SoD — approver ≠ preparer; the IC balances MUST eliminate to be signed off).
  async approvePeriod(groupId: number, period: string, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db as any;
    const [rp] = await db.select().from(icReconPeriods).where(and(eq(icReconPeriods.groupId, groupId), eq(icReconPeriods.period, period))).limit(1);
    if (!rp) throw new NotFoundException({ code: 'NOT_PREPARED', message: `IC reconciliation for ${period} has not been prepared`, messageTh: 'ยังไม่ได้จัดทำการกระทบยอด' });
    if (rp.status !== 'Prepared') throw new BadRequestException({ code: 'NOT_PREPARED', message: `IC reconciliation is ${rp.status}, not Prepared`, messageTh: 'สถานะไม่ใช่ Prepared' });
    if (rp.preparedBy && rp.preparedBy === user.username) throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'Maker-checker: the approver must differ from the preparer', messageTh: 'ผู้อนุมัติต้องไม่ใช่ผู้จัดทำ (แบ่งแยกหน้าที่)' });
    if (!rp.eliminates) throw new BadRequestException({ code: 'IC_NOT_ELIMINATED', message: 'Intercompany balances do not eliminate (Due-From ≠ Due-To) — resolve before approving', messageTh: 'ยอดระหว่างกันไม่ตัดกัน (ลูกหนี้ ≠ เจ้าหนี้ระหว่างกัน) ต้องแก้ไขก่อนอนุมัติ' });
    await db.update(icReconPeriods).set({ status: 'Approved', approvedBy: user.username, approvedAt: new Date() }).where(eq(icReconPeriods.id, rp.id));
    return this.getStatus(groupId, period, user);
  }

  async rejectPeriod(groupId: number, period: string, reason: string, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db as any;
    const [rp] = await db.select().from(icReconPeriods).where(and(eq(icReconPeriods.groupId, groupId), eq(icReconPeriods.period, period))).limit(1);
    if (!rp) throw new NotFoundException({ code: 'NOT_PREPARED', message: 'IC reconciliation has not been prepared', messageTh: 'ยังไม่ได้จัดทำ' });
    if (rp.status !== 'Prepared') throw new BadRequestException({ code: 'NOT_PREPARED', message: `IC reconciliation is ${rp.status}, not Prepared`, messageTh: 'สถานะไม่ใช่ Prepared' });
    await db.update(icReconPeriods).set({ status: 'Rejected', rejectionReason: reason ?? null }).where(eq(icReconPeriods.id, rp.id));
    return this.getStatus(groupId, period, user);
  }

  async getStatus(groupId: number, period: string, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db as any;
    const [rp] = await db.select().from(icReconPeriods).where(and(eq(icReconPeriods.groupId, groupId), eq(icReconPeriods.period, period))).limit(1);
    if (!rp) return { group_id: groupId, period, status: 'None' };
    return this.shape(rp);
  }

  async list(groupId: number, user: JwtUser) {
    this.hqOnly(user);
    const db = this.db as any;
    const rows = await db.select().from(icReconPeriods).where(eq(icReconPeriods.groupId, groupId)).orderBy(sql`${icReconPeriods.period} DESC`);
    return { periods: rows.map((r: any) => this.shape(r)), count: rows.length };
  }

  private shape(r: any) {
    return {
      id: Number(r.id), group_id: Number(r.groupId), period: r.period, status: r.status,
      total_due_from: n(r.totalDueFrom), total_due_to: n(r.totalDueTo), eliminates: r.eliminates, unmatched_count: Number(r.unmatchedCount ?? 0),
      prepared_by: r.preparedBy, prepared_at: r.preparedAt, approved_by: r.approvedBy, approved_at: r.approvedAt, rejection_reason: r.rejectionReason,
    };
  }
}
