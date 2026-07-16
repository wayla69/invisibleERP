import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { projects, invBalances, stockReservations, projectCommitments } from '../../database/schema';
import { InventoryLedgerService } from '../inventory/inventory-ledger.service';
import { CommitmentsService } from '../commitments/commitments.service';
import type { JwtUser } from '../../common/decorators';

const r4 = (x: unknown) => Math.round((Number(x) || 0) * 10000) / 10000;
const n = (x: unknown) => Number(x ?? 0);
const EPS = 0.0001;

export interface ReserveDto { project_code: string; item_id: string; location_id?: string; qty: number; boq_line_id?: number; unit_cost?: number }

// Stock reservation (M3, docs/32, INV-13). Soft-allocates on-hand stock to a project so it can't be double-
// allocated: available-to-issue = on_hand(inv_balances) − Σ(held reservations for the same item+location). A
// reservation is held → released (freed) or consumed (issued to the project, value moving inventory → WIP).
@Injectable()
export class ReservationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly inventory: InventoryLedgerService,
    @Optional() private readonly commitments?: CommitmentsService,
  ) {}

  private async projectRow(code: string) {
    const [p] = await this.db.select().from(projects).where(eq(projects.projectCode, code)).limit(1);
    if (!p) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: `Project ${code} not found`, messageTh: 'ไม่พบโครงการ' });
    return p;
  }

  // Held-reserved qty for an item+location (open holds only).
  private async heldQty(runner: any, tenantId: number | null, itemId: string, locationId: string): Promise<number> {
    const conds = [eq(stockReservations.itemId, itemId), eq(stockReservations.locationId, locationId), eq(stockReservations.status, 'held')];
    if (tenantId != null) conds.push(eq(stockReservations.tenantId, tenantId));
    const [row] = await runner.select({ v: sql<string>`coalesce(sum(${stockReservations.qtyReserved}),0)` }).from(stockReservations).where(and(...conds));
    return r4(n(row?.v));
  }

  private async onHand(runner: any, tenantId: number | null, itemId: string, locationId: string): Promise<number> {
    const conds = [eq(invBalances.itemId, itemId), eq(invBalances.locationId, locationId)];
    if (tenantId != null) conds.push(eq(invBalances.tenantId, tenantId));
    const [row] = await runner.select().from(invBalances).where(and(...conds)).limit(1);
    return r4(n(row?.onHandQty));
  }

  // Available-to-issue for an item+location = on_hand − Σ(held). Read-only view.
  async available(user: JwtUser, itemId: string, locationId = 'WH-MAIN') {
    const tenantId = user.tenantId ?? null;
    const onHand = await this.onHand(this.db, tenantId, itemId, locationId);
    const held = await this.heldQty(this.db, tenantId, itemId, locationId);
    return { item_id: itemId, location_id: locationId, on_hand: onHand, held, available: r4(onHand - held) };
  }

  // Reserve stock for a project. Atomic under a transaction: available is computed after locking existing
  // holds so two concurrent reservations can't over-allocate the same stock (INV-13). INSUFFICIENT_STOCK
  // when the request exceeds available.
  async reserve(dto: ReserveDto, user: JwtUser) {
    const p = await this.projectRow(dto.project_code);
    const tenantId = p.tenantId ?? user.tenantId ?? null;
    const loc = dto.location_id ?? 'WH-MAIN';
    const qty = r4(dto.qty);
    if (!(qty > 0)) throw new BadRequestException({ code: 'BAD_QTY', message: 'qty must be > 0', messageTh: 'จำนวนต้องมากกว่าศูนย์' });
    return this.db.transaction(async (tx: any) => {
      // Serialise concurrent reservations of the same item+location by locking its held rows.
      await tx.select({ id: stockReservations.id }).from(stockReservations)
        .where(and(eq(stockReservations.itemId, dto.item_id), eq(stockReservations.locationId, loc), eq(stockReservations.status, 'held'))).for('update');
      const onHand = await this.onHand(tx, tenantId, dto.item_id, loc);
      const held = await this.heldQty(tx, tenantId, dto.item_id, loc);
      const available = r4(onHand - held);
      if (qty > available + EPS) throw new BadRequestException({ code: 'INSUFFICIENT_STOCK', message: `Cannot reserve ${qty} of ${dto.item_id}; only ${available} available (on hand ${onHand}, held ${held})`, messageTh: `สต๊อกไม่พอสำหรับการจอง: ขอ ${qty} แต่ว่างเพียง ${available}`, available, on_hand: onHand, held });
      const [ins] = await tx.insert(stockReservations).values({
        tenantId, itemId: dto.item_id, locationId: loc, projectId: Number(p.id), boqLineId: dto.boq_line_id ?? null,
        sourceDocType: 'RES', qtyReserved: String(qty), status: 'held', createdBy: user.username,
      }).returning({ id: stockReservations.id });
      return { reservation_id: Number(ins!.id), project_code: dto.project_code, item_id: dto.item_id, location_id: loc, qty, status: 'held', available_after: r4(available - qty) };
    });
  }

  private async row(reservationId: number) {
    const [r] = await this.db.select().from(stockReservations).where(eq(stockReservations.id, Number(reservationId))).limit(1);
    if (!r) throw new NotFoundException({ code: 'RESERVATION_NOT_FOUND', message: `Reservation ${reservationId} not found`, messageTh: 'ไม่พบการจองสต๊อก' });
    return r;
  }

  // Release a held reservation → frees the stock (available goes back up). Idempotent-ish (only held releases).
  async release(reservationId: number, user: JwtUser) {
    const r = await this.row(reservationId);
    if (r.status !== 'held') throw new BadRequestException({ code: 'RESERVATION_NOT_HELD', message: `Reservation is ${r.status}, not held`, messageTh: 'การจองไม่ได้อยู่สถานะจอง' });
    await this.db.update(stockReservations).set({ status: 'released', updatedAt: new Date() }).where(eq(stockReservations.id, Number(reservationId)));
    return { reservation_id: Number(reservationId), status: 'released' };
  }

  // Issue a held reservation TO the project: consume the reservation and move the value from inventory (1200)
  // into project WIP (1260, project_id) via the inventory ledger. Records a consumed BoQ-line commitment when
  // the reservation carries a boq_line_id so the draw counts against the material budget.
  async issueToProject(reservationId: number, user: JwtUser) {
    const r = await this.row(reservationId);
    if (r.status !== 'held') throw new BadRequestException({ code: 'RESERVATION_NOT_HELD', message: `Reservation is ${r.status}, not held`, messageTh: 'การจองไม่ได้อยู่สถานะจอง' });
    const move = await this.inventory.issueToProject({
      item_id: r.itemId, location_id: r.locationId, qty: n(r.qtyReserved), project_id: Number(r.projectId),
      ref_type: 'RES', ref_id: String(r.id),
    }, user);
    await this.db.update(stockReservations).set({ status: 'consumed', issueNo: move.move_no, updatedAt: new Date() }).where(eq(stockReservations.id, Number(reservationId)));
    // Book the issued value as a consumed commitment against the BoQ line (authorised — the stock is already
    // on hand, so it never blocks; keeps the BoQ line's committed/remaining honest).
    if (this.commitments && r.boqLineId != null) {
      try {
        await this.db.transaction(async (tx: any) => {
          const moveVal = 'value' in move ? n(move.value) : 0;
          const c = await this.commitments!.reserve(tx, { projectId: Number(r.projectId), boqLineId: Number(r.boqLineId), amount: moveVal, qty: n(r.qtyReserved), sourceDocType: 'RES', sourceDocNo: move.move_no, createdBy: user.username, tenantId: r.tenantId ?? null, allowOver: true });
          await tx.update(projectCommitments).set({ status: 'consumed' }).where(eq(projectCommitments.id, c.id));
        });
      } catch { /* commitment booking is best-effort — the stock issue already posted */ }
    }
    return { reservation_id: Number(reservationId), status: 'consumed', ...move };
  }

  // A2 (docs/50 Wave 1) — stale-hold sweep. A reservation parked 'held' forever silently starves every
  // other project's available-to-issue (available = on_hand − Σheld), so holds older than max_age_days
  // are RELEASED in bulk (stock returns to the pool; nothing is issued or posted — releasing is the
  // no-GL, no-stock-movement path, so the sweep is safe to automate). Idempotent: released rows leave
  // the 'held' set, so a re-run scans nothing new. Runs manually (POST /api/reservations/expire-stale)
  // or scheduled as the `reservation_stale_release` action job (reservations-bi-reports.ts); the
  // projects action center surfaces aging holds BEFORE the sweep reaps them (kind `reservation_stale`).
  async expireStale(user: JwtUser, maxAgeDays = 30) {
    const days = Number.isFinite(Number(maxAgeDays)) && Number(maxAgeDays) > 0 ? Math.floor(Number(maxAgeDays)) : 30;
    const cutoff = new Date(Date.now() - days * 86400_000);
    const conds = [eq(stockReservations.status, 'held'), sql`${stockReservations.createdAt} < ${cutoff}`];
    if (user.tenantId != null) conds.push(eq(stockReservations.tenantId, user.tenantId));
    const stale = await this.db.select().from(stockReservations).where(and(...conds));
    if (!stale.length) return { max_age_days: days, scanned: 0, released: 0, reservations: [] };
    await this.db.update(stockReservations).set({ status: 'released', updatedAt: new Date() })
      .where(inArray(stockReservations.id, stale.map((r: any) => Number(r.id))));
    return {
      max_age_days: days, scanned: stale.length, released: stale.length,
      reservations: stale.map((r: any) => ({ id: Number(r.id), item_id: r.itemId, location_id: r.locationId, project_id: Number(r.projectId), qty: n(r.qtyReserved), created_at: r.createdAt })),
    };
  }

  async listForProject(code: string) {
    const p = await this.projectRow(code);
    const rows = await this.db.select().from(stockReservations).where(eq(stockReservations.projectId, Number(p.id))).orderBy(desc(stockReservations.id));
    const sum = (st: string) => r4(rows.filter((r: any) => r.status === st).reduce((s: number, r: any) => s + n(r.qtyReserved), 0));
    return {
      project_code: code,
      reservations: rows.map((r: any) => ({ id: Number(r.id), item_id: r.itemId, location_id: r.locationId, boq_line_id: r.boqLineId != null ? Number(r.boqLineId) : null, qty: n(r.qtyReserved), status: r.status, issue_no: r.issueNo, created_by: r.createdBy, created_at: r.createdAt })),
      count: rows.length, summary: { held: sum('held'), consumed: sum('consumed'), released: sum('released') },
    };
  }
}
