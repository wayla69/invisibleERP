import { Inject, Injectable } from '@nestjs/common';
import { eq, and, desc, like } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { auditLog, reasonCodes } from '../../../database/schema';
import type { JwtUser } from '../../../common/decorators';

export interface AuditEntry { action: string; entity?: string; entityId?: string; status?: string; meta?: Record<string, any> }

// Central, append-only POS audit. Controlled actions (void/discount/price-override/no-sale/return/refund)
// write a row here with actor + reason_code + approver + before/after, so there's one tamper-evident
// trail across modules. Also owns reason-code masters.
@Injectable()
export class PosAuditService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Best-effort: auditing must never block the business action it records.
  async record(e: AuditEntry, user: JwtUser): Promise<void> {
    try {
      const db = this.db as any;
      await db.insert(auditLog).values({
        actor: user?.username ?? null, tenantId: user?.tenantId ?? null,
        action: e.action.startsWith('POS.') ? e.action : `POS.${e.action}`,
        entity: e.entity ?? null, entityId: e.entityId ?? null, status: e.status ?? 'success', meta: e.meta ?? null,
      });
    } catch { /* never throw from audit */ }
  }

  async listPosAudit(limit = 100, action?: string) {
    const db = this.db as any;
    const where = action ? and(like(auditLog.action, 'POS.%'), eq(auditLog.action, action.startsWith('POS.') ? action : `POS.${action}`)) : like(auditLog.action, 'POS.%');
    const rows = await db.select().from(auditLog).where(where).orderBy(desc(auditLog.id)).limit(limit);
    return {
      entries: rows.map((r: any) => ({ id: r.id, ts: r.ts, actor: r.actor, action: r.action, entity: r.entity, entity_id: r.entityId, status: r.status, meta: r.meta })),
      count: rows.length,
    };
  }

  // ── Reason-code masters ─────────────────────────────────────────────────────
  async listReasonCodes(appliesTo?: string) {
    const db = this.db as any;
    const rows = await db.select().from(reasonCodes).where(eq(reasonCodes.active, true)).orderBy(reasonCodes.code);
    const filtered = appliesTo ? rows.filter((r: any) => r.appliesTo === 'all' || r.appliesTo === appliesTo) : rows;
    return { reason_codes: filtered.map((r: any) => ({ id: r.id, code: r.code, label: r.label, applies_to: r.appliesTo })), count: filtered.length };
  }
  async upsertReasonCode(dto: { id?: number; code: string; label: string; applies_to?: string; active?: boolean }, user: JwtUser) {
    const db = this.db as any;
    const vals = { tenantId: user.tenantId ?? null, code: dto.code, label: dto.label, appliesTo: dto.applies_to ?? 'all', active: dto.active ?? true };
    if (dto.id) { await db.update(reasonCodes).set(vals).where(eq(reasonCodes.id, dto.id)); return { id: dto.id, updated: true }; }
    const [r] = await db.insert(reasonCodes).values(vals).returning({ id: reasonCodes.id });
    return { id: r.id, created: true };
  }
  async deleteReasonCode(id: number) {
    const db = this.db as any;
    await db.update(reasonCodes).set({ active: false }).where(eq(reasonCodes.id, id));
    return { id, deleted: true };
  }
}
