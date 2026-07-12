import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { eq, and, isNull, or, sql, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import {
  accounts, accountGroups, journalLines, tenantAccounts, users,
  postingRules, itemCategories, taxCodes, items, locations, assetCategories,
  bankAccounts, recurringJournals, prepaidSchedules, revRecSchedules,
  coaChangeRequests,
} from '../../database/schema';
import { currentTenantStore } from '../../common/tenant-context';

@Injectable()
export class CoaService {
  constructor(@Inject(DRIZZLE) private db: DrizzleDb) {}

  private tenantId() { return currentTenantStore()?.tenantId ?? null; }

  async listTree(opts?: { all?: boolean }) {
    const rows = await this.db.select().from(accounts).orderBy(accounts.code);
    const tenantId = this.tenantId();
    const groups = await this.db.select().from(accountGroups)
      .where(or(isNull(accountGroups.tenantId), eq(accountGroups.tenantId, tenantId ?? 0)))
      .orderBy(accountGroups.sortOrder);
    return { accounts: rows, groups };
  }

  async createAccount(dto: {
    code: string; name: string; nameTh?: string; type: string;
    parentCode?: string; accountGroupId?: number; normalBalance?: string;
    isPostable?: boolean; requireDimension?: Record<string, boolean>;
    effectiveFrom?: string; effectiveTo?: string;
    cfBucket?: string; cfLabel?: string; isCurrent?: boolean;
  }) {
    const existing = await this.db.select({ id: accounts.id }).from(accounts)
      .where(eq(accounts.code, dto.code)).limit(1);
    if (existing.length) throw new BadRequestException({ code: 'DUPLICATE_ACCOUNT', message: `Account ${dto.code} already exists`, messageTh: `บัญชี ${dto.code} มีอยู่แล้ว` });
    const [row] = await this.db.insert(accounts).values({
      code: dto.code,
      name: dto.name,
      nameTh: dto.nameTh,
      type: dto.type as typeof accounts.$inferInsert.type,
      parentCode: dto.parentCode,
      accountGroupId: dto.accountGroupId,
      normalBalance: dto.normalBalance ?? ((['Liability','Equity','Revenue'].includes(dto.type)) ? 'C' : 'D'),
      isPostable: dto.isPostable ?? true,
      requireDimension: dto.requireDimension,
      effectiveFrom: dto.effectiveFrom,
      effectiveTo: dto.effectiveTo,
      cfBucket: dto.cfBucket,
      cfLabel: dto.cfLabel,
      isCurrent: dto.isCurrent,
    }).returning();
    return row;
  }

  async updateAccount(code: string, dto: {
    name?: string; nameTh?: string; accountGroupId?: number;
    isPostable?: boolean; requireDimension?: Record<string, boolean>;
    effectiveFrom?: string; effectiveTo?: string; active?: string;
    cfBucket?: string | null; cfLabel?: string | null; isCurrent?: boolean | null;
  }) {
    // Block code changes for accounts with postings
    if (dto.isPostable === false) {
      const postings = await this.db.select({ id: journalLines.id }).from(journalLines)
        .where(eq(journalLines.accountCode, code)).limit(1);
      if (postings.length) throw new BadRequestException({
        code: 'CODE_HAS_POSTINGS',
        message: `Account ${code} has posted entries; cannot change postability`,
        messageTh: `บัญชี ${code} มีรายการที่โพสต์แล้ว ไม่สามารถเปลี่ยนได้`,
      });
    }
    const [row] = await this.db.update(accounts).set({
      ...(dto.name && { name: dto.name }),
      ...(dto.nameTh !== undefined && { nameTh: dto.nameTh }),
      ...(dto.accountGroupId !== undefined && { accountGroupId: dto.accountGroupId }),
      ...(dto.isPostable !== undefined && { isPostable: dto.isPostable }),
      ...(dto.requireDimension !== undefined && { requireDimension: dto.requireDimension }),
      ...(dto.effectiveFrom !== undefined && { effectiveFrom: dto.effectiveFrom }),
      ...(dto.effectiveTo !== undefined && { effectiveTo: dto.effectiveTo }),
      ...(dto.active !== undefined && { active: dto.active }),
      ...(dto.cfBucket !== undefined && { cfBucket: dto.cfBucket }),
      ...(dto.cfLabel !== undefined && { cfLabel: dto.cfLabel }),
      ...(dto.isCurrent !== undefined && { isCurrent: dto.isCurrent }),
    }).where(eq(accounts.code, code)).returning();
    if (!row) throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND', message: `Account ${code} not found`, messageTh: `ไม่พบบัญชี ${code}` });
    return row;
  }

  async deactivateAccount(code: string) {
    // Block deactivation if account has a non-zero balance
    const [bal] = await this.db.select({
      net: sql<string>`SUM(COALESCE(${journalLines.debit},0)) - SUM(COALESCE(${journalLines.credit},0))`,
    }).from(journalLines).where(eq(journalLines.accountCode, code));
    if (bal && Math.abs(Number(bal.net ?? 0)) > 0.005) throw new BadRequestException({
      code: 'ACCOUNT_HAS_BALANCE',
      message: `Account ${code} has a non-zero balance; deactivate not allowed`,
      messageTh: `บัญชี ${code} มียอดคงเหลือ ไม่สามารถปิดได้`,
    });
    return this.updateAccount(code, { active: 'false', isPostable: false });
  }

  // ───────────────── GL-27 — canonical CoA maker-checker (COA follow-up C, 0358) ─────────────────
  // A canonical account write re-routes the SHARED chart every tenant posts against, so it is governed
  // config like a posting rule (GL-24): the change is validated fail-closed at REQUEST time, staged
  // PendingApproval, and applied only by a DIFFERENT Admin (SOD_VIOLATION binds even Admin).
  // SINGLE-ADMIN EXCEPTION (owner decision 2026-07-12): when the system has exactly ONE active Admin a
  // maker-checker would deadlock every fix, so the change applies immediately and the request row records
  // the exception (status 'AutoApplied') — the trail survives even where the second pair of eyes can't.

  private async activeAdminCount() {
    const [row] = await this.db.select({ n: sql<string>`count(*)` }).from(users)
      .where(and(eq(users.role, 'Admin'), eq(users.isActive, true)));
    return Number(row?.n ?? 0);
  }

  /** Fail-closed request-time validation (repeated at approve — state may have moved). */
  private async validateChange(action: string, code: string, dto: Record<string, unknown> | undefined) {
    const [existing] = await this.db.select().from(accounts).where(eq(accounts.code, code)).limit(1);
    if (action === 'create') {
      if (existing) throw new BadRequestException({ code: 'DUPLICATE_ACCOUNT', message: `Account ${code} already exists`, messageTh: `บัญชี ${code} มีอยู่แล้ว` });
    } else {
      if (!existing) throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND', message: `Account ${code} not found`, messageTh: `ไม่พบบัญชี ${code}` });
      if (action === 'deactivate') {
        const [bal] = await this.db.select({
          net: sql<string>`SUM(COALESCE(${journalLines.debit},0)) - SUM(COALESCE(${journalLines.credit},0))`,
        }).from(journalLines).where(eq(journalLines.accountCode, code));
        if (bal && Math.abs(Number(bal.net ?? 0)) > 0.005) throw new BadRequestException({
          code: 'ACCOUNT_HAS_BALANCE',
          message: `Account ${code} has a non-zero balance; deactivate not allowed`,
          messageTh: `บัญชี ${code} มียอดคงเหลือ ไม่สามารถปิดได้`,
        });
      }
      if (action === 'update' && dto?.isPostable === false) {
        const postings = await this.db.select({ id: journalLines.id }).from(journalLines)
          .where(eq(journalLines.accountCode, code)).limit(1);
        if (postings.length) throw new BadRequestException({
          code: 'CODE_HAS_POSTINGS',
          message: `Account ${code} has posted entries; cannot change postability`,
          messageTh: `บัญชี ${code} มีรายการที่โพสต์แล้ว ไม่สามารถเปลี่ยนได้`,
        });
      }
    }
    return existing ?? null;
  }

  private async applyChange(action: string, code: string, payload: Record<string, unknown> | undefined) {
    if (action === 'create') return this.createAccount(payload as Parameters<CoaService['createAccount']>[0]);
    if (action === 'update') return this.updateAccount(code, (payload ?? {}) as Parameters<CoaService['updateAccount']>[1]);
    return this.deactivateAccount(code);
  }

  /** Stage a canonical CoA change (or apply immediately under the single-Admin exception). */
  async requestChange(action: 'create' | 'update' | 'deactivate', code: string, dto: Record<string, unknown> | undefined, user: { username: string }) {
    const before = await this.validateChange(action, code, dto);
    const [pending] = await this.db.select({ id: coaChangeRequests.id }).from(coaChangeRequests)
      .where(and(eq(coaChangeRequests.accountCode, code), eq(coaChangeRequests.status, 'PendingApproval'))).limit(1);
    if (pending) throw new BadRequestException({
      code: 'CHANGE_ALREADY_PENDING',
      message: `A change for account ${code} is already pending approval (request ${pending.id})`,
      messageTh: `มีคำขอแก้ไขบัญชี ${code} รออนุมัติอยู่แล้ว (คำขอ ${pending.id})`,
    });
    const base = {
      action, accountCode: code, payload: dto ?? null,
      before: before ? { name: before.name, type: before.type, isPostable: before.isPostable, active: before.active, cfBucket: before.cfBucket, isCurrent: before.isCurrent } : null,
      createdBy: user.username, createdTenantId: this.tenantId(),
    };
    if ((await this.activeAdminCount()) <= 1) {
      const result = await this.applyChange(action, code, dto);
      const [req] = await this.db.insert(coaChangeRequests).values({
        ...base, status: 'AutoApplied', approvedBy: user.username, approvedAt: new Date(),
        reason: 'single-admin exception: only one active Admin exists — applied immediately, recorded for audit',
      }).returning();
      return { ...(result as Record<string, unknown>), change_request: { id: req!.id, status: 'AutoApplied' } };
    }
    const [req] = await this.db.insert(coaChangeRequests).values(base).returning();
    return { status: 'PendingApproval', id: req!.id, action, account_code: code };
  }

  /** A DIFFERENT Admin activates the pending change (SoD binds even Admin). */
  async approveChange(id: number, user: { username: string }) {
    const [row] = await this.db.select().from(coaChangeRequests).where(eq(coaChangeRequests.id, id)).limit(1);
    if (!row) throw new NotFoundException({ code: 'REQUEST_NOT_FOUND', message: `CoA change request ${id} not found`, messageTh: `ไม่พบคำขอ ${id}` });
    if (row.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Request ${id} is ${row.status}, not pending approval`, messageTh: 'คำขอนี้ไม่ได้รออนุมัติ' });
    if (row.createdBy === user.username) throw new ForbiddenException({
      code: 'SOD_VIOLATION',
      message: 'A canonical CoA change must be approved by a DIFFERENT user than its creator',
      messageTh: 'ผู้อนุมัติต้องไม่ใช่ผู้สร้างคำขอ (แบ่งแยกหน้าที่)',
    });
    await this.validateChange(row.action, row.accountCode, (row.payload ?? undefined) as Record<string, unknown> | undefined);
    const result = await this.applyChange(row.action, row.accountCode, (row.payload ?? undefined) as Record<string, unknown> | undefined);
    const [upd] = await this.db.update(coaChangeRequests)
      .set({ status: 'Approved', approvedBy: user.username, approvedAt: new Date() })
      .where(eq(coaChangeRequests.id, id)).returning();
    return { ...(result as Record<string, unknown>), change_request: { id: upd!.id, status: upd!.status, approved_by: upd!.approvedBy } };
  }

  async rejectChange(id: number, user: { username: string }, reason?: string) {
    const [row] = await this.db.select().from(coaChangeRequests).where(eq(coaChangeRequests.id, id)).limit(1);
    if (!row) throw new NotFoundException({ code: 'REQUEST_NOT_FOUND', message: `CoA change request ${id} not found`, messageTh: `ไม่พบคำขอ ${id}` });
    if (row.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Request ${id} is ${row.status}, not pending approval`, messageTh: 'คำขอนี้ไม่ได้รออนุมัติ' });
    const [upd] = await this.db.update(coaChangeRequests)
      .set({ status: 'Rejected', approvedBy: user.username, approvedAt: new Date(), reason: reason ?? null })
      .where(eq(coaChangeRequests.id, id)).returning();
    return upd;
  }

  async listChanges(status?: string) {
    const rows = await this.db.select().from(coaChangeRequests)
      .where(status ? eq(coaChangeRequests.status, status) : undefined)
      .orderBy(desc(coaChangeRequests.id)).limit(200);
    return { requests: rows, count: rows.length };
  }

  // COA follow-up B — where-used: every CONFIG master that references this account code. Deactivation
  // stays balance-gated only (warn, don't block) — but a retired code left in any of these would surface
  // later as a fail-closed INVALID_POSTING_ACCOUNT at posting time, so the dialog shows this list up
  // front. Tenant-scoped tables are already narrowed by RLS; counts are per the caller's visibility.
  async whereUsed(code: string) {
    const [exists] = await this.db.select({ code: accounts.code }).from(accounts).where(eq(accounts.code, code)).limit(1);
    if (!exists) throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND', message: `Account ${code} not found`, messageTh: `ไม่พบบัญชี ${code}` });
    const n = async (q: Promise<{ n: unknown }[]>) => Number((await q)[0]?.n ?? 0);
    const cnt = { n: sql<string>`count(*)` };
    const [rules, cats, taxes, itemRows, locs, assetCats, banks, recurring, prepaids, revrec] = await Promise.all([
      n(this.db.select(cnt).from(postingRules).where(and(eq(postingRules.accountCode, code), eq(postingRules.active, true)))),
      n(this.db.select(cnt).from(itemCategories).where(or(
        eq(itemCategories.revenueAccount, code), eq(itemCategories.cogsAccount, code),
        eq(itemCategories.inventoryAccount, code), eq(itemCategories.valuationAccount, code)))),
      n(this.db.select(cnt).from(taxCodes).where(and(eq(taxCodes.active, true), or(
        eq(taxCodes.outputAccount, code), eq(taxCodes.inputAccount, code), eq(taxCodes.whtAccount, code))))),
      n(this.db.select(cnt).from(items).where(or(
        eq(items.revenueAccount, code), eq(items.cogsAccount, code),
        eq(items.inventoryAccount, code), eq(items.valuationAccount, code)))),
      n(this.db.select(cnt).from(locations).where(or(
        eq(locations.inventoryAccount, code), eq(locations.adjustmentAccount, code)))),
      n(this.db.select(cnt).from(assetCategories).where(or(
        eq(assetCategories.assetAccount, code), eq(assetCategories.accumDepAccount, code),
        eq(assetCategories.depExpenseAccount, code)))),
      n(this.db.select(cnt).from(bankAccounts).where(eq(bankAccounts.glAccountCode, code))),
      n(this.db.select(cnt).from(recurringJournals).where(and(
        eq(recurringJournals.active, 'true'),
        sql`exists (select 1 from jsonb_array_elements(${recurringJournals.lines}) e where e->>'account_code' = ${code})`))),
      n(this.db.select(cnt).from(prepaidSchedules).where(and(
        sql`coalesce(${prepaidSchedules.periodsPosted},0) < ${prepaidSchedules.months}`,
        or(eq(prepaidSchedules.expenseAccount, code), eq(prepaidSchedules.prepaidAccount, code))))),
      n(this.db.select(cnt).from(revRecSchedules).where(or(
        eq(revRecSchedules.deferredAccount, code), eq(revRecSchedules.revenueAccount, code)))),
    ]);
    const references = [
      { source: 'posting_rules', count: rules },
      { source: 'item_categories', count: cats },
      { source: 'tax_codes', count: taxes },
      { source: 'items', count: itemRows },
      { source: 'locations', count: locs },
      { source: 'asset_categories', count: assetCats },
      { source: 'bank_accounts', count: banks },
      { source: 'recurring_journals', count: recurring },
      { source: 'prepaid_schedules', count: prepaids },
      { source: 'rev_rec_schedules', count: revrec },
    ].filter((r) => r.count > 0);
    return { account_code: code, references, total: references.reduce((a, r) => a + r.count, 0) };
  }

  // GL-11 — per-tenant chart curation. Upserts the caller tenant's `tenant_accounts` overlay row for a
  // canonical account: toggle whether it is active on this tenant's chart, override its display name(s),
  // group label, and sort order. RLS-scoped (tenant_id is sourced from the request context, never the
  // caller) so a tenant can only ever shape its OWN chart — it can neither read nor mutate another
  // tenant's overlay. The overlay may only reference an EXISTING canonical code (it does not mint new
  // accounts — that is the Admin/HQ canonical duty) and NEVER gates postings (see LedgerService.listAccounts).
  async curateOverlay(code: string, dto: {
    active?: boolean; displayName?: string | null; displayNameTh?: string | null;
    groupLabel?: string | null; sortOrder?: number;
  }) {
    const tenantId = this.tenantId();
    if (tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'A tenant context is required to curate the chart of accounts', messageTh: 'ต้องมีบริบทกิจการเพื่อปรับแต่งผังบัญชี' });
    const [canon] = await this.db.select({ code: accounts.code }).from(accounts).where(eq(accounts.code, code)).limit(1);
    if (!canon) throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND', message: `Account ${code} not found in the canonical chart`, messageTh: `ไม่พบบัญชี ${code} ในผังบัญชีกลาง` });
    const set: Record<string, unknown> = {};
    if (dto.active !== undefined) set.active = dto.active;
    if (dto.displayName !== undefined) set.displayName = dto.displayName;
    if (dto.displayNameTh !== undefined) set.displayNameTh = dto.displayNameTh;
    if (dto.groupLabel !== undefined) set.groupLabel = dto.groupLabel;
    if (dto.sortOrder !== undefined) set.sortOrder = dto.sortOrder;
    const [row] = await this.db.insert(tenantAccounts)
      .values({ tenantId, accountCode: code, ...set })
      .onConflictDoUpdate({ target: [tenantAccounts.tenantId, tenantAccounts.accountCode], set })
      .returning();
    return row;
  }
}
