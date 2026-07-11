import { Injectable, BadRequestException, ForbiddenException, NotFoundException, Inject } from '@nestjs/common';
import { eq, and, isNull, or } from 'drizzle-orm';
// (governance below uses only eq/and/or/isNull — the resolver keeps its original read shape)
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { postingRules, postingEventTypes, postingRuleAudit, accounts } from '../../database/schema';
import { LedgerService, type PostEntryDto } from './ledger.service';
import { currentTenantStore } from '../../common/tenant-context';
import { POSTING_EVENTS, postingRole } from './posting-events';
import { bustPostingOverridesCache } from './posting-overrides-cache';

export interface PostingContext {
  tenantId?: number | null;
  date?: string;
  source: string;
  sourceRef?: string;
  createdBy: string;
  ledgerCode?: string | null;
  branchId?: number;
  projectId?: number;
  departmentId?: number;
  /** Amounts keyed by semantic role (e.g. { net: 1000, vat: 70, gross: 1070 }) */
  amounts: Record<string, number>;
  meta?: Record<string, unknown>;
  outerTx?: any;
  pendingApproval?: boolean;
  viaSubledger?: boolean;
}

export interface PreviewLine {
  role: string;
  side: 'DR' | 'CR';
  accountCode: string;
  amount: number;
}

@Injectable()
export class PostingService {
  constructor(
    @Inject(DRIZZLE) private db: DrizzleDb,
    private ledger: LedgerService,
  ) {}

  private tenantId(ctx: PostingContext): number | null {
    return ctx.tenantId ?? currentTenantStore()?.tenantId ?? null;
  }

  // A rule's optional `condition` jsonb (e.g. {"category":"exempt"}) selects it only when EVERY key equals the
  // matching value in the event's condition context (ctx.meta). A null/empty condition is unconditional. This
  // is what lets an item's category/tax profile pick a different account for the same event.
  private matchesCondition(condition: unknown, conditionCtx: Record<string, unknown>): boolean {
    if (condition == null || typeof condition !== 'object') return true;
    const entries = Object.entries(condition as Record<string, unknown>);
    if (!entries.length) return true;
    return entries.every(([k, v]) => conditionCtx[k] === v);
  }

  /** Resolve posting rules for an event, falling back global → tenant-specific, filtered by `condition`. */
  private async resolveRules(eventType: string, tenantId: number | null, conditionCtx: Record<string, unknown> = {}) {
    const rows = await this.db
      .select()
      .from(postingRules)
      .where(
        and(
          eq(postingRules.eventType, eventType),
          eq(postingRules.active, true),
          eq(postingRules.status, 'Approved'), // GL-24: an unapproved rule never reaches a posting/preview
          or(
            isNull(postingRules.tenantId),
            tenantId ? eq(postingRules.tenantId, tenantId) : isNull(postingRules.tenantId),
          ),
        ),
      )
      .orderBy(postingRules.tenantId, postingRules.legOrder);

    // Only rules whose condition matches the event context apply (unconditional rules always match).
    const applicable = rows.filter(r => this.matchesCondition(r.condition, conditionCtx));
    if (!applicable.length) {
      throw new BadRequestException({
        code: 'NO_POSTING_RULE',
        message: `No posting rules found for event '${eventType}'`,
        messageTh: `ไม่พบกฎการบันทึกบัญชีสำหรับเหตุการณ์ '${eventType}'`,
      });
    }
    // Prefer tenant-specific rules over global (tenant rules shadow global ones for same leg_order)
    const tenantRules = applicable.filter(r => r.tenantId != null);
    return tenantRules.length ? tenantRules : applicable;
  }

  /** Preview: return the journal lines PostingService would produce (dry-run). */
  async preview(eventType: string, ctx: PostingContext): Promise<PreviewLine[]> {
    const tenantId = this.tenantId(ctx);
    const rules = await this.resolveRules(eventType, tenantId, ctx.meta ?? {});
    return rules.map(r => ({
      role: r.role,
      side: r.side as 'DR' | 'CR',
      accountCode: r.accountCode,
      amount: ctx.amounts[r.role] ?? 0,
    }));
  }

  /** Post an event to the GL via the posting-rules engine. */
  async post(eventType: string, ctx: PostingContext): Promise<Record<string, unknown>> {
    const tenantId = this.tenantId(ctx);
    const rules = await this.resolveRules(eventType, tenantId, ctx.meta ?? {});

    const lines = rules.map(r => {
      const amount = ctx.amounts[r.role] ?? 0;
      return {
        account_code: r.accountCode,
        debit: r.side === 'DR' ? amount : 0,
        credit: r.side === 'CR' ? amount : 0,
        memo: r.role,
        cost_center: undefined as string | undefined,
        branch_id: ctx.branchId ?? null,
        project_id: ctx.projectId ?? null,
        dept_id: ctx.departmentId ?? null,
      };
    }).filter(l => l.debit > 0 || l.credit > 0);

    const dto: PostEntryDto = {
      date: ctx.date,
      source: ctx.source,
      sourceRef: ctx.sourceRef,
      tenantId,
      currency: (ctx.meta?.currency as string) ?? 'THB',
      memo: (ctx.meta?.memo as string) ?? eventType,
      lines,
      createdBy: ctx.createdBy,
      ledgerCode: ctx.ledgerCode,
      pendingApproval: ctx.pendingApproval,
      viaSubledger: ctx.viaSubledger,
    };

    return this.ledger.postEntry(dto, ctx.outerTx);
  }

  /** List all event types */
  async listEventTypes() {
    return this.db.select().from(postingEventTypes).orderBy(postingEventTypes.key);
  }

  /** List posting rules (global + tenant) */
  async listRules(opts?: { eventType?: string }) {
    const tenantId = currentTenantStore()?.tenantId ?? null;
    const conditions: any[] = [
      or(
        isNull(postingRules.tenantId),
        tenantId ? eq(postingRules.tenantId, tenantId) : isNull(postingRules.tenantId),
      ),
      eq(postingRules.active, true),
    ];
    if (opts?.eventType) conditions.push(eq(postingRules.eventType, opts.eventType));
    return this.db
      .select()
      .from(postingRules)
      .where(and(...conditions))
      .orderBy(postingRules.eventType, postingRules.legOrder);
  }

  // ───────────────────── GL-24 — posting-rule change governance (docs/43 PR-1) ─────────────────────
  // A posting-rule override re-routes where financial statements land, so a change is GOVERNED config:
  // validated fail-closed at save (registry role/side, tier policy, real postable account), lands
  // PendingApproval, and only a DIFFERENT user's approval activates it (SoD — binds even Admin).
  // Every action writes an append-only posting_rule_audit row. The resolver + cache consume only
  // active + Approved rows, so an unapproved rule can never touch a posting.

  private async audit(tenantId: number | null, ruleId: number | null, action: string, actor: string | null, detail: Record<string, unknown>) {
    await this.db.insert(postingRuleAudit).values({ tenantId, ruleId, action, actor, detail });
  }

  /** GL-24 validation: event/role from the registry, side must match, tier must be 'free', account must
   *  be a real POSTABLE canonical account. Fail-closed — reject at save, not at month-end. */
  private async validateRule(dto: { eventType: string; role: string; side: 'DR' | 'CR'; accountCode: string }) {
    const ev = POSTING_EVENTS[dto.eventType];
    if (!ev) {
      throw new BadRequestException({
        code: 'UNKNOWN_POSTING_EVENT',
        message: `Unknown posting event '${dto.eventType}'`,
        messageTh: `ไม่รู้จักเหตุการณ์ '${dto.eventType}'`,
      });
    }
    const role = postingRole(dto.eventType, dto.role);
    if (!role) {
      throw new BadRequestException({
        code: 'UNKNOWN_POSTING_ROLE',
        message: `Event '${dto.eventType}' has no role '${dto.role}' (valid: ${Object.keys(ev.roles).join(', ')})`,
        messageTh: `เหตุการณ์ '${dto.eventType}' ไม่มีบทบาท '${dto.role}'`,
      });
    }
    if (role.side !== dto.side) {
      throw new BadRequestException({
        code: 'POSTING_SIDE_MISMATCH',
        message: `Role '${dto.role}' posts ${role.side}, not ${dto.side}`,
        messageTh: `บทบาท '${dto.role}' ลงด้าน ${role.side} ไม่ใช่ ${dto.side}`,
      });
    }
    if (role.tier !== 'free') {
      throw new BadRequestException({
        code: 'OVERRIDE_ROLE_PINNED',
        message: `Role '${dto.eventType}.${dto.role}' is ${role.tier === 'pinned' ? 'pinned (a sub-ledger control / structural account)' : 'reconciliation-gated (Tier B — not yet widened)'} and cannot be re-mapped`,
        messageTh: `บทบาท '${dto.eventType}.${dto.role}' เป็นบัญชีคุม/ผูกกับการกระทบยอด ไม่สามารถเปลี่ยนได้`,
      });
    }
    const [acc] = await this.db.select({ code: accounts.code, isPostable: accounts.isPostable })
      .from(accounts).where(eq(accounts.code, dto.accountCode)).limit(1);
    if (!acc || acc.isPostable === false) {
      throw new BadRequestException({
        code: 'INVALID_POSTING_ACCOUNT',
        message: `Account '${dto.accountCode}' ${!acc ? 'does not exist in the chart of accounts' : 'is not postable'}`,
        messageTh: `บัญชี '${dto.accountCode}' ${!acc ? 'ไม่มีอยู่ในผังบัญชี' : 'ไม่สามารถบันทึกรายการได้'}`,
      });
    }
  }

  /** Upsert a tenant-specific posting rule → lands PendingApproval (GL-24 maker-checker). */
  async upsertRule(dto: {
    eventType: string; legOrder: number; role: string;
    side: 'DR' | 'CR'; accountCode: string; dimensionSource?: string; condition?: Record<string, unknown>;
  }, user?: { username: string }) {
    const tenantId = currentTenantStore()?.tenantId ?? null;
    if (!tenantId) {
      throw new BadRequestException({
        code: 'TENANT_REQUIRED',
        message: 'Tenant context required to upsert rule',
        messageTh: 'ต้องมี tenant context ในการบันทึกกฎ',
      });
    }
    await this.validateRule(dto);
    // Manual upsert: the uq_posting_rules index is the COALESCE(tenant_id,0) EXPRESSION form, which a
    // plain-column ON CONFLICT target cannot address. Rule edits are rare, human-paced writes — a
    // select-then-write is fine (the unique index still backstops a true race).
    const [existing] = await this.db.select({ id: postingRules.id }).from(postingRules)
      .where(and(eq(postingRules.tenantId, tenantId), eq(postingRules.eventType, dto.eventType), eq(postingRules.legOrder, dto.legOrder)))
      .limit(1);
    const values = {
      role: dto.role,
      side: dto.side,
      accountCode: dto.accountCode,
      dimensionSource: dto.dimensionSource,
      condition: dto.condition,
      active: true,
      status: 'PendingApproval',
      createdBy: user?.username ?? null,
      approvedBy: null,
      approvedAt: null,
    };
    const [row] = existing
      ? await this.db.update(postingRules).set(values).where(eq(postingRules.id, existing.id)).returning()
      : await this.db.insert(postingRules).values({ tenantId, eventType: dto.eventType, legOrder: dto.legOrder, ...values }).returning();
    // A re-edited rule falls back to PendingApproval, so a previously-approved mapping can't be
    // silently repointed; the cache is busted so the old approved value stops serving immediately.
    bustPostingOverridesCache(tenantId);
    await this.audit(tenantId, Number(row!.id), 'CREATE', user?.username ?? null, {
      event_type: dto.eventType, role: dto.role, side: dto.side, account_code: dto.accountCode, leg_order: dto.legOrder,
    });
    return row;
  }

  /** GL-24 approve: a DIFFERENT user activates the pending rule (SoD binds even Admin). */
  async approveRule(id: number, user: { username: string }) {
    const tenantId = currentTenantStore()?.tenantId ?? null;
    const [row] = await this.db.select().from(postingRules).where(eq(postingRules.id, id)).limit(1);
    if (!row) throw new NotFoundException({ code: 'RULE_NOT_FOUND', message: `Posting rule ${id} not found`, messageTh: `ไม่พบกฎ ${id}` });
    if (row.status !== 'PendingApproval') {
      throw new BadRequestException({ code: 'NOT_PENDING', message: `Rule ${id} is ${row.status}, not pending approval`, messageTh: 'กฎนี้ไม่ได้รออนุมัติ' });
    }
    if (row.createdBy && row.createdBy === user.username) {
      throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve a posting rule you created', messageTh: 'ผู้สร้างอนุมัติกฎของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    const [upd] = await this.db.update(postingRules)
      .set({ status: 'Approved', approvedBy: user.username, approvedAt: new Date() })
      .where(eq(postingRules.id, id)).returning();
    bustPostingOverridesCache(row.tenantId ?? tenantId);
    await this.audit(row.tenantId ?? tenantId, id, 'APPROVE', user.username, { created_by: row.createdBy, event_type: row.eventType, role: row.role, account_code: row.accountCode });
    return upd;
  }

  /** GL-24 reject: close a pending rule without effect. */
  async rejectRule(id: number, user: { username: string }, reason?: string) {
    const [row] = await this.db.select().from(postingRules).where(eq(postingRules.id, id)).limit(1);
    if (!row) throw new NotFoundException({ code: 'RULE_NOT_FOUND', message: `Posting rule ${id} not found`, messageTh: `ไม่พบกฎ ${id}` });
    if (row.status !== 'PendingApproval') {
      throw new BadRequestException({ code: 'NOT_PENDING', message: `Rule ${id} is ${row.status}, not pending approval`, messageTh: 'กฎนี้ไม่ได้รออนุมัติ' });
    }
    const [upd] = await this.db.update(postingRules)
      .set({ status: 'Rejected', active: false })
      .where(eq(postingRules.id, id)).returning();
    await this.audit(row.tenantId ?? null, id, 'REJECT', user.username, { reason: reason ?? null, event_type: row.eventType, role: row.role });
    return upd;
  }

  /** GL-24 deactivate: retire an approved rule (postings fall back to the registry default). */
  async deactivateRule(id: number, user: { username: string }) {
    const [row] = await this.db.select().from(postingRules).where(eq(postingRules.id, id)).limit(1);
    if (!row) throw new NotFoundException({ code: 'RULE_NOT_FOUND', message: `Posting rule ${id} not found`, messageTh: `ไม่พบกฎ ${id}` });
    const [upd] = await this.db.update(postingRules).set({ active: false }).where(eq(postingRules.id, id)).returning();
    bustPostingOverridesCache(row.tenantId ?? null);
    await this.audit(row.tenantId ?? null, id, 'DEACTIVATE', user.username, { event_type: row.eventType, role: row.role, account_code: row.accountCode });
    return upd;
  }

  /** GL-24 audit trail (tenant-scoped by RLS). */
  async listRuleAudit(limit = 100) {
    const rows = await this.db.select().from(postingRuleAudit).orderBy(postingRuleAudit.id).limit(limit);
    return { audit: rows, count: rows.length };
  }
}
