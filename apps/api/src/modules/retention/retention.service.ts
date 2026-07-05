import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { retentionLedger, retentionReleaseSchedule, projects } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
const n = (x: unknown) => Number(x ?? 0);
const EPS = 0.005; // half a cent — absorb numeric(16,2) rounding at the boundary

export type RetentionParty = 'customer' | 'subcontractor';
// The GL anchor for each side (docs/35 Phase 0): a customer withholds retention we will collect (asset);
// we withhold retention from a subcontractor we will pay (liability).
export const RETENTION_GL: Record<RetentionParty, string> = { customer: '1170', subcontractor: '2440' };
// On RELEASE the withheld amount reclassifies from the retention account to the ordinary control account: a
// customer's retention receivable (1170) becomes billable AR (1100); a subcontractor's retention payable (2440)
// becomes payable AP (2000) — [debit, credit] of the release JE.
const RELEASE_GL: Record<string, [string, string]> = { '1170': ['1100', '1170'], '2440': ['2440', '2000'] };

export interface RetentionTrancheDto {
  tranche_no?: number;
  due_basis?: 'date' | 'practical_completion' | 'dlp_end';
  pct?: number;        // % of the withheld amount (used when amount is omitted)
  amount?: number;     // explicit tranche amount (overrides pct)
  due_date?: string;   // ISO date (basis 'date')
}
export interface WithholdDto {
  partyType: RetentionParty;
  projectId?: number | null;
  partyRef?: string;
  sourceDocType?: string; // CLAIM | SUBVAL | MANUAL
  sourceDocNo: string;
  amount: number;
  createdBy?: string;
  tenantId?: number | null;
  schedule?: RetentionTrancheDto[];
}
export interface ReleaseDto {
  retentionId: number;
  amount?: number;      // partial release amount (ignored when trancheId is given)
  trancheId?: number;   // release a specific scheduled tranche (uses its amount)
  releasedBy?: string;
}

// Shared retention sub-ledger (docs/35 Phase 0). The primitive both Track A (customer progress billing /
// งวดงาน) and Track B (subcontractor valuations) build on: it records retention WITHHELD on certification and
// RELEASED in tranches, per party/document (outstanding = withheld − released), with an optional release
// schedule. It tracks balances only — the certifying service posts the GL journal touching the retention
// receivable (1170) / payable (2440) account in the SAME transaction (pass that tx as `runner`), exactly as
// the commitment ledger (docs/32) records encumbrance without posting GL. Standalone (DRIZZLE only) so both
// the projects/AR and procurement/AP services can depend on it without a module cycle.
@Injectable()
export class RetentionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly ledger: LedgerService,
  ) {}

  private async projectRow(code: string) {
    const [p] = await this.db.select().from(projects).where(eq(projects.projectCode, code)).limit(1);
    if (!p) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: `Project ${code} not found`, messageTh: 'ไม่พบโครงการ' });
    return p;
  }

  // Resolve an optional project_code to its id + the tenant to stamp on the retention row (the project's
  // tenant, falling back to the acting user's). Used by the controller to keep withhold() dimension-agnostic.
  async resolveProjectRef(code: string | undefined, userTenantId?: number | null): Promise<{ projectId: number | null; tenantId: number | null }> {
    if (!code) return { projectId: null, tenantId: userTenantId ?? null };
    const p = await this.projectRow(code);
    return { projectId: Number(p.id), tenantId: p.tenantId ?? userTenantId ?? null };
  }

  // Record a retention withholding. `runner` defaults to the injected db so the standalone controller can call
  // it directly; Track A/B pass their own transaction so the sub-ledger entry and the GL journal commit atomically.
  async withhold(dto: WithholdDto, runner: any = this.db): Promise<{ id: number; gl_account: string; withheld: number }> {
    const amount = r2(dto.amount);
    if (amount <= 0) throw new BadRequestException({ code: 'RETENTION_AMOUNT_INVALID', message: 'Retention amount must be positive', messageTh: 'จำนวนเงินประกันผลงานต้องมากกว่าศูนย์' });
    if (dto.partyType !== 'customer' && dto.partyType !== 'subcontractor')
      throw new BadRequestException({ code: 'RETENTION_PARTY_INVALID', message: 'party_type must be customer or subcontractor', messageTh: 'ประเภทคู่สัญญาไม่ถูกต้อง' });
    const gl = RETENTION_GL[dto.partyType];
    const [ins] = await runner.insert(retentionLedger).values({
      tenantId: dto.tenantId ?? null,
      partyType: dto.partyType,
      projectId: dto.projectId ?? null,
      partyRef: dto.partyRef ?? null,
      sourceDocType: dto.sourceDocType ?? 'MANUAL',
      sourceDocNo: dto.sourceDocNo,
      glAccount: gl,
      withheldAmount: String(amount),
      releasedAmount: '0',
      status: 'held',
      createdBy: dto.createdBy ?? null,
    }).returning({ id: retentionLedger.id });
    const id = Number(ins!.id);
    // Optional release schedule — a tranche amount is the explicit `amount`, else pct% of the withheld total.
    if (dto.schedule?.length) {
      let i = 0;
      for (const t of dto.schedule) {
        i += 1;
        const trAmount = t.amount != null ? r2(t.amount) : r2((amount * n(t.pct)) / 100);
        await runner.insert(retentionReleaseSchedule).values({
          tenantId: dto.tenantId ?? null, retentionId: id, trancheNo: t.tranche_no ?? i,
          dueBasis: t.due_basis ?? 'date', pct: t.pct != null ? String(t.pct) : null, amount: String(trAmount),
          dueDate: t.due_date ?? null, status: 'pending',
        });
      }
    }
    return { id, gl_account: gl, withheld: amount };
  }

  // Release retention (a partial amount, or a specific scheduled tranche). MUST run inside a transaction so the
  // FOR UPDATE lock on the ledger row serialises concurrent releases and the outstanding can't be over-released.
  async release(dto: ReleaseDto, runner: any): Promise<{ id: number; released: number; released_amount: number; outstanding: number; status: string; entry_no: string | null }> {
    const [row] = await runner.select().from(retentionLedger).where(eq(retentionLedger.id, Number(dto.retentionId))).for('update').limit(1);
    if (!row) throw new NotFoundException({ code: 'RETENTION_NOT_FOUND', message: `Retention ${dto.retentionId} not found`, messageTh: 'ไม่พบรายการเงินประกันผลงาน' });
    const withheld = r2(n(row.withheldAmount));
    const already = r2(n(row.releasedAmount));
    const outstanding = r2(withheld - already);

    // Resolve the release amount (a named tranche's amount, else the explicit amount).
    let tranche: any = null;
    let amount: number;
    if (dto.trancheId != null) {
      [tranche] = await runner.select().from(retentionReleaseSchedule)
        .where(and(eq(retentionReleaseSchedule.id, Number(dto.trancheId)), eq(retentionReleaseSchedule.retentionId, Number(dto.retentionId)))).limit(1);
      if (!tranche) throw new NotFoundException({ code: 'RETENTION_TRANCHE_NOT_FOUND', message: `Tranche ${dto.trancheId} not found`, messageTh: 'ไม่พบงวดการคืนเงินประกัน' });
      if (tranche.status === 'released') throw new BadRequestException({ code: 'RETENTION_TRANCHE_RELEASED', message: 'Tranche already released', messageTh: 'งวดนี้คืนแล้ว' });
      amount = r2(n(tranche.amount));
    } else {
      amount = r2(dto.amount);
    }
    if (amount <= 0) throw new BadRequestException({ code: 'RETENTION_AMOUNT_INVALID', message: 'Release amount must be positive', messageTh: 'จำนวนเงินที่คืนต้องมากกว่าศูนย์' });
    if (amount > outstanding + EPS)
      throw new BadRequestException({ code: 'RETENTION_OVER_RELEASE', message: `Release ${amount} exceeds outstanding retention ${outstanding}`, messageTh: `คืนเกินยอดคงค้าง: คืน ${amount} แต่คงค้าง ${outstanding}`, outstanding, withheld, released: already });

    const newReleased = r2(already + amount);
    const status = newReleased + EPS >= withheld ? 'released' : 'partially_released';
    await runner.update(retentionLedger).set({ releasedAmount: String(newReleased), status, updatedAt: new Date() }).where(eq(retentionLedger.id, Number(dto.retentionId)));
    if (tranche) await runner.update(retentionReleaseSchedule).set({ status: 'released', releasedAt: new Date() }).where(eq(retentionReleaseSchedule.id, Number(tranche.id)));

    // Reclassify the released amount OUT of the retention account into the ordinary control account (customer
    // retention receivable 1170 → AR 1100; subcontractor retention payable 2440 → AP 2000). Idempotent on the
    // cumulative released amount so a retried release can't double-post.
    const [dr, cr] = RELEASE_GL[String(row.glAccount)] ?? [];
    let entryNo: string | null = null;
    if (dr && cr) {
      const ref = `RET${dto.retentionId}-${newReleased}`;
      if (!(await this.ledger.alreadyPosted('RETENTION-REL', ref, row.tenantId ?? null, runner))) {
        const projectId = row.projectId != null ? Number(row.projectId) : null;
        const je: any = await this.ledger.postEntry({
          source: 'RETENTION-REL', sourceRef: ref, tenantId: row.tenantId ?? null, memo: `Retention release ${row.sourceDocType} ${row.sourceDocNo}`, createdBy: dto.releasedBy ?? 'system',
          lines: [
            { account_code: dr, debit: amount, memo: `Retention release ${row.sourceDocNo}`, project_id: projectId },
            { account_code: cr, credit: amount, memo: `Retention release ${row.sourceDocNo}`, project_id: projectId },
          ],
        }, runner);
        entryNo = je.entry_no;
      }
    }
    return { id: Number(dto.retentionId), released: amount, released_amount: newReleased, outstanding: r2(withheld - newReleased), status, entry_no: entryNo };
  }

  // Controller convenience: run a standalone release inside its own transaction (row-locked).
  async releaseStandalone(dto: ReleaseDto) {
    return this.db.transaction((tx) => this.release(dto, tx));
  }

  // Per-project retention read model: rows + a receivable/payable-split balance summary.
  async listForProject(projectId: number) {
    const rows = await this.db.select().from(retentionLedger).where(eq(retentionLedger.projectId, Number(projectId))).orderBy(desc(retentionLedger.id));
    const ids = rows.map((r: any) => Number(r.id));
    const tranches = ids.length
      ? await this.db.select().from(retentionReleaseSchedule).where(inArray(retentionReleaseSchedule.retentionId, ids))
      : [];
    const bySide = (party: RetentionParty) => {
      const rs = rows.filter((r: any) => r.partyType === party);
      const withheld = r2(rs.reduce((s: number, r: any) => s + n(r.withheldAmount), 0));
      const released = r2(rs.reduce((s: number, r: any) => s + n(r.releasedAmount), 0));
      return { withheld, released, outstanding: r2(withheld - released), count: rs.length };
    };
    return {
      project_id: Number(projectId),
      receivable: bySide('customer'),      // retention withheld by customers (asset 1170)
      payable: bySide('subcontractor'),    // retention withheld from subcontractors (liability 2440)
      rows: rows.map((r: any) => ({
        id: Number(r.id), party_type: r.partyType, party_ref: r.partyRef, gl_account: r.glAccount,
        source_doc_type: r.sourceDocType, source_doc_no: r.sourceDocNo,
        withheld: n(r.withheldAmount), released: n(r.releasedAmount), outstanding: r2(n(r.withheldAmount) - n(r.releasedAmount)),
        status: r.status, created_at: r.createdAt,
        schedule: tranches.filter((t: any) => Number(t.retentionId) === Number(r.id)).map((t: any) => ({
          id: Number(t.id), tranche_no: t.trancheNo, due_basis: t.dueBasis, pct: t.pct != null ? n(t.pct) : null, amount: n(t.amount), due_date: t.dueDate, status: t.status,
        })),
      })),
    };
  }

  async listForProjectCode(code: string) {
    const p = await this.projectRow(code);
    return this.listForProject(Number(p.id));
  }

  // Retention releases due for action — pending, date-based tranches whose due date has passed (as_of),
  // joined to the parent ledger row. The seed of the future action-center `retention_due` exception.
  async due(asOf?: string) {
    const cutoff = asOf ?? new Date().toISOString().slice(0, 10);
    const tranches = await this.db.select().from(retentionReleaseSchedule)
      .where(and(eq(retentionReleaseSchedule.status, 'pending'), eq(retentionReleaseSchedule.dueBasis, 'date'), lte(retentionReleaseSchedule.dueDate, cutoff)))
      .orderBy(retentionReleaseSchedule.dueDate);
    const retIds = [...new Set(tranches.map((t: any) => Number(t.retentionId)))];
    const parents = retIds.length ? await this.db.select().from(retentionLedger).where(inArray(retentionLedger.id, retIds)) : [];
    const byId = new Map<number, any>(parents.map((p: any) => [Number(p.id), p]));
    return {
      as_of: cutoff,
      count: tranches.length,
      total: r2(tranches.reduce((s: number, t: any) => s + n(t.amount), 0)),
      due: tranches.map((t: any) => {
        const p = byId.get(Number(t.retentionId));
        return {
          tranche_id: Number(t.id), retention_id: Number(t.retentionId), amount: n(t.amount), due_date: t.dueDate,
          party_type: p?.partyType, party_ref: p?.partyRef, project_id: p ? Number(p.projectId) : null,
          source_doc_type: p?.sourceDocType, source_doc_no: p?.sourceDocNo, gl_account: p?.glAccount,
        };
      }),
    };
  }
}
