import { Inject, Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { z } from 'zod';
import { sql, eq, and, ne, or, ilike, desc, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { customerMaster, posMembers, customerAddresses, customerContacts, dataChangeLog, customerRelationships } from '../../database/schema';
import { n } from '../../database/queries';
import { DocNumberService } from '../../common/doc-number.service';
import { type JwtUser } from '../../common/decorators';
import { isUniqueViolation } from '../../common/db-error';
import { nameSimilarity, normalizeKey } from '../../common/text-similarity';
import { shapeChangeHistory } from '../../common/change-history';
import { isValidPostalCode, normalizeProvince } from '../../common/thai-address';
import { CustomersService } from './customers.service';

// docs/46 Phase 5 — split VERBATIM out of the single-file customers.module.ts (service/controller/module
// convention; no DI or behaviour change). The zod request bodies are exported for the controller.
// ── Unified customer master / customer-of-record (REV-14) ──────────────────────────────────────────
export const CreateCustomerBody = z.object({
  name: z.string().min(1), kind: z.enum(['person', 'company']).default('person'),
  email: z.string().optional(), phone: z.string().optional(), tax_id: z.string().optional(),
  address: z.string().optional(), branch_code: z.string().optional(),
  member_id: z.number().int().optional(), account_code: z.string().optional(), notes: z.string().optional(),
  credit_terms: z.string().optional(), sales_rep: z.string().optional(), category: z.string().optional(),
  language: z.string().optional(), external_ref: z.string().optional(),
});
export const LinkCustomerBody = z.object({ member_id: z.number().int().nullable().optional(), account_code: z.string().nullable().optional() });
// Party-model depth (master-data audit Phase 4) — a customer can carry more than one address/contact
// (previously exactly one scalar each), plus an optional pointer at its parent company for consolidated
// credit/reporting.
export const AddressBody = z.object({
  address_type: z.enum(['billing', 'shipping', 'registered', 'other']).default('other'),
  address_line1: z.string().optional(), address_line2: z.string().optional(),
  sub_district: z.string().optional(), district: z.string().optional(), province: z.string().optional(), postal_code: z.string().optional(),
  is_primary: z.boolean().optional(),
});
export const ContactBody = z.object({
  name: z.string().min(1), title: z.string().optional(), phone: z.string().optional(), email: z.string().optional(),
  notes: z.string().optional(), is_primary: z.boolean().optional(),
});
export const ParentBody = z.object({ parent_customer_no: z.string().nullable() });
export const MergeCustomerBody = z.object({ duplicate_customer_no: z.string().min(1) });
// Typed party relationships (master-data audit Phase 8) — directional (this customer → target), typed.
export const CUSTOMER_REL_TYPES = ['bill_to', 'ship_to', 'sold_to', 'guarantor', 'related_party', 'subsidiary', 'franchisee', 'other'] as const;
export const RelationshipBody = z.object({
  to_customer_no: z.string().min(1),
  rel_type: z.enum(CUSTOMER_REL_TYPES).default('related_party'),
  note: z.string().optional(),
});
// Direct-edit customer master profile (master-data audit Phase 3) — mirrors the vendor-profile direct-edit
// pattern (0270 follow-up): none of these fields carry the payment-redirection risk that vendor bank details
// do, so no maker-checker. member_id/account_code stay on the dedicated `link` endpoint (SoD-adjacent linkage).
export const UpdateCustomerBody = z.object({
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
    const [addresses, contacts, parent] = await Promise.all([
      this.listAddresses(customerNo, user),
      this.listContacts(customerNo, user),
      c.parentCustomerNo ? this.get(c.parentCustomerNo, user).catch(() => null) : null,
    ]);
    return {
      customer: shapeCustomer(c),
      loyalty,
      b2b: b2b ? { account_code: c.accountCode, orders: b2b.orders, stats: b2b.stats, ar_balance: b2b.ar_balance } : null,
      summary: { ar_outstanding: arOutstanding, sales_lifetime: salesLifetime, has_loyalty: !!loyalty, has_account: !!b2b },
      addresses: addresses.addresses, contacts: contacts.contacts,
      parent: parent ? { customer_no: parent.customer_no, name: parent.name } : null,
    };
  }

  // ── Party-model depth (master-data audit Phase 4): multi-address / multi-contact / parent company ──
  async setParent(customerNo: string, dto: z.infer<typeof ParentBody>, user: JwtUser) {
    const db = this.db;
    const c = await this.byNo(customerNo, user);
    if (dto.parent_customer_no === customerNo) throw new BadRequestException({ code: 'SELF_PARENT', message: 'A customer cannot be its own parent', messageTh: 'ลูกค้าไม่สามารถเป็นบริษัทแม่ของตัวเองได้' });
    if (dto.parent_customer_no) await this.byNo(dto.parent_customer_no, user); // validates it exists in this tenant
    await db.update(customerMaster).set({ parentCustomerNo: dto.parent_customer_no }).where(eq(customerMaster.id, Number(c.id)));
    return this.get(customerNo, user);
  }

  async addAddress(customerNo: string, dto: z.infer<typeof AddressBody>, user: JwtUser) {
    const db = this.db;
    const c = await this.byNo(customerNo, user);
    // Thai address standardization (Phase 7): postal code must be 5 digits; province is canonicalised to its
    // official name when recognised (else kept as entered — data migration carries messy values).
    if (dto.postal_code && !isValidPostalCode(dto.postal_code)) throw new BadRequestException({ code: 'POSTAL_INVALID', message: 'Postal code must be 5 digits', messageTh: 'รหัสไปรษณีย์ต้องเป็นตัวเลข 5 หลัก' });
    const province = dto.province ? (normalizeProvince(dto.province) ?? dto.province) : null;
    if (dto.is_primary) await db.update(customerAddresses).set({ isPrimary: false }).where(eq(customerAddresses.customerId, Number(c.id)));
    const [row] = await db.insert(customerAddresses).values({
      tenantId: c.tenantId ?? null, customerId: Number(c.id), addressType: dto.address_type,
      addressLine1: dto.address_line1 ?? null, addressLine2: dto.address_line2 ?? null,
      subDistrict: dto.sub_district ?? null, district: dto.district ?? null, province, postalCode: dto.postal_code ?? null,
      isPrimary: dto.is_primary ?? false, createdBy: user.username,
    }).returning();
    return shapeAddress(row);
  }

  async listAddresses(customerNo: string, user: JwtUser) {
    const db = this.db;
    const c = await this.byNo(customerNo, user);
    const rows = await db.select().from(customerAddresses).where(eq(customerAddresses.customerId, Number(c.id))).orderBy(desc(customerAddresses.isPrimary), desc(customerAddresses.id));
    return { addresses: rows.map(shapeAddress), count: rows.length };
  }

  async deleteAddress(customerNo: string, addressId: number, user: JwtUser) {
    const db = this.db;
    const c = await this.byNo(customerNo, user);
    const del = await db.delete(customerAddresses).where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, Number(c.id)))).returning({ id: customerAddresses.id });
    if (!del.length) throw new NotFoundException({ code: 'ADDRESS_NOT_FOUND', message: 'Address not found', messageTh: 'ไม่พบที่อยู่นี้' });
    return { deleted: true };
  }

  async addContact(customerNo: string, dto: z.infer<typeof ContactBody>, user: JwtUser) {
    const db = this.db;
    const c = await this.byNo(customerNo, user);
    if (dto.is_primary) await db.update(customerContacts).set({ isPrimary: false }).where(eq(customerContacts.customerId, Number(c.id)));
    const [row] = await db.insert(customerContacts).values({
      tenantId: c.tenantId ?? null, customerId: Number(c.id), name: dto.name, title: dto.title ?? null,
      phone: dto.phone ?? null, email: dto.email ?? null, notes: dto.notes ?? null, isPrimary: dto.is_primary ?? false, createdBy: user.username,
    }).returning();
    return shapeContact(row);
  }

  async listContacts(customerNo: string, user: JwtUser) {
    const db = this.db;
    const c = await this.byNo(customerNo, user);
    const rows = await db.select().from(customerContacts).where(eq(customerContacts.customerId, Number(c.id))).orderBy(desc(customerContacts.isPrimary), desc(customerContacts.id));
    return { contacts: rows.map(shapeContact), count: rows.length };
  }

  async deleteContact(customerNo: string, contactId: number, user: JwtUser) {
    const db = this.db;
    const c = await this.byNo(customerNo, user);
    const del = await db.delete(customerContacts).where(and(eq(customerContacts.id, contactId), eq(customerContacts.customerId, Number(c.id)))).returning({ id: customerContacts.id });
    if (!del.length) throw new NotFoundException({ code: 'CONTACT_NOT_FOUND', message: 'Contact not found', messageTh: 'ไม่พบผู้ติดต่อนี้' });
    return { deleted: true };
  }

  // ── Match-merge / DQM (master-data audit Phase 5) ────────────────────────────────────────────────
  // Detect probable duplicate customers within the tenant: exact tax-id/email/phone signals plus fuzzy
  // name similarity (app-side trigram — pg_trgm isn't enabled here). Read-only steward review queue.
  async findDuplicates(user: JwtUser) {
    const db = this.db;
    const conds = [ne(customerMaster.status, 'merged')];
    if (user.tenantId != null) conds.push(eq(customerMaster.tenantId, user.tenantId));
    const rows = await db.select().from(customerMaster).where(and(...conds)).orderBy(desc(customerMaster.id)).limit(1000);
    const used = new Set<number>();
    const groups: any[] = [];
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i]; if (!a || used.has(Number(a.id))) continue;
      const dups: any[] = [];
      for (let j = i + 1; j < rows.length; j++) {
        const b = rows[j]; if (!b || used.has(Number(b.id))) continue;
        const reasons: string[] = [];
        if (a.taxId && b.taxId && normalizeKey(a.taxId) === normalizeKey(b.taxId)) reasons.push('tax_id');
        if (a.email && b.email && normalizeKey(a.email) === normalizeKey(b.email)) reasons.push('email');
        if (a.phone && b.phone && normalizeKey(a.phone) === normalizeKey(b.phone)) reasons.push('phone');
        const score = nameSimilarity(a.name, b.name);
        if (score >= 0.6) reasons.push('name');
        if (reasons.length) { dups.push({ ...shapeCustomer(b), score: Math.round(score * 100) / 100, reasons }); used.add(Number(b.id)); }
      }
      if (dups.length) { used.add(Number(a.id)); groups.push({ primary: shapeCustomer(a), duplicates: dups }); }
    }
    return { groups, count: groups.length };
  }

  // Merge a duplicate customer INTO a survivor: repoint the duplicate's child rows (addresses/contacts/…)
  // to the survivor, fill any blank survivor field from the duplicate (survivorship), and soft-retire the
  // duplicate (status='merged' + merged_into/by/at). Atomic — a unique-key collision rolls back and surfaces
  // MERGE_CONFLICT for manual steward resolution. Consequential + audited, so gated to steward duties.
  async merge(survivorNo: string, duplicateNo: string, user: JwtUser) {
    if (survivorNo === duplicateNo) throw new BadRequestException({ code: 'SELF_MERGE', message: 'Cannot merge a customer into itself', messageTh: 'ไม่สามารถรวมลูกค้าเข้ากับตัวเองได้' });
    const survivor = await this.byNo(survivorNo, user);
    const dup = await this.byNo(duplicateNo, user);
    if (dup.status === 'merged') throw new BadRequestException({ code: 'ALREADY_MERGED', message: 'Duplicate is already merged', messageTh: 'รายการนี้ถูกรวมไปแล้ว' });
    const db = this.db;
    try {
      await db.transaction(async (tx: any) => {
        await tx.execute(sql`SELECT md_merge_repoint('customer_id', 'customer_master', ${Number(survivor.id)}, ${Number(dup.id)})`);
        // re-parent any subsidiaries that pointed at the duplicate
        await tx.update(customerMaster).set({ parentCustomerNo: survivor.customerNo }).where(eq(customerMaster.parentCustomerNo, dup.customerNo));
        const fill: Record<string, unknown> = {};
        const pick = (k: string, s: unknown, d: unknown) => { if ((s === null || s === undefined || s === '') && d !== null && d !== undefined && d !== '') fill[k] = d; };
        pick('email', survivor.email, dup.email); pick('phone', survivor.phone, dup.phone); pick('taxId', survivor.taxId, dup.taxId);
        pick('address', survivor.address, dup.address); pick('branchCode', survivor.branchCode, dup.branchCode);
        pick('memberId', survivor.memberId, dup.memberId); pick('accountCode', survivor.accountCode, dup.accountCode);
        pick('creditTerms', survivor.creditTerms, dup.creditTerms); pick('salesRep', survivor.salesRep, dup.salesRep);
        pick('category', survivor.category, dup.category); pick('externalRef', survivor.externalRef, dup.externalRef);
        if (Object.keys(fill).length) await tx.update(customerMaster).set(fill).where(eq(customerMaster.id, Number(survivor.id)));
        await tx.update(customerMaster).set({ status: 'merged', mergedInto: Number(survivor.id), mergedBy: user.username, mergedAt: new Date() }).where(eq(customerMaster.id, Number(dup.id)));
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException({ code: 'MERGE_CONFLICT', message: 'Survivor and duplicate both own a row with the same key — resolve manually', messageTh: 'ข้อมูลลูกค้าทั้งสองมีรายการที่ซ้ำกัน กรุณาแก้ไขก่อนรวม' });
      throw e;
    }
    return { survivor_no: survivorNo, merged_no: duplicateNo, merged: true };
  }

  // ── Change history (master-data audit Phase 6) — the append-only field-level trail (ITGC-AC-14) for this
  // customer + its address/contact children, captured by the DB trigger (0274). Read-only, tenant-scoped.
  async history(customerNo: string, user: JwtUser) {
    const db = this.db;
    const c = await this.byNo(customerNo, user);
    const cid = String(c.id);
    const conds = [
      or(
        and(eq(dataChangeLog.tableName, 'customer_master'), eq(dataChangeLog.rowPk, cid)),
        and(inArray(dataChangeLog.tableName, ['customer_addresses', 'customer_contacts']),
          sql`coalesce(${dataChangeLog.newValue}->>'customer_id', ${dataChangeLog.oldValue}->>'customer_id') = ${cid}`),
      ),
    ];
    if (user.tenantId != null) conds.push(eq(dataChangeLog.tenantRef, user.tenantId));
    const rows = await db.select().from(dataChangeLog).where(and(...conds)).orderBy(desc(dataChangeLog.ts)).limit(200);
    return { customer_no: customerNo, history: shapeChangeHistory(rows), count: rows.length };
  }

  // ── Typed party relationships (master-data audit Phase 8) ────────────────────────────────────────
  async addRelationship(customerNo: string, dto: z.infer<typeof RelationshipBody>, user: JwtUser) {
    const db = this.db;
    const from = await this.byNo(customerNo, user);
    if (dto.to_customer_no === customerNo) throw new BadRequestException({ code: 'SELF_RELATION', message: 'A customer cannot relate to itself', messageTh: 'ลูกค้าไม่สามารถเชื่อมโยงกับตัวเองได้' });
    const to = await this.byNo(dto.to_customer_no, user); // validates existence in tenant
    try {
      const [row] = await db.insert(customerRelationships).values({
        tenantId: from.tenantId ?? null, fromCustomerId: Number(from.id), toCustomerId: Number(to.id),
        relType: dto.rel_type, note: dto.note ?? null, createdBy: user.username,
      }).returning();
      return shapeRelationship(row, { customer_no: to.customerNo, name: to.name }, 'outgoing');
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException({ code: 'RELATION_EXISTS', message: 'This relationship already exists', messageTh: 'มีความสัมพันธ์นี้อยู่แล้ว' });
      throw e;
    }
  }

  async listRelationships(customerNo: string, user: JwtUser) {
    const db = this.db;
    const c = await this.byNo(customerNo, user);
    const cid = Number(c.id);
    const toM = alias(customerMaster, 'to_m');
    const fromM = alias(customerMaster, 'from_m');
    const outgoing = await db.select({ r: customerRelationships, no: toM.customerNo, name: toM.name })
      .from(customerRelationships).innerJoin(toM, eq(customerRelationships.toCustomerId, toM.id))
      .where(eq(customerRelationships.fromCustomerId, cid)).orderBy(desc(customerRelationships.id));
    const incoming = await db.select({ r: customerRelationships, no: fromM.customerNo, name: fromM.name })
      .from(customerRelationships).innerJoin(fromM, eq(customerRelationships.fromCustomerId, fromM.id))
      .where(eq(customerRelationships.toCustomerId, cid)).orderBy(desc(customerRelationships.id));
    return {
      customer_no: customerNo,
      relationships: [
        ...outgoing.map((x: any) => shapeRelationship(x.r, { customer_no: x.no, name: x.name }, 'outgoing')),
        ...incoming.map((x: any) => shapeRelationship(x.r, { customer_no: x.no, name: x.name }, 'incoming')),
      ],
    };
  }

  async deleteRelationship(customerNo: string, relId: number, user: JwtUser) {
    const db = this.db;
    const c = await this.byNo(customerNo, user);
    const del = await db.delete(customerRelationships)
      .where(and(eq(customerRelationships.id, relId), or(eq(customerRelationships.fromCustomerId, Number(c.id)), eq(customerRelationships.toCustomerId, Number(c.id)))))
      .returning({ id: customerRelationships.id });
    if (!del.length) throw new NotFoundException({ code: 'RELATION_NOT_FOUND', message: 'Relationship not found', messageTh: 'ไม่พบความสัมพันธ์นี้' });
    return { deleted: true };
  }
}

function shapeRelationship(r: any, other: { customer_no: string; name: string }, direction: 'outgoing' | 'incoming') {
  return { id: Number(r.id), rel_type: r.relType, direction, party: other, note: r.note ?? null, created_by: r.createdBy, created_at: r.createdAt };
}

function shapeAddress(a: any) {
  return {
    id: Number(a.id), address_type: a.addressType, address_line1: a.addressLine1 ?? null, address_line2: a.addressLine2 ?? null,
    sub_district: a.subDistrict ?? null, district: a.district ?? null, province: a.province ?? null, postal_code: a.postalCode ?? null,
    is_primary: a.isPrimary === true, created_by: a.createdBy, created_at: a.createdAt,
  };
}
function shapeContact(c: any) {
  return { id: Number(c.id), name: c.name, title: c.title ?? null, phone: c.phone ?? null, email: c.email ?? null, notes: c.notes ?? null, is_primary: c.isPrimary === true, created_by: c.createdBy, created_at: c.createdAt };
}

function shapeCustomer(c: any) {
  return {
    customer_no: c.customerNo, name: c.name, kind: c.kind, email: c.email, phone: c.phone, tax_id: c.taxId,
    address: c.address ?? null, branch_code: c.branchCode ?? null, member_id: c.memberId != null ? Number(c.memberId) : null,
    account_code: c.accountCode, status: c.status, notes: c.notes, created_by: c.createdBy, created_at: c.createdAt,
    credit_terms: c.creditTerms ?? null, sales_rep: c.salesRep ?? null, category: c.category ?? null,
    language: c.language ?? null, external_ref: c.externalRef ?? null, parent_customer_no: c.parentCustomerNo ?? null,
    merged_into: c.mergedInto != null ? Number(c.mergedInto) : null,
  };
}
