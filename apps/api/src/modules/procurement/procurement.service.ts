import { Inject, Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { sql, eq, and } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { purchaseRequests, prItems, purchaseOrders, poItems, goodsReceipts, grItems, lotLedger, stockMovements, vendors } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import { ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const n = (v: unknown) => Number(v ?? 0);

export interface CreatePrDto { items: { item_id: string; item_description?: string; request_qty: number; uom?: string; required_date?: string; reason?: string }[]; remarks?: string; priority?: string }
export interface CreatePoDto { vendor_id?: number; vendor_name?: string; expected_date?: string; remarks?: string; items: { item_id: string; item_description?: string; order_qty: number; unit_price: number; uom?: string }[] }
export interface CreateGrDto { po_no: string; remarks?: string; items: { item_id: string; received_qty: number; lot_no?: string; expiry_date?: string; unit_cost?: number; uom?: string }[] }

@Injectable()
export class ProcurementService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly statusLog: StatusLogService,
  ) {}

  // ── PR ──────────────────────────────────────────────────────────────
  async createPr(dto: CreatePrDto, user: JwtUser) {
    const db = this.db as any;
    if (!dto.items?.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No items', messageTh: 'ไม่มีรายการ' });
    const prNo = await this.docNo.nextDaily('PR');
    await db.transaction(async (tx: any) => {
      const [h] = await tx.insert(purchaseRequests).values({
        prNo, prDate: ymd(), requestedBy: user.username, status: 'Pending', remarks: dto.remarks ?? null, priority: dto.priority ?? 'Normal',
      }).returning({ id: purchaseRequests.id });
      await tx.insert(prItems).values(dto.items.map((it) => ({
        prId: Number(h.id), itemId: it.item_id, itemDescription: it.item_description ?? null,
        requestQty: String(n(it.request_qty)), uom: it.uom ?? null, requiredDate: it.required_date ?? null,
        reason: it.reason ?? null, status: 'Open',
      })));
    });
    await this.statusLog.log('PR', prNo, '', 'Pending', user.username);
    return { pr_no: prNo, status: 'Pending', lines: dto.items.length };
  }

  async approvePr(prNo: string, approve: boolean, user: JwtUser) {
    if (user.role !== 'Admin') throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Admin only', messageTh: 'เฉพาะผู้ดูแล' });
    const db = this.db as any;
    const [pr] = await db.select().from(purchaseRequests).where(eq(purchaseRequests.prNo, prNo)).limit(1);
    if (!pr) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PR not found', messageTh: 'ไม่พบ PR' });
    const newStatus = approve ? 'Approved' : 'Rejected';
    await db.update(purchaseRequests).set({ status: newStatus, approvedBy: user.username, approvedAt: new Date() }).where(eq(purchaseRequests.id, pr.id));
    await this.statusLog.log('PR', prNo, pr.status ?? '', newStatus, user.username);
    return { pr_no: prNo, status: newStatus };
  }

  // ── PO ──────────────────────────────────────────────────────────────
  async createPo(dto: CreatePoDto, user: JwtUser) {
    const db = this.db as any;
    if (!dto.items?.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No items', messageTh: 'ไม่มีรายการ' });
    let vendorId = dto.vendor_id ?? null;
    let vendorName = dto.vendor_name ?? null;
    if (!vendorId && vendorName) {
      const [v] = await db.select().from(vendors).where(eq(vendors.name, vendorName)).limit(1);
      vendorId = v?.id ?? null;
    } else if (vendorId && !vendorName) {
      const [v] = await db.select().from(vendors).where(eq(vendors.id, vendorId)).limit(1);
      vendorName = v?.name ?? null;
    }
    const total = dto.items.reduce((a, it) => a + n(it.order_qty) * n(it.unit_price), 0);
    const poNo = await this.docNo.nextDaily('PO');
    await db.transaction(async (tx: any) => {
      const [h] = await tx.insert(purchaseOrders).values({
        poNo, poDate: ymd(), vendorId, vendorName, status: 'Pending', totalAmount: String(total),
        createdBy: user.username, expectedDate: dto.expected_date ?? null, remarks: dto.remarks ?? null,
      }).returning({ id: purchaseOrders.id });
      await tx.insert(poItems).values(dto.items.map((it) => ({
        poId: Number(h.id), itemId: it.item_id, itemDescription: it.item_description ?? null,
        orderQty: String(n(it.order_qty)), unitPrice: String(n(it.unit_price)), uom: it.uom ?? null,
        amount: String(n(it.order_qty) * n(it.unit_price)), receivedQty: '0', status: 'Open',
      })));
    });
    await this.statusLog.log('PO', poNo, '', 'Pending', user.username);
    return { po_no: poNo, status: 'Pending', total_amount: total };
  }

  async approvePo(poNo: string, approve: boolean, reason: string | undefined, user: JwtUser) {
    if (user.role !== 'Admin') throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Admin only', messageTh: 'เฉพาะผู้ดูแล' });
    const db = this.db as any;
    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.poNo, poNo)).limit(1);
    if (!po) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found', messageTh: 'ไม่พบ PO' });
    const newStatus = approve ? 'Approved' : 'Cancelled';
    await db.update(purchaseOrders).set({
      status: newStatus, approvedBy: user.username, approvedAt: new Date(),
      remarks: approve ? po.remarks : `Rejected: ${reason ?? ''}`,
    }).where(eq(purchaseOrders.id, po.id));
    await this.statusLog.log('PO', poNo, po.status ?? '', newStatus, user.username);
    return { po_no: poNo, status: newStatus };
  }

  async cancelPo(poNo: string, reason: string, user: JwtUser) {
    const db = this.db as any;
    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.poNo, poNo)).limit(1);
    if (!po) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found', messageTh: 'ไม่พบ PO' });
    // parity: ถ้ามี GR แล้วและไม่ใช่ Admin → ปิดไม่ได้
    const [gr] = await db.select({ id: goodsReceipts.id }).from(goodsReceipts).where(eq(goodsReceipts.poNo, poNo)).limit(1);
    if (gr && user.role !== 'Admin') throw new ForbiddenException({ code: 'FORBIDDEN', message: 'PO has GR — must close via Admin', messageTh: 'มีการรับของแล้ว ต้องปิดผ่าน Admin' });
    if (!reason) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Cancel reason required', messageTh: 'ต้องระบุเหตุผล' });
    await db.update(purchaseOrders).set({ status: 'Cancelled', remarks: reason }).where(eq(purchaseOrders.id, po.id));
    await this.statusLog.log('PO', poNo, po.status ?? '', 'Cancelled', user.username, reason);
    return { po_no: poNo, status: 'Cancelled' };
  }

  // ── GR ── (received_qty++ ; stock_movement ; lot_ledger ; auto-close PO)
  async createGr(dto: CreateGrDto, user: JwtUser) {
    const db = this.db as any;
    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.poNo, dto.po_no)).limit(1);
    if (!po) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found', messageTh: 'ไม่พบ PO' });
    const lines = (dto.items ?? []).filter((it) => n(it.received_qty) > 0);
    if (!lines.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No received qty', messageTh: 'ไม่มีจำนวนรับ' });

    const grNo = await this.docNo.nextDaily('GR');
    const today = ymd();
    const now = new Date();

    await db.transaction(async (tx: any) => {
      const [gh] = await tx.insert(goodsReceipts).values({
        grNo, grDate: today, poNo: dto.po_no, vendorId: po.vendorId, vendorName: po.vendorName, receivedBy: user.username, remarks: dto.remarks ?? null,
      }).returning({ id: goodsReceipts.id });

      for (const it of lines) {
        const recv = n(it.received_qty);
        const [poi] = await tx.select().from(poItems).where(and(eq(poItems.poId, po.id), eq(poItems.itemId, it.item_id))).limit(1);
        await tx.insert(grItems).values({
          grId: Number(gh.id), poNo: dto.po_no, itemId: it.item_id, itemDescription: poi?.itemDescription ?? null,
          poQty: poi?.orderQty ?? null, receivedQty: String(recv), uom: it.uom ?? poi?.uom ?? null,
          lotNo: it.lot_no ?? null, expiryDate: it.expiry_date ?? null, unitCost: it.unit_cost != null ? String(it.unit_cost) : (poi?.unitPrice ?? null),
        });
        if (poi) await tx.update(poItems).set({ receivedQty: sql`${poItems.receivedQty} + ${recv}` }).where(eq(poItems.id, poi.id));
        // stock movement (audit log; ไม่ปรับ snapshot — คง model V1)
        await tx.insert(stockMovements).values({
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
    await this.statusLog.log('GR', grNo, '', 'Open', user.username);
    await this.statusLog.log('PO', dto.po_no, po.status ?? '', newStatus, user.username, `GR ${grNo}`);

    return { gr_no: grNo, po_no: dto.po_no, po_status: newStatus, lines: lines.length };
  }
}
