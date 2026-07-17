// FA-10 Procure-to-Capitalize — register fixed assets from goods-receipt capital lines (docs/46 god-service
// burn-down round 4). Plain class constructed in the AssetsService ctor BODY (not a DI provider) so the
// facade's positional ctor contract is untouched; the facade keeps thin delegators. Bodies moved VERBATIM
// from assets.service.ts. Creating the asset is a maker-checker request so receiving goods and putting them
// on the asset register (and at what cost / life) are segregated duties. The `acquire` port loops back into
// the facade so the approved registration books through the exact same acquisition path (JE + tax book).
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { assetCategories, assetRegistrationRequests, goodsReceipts, grItems, items } from '../../database/schema';
import type { DocNumberService } from '../../common/doc-number.service';
import { n, fx, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';
import type { AcquireAssetDto, RegisterFromGrDto } from './dto';

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

/** Loop-back port into the facade's acquire() so approval books the asset through the canonical path. */
export type AcquirePort = (
  dto: AcquireAssetDto,
  user: JwtUser,
  opts?: { tenantId?: number | null; sourceGrNo?: string | null; sourcePoNo?: string | null; sourceCipNo?: string | null; creditAccount?: string },
) => Promise<{ asset_no: string; journal_no: string | null; net_book_value: number }>;

export class AssetsRegistrationService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly acquire: AcquirePort,
  ) {}

  // Capital GR lines on a GR that have not yet been registered (no PendingApproval/Posted request).
  async eligibleFromGr(grNo: string, _user: JwtUser) {
    const db = this.db;
    const [gr] = await db.select().from(goodsReceipts).where(eq(goodsReceipts.grNo, grNo)).limit(1);
    if (!gr) throw new NotFoundException({ code: 'NOT_FOUND', message: 'GR not found', messageTh: 'ไม่พบใบรับสินค้า' });
    const rows = await db.select({ id: grItems.id, itemId: grItems.itemId, itemDescription: grItems.itemDescription, receivedQty: grItems.receivedQty, uom: grItems.uom, unitCost: grItems.unitCost })
      .from(grItems).innerJoin(goodsReceipts, eq(grItems.grId, goodsReceipts.id))
      .where(and(eq(goodsReceipts.grNo, grNo), eq(grItems.isCapital, true)));
    const reqs = await db.select({ grItemId: assetRegistrationRequests.grItemId, status: assetRegistrationRequests.status })
      .from(assetRegistrationRequests).where(eq(assetRegistrationRequests.grNo, grNo));
    const blocked = new Set(reqs.filter((r: any) => r.status !== 'Rejected').map((r: any) => Number(r.grItemId)));
    const lines = rows.filter((r: any) => !blocked.has(Number(r.id))).map((r: any) => ({
      gr_item_id: Number(r.id), item_id: r.itemId, item_description: r.itemDescription,
      received_qty: n(r.receivedQty), uom: r.uom, unit_cost: n(r.unitCost), suggested_cost: round4(n(r.receivedQty) * n(r.unitCost)),
    }));
    return { gr_no: grNo, po_no: gr.poNo, vendor_name: gr.vendorName, eligible: lines, count: lines.length };
  }

  // Maker: raise a registration request for a capital GR line. Posts NOTHING to the GL. Resolves the default
  // asset category / useful life from the item master when not supplied; cost defaults to the GR line value.
  async registerFromGr(dto: RegisterFromGrDto, user: JwtUser) {
    const db = this.db;
    const [gr] = await db.select().from(goodsReceipts).where(eq(goodsReceipts.grNo, dto.gr_no)).limit(1);
    if (!gr) throw new NotFoundException({ code: 'NOT_FOUND', message: 'GR not found', messageTh: 'ไม่พบใบรับสินค้า' });
    const [line] = await db.select().from(grItems).where(and(eq(grItems.id, dto.gr_item_id), eq(grItems.grId, Number(gr.id)))).limit(1);
    if (!line) throw new NotFoundException({ code: 'NOT_FOUND', message: 'GR line not found', messageTh: 'ไม่พบรายการในใบรับสินค้า' });
    if (!line.isCapital) throw new BadRequestException({ code: 'NOT_CAPITAL', message: 'GR line is not a capital item', messageTh: 'รายการนี้ไม่ใช่สินทรัพย์ถาวร' });
    const [dup] = await db.select({ id: assetRegistrationRequests.id }).from(assetRegistrationRequests)
      .where(and(eq(assetRegistrationRequests.grItemId, dto.gr_item_id), inArray(assetRegistrationRequests.status, ['PendingApproval', 'Posted']))).limit(1);
    if (dup) throw new BadRequestException({ code: 'ALREADY_REGISTERED', message: 'This GR line already has an active asset registration', messageTh: 'รายการนี้มีการตั้งทรัพย์สินอยู่แล้ว' });
    // resolve category (dto → item-master default) and useful life (dto → category default)
    let categoryId = dto.category_id ?? null;
    if (categoryId == null && line.itemId) {
      const [it] = await db.select({ cat: items.defaultAssetCategoryId }).from(items).where(eq(items.itemId, line.itemId)).limit(1);
      categoryId = it?.cat ?? null;
    }
    let life = dto.useful_life_months ?? null;
    if (life == null && categoryId != null) {
      const [cat] = await db.select().from(assetCategories).where(eq(assetCategories.id, categoryId)).limit(1);
      life = cat ? cat.defaultUsefulLifeYears * 12 : null;
    }
    if (!life) throw new BadRequestException({ code: 'NO_LIFE', message: 'useful_life_months or a category is required', messageTh: 'ต้องระบุอายุการใช้งานหรือหมวดสินทรัพย์' });
    const cost = round4(dto.acquire_cost ?? n(line.receivedQty) * n(line.unitCost));
    if (cost <= 0) throw new BadRequestException({ code: 'BAD_COST', message: 'acquire_cost must be > 0', messageTh: 'มูลค่าต้องมากกว่าศูนย์' });
    const regNo = await this.docNo.nextDaily('FAR');
    await db.insert(assetRegistrationRequests).values({
      tenantId: user.tenantId ?? null, regNo, grNo: dto.gr_no, poNo: gr.poNo, grItemId: dto.gr_item_id,
      itemId: line.itemId, name: dto.name, categoryId, acquireDate: gr.grDate ?? ymd(),
      acquireCost: fx(cost, 4), salvageValue: fx(dto.salvage_value, 4), usefulLifeMonths: life, acquireSource: 'credit',
      location: dto.location ?? null, department: dto.department ?? null, serialNo: dto.serial_no ?? null,
      notes: dto.notes ?? null, status: 'PendingApproval', requestedBy: user.username,
    });
    return { reg_no: regNo, gr_no: dto.gr_no, po_no: gr.poNo, item_id: line.itemId, name: dto.name, acquire_cost: cost, useful_life_months: life, status: 'PendingApproval' };
  }

  // List registration requests (default: the pending-approval queue).
  async listRegistrations(status: string | undefined, _user: JwtUser) {
    const db = this.db;
    const where = status ? eq(assetRegistrationRequests.status, status) : undefined;
    const rows = await db.select().from(assetRegistrationRequests).where(where).orderBy(desc(assetRegistrationRequests.id));
    return { registrations: rows.map(shapeReg), count: rows.length };
  }

  // Checker (FA-10 maker-checker): a DIFFERENT user approves → the fixed asset is created and the acquisition
  // JE (Dr 1500 / Cr 2000) posts EFFECTIVE. The asset is stamped with its source GR/PO for traceability.
  async approveRegistration(regNo: string, user: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const req = await this.pendingRegistration(regNo);
    await assertMakerChecker(db, { user, maker: req.requestedBy, event: 'fa.registration.approve', ref: regNo, amount: n(req.acquireCost), reason: selfApprovalReason, code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve an asset registration you requested', messageTh: 'แยกหน้าที่: ผู้ขอไม่สามารถอนุมัติรายการของตนเองได้' });
    const res = await this.acquire({
      name: req.name, category_id: req.categoryId ?? undefined, acquire_date: req.acquireDate ?? undefined,
      acquire_cost: n(req.acquireCost), salvage_value: n(req.salvageValue), useful_life_months: req.usefulLifeMonths ?? undefined,
      acquire_source: 'credit', location: req.location ?? undefined, department: req.department ?? undefined,
      serial_no: req.serialNo ?? undefined, notes: req.notes ?? undefined,
    } as AcquireAssetDto, user, { tenantId: req.tenantId ?? user.tenantId ?? null, sourceGrNo: req.grNo, sourcePoNo: req.poNo });
    await db.update(assetRegistrationRequests).set({ status: 'Posted', assetNo: res.asset_no, approvedBy: user.username, approvedAt: new Date() }).where(eq(assetRegistrationRequests.id, Number(req.id)));
    return { reg_no: regNo, asset_no: res.asset_no, journal_no: res.journal_no, status: 'Posted', approved_by: user.username, prepared_by: req.requestedBy, source_gr_no: req.grNo, source_po_no: req.poNo };
  }

  // Reject a pending registration → no asset is created; the GR line becomes eligible to re-raise.
  async rejectRegistration(regNo: string, user: JwtUser, reason?: string) {
    const db = this.db;
    const req = await this.pendingRegistration(regNo);
    await db.update(assetRegistrationRequests).set({ status: 'Rejected', approvedBy: user.username, approvedAt: new Date(), rejectReason: reason ?? null }).where(eq(assetRegistrationRequests.id, Number(req.id)));
    return { reg_no: regNo, status: 'Rejected', rejected_by: user.username };
  }

  private async pendingRegistration(regNo: string) {
    const db = this.db;
    const [req] = await db.select().from(assetRegistrationRequests).where(and(eq(assetRegistrationRequests.regNo, regNo), eq(assetRegistrationRequests.status, 'PendingApproval'))).limit(1);
    if (!req) throw new BadRequestException({ code: 'NO_PENDING_REGISTRATION', message: `No registration pending approval for ${regNo}`, messageTh: 'ไม่มีรายการตั้งทรัพย์สินที่รออนุมัติ' });
    return req;
  }
}

function shapeReg(r: any) {
  return { reg_no: r.regNo, gr_no: r.grNo, po_no: r.poNo, gr_item_id: r.grItemId != null ? Number(r.grItemId) : null, item_id: r.itemId, name: r.name, category_id: r.categoryId != null ? Number(r.categoryId) : null, acquire_date: r.acquireDate, acquire_cost: n(r.acquireCost), salvage_value: n(r.salvageValue), useful_life_months: r.usefulLifeMonths, location: r.location ?? null, department: r.department ?? null, serial_no: r.serialNo ?? null, status: r.status, asset_no: r.assetNo ?? null, requested_by: r.requestedBy ?? null, requested_at: r.requestedAt, approved_by: r.approvedBy ?? null, approved_at: r.approvedAt ?? null, reject_reason: r.rejectReason ?? null };
}
