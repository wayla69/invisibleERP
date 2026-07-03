import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { eq, and, isNull, or, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { accounts, accountGroups, journalLines, tenantAccounts } from '../../database/schema';
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
    }).returning();
    return row;
  }

  async updateAccount(code: string, dto: {
    name?: string; nameTh?: string; accountGroupId?: number;
    isPostable?: boolean; requireDimension?: Record<string, boolean>;
    effectiveFrom?: string; effectiveTo?: string; active?: string;
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
