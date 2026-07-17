import { Inject, Injectable, Optional, BadRequestException, ForbiddenException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { invMoves, invBalances, invCostLayers, invWriteoffRequests, itemCosting, items, itemCategories, locations, journalEntries, journalLines } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { postingDefault } from '../ledger/posting-events';
import { AccountDeterminationService } from '../ledger/account-determination.service';
import { n, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';
import { round4, EPS, isLayered, createLayer, consumeLayers, type CostingMethod, type LayerSlice } from './inventory-cost-layers';
import { InventoryWriteoffService } from './inventory-writeoff.service';

// FIFO/FEFO cost-layer mechanics live in inventory-cost-layers.ts; old import sites keep working.
export type { LayerSlice } from './inventory-cost-layers';

const bad = (code: string, message: string, messageTh: string) =>
  new BadRequestException({ code, message, messageTh });

// Inventory GL accounts — all already seeded in the COA (no new accounts introduced):
//   1200 Inventory · 2000 Accounts Payable · 5000 COGS · 5810 Scrap/Rework Loss (shrink/variance bucket).
const ACCT_INVENTORY = '1200';
const ACCT_AP = '2000';
const ACCT_COGS = '5000';
const ACCT_ADJ = '5810';
// INV-LC (landed cost, INV-1/COST-01) capitalises freight/duty/etc into 1200 and raises the sub-ledger value.
// Goods-in-Transit (INV-2/INV-16): value in transit on a two-step transfer order — SHIP moves value out of
// source inventory (Cr 1200) into 1255 (Dr); RECEIVE lands it at destination (Dr 1200, Cr 1255). Both INV-GIT
// and INV-LC are in INV_SOURCES so reconcile() sees the 1200 legs and the perpetual sub-ledger stays tied to
// GL 1200 (the 1255 balance sits outside the inventory set).
const ACCT_GIT = '1255';
const INV_SOURCES = ['INV-RCV', 'INV-ISS', 'INV-ADJ', 'INV-GIT', 'INV-LC'];

export interface ReceiveDto { item_id: string; item_description?: string; uom?: string; location_id?: string; qty: number; unit_cost: number; ref_type?: string; ref_id?: string; costing_method?: CostingMethod; lot_no?: string; expiry_date?: string }
export interface IssueDto { item_id: string; location_id?: string; qty: number; ref_type?: string; ref_id?: string }
export interface IssueToProjectDto { item_id: string; location_id?: string; qty: number; project_id: number; ref_type?: string; ref_id?: string }
export interface ReturnFromProjectDto { item_id: string; location_id?: string; qty: number; unit_cost: number; project_id: number; ref_type?: string; ref_id?: string }
export interface AdjustDto { item_id: string; location_id?: string; qty_delta: number; reason?: string }

/**
 * Perpetual inventory valuation sub-ledger (INV cycle). Each financial movement updates the running
 * moving-average balance AND posts a balanced JE through LedgerService, so the inventory control
 * account (1200) always ties to the sub-ledger (reconcile()). Atomicity rides the per-request tx
 * (same pattern as finance.issueAdvance): the move, the balance upsert and the JE commit/rollback together.
 *
 * Scope note: this is a self-contained valued ledger for receipts / issues / adjustments — it deliberately
 * does NOT hook into the POS sale path (which already relieves recipe COGS via 5300) to avoid double-posting.
 */
@Injectable()
export class InventoryLedgerService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly ledger: LedgerService,
    // Optional so a partially-constructed harness still builds; absent ⇒ determination off (literal parity).
    @Optional() private readonly determination?: AccountDeterminationService,
  ) {
    // Ctor-body plain class (god-service ratchet pattern) — the INV-07 write-off maker-checker register.
    this.writeoffs = new InventoryWriteoffService(db, {
      tenantOf: (u) => this.tenant(u),
      locFor: (t, i, l) => this.locFor(t, i, l),
      balanceRow: (t, i, l) => this.balanceRow(t, i, l),
      applyAdjust: (dto, u) => this.applyAdjust(dto, u),
    });
  }
  private readonly writeoffs: InventoryWriteoffService;

  private tenant(user: JwtUser): number {
    if (user.tenantId == null) throw bad('NO_TENANT', 'A tenant context is required', 'ต้องอยู่ในบริบทผู้เช่า');
    return user.tenantId;
  }

  // GL-21 — resolve the inventory / COGS / adjustment accounts for an item at a location: item → category →
  // warehouse override (when the tenant has opted into posting_determination) else the hardcoded control
  // accounts. Off/unconfigured ⇒ 1200 / 5000 / 5810.
  private async invAccounts(tenantId: number, itemId: string, loc: string): Promise<{ inventory: string; cogs: string; adj: string }> {
    const r = this.determination ? await this.determination.resolveItemAccounts(tenantId, itemId, loc) : null;
    // docs/43 PR-5: the tenant posting-rule layer sits BETWEEN item/warehouse determination and the
    // control literal — precedence: item → category → warehouse → posting-rule → registry default.
    // The inventory leg stays the pinned control (item-grain override lives in GL-21 determination only).
    const [issOvr, adjOvr] = await Promise.all([
      this.ledger.postingOverrides('COSTING.ISSUE', tenantId),
      this.ledger.postingOverrides('INV.ADJUST', tenantId),
    ]);
    return {
      inventory: r?.inventoryAccount ?? ACCT_INVENTORY,
      cogs: r?.cogsAccount ?? issOvr.cogs ?? postingDefault('COSTING.ISSUE', 'cogs'),
      adj: r?.adjustmentAccount ?? adjOvr.adjustment ?? postingDefault('INV.ADJUST', 'adjustment'),
    };
  }

  // docs/33 PR7 — the stock location for a move: the explicit one, else the item's default_location_id
  // (item → category, when determination is on), else the WH-MAIN control default. Off/unset ⇒ WH-MAIN.
  private async locFor(tenantId: number, itemId: string, explicit?: string | null): Promise<string> {
    if (explicit) return explicit;
    const d = this.determination ? await this.determination.resolveDefaultLocation(tenantId, itemId) : null;
    return d ?? 'WH-MAIN';
  }

  // The set of GL accounts that carry inventory value for this tenant's sub-ledger = the default control (1200)
  // plus any per-item / per-category / per-WAREHOUSE inventory_account overrides. reconcile() sums GL over this
  // whole set so it stays correct even when determination routes some items to a different inventory account.
  private async inventoryAccountSet(tenantId: number): Promise<string[]> {
    const set = new Set<string>([ACCT_INVENTORY]);
    const catRows = await this.db.selectDistinct({ a: itemCategories.inventoryAccount }).from(itemCategories)
      .where(and(eq(itemCategories.tenantId, tenantId), isNotNull(itemCategories.inventoryAccount)));
    const itemRows = await this.db.selectDistinct({ a: items.inventoryAccount }).from(items)
      .where(isNotNull(items.inventoryAccount));
    const locRows = await this.db.selectDistinct({ a: locations.inventoryAccount }).from(locations)
      .where(isNotNull(locations.inventoryAccount));
    for (const r of [...catRows, ...itemRows, ...locRows]) if (r.a) set.add(r.a);
    return [...set];
  }

  // Reject if the item is explicitly costed by the `costing` module (a per-item item_costing row) — the two
  // valued-inventory engines are mutually exclusive per item (see costing.setMethod for the reverse guard).
  private async assertNotCostingManaged(tenantId: number, itemId: string) {
    const [ic] = await this.db.select().from(itemCosting)
      .where(and(eq(itemCosting.tenantId, tenantId), eq(itemCosting.itemId, itemId))).limit(1);
    if (ic) throw bad('CONFLICTING_COSTING', `Item ${itemId} is managed by the costing module (method ${ic.method}); use the procurement-GR/costing path, or clear its costing config first`, 'สินค้านี้คิดต้นทุนผ่านโมดูล costing แล้ว — ใช้ช่องทาง GR/costing หรือยกเลิกการตั้งค่า costing ของสินค้านี้ก่อน');
  }

  private mkNo(prefix: string): string {
    const d = ymd().replace(/-/g, '');
    const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
    return `${prefix}-${d}-${rand}`;
  }

  private async balanceRow(tenantId: number, itemId: string, locationId: string) {
    const [b] = await this.db.select().from(invBalances)
      .where(and(eq(invBalances.tenantId, tenantId), eq(invBalances.itemId, itemId), eq(invBalances.locationId, locationId))).limit(1);
    return b ?? null;
  }

  private async findByRef(tenantId: number, refType: string, refId: string) {
    const [r] = await this.db.select().from(invMoves)
      .where(and(eq(invMoves.tenantId, tenantId), eq(invMoves.refType, refType), eq(invMoves.refId, refId))).limit(1);
    return r ?? null;
  }

  private async writeMove(a: {
    tenantId: number; moveNo: string; moveType: string; itemId: string; itemDescription?: string | null; uom?: string | null;
    locationId: string; qtySigned: number; unitCost: number; valueSigned: number; balanceQty: number; avgCost: number;
    refType?: string | null; refId?: string | null; reason?: string | null; glNo: string | null; by: string;
  }) {
    await this.db.insert(invMoves).values({
      tenantId: a.tenantId, moveNo: a.moveNo, moveType: a.moveType, itemId: a.itemId,
      itemDescription: a.itemDescription ?? null, uom: a.uom ?? null, locationId: a.locationId,
      qty: String(a.qtySigned), unitCost: String(a.unitCost), totalCost: String(a.valueSigned),
      balanceQty: String(a.balanceQty), avgCost: String(a.avgCost),
      refType: a.refType ?? null, refId: a.refId ?? null, reason: a.reason ?? null,
      glEntryNo: a.glNo, createdBy: a.by,
    });
  }

  private async upsertBalance(tenantId: number, itemId: string, itemDescription: string | null | undefined, locationId: string, qty: number, avg: number, value: number, method: CostingMethod = 'moving_avg') {
    // costingMethod is set only on INSERT (first touch); it is intentionally absent from the conflict
    // SET so an item's method is fixed once established.
    await this.db.insert(invBalances).values({
      tenantId, itemId, itemDescription: itemDescription ?? null, locationId,
      onHandQty: String(qty), avgCost: String(avg), totalValue: String(value), costingMethod: method,
    }).onConflictDoUpdate({
      target: [invBalances.tenantId, invBalances.itemId, invBalances.locationId],
      set: { onHandQty: String(qty), avgCost: String(avg), totalValue: String(value), updatedAt: sql`now()` },
    });
  }

  // ── Goods receipt → valued stock-in + GL (Dr 1200 / Cr 2000) ──────────────────────────────
  async receive(dto: ReceiveDto, user: JwtUser) {
    const tenantId = this.tenant(user);
    const qty = round4(dto.qty);
    const unitCost = round4(dto.unit_cost);
    if (!(qty > 0)) throw bad('BAD_QTY', 'qty must be > 0', 'จำนวนต้องมากกว่าศูนย์');
    if (unitCost < 0) throw bad('BAD_COST', 'unit_cost must be ≥ 0', 'ต้นทุนต้องไม่ติดลบ');
    const loc = await this.locFor(tenantId, dto.item_id, dto.location_id);
    // Costing-engine boundary: an item EXPLICITLY managed by the costing module (item_costing per-item row —
    // FIFO/AVG/STD, capitalized on procurement GR to GL 1200) must NOT also be capitalized by this perpetual
    // sub-ledger, or inventory double-posts to 1200. The newer sub-ledger yields to the established engine.
    await this.assertNotCostingManaged(tenantId, dto.item_id);
    // INV-02 — idempotent posting: a receipt already recorded for this ref is a no-op (no double stock / GL).
    if (dto.ref_type && dto.ref_id) {
      const dup = await this.findByRef(tenantId, dto.ref_type, dto.ref_id);
      if (dup) return { move_no: dup.moveNo, move_type: 'receipt', deduped: true, balance_qty: n(dup.balanceQty), avg_cost: n(dup.avgCost) };
    }
    const cur = await this.balanceRow(tenantId, dto.item_id, loc);
    // Costing method: fixed by the first receipt; later receipts inherit the established method.
    const method: CostingMethod = (cur?.costingMethod as CostingMethod) ?? dto.costing_method ?? 'moving_avg';
    const oldQty = n(cur?.onHandQty), oldVal = n(cur?.totalValue);
    const value = round4(qty * unitCost);
    const newQty = round4(oldQty + qty);
    const newVal = round4(oldVal + value);
    const newAvg = newQty > EPS ? round4(newVal / newQty) : 0;
    const moveNo = this.mkNo('INV-RCV');
    const acc = await this.invAccounts(tenantId, dto.item_id, loc);
    const je = value > EPS ? await this.ledger.postEntry({
      date: ymd(), source: 'INV-RCV', sourceRef: dto.ref_type && dto.ref_id ? `${dto.ref_type}:${dto.ref_id}` : moveNo,
      tenantId, memo: `Goods receipt ${moveNo} — ${dto.item_id}`, createdBy: user.username,
      lines: [{ account_code: acc.inventory, debit: value }, { account_code: ACCT_AP, credit: value }],
    }) : null;
    await this.writeMove({
      tenantId, moveNo, moveType: 'receipt', itemId: dto.item_id, itemDescription: dto.item_description, uom: dto.uom,
      locationId: loc, qtySigned: qty, unitCost, valueSigned: value, balanceQty: newQty, avgCost: newAvg,
      refType: dto.ref_type, refId: dto.ref_id, glNo: je?.entry_no ?? null, by: user.username,
    });
    await this.upsertBalance(tenantId, dto.item_id, dto.item_description, loc, newQty, newAvg, newVal, method);
    // fifo/fefo: this receipt opens a cost layer (lot/expiry carried for FEFO ordering).
    if (isLayered(method)) await createLayer(this.db, tenantId, dto.item_id, loc, qty, unitCost, dto.lot_no ?? null, dto.expiry_date ?? null, dto.ref_type ?? null, dto.ref_id ?? null, user.username);
    return { move_no: moveNo, move_type: 'receipt', item_id: dto.item_id, qty, unit_cost: unitCost, value, balance_qty: newQty, avg_cost: newAvg, costing_method: method, gl_entry_no: je?.entry_no ?? null };
  }

  // ── Goods issue → COGS at moving-average + GL (Dr 5000 / Cr 1200) ─────────────────────────
  async issue(dto: IssueDto, user: JwtUser) {
    const tenantId = this.tenant(user);
    const qty = round4(dto.qty);
    if (!(qty > 0)) throw bad('BAD_QTY', 'qty must be > 0', 'จำนวนต้องมากกว่าศูนย์');
    const loc = await this.locFor(tenantId, dto.item_id, dto.location_id);
    if (dto.ref_type && dto.ref_id) {
      const dup = await this.findByRef(tenantId, dto.ref_type, dto.ref_id);
      if (dup) return { move_no: dup.moveNo, move_type: 'issue', deduped: true, balance_qty: n(dup.balanceQty), avg_cost: n(dup.avgCost) };
    }
    const cur = await this.balanceRow(tenantId, dto.item_id, loc);
    const oldQty = n(cur?.onHandQty), oldVal = n(cur?.totalValue), avg = n(cur?.avgCost);
    const method: CostingMethod = (cur?.costingMethod as CostingMethod) ?? 'moving_avg';
    // INV-01 — negative-stock guard: cannot issue more than is on hand.
    if (qty > oldQty + EPS) throw bad('NEG_STOCK', `Cannot issue ${qty} of ${dto.item_id}; only ${oldQty} on hand`, 'สต๊อกไม่พอสำหรับการเบิก');
    // COGS = actual consumed layer cost (fifo/fefo) or qty × moving-average.
    const value = isLayered(method) ? (await consumeLayers(this.db, tenantId, dto.item_id, loc, qty, method)).cost : round4(qty * avg);
    const issueUnit = qty > EPS ? round4(value / qty) : avg;
    const newQty = round4(oldQty - qty);
    const newVal = round4(oldVal - value);
    const newAvg = newQty > EPS ? round4(newVal / newQty) : avg;
    const moveNo = this.mkNo('INV-ISS');
    const acc = await this.invAccounts(tenantId, dto.item_id, loc);
    const je = value > EPS ? await this.ledger.postEntry({
      date: ymd(), source: 'INV-ISS', sourceRef: dto.ref_type && dto.ref_id ? `${dto.ref_type}:${dto.ref_id}` : moveNo,
      tenantId, memo: `Goods issue ${moveNo} — ${dto.item_id}`, createdBy: user.username,
      lines: [{ account_code: acc.cogs, debit: value }, { account_code: acc.inventory, credit: value }],
    }) : null;
    await this.writeMove({
      tenantId, moveNo, moveType: 'issue', itemId: dto.item_id, locationId: loc,
      qtySigned: -qty, unitCost: issueUnit, valueSigned: -value, balanceQty: newQty, avgCost: newAvg,
      refType: dto.ref_type, refId: dto.ref_id, glNo: je?.entry_no ?? null, by: user.username,
    });
    await this.upsertBalance(tenantId, dto.item_id, cur?.itemDescription, loc, newQty, newAvg, newVal, method);
    return { move_no: moveNo, move_type: 'issue', item_id: dto.item_id, qty, unit_cost: issueUnit, value, balance_qty: newQty, avg_cost: newAvg, costing_method: method, gl_entry_no: je?.entry_no ?? null };
  }

  // ── Issue stock TO A PROJECT (M3, docs/32) → relieve inventory into project WIP + GL (Dr 1260 project WIP /
  // Cr 1200 Inventory) at moving-average / consumed-layer cost. Unlike a plain goods issue (Dr 5000 COGS), the
  // value is CAPITALISED into project WIP carrying the project_id dimension — it becomes project cost, relieved
  // to COGS only when the project bills. Same negative-stock guard and sub-ledger update as issue().
  async issueToProject(dto: IssueToProjectDto, user: JwtUser) {
    const tenantId = this.tenant(user);
    const qty = round4(dto.qty);
    if (!(qty > 0)) throw bad('BAD_QTY', 'qty must be > 0', 'จำนวนต้องมากกว่าศูนย์');
    const loc = await this.locFor(tenantId, dto.item_id, dto.location_id);
    if (dto.ref_type && dto.ref_id) {
      const dup = await this.findByRef(tenantId, dto.ref_type, dto.ref_id);
      if (dup) return { move_no: dup.moveNo, move_type: 'issue', deduped: true, balance_qty: n(dup.balanceQty), avg_cost: n(dup.avgCost) };
    }
    const cur = await this.balanceRow(tenantId, dto.item_id, loc);
    const oldQty = n(cur?.onHandQty), oldVal = n(cur?.totalValue), avg = n(cur?.avgCost);
    const method: CostingMethod = (cur?.costingMethod as CostingMethod) ?? 'moving_avg';
    if (qty > oldQty + EPS) throw bad('NEG_STOCK', `Cannot issue ${qty} of ${dto.item_id}; only ${oldQty} on hand`, 'สต๊อกไม่พอสำหรับการเบิก');
    const value = isLayered(method) ? (await consumeLayers(this.db, tenantId, dto.item_id, loc, qty, method)).cost : round4(qty * avg);
    const issueUnit = qty > EPS ? round4(value / qty) : avg;
    const newQty = round4(oldQty - qty);
    const newVal = round4(oldVal - value);
    const newAvg = newQty > EPS ? round4(newVal / newQty) : avg;
    const moveNo = this.mkNo('INV-PRJ');
    const acc = await this.invAccounts(tenantId, dto.item_id, loc);
    const je = value > EPS ? await this.ledger.postEntry({
      date: ymd(), source: 'INV-ISS', sourceRef: dto.ref_type && dto.ref_id ? `${dto.ref_type}:${dto.ref_id}` : moveNo,
      tenantId, memo: `Issue to project ${moveNo} — ${dto.item_id}`, createdBy: user.username,
      lines: [{ account_code: '1260', debit: value, project_id: dto.project_id, memo: `WIP ${dto.item_id}` }, { account_code: acc.inventory, credit: value }],
    }) : null;
    await this.writeMove({
      tenantId, moveNo, moveType: 'issue', itemId: dto.item_id, locationId: loc,
      qtySigned: -qty, unitCost: issueUnit, valueSigned: -value, balanceQty: newQty, avgCost: newAvg,
      refType: dto.ref_type, refId: dto.ref_id, glNo: je?.entry_no ?? null, by: user.username,
    });
    await this.upsertBalance(tenantId, dto.item_id, cur?.itemDescription, loc, newQty, newAvg, newVal, method);
    return { move_no: moveNo, move_type: 'issue_to_project', item_id: dto.item_id, qty, unit_cost: issueUnit, value, balance_qty: newQty, avg_cost: newAvg, gl_entry_no: je?.entry_no ?? null };
  }

  // ── Return unused material FROM A PROJECT (A1, docs/50 Wave 2 — the inverse of issueToProject; INV-19).
  // Receives the qty back on hand at the ORIGINAL issue unit cost (passed by the return flow, which reads it
  // off the issue movement — never re-valued at today's average) and relieves project WIP: Dr inventory /
  // Cr 1260 (project_id dimension). Layered items reopen a cost layer at that unit cost. Lives beside
  // issueToProject because both are the valued sub-ledger's core (module-private balance/layer helpers).
  async returnFromProject(dto: ReturnFromProjectDto, user: JwtUser) {
    const tenantId = this.tenant(user);
    const qty = round4(dto.qty);
    const unitCost = round4(dto.unit_cost);
    if (!(qty > 0)) throw bad('BAD_QTY', 'qty must be > 0', 'จำนวนต้องมากกว่าศูนย์');
    if (unitCost < 0) throw bad('BAD_COST', 'unit_cost must be ≥ 0', 'ต้นทุนต้องไม่ติดลบ');
    const loc = await this.locFor(tenantId, dto.item_id, dto.location_id);
    if (dto.ref_type && dto.ref_id) {
      const dup = await this.findByRef(tenantId, dto.ref_type, dto.ref_id);
      if (dup) return { move_no: dup.moveNo, move_type: 'return_from_project', deduped: true, balance_qty: n(dup.balanceQty), avg_cost: n(dup.avgCost) };
    }
    const cur = await this.balanceRow(tenantId, dto.item_id, loc);
    const method: CostingMethod = (cur?.costingMethod as CostingMethod) ?? 'moving_avg';
    const oldQty = n(cur?.onHandQty), oldVal = n(cur?.totalValue);
    const value = round4(qty * unitCost);
    const newQty = round4(oldQty + qty);
    const newVal = round4(oldVal + value);
    const newAvg = newQty > EPS ? round4(newVal / newQty) : 0;
    const moveNo = this.mkNo('INV-PRJR');
    const acc = await this.invAccounts(tenantId, dto.item_id, loc);
    const je = value > EPS ? await this.ledger.postEntry({
      date: ymd(), source: 'INV-RCV', sourceRef: dto.ref_type && dto.ref_id ? `${dto.ref_type}:${dto.ref_id}` : moveNo,
      tenantId, memo: `Return from project ${moveNo} — ${dto.item_id}`, createdBy: user.username,
      lines: [{ account_code: acc.inventory, debit: value }, { account_code: '1260', credit: value, project_id: dto.project_id, memo: `WIP return ${dto.item_id}` }],
    }) : null;
    await this.writeMove({
      tenantId, moveNo, moveType: 'receipt', itemId: dto.item_id, locationId: loc,
      qtySigned: qty, unitCost, valueSigned: value, balanceQty: newQty, avgCost: newAvg,
      refType: dto.ref_type, refId: dto.ref_id, glNo: je?.entry_no ?? null, by: user.username,
    });
    await this.upsertBalance(tenantId, dto.item_id, cur?.itemDescription, loc, newQty, newAvg, newVal, method);
    if (isLayered(method)) await createLayer(this.db, tenantId, dto.item_id, loc, qty, unitCost, null, null, dto.ref_type ?? null, dto.ref_id ?? null, user.username);
    return { move_no: moveNo, move_type: 'return_from_project', item_id: dto.item_id, qty, unit_cost: unitCost, value, balance_qty: newQty, avg_cost: newAvg, gl_entry_no: je?.entry_no ?? null };
  }

  // ── Stock adjustment (count variance / shrinkage) + GL (loss Dr 5810 / Cr 1200; gain reversed) ──
  // Stock adjustment. INV-04 — must carry a reason; authority gated to wh_adjust at the route. INV-07 —
  // a NEGATIVE adjustment (a write-off) is maker-checker: it becomes a REQUEST that posts nothing until a
  // different user approves; a positive adjustment (overage/found) posts immediately.
  async adjust(dto: AdjustDto, user: JwtUser) {
    const delta = round4(dto.qty_delta);
    if (!delta) throw bad('NO_CHANGE', 'qty_delta must be non-zero', 'ต้องระบุส่วนต่างที่ไม่เป็นศูนย์');
    if (!dto.reason || !dto.reason.trim()) throw bad('REASON_REQUIRED', 'A reason is required for stock adjustments', 'ต้องระบุเหตุผลในการปรับสต๊อก');
    if (delta < 0) return this.writeoffs.requestWriteOff(dto, delta, user);
    return this.applyAdjust(dto, user);
  }

  // INV-07 write-off maker-checker — extracted to InventoryWriteoffService (god-service ratchet round);
  // the approve path still runs the valued adjustment through this facade's applyAdjust port.
  async approveWriteOff(requestId: number, user: JwtUser, selfApprovalReason?: string | null) { return this.writeoffs.approveWriteOff(requestId, user, selfApprovalReason); }
  async rejectWriteOff(requestId: number, user: JwtUser, reason?: string) { return this.writeoffs.rejectWriteOff(requestId, user, reason); }
  async listWriteOffs(user: JwtUser, status?: string) { return this.writeoffs.listWriteOffs(user, status); }

  private async applyAdjust(dto: AdjustDto, user: JwtUser) {
    const tenantId = this.tenant(user);
    const delta = round4(dto.qty_delta);
    if (!delta) throw bad('NO_CHANGE', 'qty_delta must be non-zero', 'ต้องระบุส่วนต่างที่ไม่เป็นศูนย์');
    if (!dto.reason || !dto.reason.trim()) throw bad('REASON_REQUIRED', 'A reason is required for stock adjustments', 'ต้องระบุเหตุผลในการปรับสต๊อก');
    const loc = await this.locFor(tenantId, dto.item_id, dto.location_id);
    const cur = await this.balanceRow(tenantId, dto.item_id, loc);
    const oldQty = n(cur?.onHandQty), oldVal = n(cur?.totalValue), avg = n(cur?.avgCost);
    const method: CostingMethod = (cur?.costingMethod as CostingMethod) ?? 'moving_avg';
    const newQty = round4(oldQty + delta);
    if (newQty < -EPS) throw bad('NEG_STOCK', `Adjustment would drive ${dto.item_id} below zero (${newQty})`, 'การปรับทำให้สต๊อกติดลบ');
    const moveNo = this.mkNo('INV-ADJ');
    // Value impact: fifo/fefo shrinkage consumes layers at actual cost; an overage opens a layer at the
    // current average; moving-average items value the delta at the running average (unchanged).
    let moveVal: number;
    if (isLayered(method)) {
      if (delta < 0) {
        moveVal = (await consumeLayers(this.db, tenantId, dto.item_id, loc, Math.abs(delta), method)).cost;
      } else {
        moveVal = round4(delta * avg);
        await createLayer(this.db, tenantId, dto.item_id, loc, delta, avg, null, null, 'ADJ', moveNo, user.username);
      }
    } else {
      moveVal = round4(Math.abs(delta) * avg);
    }
    const newVal = round4(oldVal + (delta > 0 ? moveVal : -moveVal));
    const newAvg = newQty > EPS ? round4(newVal / newQty) : avg;
    const acc = await this.invAccounts(tenantId, dto.item_id, loc);
    const lines = delta < 0
      ? [{ account_code: acc.adj, debit: moveVal }, { account_code: acc.inventory, credit: moveVal }]
      : [{ account_code: acc.inventory, debit: moveVal }, { account_code: acc.adj, credit: moveVal }];
    const je = moveVal > EPS ? await this.ledger.postEntry({
      date: ymd(), source: 'INV-ADJ', sourceRef: moveNo,
      tenantId, memo: `Stock adjustment ${moveNo} — ${dto.reason}`, createdBy: user.username, lines,
    }) : null;
    await this.writeMove({
      tenantId, moveNo, moveType: 'adjust', itemId: dto.item_id, locationId: loc,
      qtySigned: delta, unitCost: avg, valueSigned: round4(delta > 0 ? moveVal : -moveVal), balanceQty: newQty, avgCost: newAvg,
      reason: dto.reason, glNo: je?.entry_no ?? null, by: user.username,
    });
    await this.upsertBalance(tenantId, dto.item_id, cur?.itemDescription, loc, newQty, newAvg, newVal);
    return { move_no: moveNo, move_type: 'adjust', item_id: dto.item_id, qty_delta: delta, value: round4(delta > 0 ? moveVal : -moveVal), balance_qty: newQty, avg_cost: newAvg, gl_entry_no: je?.entry_no ?? null };
  }

  // ── Valuation: on-hand value at moving-average per item/location ───────────────────────────
  async valuation(user: JwtUser) {
    const tenantId = this.tenant(user);
    const rows = await this.db.select().from(invBalances)
      .where(eq(invBalances.tenantId, tenantId)).orderBy(invBalances.itemId);
    const items = rows
      .filter((r: any) => Math.abs(n(r.onHandQty)) > EPS || Math.abs(n(r.totalValue)) > EPS)
      .map((r: any) => ({ item_id: r.itemId, item_description: r.itemDescription, location_id: r.locationId, on_hand_qty: n(r.onHandQty), avg_cost: n(r.avgCost), total_value: n(r.totalValue), costing_method: r.costingMethod ?? 'moving_avg' }));
    const total = round4(items.reduce((a: number, r: any) => a + r.total_value, 0));
    return { items, count: items.length, total_value: total };
  }

  // ── Open FIFO/FEFO cost layers (valuation depth for layer-costed items) ────────────────────
  async layers(user: JwtUser, q: { item_id?: string }) {
    const tenantId = this.tenant(user);
    const conds = [eq(invCostLayers.tenantId, tenantId), sql`${invCostLayers.remainingQty} > 0`];
    if (q.item_id) conds.push(eq(invCostLayers.itemId, q.item_id));
    const rows = await this.db.select().from(invCostLayers).where(and(...conds)).orderBy(asc(invCostLayers.itemId), asc(invCostLayers.id));
    const layers = rows.map((r: any) => ({
      item_id: r.itemId, location_id: r.locationId, lot_no: r.lotNo, expiry_date: r.expiryDate,
      remaining_qty: n(r.remainingQty), unit_cost: n(r.unitCost), layer_value: round4(n(r.remainingQty) * n(r.unitCost)),
      ref_type: r.refType, ref_id: r.refId,
    }));
    return { layers, count: layers.length, total_value: round4(layers.reduce((a: number, l: any) => a + l.layer_value, 0)) };
  }

  // ── INV-06 — sub-ledger ↔ GL inventory control-account reconciliation ──────────────────────
  async reconcile(user: JwtUser) {
    const tenantId = this.tenant(user);
    const bals = await this.db.select().from(invBalances).where(eq(invBalances.tenantId, tenantId));
    const subLedger = round4(bals.reduce((a: number, r: any) => a + n(r.totalValue), 0));
    // GL inventory attributable to the sub-ledger's own postings, for this tenant. Sums the whole inventory
    // account SET (control 1200 + any item/category overrides) so determination routing can't break the tie.
    const invAccts = await this.inventoryAccountSet(tenantId);
    const [g] = await this.db.select({
      d: sql<string>`coalesce(sum(${journalLines.debit}),0)`,
      c: sql<string>`coalesce(sum(${journalLines.credit}),0)`,
    }).from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(
        inArray(journalLines.accountCode, invAccts),
        eq(journalLines.tenantId, tenantId),
        eq(journalEntries.status, 'Posted'),
        inArray(journalEntries.source, INV_SOURCES),
      ));
    const glInventory = round4(n(g?.d) - n(g?.c));
    const difference = round4(subLedger - glInventory);
    return { sub_ledger_value: subLedger, gl_inventory: glInventory, difference, reconciled: Math.abs(difference) < 0.01 };
  }

  // ── Bridge for stock-ops (issue / transfer / stocktake) → perpetual valued sub-ledger ─────────
  // A "tracked" item is one already under perpetual valuation (it has a balance row, established by a
  // valued goods-receipt). Stock-ops drives valued postings for tracked items; legacy snapshot-only
  // items have no balance row → these return { valued: false } and the caller keeps its audit-only path.

  async isTracked(tenantId: number, itemId: string, locationId = 'WH-MAIN'): Promise<boolean> {
    return !!(await this.balanceRow(tenantId, itemId, locationId));
  }

  // Stocktake variance for a tracked item: bring valued on-hand to the counted qty and book the value
  // variance to GL (reuses adjust(): shortage Dr 5810 / Cr 1200, overage reversed). No-op if untracked.
  async postCountVariance(p: { item_id: string; location_id?: string; physical_qty: number; doc_no: string }, user: JwtUser) {
    const tenantId = this.tenant(user);
    const loc = await this.locFor(tenantId, p.item_id, p.location_id);
    const cur = await this.balanceRow(tenantId, p.item_id, loc);
    if (!cur) return { valued: false as const };
    const delta = round4(round4(p.physical_qty) - n(cur.onHandQty));
    if (!delta) return { valued: true as const, move_no: null, value_delta: 0, balance_qty: n(cur.onHandQty) };
    // A stocktake count IS the authorizing document, so it posts immediately (applyAdjust) — it does NOT
    // route through the INV-07 write-off maker-checker (which is only for ad-hoc /adjustments write-offs).
    const r = await this.applyAdjust({ item_id: p.item_id, location_id: loc, qty_delta: delta, reason: `Stocktake ${p.doc_no}` }, user);
    return { valued: true as const, ...r };
  }

  // Goods issue for a tracked item → relieve valued stock + COGS (reuses issue(), incl. NEG_STOCK guard).
  async issueIfTracked(p: { item_id: string; location_id?: string; qty: number }, user: JwtUser) {
    const tenantId = this.tenant(user);
    const loc = await this.locFor(tenantId, p.item_id, p.location_id);
    if (!(await this.balanceRow(tenantId, p.item_id, loc))) return { valued: false as const };
    const r = await this.issue({ item_id: p.item_id, location_id: loc, qty: p.qty }, user);
    return { valued: true as const, ...r };
  }

  // Inter-location transfer for a tracked item: move qty + value at the from-location's average cost
  // (value-neutral overall — no GL). No-op if the from-location is untracked.
  async transferIfTracked(p: { item_id: string; from_location: string; to_location: string; qty: number }, user: JwtUser) {
    const tenantId = this.tenant(user);
    const from = await this.balanceRow(tenantId, p.item_id, p.from_location);
    if (!from) return { valued: false as const };
    const qty = round4(p.qty);
    const fromOld = n(from.onHandQty), avg = n(from.avgCost);
    if (qty > fromOld + EPS) throw bad('NEG_STOCK', `Cannot transfer ${qty} of ${p.item_id} from ${p.from_location}; only ${fromOld} on hand`, 'สต๊อกต้นทางไม่พอสำหรับการโอน');
    const method: CostingMethod = (from.costingMethod as CostingMethod) ?? 'moving_avg';
    const moveNo = this.mkNo('INV-TRF');
    // fifo/fefo: physically move the consumed cost layers to the destination (preserving lot/expiry/cost);
    // moving-average: move value at the from-location's average. Value-neutral overall — no GL.
    let moveVal: number;
    if (isLayered(method)) {
      const consumed = await consumeLayers(this.db, tenantId, p.item_id, p.from_location, qty, method);
      moveVal = consumed.cost;
      for (const sl of consumed.slices) await createLayer(this.db, tenantId, p.item_id, p.to_location, sl.qty, sl.unitCost, sl.lotNo, sl.expiry, 'TRF', moveNo, user.username);
    } else {
      moveVal = round4(qty * avg);
    }
    const unit = qty > EPS ? round4(moveVal / qty) : avg;
    const fromQty = round4(fromOld - qty), fromVal = round4(n(from.totalValue) - moveVal);
    await this.upsertBalance(tenantId, p.item_id, from.itemDescription, p.from_location, fromQty, fromQty > EPS ? round4(fromVal / fromQty) : avg, fromVal, method);
    const to = await this.balanceRow(tenantId, p.item_id, p.to_location);
    const toQty = round4(n(to?.onHandQty) + qty), toVal = round4(n(to?.totalValue) + moveVal);
    await this.upsertBalance(tenantId, p.item_id, from.itemDescription, p.to_location, toQty, toQty > EPS ? round4(toVal / toQty) : avg, toVal, method);
    await this.writeMove({ tenantId, moveNo, moveType: 'transfer', itemId: p.item_id, locationId: p.from_location, qtySigned: -qty, unitCost: unit, valueSigned: -moveVal, balanceQty: fromQty, avgCost: fromQty > EPS ? round4(fromVal / fromQty) : avg, glNo: null, by: user.username });
    await this.writeMove({ tenantId, moveNo, moveType: 'transfer', itemId: p.item_id, locationId: p.to_location, qtySigned: qty, unitCost: unit, valueSigned: moveVal, balanceQty: toQty, avgCost: toQty > EPS ? round4(toVal / toQty) : avg, glNo: null, by: user.username });
    return { valued: true as const, move_no: moveNo, qty, unit_cost: unit };
  }

  // ── Two-step transfer-order in-transit legs (INV-2/INV-16) ────────────────────────────────
  // SHIP: relieve the source location's valued stock into Goods-in-Transit. Value = consumed FIFO/FEFO layer
  // cost (carried as slices so the destination can recreate them on receive) or qty × moving-average. Posts a
  // balanced JE Dr 1255 Goods-in-Transit / Cr <source inventory acct>. Untracked (no balance row) ⇒ valued:false
  // (audit-only — the transfer-order document still records the qty; no GL). Same NEG_STOCK guard as a transfer.
  async shipToInTransit(p: { item_id: string; item_description?: string | null; from_location: string; qty: number; ref_type?: string; ref_id?: string }, user: JwtUser) {
    const tenantId = this.tenant(user);
    const from = await this.balanceRow(tenantId, p.item_id, p.from_location);
    if (!from) return { valued: false as const, value: 0, unit_cost: 0, method: 'moving_avg' as CostingMethod, slices: [] as LayerSlice[] };
    const qty = round4(p.qty);
    if (!(qty > 0)) throw bad('BAD_QTY', 'qty must be > 0', 'จำนวนต้องมากกว่าศูนย์');
    const fromOld = n(from.onHandQty), avg = n(from.avgCost);
    if (qty > fromOld + EPS) throw bad('NEG_STOCK', `Cannot ship ${qty} of ${p.item_id} from ${p.from_location}; only ${fromOld} on hand`, 'สต๊อกต้นทางไม่พอสำหรับการโอน');
    const method: CostingMethod = (from.costingMethod as CostingMethod) ?? 'moving_avg';
    const moveNo = this.mkNo('INV-GIT');
    let moveVal: number; let slices: LayerSlice[] = [];
    if (isLayered(method)) { const c = await consumeLayers(this.db, tenantId, p.item_id, p.from_location, qty, method); moveVal = c.cost; slices = c.slices; }
    else moveVal = round4(qty * avg);
    const unit = qty > EPS ? round4(moveVal / qty) : avg;
    const fromQty = round4(fromOld - qty), fromVal = round4(n(from.totalValue) - moveVal);
    await this.upsertBalance(tenantId, p.item_id, from.itemDescription, p.from_location, fromQty, fromQty > EPS ? round4(fromVal / fromQty) : avg, fromVal, method);
    const acc = await this.invAccounts(tenantId, p.item_id, p.from_location);
    const je = moveVal > EPS ? await this.ledger.postEntry({
      date: ymd(), source: 'INV-GIT', sourceRef: p.ref_type && p.ref_id ? `${p.ref_type}:${p.ref_id}:SHIP` : `${moveNo}:SHIP`,
      tenantId, memo: `Transfer ship ${moveNo} — ${p.item_id} → in-transit`, createdBy: user.username,
      lines: [{ account_code: ACCT_GIT, debit: moveVal }, { account_code: acc.inventory, credit: moveVal }],
    }) : null;
    await this.writeMove({
      tenantId, moveNo, moveType: 'transfer_ship', itemId: p.item_id, itemDescription: p.item_description ?? from.itemDescription, locationId: p.from_location,
      qtySigned: -qty, unitCost: unit, valueSigned: -moveVal, balanceQty: fromQty, avgCost: fromQty > EPS ? round4(fromVal / fromQty) : avg,
      refType: p.ref_type, refId: p.ref_id ? `${p.ref_id}:SHIP` : null, glNo: je?.entry_no ?? null, by: user.username,
    });
    return { valued: true as const, value: moveVal, unit_cost: unit, method, slices, move_no: moveNo, gl_entry_no: je?.entry_no ?? null };
  }

  // RECEIVE: land the in-transit value at the destination location. Adds qty + the shipped snapshot value to
  // the destination balance (recreating carried FIFO/FEFO layers), and posts Dr <dest inventory acct> / Cr 1255
  // Goods-in-Transit. value/unit_cost/slices come from the shipping leg's snapshot on the transfer-order line.
  async receiveFromInTransit(p: { item_id: string; item_description?: string | null; to_location: string; qty: number; value: number; unit_cost?: number; method?: CostingMethod; slices?: LayerSlice[]; ref_type?: string; ref_id?: string }, user: JwtUser) {
    const tenantId = this.tenant(user);
    const qty = round4(p.qty);
    const value = round4(p.value);
    if (value <= EPS && qty <= EPS) return { valued: false as const };
    const to = await this.balanceRow(tenantId, p.item_id, p.to_location);
    const method: CostingMethod = p.method ?? (to?.costingMethod as CostingMethod) ?? 'moving_avg';
    const toOldQty = n(to?.onHandQty), toOldVal = n(to?.totalValue);
    const toQty = round4(toOldQty + qty), toVal = round4(toOldVal + value);
    const toAvg = toQty > EPS ? round4(toVal / toQty) : round4(p.unit_cost ?? 0);
    await this.upsertBalance(tenantId, p.item_id, p.item_description ?? to?.itemDescription, p.to_location, toQty, toAvg, toVal, method);
    if (isLayered(method) && p.slices?.length) for (const sl of p.slices) await createLayer(this.db, tenantId, p.item_id, p.to_location, sl.qty, sl.unitCost, sl.lotNo, sl.expiry, 'TO', p.ref_id ?? null, user.username);
    const acc = await this.invAccounts(tenantId, p.item_id, p.to_location);
    const je = value > EPS ? await this.ledger.postEntry({
      date: ymd(), source: 'INV-GIT', sourceRef: p.ref_type && p.ref_id ? `${p.ref_type}:${p.ref_id}:RECV` : `${p.item_id}:RECV`,
      tenantId, memo: `Transfer receive ${p.ref_id ?? p.item_id} — in-transit → ${p.to_location}`, createdBy: user.username,
      lines: [{ account_code: acc.inventory, debit: value }, { account_code: ACCT_GIT, credit: value }],
    }) : null;
    const moveNo = this.mkNo('INV-GIT');
    await this.writeMove({
      tenantId, moveNo, moveType: 'transfer_receive', itemId: p.item_id, itemDescription: p.item_description ?? to?.itemDescription, locationId: p.to_location,
      qtySigned: qty, unitCost: p.unit_cost ?? (qty > EPS ? round4(value / qty) : 0), valueSigned: value, balanceQty: toQty, avgCost: toAvg,
      refType: p.ref_type, refId: p.ref_id ? `${p.ref_id}:RECV` : null, glNo: je?.entry_no ?? null, by: user.username,
    });
    return { valued: true as const, value, balance_qty: toQty, avg_cost: toAvg, gl_entry_no: je?.entry_no ?? null };
  }

  // ── Movement ledger (audit trail) ─────────────────────────────────────────────────────────
  async listMoves(user: JwtUser, q: { item_id?: string; limit?: number }) {
    const tenantId = this.tenant(user);
    const conds = [eq(invMoves.tenantId, tenantId)];
    if (q.item_id) conds.push(eq(invMoves.itemId, q.item_id));
    const rows = await this.db.select().from(invMoves).where(and(...conds)).orderBy(desc(invMoves.id)).limit(q.limit ?? 100);
    return {
      moves: rows.map((r: any) => ({
        move_no: r.moveNo, move_date: r.moveDate, move_type: r.moveType, item_id: r.itemId, location_id: r.locationId,
        qty: n(r.qty), unit_cost: n(r.unitCost), total_cost: n(r.totalCost), balance_qty: n(r.balanceQty), avg_cost: n(r.avgCost),
        ref_type: r.refType, ref_id: r.refId, reason: r.reason, gl_entry_no: r.glEntryNo, created_by: r.createdBy,
      })),
      count: rows.length,
    };
  }
}
