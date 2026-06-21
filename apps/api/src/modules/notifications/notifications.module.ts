import { Inject, Injectable, Module, Controller, Get } from '@nestjs/common';
import { sql, eq, and, ne, asc, lt } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { stockSnapshots, apTransactions, arInvoices, tenants } from '../../database/schema';
import { latestSnapshotDate, ymd, n } from '../../database/queries';
import { Permissions } from '../../common/decorators';

const thb = (v: unknown) => `฿${n(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

@Injectable()
export class NotificationsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // GET /api/notifications — 3 แหล่ง, สตริงไทย + ฿ format (parity-critical contract)
  async list() {
    const db = this.db as any;
    const today = ymd();
    const alerts: any[] = [];

    // 1) low_stock
    const snap = await latestSnapshotDate(db);
    if (snap) {
      const rows = await db.select({
        Item_ID: stockSnapshots.itemId, Item_Description: stockSnapshots.itemDescription,
        AV_QTY: stockSnapshots.avQty, UOM: stockSnapshots.uom,
      }).from(stockSnapshots).where(and(eq(stockSnapshots.generateDate, snap), sql`${stockSnapshots.avQty} <= 0`))
        .orderBy(asc(stockSnapshots.avQty)).limit(30);
      for (const r of rows) {
        alerts.push({
          type: 'low_stock', severity: 'warning',
          title: r.Item_Description || r.Item_ID,
          subtitle: `Item: ${r.Item_ID} · Qty: ${n(r.AV_QTY)} ${r.UOM ?? ''}`,
          ref_id: r.Item_ID,
        });
      }
    }

    // 2) overdue_ap
    const apRows = await db.select({
      Transaction_ID: apTransactions.txnNo, Creditor_Name: apTransactions.vendorName, Invoice_No: apTransactions.invoiceNo,
      Due_Date: apTransactions.dueDate, Outstanding_Amount: sql<string>`${apTransactions.amount} - coalesce(${apTransactions.paidAmount},0)`,
    }).from(apTransactions).where(and(sql`${apTransactions.status}::text <> 'Paid'`, lt(apTransactions.dueDate, today)))
      .orderBy(asc(apTransactions.dueDate)).limit(30);
    for (const r of apRows) {
      alerts.push({
        type: 'overdue_ap', severity: 'danger',
        title: `AP เกินกำหนด: ${r.Creditor_Name ?? ''}`,
        subtitle: `Invoice ${r.Invoice_No ?? ''} · Due ${r.Due_Date} · ${thb(r.Outstanding_Amount)}`,
        ref_id: r.Transaction_ID, data: { ...r, Outstanding_Amount: n(r.Outstanding_Amount) },
      });
    }

    // 3) overdue_ar
    const arRows = await db.select({
      Invoice_No: arInvoices.invoiceNo, Customer_Name: tenants.code, Due_Date: arInvoices.dueDate,
      Outstanding_Amount: sql<string>`${arInvoices.amount} - coalesce(${arInvoices.paidAmount},0)`,
    }).from(arInvoices).leftJoin(tenants, eq(arInvoices.tenantId, tenants.id))
      .where(and(sql`${arInvoices.status}::text <> 'Paid'`, lt(arInvoices.dueDate, today)))
      .orderBy(asc(arInvoices.dueDate)).limit(30);
    for (const r of arRows) {
      alerts.push({
        type: 'overdue_ar', severity: 'danger',
        title: `AR เกินกำหนด: ${r.Customer_Name ?? ''}`,
        subtitle: `Invoice ${r.Invoice_No ?? ''} · Due ${r.Due_Date} · ${thb(r.Outstanding_Amount)}`,
        ref_id: r.Invoice_No, data: { ...r, Outstanding_Amount: n(r.Outstanding_Amount) },
      });
    }

    const counts = {
      low_stock: alerts.filter((a) => a.type === 'low_stock').length,
      overdue_ap: apRows.length,
      overdue_ar: arRows.length,
      total: alerts.length,
    };
    return { alerts, counts };
  }
}

@Controller('api/notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  @Permissions('dashboard', 'track', 'exec', 'cust_dash')
  list() {
    return this.svc.list();
  }
}

@Module({ controllers: [NotificationsController], providers: [NotificationsService] })
export class NotificationsModule {}
