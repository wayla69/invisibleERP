import { BadRequestException } from '@nestjs/common';
import { eq, and, ne, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../../database/database.module';
import { crmOpportunities, crmStagePlaybooks } from '../../../database/schema';
import { n } from '../../../database/queries';
import type { JwtUser } from './../../../common/decorators';
import type { StageRow } from './crm-pipeline.service';

// CRM-7 kanban depth (control CRM-13, migration 0406) — per-stage PLAYBOOKS: the exit criteria a deal must
// satisfy to ENTER a stage. Two governed gates, both enforced server-side in CrmPipelineService.setStage:
//   • REQUIRED FIELDS — a whitelist-validated set of opportunity fields that must be populated before a deal
//     advances into the stage (STAGE_REQUIREMENTS_UNMET); skipped when the target is Lost (abandoning a deal
//     is never blocked by data-completeness).
//   • WIP LIMIT — a cap on how many OPEN opportunities may sit in the stage at once (WIP_LIMIT_EXCEEDED);
//     ignored for the terminal Won/Lost stages.
// A plain class constructed in the CrmPipelineService constructor BODY (docs/38 recipe) so the facade stays
// under the service-size ratchet. Tenant-scoped (RLS 0232 + explicit tenant filters).
//
// The opportunity fields a playbook may require. Each key maps to a display label + a predicate over the live
// crm_opportunities row (camelCase). "Populated" for a money field means > 0, not merely non-null (amount
// defaults to '0'). This whitelist is the ONLY thing putPlaybook accepts — an unknown key is rejected.
type OppRow = typeof crmOpportunities.$inferSelect;
const REQUIRED_FIELD_DEFS: Record<string, { label: string; filled: (o: OppRow) => boolean }> = {
  amount:               { label: 'Deal amount',      filled: (o) => n(o.amount) > 0 },
  expected_close_date:  { label: 'Expected close',   filled: (o) => o.expectedCloseDate != null && o.expectedCloseDate !== '' },
  primary_contact:      { label: 'Primary contact',  filled: (o) => o.primaryContactId != null },
  account:              { label: 'Account',          filled: (o) => o.accountId != null },
  customer:             { label: 'Customer',         filled: (o) => o.customerNo != null && o.customerNo !== '' },
  owner:                { label: 'Owner',            filled: (o) => o.owner != null && o.owner !== '' },
  notes:               { label: 'Notes',            filled: (o) => o.notes != null && o.notes !== '' },
};
export const PLAYBOOK_FIELD_KEYS = Object.keys(REQUIRED_FIELD_DEFS);

type PlaybookRow = typeof crmStagePlaybooks.$inferSelect;

export class CrmStagePlaybookService {
  constructor(private readonly db: DrizzleDb) {}

  private tenantCond(user: JwtUser) {
    return user.tenantId != null ? eq(crmStagePlaybooks.tenantId, user.tenantId) : undefined;
  }

  private normalizeFields(input: unknown): string[] {
    if (input == null) return [];
    if (!Array.isArray(input)) throw new BadRequestException({ code: 'BAD_REQUIRED_FIELDS', message: 'required_fields must be a list', messageTh: 'required_fields ต้องเป็นรายการ' });
    const keys = [...new Set(input.map((x) => String(x)))];
    const bad = keys.filter((k) => !REQUIRED_FIELD_DEFS[k]);
    if (bad.length) throw new BadRequestException({ code: 'BAD_REQUIRED_FIELDS', message: `Unknown required field(s): ${bad.join(', ')}`, messageTh: 'ฟิลด์ที่ต้องกรอกไม่ถูกต้อง', details: { allowed: PLAYBOOK_FIELD_KEYS } });
    return keys;
  }

  private fieldsOf(row: PlaybookRow | undefined): string[] {
    const raw = row?.requiredFields;
    return Array.isArray(raw) ? (raw as string[]) : [];
  }

  // The board/config view: every stage with its playbook config + the live count of OPEN opps in it (for the
  // WIP badge) and whether that count is at/over the limit. HQ (no tenant) stages have id null → no playbook.
  async listView(stages: StageRow[], user: JwtUser) {
    const db = this.db;
    const rows = user.tenantId != null
      ? await db.select().from(crmStagePlaybooks).where(and(eq(crmStagePlaybooks.tenantId, user.tenantId), eq(crmStagePlaybooks.isActive, true)))
      : [];
    const byStage = new Map<number, PlaybookRow>(rows.map((r) => [Number(r.stageId), r]));
    const openByStage = await this.openCountsByStage(user);
    return {
      stages: stages.map((s) => {
        const pb = s.id != null ? byStage.get(Number(s.id)) : undefined;
        const openCount = s.id != null ? (openByStage.get(Number(s.id)) ?? 0) : 0;
        const wipLimit = pb?.wipLimit ?? null;
        return {
          stage_id: s.id, name: s.name, sequence: s.sequence, is_won: !!s.isWon, is_lost: !!s.isLost,
          wip_limit: wipLimit,
          required_fields: this.fieldsOf(pb),
          guidance: pb?.guidance ?? null,
          open_count: openCount,
          over_wip: wipLimit != null && openCount > wipLimit,
          at_wip: wipLimit != null && openCount >= wipLimit,
        };
      }),
      field_catalog: PLAYBOOK_FIELD_KEYS.map((k) => ({ key: k, label: REQUIRED_FIELD_DEFS[k]!.label })),
    };
  }

  private async openCountsByStage(user: JwtUser): Promise<Map<number, number>> {
    const db = this.db;
    const cond = user.tenantId != null ? eq(crmOpportunities.tenantId, user.tenantId) : undefined;
    const rows = await db.select({ stageId: crmOpportunities.stageId, c: sql<number>`count(*)::int` })
      .from(crmOpportunities)
      .where(and(eq(crmOpportunities.status, 'Open'), cond))
      .groupBy(crmOpportunities.stageId);
    return new Map(rows.filter((r) => r.stageId != null).map((r) => [Number(r.stageId), Number(r.c)]));
  }

  // Upsert one stage's playbook (supervisor: crm/exec). The stage must belong to the caller's tenant (validated
  // by the caller against listStages). wip_limit is a non-negative integer or null; required_fields is
  // whitelist-checked. Idempotent on (tenant, stage).
  async putPlaybook(stage: StageRow, dto: { wip_limit?: number | null; required_fields?: unknown; guidance?: string | null }, user: JwtUser) {
    if (user.tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'A tenant context is required to configure playbooks', messageTh: 'ต้องอยู่ในบริบทของบริษัทเพื่อตั้งค่า playbook' });
    if (stage.id == null) throw new BadRequestException({ code: 'BAD_STAGE', message: 'Stage is not persisted for this tenant', messageTh: 'สถานะยังไม่ได้บันทึกสำหรับบริษัทนี้' });
    let wipLimit: number | null = null;
    if (dto.wip_limit != null) {
      wipLimit = Math.trunc(Number(dto.wip_limit));
      if (!Number.isFinite(wipLimit) || wipLimit < 0) throw new BadRequestException({ code: 'BAD_WIP_LIMIT', message: 'wip_limit must be a non-negative integer or null', messageTh: 'wip_limit ต้องเป็นจำนวนเต็มไม่ติดลบหรือว่าง' });
    }
    const requiredFields = this.normalizeFields(dto.required_fields);
    const guidance = dto.guidance != null ? String(dto.guidance).slice(0, 2000) : null;
    const db = this.db;
    await db.insert(crmStagePlaybooks)
      .values({ tenantId: user.tenantId, stageId: Number(stage.id), wipLimit, requiredFields, guidance, isActive: true, updatedBy: user.username })
      .onConflictDoUpdate({
        target: [crmStagePlaybooks.tenantId, crmStagePlaybooks.stageId],
        set: { wipLimit, requiredFields, guidance, isActive: true, updatedBy: user.username, updatedAt: new Date() },
      });
    return { stage_id: Number(stage.id), name: stage.name, wip_limit: wipLimit, required_fields: requiredFields, guidance };
  }

  // Governed stage-entry gate — called from setStage AFTER the target/lost-reason checks and BEFORE the write.
  // `status` is the derived status of the target stage (Open|Won|Lost). Throws 400 with a machine code + the
  // offending detail; a no-op when the target stage has no active playbook (or the caller has no tenant/stage id).
  async assertStageEntry(opp: OppRow, target: StageRow, status: 'Open' | 'Won' | 'Lost', user: JwtUser) {
    if (target.id == null || user.tenantId == null) return;
    const db = this.db;
    const [pb] = await db.select().from(crmStagePlaybooks)
      .where(and(eq(crmStagePlaybooks.tenantId, user.tenantId), eq(crmStagePlaybooks.stageId, Number(target.id)), eq(crmStagePlaybooks.isActive, true)))
      .limit(1);
    if (!pb) return;

    // Required-field exit criteria — advancing INTO a stage requires the stage's fields populated. Skipped for
    // Lost (a deal can always be abandoned regardless of data completeness).
    if (status !== 'Lost') {
      const missing = this.fieldsOf(pb)
        .filter((k) => REQUIRED_FIELD_DEFS[k] && !REQUIRED_FIELD_DEFS[k]!.filled(opp))
        .map((k) => ({ key: k, label: REQUIRED_FIELD_DEFS[k]!.label }));
      if (missing.length) {
        throw new BadRequestException({
          code: 'STAGE_REQUIREMENTS_UNMET',
          message: `Cannot advance to ${target.name}: missing ${missing.map((m) => m.label).join(', ')}`,
          messageTh: `ยังเข้าสู่ขั้น ${target.name} ไม่ได้ ต้องกรอก: ${missing.map((m) => m.label).join(', ')}`,
          details: { stage: target.name, missing },
        });
      }
    }

    // WIP limit — a cap on OPEN opps concurrently in the stage. Only enforced when the target is itself Open
    // (Won/Lost are terminal and unbounded). Excludes the moving opp so a within-stage no-op never trips.
    if (status === 'Open' && pb.wipLimit != null) {
      const [{ c } = { c: 0 }] = await db.select({ c: sql<number>`count(*)::int` })
        .from(crmOpportunities)
        .where(and(
          eq(crmOpportunities.tenantId, user.tenantId),
          eq(crmOpportunities.stageId, Number(target.id)),
          eq(crmOpportunities.status, 'Open'),
          ne(crmOpportunities.id, Number(opp.id)),
        ));
      const current = Number(c) || 0;
      if (current >= pb.wipLimit) {
        throw new BadRequestException({
          code: 'WIP_LIMIT_EXCEEDED',
          message: `Stage ${target.name} is at its WIP limit (${current}/${pb.wipLimit})`,
          messageTh: `ขั้น ${target.name} เต็มขีดจำกัดงานระหว่างทำแล้ว (${current}/${pb.wipLimit})`,
          details: { stage: target.name, limit: pb.wipLimit, current },
        });
      }
    }
  }
}

// zod-free body shapes (the controller validates the wire body; these type the service boundary).
export type PutPlaybookBody = { wip_limit?: number | null; required_fields?: string[]; guidance?: string | null };
export type BulkStageBody = { opp_nos: string[]; stage: string; lost_reason?: string; win_reason?: string; probability?: number };
