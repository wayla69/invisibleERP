import { Inject, Injectable, Optional, BadRequestException } from '@nestjs/common';
import { eq, and, isNotNull, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { posOfflineSync, dineInOrders } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { DineInService } from './dine-in.service';
import { BuffetService } from './buffet.service';
import { MemberService } from '../loyalty/member.service';

// Offline-queued REGISTER (touch-POS) sales, replayed idempotently through the restaurant
// order→checkout path. The touch register sells MENU items by `sku` (a different catalog + sale
// path than the portal/inventory POS offline-sync), so it needs its own replay endpoint — but it
// reuses the SAME `pos_offline_sync` dedup ledger (unique (tenant, client_uuid)), so a portal op
// and a register op never collide and a replay never double-posts.
//
// Each op runs in its OWN savepoint (nested db.transaction → SAVEPOINT under the request tx): a
// thrown error rolls back to that savepoint only, so one bad sale never poisons the rest of the
// batch, and the request's final COMMIT persists every good sale.
export interface RegisterOfflineLine { sku?: string; menu_item_id?: number; qty: number; modifier_option_ids?: number[]; notes?: string }
export interface RegisterOfflineSaleOp {
  client_uuid: string;
  device_id?: string;
  client_seq?: number;
  captured_at: string;             // ISO — preserved as the original offline moment
  lines: RegisterOfflineLine[];
  method?: string;
  discount_pct?: number;
  // ── hub→cloud replay fidelity (docs/41 Phase 2a; additive — register clients don't send these) ──
  discount?: number;               // order-level FIXED discount amount (exclusive with discount_pct)
  tip?: number;                    // staff tip (THB) — liability 2300, outside subtotal/VAT
  service_charge_pct?: number;     // force-applied at party 1 (same shape as the register's manual SC)
  // ── Phase 2b: buffet-tier sale — the per-pax charge is re-priced from THIS server's package master
  //    (never the hub's number); `lines` may then be empty (buffet food itself bills ฿0). ──
  buffet?: { package_code: string; pax: number; overtime_pax?: number };
  // ── Phase 2c (docs/50 Wave 4 C4): loyalty-redemption replay — the hub emits the member + the points
  //    the HUB redeemed; the CLOUD re-checks the member and clamps to ITS balance under the redeem lock
  //    (the cloud ledger is the book of record; the hub's local ledger never syncs). ──
  member_id?: number;
  redeem_points?: number;
}
export interface RegisterOfflineSyncBatchDto { sales: RegisterOfflineSaleOp[] }
export interface SyncResult { client_uuid: string; status: 'synced' | 'duplicate' | 'failed'; sale_no: string | null; error: string | null; adjustments?: string[] }

// ── POS-6: offline DINE-IN ops (open table / add items / fire) ──────────────────────────────────
// Dine-in used to be online-only (the kitchen/fire path). POS-6 lets the register capture the dine-in
// order lifecycle while offline and replay it idempotently on reconnect — SETTLEMENT stays online (a
// recorded electronic tender must go through the live checkout path). Each op carries its own
// `client_uuid` (per-op idempotency, same dedup ledger as the quick-sale path) plus an `order_uuid`
// — a client-generated offline-order key that links the `open` op to its later `add`/`fire` ops so
// the replay can resolve the server-minted order they belong to (the client never knows DIN-… offline).
export interface DineInOfflineOpLine { sku?: string; menu_item_id?: number; qty: number; modifier_option_ids?: number[]; notes?: string; course?: number }
export interface DineInOfflineOp {
  client_uuid: string;             // per-op idempotency key (stable across retries)
  order_uuid: string;              // client offline-order key (stable across open→add→fire of one order)
  op: 'open' | 'add' | 'fire';
  captured_at: string;             // ISO — the original offline moment
  device_id?: string;
  client_seq?: number;             // per-device monotonic counter → replay in capture order (open before add/fire)
  table_id?: number;               // open: attach to a table (omit ⇒ counter/quick dine-in)
  guest_count?: number;            // open
  fulfillment_type?: 'dine_in' | 'takeaway' | 'delivery' | 'pickup'; // open
  lines?: DineInOfflineOpLine[];   // open + add
  course?: number;                 // fire: fire only this course (omit ⇒ fire all pending)
}
export interface DineInOfflineSyncBatchDto { ops: DineInOfflineOp[] }
export interface DineInSyncResult { client_uuid: string; op: DineInOfflineOp['op']; status: 'synced' | 'duplicate' | 'failed'; order_no: string | null; error: string | null }

@Injectable()
export class RestaurantOfflineSyncService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly dineIn: DineInService,
    private readonly buffet: BuffetService,
    @Optional() private readonly member?: MemberService, // C4: cloud-side redeem clamp on hub replay
  ) {}

  async syncBatch(dto: RegisterOfflineSyncBatchDto, user: JwtUser) {
    const ops = [...dto.sales].sort((a, b) => (a.client_seq ?? 0) - (b.client_seq ?? 0)); // sequence integrity
    const results: SyncResult[] = [];
    for (const op of ops) results.push(await this.syncOne(op, user));
    const summary = { synced: 0, duplicate: 0, failed: 0 } as Record<string, number>;
    for (const r of results) summary[r.status]!++;
    return { results, summary };
  }

  private async syncOne(op: RegisterOfflineSaleOp, user: JwtUser): Promise<SyncResult> {
    const db = this.db;
    const tenantId = user.tenantId ?? null;
    // dedup gate — short-circuit ONLY on a genuinely-completed sale (sale_no set). A prior 'failed'
    // tombstone (e.g. a transient 86'd item) must NOT block a retry, so we require sale_no IS NOT NULL.
    const [seen] = await db.select().from(posOfflineSync)
      .where(and(tenantId == null ? sql`${posOfflineSync.tenantId} is null` : eq(posOfflineSync.tenantId, tenantId), eq(posOfflineSync.clientUuid, op.client_uuid), isNotNull(posOfflineSync.saleNo))).limit(1);
    if (seen) return { client_uuid: op.client_uuid, status: 'duplicate', sale_no: seen.saleNo ?? null, error: null };

    try {
      return await db.transaction(async () => { // SAVEPOINT — rolls back to here on throw, outer tx survives
        // Replay through the SAME online path the register uses: create the order (server re-prices +
        // 86-checks the menu items) then checkout. Offline register sales are quick (no table) — fire
        // is skipped (the kitchen was offline anyway). The sale books on the SYNC day; offline windows
        // are short (intra-shift), so same-day sync books on the same business day.
        const order: any = await this.dineIn.createOrder({ items: (op.lines ?? []) as any }, user);
        // buffet-tier replay (Phase 2b): per-pax charge (+ overtime) priced from THIS server's master
        if (op.buffet) {
          const [row] = await db.select({ id: dineInOrders.id }).from(dineInOrders).where(eq(dineInOrders.orderNo, order.order_no)).limit(1);
          await this.buffet.applyReplayCharge(Number(row!.id), user.tenantId ?? null, op.buffet.package_code, Number(op.buffet.pax), Number(op.buffet.overtime_pax ?? 0), user);
        }
        // C4 (docs/50 Wave 4): loyalty-redemption replay — "adjusted at sync". The hub redeemed against
        // its LOCAL balance; the cloud clamps to its OWN balance (never fails the revenue-bearing sale
        // over a points drift) and surfaces what changed. redeemInTx's lock + LYL-22 idempotency then
        // apply inside checkout exactly as a native sale.
        const adjustments: string[] = [];
        let memberId = op.member_id, redeemPoints = op.redeem_points ?? 0;
        if (memberId && redeemPoints > 0) {
          try {
            const bal: any = this.member ? await this.member.balance(Number(memberId), user) : null;
            const cloudBal = Number(bal?.balance ?? bal?.points ?? 0);
            if (!bal) { adjustments.push(`LOYALTY_UNAVAILABLE: redeemed ${redeemPoints} points not replayed`); memberId = undefined; redeemPoints = 0; }
            else if (cloudBal < redeemPoints) { adjustments.push(`REDEEM_CLAMPED: hub redeemed ${redeemPoints}, cloud balance ${cloudBal} — replayed ${cloudBal}`); redeemPoints = Math.max(0, cloudBal); }
          } catch {
            adjustments.push(`MEMBER_NOT_FOUND: member ${memberId} unknown on the cloud — redeemed ${redeemPoints} points not replayed`);
            memberId = undefined; redeemPoints = 0;
          }
        }
        const sale: any = await this.dineIn.checkout(order.order_no, {
          method: op.method ?? 'Cash', discount_pct: op.discount_pct, discount: op.discount, tip: op.tip,
          ...(memberId ? { member_id: memberId } : {}),
          ...(memberId && redeemPoints > 0 ? { redeem_points: redeemPoints } : {}),
          // manual service charge replays exactly like the register applies it: forced at the given %.
          ...(op.service_charge_pct ? { apply_pricing_rules: true, service_charge_pct: op.service_charge_pct, party_size: 1, service_min_party: 1 } : {}),
        } as any, user);
        await db.insert(posOfflineSync).values({
          tenantId, clientUuid: op.client_uuid, deviceId: op.device_id ?? null, status: 'synced',
          saleNo: sale.sale_no, capturedAt: new Date(op.captured_at), clientSeq: op.client_seq ?? null,
          payloadHash: hashOp(op), createdBy: user.username,
        }).onConflictDoUpdate({ target: [posOfflineSync.tenantId, posOfflineSync.clientUuid], set: { status: 'synced', saleNo: sale.sale_no, errorCode: null, errorMessage: null, syncedAt: new Date() } });
        return { client_uuid: op.client_uuid, status: 'synced' as const, sale_no: sale.sale_no, error: null, ...(adjustments.length ? { adjustments } : {}) };
      });
    } catch (e: any) {
      const code = e?.response?.code ?? e?.code ?? 'SYNC_FAILED';
      // audit the failure in a FRESH savepoint so it commits even though the sale's savepoint rolled back.
      await db.transaction(async () => {
        await db.insert(posOfflineSync).values({
          tenantId, clientUuid: op.client_uuid, deviceId: op.device_id ?? null, status: 'failed', saleNo: null,
          capturedAt: new Date(op.captured_at), clientSeq: op.client_seq ?? null, payloadHash: hashOp(op),
          errorCode: code, errorMessage: String(e?.response?.message ?? e?.message ?? e), createdBy: user.username,
        }).onConflictDoUpdate({ target: [posOfflineSync.tenantId, posOfflineSync.clientUuid], set: { status: 'failed', errorCode: code, errorMessage: String(e?.response?.message ?? e?.message ?? e), attempts: sql`${posOfflineSync.attempts} + 1`, syncedAt: new Date() } });
      }).catch(() => { /* audit is best-effort */ });
      return { client_uuid: op.client_uuid, status: 'failed', sale_no: null, error: code };
    }
  }

  // ── POS-6: replay a batch of offline dine-in ops. Ordered by client_seq so an `open` always applies
  //    before the `add`/`fire` ops that reference it. Idempotent on (tenant, client_uuid); an already-
  //    applied op returns 'duplicate' (never re-fires a line on reconnect). ──
  async syncDineInBatch(dto: DineInOfflineSyncBatchDto, user: JwtUser) {
    const ops = [...dto.ops].sort((a, b) => (a.client_seq ?? 0) - (b.client_seq ?? 0));
    const results: DineInSyncResult[] = [];
    for (const op of ops) results.push(await this.syncOneDineIn(op, user));
    const summary = { synced: 0, duplicate: 0, failed: 0 } as Record<string, number>;
    for (const r of results) summary[r.status]!++;
    return { results, summary };
  }

  // resolve the server order an add/fire op targets: the synced `open` row for this (tenant, order_uuid).
  private async resolveOfflineOrderNo(tenantId: number | null, orderUuid: string): Promise<string | null> {
    const [row] = await this.db.select({ orderNo: posOfflineSync.orderNo }).from(posOfflineSync)
      .where(and(
        tenantId == null ? sql`${posOfflineSync.tenantId} is null` : eq(posOfflineSync.tenantId, tenantId),
        eq(posOfflineSync.orderUuid, orderUuid), eq(posOfflineSync.opType, 'dinein_open'), eq(posOfflineSync.status, 'synced'),
      )).limit(1);
    return row?.orderNo ?? null;
  }

  private async syncOneDineIn(op: DineInOfflineOp, user: JwtUser): Promise<DineInSyncResult> {
    const db = this.db;
    const tenantId = user.tenantId ?? null;
    const tEq = tenantId == null ? sql`${posOfflineSync.tenantId} is null` : eq(posOfflineSync.tenantId, tenantId);
    const opType = op.op === 'open' ? 'dinein_open' : op.op === 'add' ? 'dinein_add' : 'dinein_fire';
    // dedup gate — short-circuit only on a genuinely-applied op (status='synced'). A prior 'failed'
    // tombstone (e.g. an add that raced ahead of its open) must NOT block a retry.
    const [seen] = await db.select().from(posOfflineSync)
      .where(and(tEq, eq(posOfflineSync.clientUuid, op.client_uuid), eq(posOfflineSync.status, 'synced'))).limit(1);
    if (seen) return { client_uuid: op.client_uuid, op: op.op, status: 'duplicate', order_no: seen.orderNo ?? null, error: null };

    try {
      return await db.transaction(async () => { // SAVEPOINT — one bad op never poisons the batch
        let orderNo: string;
        if (op.op === 'open') {
          const order = await this.dineIn.createOrder({
            table_id: op.table_id, items: op.lines ?? [], guest_count: op.guest_count, fulfillment_type: op.fulfillment_type,
          }, user);
          orderNo = order.order_no;
        } else {
          const resolved = await this.resolveOfflineOrderNo(tenantId, op.order_uuid);
          if (!resolved) throw new BadRequestException({ code: 'OFFLINE_ORDER_NOT_SYNCED', message: 'The offline order this op belongs to has not synced yet', messageTh: 'ออเดอร์ออฟไลน์ยังซิงค์ไม่สำเร็จ' });
          orderNo = resolved;
          if (op.op === 'add') await this.dineIn.addItems(orderNo, { items: op.lines ?? [] }, user);
          else await this.dineIn.fire(orderNo, user, op.course);
        }
        await db.insert(posOfflineSync).values({
          tenantId, clientUuid: op.client_uuid, deviceId: op.device_id ?? null, status: 'synced', opType,
          orderNo, orderUuid: op.order_uuid, saleNo: null, capturedAt: new Date(op.captured_at), clientSeq: op.client_seq ?? null,
          payloadHash: hashDineInOp(op), createdBy: user.username,
        }).onConflictDoUpdate({ target: [posOfflineSync.tenantId, posOfflineSync.clientUuid], set: { status: 'synced', opType, orderNo, orderUuid: op.order_uuid, errorCode: null, errorMessage: null, syncedAt: new Date() } });
        return { client_uuid: op.client_uuid, op: op.op, status: 'synced' as const, order_no: orderNo, error: null };
      });
    } catch (e: any) {
      const code = e?.response?.code ?? e?.code ?? 'SYNC_FAILED';
      // audit the failure in a FRESH savepoint (commits even though the op's savepoint rolled back).
      await db.transaction(async () => {
        await db.insert(posOfflineSync).values({
          tenantId, clientUuid: op.client_uuid, deviceId: op.device_id ?? null, status: 'failed', opType, orderNo: null,
          orderUuid: op.order_uuid, saleNo: null, capturedAt: new Date(op.captured_at), clientSeq: op.client_seq ?? null,
          payloadHash: hashDineInOp(op), errorCode: code, errorMessage: String(e?.response?.message ?? e?.message ?? e), createdBy: user.username,
        }).onConflictDoUpdate({ target: [posOfflineSync.tenantId, posOfflineSync.clientUuid], set: { status: 'failed', opType, orderUuid: op.order_uuid, errorCode: code, errorMessage: String(e?.response?.message ?? e?.message ?? e), attempts: sql`${posOfflineSync.attempts} + 1`, syncedAt: new Date() } });
      }).catch(() => { /* audit is best-effort */ });
      return { client_uuid: op.client_uuid, op: op.op, status: 'failed', order_no: null, error: code };
    }
  }
}

function hashDineInOp(op: DineInOfflineOp): string {
  return createHash('sha256').update(JSON.stringify({ u: op.client_uuid, o: op.order_uuid, op: op.op, l: op.lines ?? [], t: op.table_id ?? null, c: op.captured_at })).digest('hex');
}

function hashOp(op: RegisterOfflineSaleOp): string {
  return createHash('sha256').update(JSON.stringify({ u: op.client_uuid, l: op.lines, d: op.discount_pct ?? 0, c: op.captured_at })).digest('hex');
}
