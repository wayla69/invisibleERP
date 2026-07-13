import { Inject, Injectable, Module, Controller, Get, Post, Delete, Param, Query, Body, NotFoundException, BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { crmOpportunities, crmTerritories, crmTerritoryMembers, crmQuotas } from '../../../database/schema/crm-pipeline';
import { ymd, n } from '../../../database/queries';
import { Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';

// ── CRM-11 — persisted TERRITORY & QUOTA management (CRM-10, migration 0385) ────────────────────────────
// A governance layer over the REV-17 pipeline: territories, rep assignments and per-period quotas become
// PERSISTED, auditable master data (the live forecast's quota_attainment reads an ad-hoc in-memory number).
// A territory carries match criteria (regions/segments/categories) + a self-referential parent for a team
// ROLL-UP hierarchy + a manager; reps are assigned as members; a quota targets an owner or a territory per
// period. Attainment (won-in-period ÷ quota) is measured per rep and rolled up the territory tree.
// The control (CRM-10): sales attainment is measured against an auditable, governed quota — not a number
// passed at request time — and rep performance ties to the territory hierarchy. No GL post.

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

const CriteriaSchema = z.object({
  regions: z.array(z.string().max(60)).max(200).optional(),
  segments: z.array(z.string().max(60)).max(200).optional(),
  categories: z.array(z.string().max(60)).max(200).optional(),
}).partial();
const TerritoryBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  criteria: CriteriaSchema.optional(),
  parent_code: z.string().max(60).optional(),
  manager: z.string().max(60).optional(),
});
const MemberBody = z.object({ owner: z.string().min(1).max(60), role: z.enum(['rep', 'manager']).optional() });
const QuotaBody = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  scope: z.enum(['owner', 'territory']),
  subject: z.string().min(1).max(60),   // owner username OR territory code
  target_amount: z.number().nonnegative(),
});

@Injectable()
export class CrmTerritoryService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private currentPeriod(): string { return ymd().slice(0, 7); }
  private tCond(col: any, user: JwtUser) { return user.tenantId != null ? [eq(col, user.tenantId)] : []; }

  private async resolve(user: JwtUser, code: string) {
    const [row] = await this.db.select().from(crmTerritories)
      .where(and(eq(crmTerritories.code, code), ...this.tCond(crmTerritories.tenantId, user)));
    if (!row) throw new NotFoundException({ code: 'TERRITORY_NOT_FOUND', message: 'Territory not found', messageTh: 'ไม่พบเขตการขาย' });
    return row;
  }

  async createTerritory(user: JwtUser, body: z.infer<typeof TerritoryBody>) {
    const existing = await this.db.select({ id: crmTerritories.id }).from(crmTerritories).where(and(...this.tCond(crmTerritories.tenantId, user)));
    const code = `TERR-${String(existing.length + 1).padStart(4, '0')}`;
    let parentId: number | null = null;
    if (body.parent_code) parentId = Number((await this.resolve(user, body.parent_code)).id);
    await this.db.insert(crmTerritories).values({
      tenantId: user.tenantId ?? null, code, name: body.name, description: body.description ?? null,
      criteria: (body.criteria ?? {}) as Record<string, unknown>, parentTerritoryId: parentId,
      manager: body.manager ?? null, createdBy: user.username ?? null,
    });
    return { code, name: body.name };
  }

  async listTerritories(user: JwtUser) {
    const rows = await this.db.select().from(crmTerritories).where(and(...this.tCond(crmTerritories.tenantId, user)));
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    return {
      territories: rows.map((r) => ({
        code: r.code, name: r.name, manager: r.manager, active: r.active,
        parent_code: r.parentTerritoryId != null ? byId.get(Number(r.parentTerritoryId))?.code ?? null : null,
        criteria: r.criteria,
      })),
    };
  }

  async getTerritory(user: JwtUser, code: string) {
    const t = await this.resolve(user, code);
    const members = await this.db.select().from(crmTerritoryMembers)
      .where(and(eq(crmTerritoryMembers.territoryId, Number(t.id)), ...this.tCond(crmTerritoryMembers.tenantId, user)));
    const all = await this.db.select({ id: crmTerritories.id, code: crmTerritories.code, parent: crmTerritories.parentTerritoryId })
      .from(crmTerritories).where(and(...this.tCond(crmTerritories.tenantId, user)));
    const children = all.filter((c) => Number(c.parent) === Number(t.id)).map((c) => c.code);
    return {
      code: t.code, name: t.name, description: t.description, criteria: t.criteria, manager: t.manager, active: t.active,
      members: members.map((m) => ({ owner: m.owner, role: m.role })),
      children,
    };
  }

  async addMember(user: JwtUser, code: string, body: z.infer<typeof MemberBody>) {
    const t = await this.resolve(user, code);
    await this.db.insert(crmTerritoryMembers).values({
      tenantId: user.tenantId ?? null, territoryId: Number(t.id), owner: body.owner, role: body.role ?? 'rep',
    }).onConflictDoUpdate({
      target: [crmTerritoryMembers.tenantId, crmTerritoryMembers.territoryId, crmTerritoryMembers.owner],
      set: { role: body.role ?? 'rep' },
    });
    return { code: t.code, owner: body.owner, role: body.role ?? 'rep' };
  }

  async removeMember(user: JwtUser, code: string, owner: string) {
    const t = await this.resolve(user, code);
    await this.db.delete(crmTerritoryMembers)
      .where(and(eq(crmTerritoryMembers.territoryId, Number(t.id)), eq(crmTerritoryMembers.owner, owner), ...this.tCond(crmTerritoryMembers.tenantId, user)));
    return { removed: true };
  }

  async setQuota(user: JwtUser, body: z.infer<typeof QuotaBody>) {
    const period = body.period ?? this.currentPeriod();
    if (body.scope === 'territory') await this.resolve(user, body.subject); // validate territory exists
    await this.db.insert(crmQuotas).values({
      tenantId: user.tenantId ?? null, period, scope: body.scope, subject: body.subject,
      targetAmount: String(round2(body.target_amount)), createdBy: user.username ?? null,
    }).onConflictDoUpdate({
      target: [crmQuotas.tenantId, crmQuotas.period, crmQuotas.scope, crmQuotas.subject],
      set: { targetAmount: String(round2(body.target_amount)) },
    });
    return { period, scope: body.scope, subject: body.subject, target_amount: round2(body.target_amount) };
  }

  async listQuotas(user: JwtUser, dto?: { period?: string }) {
    const period = dto?.period ?? this.currentPeriod();
    const rows = await this.db.select().from(crmQuotas)
      .where(and(eq(crmQuotas.period, period), ...this.tCond(crmQuotas.tenantId, user)));
    return { period, quotas: rows.map((q) => ({ scope: q.scope, subject: q.subject, target_amount: n(q.targetAmount) })) };
  }

  // Attainment roll-up: won-in-period per owner vs owner quota, then rolled up the territory tree vs
  // territory quota (a territory's attainment = Σ its members' won across the whole subtree).
  async attainment(user: JwtUser, dto?: { period?: string }) {
    const period = dto?.period ?? this.currentPeriod();

    // won-in-period per owner
    const wonRows = await this.db.select({ owner: crmOpportunities.owner, amount: crmOpportunities.amount, closedAt: crmOpportunities.closedAt })
      .from(crmOpportunities).where(and(eq(crmOpportunities.status, 'Won'), ...this.tCond(crmOpportunities.tenantId, user)));
    const wonByOwner = new Map<string, number>();
    for (const w of wonRows) {
      if (!w.closedAt || ymd(new Date(w.closedAt)).slice(0, 7) !== period) continue;
      const o = w.owner || 'unassigned';
      wonByOwner.set(o, round2((wonByOwner.get(o) ?? 0) + n(w.amount)));
    }

    const quotas = await this.db.select().from(crmQuotas)
      .where(and(eq(crmQuotas.period, period), ...this.tCond(crmQuotas.tenantId, user)));
    const ownerQuota = new Map<string, number>(), terrQuota = new Map<string, number>();
    for (const q of quotas) (q.scope === 'owner' ? ownerQuota : terrQuota).set(q.subject, n(q.targetAmount));

    const owners = [...new Set([...wonByOwner.keys(), ...ownerQuota.keys()])].map((owner) => {
      const won = wonByOwner.get(owner) ?? 0, quota = ownerQuota.get(owner) ?? 0;
      return { owner, won_amount: won, quota, attainment_pct: quota > 0 ? round2((won / quota) * 100) : null };
    }).sort((a, b) => b.won_amount - a.won_amount);

    // territory subtree roll-up
    const terrs = await this.db.select().from(crmTerritories).where(and(...this.tCond(crmTerritories.tenantId, user)));
    const members = await this.db.select().from(crmTerritoryMembers).where(and(...this.tCond(crmTerritoryMembers.tenantId, user)));
    const membersByTerr = new Map<number, string[]>();
    for (const m of members) { const k = Number(m.territoryId); membersByTerr.set(k, [...(membersByTerr.get(k) ?? []), m.owner]); }
    const childrenOf = new Map<number, number[]>();
    for (const t of terrs) if (t.parentTerritoryId != null) { const p = Number(t.parentTerritoryId); childrenOf.set(p, [...(childrenOf.get(p) ?? []), Number(t.id)]); }
    const ownWon = (id: number) => (membersByTerr.get(id) ?? []).reduce((s, o) => s + (wonByOwner.get(o) ?? 0), 0);
    const subtreeWon = (id: number): number => round2(ownWon(id) + (childrenOf.get(id) ?? []).reduce((s, c) => s + subtreeWon(c), 0));

    const territories = terrs.map((t) => {
      const won = subtreeWon(Number(t.id)), quota = terrQuota.get(t.code) ?? 0;
      return { code: t.code, name: t.name, manager: t.manager, member_count: (membersByTerr.get(Number(t.id)) ?? []).length, subtree_won: won, quota, attainment_pct: quota > 0 ? round2((won / quota) * 100) : null };
    }).sort((a, b) => b.subtree_won - a.subtree_won);

    return { period, owners, territories };
  }
}

@Controller('api/crm/territory')
@Permissions('crm', 'exec', 'ar')
export class CrmTerritoryController {
  constructor(private readonly svc: CrmTerritoryService) {}

  @Get('territories') list(@CurrentUser() u: JwtUser) { return this.svc.listTerritories(u); }
  @Get('territories/:code') get(@Param('code') code: string, @CurrentUser() u: JwtUser) { return this.svc.getTerritory(u, code); }
  @Get('quotas') quotas(@Query('period') period: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listQuotas(u, { period }); }
  @Get('attainment') attainment(@Query('period') period: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.attainment(u, { period }); }
  @Post('territories') @Permissions('crm', 'exec') create(@Body(new ZodValidationPipe(TerritoryBody)) b: z.infer<typeof TerritoryBody>, @CurrentUser() u: JwtUser) { return this.svc.createTerritory(u, b); }
  @Post('territories/:code/members') @Permissions('crm', 'exec') addMember(@Param('code') code: string, @Body(new ZodValidationPipe(MemberBody)) b: z.infer<typeof MemberBody>, @CurrentUser() u: JwtUser) { return this.svc.addMember(u, code, b); }
  @Delete('territories/:code/members/:owner') @Permissions('crm', 'exec') removeMember(@Param('code') code: string, @Param('owner') owner: string, @CurrentUser() u: JwtUser) { return this.svc.removeMember(u, code, owner); }
  @Post('quotas') @Permissions('crm', 'exec') setQuota(@Body(new ZodValidationPipe(QuotaBody)) b: z.infer<typeof QuotaBody>, @CurrentUser() u: JwtUser) { return this.svc.setQuota(u, b); }
}

@Module({
  controllers: [CrmTerritoryController],
  providers: [CrmTerritoryService],
  exports: [CrmTerritoryService],
})
export class CrmTerritoryModule {}
