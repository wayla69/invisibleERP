import { Inject, Injectable, Module, Controller, Get, Query } from '@nestjs/common';
import { or, ilike, desc, asc } from 'drizzle-orm';
import { expandPermissions, type Permission } from '@ierp/shared';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { customerMaster, vendors, items } from '../../database/schema';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';

// ── Global "spotlight" search (GET /api/search?q=) ─────────────────────────────────────────────────
// A read-only omni-search that lets the ⌘K palette jump straight to a record (customer / vendor / product)
// by name/code, not just to a screen — the Paypers/PEAK-style "type a name, find the thing" experience.
//
// Tenant isolation is automatic (the per-request RLS transaction), so no manual tenant_id filter is needed.
// Per-ENTITY permission is enforced in-service against the caller's EXPANDED permissions, so a user only ever
// sees result types they could already open from the menu — the endpoint never widens anyone's data access.
// Additive + read-only ⇒ no migration, no GL, no control change.

export type SearchType = 'customer' | 'vendor' | 'item';
export interface SearchResult { type: SearchType; id: string; label: string; sublabel?: string; href: string }

const PER_TYPE = 6; // cap per entity so the palette stays scannable
const MIN_LEN = 2; // ignore 1-char noise

// Each entity's read permission set mirrors its existing list endpoint's @Permissions (any-of).
const CUSTOMER_PERMS: Permission[] = ['crm', 'exec', 'ar'];
const VENDOR_PERMS: Permission[] = ['procurement', 'warehouse', 'creditors', 'exec'];
const ITEM_PERMS: Permission[] = ['warehouse', 'dashboard', 'planner'];

@Injectable()
export class SearchService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async search(qRaw: string | undefined, user: JwtUser): Promise<{ results: SearchResult[]; count: number }> {
    const q = (qRaw ?? '').trim();
    if (q.length < MIN_LEN) return { results: [], count: 0 };
    const term = `%${q}%`;
    const db = this.db;

    // Expand once so a coarse holder (e.g. 'exec') is credited its sub-permissions, matching the menu/guards.
    const held = new Set<Permission>(expandPermissions((user.permissions ?? []) as Permission[]));
    const can = (req: Permission[]) => req.some((p) => held.has(p));

    const results: SearchResult[] = [];

    if (can(CUSTOMER_PERMS)) {
      const rows = await db
        .select({ no: customerMaster.customerNo, name: customerMaster.name, phone: customerMaster.phone })
        .from(customerMaster)
        .where(or(ilike(customerMaster.name, term), ilike(customerMaster.customerNo, term), ilike(customerMaster.email, term), ilike(customerMaster.phone, term)))
        .orderBy(desc(customerMaster.id))
        .limit(PER_TYPE);
      for (const r of rows as any[]) results.push({ type: 'customer', id: r.no, label: r.name, sublabel: [r.no, r.phone].filter(Boolean).join(' · ') || undefined, href: '/finance/customers' });
    }

    if (can(VENDOR_PERMS)) {
      const rows = await db
        .select({ code: vendors.vendorCode, name: vendors.name, contact: vendors.contact })
        .from(vendors)
        .where(or(ilike(vendors.name, term), ilike(vendors.vendorCode, term), ilike(vendors.contact, term), ilike(vendors.email, term)))
        .orderBy(asc(vendors.name))
        .limit(PER_TYPE);
      for (const r of rows as any[]) results.push({ type: 'vendor', id: r.code ?? r.name, label: r.name, sublabel: [r.code, r.contact].filter(Boolean).join(' · ') || undefined, href: '/inventory/suppliers' });
    }

    if (can(ITEM_PERMS)) {
      const rows = await db
        .select({ itemId: items.itemId, description: items.itemDescription, category: items.category })
        .from(items)
        .where(or(ilike(items.itemId, term), ilike(items.itemDescription, term), ilike(items.category, term)))
        .orderBy(asc(items.itemId))
        .limit(PER_TYPE);
      for (const r of rows as any[]) results.push({ type: 'item', id: r.itemId, label: r.description || r.itemId, sublabel: [r.itemId, r.category].filter(Boolean).join(' · ') || undefined, href: `/inventory/${encodeURIComponent(r.itemId)}` });
    }

    return { results, count: results.length };
  }
}

@Controller('api/search')
export class SearchController {
  constructor(private readonly svc: SearchService) {}

  // Guarded by the UNION of the per-entity perms, so a user with at least one result type can reach it; the
  // service then returns only the types that user is entitled to (per-type gate above).
  @Get()
  @Permissions('crm', 'exec', 'ar', 'procurement', 'warehouse', 'creditors', 'dashboard', 'planner')
  search(@Query('q') q: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.search(q, u);
  }
}

@Module({ controllers: [SearchController], providers: [SearchService] })
export class SearchModule {}
