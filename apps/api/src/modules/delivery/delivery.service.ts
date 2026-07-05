import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { deliveryOrders, doItems, orders, orderLines, tenants } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { n, ymd } from '../../database/queries';
import { DeliveryPdfService, type DeliveryPrintData } from './delivery-pdf.service';
import { DocEmailService } from '../mail/doc-email.service';
import { sellerParty } from '../../common/doc-party';
import type { JwtUser } from '../../common/decorators';

export interface DeliveryDto {
  order_no?: string; address?: string; driver?: string; vehicle?: string; remarks?: string;
  lines?: { item_id: string; item_description?: string; qty: number; uom?: string }[];
}
const VALID = ['Pending', 'In Transit', 'Delivered', 'Cancelled'];

// Delivery Orders over the existing logistics.deliveryOrders / doItems tables (created in 0000).
@Injectable()
export class DeliveryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    @Optional() private readonly deliveryPdf?: DeliveryPdfService, // provided via DeliveryModule
    @Optional() private readonly docEmail?: DocEmailService,       // @Global MailModule
  ) {}

  async create(dto: DeliveryDto, user: JwtUser) {
    const db = this.db;
    let lines = dto.lines ?? [];
    if (!lines.length && dto.order_no) {
      const [o] = await db.select().from(orders).where(eq(orders.orderNo, dto.order_no)).limit(1);
      if (o) {
        const ols = await db.select().from(orderLines).where(eq(orderLines.orderId, o.id));
        lines = ols.map((l: any) => ({ item_id: l.itemId, item_description: l.itemDescription, qty: n(l.orderQty), uom: l.stockUom }));
      }
    }
    if (!lines.length) throw new BadRequestException({ code: 'NO_LINES', message: 'No delivery lines (order has none / not found)', messageTh: 'ไม่มีรายการส่ง' });
    const doNo = await this.docNo.nextDaily('DO');
    const [hdr] = await db.insert(deliveryOrders).values({
      doNo, doDate: ymd(), tenantId: user.tenantId ?? null, address: dto.address ?? null, driver: dto.driver ?? null,
      vehicle: dto.vehicle ?? null, status: 'Pending', remarks: dto.remarks ?? null, createdBy: user.username,
    }).returning({ id: deliveryOrders.id });
    for (const l of lines) {
      await db.insert(doItems).values({ doId: Number(hdr!.id), orderNo: dto.order_no ?? null, itemId: l.item_id, itemDescription: l.item_description ?? null, qty: String(n(l.qty)), uom: l.uom ?? null, status: 'Pending' });
    }
    return { do_no: doNo, status: 'Pending', lines: lines.length };
  }

  async list(status?: string) {
    const db = this.db;
    const where = status ? eq(deliveryOrders.status, status) : undefined;
    const rows = await db.select().from(deliveryOrders).where(where).orderBy(desc(deliveryOrders.id));
    return { deliveries: rows.map(shape), count: rows.length };
  }

  async detail(doNo: string) {
    const db = this.db;
    const [h] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.doNo, doNo)).limit(1);
    if (!h) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Delivery order not found', messageTh: 'ไม่พบใบส่งสินค้า' });
    const items = await db.select().from(doItems).where(eq(doItems.doId, Number(h.id)));
    return { ...shape(h), items: items.map((i: any) => ({ item_id: i.itemId, item_description: i.itemDescription, qty: n(i.qty), uom: i.uom, order_no: i.orderNo, status: i.status })) };
  }

  // Assemble the printable ใบส่งของ (header + item lines + our-company seller block) for the PDF/email path.
  async getForPrint(doNo: string): Promise<DeliveryPrintData> {
    const db = this.db;
    const [h] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.doNo, doNo)).limit(1);
    if (!h) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Delivery order not found', messageTh: 'ไม่พบใบส่งสินค้า' });
    const items = await db.select().from(doItems).where(eq(doItems.doId, Number(h.id)));
    const [t] = h.tenantId != null ? await db.select().from(tenants).where(eq(tenants.id, Number(h.tenantId))).limit(1) : [null];
    return {
      do_no: h.doNo, do_date: h.doDate ?? null, status: String(h.status ?? ''), address: h.address ?? null,
      driver: h.driver ?? null, vehicle: h.vehicle ?? null, remarks: h.remarks ?? null, created_by: h.createdBy ?? null,
      order_no: items.find((i: any) => i.orderNo)?.orderNo ?? null, seller: sellerParty(t),
      lines: items.map((i: any) => ({ item_id: i.itemId ?? null, description: i.itemDescription ?? null, qty: n(i.qty), uom: i.uom ?? null })),
    };
  }

  deliveryNoteHtml(d: DeliveryPrintData): string {
    if (!this.deliveryPdf) throw new NotFoundException({ code: 'RENDERER_UNAVAILABLE', message: 'Delivery renderer not wired' });
    return this.deliveryPdf.deliveryNoteHtml(d);
  }

  async renderPdf(d: DeliveryPrintData): Promise<Buffer | null> {
    return this.deliveryPdf ? this.deliveryPdf.renderToPdf(this.deliveryPdf.deliveryNoteHtml(d)) : null;
  }

  // Email the ใบส่งของ to the customer as a PDF attachment (HTML fallback when Chromium absent).
  async emailDelivery(doNo: string, toEmail: string) {
    if (!this.docEmail) throw new NotFoundException({ code: 'EMAIL_UNAVAILABLE', message: 'Email path not wired' });
    const d = await this.getForPrint(doNo);
    const res = await this.docEmail.sendDocument({
      to: toEmail, from: d.seller.email ?? undefined, filename: d.do_no,
      subject: `ใบส่งของ ${d.do_no} จาก ${d.seller.name}`,
      text: `แนบใบส่งของเลขที่ ${d.do_no} (${d.lines.length} รายการ)\n\n${d.seller.name}`,
      html: this.deliveryNoteHtml(d),
    });
    return { ...res, do_no: d.do_no };
  }

  async updateStatus(doNo: string, dto: { status: string; pod_image_key?: string; driver?: string; vehicle?: string }, _user: JwtUser) {
    if (!VALID.includes(dto.status)) throw new BadRequestException({ code: 'BAD_STATUS', message: `Invalid status: ${dto.status}`, messageTh: 'สถานะไม่ถูกต้อง' });
    const db = this.db;
    const [h] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.doNo, doNo)).limit(1);
    if (!h) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Delivery order not found', messageTh: 'ไม่พบใบส่งสินค้า' });
    const set: any = { status: dto.status };
    if (dto.pod_image_key !== undefined) set.podImageKey = dto.pod_image_key;
    if (dto.driver !== undefined) set.driver = dto.driver;
    if (dto.vehicle !== undefined) set.vehicle = dto.vehicle;
    if (dto.status === 'Delivered') set.deliveredAt = new Date();
    await db.update(deliveryOrders).set(set).where(eq(deliveryOrders.id, h.id));
    return { do_no: doNo, status: dto.status };
  }
}

function shape(h: any) {
  return { do_no: h.doNo, do_date: h.doDate, status: h.status, address: h.address, driver: h.driver, vehicle: h.vehicle, pod_image_key: h.podImageKey, remarks: h.remarks, delivered_at: h.deliveredAt };
}
