import { Inject, Injectable, Module, Controller, Get, Query } from '@nestjs/common';
import { or, ilike, desc, asc, type SQL } from 'drizzle-orm';
import { expandPermissions, type Permission } from '@ierp/shared';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { customerMaster, vendors, items, custPosSales, arInvoices, taxInvoices, purchaseOrders } from '../../database/schema';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';

// ── Global "spotlight" search (GET /api/search?q=) ─────────────────────────────────────────────────
// A read-only omni-search that lets the ⌘K palette jump straight to a record by name/code/number, not just
// to a screen — the Paypers/PEAK-style "type a name, find the thing" experience. Covers the master data
// (customer / vendor / item) and the day-to-day documents (POS sale / AR invoice / tax invoice / PO).
//
// Tenant isolation is automatic (the per-request RLS transaction), so no manual tenant_id filter is needed.
// Per-ENTITY permission is enforced in-service against the caller's EXPANDED permissions, so a user only ever
// sees result types they could already open from the menu — the endpoint never widens anyone's data access.
// Additive + read-only ⇒ no migration, no GL, no control change.

export type SearchType = 'customer' | 'vendor' | 'item' | 'sale' | 'ar_invoice' | 'tax_invoice' | 'purchase_order';
export interface SearchResult { type: SearchType; id: string; label: string; sublabel?: string; href: string }

const PER_TYPE = 6; // cap per entity so the palette stays scannable
const MIN_LEN = 2; // ignore 1-char noise

const sub = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(' · ') || undefined;

// One entry per searchable entity. `perms` mirrors that entity's existing read endpoint's @Permissions
// (any-of); `run` does the tenant-scoped ILIKE query and maps rows to results. Document deep-links carry a
// `?q=` so the destination list can pre-filter to the record (item goes straight to its detail page).
interface EntitySpec {
  type: SearchType;
  perms: Permission[];
  run(db: DrizzleDb, term: string, limit: number): Promise<SearchResult[]>;
}

const ENTITIES: EntitySpec[] = [
  {
    type: 'customer',
    perms: ['crm', 'exec', 'ar'],
    run: async (db, term, limit) => {
      const rows = await db
        .select({ no: customerMaster.customerNo, name: customerMaster.name, phone: customerMaster.phone })
        .from(customerMaster)
        .where(or(ilike(customerMaster.name, term), ilike(customerMaster.customerNo, term), ilike(customerMaster.email, term), ilike(customerMaster.phone, term)) as SQL)
        .orderBy(desc(customerMaster.id))
        .limit(limit);
      return (rows as any[]).map((r) => ({ type: 'customer' as const, id: r.no, label: r.name, sublabel: sub(r.no, r.phone), href: '/finance/customers' }));
    },
  },
  {
    type: 'vendor',
    perms: ['procurement', 'warehouse', 'creditors', 'exec'],
    run: async (db, term, limit) => {
      const rows = await db
        .select({ code: vendors.vendorCode, name: vendors.name, contact: vendors.contact })
        .from(vendors)
        .where(or(ilike(vendors.name, term), ilike(vendors.vendorCode, term), ilike(vendors.contact, term), ilike(vendors.email, term)) as SQL)
        .orderBy(asc(vendors.name))
        .limit(limit);
      return (rows as any[]).map((r) => ({ type: 'vendor' as const, id: r.code ?? r.name, label: r.name, sublabel: sub(r.code, r.contact), href: '/inventory/suppliers' }));
    },
  },
  {
    type: 'item',
    perms: ['warehouse', 'dashboard', 'planner'],
    run: async (db, term, limit) => {
      const rows = await db
        .select({ itemId: items.itemId, description: items.itemDescription, category: items.category })
        .from(items)
        .where(or(ilike(items.itemId, term), ilike(items.itemDescription, term), ilike(items.category, term)) as SQL)
        .orderBy(asc(items.itemId))
        .limit(limit);
      return (rows as any[]).map((r) => ({ type: 'item' as const, id: r.itemId, label: r.description || r.itemId, sublabel: sub(r.itemId, r.category), href: `/inventory/${encodeURIComponent(r.itemId)}` }));
    },
  },
  {
    type: 'sale',
    perms: ['pos', 'order_mgt', 'dashboard'],
    run: async (db, term, limit) => {
      const rows = await db
        .select({ no: custPosSales.saleNo, date: custPosSales.saleDate, status: custPosSales.status })
        .from(custPosSales)
        .where(ilike(custPosSales.saleNo, term))
        .orderBy(desc(custPosSales.id))
        .limit(limit);
      return (rows as any[]).map((r) => ({ type: 'sale' as const, id: r.no, label: r.no, sublabel: sub(r.date, r.status), href: `/pos?q=${encodeURIComponent(r.no)}` }));
    },
  },
  {
    type: 'ar_invoice',
    perms: ['ar', 'exec'],
    run: async (db, term, limit) => {
      const rows = await db
        .select({ no: arInvoices.invoiceNo, orderNo: arInvoices.orderNo, status: arInvoices.status })
        .from(arInvoices)
        .where(or(ilike(arInvoices.invoiceNo, term), ilike(arInvoices.orderNo, term)) as SQL)
        .orderBy(desc(arInvoices.id))
        .limit(limit);
      return (rows as any[]).map((r) => ({ type: 'ar_invoice' as const, id: r.no, label: r.no, sublabel: sub(r.orderNo, r.status), href: '/finance?tab=receivables' }));
    },
  },
  {
    type: 'tax_invoice',
    perms: ['ar', 'pos', 'cust_pos'],
    run: async (db, term, limit) => {
      const rows = await db
        .select({ no: taxInvoices.docNo, buyer: taxInvoices.buyerName, ref: taxInvoices.sourceRef })
        .from(taxInvoices)
        .where(or(ilike(taxInvoices.docNo, term), ilike(taxInvoices.buyerName, term), ilike(taxInvoices.sourceRef, term)) as SQL)
        .orderBy(desc(taxInvoices.id))
        .limit(limit);
      return (rows as any[]).map((r) => ({ type: 'tax_invoice' as const, id: r.no, label: r.no, sublabel: sub(r.buyer, r.ref), href: '/tax/invoices' }));
    },
  },
  {
    type: 'purchase_order',
    perms: ['procurement', 'warehouse', 'dashboard'],
    run: async (db, term, limit) => {
      const rows = await db
        .select({ no: purchaseOrders.poNo, vendor: purchaseOrders.vendorName, status: purchaseOrders.status })
        .from(purchaseOrders)
        .where(or(ilike(purchaseOrders.poNo, term), ilike(purchaseOrders.vendorName, term)) as SQL)
        .orderBy(desc(purchaseOrders.id))
        .limit(limit);
      return (rows as any[]).map((r) => ({ type: 'purchase_order' as const, id: r.no, label: r.no, sublabel: sub(r.vendor, r.status), href: `/inventory/purchase-orders?q=${encodeURIComponent(r.no)}` }));
    },
  },
];

// The controller guard is the UNION of every entity's perms, so a user with at least one result type can
// reach the endpoint; the service then runs only the entities that user is entitled to.
const ALL_PERMS = [...new Set(ENTITIES.flatMap((e) => e.perms))] as Permission[];

@Injectable()
export class SearchService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async search(qRaw: string | undefined, user: JwtUser): Promise<{ results: SearchResult[]; count: number }> {
    const q = (qRaw ?? '').trim();
    if (q.length < MIN_LEN) return { results: [], count: 0 };
    const term = `%${q}%`;

    // Expand once so a coarse holder (e.g. 'exec') is credited its sub-permissions, matching the menu/guards.
    const held = new Set<Permission>(expandPermissions((user.permissions ?? []) as Permission[]));
    const can = (req: Permission[]) => req.some((p) => held.has(p));

    const allowed = ENTITIES.filter((e) => can(e.perms));
    const batches = await Promise.all(allowed.map((e) => e.run(this.db, term, PER_TYPE)));
    const results = batches.flat();
    return { results, count: results.length };
  }
}

@Controller('api/search')
export class SearchController {
  constructor(private readonly svc: SearchService) {}

  @Get()
  @Permissions(...ALL_PERMS)
  search(@Query('q') q: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.search(q, u);
  }
}

@Module({ controllers: [SearchController], providers: [SearchService] })
export class SearchModule {}
