import { Inject, Injectable } from '@nestjs/common';
import { eq, and, isNotNull, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { posOfflineSync } from '../../database/schema';
import { ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { PortalService } from './portal.service';
import { PortalPosService } from './portal.pos.service';

export interface OfflineSaleOp {
  client_uuid: string;
  branch_id?: number;             // multi-branch: outlet that queued this offline sale
  device_id?: string;
  client_seq?: number;
  captured_at: string;            // ISO — preserved verbatim
  lines: { item_id: string; item_description?: string; qty: number; unit_price: number; uom?: string; discount_pct?: number }[];
  discount?: number;
  payment_method?: string;
}
export interface OfflineSyncBatchDto { sales: OfflineSaleOp[] }
export interface SyncResult { client_uuid: string; status: 'synced' | 'duplicate' | 'failed'; sale_no: string | null; error: string | null }

// Replay offline-queued sales idempotently. Each op runs in its OWN savepoint (nested db.transaction →
// SAVEPOINT under the request tx): a thrown error rolls back to that savepoint only, so one bad sale
// never poisons the rest of the batch, and the request's final COMMIT persists every good sale.
@Injectable()
export class OfflineSyncService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly portal: PortalService,
    private readonly portalPos: PortalPosService,
  ) {}

  async syncBatch(dto: OfflineSyncBatchDto, user: JwtUser) {
    const t = await this.portal.tenantId(user);
    const ops = [...dto.sales].sort((a, b) => (a.client_seq ?? 0) - (b.client_seq ?? 0)); // sequence integrity
    const results: SyncResult[] = [];
    for (const op of ops) results.push(await this.syncOne(t, op, user));
    const summary = { synced: 0, duplicate: 0, failed: 0 } as Record<string, number>;
    for (const r of results) summary[r.status]++;
    return { results, summary };
  }

  private async syncOne(t: { id: number; code: string }, op: OfflineSaleOp, user: JwtUser): Promise<SyncResult> {
    const db = this.db as any;
    // 1. dedup gate — short-circuit ONLY on a genuinely-completed sale (sale_no set). A prior 'failed'
    //    tombstone (e.g. transient PERIOD_CLOSED) must NOT block a retry, so we require sale_no IS NOT NULL.
    const [seen] = await db.select().from(posOfflineSync)
      .where(and(eq(posOfflineSync.tenantId, t.id), eq(posOfflineSync.clientUuid, op.client_uuid), isNotNull(posOfflineSync.saleNo))).limit(1);
    if (seen) return { client_uuid: op.client_uuid, status: 'duplicate', sale_no: seen.saleNo ?? null, error: null };

    const saleDate = ymd(new Date(op.captured_at)); // book on the offline day
    try {
      return await db.transaction(async () => { // SAVEPOINT — rolls back to here on throw, outer tx survives
        const sale: any = await this.portalPos.createSale(
          { items: op.lines, discount: op.discount, payment_method: op.payment_method ?? 'Cash', notes: `offline ${op.device_id ?? ''}`.trim() },
          user,
          { saleDate, branchId: op.branch_id },
        );
        // upsert so a retry of a previously-'failed' op is PROMOTED to 'synced' (the unique key is (tenant,uuid))
        await db.insert(posOfflineSync).values({
          tenantId: t.id, clientUuid: op.client_uuid, branchId: op.branch_id ?? null, deviceId: op.device_id ?? null, status: 'synced',
          saleNo: sale.sale_no, capturedAt: new Date(op.captured_at), clientSeq: op.client_seq ?? null,
          payloadHash: hashOp(op), createdBy: user.username,
        }).onConflictDoUpdate({ target: [posOfflineSync.tenantId, posOfflineSync.clientUuid], set: { status: 'synced', saleNo: sale.sale_no, branchId: op.branch_id ?? null, errorCode: null, errorMessage: null, syncedAt: new Date() } });
        return { client_uuid: op.client_uuid, status: 'synced' as const, sale_no: sale.sale_no, error: null };
      });
    } catch (e: any) {
      const code = e?.response?.code ?? e?.code ?? 'SYNC_FAILED';
      // audit the failure in a FRESH savepoint so it commits even though the sale's savepoint rolled back.
      // Upsert (not DoNothing) so repeated transient failures bump attempts + keep the row replayable.
      await db.transaction(async () => {
        await db.insert(posOfflineSync).values({
          tenantId: t.id, clientUuid: op.client_uuid, branchId: op.branch_id ?? null, deviceId: op.device_id ?? null, status: 'failed', saleNo: null,
          capturedAt: new Date(op.captured_at), clientSeq: op.client_seq ?? null, payloadHash: hashOp(op),
          errorCode: code, errorMessage: String(e?.response?.message ?? e?.message ?? e), createdBy: user.username,
        }).onConflictDoUpdate({ target: [posOfflineSync.tenantId, posOfflineSync.clientUuid], set: { status: 'failed', errorCode: code, errorMessage: String(e?.response?.message ?? e?.message ?? e), attempts: sql`${posOfflineSync.attempts} + 1`, syncedAt: new Date() } });
      }).catch(() => { /* audit is best-effort */ });
      return { client_uuid: op.client_uuid, status: 'failed', sale_no: null, error: code };
    }
  }
}

function hashOp(op: OfflineSaleOp): string {
  return createHash('sha256').update(JSON.stringify({ u: op.client_uuid, l: op.lines, d: op.discount ?? 0, c: op.captured_at })).digest('hex');
}
