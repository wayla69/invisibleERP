import { Inject, Injectable, Module, Controller, Get, Post, Patch, Param, Query, Body, NotFoundException, BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { sql, eq, and, ne, or, ilike, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { custPosSales, arInvoices, tenants, customerMaster, posMembers } from '../../database/schema';
import { n, ymd } from '../../database/queries';
import { DocNumberService } from '../../common/doc-number.service';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

@Injectable()
export class CustomersService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // GET /api/customers/{name} — key = tenant code (ไม่มี 404; คืน 0/ว่างถ้าไม่พบ)
  async detail(name: string) {
    const db = this.db;
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

// ── Unified customer master / customer-of-record (REV-14) ──────────────────────────────────────────
const CreateCustomerBody = z.object({
  name: z.string().min(1), kind: z.enum(['person', 'company']).default('person'),
  email: z.string().optional(), phone: z.string().optional(), tax_id: z.string().optional(),
  address: z.string().optional(), branch_code: z.string().optional(),
  member_id: z.number().int().optional(), account_code: z.string().optional(), notes: z.string().optional(),
  credit_terms: z.string().optional(), sales_rep: z.string().optional(), category: z.string().optional(),
  language: z.string().optional(), external_ref: z.string().optional(),
});
const LinkCustomerBody = z.object({ member_id: z.number().int().nullable().optional(), account_code: z.string().nullable().optional() });
// Direct-edit customer master profile (master-data audit Phase 3) — mirrors the vendor-profile direct-edit
// pattern (0270 follow-up): none of these fields carry the payment-redirection risk that vendor bank details
// do, so no maker-checker. member_id/account_code stay on the dedicated `link` endpoint (SoD-adjacent linkage).
const UpdateCustomerBody = z.object({
  name: z.string().min(1).optional(), kind: z.enum(['person', 'company']).optional(),
  email: z.string().nullish(), phone: z.string().nullish(), tax_id: z.string().nullish(),
  address: z.string().nullish(), branch_code: z.string().nullish(), status: z.enum(['active', 'inactive']).optional(),
  notes: z.string().nullish(), credit_terms: z.string().nullish(), sales_rep: z.string().nullish(),
  category: z.string().nullish(), language: z.string().nullish(), external_ref: z.string().nullish(),
});

@Injectable()
export class CustomerMasterService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly docNo: DocNumberService, private readonly customers: CustomersService) {}

  async create(dto: z.infer<typeof CreateCustomerBody>, user: JwtUser) {
    const db = this.db;
    const customerNo = await this.docNo.nextDaily('CUS');
    await db.insert(customerMaster).values({
      tenantId: user.tenantId ?? null, customerNo, name: dto.name, kind: dto.kind, email: dto.email ?? null,
      phone: dto.phone ?? null, taxId: dto.tax_id ?? null, address: dto.address ?? null, branchCode: dto.branch_code ?? null,
      memberId: dto.member_id ?? null, accountCode: dto.account_code ?? null,
      status: 'active', notes: dto.notes ?? null, createdBy: user.username,
      creditTerms: dto.credit_terms ?? null, salesRep: dto.sales_rep ?? null, category: dto.category ?? null,
      language: dto.language ?? 'th', externalRef: dto.external_ref ?? null,
    });
    return { customer_no: customerNo, name: dto.name, kind: dto.kind };
  }

  // Direct-edit (master-data audit Phase 3) — the only mutation path before this was create + the invoice-
  // upsert auto-refresh + link(); there was no way to correct/enrich a record through a web screen at all.
  async update(customerNo: string, dto: z.infer<typeof UpdateCustomerBody>, user: JwtUser) {
    const db = this.db;
    const c = await this.byNo(customerNo, user);
    const set: Record<string, unknown> = {};
    if (dto.name !== undefined) set.name = dto.name;
    if (dto.kind !== undefined) set.kind = dto.kind;
    if (dto.email !== undefined) set.email = dto.email || null;
    if (dto.phone !== undefined) set.phone = dto.phone || null;
    if (dto.tax_id !== undefined) set.taxId = dto.tax_id || null;
    if (dto.address !== undefined) set.address = dto.address || null;
    if (dto.branch_code !== undefined) set.branchCode = dto.branch_code || null;
    if (dto.status !== undefined) set.status = dto.status;
    if (dto.notes !== undefined) set.notes = dto.notes || null;
    if (dto.credit_terms !== undefined) set.creditTerms = dto.credit_terms || null;
    if (dto.sales_rep !== undefined) set.salesRep = dto.sales_rep || null;
    if (dto.category !== undefined) set.category = dto.category || null;
    if (dto.language !== undefined) set.language = dto.language || null;
    if (dto.external_ref !== undefined) set.externalRef = dto.external_ref || null;
    if (!Object.keys(set).length) throw new BadRequestException({ code: 'NO_FIELDS', message: 'No fields to update', messageTh: 'ไม่มีข้อมูลให้แก้ไข' });
    await db.update(customerMaster).set(set).where(eq(customerMaster.id, Number(c.id)));
    return this.get(customerNo, user);
  }

  // Called when a full tax invoice (ม.86/4) is issued for a buyer — keeps the master directory reusable
  // (name/tax_id/branch/address) without a separate "add customer" step. Dedup is by exact name match
  // within the tenant (customer_master has no strict unique-customer key today — see the table's own
  // "unifying two silos" note — tax_id can't be the dedup key since it's stored encrypted, not equality-
  // queryable; see database/encrypted-column.ts). An existing match's address/branch/tax-id are refreshed
  // from the invoice (the issuer is providing the current, authoritative info); a genuinely new buyer name
  // creates a new record. Best-effort: never blocks or fails invoice issuance.
  async upsertFromInvoiceBuyer(buyer: { name: string; tax_id?: string | null; address?: string | null; branch_code?: string | null }, tenantId: number | null, username: string) {
    const db = this.db;
    const name = buyer.name?.trim();
    if (!name) return;
    const conds = [eq(customerMaster.name, name)];
    if (tenantId != null) conds.push(eq(customerMaster.tenantId, tenantId));
    const [existing] = await db.select().from(customerMaster).where(and(...conds)).limit(1);
    if (existing) {
      const set: any = {};
      if (buyer.tax_id) set.taxId = buyer.tax_id;
      if (buyer.address) set.address = buyer.address;
      if (buyer.branch_code) set.branchCode = buyer.branch_code;
      if (Object.keys(set).length) await db.update(customerMaster).set(set).where(eq(customerMaster.id, Number(existing.id)));
      return;
    }
    const customerNo = await this.docNo.nextDaily('CUS');
    await db.insert(customerMaster).values({
      tenantId, customerNo, name, kind: 'company', taxId: buyer.tax_id ?? null,
      address: buyer.address ?? null, branchCode: buyer.branch_code ?? null,
      status: 'active', createdBy: username,
    });
  }

  async list(q: { search?: string }, _user: JwtUser) {
    const db = this.db;
    const where = q.search ? or(ilike(customerMaster.name, `%${q.search}%`), ilike(customerMaster.phone, `%${q.search}%`), ilike(customerMaster.email, `%${q.search}%`), ilike(customerMaster.customerNo, `%${q.search}%`)) : undefined;
    const rows = await db.select().from(customerMaster).where(where).orderBy(desc(customerMaster.id)).limit(200);
    return { customers: rows.map(shapeCustomer), count: rows.length };
  }

  private async byNo(customerNo: string, user: JwtUser) {
    const db = this.db;
    const conds = [eq(customerMaster.customerNo, customerNo)];
    if (user.tenantId != null) conds.push(eq(customerMaster.tenantId, user.tenantId));
    const [c] = await db.select().from(customerMaster).where(and(...conds)).limit(1);
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Customer not found', messageTh: 'ไม่พบลูกค้า' });
    return c;
  }

  async get(customerNo: string, user: JwtUser) {
    return shapeCustomer(await this.byNo(customerNo, user));
  }

  async link(customerNo: string, dto: z.infer<typeof LinkCustomerBody>, user: JwtUser) {
    const db = this.db;
    const c = await this.byNo(customerNo, user);
    const set: any = {};
    if (dto.member_id !== undefined) set.memberId = dto.member_id;
    if (dto.account_code !== undefined) set.accountCode = dto.account_code;
    await db.update(customerMaster).set(set).where(eq(customerMaster.id, Number(c.id)));
    return { customer_no: customerNo, ...dto };
  }

  // 360° view — the single customer-of-record joined to both silos: B2C loyalty (pos_members via member_id)
  // and B2B account (orders + AR via account_code, reusing the existing per-tenant detail).
  async view360(customerNo: string, user: JwtUser) {
    const db = this.db;
    const c = await this.byNo(customerNo, user);
    let loyalty: any = null;
    if (c.memberId != null) {
      const [m] = await db.select().from(posMembers).where(eq(posMembers.id, Number(c.memberId))).limit(1);
      if (m) loyalty = { member_code: m.memberCode, tier: m.tier, points_balance: n(m.balance), points_lifetime: n(m.lifetime), active: m.active !== false };
    }
    const b2b = c.accountCode ? await this.customers.detail(c.accountCode) : null;
    const arOutstanding = b2b ? n(b2b.ar_balance?.outstanding) : 0;
    const salesLifetime = b2b ? n(b2b.stats?.lifetime_value) : 0;
    return {
      customer: shapeCustomer(c),
      loyalty,
      b2b: b2b ? { account_code: c.accountCode, orders: b2b.orders, stats: b2b.stats, ar_balance: b2b.ar_balance } : null,
      summary: { ar_outstanding: arOutstanding, sales_lifetime: salesLifetime, has_loyalty: !!loyalty, has_account: !!b2b },
    };
  }
}

function shapeCustomer(c: any) {
  return {
    customer_no: c.customerNo, name: c.name, kind: c.kind, email: c.email, phone: c.phone, tax_id: c.taxId,
    address: c.address ?? null, branch_code: c.branchCode ?? null, member_id: c.memberId != null ? Number(c.memberId) : null,
    account_code: c.accountCode, status: c.status, notes: c.notes, created_by: c.createdBy, created_at: c.createdAt,
    credit_terms: c.creditTerms ?? null, sales_rep: c.salesRep ?? null, category: c.category ?? null,
    language: c.language ?? null, external_ref: c.externalRef ?? null,
  };
}

@Controller('api/customer-master')
@Permissions('crm', 'exec', 'ar')
export class CustomerMasterController {
  constructor(private readonly svc: CustomerMasterService) {}

  @Post() create(@Body(new ZodValidationPipe(CreateCustomerBody)) b: z.infer<typeof CreateCustomerBody>, @CurrentUser() u: JwtUser) { return this.svc.create(b, u); }
  @Get() list(@Query('search') search: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.list({ search }, u); }
  @Get(':customerNo') get(@Param('customerNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.get(no, u); }
  @Get(':customerNo/360') view360(@Param('customerNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.view360(no, u); }
  @Patch(':customerNo') update(@Param('customerNo') no: string, @Body(new ZodValidationPipe(UpdateCustomerBody)) b: z.infer<typeof UpdateCustomerBody>, @CurrentUser() u: JwtUser) { return this.svc.update(no, b, u); }
  @Patch(':customerNo/link') link(@Param('customerNo') no: string, @Body(new ZodValidationPipe(LinkCustomerBody)) b: z.infer<typeof LinkCustomerBody>, @CurrentUser() u: JwtUser) { return this.svc.link(no, b, u); }
}

@Module({ controllers: [CustomersController, CustomerMasterController], providers: [CustomersService, CustomerMasterService], exports: [CustomersService, CustomerMasterService] })
export class CustomersModule {}
