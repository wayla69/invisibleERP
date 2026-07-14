import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { cpqPricebooks, cpqPricebookEntries } from '../../database/schema/cpq';
import { n, fx, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

// CRM-15 CPQ pricebooks (control CRM-15, migration 0408) — governed, effective-dated price lists a quote can be
// priced FROM. Master data (created under the `masterdata` duty). At quote time, a selected pricebook is
// validated (tenant + active + effective window) and each line's unit price resolves from the book's entry for
// that item code; the resulting price still flows through the CPQ-01 margin floor. A plain DI service (not
// appended to CpqService) so the CPQ facade stays under the service-size ratchet.
type LineValue = { itemCode?: string | null; qty: any; unitPrice: any; discountPct: any; lineTotal: any };

@Injectable()
export class CpqPricebookService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private tenantCond(user: JwtUser) {
    return user.tenantId != null ? eq(cpqPricebooks.tenantId, user.tenantId) : undefined;
  }

  async createPricebook(dto: { code: string; name: string; currency?: string; effective_from?: string | null; effective_to?: string | null; is_active?: boolean }, user: JwtUser) {
    if (user.tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'A tenant context is required', messageTh: 'ต้องอยู่ในบริบทของบริษัท' });
    if (dto.effective_from && dto.effective_to && dto.effective_from > dto.effective_to)
      throw new BadRequestException({ code: 'BAD_EFFECTIVE_WINDOW', message: 'effective_from must be on or before effective_to', messageTh: 'ช่วงวันที่มีผลไม่ถูกต้อง' });
    const db = this.db;
    const [pb] = await db.insert(cpqPricebooks).values({
      tenantId: user.tenantId, code: dto.code, name: dto.name, currency: dto.currency ?? 'THB',
      effectiveFrom: dto.effective_from ?? null, effectiveTo: dto.effective_to ?? null,
      isActive: dto.is_active ?? true, createdBy: user.username,
    }).onConflictDoUpdate({
      target: [cpqPricebooks.tenantId, cpqPricebooks.code],
      set: { name: dto.name, currency: dto.currency ?? 'THB', effectiveFrom: dto.effective_from ?? null, effectiveTo: dto.effective_to ?? null, isActive: dto.is_active ?? true },
    }).returning();
    return this.fmt(pb);
  }

  async listPricebooks(user: JwtUser) {
    const rows = await this.db.select().from(cpqPricebooks).where(this.tenantCond(user)).orderBy(desc(cpqPricebooks.id));
    return { pricebooks: rows.map((p) => this.fmt(p)), count: rows.length };
  }

  private async bookByCode(code: string, user: JwtUser) {
    const [pb] = await this.db.select().from(cpqPricebooks)
      .where(and(eq(cpqPricebooks.code, code), this.tenantCond(user))).limit(1);
    if (!pb) throw new NotFoundException({ code: 'PRICEBOOK_NOT_FOUND', message: `Pricebook ${code} not found`, messageTh: 'ไม่พบตารางราคา' });
    return pb;
  }

  // Upsert entries (item_code → unit_price) on a pricebook. Master-data maintenance.
  async upsertEntries(code: string, entries: { item_code: string; unit_price: number }[], user: JwtUser) {
    const pb = await this.bookByCode(code, user);
    if (!entries?.length) throw new BadRequestException({ code: 'NO_ENTRIES', message: 'entries is required', messageTh: 'ต้องระบุรายการราคา' });
    const db = this.db;
    for (const e of entries) {
      await db.insert(cpqPricebookEntries)
        .values({ tenantId: user.tenantId ?? null, pricebookId: Number(pb.id), itemCode: e.item_code, unitPrice: fx(e.unit_price ?? 0, 4) })
        .onConflictDoUpdate({ target: [cpqPricebookEntries.tenantId, cpqPricebookEntries.pricebookId, cpqPricebookEntries.itemCode], set: { unitPrice: fx(e.unit_price ?? 0, 4) } });
    }
    return this.getPricebook(code, user);
  }

  async getPricebook(code: string, user: JwtUser) {
    const pb = await this.bookByCode(code, user);
    const entries = await this.db.select().from(cpqPricebookEntries)
      .where(and(eq(cpqPricebookEntries.pricebookId, Number(pb.id)), user.tenantId != null ? eq(cpqPricebookEntries.tenantId, user.tenantId) : undefined))
      .orderBy(cpqPricebookEntries.itemCode);
    return { ...this.fmt(pb), entries: entries.map((e) => ({ item_code: e.itemCode, unit_price: n(e.unitPrice) })) };
  }

  // Resolve a pricebook by id + validate it is usable NOW (tenant + active + within its effective window on the
  // business day). Returns the book row + a code→price map. Throws a precise code on any failure.
  private async resolveUsable(pricebookId: number, user: JwtUser) {
    const [pb] = await this.db.select().from(cpqPricebooks)
      .where(and(eq(cpqPricebooks.id, pricebookId), this.tenantCond(user))).limit(1);
    if (!pb) throw new NotFoundException({ code: 'PRICEBOOK_NOT_FOUND', message: `Pricebook ${pricebookId} not found`, messageTh: 'ไม่พบตารางราคา' });
    if (!pb.isActive) throw new BadRequestException({ code: 'PRICEBOOK_INACTIVE', message: `Pricebook ${pb.code} is inactive`, messageTh: 'ตารางราคานี้ปิดใช้งานแล้ว' });
    const today = ymd(); // Asia/Bangkok business day (YYYY-MM-DD)
    if ((pb.effectiveFrom && today < pb.effectiveFrom) || (pb.effectiveTo && today > pb.effectiveTo))
      throw new BadRequestException({ code: 'PRICEBOOK_NOT_EFFECTIVE', message: `Pricebook ${pb.code} is not effective on ${today}`, messageTh: 'ตารางราคายังไม่มีผลหรือหมดอายุแล้ว', details: { effective_from: pb.effectiveFrom, effective_to: pb.effectiveTo, today } });
    const entries = await this.db.select().from(cpqPricebookEntries).where(eq(cpqPricebookEntries.pricebookId, Number(pb.id)));
    const priceByCode = new Map<string, number>(entries.map((e) => [e.itemCode, n(e.unitPrice)]));
    return { pb, priceByCode };
  }

  // Re-price the built quote lines from the pricebook (called by CpqService.createQuote when a pricebook is
  // selected). A line with a matching item-code entry takes the pricebook price (its line total recomputes off
  // the line's own discount%); a line the pricebook doesn't cover keeps its resolved price. Mutates in place;
  // returns { pricebookId, subtotal } — subtotal is recomputed so the quote total stays consistent.
  async applyToLines(lineValues: LineValue[], pricebookId: number, user: JwtUser): Promise<{ pricebookId: number; subtotal: number }> {
    const { pb, priceByCode } = await this.resolveUsable(pricebookId, user);
    let subtotal = 0;
    for (const l of lineValues) {
      const code = l.itemCode ?? undefined;
      if (code && priceByCode.has(code)) {
        const price = priceByCode.get(code)!;
        const qty = n(l.qty); const disc = n(l.discountPct);
        l.unitPrice = fx(price, 4);
        l.lineTotal = fx(round4(price * qty * (1 - disc / 100)), 4);
      }
      subtotal += n(l.lineTotal);
    }
    return { pricebookId: Number(pb.id), subtotal: round4(subtotal) };
  }

  private fmt(p: any) {
    return { id: Number(p.id), code: p.code, name: p.name, currency: p.currency, effective_from: p.effectiveFrom ?? null, effective_to: p.effectiveTo ?? null, is_active: p.isActive === true, created_by: p.createdBy ?? null, created_at: p.createdAt };
  }
}

export type PricebookBody = { code: string; name: string; currency?: string; effective_from?: string | null; effective_to?: string | null; is_active?: boolean };
export type PricebookEntriesBody = { entries: { item_code: string; unit_price: number }[] };
