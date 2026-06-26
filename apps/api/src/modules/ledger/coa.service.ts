import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { eq, and, isNull, or, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { accounts, accountGroups, journalLines } from '../../database/schema';
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
      type: dto.type as any,
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
}
