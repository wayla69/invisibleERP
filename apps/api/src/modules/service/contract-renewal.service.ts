import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, lte, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { serviceContracts, contractRenewals, contractRenewalSettings } from '../../database/schema/service';
import { docCountersTenant } from '../../database/schema/system';
import { n, fx } from '../../database/queries';
import { bizYmdDash } from '../../common/bizdate';
import type { JwtUser } from '../../common/decorators';

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;
const round3 = (x: number) => Math.round((Number(x) || 0) * 1000) / 1000;

// SVC-3 (docs Track-2 audit): Service Contract Renewal & Expiry management. Built ALONGSIDE the existing
// contract/SLA/subscription surfaces — this service never touches resolveEvent, sla_events or subscriptions.
//
// SVC-02 control: a proposed renewal whose uplift_pct exceeds the tenant threshold
// (contract_renewal_settings.max_auto_uplift_pct, default 5%), OR an auto-renew that would raise price at all,
// is parked `pending` and the successor service_contracts row is created ONLY when a DIFFERENT user approves
// (approved_by ≠ requested_by → SOD_SELF_APPROVAL). Within-threshold renewals auto-approve + create at once.
@Injectable()
export class ContractRenewalService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private async nextRenewalNo(tenantId: number) {
    const r = await this.db.insert(docCountersTenant)
      .values({ docType: 'REN', tenantId, period: 'all', n: 1 })
      .onConflictDoUpdate({
        target: [docCountersTenant.docType, docCountersTenant.tenantId, docCountersTenant.period],
        set: { n: sql`${docCountersTenant.n} + 1` },
      }).returning({ n: docCountersTenant.n });
    return `REN-${String(Number(r[0]!.n)).padStart(5, '0')}`;
  }

  private async nextContractNo(tenantId: number) {
    const r = await this.db.insert(docCountersTenant)
      .values({ docType: 'SVC', tenantId, period: 'all', n: 1 })
      .onConflictDoUpdate({
        target: [docCountersTenant.docType, docCountersTenant.tenantId, docCountersTenant.period],
        set: { n: sql`${docCountersTenant.n} + 1` },
      }).returning({ n: docCountersTenant.n });
    return `SVC-${String(Number(r[0]!.n)).padStart(5, '0')}`;
  }

  private async assertContract(id: number) {
    const [c] = await this.db.select().from(serviceContracts).where(eq(serviceContracts.id, id)).limit(1);
    if (!c) throw new NotFoundException({ code: 'CONTRACT_NOT_FOUND', message: `Service contract ${id} not found`, messageTh: `ไม่พบสัญญาบริการ ${id}` });
    return c;
  }

  // ── Renewal-uplift threshold (SVC-02 config) ──
  async getSettings(user: JwtUser) {
    const tenantId = user.tenantId!;
    const [row] = await this.db.select().from(contractRenewalSettings).where(eq(contractRenewalSettings.tenantId, tenantId)).limit(1);
    return { max_auto_uplift_pct: row ? n(row.maxAutoUpliftPct) : 5, updated_by: row?.updatedBy ?? null };
  }

  async putSettings(dto: { max_auto_uplift_pct: number }, user: JwtUser) {
    const tenantId = user.tenantId!;
    const pct = round3(dto.max_auto_uplift_pct);
    if (pct < 0 || pct > 100) throw new BadRequestException({ code: 'UPLIFT_OUT_OF_RANGE', message: 'max_auto_uplift_pct must be between 0 and 100', messageTh: 'เพดานการปรับราคาต่ออายุอัตโนมัติต้องอยู่ระหว่าง 0 ถึง 100' });
    await this.db.insert(contractRenewalSettings)
      .values({ tenantId, maxAutoUpliftPct: fx(pct, 3), updatedBy: user.username })
      .onConflictDoUpdate({ target: [contractRenewalSettings.tenantId], set: { maxAutoUpliftPct: fx(pct, 3), updatedBy: user.username, updatedAt: new Date() } });
    return this.getSettings(user);
  }

  private async maxAutoUplift(tenantId: number) {
    const [row] = await this.db.select().from(contractRenewalSettings).where(eq(contractRenewalSettings.tenantId, tenantId)).limit(1);
    return row ? n(row.maxAutoUpliftPct) : 5;
  }

  // ── Propose a renewal ──
  // new_value = base × (1 + uplift/100). Within threshold + no auto-renew price rise → auto-approve + create
  // the successor immediately. Over threshold OR auto-renew-with-uplift → pending (SVC-02 maker-checker).
  async proposeRenewal(contractId: number, dto: { proposed_start?: string; proposed_end?: string; base_value?: number; uplift_pct?: number; auto_renew?: boolean; reason?: string }, user: JwtUser) {
    const tenantId = user.tenantId!;
    const contract = await this.assertContract(contractId);
    if (contract.renewalStatus === 'renewed' || contract.renewedToContractId)
      throw new BadRequestException({ code: 'CONTRACT_ALREADY_RENEWED', message: `Contract ${contract.contractNo} is already renewed`, messageTh: `สัญญา ${contract.contractNo} ถูกต่ออายุแล้ว` });
    // one in-flight renewal at a time
    const pending = await this.db.select().from(contractRenewals).where(and(eq(contractRenewals.contractId, contractId), eq(contractRenewals.status, 'pending'))).limit(1);
    if (pending.length) throw new BadRequestException({ code: 'RENEWAL_IN_FLIGHT', message: `Contract ${contract.contractNo} already has a pending renewal`, messageTh: `สัญญา ${contract.contractNo} มีคำขอต่ออายุที่รออนุมัติอยู่แล้ว` });

    const uplift = round3(dto.uplift_pct ?? n(contract.renewalUpliftPct) ?? 0);
    if (uplift < 0) throw new BadRequestException({ code: 'UPLIFT_INVALID', message: 'uplift_pct cannot be negative', messageTh: 'อัตราการปรับราคาต่ออายุติดลบไม่ได้' });
    const base = round4(dto.base_value ?? n(contract.monthlyValue));
    const newValue = round4(base * (1 + uplift / 100));
    const autoRenew = dto.auto_renew ?? contract.autoRenew;

    const proposedStart = dto.proposed_start ?? this.dayAfter(contract.endDate);
    const proposedEnd = dto.proposed_end ?? this.plusOneYear(proposedStart);

    const threshold = await this.maxAutoUplift(tenantId);
    // SVC-02 gate: over the uplift threshold, OR an auto-renew that would raise price at all.
    const needsApproval = uplift > threshold || (autoRenew && uplift > 0);

    const renewalNo = await this.nextRenewalNo(tenantId);
    const [renewal] = await this.db.insert(contractRenewals).values({
      tenantId, renewalNo, contractId,
      proposedStart, proposedEnd,
      baseValue: fx(base, 4), upliftPct: fx(uplift, 3), newValue: fx(newValue, 4),
      autoRenew, status: needsApproval ? 'pending' : 'approved',
      reason: dto.reason ?? null, requestedBy: user.username,
      decidedAt: needsApproval ? null : new Date(),
    }).returning();

    if (needsApproval) {
      await this.db.update(serviceContracts).set({ renewalStatus: 'pending' }).where(eq(serviceContracts.id, contractId));
      return { renewal: this.fmt(renewal!), requires_approval: true, auto_approved: false, threshold_pct: threshold };
    }
    // within threshold → create the successor now
    const successor = await this.createSuccessor(contract, renewal!, user.username);
    return { renewal: this.fmt(renewal!), requires_approval: false, auto_approved: true, threshold_pct: threshold, successor_contract: successor };
  }

  // ── Approve a pending renewal (SVC-02: approver ≠ requester) ──
  async approveRenewal(renewalId: number, user: JwtUser) {
    const [r] = await this.db.select().from(contractRenewals).where(eq(contractRenewals.id, renewalId)).limit(1);
    if (!r) throw new NotFoundException({ code: 'RENEWAL_NOT_FOUND', message: `Renewal ${renewalId} not found`, messageTh: `ไม่พบคำขอต่ออายุ ${renewalId}` });
    if (r.status !== 'pending') throw new BadRequestException({ code: 'RENEWAL_NOT_PENDING', message: `Renewal ${r.renewalNo} is ${r.status}, not pending`, messageTh: `คำขอต่ออายุ ${r.renewalNo} ไม่ได้อยู่ในสถานะรออนุมัติ` });
    if (r.requestedBy && r.requestedBy === user.username)
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: you cannot approve a renewal you proposed', messageTh: 'ผู้เสนอต่ออายุอนุมัติเองไม่ได้ (แบ่งแยกหน้าที่)' });

    const contract = await this.assertContract(Number(r.contractId));
    if (contract.renewalStatus === 'renewed' || contract.renewedToContractId)
      throw new BadRequestException({ code: 'CONTRACT_ALREADY_RENEWED', message: `Contract ${contract.contractNo} is already renewed`, messageTh: `สัญญา ${contract.contractNo} ถูกต่ออายุแล้ว` });

    const [updated] = await this.db.update(contractRenewals)
      .set({ status: 'approved', approvedBy: user.username, decidedAt: new Date() })
      .where(eq(contractRenewals.id, renewalId)).returning();
    const successor = await this.createSuccessor(contract, updated!, r.requestedBy ?? user.username);
    return { renewal: this.fmt(updated!), successor_contract: successor };
  }

  // ── Reject a pending renewal (leaves the old contract untouched) ──
  async rejectRenewal(renewalId: number, user: JwtUser, reason?: string) {
    const [r] = await this.db.select().from(contractRenewals).where(eq(contractRenewals.id, renewalId)).limit(1);
    if (!r) throw new NotFoundException({ code: 'RENEWAL_NOT_FOUND', message: `Renewal ${renewalId} not found`, messageTh: `ไม่พบคำขอต่ออายุ ${renewalId}` });
    if (r.status !== 'pending') throw new BadRequestException({ code: 'RENEWAL_NOT_PENDING', message: `Renewal ${r.renewalNo} is ${r.status}, not pending`, messageTh: `คำขอต่ออายุ ${r.renewalNo} ไม่ได้อยู่ในสถานะรออนุมัติ` });
    const [updated] = await this.db.update(contractRenewals)
      .set({ status: 'rejected', approvedBy: user.username, reason: reason ?? r.reason, decidedAt: new Date() })
      .where(eq(contractRenewals.id, renewalId)).returning();
    await this.db.update(serviceContracts).set({ renewalStatus: 'declined' }).where(eq(serviceContracts.id, Number(r.contractId)));
    return { renewal: this.fmt(updated!), declined: true };
  }

  // Create the successor service_contracts row + link the old one (renewal_status='renewed').
  private async createSuccessor(contract: any, renewal: any, createdBy: string) {
    const tenantId = Number(contract.tenantId);
    const contractNo = await this.nextContractNo(tenantId);
    const [succ] = await this.db.insert(serviceContracts).values({
      tenantId, contractNo, customerName: contract.customerName, slaTier: contract.slaTier,
      responseHours: contract.responseHours, resolutionHours: contract.resolutionHours,
      startDate: renewal.proposedStart, endDate: renewal.proposedEnd,
      status: 'Active', monthlyValue: fx(n(renewal.newValue), 4), currency: contract.currency,
      renewalStatus: 'none', autoRenew: renewal.autoRenew, createdBy,
    }).returning();
    await this.db.update(serviceContracts)
      .set({ renewalStatus: 'renewed', renewedToContractId: Number(succ!.id) })
      .where(eq(serviceContracts.id, Number(contract.id)));
    return { id: Number(succ!.id), contract_no: succ!.contractNo, start_date: succ!.startDate, end_date: succ!.endDate, monthly_value: n(succ!.monthlyValue), status: succ!.status };
  }

  // ── Reads ──
  async listRenewals(user: JwtUser, status?: string) {
    const conds = [eq(contractRenewals.tenantId, user.tenantId!)];
    if (status) conds.push(eq(contractRenewals.status, status));
    const rows = await this.db.select().from(contractRenewals).where(and(...conds)).orderBy(sql`${contractRenewals.id} DESC`);
    return { renewals: rows.map((r: any) => this.fmt(r)), count: rows.length };
  }

  // Detective (SVC-02): contracts nearing end_date with NO renewal in flight (renewal_status not pending/renewed).
  async expiring(user: JwtUser, days: number, asOf?: string) {
    const tenantId = user.tenantId!;
    const base = asOf ?? bizYmdDash();
    const horizon = this.plusDays(base, Number.isFinite(days) ? days : 30);
    const rows = await this.db.select().from(serviceContracts)
      .where(and(
        eq(serviceContracts.tenantId, tenantId),
        eq(serviceContracts.status, 'Active'),
        lte(serviceContracts.endDate, horizon),
      ));
    const flagged = rows
      .filter((c: any) => !['pending', 'renewed'].includes(c.renewalStatus))
      .map((c: any) => ({
        id: Number(c.id), contract_no: c.contractNo, customer_name: c.customerName,
        end_date: c.endDate, days_to_expiry: this.daysBetween(base, c.endDate),
        monthly_value: n(c.monthlyValue), auto_renew: c.autoRenew, renewal_status: c.renewalStatus,
        expired: c.endDate < base,
      }))
      .sort((a, b) => a.days_to_expiry - b.days_to_expiry);
    return { as_of: base, horizon_days: Number.isFinite(days) ? days : 30, expiring: flagged, count: flagged.length };
  }

  // ── date helpers (business-day, string YYYY-MM-DD) ──
  private dayAfter(ymd: string) { return this.plusDays(ymd, 1); }
  private plusDays(ymd: string, days: number) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
  private plusOneYear(ymd: string) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCFullYear(d.getUTCFullYear() + 1); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); }
  private daysBetween(from: string, to: string) { return Math.round((new Date(to + 'T00:00:00Z').getTime() - new Date(from + 'T00:00:00Z').getTime()) / 86400000); }

  private fmt(r: any) {
    return {
      id: Number(r.id), renewal_no: r.renewalNo, contract_id: Number(r.contractId),
      proposed_start: r.proposedStart, proposed_end: r.proposedEnd,
      base_value: n(r.baseValue), uplift_pct: n(r.upliftPct), new_value: n(r.newValue),
      auto_renew: r.autoRenew, status: r.status, reason: r.reason ?? null,
      requested_by: r.requestedBy ?? null, approved_by: r.approvedBy ?? null,
    };
  }
}
