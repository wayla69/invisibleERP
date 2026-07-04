import { Injectable, BadRequestException, Inject } from '@nestjs/common';
import { eq, and, isNull, or } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { postingRules, postingEventTypes } from '../../database/schema';
import { LedgerService, type PostEntryDto } from './ledger.service';
import { currentTenantStore } from '../../common/tenant-context';

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

  /** Upsert a tenant-specific posting rule (override global default). */
  async upsertRule(dto: {
    eventType: string; legOrder: number; role: string;
    side: 'DR' | 'CR'; accountCode: string; dimensionSource?: string; condition?: Record<string, unknown>;
  }) {
    const tenantId = currentTenantStore()?.tenantId ?? null;
    if (!tenantId) {
      throw new BadRequestException({
        code: 'TENANT_REQUIRED',
        message: 'Tenant context required to upsert rule',
        messageTh: 'ต้องมี tenant context ในการบันทึกกฎ',
      });
    }
    const [row] = await this.db.insert(postingRules).values({
      tenantId,
      eventType: dto.eventType,
      legOrder: dto.legOrder,
      role: dto.role,
      side: dto.side,
      accountCode: dto.accountCode,
      dimensionSource: dto.dimensionSource,
      condition: dto.condition,
    }).onConflictDoUpdate({
      target: [postingRules.tenantId, postingRules.eventType, postingRules.legOrder],
      set: {
        role: dto.role,
        side: dto.side,
        accountCode: dto.accountCode,
        dimensionSource: dto.dimensionSource,
        condition: dto.condition,
        active: true,
      },
    }).returning();
    return row;
  }
}
