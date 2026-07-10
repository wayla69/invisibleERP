import { Inject, Injectable, Module, Controller, Get, Post, Patch, Param, Query, Body, NotFoundException, BadRequestException, ConflictException, ForbiddenException, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { eq, and, ne, or, ilike, desc, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { crmAccounts, crmContacts, crmOpportunities, crmActivities, users } from '../../../database/schema';
import { DocNumberService } from '../../../common/doc-number.service';
import { Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { isUniqueViolation } from '../../../common/db-error';
import { normalizeName, normalizeKey } from '../../../common/text-similarity';

// ── CRM accounts & contacts (CRM-1 unification, migration 0293) ────────────────────────────────────
// The CRM-side party model: crm_accounts (company — becomes the customer-of-record link once transacting,
// customer_no → customer_master) and crm_contacts (people under an account, role-tagged, optional
// pos_members loyalty join). Duplicate-governed: create runs normalized email/phone/tax-id/company-name
// matching and refuses a suspect (409 DUPLICATE_SUSPECT with the match list) unless force:true; a steward
// merges a confirmed duplicate into a survivor (children repointed, blanks survivorship-filled, duplicate
// soft-retired status='merged' + merged_into/by/at — mirrors the customer-master merge, REV-15/PN-17).
// Maker-checker: a merge that REASSIGNS children (contacts/opportunities) must be performed by a user other
// than the duplicate's creator (SOD_VIOLATION otherwise) — one person cannot mint a shadow account and fold
// its pipeline into another record single-handedly.

const AccountBody = z.object({
  name: z.string().min(1), tax_id: z.string().optional(), industry: z.string().optional(), size: z.string().optional(),
  email: z.string().optional(), phone: z.string().optional(), website: z.string().optional(),
  owner: z.string().optional(), customer_no: z.string().optional(), notes: z.string().optional(),
  force: z.boolean().optional(),
});
const AccountUpdateBody = z.object({
  name: z.string().min(1).optional(), tax_id: z.string().nullish(), industry: z.string().nullish(), size: z.string().nullish(),
  email: z.string().nullish(), phone: z.string().nullish(), website: z.string().nullish(),
  owner: z.string().nullish(), customer_no: z.string().nullish(), status: z.enum(['active', 'inactive']).optional(), notes: z.string().nullish(),
});
const MergeBody = z.object({ duplicate_account_no: z.string().min(1) });
const CONTACT_ROLES = ['decision_maker', 'billing', 'technical', 'other'] as const;
const ContactBody = z.object({
  account_no: z.string().min(1), name: z.string().min(1), email: z.string().optional(), phone: z.string().optional(),
  role: z.enum(CONTACT_ROLES).default('other'), line_id: z.string().optional(), member_id: z.number().int().optional(),
  notes: z.string().optional(), force: z.boolean().optional(),
});
const ContactUpdateBody = z.object({
  name: z.string().min(1).optional(), email: z.string().nullish(), phone: z.string().nullish(),
  role: z.enum(CONTACT_ROLES).optional(), line_id: z.string().nullish(), member_id: z.number().int().nullish(),
  status: z.enum(['active', 'inactive']).optional(), notes: z.string().nullish(),
});

@Injectable()
export class CrmAccountsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly docNo: DocNumberService) {}

  private async userIdByUsername(username: string | null | undefined): Promise<number | null> {
    if (!username) return null;
    const [u] = await this.db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    return u ? Number(u.id) : null;
  }

  // Duplicate suspects for a prospective account: exact normalized tax-id / email / phone signals plus the
  // normalized company name (legal suffixes stripped — 'บริษัท เอ จำกัด' ≡ 'A Co., Ltd.').
  private async accountDuplicates(dto: { name: string; tax_id?: string; email?: string; phone?: string }, user: JwtUser) {
    const db = this.db;
    const conds = [ne(crmAccounts.status, 'merged')];
    if (user.tenantId != null) conds.push(eq(crmAccounts.tenantId, user.tenantId));
    const rows = await db.select().from(crmAccounts).where(and(...conds)).orderBy(desc(crmAccounts.id)).limit(1000);
    const nameKey = normalizeName(dto.name);
    const matches: any[] = [];
    for (const a of rows) {
      const reasons: string[] = [];
      if (dto.tax_id && a.taxId && normalizeKey(dto.tax_id) === normalizeKey(a.taxId)) reasons.push('tax_id');
      if (dto.email && a.email && normalizeKey(dto.email) === normalizeKey(a.email)) reasons.push('email');
      if (dto.phone && a.phone && normalizeKey(dto.phone) === normalizeKey(a.phone)) reasons.push('phone');
      if (nameKey && normalizeName(a.name) === nameKey) reasons.push('name');
      if (reasons.length) matches.push({ ...shapeAccount(a), reasons });
    }
    return matches;
  }

  async create(dto: z.infer<typeof AccountBody>, user: JwtUser) {
    const db = this.db;
    if (!dto.force) {
      const matches = await this.accountDuplicates(dto, user);
      if (matches.length) {
        throw new ConflictException({
          code: 'DUPLICATE_SUSPECT', message: 'A probable duplicate account exists — review the matches or resubmit with force:true',
          messageTh: 'พบบัญชีลูกค้าที่อาจซ้ำ กรุณาตรวจสอบหรือยืนยันบันทึกซ้ำ', details: { matches },
        });
      }
    }
    const accountNo = await this.docNo.nextDaily('ACC');
    const owner = dto.owner ?? user.username;
    const [row] = await db.insert(crmAccounts).values({
      tenantId: user.tenantId ?? null, accountNo, name: dto.name, taxId: dto.tax_id ?? null,
      industry: dto.industry ?? null, size: dto.size ?? null, email: dto.email ?? null, phone: dto.phone ?? null,
      website: dto.website ?? null, ownerUserId: await this.userIdByUsername(owner), customerNo: dto.customer_no ?? null,
      status: 'active', notes: dto.notes ?? null, createdBy: user.username,
    }).returning();
    return shapeAccount(row);
  }

  async list(q: { search?: string }, _user: JwtUser) {
    const db = this.db;
    const conds: any[] = [ne(crmAccounts.status, 'merged')];
    if (q.search) conds.push(or(ilike(crmAccounts.name, `%${q.search}%`), ilike(crmAccounts.accountNo, `%${q.search}%`), ilike(crmAccounts.email, `%${q.search}%`), ilike(crmAccounts.phone, `%${q.search}%`)));
    const rows = await db.select().from(crmAccounts).where(and(...conds)).orderBy(desc(crmAccounts.id)).limit(200);
    return { accounts: rows.map(shapeAccount), count: rows.length };
  }

  private async byNo(accountNo: string, user: JwtUser) {
    const db = this.db;
    const conds = [eq(crmAccounts.accountNo, accountNo)];
    if (user.tenantId != null) conds.push(eq(crmAccounts.tenantId, user.tenantId));
    const [a] = await db.select().from(crmAccounts).where(and(...conds)).limit(1);
    if (!a) throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND', message: 'Account not found', messageTh: 'ไม่พบบัญชีลูกค้า' });
    return a;
  }

  async get(accountNo: string, user: JwtUser) {
    const db = this.db;
    const a = await this.byNo(accountNo, user);
    const contacts = await db.select().from(crmContacts).where(and(eq(crmContacts.accountId, Number(a.id)), ne(crmContacts.status, 'merged'))).orderBy(desc(crmContacts.id));
    // CRM-2 account page (additive): the account's deals + the recent activities across those deals.
    const oppRows = await db.select().from(crmOpportunities).where(eq(crmOpportunities.accountId, Number(a.id))).orderBy(desc(crmOpportunities.id)).limit(100);
    const oppNos = oppRows.map((o: any) => o.oppNo);
    const actRows = oppNos.length
      ? await db.select().from(crmActivities).where(and(eq(crmActivities.entityType, 'opportunity'), inArray(crmActivities.entityNo, oppNos))).orderBy(desc(crmActivities.id)).limit(50)
      : [];
    return {
      ...shapeAccount(a), contacts: contacts.map(shapeContact), opportunity_count: oppRows.length,
      opportunities: oppRows.map((o: any) => ({ opp_no: o.oppNo, name: o.name, stage: o.stage, status: o.status, amount: Number(o.amount ?? 0), probability: Number(o.probability ?? 0), owner: o.owner, expected_close_date: o.expectedCloseDate, created_at: o.createdAt, closed_at: o.closedAt })),
      recent_activities: actRows.map((x: any) => ({ id: Number(x.id), entity_no: x.entityNo, type: x.type, subject: x.subject, notes: x.notes, due_date: x.dueDate, done: x.done === true, owner: x.owner, created_at: x.createdAt })),
    };
  }

  async update(accountNo: string, dto: z.infer<typeof AccountUpdateBody>, user: JwtUser) {
    const db = this.db;
    const a = await this.byNo(accountNo, user);
    const set: Record<string, unknown> = {};
    if (dto.name !== undefined) set.name = dto.name;
    if (dto.tax_id !== undefined) set.taxId = dto.tax_id || null;
    if (dto.industry !== undefined) set.industry = dto.industry || null;
    if (dto.size !== undefined) set.size = dto.size || null;
    if (dto.email !== undefined) set.email = dto.email || null;
    if (dto.phone !== undefined) set.phone = dto.phone || null;
    if (dto.website !== undefined) set.website = dto.website || null;
    if (dto.owner !== undefined) set.ownerUserId = await this.userIdByUsername(dto.owner);
    if (dto.customer_no !== undefined) set.customerNo = dto.customer_no || null;
    if (dto.status !== undefined) set.status = dto.status;
    if (dto.notes !== undefined) set.notes = dto.notes || null;
    if (!Object.keys(set).length) throw new BadRequestException({ code: 'NO_FIELDS', message: 'No fields to update', messageTh: 'ไม่มีข้อมูลให้แก้ไข' });
    await db.update(crmAccounts).set(set).where(eq(crmAccounts.id, Number(a.id)));
    return this.get(accountNo, user);
  }

  // Merge a duplicate account INTO a survivor (survivor pattern — mirrors the customer-master merge):
  // repoint the duplicate's contacts + opportunities to the survivor, fill blank survivor fields from the
  // duplicate (survivorship), soft-retire the duplicate. Maker-checker when children reassign: the caller
  // must differ from the duplicate's creator (SOD_VIOLATION). Atomic — a unique-key collision rolls back
  // and surfaces MERGE_CONFLICT for manual steward resolution.
  async merge(survivorNo: string, duplicateNo: string, user: JwtUser) {
    if (survivorNo === duplicateNo) throw new BadRequestException({ code: 'SELF_MERGE', message: 'Cannot merge an account into itself', messageTh: 'ไม่สามารถรวมบัญชีเข้ากับตัวเองได้' });
    const survivor = await this.byNo(survivorNo, user);
    const dup = await this.byNo(duplicateNo, user);
    if (dup.status === 'merged') throw new BadRequestException({ code: 'ALREADY_MERGED', message: 'Duplicate is already merged', messageTh: 'รายการนี้ถูกรวมไปแล้ว' });
    const db = this.db;
    const [kidContacts] = await db.select({ c: sql<string>`count(*)` }).from(crmContacts).where(eq(crmContacts.accountId, Number(dup.id)));
    const [kidOpps] = await db.select({ c: sql<string>`count(*)` }).from(crmOpportunities).where(eq(crmOpportunities.accountId, Number(dup.id)));
    const childCount = Number(kidContacts?.c ?? 0) + Number(kidOpps?.c ?? 0);
    if (childCount > 0 && dup.createdBy === user.username) {
      throw new ForbiddenException({
        code: 'SOD_VIOLATION',
        message: 'Merging an account you created that has contacts/opportunities requires a different user (maker-checker)',
        messageTh: 'การรวมบัญชีที่คุณสร้างเองและมีข้อมูลลูก ต้องให้ผู้ใช้อื่นเป็นผู้ดำเนินการ',
      });
    }
    try {
      await db.transaction(async (tx: any) => {
        await tx.update(crmContacts).set({ accountId: Number(survivor.id) }).where(eq(crmContacts.accountId, Number(dup.id)));
        await tx.update(crmOpportunities).set({ accountId: Number(survivor.id) }).where(eq(crmOpportunities.accountId, Number(dup.id)));
        const fill: Record<string, unknown> = {};
        const pick = (k: string, s: unknown, d: unknown) => { if ((s === null || s === undefined || s === '') && d !== null && d !== undefined && d !== '') fill[k] = d; };
        pick('email', survivor.email, dup.email); pick('phone', survivor.phone, dup.phone); pick('taxId', survivor.taxId, dup.taxId);
        pick('industry', survivor.industry, dup.industry); pick('size', survivor.size, dup.size);
        pick('website', survivor.website, dup.website); pick('customerNo', survivor.customerNo, dup.customerNo);
        pick('ownerUserId', survivor.ownerUserId, dup.ownerUserId);
        if (Object.keys(fill).length) await tx.update(crmAccounts).set(fill).where(eq(crmAccounts.id, Number(survivor.id)));
        await tx.update(crmAccounts).set({ status: 'merged', mergedInto: Number(survivor.id), mergedBy: user.username, mergedAt: new Date() }).where(eq(crmAccounts.id, Number(dup.id)));
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException({ code: 'MERGE_CONFLICT', message: 'Survivor and duplicate both own a row with the same key — resolve manually', messageTh: 'บัญชีทั้งสองมีรายการที่ซ้ำกัน กรุณาแก้ไขก่อนรวม' });
      throw e;
    }
    return { survivor_no: survivorNo, merged_no: duplicateNo, merged: true, reassigned_children: childCount };
  }

  // ── Contacts ──────────────────────────────────────────────────────────
  private async contactDuplicates(dto: { email?: string; phone?: string }, user: JwtUser) {
    if (!dto.email && !dto.phone) return [];
    const db = this.db;
    const conds = [ne(crmContacts.status, 'merged')];
    if (user.tenantId != null) conds.push(eq(crmContacts.tenantId, user.tenantId));
    const rows = await db.select().from(crmContacts).where(and(...conds)).orderBy(desc(crmContacts.id)).limit(1000);
    const matches: any[] = [];
    for (const c of rows) {
      const reasons: string[] = [];
      if (dto.email && c.email && normalizeKey(dto.email) === normalizeKey(c.email)) reasons.push('email');
      if (dto.phone && c.phone && normalizeKey(dto.phone) === normalizeKey(c.phone)) reasons.push('phone');
      if (reasons.length) matches.push({ ...shapeContact(c), reasons });
    }
    return matches;
  }

  async createContact(dto: z.infer<typeof ContactBody>, user: JwtUser) {
    const db = this.db;
    const account = await this.byNo(dto.account_no, user);
    if (!dto.force) {
      const matches = await this.contactDuplicates(dto, user);
      if (matches.length) {
        throw new ConflictException({
          code: 'DUPLICATE_SUSPECT', message: 'A probable duplicate contact exists — review the matches or resubmit with force:true',
          messageTh: 'พบผู้ติดต่อที่อาจซ้ำ กรุณาตรวจสอบหรือยืนยันบันทึกซ้ำ', details: { matches },
        });
      }
    }
    const [row] = await db.insert(crmContacts).values({
      tenantId: user.tenantId ?? null, accountId: Number(account.id), name: dto.name, email: dto.email ?? null,
      phone: dto.phone ?? null, role: dto.role ?? 'other', lineId: dto.line_id ?? null, memberId: dto.member_id ?? null,
      status: 'active', notes: dto.notes ?? null, createdBy: user.username,
    }).returning();
    return shapeContact(row);
  }

  async listContacts(q: { account_no?: string; search?: string }, user: JwtUser) {
    const db = this.db;
    const conds: any[] = [ne(crmContacts.status, 'merged')];
    if (q.account_no) {
      const account = await this.byNo(q.account_no, user);
      conds.push(eq(crmContacts.accountId, Number(account.id)));
    }
    if (q.search) conds.push(or(ilike(crmContacts.name, `%${q.search}%`), ilike(crmContacts.email, `%${q.search}%`), ilike(crmContacts.phone, `%${q.search}%`)));
    const rows = await db.select().from(crmContacts).where(and(...conds)).orderBy(desc(crmContacts.id)).limit(300);
    return { contacts: rows.map(shapeContact), count: rows.length };
  }

  async updateContact(id: number, dto: z.infer<typeof ContactUpdateBody>, user: JwtUser) {
    const db = this.db;
    const conds = [eq(crmContacts.id, id)];
    if (user.tenantId != null) conds.push(eq(crmContacts.tenantId, user.tenantId));
    const [c] = await db.select().from(crmContacts).where(and(...conds)).limit(1);
    if (!c) throw new NotFoundException({ code: 'CONTACT_NOT_FOUND', message: 'Contact not found', messageTh: 'ไม่พบผู้ติดต่อนี้' });
    const set: Record<string, unknown> = {};
    if (dto.name !== undefined) set.name = dto.name;
    if (dto.email !== undefined) set.email = dto.email || null;
    if (dto.phone !== undefined) set.phone = dto.phone || null;
    if (dto.role !== undefined) set.role = dto.role;
    if (dto.line_id !== undefined) set.lineId = dto.line_id || null;
    if (dto.member_id !== undefined) set.memberId = dto.member_id ?? null;
    if (dto.status !== undefined) set.status = dto.status;
    if (dto.notes !== undefined) set.notes = dto.notes || null;
    if (!Object.keys(set).length) throw new BadRequestException({ code: 'NO_FIELDS', message: 'No fields to update', messageTh: 'ไม่มีข้อมูลให้แก้ไข' });
    const [row] = await db.update(crmContacts).set(set).where(eq(crmContacts.id, id)).returning();
    return shapeContact(row);
  }
}

function shapeAccount(a: any) {
  return {
    account_no: a.accountNo, name: a.name, tax_id: a.taxId ?? null, industry: a.industry ?? null, size: a.size ?? null,
    email: a.email ?? null, phone: a.phone ?? null, website: a.website ?? null,
    owner_user_id: a.ownerUserId != null ? Number(a.ownerUserId) : null, customer_no: a.customerNo ?? null,
    status: a.status, merged_into: a.mergedInto != null ? Number(a.mergedInto) : null,
    notes: a.notes ?? null, created_by: a.createdBy, created_at: a.createdAt,
  };
}
function shapeContact(c: any) {
  return {
    id: Number(c.id), account_id: c.accountId != null ? Number(c.accountId) : null, name: c.name,
    email: c.email ?? null, phone: c.phone ?? null, role: c.role, line_id: c.lineId ?? null,
    member_id: c.memberId != null ? Number(c.memberId) : null, status: c.status, notes: c.notes ?? null,
    created_by: c.createdBy, created_at: c.createdAt,
  };
}

@Controller('api/crm/accounts')
@Permissions('crm', 'exec', 'ar')
export class CrmAccountsController {
  constructor(private readonly svc: CrmAccountsService) {}

  @Post() create(@Body(new ZodValidationPipe(AccountBody)) b: z.infer<typeof AccountBody>, @CurrentUser() u: JwtUser) { return this.svc.create(b, u); }
  @Get() list(@Query('search') search: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.list({ search }, u); }
  // Consequential + audited → steward duties (mirrors POST /api/customer-master/:no/merge).
  @Post(':survivorNo/merge') @HttpCode(200) @Permissions('crm', 'exec', 'masterdata')
  merge(@Param('survivorNo') no: string, @Body(new ZodValidationPipe(MergeBody)) b: z.infer<typeof MergeBody>, @CurrentUser() u: JwtUser) { return this.svc.merge(no, b.duplicate_account_no, u); }
  @Get(':accountNo') get(@Param('accountNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.get(no, u); }
  @Patch(':accountNo') update(@Param('accountNo') no: string, @Body(new ZodValidationPipe(AccountUpdateBody)) b: z.infer<typeof AccountUpdateBody>, @CurrentUser() u: JwtUser) { return this.svc.update(no, b, u); }
}

@Controller('api/crm/contacts')
@Permissions('crm', 'exec', 'ar')
export class CrmContactsController {
  constructor(private readonly svc: CrmAccountsService) {}

  @Post() create(@Body(new ZodValidationPipe(ContactBody)) b: z.infer<typeof ContactBody>, @CurrentUser() u: JwtUser) { return this.svc.createContact(b, u); }
  @Get() list(@Query('account_no') accountNo: string | undefined, @Query('search') search: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listContacts({ account_no: accountNo, search }, u); }
  @Patch(':id') update(@Param('id') id: string, @Body(new ZodValidationPipe(ContactUpdateBody)) b: z.infer<typeof ContactUpdateBody>, @CurrentUser() u: JwtUser) { return this.svc.updateContact(+id, b, u); }
}

@Module({ controllers: [CrmAccountsController, CrmContactsController], providers: [CrmAccountsService], exports: [CrmAccountsService] })
export class CrmAccountsModule {}
