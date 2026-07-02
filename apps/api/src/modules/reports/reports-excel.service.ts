import { Inject, Injectable } from '@nestjs/common';
import { sql, eq, ne, and, gte, lt, asc, lte } from 'drizzle-orm';
import * as ExcelJS from 'exceljs';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { custPosSales, stockSnapshots, tenants, apTransactions } from '../../database/schema';
import { latestSnapshotDate, ymd, n } from '../../database/queries';

const HEADER_FILL = 'FF1E3C72'; // brand navy (ARGB)
const HEADER_FONT = 'FFFFFFFF'; // white (ARGB)

// ใบรายงาน Excel — สร้างด้วย exceljs, header แถบสีน้ำเงินตัวหนาขาว
@Injectable()
export class ReportExcelService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // GET /api/reports/daily-sales/export — ยอดขายรายวัน (ตัด Voided)
  async dailySalesXlsx(date?: string): Promise<Buffer> {
    const db = this.db;
    const d = date ?? ymd();
    const rows = await db
      .select({
        Sale_No: custPosSales.saleNo,
        Sale_Date: custPosSales.saleDate,
        Customer_Name: tenants.code,
        Subtotal: custPosSales.subtotal,
        Discount: custPosSales.discount,
        Tax_Amount: custPosSales.taxAmount,
        Total: custPosSales.total,
        Payment_Method: custPosSales.paymentMethod,
        Status: custPosSales.status,
      })
      .from(custPosSales)
      .leftJoin(tenants, eq(custPosSales.tenantId, tenants.id))
      .where(and(eq(custPosSales.saleDate, d), ne(custPosSales.status, 'Voided')))
      .orderBy(asc(custPosSales.saleNo));

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Invisible ERP';
    wb.created = new Date();
    const ws = wb.addWorksheet('Daily Sales');

    ws.columns = [
      { header: 'Sale No', key: 'saleNo', width: 24 },
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Customer', key: 'customer', width: 28 },
      { header: 'Subtotal', key: 'subtotal', width: 14 },
      { header: 'Discount', key: 'discount', width: 14 },
      { header: 'Tax', key: 'tax', width: 14 },
      { header: 'Total', key: 'total', width: 14 },
      { header: 'Payment', key: 'payment', width: 16 },
      { header: 'Status', key: 'status', width: 14 },
    ];

    this.styleHeader(ws);

    for (const r of rows) {
      ws.addRow({
        saleNo: r.Sale_No,
        date: r.Sale_Date,
        customer: r.Customer_Name ?? '-',
        subtotal: n(r.Subtotal),
        discount: n(r.Discount),
        tax: n(r.Tax_Amount),
        total: n(r.Total),
        payment: r.Payment_Method,
        status: r.Status,
      });
    }

    // total row
    const totalSum = rows.reduce((a: number, r: any) => a + n(r.Total), 0);
    const totalRow = ws.addRow({ customer: 'TOTAL', total: Math.round(totalSum * 100) / 100 });
    totalRow.font = { bold: true };

    this.formatMoneyColumns(ws, ['subtotal', 'discount', 'tax', 'total']);
    return this.toBuffer(wb);
  }

  // GET /api/reports/monthly-pl/export — รวมรายได้ต่อวันในเดือน
  async monthlyPlXlsx(month: number, year: number): Promise<Buffer> {
    const db = this.db;
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const end = month < 12 ? `${year}-${String(month + 1).padStart(2, '0')}-01` : `${year + 1}-01-01`;
    const inWin = and(ne(custPosSales.status, 'Voided'), gte(custPosSales.saleDate, start), lt(custPosSales.saleDate, end));

    const rows = await db
      .select({
        Sale_Date: custPosSales.saleDate,
        order_count: sql<string>`count(*)`,
        subtotal: sql<string>`coalesce(sum(${custPosSales.subtotal}),0)`,
        discount: sql<string>`coalesce(sum(${custPosSales.discount}),0)`,
        tax: sql<string>`coalesce(sum(${custPosSales.taxAmount}),0)`,
        total: sql<string>`coalesce(sum(${custPosSales.total}),0)`,
      })
      .from(custPosSales)
      .where(inWin)
      .groupBy(custPosSales.saleDate)
      .orderBy(asc(custPosSales.saleDate));

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Invisible ERP';
    wb.created = new Date();
    const ws = wb.addWorksheet('Monthly P&L');

    ws.columns = [
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Orders', key: 'orders', width: 12 },
      { header: 'Subtotal', key: 'subtotal', width: 16 },
      { header: 'Discount', key: 'discount', width: 16 },
      { header: 'Tax', key: 'tax', width: 16 },
      { header: 'Revenue', key: 'revenue', width: 16 },
    ];

    this.styleHeader(ws);

    let totOrders = 0;
    let totSubtotal = 0;
    let totDiscount = 0;
    let totTax = 0;
    let totRevenue = 0;
    for (const r of rows) {
      totOrders += n(r.order_count);
      totSubtotal += n(r.subtotal);
      totDiscount += n(r.discount);
      totTax += n(r.tax);
      totRevenue += n(r.total);
      ws.addRow({
        date: r.Sale_Date,
        orders: n(r.order_count),
        subtotal: n(r.subtotal),
        discount: n(r.discount),
        tax: n(r.tax),
        revenue: n(r.total),
      });
    }

    const totalRow = ws.addRow({
      date: 'TOTAL',
      orders: totOrders,
      subtotal: round2(totSubtotal),
      discount: round2(totDiscount),
      tax: round2(totTax),
      revenue: round2(totRevenue),
    });
    totalRow.font = { bold: true };

    this.formatMoneyColumns(ws, ['subtotal', 'discount', 'tax', 'revenue']);
    return this.toBuffer(wb);
  }

  // GET /api/reports/ap-aging/export — open AP bucketed by days overdue
  async apAgingXlsx(): Promise<Buffer> {
    const db = this.db;
    const today = ymd();
    const rows = await db.select({
      txn: apTransactions.txnNo, vendor: apTransactions.vendorName, due: apTransactions.dueDate,
      outstanding: sql<string>`${apTransactions.amount} - coalesce(${apTransactions.paidAmount},0)`,
    }).from(apTransactions).where(sql`${apTransactions.status}::text <> 'Paid'`);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Invisible ERP';
    wb.created = new Date();
    const ws = wb.addWorksheet('AP Aging');
    ws.columns = [
      { header: 'Txn No', key: 'txn', width: 22 },
      { header: 'Vendor', key: 'vendor', width: 28 },
      { header: 'Due Date', key: 'due', width: 14 },
      { header: 'Days Overdue', key: 'days', width: 14 },
      { header: 'Bucket', key: 'bucket', width: 12 },
      { header: 'Outstanding', key: 'amt', width: 16 },
    ];
    this.styleHeader(ws);
    let tot = 0;
    for (const r of rows) {
      const out = n(r.outstanding);
      if (out <= 0.0001) continue;
      const overdue = r.due ? Math.round((Date.parse(today) - Date.parse(String(r.due))) / 86400000) : 0;
      const bucket = overdue <= 0 ? 'Current' : overdue <= 30 ? '1-30' : overdue <= 60 ? '31-60' : overdue <= 90 ? '61-90' : '90+';
      tot += out;
      ws.addRow({ txn: r.txn, vendor: r.vendor ?? '-', due: r.due, days: Math.max(0, overdue), bucket, amt: out });
    }
    const tr = ws.addRow({ vendor: 'TOTAL', amt: round2(tot) });
    tr.font = { bold: true };
    this.formatMoneyColumns(ws, ['amt']);
    return this.toBuffer(wb);
  }

  // GET /api/reports/stock-summary/export — snapshot ล่าสุด, low → av_qty<=0
  async stockSummaryXlsx(lowOnly = false): Promise<Buffer> {
    const db = this.db;
    const snap = await latestSnapshotDate(db);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Invisible ERP';
    wb.created = new Date();
    const ws = wb.addWorksheet('Stock Summary');

    ws.columns = [
      { header: 'Item ID', key: 'itemId', width: 18 },
      { header: 'Description', key: 'desc', width: 36 },
      { header: 'UOM', key: 'uom', width: 12 },
      { header: 'Available Qty', key: 'avQty', width: 16 },
      { header: 'Total Stock', key: 'totalStock', width: 16 },
      { header: 'Temperature', key: 'temp', width: 16 },
      { header: 'Expiry Date', key: 'expiry', width: 16 },
    ];

    this.styleHeader(ws);

    if (snap) {
      const where = lowOnly
        ? and(eq(stockSnapshots.generateDate, snap), lte(stockSnapshots.avQty, '0'))
        : eq(stockSnapshots.generateDate, snap);
      const items = await db
        .select({
          Item_ID: stockSnapshots.itemId,
          Item_Description: stockSnapshots.itemDescription,
          UOM: stockSnapshots.uom,
          AV_QTY: stockSnapshots.avQty,
          Total_Stock: stockSnapshots.totalStock,
          Temperature_Type: stockSnapshots.temperatureType,
          Expiry_Date: stockSnapshots.expiryDate,
        })
        .from(stockSnapshots)
        .where(where)
        .orderBy(asc(stockSnapshots.itemDescription));

      for (const it of items) {
        ws.addRow({
          itemId: it.Item_ID,
          desc: it.Item_Description ?? '-',
          uom: it.UOM ?? '-',
          avQty: n(it.AV_QTY),
          totalStock: n(it.Total_Stock),
          temp: it.Temperature_Type ?? '-',
          expiry: it.Expiry_Date ?? '-',
        });
      }
    }

    this.formatMoneyColumns(ws, ['avQty', 'totalStock']);
    return this.toBuffer(wb);
  }

  // ── helpers ─────────────────────────────────────────────────────────
  private styleHeader(ws: ExcelJS.Worksheet) {
    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: HEADER_FONT } };
    header.alignment = { vertical: 'middle', horizontal: 'left' };
    header.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    });
    header.height = 20;
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  private formatMoneyColumns(ws: ExcelJS.Worksheet, keys: string[]) {
    for (const key of keys) {
      const col = ws.getColumn(key);
      col.numFmt = '#,##0.00';
    }
  }

  private async toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
    const ab = await wb.xlsx.writeBuffer();
    return Buffer.from(ab as ArrayBuffer);
  }
}

function round2(x: number) {
  return Math.round(x * 100) / 100;
}
