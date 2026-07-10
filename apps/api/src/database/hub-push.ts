// Store-hub → cloud sales push (docs/41 Phase 2a, control BRANCH-04).
//
// Runs ON THE HUB. Collects hub-captured restaurant sales that have not yet reached the cloud,
// reconstructs each as a register offline-sync op (lines + modifiers from the originating dine-in
// order, discount/tip/service-charge from the sale header), signs the batch with HUB_SYNC_SECRET and
// POSTs it to the cloud's `POST /api/hub/ingest` — which replays through the same idempotent
// order→checkout path (dedup on (tenant, client_uuid); the cloud re-prices authoritatively and posts
// GL on the CLOUD ledger, the book of record).
//
// Exactly-once mechanics: the client_uuid is DETERMINISTIC (`hub:{tenant}:{hub_sale_no}`), so any
// re-push of the same sale — crash mid-run, double cron, replayed batch — lands as 'duplicate'.
// Every outcome is recorded in hub_push_log; a sale the pusher cannot faithfully replay (buffet
// session, loyalty redemption, no order linkage e.g. portal/split path) is logged
// 'skipped_unsupported' WITH its reason — visible to the BRANCH-04 reconciliation review, never a
// silent drop.
//
// CLI (on the hub box):  pnpm --filter @ierp/api db:hub:push
//   env: DATABASE_URL (hub DB), HUB_SYNC_SECRET (must match the cloud), CLOUD_URL
//   (e.g. https://erp.example.com), optional HUB_TENANT_ID when the hub DB holds >1 tenant.
//
// The core is exported over a drizzle instance + injectable send() so the `hub-snapshot` cutover
// harness proves the full hub→cloud round-trip on two PGlites.
import { createHmac } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { custPosSales, dineInOrders, dineInOrderItems, hubPushLog, tenants } from './schema';

export interface HubIngestBatch { tenant_id: number; sent_at: string; sales: any[]; signature: string }
export interface HubIngestResponse { results: { client_uuid: string; status: 'synced' | 'duplicate' | 'failed'; sale_no: string | null; error: string | null }[]; summary: Record<string, number> }
export interface HubPushSummary { collected: number; pushed: number; duplicate: number; failed: number; skipped: number }

export function signHubBatch(tenantId: number, sentAt: string, sales: unknown[], secret: string): string {
  return createHmac('sha256', secret).update(JSON.stringify({ tenant_id: tenantId, sent_at: sentAt, sales })).digest('hex');
}

const num = (v: any) => (v == null ? 0 : Number(v));

// modifier jsonb tolerance: [{option_id|id, ...}] → number[] (anything unshaped ⇒ no modifiers)
function modifierIds(m: any): number[] | undefined {
  if (!Array.isArray(m)) return undefined;
  const ids = m.map((o: any) => Number(o?.option_id ?? o?.id)).filter((x: any) => Number.isFinite(x) && x > 0);
  return ids.length ? ids : undefined;
}

export async function pushHubSales(
  db: any,
  tenantId: number,
  deps: { secret: string; send: (batch: HubIngestBatch) => Promise<HubIngestResponse>; sentAt?: string },
): Promise<HubPushSummary> {
  // candidates: completed hub sales with no terminal push-log row ('failed' rows are retried)
  const candidates: any[] = await db.execute(sql`
    SELECT s.sale_no, s.total, s.subtotal, s.discount, s.tip, s.service_charge, s.payment_method, s.points_used
    FROM cust_pos_sales s
    LEFT JOIN hub_push_log l ON l.tenant_id = s.tenant_id AND l.hub_sale_no = s.sale_no AND l.status <> 'failed'
    WHERE s.tenant_id = ${tenantId} AND s.status = 'Completed' AND l.id IS NULL
    ORDER BY s.id`).then((r: any) => r.rows ?? r);

  const summary: HubPushSummary = { collected: candidates.length, pushed: 0, duplicate: 0, failed: 0, skipped: 0 };
  if (!candidates.length) return summary;

  const logRow = async (row: Record<string, any>) => {
    await db.insert(hubPushLog).values({ tenantId, attempts: 1, ...row })
      .onConflictDoUpdate({ target: [hubPushLog.tenantId, hubPushLog.hubSaleNo], set: { ...row, attempts: sql`${hubPushLog.attempts} + 1`, pushedAt: new Date() } });
  };

  const ops: any[] = [];
  const bySale = new Map<string, any>();
  for (const s of candidates) {
    const saleNo = String(s.sale_no);
    const clientUuid = `hub:${tenantId}:${saleNo}`;
    const skip = async (reason: string) => {
      summary.skipped++;
      await logRow({ hubSaleNo: saleNo, clientUuid, status: 'skipped_unsupported', hubTotal: String(num(s.total).toFixed(2)), skipReason: reason });
    };
    if (num(s.points_used) > 0) { await skip('LOYALTY_REDEEM — points were redeemed on the hub; reconcile manually'); continue; }
    const [order] = await db.select().from(dineInOrders).where(and(eq(dineInOrders.tenantId, tenantId), eq(dineInOrders.saleNo, saleNo))).limit(1);
    if (!order) { await skip('NO_ORDER_LINK — not a restaurant order→checkout sale (portal/split path)'); continue; }
    const items: any[] = await db.select().from(dineInOrderItems)
      .where(and(eq(dineInOrderItems.orderId, Number(order.id)), isNull(dineInOrderItems.voidedAt)));
    if (items.some((l) => l.isBuffet || l.buffetPackageId != null)) { await skip('BUFFET_SALE — per-pax tier pricing does not replay through the a-la-carte path'); continue; }
    if (items.some((l) => !l.itemId)) { await skip('LINE_WITHOUT_SKU — custom/unlinked line cannot be re-priced by the cloud'); continue; }
    if (!items.length) { await skip('NO_LINES'); continue; }

    const subtotal = num(s.subtotal), discount = num(s.discount), sc = num(s.service_charge), tip = num(s.tip);
    const netBase = subtotal - discount;
    const op = {
      client_uuid: clientUuid,
      device_id: 'HUB',
      captured_at: (order.createdAt instanceof Date ? order.createdAt : new Date(order.createdAt ?? Date.now())).toISOString(),
      lines: items.map((l) => ({ sku: String(l.itemId), qty: num(l.qty), modifier_option_ids: modifierIds(l.modifiers), notes: l.notes ?? undefined })),
      method: s.payment_method ?? 'Cash',
      ...(discount > 0 ? { discount } : {}),
      ...(tip > 0 ? { tip } : {}),
      // checkout computes SC as pct × (subtotal − discount); invert that so the cloud re-derives the
      // same amount (± satang rounding — the BRANCH-04 report surfaces any drift vs hub_total).
      ...(sc > 0 && netBase > 0 ? { service_charge_pct: Math.round((sc / netBase) * 1e6) / 1e4 } : {}),
    };
    ops.push(op);
    bySale.set(clientUuid, s);
  }

  if (ops.length) {
    const sentAt = deps.sentAt ?? new Date().toISOString();
    const batch: HubIngestBatch = { tenant_id: tenantId, sent_at: sentAt, sales: ops, signature: signHubBatch(tenantId, sentAt, ops, deps.secret) };
    const res = await deps.send(batch);
    for (const r of res.results ?? []) {
      const s = bySale.get(r.client_uuid);
      const saleNo = String(r.client_uuid).split(':')[2] ?? '';
      if (r.status === 'synced' || r.status === 'duplicate') {
        summary[r.status === 'synced' ? 'pushed' : 'duplicate']++;
        await logRow({ hubSaleNo: saleNo, clientUuid: r.client_uuid, status: r.status === 'synced' ? 'pushed' : 'duplicate', cloudSaleNo: r.sale_no, hubTotal: s ? String(num(s.total).toFixed(2)) : null, errorCode: null, errorMessage: null });
      } else {
        summary.failed++;
        await logRow({ hubSaleNo: saleNo, clientUuid: r.client_uuid, status: 'failed', hubTotal: s ? String(num(s.total).toFixed(2)) : null, errorCode: r.error ?? 'SYNC_FAILED', errorMessage: r.error ?? null });
      }
    }
  }
  return summary;
}

// ── CLI ──
async function main() {
  const url = process.env.DATABASE_URL;
  const secret = process.env.HUB_SYNC_SECRET;
  const cloud = (process.env.CLOUD_URL ?? '').replace(/\/+$/, '');
  if (!url || !secret || !cloud) {
    console.error('DATABASE_URL, HUB_SYNC_SECRET and CLOUD_URL are required');
    process.exit(2);
  }
  const [{ default: postgres }, { drizzle }] = await Promise.all([import('postgres'), import('drizzle-orm/postgres-js')]);
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  try {
    let tenantId = process.env.HUB_TENANT_ID ? Number(process.env.HUB_TENANT_ID) : null;
    if (!tenantId) {
      const rows = await db.select().from(tenants);
      if (rows.length !== 1) { console.error(`hub DB holds ${rows.length} tenants — set HUB_TENANT_ID`); process.exit(2); }
      tenantId = Number(rows[0]!.id);
    }
    const send = async (batch: HubIngestBatch): Promise<HubIngestResponse> => {
      const res = await fetch(`${cloud}/api/hub/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error?.code ?? `HTTP ${res.status}`);
      return json;
    };
    const sum = await pushHubSales(db, tenantId, { secret, send });
    console.log(`✅ hub push — collected ${sum.collected}: pushed ${sum.pushed}, duplicate ${sum.duplicate}, failed ${sum.failed}, skipped ${sum.skipped}`);
    if (sum.skipped) console.log('   ⚠ skipped sales are recorded in hub_push_log (status skipped_unsupported) — review per BRANCH-04');
    process.exit(sum.failed ? 1 : 0);
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('❌ hub push failed:', e.message ?? e); process.exit(1); });
}
