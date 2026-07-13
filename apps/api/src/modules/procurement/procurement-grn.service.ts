import { BadRequestException, NotFoundException, ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { purchaseOrders, poItems, goodsReceipts, grItems, stockMovements, lotLedger, items, vendors, tenants, receivingSettings } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import { CostingService } from '../costing/costing.service';
import { CommitmentsService } from '../commitments/commitments.service';
import { GrPdfService, type GrPrintData } from './gr-pdf.service';
import { DocEmailService } from '../mail/doc-email.service';
import { sellerParty } from '../../common/doc-party';
import { n, type CreateGrDto } from './procurement.shared';
import { ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// GRN sub-service (docs/38 §3 procurement decomposition, PR-2): goods receiving — createGr (EXP-03
// approval gate + costing capitalization + commitment consumption + stock/lot ledgers), the receive
// conveniences, the printable/email GR note and the register — moved VERBATIM. A PLAIN class constructed
// in the ProcurementService ctor BODY (the goldenmaster/writeflow harnesses construct the facade
// positionally with 3 args, so sub-services must always exist regardless of construction path). The one
// shared helper (notifyPoPrRequesters — D2 LINE notify) is injected as a callback port.
// Weight-basis UoMs (EXP-12): a supplier delivering by weight legitimately varies a little, so only these
// UoMs may over-receive — and only within receiving_settings.over_receipt_weight_pct of the ordered qty.
// Every other UoM (pieces, boxes, …) is hard-capped at the ordered qty.
const WEIGHT_UOMS = new Set(['kg', 'กก.', 'กก', 'กิโลกรัม', 'kilogram', 'g', 'กรัม', 'gram', 'ton', 'ตัน', 'tonne', 'lb', 'ปอนด์']);
export const isWeightUom = (uom?: string | null): boolean => WEIGHT_UOMS.has(String(uom ?? '').trim().toLowerCase());

export class ProcurementGrnService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly statusLog: StatusLogService,
    private readonly notifyRequesters: (poNo: string, message: string) => Promise<void>,
    private readonly costing?: CostingService,
    private readonly commitments?: CommitmentsService,
    private readonly grPdf?: GrPdfService,
    private readonly docEmail?: DocEmailService,
  ) {}

  // ── Receiving tolerances (EXP-12) ── tenant-scoped read with defaults, mirroring the 3-way-match
  // tolerance pattern (never RLS+limit(1) — an Admin/HQ request bypasses RLS).
  async getReceivingSettings(tenantId?: number | null): Promise<{ overReceiptWeightPct: number; claimWindowHours: number }> {
    const db = this.db;
    const [s] = tenantId != null
      ? await db.select().from(receivingSettings).where(eq(receivingSettings.tenantId, tenantId)).limit(1)
      : await db.select().from(receivingSettings).where(isNull(receivingSettings.tenantId)).limit(1);
    return { overReceiptWeightPct: s ? n(s.overReceiptWeightPct) : 5, claimWindowHours: s ? Number(s.claimWindowHours) : 24 };
  }

  async setReceivingSettings(dto: { over_receipt_weight_pct?: number; claim_window_hours?: number }, user: JwtUser) {
    const db = this.db;
    if (dto.over_receipt_weight_pct != null && (dto.over_receipt_weight_pct < 0 || dto.over_receipt_weight_pct > 100)) {
      throw new BadRequestException({ code: 'BAD_PCT', message: 'over_receipt_weight_pct must be 0–100', messageTh: 'เปอร์เซ็นต์รับเกินต้องอยู่ระหว่าง 0–100' });
    }
    if (dto.claim_window_hours != null && (!Number.isInteger(dto.claim_window_hours) || dto.claim_window_hours < 1)) {
      throw new BadRequestException({ code: 'BAD_HOURS', message: 'claim_window_hours must be a positive integer', messageTh: 'ชั่วโมงแจ้งเคลมต้องเป็นจำนวนเต็มบวก' });
    }
    const [ex] = await db.select().from(receivingSettings).where(user.tenantId != null ? eq(receivingSettings.tenantId, user.tenantId) : isNull(receivingSettings.tenantId)).limit(1);
    const cur = await this.getReceivingSettings(user.tenantId ?? null);
    const vals = {
      overReceiptWeightPct: String(dto.over_receipt_weight_pct ?? cur.overReceiptWeightPct),
      claimWindowHours: dto.claim_window_hours ?? cur.claimWindowHours,
      updatedBy: user.username, updatedAt: new Date(),
    };
    if (ex) await db.update(receivingSettings).set(vals).where(eq(receivingSettings.id, ex.id));
    else await db.insert(receivingSettings).values({ tenantId: user.tenantId ?? null, ...vals });
    const out = await this.getReceivingSettings(user.tenantId ?? null);
    return { over_receipt_weight_pct: out.overReceiptWeightPct, claim_window_hours: out.claimWindowHours };
  }

  // PO lines for the receiving screen — what was ordered, what's already in, what's still outstanding —
  // so the warehouse counts the actual delivery against the order instead of keying free-form lines.
  async receiveLines(poNo: string, user: JwtUser) {
    const db = this.db;
    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.poNo, poNo)).limit(1);
    if (!po) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found', messageTh: 'ไม่พบใบสั่งซื้อ' });
    const poLines = await db.select().from(poItems).where(eq(poItems.poId, po.id));
    const settings = await this.getReceivingSettings(user.tenantId ?? null);
    return {
      po_no: po.poNo, status: po.status, vendor_name: po.vendorName ?? null, po_date: po.poDate ?? null,
      over_receipt_weight_pct: settings.overReceiptWeightPct, claim_window_hours: settings.claimWindowHours,
      lines: poLines.map((l: any) => {
        const ordered = n(l.orderQty); const received = n(l.receivedQty);
        const closed = String(l.status) === 'Closed'; // closed short — nothing further receivable
        return {
          item_id: l.itemId, item_description: l.itemDescription ?? null, uom: l.uom ?? null,
          order_qty: ordered, received_qty: received, remaining_qty: closed ? 0 : Math.max(ordered - received, 0),
          is_weight: !closed && isWeightUom(l.uom), closed,
        };
      }),
    };
  }

  // Assemble the printable ใบรับสินค้า (Goods Receipt Note) — header + received lines + vendor + our-company.
  async getGrForPrint(grNo: string, user: JwtUser): Promise<GrPrintData> {
    const db = this.db;
    const [gr] = await db.select().from(goodsReceipts).where(eq(goodsReceipts.grNo, grNo)).limit(1);
    if (!gr) throw new NotFoundException({ code: 'NOT_FOUND', message: 'GR not found', messageTh: 'ไม่พบใบรับสินค้า' });
    const lineRows = await db.select().from(grItems).where(eq(grItems.grId, Number(gr.id)));
    const vendorRow = gr.vendorId ? (await db.select().from(vendors).where(eq(vendors.id, Number(gr.vendorId))).limit(1))[0] : null;
    const [t] = user.tenantId != null ? await db.select().from(tenants).where(eq(tenants.id, Number(user.tenantId))).limit(1) : [null];
    return {
      gr_no: gr.grNo, gr_date: gr.grDate ?? null, po_no: gr.poNo ?? null, remarks: gr.remarks ?? null,
      received_by: gr.receivedBy ?? null, currency: gr.currency ?? 'THB', seller: sellerParty(t),
      vendor: { name: vendorRow?.name ?? gr.vendorName ?? '-', address: vendorRow?.address ?? null, tax_id: vendorRow?.taxId ?? null, branch_label: null, phone: vendorRow?.phone ?? null, email: vendorRow?.email ?? null },
      lines: lineRows.map((l: any) => ({ item_id: l.itemId ?? null, description: l.itemDescription ?? null, received_qty: n(l.receivedQty), uom: l.uom ?? null, unit_cost: n(l.unitCost), lot_no: l.lotNo ?? null })),
    };
  }

  goodsReceiptHtml(g: GrPrintData): string {
    if (!this.grPdf) throw new NotFoundException({ code: 'RENDERER_UNAVAILABLE', message: 'GR renderer not wired' });
    return this.grPdf.goodsReceiptHtml(g);
  }

  // Recent goods receipts (for the /receiving list surface — print/email each). goods_receipts carries no
  // tenant_id (procurement is buyer-side), consistent with the existing GR print/email endpoints.
  async listGrs(_user: JwtUser, limit = 50) {
    const db = this.db;
    const rows = await db.select().from(goodsReceipts).orderBy(desc(goodsReceipts.id)).limit(Math.min(Math.max(limit, 1), 100));
    return { grs: rows.map((g: any) => ({ gr_no: g.grNo, gr_date: g.grDate ?? null, po_no: g.poNo ?? null, vendor_name: g.vendorName ?? null, currency: g.currency ?? 'THB', received_by: g.receivedBy ?? null })), count: rows.length };
  }

  async emailGr(grNo: string, toEmail: string | undefined, user: JwtUser) {
    if (!this.docEmail) throw new NotFoundException({ code: 'EMAIL_UNAVAILABLE', message: 'Email path not wired' });
    const g = await this.getGrForPrint(grNo, user);
    // Default the recipient to the vendor's email on file (master data) when to_email is omitted.
    const res = await this.docEmail.sendDocument({
      to: toEmail?.trim() || g.vendor.email || '', from: g.seller.email ?? undefined, filename: g.gr_no,
      subject: `ใบรับสินค้า ${g.gr_no} จาก ${g.seller.name}`,
      text: `แนบใบรับสินค้าเลขที่ ${g.gr_no}${g.po_no ? ` (อ้างอิง PO ${g.po_no})` : ''} จำนวน ${g.lines.length} รายการ\n\n${g.seller.name}`,
      html: this.goodsReceiptHtml(g),
    });
    return { ...res, gr_no: g.gr_no };
  }

  // ── GR ── (received_qty++ ; stock_movement ; lot_ledger ; auto-close PO)
  async createGr(dto: CreateGrDto, user: JwtUser) {
    const db = this.db;
    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.poNo, dto.po_no)).limit(1);
    if (!po) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found', messageTh: 'ไม่พบ PO' });
    // EXP-03 — a PO must clear its approval (maker-checker + DoA thresholds, enforced by the workflow engine)
    // BEFORE goods can be received against it; otherwise an unapproved/cancelled PO could trigger a GR and an
    // AP liability, defeating the 3-way match. Receivable = past approval (Approved or a part-received/closed
    // state); block the not-yet-approved / dead states.
    if (['Pending', 'Draft', 'Rejected', 'Cancelled'].includes(String(po.status))) {
      throw new ForbiddenException({ code: 'PO_NOT_APPROVED', message: `Cannot receive against a '${po.status}' PO — it must be approved first`, messageTh: `รับสินค้าไม่ได้: PO สถานะ '${po.status}' ต้องได้รับอนุมัติก่อน` });
    }
    const lines = (dto.items ?? []).filter((it) => n(it.received_qty) > 0);
    if (!lines.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No received qty', messageTh: 'ไม่มีจำนวนรับ' });

    // EXP-12 over-receipt gate — receiving more than was ordered is blocked (fictitious/duplicate receipt,
    // uncontrolled AP exposure). Exception: a weight-basis line (kg/g/ton) may run over by up to the
    // configurable tolerance (default 5% of the ordered qty), because weighed deliveries legitimately vary.
    // Checked per PO line over the AGGREGATE requested in this GR (two lots of one item can't sneak past).
    const settings = await this.getReceivingSettings(user.tenantId ?? null);
    const reqByItem = new Map<string, number>();
    for (const it of lines) reqByItem.set(it.item_id, (reqByItem.get(it.item_id) ?? 0) + n(it.received_qty));
    for (const [itemId, reqQty] of reqByItem) {
      const [poi] = await db.select().from(poItems).where(and(eq(poItems.poId, po.id), eq(poItems.itemId, itemId))).limit(1);
      if (!poi) continue; // an off-PO line has no ordered baseline — existing behaviour (kept for non-PO receipt flows)
      // A line closed short (closePoShort) takes no further stock — the close decision is binding.
      if (String(poi.status) === 'Closed') {
        throw new UnprocessableEntityException({ code: 'PO_LINE_CLOSED', message: `Item ${itemId}: the PO line was closed short — no further receipt`, messageTh: `สินค้า ${itemId}: รายการนี้ถูกปิดรับแล้ว (ปิดของขาดส่ง) รับเพิ่มไม่ได้` });
      }
      const ordered = n(poi.orderQty);
      const cap = isWeightUom(poi.uom) ? ordered * (1 + settings.overReceiptWeightPct / 100) : ordered;
      if (n(poi.receivedQty) + reqQty > cap + 1e-9) {
        const remaining = Math.max(ordered - n(poi.receivedQty), 0);
        throw new UnprocessableEntityException({
          code: 'OVER_RECEIPT',
          message: `Item ${itemId}: receiving ${reqQty} exceeds the ordered quantity (ordered ${ordered}, already received ${n(poi.receivedQty)}${isWeightUom(poi.uom) ? `, weight tolerance ${settings.overReceiptWeightPct}%` : ''})`,
          messageTh: `สินค้า ${itemId}: จำนวนรับ ${reqQty} เกินจำนวนที่สั่ง (สั่ง ${ordered} รับแล้ว ${n(poi.receivedQty)} คงเหลือ ${remaining}${isWeightUom(poi.uom) ? ` — สินค้าชั่งน้ำหนักรับเกินได้ไม่เกิน ${settings.overReceiptWeightPct}%` : ''})`,
          item_id: itemId, order_qty: ordered, received_qty: n(poi.receivedQty), remaining_qty: remaining,
        });
      }
    }

    const grNo = await this.docNo.nextDaily('GR');
    const today = ymd();
    const now = new Date();
    const costingLines: any[] = []; // Phase 17A — capitalize configured items (Dr 1200 / Cr 2000)

    await db.transaction(async (tx: any) => {
      const [gh] = await tx.insert(goodsReceipts).values({
        grNo, grDate: today, poNo: dto.po_no, vendorId: po.vendorId, vendorName: po.vendorName, receivedBy: user.username, remarks: dto.remarks ?? null,
        currency: po.currency ?? 'THB', fxRate: po.fxRate ?? '1.000000', projectId: po.projectId ?? null, // M0 — inherit the PO's project dimension
        tenantId: (po as any).tenantId ?? user.tenantId ?? null, // inherit the receiving PO's tenant (migration 0387)
      }).returning({ id: goodsReceipts.id });

      for (const it of lines) {
        const recv = n(it.received_qty);
        const [poi] = await tx.select().from(poItems).where(and(eq(poItems.poId, po.id), eq(poItems.itemId, it.item_id))).limit(1);
        // FA-10: a capital line (PO-line override, else item-master flag) is routed to the asset register
        // (Dr 1500 via the registration maker-checker) — NOT capitalised into inventory (Dr 1200) here, or it
        // would double-count. We still record the GR line + stock movement for the receipt audit trail.
        let isCapital = poi?.isCapital === true;
        if (!isCapital) {
          const [im] = await tx.select({ f: items.isFixedAsset }).from(items).where(eq(items.itemId, it.item_id)).limit(1);
          isCapital = im?.f === true;
        }
        await tx.insert(grItems).values({
          grId: Number(gh.id), poNo: dto.po_no, itemId: it.item_id, itemDescription: poi?.itemDescription ?? null,
          poQty: poi?.orderQty ?? null, receivedQty: String(recv), uom: it.uom ?? poi?.uom ?? null,
          lotNo: it.lot_no ?? null, expiryDate: it.expiry_date ?? null, unitCost: it.unit_cost != null ? String(it.unit_cost) : (poi?.unitPrice ?? null),
          isCapital, tenantId: (po as any).tenantId ?? user.tenantId ?? null,
        });
        if (poi) await tx.update(poItems).set({ receivedQty: sql`${poItems.receivedQty} + ${recv}` }).where(eq(poItems.id, poi.id));
        // Phase 17A — build cost basis (FIFO layer / AVG running cost) for configured items (capital goods excluded)
        if (this.costing && user.tenantId != null && !isCapital) {
          const actualCost = Number(it.unit_cost ?? poi?.unitPrice ?? 0);
          const c = await this.costing.onReceipt(tx, { tenantId: user.tenantId, itemId: it.item_id, qty: recv, unitCost: actualCost, grNo, date: today });
          if (c.active) costingLines.push({ itemId: it.item_id, qty: recv, actualCost, method: c.method, standardCost: c.standardCost ?? 0 });
        }
        // stock movement (audit log; ไม่ปรับ snapshot — คง model V1)
        // 0316 made stock_movements tenant-scoped (RLS WITH CHECK) — a NULL tenant_id insert from a
        // tenant session is REJECTED, so the write must carry the tenant explicitly.
        await tx.insert(stockMovements).values({
          tenantId: user.tenantId ?? null,
          moveDate: now, docNo: grNo, moveType: 'GR', itemId: it.item_id, itemDescription: poi?.itemDescription ?? null,
          uom: it.uom ?? poi?.uom ?? null, qty: String(recv), fromLocation: 'Supplier', toLocation: 'Warehouse', refDoc: dto.po_no, createdBy: user.username,
        });
        // lot ledger (เฉพาะมี lot_no)
        if (it.lot_no) {
          await tx.insert(lotLedger).values({
            lotNo: it.lot_no, itemId: it.item_id, itemDescription: poi?.itemDescription ?? null, uom: it.uom ?? poi?.uom ?? null,
            locationId: 'WH-MAIN', grNo, qtyIn: String(recv), qtyOut: '0', balance: String(recv),
            expiryDate: it.expiry_date ?? null, status: 'Active', moveDate: now, refDoc: grNo, createdBy: user.username,
          });
        }
      }
    });

    // auto-close: Closed ถ้าทุก line received >= order; else Received
    const allItems = await db.select().from(poItems).where(eq(poItems.poId, po.id));
    const fullyReceived = allItems.every((i: any) => n(i.receivedQty) >= n(i.orderQty));
    const newStatus = fullyReceived ? 'Closed' : 'Received';
    await db.update(purchaseOrders).set({ status: newStatus }).where(eq(purchaseOrders.id, po.id));
    // M1 (PROJ-12) — once a project PO is fully received, its BoQ-line commitments become consumed (open →
    // consumed; still counts against the budget — the spend is now actual, no longer just an open encumbrance).
    if (this.commitments && fullyReceived) await this.commitments.consume(db, 'PO', dto.po_no);
    // FIN-3 (BUD-02) — a fully-received PO's GL-budget commitment is CONSUMED: the spend is (or will shortly
    // be) in the GL as an actual, so the open encumbrance drops out of availability instead of double-counting.
    if (this.commitments && fullyReceived) await this.commitments.glConsume(db, 'PO', dto.po_no);
    await this.statusLog.log('GR', grNo, '', 'Open', user.username);
    await this.statusLog.log('PO', dto.po_no, po.status ?? '', newStatus, user.username, `GR ${grNo}`);

    // Phase 17A — capitalize inventory for configured items (after the GR tx; idempotent on GRV/grNo)
    if (this.costing && costingLines.length) await this.costing.postReceiptGl({ tenantId: user.tenantId as number, grNo, date: today, lines: costingLines, createdBy: user.username });

    // D2 — close the loop: tell the requester(s) of any PR linked to this PO that their goods arrived.
    await this.notifyRequesters(dto.po_no, `📦 สินค้าตามใบสั่งซื้อ ${dto.po_no} (จากคำขอซื้อของคุณ) รับเข้าคลังแล้ว ${newStatus === 'Closed' ? '(รับครบ)' : '(รับบางส่วน)'} · ใบรับของ ${grNo}`);

    // EXP-12 — ordered-vs-received summary so the receiver sees any shortage immediately, plus the claim
    // cutoff (claims after the window are refused, so surface the deadline at receipt time).
    const receivedNow = new Map<string, number>();
    for (const it of lines) receivedNow.set(it.item_id, (receivedNow.get(it.item_id) ?? 0) + n(it.received_qty));
    const claimDeadline = new Date(now.getTime() + settings.claimWindowHours * 3600_000);
    const summary = {
      claim_window_hours: settings.claimWindowHours,
      claim_deadline: claimDeadline.toISOString(),
      lines: allItems.map((l: any) => {
        const ordered = n(l.orderQty); const total = n(l.receivedQty);
        return {
          item_id: l.itemId, item_description: l.itemDescription ?? null, uom: l.uom ?? null,
          order_qty: ordered, received_now: receivedNow.get(String(l.itemId)) ?? 0, received_total: total,
          shortage_qty: Math.max(ordered - total, 0), over_qty: Math.max(total - ordered, 0),
          is_weight: isWeightUom(l.uom),
        };
      }),
    };

    return { gr_no: grNo, po_no: dto.po_no, po_status: newStatus, lines: lines.length, costed: costingLines.length > 0, summary };
  }

  // EXP-12 — close a part-received PO SHORT: the receiver decides the missing quantity is never coming
  // (short shipment) and closes the order instead of leaving it open for a receipt that won't happen.
  // Remaining project commitments are RELEASED (not consumed — the money was never spent). Audit-trailed.
  async closePoShort(poNo: string, reason: string | undefined, user: JwtUser) {
    const db = this.db;
    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.poNo, poNo)).limit(1);
    if (!po) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found', messageTh: 'ไม่พบใบสั่งซื้อ' });
    if (!['Approved', 'Received'].includes(String(po.status))) {
      throw new UnprocessableEntityException({ code: 'BAD_STATUS', message: `Cannot close a '${po.status}' PO short`, messageTh: `ปิดใบสั่งซื้อสถานะ '${po.status}' ไม่ได้` });
    }
    const allItems = await db.select().from(poItems).where(eq(poItems.poId, po.id));
    const shortLines = allItems
      .map((l: any) => ({ item_id: l.itemId, short_qty: n(l.orderQty) - n(l.receivedQty), uom: l.uom ?? null }))
      .filter((x) => x.short_qty > 0);
    if (!shortLines.length) throw new UnprocessableEntityException({ code: 'NOTHING_OUTSTANDING', message: 'PO already fully received', messageTh: 'รับของครบแล้ว ไม่มีรายการค้างรับ' });
    await db.update(purchaseOrders).set({ status: 'Closed' }).where(eq(purchaseOrders.id, po.id));
    // Bind the decision at line level too — a closed-short line takes no further stock (see the
    // PO_LINE_CLOSED gate in createGr), so the close can't be undone by a later ordinary GR.
    await db.update(poItems).set({ status: 'Closed' }).where(eq(poItems.poId, po.id));
    if (this.commitments) await this.commitments.release(db, 'PO', poNo);
    // FIN-3 (BUD-02) — a closed-short PO releases its GL-budget commitment: the received part is already in
    // the GL as an actual; the never-coming remainder frees its encumbrance (money was never spent).
    if (this.commitments) await this.commitments.glRelease(db, 'PO', poNo);
    await this.statusLog.log('PO', poNo, po.status ?? '', 'Closed', user.username, `ปิดรับ (ของขาดส่ง)${reason ? `: ${reason}` : ''}`);
    await this.notifyRequesters(poNo, `📦 ใบสั่งซื้อ ${poNo} ถูกปิดโดยไม่รับส่วนที่ขาดส่ง (${shortLines.length} รายการค้างรับ)`);
    return { po_no: poNo, po_status: 'Closed', short_lines: shortLines };
  }

  // Receive ALL still-outstanding qty on an approved PO in one shot — the LINE chat `receive <PO>` path
  // and the web "รับครบ" button. Builds the GR lines from each PO line's remaining (order − received) and
  // runs the ordinary createGr (EXP-03 approval gate + stock/lot + auto-close all bind). No remaining → 422.
  async receiveAllRemaining(poNo: string, user: JwtUser) {
    const db = this.db;
    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.poNo, poNo)).limit(1);
    if (!po) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found', messageTh: 'ไม่พบใบสั่งซื้อ' });
    const poLines = await db.select().from(poItems).where(eq(poItems.poId, po.id));
    const items = poLines
      .filter((l: any) => String(l.status) !== 'Closed') // a closed-short line takes no further stock
      .map((l: any) => ({ item_id: String(l.itemId), received_qty: n(l.orderQty) - n(l.receivedQty), uom: l.uom ?? undefined }))
      .filter((x) => x.received_qty > 0);
    if (!items.length) throw new UnprocessableEntityException({ code: 'NOTHING_TO_RECEIVE', message: 'PO already fully received', messageTh: 'รับของครบแล้ว ไม่มีรายการค้างรับ' });
    return this.createGr({ po_no: poNo, remarks: 'รับครบผ่านแชท/ปุ่มรับครบ', items }, user);
  }

  // D4 — receive a PARTIAL quantity of ONE item on an approved PO (LINE chat `receive <PO> <item> <qty>`).
  // The item must be a line on the PO; qty is capped at the outstanding amount so a fat-finger can't
  // over-receive. Runs the ordinary createGr path (EXP-03 approval gate + stock/lot + auto-close all bind).
  async receiveItem(poNo: string, itemId: string, qty: number, user: JwtUser) {
    const db = this.db;
    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.poNo, poNo)).limit(1);
    if (!po) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found', messageTh: 'ไม่พบใบสั่งซื้อ' });
    const [poi] = await db.select().from(poItems).where(and(eq(poItems.poId, po.id), eq(poItems.itemId, itemId))).limit(1);
    if (!poi) throw new UnprocessableEntityException({ code: 'ITEM_NOT_ON_PO', message: `Item ${itemId} is not on ${poNo}`, messageTh: `ไม่มีสินค้า ${itemId} ในใบสั่งซื้อ ${poNo}` });
    if (String(poi.status) === 'Closed') throw new UnprocessableEntityException({ code: 'PO_LINE_CLOSED', message: `Item ${itemId}: the PO line was closed short — no further receipt`, messageTh: `สินค้า ${itemId}: รายการนี้ถูกปิดรับแล้ว (ปิดของขาดส่ง) รับเพิ่มไม่ได้` });
    const remaining = n(poi.orderQty) - n(poi.receivedQty);
    if (!(remaining > 0)) throw new UnprocessableEntityException({ code: 'NOTHING_TO_RECEIVE', message: `Item ${itemId} already fully received`, messageTh: `สินค้า ${itemId} รับครบแล้ว` });
    const recv = Math.min(n(qty), remaining); // cap at outstanding — no accidental over-receipt
    if (!(recv > 0)) throw new BadRequestException({ code: 'BAD_QTY', message: 'Received qty must be > 0', messageTh: 'จำนวนรับต้องมากกว่า 0' });
    return this.createGr({ po_no: poNo, remarks: 'รับบางส่วนผ่านแชท', items: [{ item_id: itemId, received_qty: recv, uom: poi.uom ?? undefined }] }, user);
  }
}
