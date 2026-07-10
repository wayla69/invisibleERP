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
import { hostname } from 'node:os';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { buffetPackages, custPosSales, dineInOrders, dineInOrderItems, hubPushLog, tenants } from './schema';

// pseudo item_ids the buffet flow writes for the per-pax charge + overtime surcharge lines
const BUFFET_CHARGE_REF = '__buffet_charge__';
const BUFFET_OVERTIME_REF = '__buffet_overtime__';

export interface HubIngestBatch { tenant_id: number; sent_at: string; sales: any[]; signature: string }
export interface HubIngestResponse { results: { client_uuid: string; status: 'synced' | 'duplicate' | 'failed'; sale_no: string | null; error: string | null }[]; summary: Record<string, number> }
export interface HubPushSummary { collected: number; pushed: number; duplicate: number; failed: number; skipped: number }

// Canonical JSON (recursively key-sorted) so the signature survives any re-serialization on the way —
// the cloud verifies AFTER Zod validation, which rebuilds objects in schema-declaration key order.
function canonicalJson(v: any): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function signHubBatch(tenantId: number, sentAt: string, sales: unknown[], secret: string): string {
  return createHmac('sha256', secret).update(canonicalJson({ tenant_id: tenantId, sent_at: sentAt, sales })).digest('hex');
}

/** Sign any hub→cloud document envelope (till close, heartbeat) — canonical JSON of the whole body. */
export function signHubDoc(body: Record<string, unknown>, secret: string): string {
  return createHmac('sha256', secret).update(canonicalJson(body)).digest('hex');
}

// Phase 2c — the till/Z-report envelope. `sale_nos` are the HUB's sale numbers rung in the session:
// the cloud resolves each through the BRANCH-04 dedup ledger and recomputes expected cash itself.
export interface HubTillDoc {
  session_no: string;
  opened_by?: string; closed_by?: string;
  opened_at: string; closed_at: string;
  opening_float: number; closing_count: number;
  paid_in?: number; paid_out?: number; drops?: number; cash_refunds?: number;
  denominations?: Record<string, number> | null;
  sale_nos: string[];
}

// Phase 2c-2 — waste envelope (BRANCH-06). Kitchen waste posts Dr 5810 / Cr 1200 on the HUB's ledger;
// without this the cloud never sees the expense or the inventory relief, and shrinkage is invisible to HQ.
export interface HubWasteDoc {
  waste_no: string; item_id: string; qty: number; reason_code: string;
  unit_cost?: number; uom?: string; notes?: string;
}

// Phase 2c-2 — stocktake envelope (BRANCH-07). A POSTED count sheet with BOTH humans named: the cloud
// refuses the document unless counted_by and posted_by differ, so SoD R11 survives the machine replay.
export interface HubStocktakeLine { item_id: string; item_description?: string; uom?: string; system_qty: number; physical_qty: number }
export interface HubStocktakeDoc {
  st_no: string; st_date: string; counted_by: string; posted_by: string; remarks?: string;
  lines: HubStocktakeLine[];
}

// Phase 4a — heartbeat payload (liveness + replay backlog; the cloud stamps last_seen + clock skew).
export interface HubHeartbeatDoc {
  hub_id: string; app_version?: string; last_push_at?: string | null;
  pending_sales?: number; pending_tills?: number; failed_docs?: number; skipped_docs?: number;
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
  // `cust_pos_sales.payment_method` is the literal 'Dine-in' for restaurant sales — the TENDER row
  // carries the real method (Cash/Card/PromptPay/…). Replaying with the sale header's value would
  // stamp every cloud tender 'Dine-in', breaking the cash-vs-card split the till reconciliation needs.
  const candidates: any[] = await db.execute(sql`
    SELECT s.sale_no, s.total, s.subtotal, s.discount, s.tip, s.service_charge, s.points_used,
           coalesce(p.method, s.payment_method) AS tender_method
    FROM cust_pos_sales s
    LEFT JOIN hub_push_log l ON l.tenant_id = s.tenant_id AND l.hub_sale_no = s.sale_no AND l.status <> 'failed'
    LEFT JOIN LATERAL (
      SELECT method FROM payments
      WHERE sale_no = s.sale_no AND status IN ('Captured','Refunded')
      ORDER BY id LIMIT 1
    ) p ON true
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

    // buffet-tier sale (Phase 2b): replay as a package_code + pax op — the CLOUD re-prices the charge
    // from its own package master. ฿0 buffet food lines carry no revenue and are not replayed.
    let buffet: { package_code: string; pax: number; overtime_pax?: number } | undefined;
    const chargeLine = items.find((l) => l.itemId === BUFFET_CHARGE_REF);
    const overtimeLine = items.find((l) => l.itemId === BUFFET_OVERTIME_REF);
    if (items.some((l) => l.isBuffet || l.buffetPackageId != null)) {
      if (!chargeLine?.buffetPackageId) { await skip('BUFFET_WITHOUT_CHARGE_LINE — no per-pax charge to replay'); continue; }
      const [pkg] = await db.select().from(buffetPackages).where(eq(buffetPackages.id, Number(chargeLine.buffetPackageId))).limit(1);
      if (!pkg) { await skip('BUFFET_PACKAGE_MISSING_ON_HUB — cannot resolve the tier code'); continue; }
      buffet = { package_code: String(pkg.code), pax: num(chargeLine.qty), ...(overtimeLine ? { overtime_pax: num(overtimeLine.qty) } : {}) };
    }
    // regular priced lines: everything that is not buffet food (฿0) and not a charge/overtime pseudo line
    const skuLines = items.filter((l) => !l.isBuffet && l.buffetPackageId == null);
    if (skuLines.some((l) => !l.itemId)) { await skip('LINE_WITHOUT_SKU — custom/unlinked line cannot be re-priced by the cloud'); continue; }
    if (!skuLines.length && !buffet) { await skip('NO_LINES'); continue; }

    const subtotal = num(s.subtotal), discount = num(s.discount), sc = num(s.service_charge), tip = num(s.tip);
    const netBase = subtotal - discount;
    const op = {
      client_uuid: clientUuid,
      device_id: 'HUB',
      // the moment the sale was actually rung on the hub — `dine_in_orders` has openedAt/paidAt (NOT
      // createdAt): reading a non-existent column silently stamped every replay with the PUSH time,
      // which would book an offline day's sales on the sync day.
      captured_at: new Date(order.paidAt ?? order.openedAt ?? Date.now()).toISOString(),
      lines: skuLines.map((l) => ({ sku: String(l.itemId), qty: num(l.qty), modifier_option_ids: modifierIds(l.modifiers), notes: l.notes ?? undefined })),
      ...(buffet ? { buffet } : {}),
      method: s.tender_method && s.tender_method !== 'Dine-in' ? String(s.tender_method) : 'Cash',
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

export interface HubTillPushSummary { collected: number; pushed: number; duplicate: number; blocked: number; failed: number }

/**
 * Phase 2c — push CLOSED till sessions (Z-report envelopes) to the cloud (control BRANCH-05).
 *
 * The session's sale population is derived from the dine-in orders opened inside the session window
 * (restaurant hubs settle through the order→checkout path, which writes no `payments` tender — see
 * PN-24 §7 6d). The cloud resolves every listed hub sale through the BRANCH-04 dedup ledger, so a
 * session is deliberately BLOCKED (`TILL_SALES_NOT_SYNCED`) until its sales have all replayed: a
 * variance must never be certified over an incomplete revenue population. Run AFTER pushHubSales.
 */
export async function pushHubTills(
  db: any,
  tenantId: number,
  deps: { secret: string; sendTill: (body: { tenant_id: number; sent_at: string; till: HubTillDoc; signature: string }) => Promise<any>; sentAt?: string },
): Promise<HubTillPushSummary> {
  const sessions: any[] = await db.execute(sql`
    SELECT s.session_no, s.opened_by, s.closed_by, s.opened_at, s.closed_at, s.opening_float, s.closing_count, s.denominations
    FROM till_sessions s
    LEFT JOIN hub_push_log l ON l.tenant_id = s.tenant_id AND l.hub_sale_no = s.session_no AND l.status <> 'failed'
    WHERE s.tenant_id = ${tenantId} AND s.status = 'Closed' AND l.id IS NULL
    ORDER BY s.id`).then((r: any) => r.rows ?? r);

  const summary: HubTillPushSummary = { collected: sessions.length, pushed: 0, duplicate: 0, blocked: 0, failed: 0 };
  if (!sessions.length) return summary;

  const logRow = async (row: Record<string, any>) => {
    await db.insert(hubPushLog).values({ tenantId, docType: 'till', attempts: 1, ...row })
      .onConflictDoUpdate({ target: [hubPushLog.tenantId, hubPushLog.hubSaleNo], set: { ...row, docType: 'till', attempts: sql`${hubPushLog.attempts} + 1`, pushedAt: new Date() } });
  };

  for (const s of sessions) {
    const sessionNo = String(s.session_no);
    const clientUuid = `hub:${tenantId}:${sessionNo}`;
    // membership is by SETTLEMENT time (paid_at) — that is when the cash entered this drawer.
    const saleRows: any[] = await db.execute(sql`
      SELECT DISTINCT o.sale_no FROM dine_in_orders o
      WHERE o.tenant_id = ${tenantId} AND o.sale_no IS NOT NULL
        AND coalesce(o.paid_at, o.opened_at) >= ${s.opened_at}
        AND coalesce(o.paid_at, o.opened_at) <= ${s.closed_at}`).then((r: any) => r.rows ?? r);
    const saleNos = saleRows.map((r) => String(r.sale_no));

    const till: HubTillDoc = {
      session_no: sessionNo,
      opened_by: s.opened_by ?? undefined, closed_by: s.closed_by ?? undefined,
      opened_at: new Date(s.opened_at).toISOString(), closed_at: new Date(s.closed_at).toISOString(),
      opening_float: num(s.opening_float), closing_count: num(s.closing_count),
      denominations: s.denominations ?? null,
      sale_nos: saleNos,
    };
    const sentAt = deps.sentAt ?? new Date().toISOString();
    const body = { tenant_id: tenantId, sent_at: sentAt, till, signature: signHubDoc({ tenant_id: tenantId, sent_at: sentAt, till }, deps.secret) };
    try {
      const res = await deps.sendTill(body);
      const dup = res?.status === 'duplicate';
      summary[dup ? 'duplicate' : 'pushed']++;
      await logRow({ hubSaleNo: sessionNo, clientUuid, status: dup ? 'duplicate' : 'pushed', hubTotal: String(num(s.closing_count).toFixed(2)), errorCode: null, errorMessage: null });
    } catch (e: any) {
      const code = String(e?.code ?? e?.message ?? 'TILL_PUSH_FAILED');
      // A blocked session is NOT a failure to retry blindly: its sales must be reconciled first.
      if (code.includes('TILL_SALES_NOT_SYNCED')) summary.blocked++; else summary.failed++;
      await logRow({ hubSaleNo: sessionNo, clientUuid, status: 'failed', hubTotal: String(num(s.closing_count).toFixed(2)), errorCode: code, errorMessage: String(e?.message ?? e) });
    }
  }
  return summary;
}

export interface HubWastePushSummary { collected: number; pushed: number; duplicate: number; failed: number }

/**
 * Phase 2c-2 — push kitchen WASTE documents to the cloud (control BRANCH-06). The hub's `waste_no` is
 * reused verbatim as the document identity on both ledgers, so a re-push is a `duplicate` (the cloud
 * returns the stored row and neither decrements stock nor posts GL again). Run after the sales.
 */
export async function pushHubWaste(
  db: any,
  tenantId: number,
  deps: { secret: string; sendWaste: (body: { tenant_id: number; sent_at: string; waste: HubWasteDoc; signature: string }) => Promise<any>; sentAt?: string },
): Promise<HubWastePushSummary> {
  const rows: any[] = await db.execute(sql`
    SELECT w.waste_no, w.item_id, w.qty, w.reason_code, w.unit_cost, w.uom, w.notes
    FROM waste_log w
    LEFT JOIN hub_push_log l ON l.tenant_id = w.tenant_id AND l.hub_sale_no = w.waste_no AND l.status <> 'failed'
    WHERE w.tenant_id = ${tenantId} AND l.id IS NULL
    ORDER BY w.id`).then((r: any) => r.rows ?? r);

  const summary: HubWastePushSummary = { collected: rows.length, pushed: 0, duplicate: 0, failed: 0 };
  if (!rows.length) return summary;

  const logRow = async (row: Record<string, any>) => {
    await db.insert(hubPushLog).values({ tenantId, docType: 'waste', attempts: 1, ...row })
      .onConflictDoUpdate({ target: [hubPushLog.tenantId, hubPushLog.hubSaleNo], set: { ...row, docType: 'waste', attempts: sql`${hubPushLog.attempts} + 1`, pushedAt: new Date() } });
  };

  for (const w of rows) {
    const wasteNo = String(w.waste_no);
    const clientUuid = `hub:${tenantId}:${wasteNo}`;
    const waste: HubWasteDoc = {
      waste_no: wasteNo, item_id: String(w.item_id), qty: num(w.qty), reason_code: String(w.reason_code),
      unit_cost: num(w.unit_cost), uom: w.uom ?? undefined, notes: w.notes ?? undefined,
    };
    const sentAt = deps.sentAt ?? new Date().toISOString();
    const body = { tenant_id: tenantId, sent_at: sentAt, waste, signature: signHubDoc({ tenant_id: tenantId, sent_at: sentAt, waste }, deps.secret) };
    try {
      const res = await deps.sendWaste(body);
      const dup = res?.duplicate === true;
      summary[dup ? 'duplicate' : 'pushed']++;
      await logRow({ hubSaleNo: wasteNo, clientUuid, status: dup ? 'duplicate' : 'pushed', hubTotal: String(num(w.unit_cost * 0 + num(w.qty) * num(w.unit_cost)).toFixed(2)), errorCode: null, errorMessage: null });
    } catch (e: any) {
      summary.failed++;
      await logRow({ hubSaleNo: wasteNo, clientUuid, status: 'failed', errorCode: String(e?.code ?? e?.message ?? 'WASTE_PUSH_FAILED'), errorMessage: String(e?.message ?? e) });
    }
  }

  return summary;
}

export interface HubStocktakePushSummary { collected: number; pushed: number; duplicate: number; blocked: number; failed: number }

/**
 * Phase 2c-2 — push POSTED stocktakes (BRANCH-07). Draft sheets are NOT pushed: a count only becomes
 * evidence once an independent reviewer has posted its variance (SoD R11), and the cloud re-checks that
 * the two names differ. A sheet whose poster equals its counter is BLOCKED, not silently accepted.
 */
export async function pushHubStocktakes(
  db: any,
  tenantId: number,
  deps: { secret: string; sendStocktake: (body: { tenant_id: number; sent_at: string; stocktake: HubStocktakeDoc; signature: string }) => Promise<any>; sentAt?: string },
): Promise<HubStocktakePushSummary> {
  const rows: any[] = await db.execute(sql`
    SELECT st_no, min(st_date) AS st_date, min(counted_by) AS counted_by, min(posted_by) AS posted_by, min(remarks) AS remarks
    FROM stocktakes s
    WHERE s.tenant_id = ${tenantId} AND s.status = 'Posted'
      AND NOT EXISTS (SELECT 1 FROM hub_push_log l WHERE l.tenant_id = s.tenant_id AND l.hub_sale_no = s.st_no AND l.status <> 'failed')
    GROUP BY st_no ORDER BY st_no`).then((r: any) => r.rows ?? r);

  const summary: HubStocktakePushSummary = { collected: rows.length, pushed: 0, duplicate: 0, blocked: 0, failed: 0 };
  if (!rows.length) return summary;

  const logRow = async (row: Record<string, any>) => {
    await db.insert(hubPushLog).values({ tenantId, docType: 'stocktake', attempts: 1, ...row })
      .onConflictDoUpdate({ target: [hubPushLog.tenantId, hubPushLog.hubSaleNo], set: { ...row, docType: 'stocktake', attempts: sql`${hubPushLog.attempts} + 1`, pushedAt: new Date() } });
  };

  for (const st of rows) {
    const stNo = String(st.st_no);
    const clientUuid = `hub:${tenantId}:${stNo}`;
    const lineRows: any[] = await db.execute(sql`
      SELECT item_id, item_description, uom, system_qty, physical_qty FROM stocktakes
      WHERE tenant_id = ${tenantId} AND st_no = ${stNo} ORDER BY id`).then((r: any) => r.rows ?? r);
    const stocktake: HubStocktakeDoc = {
      st_no: stNo, st_date: String(st.st_date), counted_by: String(st.counted_by ?? ''), posted_by: String(st.posted_by ?? ''),
      remarks: st.remarks ?? undefined,
      lines: lineRows.map((l) => ({ item_id: String(l.item_id), item_description: l.item_description ?? undefined, uom: l.uom ?? undefined, system_qty: num(l.system_qty), physical_qty: num(l.physical_qty) })),
    };
    const sentAt = deps.sentAt ?? new Date().toISOString();
    const body = { tenant_id: tenantId, sent_at: sentAt, stocktake, signature: signHubDoc({ tenant_id: tenantId, sent_at: sentAt, stocktake }, deps.secret) };
    try {
      const res = await deps.sendStocktake(body);
      const dup = res?.duplicate === true;
      summary[dup ? 'duplicate' : 'pushed']++;
      await logRow({ hubSaleNo: stNo, clientUuid, status: dup ? 'duplicate' : 'pushed', errorCode: null, errorMessage: null });
    } catch (e: any) {
      const code = String(e?.code ?? e?.message ?? 'STOCKTAKE_PUSH_FAILED');
      if (code.includes('SOD') || code.includes('STOCKTAKE_NOT_SEGREGATED')) summary.blocked++; else summary.failed++;
      await logRow({ hubSaleNo: stNo, clientUuid, status: 'failed', errorCode: code, errorMessage: String(e?.message ?? e) });
    }
  }
  return summary;
}

/** Phase 4a — report liveness + replay backlog to the cloud (fleet visibility). */
export async function sendHubHeartbeat(
  db: any,
  tenantId: number,
  deps: { secret: string; hubId: string; appVersion?: string; sendHeartbeat: (body: { tenant_id: number; sent_at: string; hub: HubHeartbeatDoc; signature: string }) => Promise<any>; sentAt?: string },
): Promise<HubHeartbeatDoc & { advice: any }> {
  const one = async (q: any) => Number(((await db.execute(q).then((r: any) => r.rows ?? r))[0] ?? {}).n ?? 0);
  const pendingSales = await one(sql`
    SELECT count(*)::int n FROM cust_pos_sales s
    LEFT JOIN hub_push_log l ON l.tenant_id = s.tenant_id AND l.hub_sale_no = s.sale_no AND l.status <> 'failed'
    WHERE s.tenant_id = ${tenantId} AND s.status = 'Completed' AND l.id IS NULL`);
  const pendingTills = await one(sql`
    SELECT count(*)::int n FROM till_sessions s
    LEFT JOIN hub_push_log l ON l.tenant_id = s.tenant_id AND l.hub_sale_no = s.session_no AND l.status <> 'failed'
    WHERE s.tenant_id = ${tenantId} AND s.status = 'Closed' AND l.id IS NULL`);
  const failedDocs = await one(sql`SELECT count(*)::int n FROM hub_push_log WHERE tenant_id = ${tenantId} AND status = 'failed'`);
  const skippedDocs = await one(sql`SELECT count(*)::int n FROM hub_push_log WHERE tenant_id = ${tenantId} AND status = 'skipped_unsupported'`);
  const lastPush: any[] = await db.execute(sql`SELECT max(pushed_at) AS t FROM hub_push_log WHERE tenant_id = ${tenantId} AND status IN ('pushed','duplicate')`).then((r: any) => r.rows ?? r);

  const hub: HubHeartbeatDoc = {
    hub_id: deps.hubId, app_version: deps.appVersion,
    last_push_at: lastPush[0]?.t ? new Date(lastPush[0].t).toISOString() : null,
    pending_sales: pendingSales, pending_tills: pendingTills, failed_docs: failedDocs, skipped_docs: skippedDocs,
  };
  const sentAt = deps.sentAt ?? new Date().toISOString();
  // Phase 4c: the cloud answers with its own version + advice — the heartbeat IS the update channel.
  const advice = await deps.sendHeartbeat({ tenant_id: tenantId, sent_at: sentAt, hub, signature: signHubDoc({ tenant_id: tenantId, sent_at: sentAt, hub }, deps.secret) });
  return { ...hub, advice: advice ?? null };
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
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${cloud}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error?.code ?? `HTTP ${res.status}`);
      return json;
    };
    const send = (batch: HubIngestBatch): Promise<HubIngestResponse> => post('/api/hub/ingest', batch);

    // sales first — a till can only be certified once ALL of its sales are on the cloud (BRANCH-05)
    const sum = await pushHubSales(db, tenantId, { secret, send });
    console.log(`✅ hub push — sales collected ${sum.collected}: pushed ${sum.pushed}, duplicate ${sum.duplicate}, failed ${sum.failed}, skipped ${sum.skipped}`);
    if (sum.skipped) console.log('   ⚠ skipped sales are recorded in hub_push_log (status skipped_unsupported) — review per BRANCH-04');

    const waste = await pushHubWaste(db, tenantId, { secret, sendWaste: (b) => post('/api/hub/ingest-waste', b) });
    if (waste.collected) console.log(`✅ hub push — waste collected ${waste.collected}: pushed ${waste.pushed}, duplicate ${waste.duplicate}, failed ${waste.failed}`);
    const counts = await pushHubStocktakes(db, tenantId, { secret, sendStocktake: (b) => post('/api/hub/ingest-stocktake', b) });
    if (counts.collected) {
      console.log(`✅ hub push — stocktakes collected ${counts.collected}: pushed ${counts.pushed}, duplicate ${counts.duplicate}, blocked ${counts.blocked}, failed ${counts.failed}`);
      if (counts.blocked) console.log('   ⚠ blocked: the counter also posted the sheet — SoD R11 requires an independent reviewer (fix on the hub, then re-run)');
    }

    const tills = await pushHubTills(db, tenantId, { secret, sendTill: (b) => post('/api/hub/ingest-till', b) });
    if (tills.collected) {
      console.log(`✅ hub push — tills collected ${tills.collected}: pushed ${tills.pushed}, duplicate ${tills.duplicate}, blocked ${tills.blocked}, failed ${tills.failed}`);
      if (tills.blocked) console.log('   ⚠ blocked tills: their sales have not all replayed — resolve the skipped/failed sales, then re-run (BRANCH-05)');
    }

    const hb = await sendHubHeartbeat(db, tenantId, {
      secret, hubId: process.env.HUB_ID || hostname(), appVersion: process.env.APP_VERSION,
      sendHeartbeat: (b) => post('/api/hub/heartbeat', b),
    }).catch((e) => { console.log(`   ⚠ heartbeat failed: ${e.message ?? e}`); return null; });

    const advice = hb?.advice;
    if (advice?.version_status === 'behind') {
      console.log(`⬆ update available — the cloud runs ${advice.cloud_version}, this hub runs ${process.env.APP_VERSION}. Upgrade after close (runbook §8).`);
    } else if (advice?.version_status === 'ahead') {
      console.log(`⚠ THIS HUB IS AHEAD OF THE CLOUD (hub ${process.env.APP_VERSION} > cloud ${advice.cloud_version}). Upgrade the CLOUD first — a hub ahead can send fields the cloud rejects.`);
    }

    process.exit(sum.failed || tills.failed || waste.failed || counts.failed ? 1 : 0);
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('❌ hub push failed:', e.message ?? e); process.exit(1); });
}
