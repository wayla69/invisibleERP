import { Inject, Injectable, Module, Controller, Get, Param } from '@nestjs/common';
import { sql, eq, and, ne, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { custPosSales, arInvoices, tenants } from '../../database/schema';
import { n } from '../../database/queries';
import { Permissions } from '../../common/decorators';

@Injectable()
export class CustomersService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // GET /api/customers/{name} — key = tenant code (ไม่มี 404; คืน 0/ว่างถ้าไม่พบ)
  async detail(name: string) {
    const db = this.db as any;
    const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, name)).limit(1);
    const tid = tenant?.id ?? -1;

    // orders: ทุกสถานะ (รวม Voided)
    const orders = await db.select({
      Sale_No: custPosSales.saleNo, Sale_Date: custPosSales.saleDate, Total: custPosSales.total,
      Payment_Method: custPosSales.paymentMethod, Status: custPosSales.status,
    }).from(custPosSales).where(eq(custPosSales.tenantId, tid))
      .orderBy(desc(custPosSales.saleDate), desc(custPosSales.saleNo)).limit(20);

    // stats: non-Voided
    const [stats] = await db.select({
      lifetime_value: sql<string>`coalesce(sum(${custPosSales.total}),0)`,
      order_count: sql<string>`count(*)`,
      last_order_date: sql<string>`max(${custPosSales.saleDate})`,
      first_order_date: sql<string>`min(${custPosSales.saleDate})`,
    }).from(custPosSales).where(and(eq(custPosSales.tenantId, tid), ne(custPosSales.status, 'Voided')));

    const [ar] = await db.select({
      outstanding: sql<string>`coalesce(sum(${arInvoices.amount} - coalesce(${arInvoices.paidAmount},0)),0)`,
      open_invoices: sql<string>`count(*)`,
    }).from(arInvoices).where(and(eq(arInvoices.tenantId, tid), sql`${arInvoices.status}::text <> 'Paid'`));

    return {
      customer_name: name,
      orders: orders.map((o: any) => ({ ...o, Total: n(o.Total) })),
      stats: {
        lifetime_value: n(stats?.lifetime_value), order_count: n(stats?.order_count),
        last_order_date: stats?.last_order_date ?? null, first_order_date: stats?.first_order_date ?? null,
      },
      ar_balance: { outstanding: n(ar?.outstanding), open_invoices: n(ar?.open_invoices) },
    };
  }
}

@Controller('api/customers')
export class CustomersController {
  constructor(private readonly svc: CustomersService) {}

  @Get(':name')
  @Permissions('crm', 'dashboard', 'ar')
  detail(@Param('name') name: string) {
    return this.svc.detail(name);
  }
}

@Module({ controllers: [CustomersController], providers: [CustomersService] })
export class CustomersModule {}
