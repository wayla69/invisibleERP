import { Inject, Injectable } from '@nestjs/common';
import { eq, and, isNotNull, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { posOfflineSync, dineInOrders } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { DineInService } from './dine-in.service';
import { BuffetService } from './buffet.service';

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
}
export interface RegisterOfflineSyncBatchDto { sales: RegisterOfflineSaleOp[] }
export interface SyncResult { client_uuid: string; status: 'synced' | 'duplicate' | 'failed'; sale_no: string | null; error: string | null }

@Injectable()
export class RestaurantOfflineSyncService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly dineIn: DineInService,
    private readonly buffet: BuffetService,
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
        const sale: any = await this.dineIn.checkout(order.order_no, {
          method: op.method ?? 'Cash', discount_pct: op.discount_pct, discount: op.discount, tip: op.tip,
          // manual service charge replays exactly like the register applies it: forced at the given %.
          ...(op.service_charge_pct ? { apply_pricing_rules: true, service_charge_pct: op.service_charge_pct, party_size: 1, service_min_party: 1 } : {}),
        } as any, user);
        await db.insert(posOfflineSync).values({
          tenantId, clientUuid: op.client_uuid, deviceId: op.device_id ?? null, status: 'synced',
          saleNo: sale.sale_no, capturedAt: new Date(op.captured_at), clientSeq: op.client_seq ?? null,
          payloadHash: hashOp(op), createdBy: user.username,
        }).onConflictDoUpdate({ target: [posOfflineSync.tenantId, posOfflineSync.clientUuid], set: { status: 'synced', saleNo: sale.sale_no, errorCode: null, errorMessage: null, syncedAt: new Date() } });
        return { client_uuid: op.client_uuid, status: 'synced' as const, sale_no: sale.sale_no, error: null };
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
}

function hashOp(op: RegisterOfflineSaleOp): string {
  return createHash('sha256').update(JSON.stringify({ u: op.client_uuid, l: op.lines, d: op.discount_pct ?? 0, c: op.captured_at })).digest('hex');
}
