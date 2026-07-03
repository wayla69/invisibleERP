import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { projectBoqLines, projectCommitments } from '../../database/schema';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
const n = (x: unknown) => Number(x ?? 0);
const EPS = 0.005; // half a cent — absorb numeric(16,2) rounding at the boundary

export interface ReserveDto {
  projectId: number;
  boqLineId: number;
  amount: number;
  qty?: number;
  sourceDocType: string;   // PO | PMR | PR | ADV | REIMB
  sourceDocNo: string;
  createdBy?: string;
  tenantId?: number | null;
}

// Commitment / encumbrance ledger (M1, docs/32, PROJ-12). The primitive that turns the BoQ-line material
// budget from *observed* into *enforced*: a draw is admitted only if it fits the line's remaining budget
// (`budget − Σ open+consumed commitments`), checked atomically under a FOR UPDATE row-lock on the BoQ line so
// two concurrent draws can't jointly overrun. Standalone (DRIZZLE only) so both procurement and projects can
// depend on it without a module cycle.
@Injectable()
export class CommitmentsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Sum of amounts that count against a BoQ line's budget (open + consumed; released is freed).
  private async committedFor(runner: any, boqLineId: number): Promise<number> {
    const [row] = await runner.select({ v: sql<string>`coalesce(sum(${projectCommitments.amount}),0)` })
      .from(projectCommitments)
      .where(and(eq(projectCommitments.boqLineId, Number(boqLineId)), inArray(projectCommitments.status, ['open', 'consumed'])));
    return r2(n(row?.v));
  }

  // Atomically reserve budget against a BoQ line. MUST run inside a transaction (`runner` = the tx) so the
  // FOR UPDATE lock on the BoQ line serialises concurrent draws. Throws BUDGET_EXCEEDED (with the remaining)
  // when the draw would push open+consumed commitments past the line budget. Returns the new commitment id.
  async reserve(runner: any, dto: ReserveDto): Promise<{ id: number; remaining: number; budget: number; committed: number }> {
    // Lock the BoQ line row for the duration of the tx — no other draw can read-then-write the same line
    // concurrently, which is what closes the "two requests each pass the check then both insert" race.
    const [line] = await runner.select().from(projectBoqLines).where(eq(projectBoqLines.id, Number(dto.boqLineId))).for('update').limit(1);
    if (!line) throw new NotFoundException({ code: 'BOQ_LINE_NOT_FOUND', message: `BoQ line ${dto.boqLineId} not found`, messageTh: 'ไม่พบรายการ BoQ' });
    const budget = r2(n(line.budgetAmount));
    const committed = await this.committedFor(runner, Number(dto.boqLineId));
    const amount = r2(dto.amount);
    if (committed + amount > budget + EPS) {
      const remaining = r2(Math.max(0, budget - committed));
      throw new BadRequestException({
        code: 'BUDGET_EXCEEDED',
        message: `Draw ${amount} exceeds the BoQ line remaining budget ${remaining} (budget ${budget}, already committed ${committed})`,
        messageTh: `เกินงบรายการ BoQ: ขอเบิก ${amount} แต่คงเหลือ ${remaining} (งบ ${budget} ผูกพันแล้ว ${committed})`,
        remaining, budget, committed,
      });
    }
    const [ins] = await runner.insert(projectCommitments).values({
      projectId: Number(dto.projectId), boqLineId: Number(dto.boqLineId), tenantId: dto.tenantId ?? null,
      sourceDocType: dto.sourceDocType, sourceDocNo: dto.sourceDocNo, qty: String(n(dto.qty)), amount: String(amount),
      status: 'open', createdBy: dto.createdBy ?? null,
    }).returning({ id: projectCommitments.id });
    return { id: Number(ins!.id), remaining: r2(budget - committed - amount), budget, committed: r2(committed + amount) };
  }

  // Release every OPEN commitment for a source doc (e.g. a cancelled PO) → frees the budget it held.
  async release(runner: any, sourceDocType: string, sourceDocNo: string): Promise<number> {
    const rows = await runner.update(projectCommitments)
      .set({ status: 'released', updatedAt: new Date() })
      .where(and(eq(projectCommitments.sourceDocType, sourceDocType), eq(projectCommitments.sourceDocNo, sourceDocNo), eq(projectCommitments.status, 'open')))
      .returning({ id: projectCommitments.id });
    return rows.length;
  }

  // Mark a source doc's OPEN commitments consumed (e.g. goods received) — a lifecycle transition; open and
  // consumed both count against the budget, so this doesn't change the remaining.
  async consume(runner: any, sourceDocType: string, sourceDocNo: string): Promise<number> {
    const rows = await runner.update(projectCommitments)
      .set({ status: 'consumed', updatedAt: new Date() })
      .where(and(eq(projectCommitments.sourceDocType, sourceDocType), eq(projectCommitments.sourceDocNo, sourceDocNo), eq(projectCommitments.status, 'open')))
      .returning({ id: projectCommitments.id });
    return rows.length;
  }

  // Per-BoQ-line committed total (open+consumed) for a set of lines — feeds the budget/committed/remaining read
  // model on getBoq. Returns a map lineId → committed amount.
  async committedByLine(boqLineIds: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (!boqLineIds.length) return out;
    const rows = await this.db.select({ line: projectCommitments.boqLineId, v: sql<string>`coalesce(sum(${projectCommitments.amount}),0)` })
      .from(projectCommitments)
      .where(and(inArray(projectCommitments.boqLineId, boqLineIds.map(Number)), inArray(projectCommitments.status, ['open', 'consumed'])))
      .groupBy(projectCommitments.boqLineId);
    for (const r of rows) out.set(Number(r.line), r2(n(r.v)));
    return out;
  }

  // Commitment rows for a project (newest first) + a status summary — the project commitments read model.
  async listForProject(projectId: number) {
    const rows = await this.db.select().from(projectCommitments)
      .where(eq(projectCommitments.projectId, Number(projectId)))
      .orderBy(sql`${projectCommitments.id} desc`);
    const sum = (st: string) => r2(rows.filter((r: any) => r.status === st).reduce((s: number, r: any) => s + n(r.amount), 0));
    return {
      commitments: rows.map((r: any) => ({
        id: Number(r.id), boq_line_id: Number(r.boqLineId), source_doc_type: r.sourceDocType, source_doc_no: r.sourceDocNo,
        qty: n(r.qty), amount: n(r.amount), status: r.status, created_by: r.createdBy, created_at: r.createdAt,
      })),
      count: rows.length,
      summary: { open: sum('open'), consumed: sum('consumed'), released: sum('released'), committed: r2(sum('open') + sum('consumed')) },
    };
  }
}
