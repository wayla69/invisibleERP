import { Inject, Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { z } from 'zod';
import { eq, and, ne, inArray, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { crmAccounts, crmContacts, crmOpportunities, crmAccountPlans, crmOpportunityContacts, itemCategories } from '../../../database/schema';
import { DocNumberService } from '../../../common/doc-number.service';
import { type JwtUser } from '../../../common/decorators';
import { isUniqueViolation } from '../../../common/db-error';

// docs/46 Phase 5 — split VERBATIM out of the single-file crm-account-depth.module.ts (service/controller/
// module convention; no DI or behaviour change). The zod request bodies are exported for the controller.
// ── CRM-7 — B2B Account/Contact 360 DEPTH (CRM-07, migration 0365) ──────────────────────────────────
// Three net-new capabilities layered on the REV-17 CRM spine (no change to lead→convert→opportunity):
//   1. Account HIERARCHY — crm_accounts.parent_account_id; set-parent rejects cycles (HIERARCHY_CYCLE);
//      the hierarchy read rolls the open weighted pipeline up the subtree.
//   2. Buying COMMITTEE — crm_opportunity_contacts: which contacts sit on a deal (role + influence), at
//      most one is_primary per deal; a committee contact must belong to the deal's account.
//   3. Account PLANS — crm_account_plans: a governed draft → active → closed plan (owner + objective +
//      target revenue + target product categories validated against item_categories); the whitespace read
//      surfaces the product categories the account is NOT yet being pursued for.
// The control (CRM-07): B2B relationships are governed — hierarchies stay acyclic, each deal's buying
// committee is documented, and account plans carry an owner + target through a governed lifecycle.

const MAX_DEPTH = 50;

export const ParentBody = z.object({ parent_account_no: z.string().min(1).nullish() });

const COMMITTEE_ROLES = ['decision_maker', 'champion', 'influencer', 'evaluator', 'blocker', 'user'] as const;
const INFLUENCE = ['high', 'medium', 'low'] as const;
export const CommitteeBody = z.object({
  contact_id: z.number().int(), role: z.enum(COMMITTEE_ROLES).default('user'),
  influence: z.enum(INFLUENCE).default('medium'), is_primary: z.boolean().optional(), notes: z.string().optional(),
});

export const PlanBody = z.object({
  account_no: z.string().min(1), period: z.string().optional(), objective: z.string().optional(),
  strategy: z.string().optional(), target_revenue: z.number().nonnegative().optional(),
  target_categories: z.array(z.string()).optional(), owner: z.string().optional(),
});
export const PlanUpdateBody = z.object({
  period: z.string().nullish(), objective: z.string().nullish(), strategy: z.string().nullish(),
  target_revenue: z.number().nonnegative().optional(), target_categories: z.array(z.string()).optional(), owner: z.string().nullish(),
});
@Injectable()
export class CrmAccountDepthService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly docNo: DocNumberService) {}

  private async accountByNo(accountNo: string, user: JwtUser) {
    const conds = [eq(crmAccounts.accountNo, accountNo)];
    if (user.tenantId != null) conds.push(eq(crmAccounts.tenantId, user.tenantId));
    const [a] = await this.db.select().from(crmAccounts).where(and(...conds)).limit(1);
    if (!a) throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND', message: 'Account not found', messageTh: 'ไม่พบบัญชีลูกค้า' });
    return a;
  }

  private async oppByNo(oppNo: string, user: JwtUser) {
    const conds = [eq(crmOpportunities.oppNo, oppNo)];
    if (user.tenantId != null) conds.push(eq(crmOpportunities.tenantId, user.tenantId));
    const [o] = await this.db.select().from(crmOpportunities).where(and(...conds)).limit(1);
    if (!o) throw new NotFoundException({ code: 'OPPORTUNITY_NOT_FOUND', message: 'Opportunity not found', messageTh: 'ไม่พบโอกาสการขาย' });
    return o;
  }

  private async accountById(id: number) {
    const [a] = await this.db.select().from(crmAccounts).where(eq(crmAccounts.id, id)).limit(1);
    return a ?? null;
  }

  // ── Hierarchy ─────────────────────────────────────────────────────────
  async setParent(accountNo: string, parentAccountNo: string | null | undefined, user: JwtUser) {
    const account = await this.accountByNo(accountNo, user);
    if (parentAccountNo == null) {
      await this.db.update(crmAccounts).set({ parentAccountId: null }).where(eq(crmAccounts.id, Number(account.id)));
      return { account_no: accountNo, parent_account_no: null };
    }
    const parent = await this.accountByNo(parentAccountNo, user);
    if (Number(parent.id) === Number(account.id)) {
      throw new BadRequestException({ code: 'SELF_PARENT', message: 'An account cannot be its own parent', messageTh: 'บัญชีไม่สามารถเป็นบริษัทแม่ของตัวเองได้' });
    }
    // Cycle guard: walk UP from the proposed parent; if we ever reach the account being re-parented, the
    // link would close a loop.
    let cursor: number | null = Number(parent.parentAccountId ?? 0) || null;
    for (let i = 0; i < MAX_DEPTH && cursor; i++) {
      if (cursor === Number(account.id)) {
        throw new BadRequestException({ code: 'HIERARCHY_CYCLE', message: 'That parent would create a hierarchy cycle', messageTh: 'การกำหนดบริษัทแม่นี้จะทำให้เกิดวงจรลำดับชั้น' });
      }
      const anc = await this.accountById(cursor);
      cursor = anc && anc.parentAccountId != null ? Number(anc.parentAccountId) : null;
    }
    await this.db.update(crmAccounts).set({ parentAccountId: Number(parent.id) }).where(eq(crmAccounts.id, Number(account.id)));
    return { account_no: accountNo, parent_account_no: parentAccountNo };
  }

  async hierarchy(accountNo: string, user: JwtUser) {
    const db = this.db;
    const account = await this.accountByNo(accountNo, user);
    // Ancestors (root-ward chain).
    const ancestors: any[] = [];
    let cursor: number | null = account.parentAccountId != null ? Number(account.parentAccountId) : null;
    for (let i = 0; i < MAX_DEPTH && cursor; i++) {
      const anc = await this.accountById(cursor);
      if (!anc) break;
      ancestors.push({ account_no: anc.accountNo, name: anc.name });
      cursor = anc.parentAccountId != null ? Number(anc.parentAccountId) : null;
    }
    // Direct children.
    const childRows = await db.select().from(crmAccounts).where(and(eq(crmAccounts.parentAccountId, Number(account.id)), ne(crmAccounts.status, 'merged'))).orderBy(desc(crmAccounts.id));
    // Subtree (this account + all descendants) for the pipeline rollup.
    const subtree: number[] = [Number(account.id)];
    let frontier: number[] = [Number(account.id)];
    for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
      const kids = await db.select({ id: crmAccounts.id }).from(crmAccounts).where(and(inArray(crmAccounts.parentAccountId, frontier), ne(crmAccounts.status, 'merged')));
      frontier = kids.map((k: any) => Number(k.id)).filter((id: number) => !subtree.includes(id));
      subtree.push(...frontier);
    }
    const [roll] = await db.select({
      weighted: sql<string>`coalesce(sum(${crmOpportunities.amount} * ${crmOpportunities.probability} / 100.0), 0)`,
      open_count: sql<string>`count(*)`,
    }).from(crmOpportunities).where(and(inArray(crmOpportunities.accountId, subtree), eq(crmOpportunities.status, 'Open')));
    return {
      account_no: account.accountNo, name: account.name,
      parent_account_no: ancestors[0]?.account_no ?? null,
      ancestors,
      children: childRows.map((c: any) => ({ account_no: c.accountNo, name: c.name, status: c.status })),
      subtree_account_count: subtree.length,
      subtree_open_weighted: Number(roll?.weighted ?? 0),
      subtree_open_count: Number(roll?.open_count ?? 0),
    };
  }

  // ── Buying committee ──────────────────────────────────────────────────
  async addCommitteeMember(oppNo: string, dto: z.infer<typeof CommitteeBody>, user: JwtUser) {
    const db = this.db;
    const opp = await this.oppByNo(oppNo, user);
    const conds = [eq(crmContacts.id, dto.contact_id)];
    if (user.tenantId != null) conds.push(eq(crmContacts.tenantId, user.tenantId));
    const [contact] = await db.select().from(crmContacts).where(and(...conds)).limit(1);
    if (!contact) throw new NotFoundException({ code: 'CONTACT_NOT_FOUND', message: 'Contact not found', messageTh: 'ไม่พบผู้ติดต่อนี้' });
    if (opp.accountId != null && contact.accountId != null && Number(contact.accountId) !== Number(opp.accountId)) {
      throw new BadRequestException({ code: 'CONTACT_ACCOUNT_MISMATCH', message: "The contact does not belong to the deal's account", messageTh: 'ผู้ติดต่อไม่ได้สังกัดบัญชีลูกค้าของดีลนี้' });
    }
    try {
      if (dto.is_primary) {
        await db.update(crmOpportunityContacts).set({ isPrimary: false }).where(eq(crmOpportunityContacts.opportunityId, Number(opp.id)));
      }
      const [row] = await db.insert(crmOpportunityContacts).values({
        tenantId: user.tenantId ?? null, opportunityId: Number(opp.id), contactId: dto.contact_id,
        role: dto.role, influence: dto.influence, isPrimary: dto.is_primary === true, notes: dto.notes ?? null, createdBy: user.username,
      }).returning();
      return shapeCommittee(row, contact);
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException({ code: 'COMMITTEE_DUP', message: 'That contact is already on this deal', messageTh: 'ผู้ติดต่อนี้อยู่ในคณะผู้ตัดสินใจของดีลนี้แล้ว' });
      throw e;
    }
  }

  async listCommittee(oppNo: string, user: JwtUser) {
    const db = this.db;
    const opp = await this.oppByNo(oppNo, user);
    const rows = await db.select({ m: crmOpportunityContacts, c: crmContacts })
      .from(crmOpportunityContacts)
      .leftJoin(crmContacts, eq(crmOpportunityContacts.contactId, crmContacts.id))
      .where(eq(crmOpportunityContacts.opportunityId, Number(opp.id)))
      .orderBy(desc(crmOpportunityContacts.isPrimary), desc(crmOpportunityContacts.id));
    return { opp_no: oppNo, committee: rows.map((r: any) => shapeCommittee(r.m, r.c)), count: rows.length };
  }

  async removeCommitteeMember(oppNo: string, contactId: number, user: JwtUser) {
    const db = this.db;
    const opp = await this.oppByNo(oppNo, user);
    const res = await db.delete(crmOpportunityContacts).where(and(eq(crmOpportunityContacts.opportunityId, Number(opp.id)), eq(crmOpportunityContacts.contactId, contactId))).returning();
    if (!res.length) throw new NotFoundException({ code: 'COMMITTEE_MEMBER_NOT_FOUND', message: 'That contact is not on this deal', messageTh: 'ไม่พบผู้ติดต่อในคณะผู้ตัดสินใจของดีลนี้' });
    return { opp_no: oppNo, contact_id: contactId, removed: true };
  }

  // ── Account plans ─────────────────────────────────────────────────────
  private async validateCategories(codes: string[] | undefined, user: JwtUser): Promise<string[]> {
    if (!codes || !codes.length) return [];
    const uniq = Array.from(new Set(codes.map((c) => c.trim()).filter(Boolean)));
    if (!uniq.length) return [];
    const conds = [inArray(itemCategories.code, uniq), eq(itemCategories.active, true)];
    if (user.tenantId != null) conds.push(eq(itemCategories.tenantId, user.tenantId));
    const found = await this.db.select({ code: itemCategories.code }).from(itemCategories).where(and(...conds));
    const foundSet = new Set(found.map((f: any) => f.code));
    const unknown = uniq.filter((c) => !foundSet.has(c));
    if (unknown.length) throw new BadRequestException({ code: 'UNKNOWN_CATEGORY', message: `Unknown item category: ${unknown.join(', ')}`, messageTh: `ไม่พบหมวดสินค้า: ${unknown.join(', ')}`, details: { unknown } });
    return uniq;
  }

  private async planByNo(planNo: string, user: JwtUser) {
    const conds = [eq(crmAccountPlans.planNo, planNo)];
    if (user.tenantId != null) conds.push(eq(crmAccountPlans.tenantId, user.tenantId));
    const [p] = await this.db.select().from(crmAccountPlans).where(and(...conds)).limit(1);
    if (!p) throw new NotFoundException({ code: 'PLAN_NOT_FOUND', message: 'Account plan not found', messageTh: 'ไม่พบแผนบัญชีลูกค้า' });
    return p;
  }

  async createPlan(dto: z.infer<typeof PlanBody>, user: JwtUser) {
    const account = await this.accountByNo(dto.account_no, user);
    const cats = await this.validateCategories(dto.target_categories, user);
    const planNo = await this.docNo.nextDaily('APL');
    const [row] = await this.db.insert(crmAccountPlans).values({
      tenantId: user.tenantId ?? null, planNo, accountId: Number(account.id), period: dto.period ?? null,
      objective: dto.objective ?? null, strategy: dto.strategy ?? null,
      targetRevenue: String(dto.target_revenue ?? 0), targetCategories: cats, status: 'draft',
      owner: dto.owner ?? user.username, createdBy: user.username,
    }).returning();
    return shapePlan(row, account.accountNo);
  }

  async listPlans(q: { account_no?: string }, user: JwtUser) {
    const db = this.db;
    const conds: any[] = [];
    if (user.tenantId != null) conds.push(eq(crmAccountPlans.tenantId, user.tenantId));
    let accountNo: string | undefined;
    if (q.account_no) { const a = await this.accountByNo(q.account_no, user); conds.push(eq(crmAccountPlans.accountId, Number(a.id))); accountNo = a.accountNo; }
    const rows = await db.select().from(crmAccountPlans).where(conds.length ? and(...conds) : undefined).orderBy(desc(crmAccountPlans.id)).limit(200);
    return { plans: rows.map((p: any) => shapePlan(p, accountNo)), count: rows.length };
  }

  async getPlan(planNo: string, user: JwtUser) {
    const p = await this.planByNo(planNo, user);
    const acc = await this.accountById(Number(p.accountId));
    return shapePlan(p, acc?.accountNo);
  }

  async updatePlan(planNo: string, dto: z.infer<typeof PlanUpdateBody>, user: JwtUser) {
    const p = await this.planByNo(planNo, user);
    if (p.status === 'closed') throw new BadRequestException({ code: 'PLAN_CLOSED', message: 'A closed plan cannot be edited', messageTh: 'แผนที่ปิดแล้วไม่สามารถแก้ไขได้' });
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.period !== undefined) set.period = dto.period || null;
    if (dto.objective !== undefined) set.objective = dto.objective || null;
    if (dto.strategy !== undefined) set.strategy = dto.strategy || null;
    if (dto.target_revenue !== undefined) set.targetRevenue = String(dto.target_revenue);
    if (dto.owner !== undefined) set.owner = dto.owner || null;
    if (dto.target_categories !== undefined) set.targetCategories = await this.validateCategories(dto.target_categories, user);
    await this.db.update(crmAccountPlans).set(set).where(eq(crmAccountPlans.id, Number(p.id)));
    return this.getPlan(planNo, user);
  }

  async activatePlan(planNo: string, user: JwtUser) {
    const p = await this.planByNo(planNo, user);
    if (p.status !== 'draft') throw new BadRequestException({ code: 'PLAN_NOT_DRAFT', message: `Plan ${planNo} is not a draft (status=${p.status})`, messageTh: `แผน ${planNo} ไม่ใช่ฉบับร่าง` });
    if (!p.owner || !p.objective) throw new BadRequestException({ code: 'PLAN_INCOMPLETE', message: 'A plan needs an owner and an objective before it can be activated', messageTh: 'แผนต้องมีเจ้าของและวัตถุประสงค์ก่อนเปิดใช้งาน' });
    await this.db.update(crmAccountPlans).set({ status: 'active', updatedAt: new Date() }).where(eq(crmAccountPlans.id, Number(p.id)));
    return this.getPlan(planNo, user);
  }

  async closePlan(planNo: string, user: JwtUser) {
    const p = await this.planByNo(planNo, user);
    if (p.status !== 'active') throw new BadRequestException({ code: 'PLAN_NOT_ACTIVE', message: `Plan ${planNo} is not active (status=${p.status})`, messageTh: `แผน ${planNo} ยังไม่เปิดใช้งาน` });
    await this.db.update(crmAccountPlans).set({ status: 'closed', updatedAt: new Date() }).where(eq(crmAccountPlans.id, Number(p.id)));
    return this.getPlan(planNo, user);
  }

  // ── Whitespace ────────────────────────────────────────────────────────
  // The product categories the account is NOT yet being pursued for: the tenant's active item_categories
  // diffed against the union of target_categories on the account's ACTIVE plans.
  async whitespace(accountNo: string, user: JwtUser) {
    const db = this.db;
    const account = await this.accountByNo(accountNo, user);
    const catConds: any[] = [eq(itemCategories.active, true)];
    if (user.tenantId != null) catConds.push(eq(itemCategories.tenantId, user.tenantId));
    const cats = await db.select({ code: itemCategories.code, name: itemCategories.name, nameTh: itemCategories.nameTh }).from(itemCategories).where(and(...catConds)).orderBy(itemCategories.code);
    const planConds = [eq(crmAccountPlans.accountId, Number(account.id)), eq(crmAccountPlans.status, 'active')];
    if (user.tenantId != null) planConds.push(eq(crmAccountPlans.tenantId, user.tenantId));
    const plans = await db.select({ targetCategories: crmAccountPlans.targetCategories, planNo: crmAccountPlans.planNo }).from(crmAccountPlans).where(and(...planConds));
    const targeted = new Map<string, string>(); // code → first covering plan_no
    for (const pl of plans) {
      for (const code of ((pl.targetCategories as string[]) ?? [])) if (!targeted.has(code)) targeted.set(code, pl.planNo);
    }
    const categories = cats.map((c: any) => ({ code: c.code, name: c.name ?? c.code, name_th: c.nameTh ?? null, targeted: targeted.has(c.code), plan_no: targeted.get(c.code) ?? null }));
    return {
      account_no: account.accountNo, name: account.name,
      categories,
      targeted_count: categories.filter((c) => c.targeted).length,
      whitespace_count: categories.filter((c) => !c.targeted).length,
    };
  }
}

function shapeCommittee(m: any, c: any) {
  return {
    contact_id: Number(m.contactId), contact_name: c?.name ?? null, contact_role: c?.role ?? null,
    role: m.role, influence: m.influence, is_primary: m.isPrimary === true, notes: m.notes ?? null,
    created_by: m.createdBy, created_at: m.createdAt,
  };
}
function shapePlan(p: any, accountNo?: string) {
  return {
    plan_no: p.planNo, account_no: accountNo ?? null, period: p.period ?? null, objective: p.objective ?? null,
    strategy: p.strategy ?? null, target_revenue: Number(p.targetRevenue ?? 0),
    target_categories: (p.targetCategories as string[]) ?? [], status: p.status, owner: p.owner ?? null,
    created_by: p.createdBy, created_at: p.createdAt, updated_at: p.updatedAt,
  };
}
