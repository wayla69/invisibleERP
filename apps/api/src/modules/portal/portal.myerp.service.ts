import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { myCustomers, mySuppliers, myPurchaseOrders, myPoItems } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { ymd, n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { PortalService } from './portal.service';

export interface MyCustomerDto { customer_name: string; phone?: string; address?: string; notes?: string }
export interface MySupplierDto { supplier_name: string; contact_name?: string; phone?: string; address?: string }
export interface MyPoDto {
  supplier_name?: string; remarks?: string;
  items: { item_description: string; qty: number; uom?: string; unit_price: number }[];
}

@Injectable()
export class PortalMyErpService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly portal: PortalService,
  ) {}

  // ── My Customers ─────────────────────────────────────────
  async listCustomers(user: JwtUser) {
    const t = await this.portal.tenantId(user);
    const db = this.db as any;
    const rows = await db.select().from(myCustomers).where(eq(myCustomers.tenantId, t.id)).orderBy(desc(myCustomers.id));
    return {
      customers: rows.map((r: any) => ({ id: Number(r.id), customer_name: r.customerName, phone: r.phone, address: r.address, notes: r.notes })),
      count: rows.length,
    };
  }

  async addCustomer(dto: MyCustomerDto, user: JwtUser) {
    const t = await this.portal.tenantId(user);
    const db = this.db as any;
    const [row] = await db.insert(myCustomers).values({
      tenantId: t.id, customerName: dto.customer_name, phone: dto.phone ?? null, address: dto.address ?? null, notes: dto.notes ?? null,
    }).returning({ id: myCustomers.id });
    return { id: Number(row.id), customer_name: dto.customer_name };
  }

  async deleteCustomer(id: number, user: JwtUser) {
    const t = await this.portal.tenantId(user);
    const db = this.db as any;
    const [row] = await db.select().from(myCustomers).where(and(eq(myCustomers.id, id), eq(myCustomers.tenantId, t.id))).limit(1);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Customer not found', messageTh: 'ไม่พบลูกค้า' });
    await db.delete(myCustomers).where(eq(myCustomers.id, id));
    return { id, deleted: true };
  }

  // ── My Suppliers ─────────────────────────────────────────
  async listSuppliers(user: JwtUser) {
    const t = await this.portal.tenantId(user);
    const db = this.db as any;
    const rows = await db.select().from(mySuppliers).where(eq(mySuppliers.tenantId, t.id)).orderBy(desc(mySuppliers.id));
    return {
      suppliers: rows.map((r: any) => ({ id: Number(r.id), supplier_name: r.supplierName, contact_name: r.contactName, phone: r.phone, address: r.address })),
      count: rows.length,
    };
  }

  async addSupplier(dto: MySupplierDto, user: JwtUser) {
    const t = await this.portal.tenantId(user);
    const db = this.db as any;
    const [row] = await db.insert(mySuppliers).values({
      tenantId: t.id, supplierName: dto.supplier_name, contactName: dto.contact_name ?? null, phone: dto.phone ?? null, address: dto.address ?? null,
    }).returning({ id: mySuppliers.id });
    return { id: Number(row.id), supplier_name: dto.supplier_name };
  }

  async deleteSupplier(id: number, user: JwtUser) {
    const t = await this.portal.tenantId(user);
    const db = this.db as any;
    const [row] = await db.select().from(mySuppliers).where(and(eq(mySuppliers.id, id), eq(mySuppliers.tenantId, t.id))).limit(1);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Supplier not found', messageTh: 'ไม่พบซัพพลายเออร์' });
    await db.delete(mySuppliers).where(eq(mySuppliers.id, id));
    return { id, deleted: true };
  }

  // ── My Purchase Orders (MPO-) ────────────────────────────
  async listPurchaseOrders(user: JwtUser) {
    const t = await this.portal.tenantId(user);
    const db = this.db as any;
    const hdrs = await db.select().from(myPurchaseOrders).where(eq(myPurchaseOrders.tenantId, t.id)).orderBy(desc(myPurchaseOrders.id));
    const out = [];
    for (const h of hdrs) {
      const items = await db.select().from(myPoItems).where(eq(myPoItems.myPoId, Number(h.id)));
      out.push({
        po_no: h.poNo, po_date: h.poDate, supplier_name: h.supplierName, status: h.status,
        total_amount: n(h.totalAmount), remarks: h.remarks,
        items: items.map((i: any) => ({ item_description: i.itemDescription, qty: n(i.qty), uom: i.uom, unit_price: n(i.unitPrice), amount: n(i.amount) })),
      });
    }
    return { purchase_orders: out, count: out.length };
  }

  async createPurchaseOrder(dto: MyPoDto, user: JwtUser) {
    const t = await this.portal.tenantId(user);
    const db = this.db as any;
    if (!dto.items?.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No items', messageTh: 'ไม่มีรายการ' });
    const total = Math.round(dto.items.reduce((a, it) => a + n(it.qty) * n(it.unit_price), 0) * 100) / 100;
    const poNo = this.docNo.nextTenantStamped('MPO', t.code);

    await db.transaction(async (tx: any) => {
      const [h] = await tx.insert(myPurchaseOrders).values({
        poNo, tenantId: t.id, poDate: ymd(), supplierName: dto.supplier_name ?? null,
        totalAmount: String(total), status: 'Issued', remarks: dto.remarks ?? null,
      }).returning({ id: myPurchaseOrders.id });
      await tx.insert(myPoItems).values(dto.items.map((it) => ({
        myPoId: Number(h.id), itemDescription: it.item_description, qty: String(n(it.qty)), uom: it.uom ?? null,
        unitPrice: String(n(it.unit_price)), amount: String(Math.round(n(it.qty) * n(it.unit_price) * 100) / 100),
      })));
    });

    return { po_no: poNo, status: 'Issued', total_amount: total, lines: dto.items.length };
  }

  async deletePurchaseOrder(poNo: string, user: JwtUser) {
    const t = await this.portal.tenantId(user);
    const db = this.db as any;
    const [h] = await db.select().from(myPurchaseOrders).where(and(eq(myPurchaseOrders.poNo, poNo), eq(myPurchaseOrders.tenantId, t.id))).limit(1);
    if (!h) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found', messageTh: 'ไม่พบใบสั่งซื้อ' });
    await db.transaction(async (tx: any) => {
      await tx.delete(myPoItems).where(eq(myPoItems.myPoId, Number(h.id)));
      await tx.delete(myPurchaseOrders).where(eq(myPurchaseOrders.id, Number(h.id)));
    });
    return { po_no: poNo, deleted: true };
  }
}
