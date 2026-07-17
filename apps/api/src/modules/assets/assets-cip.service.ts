// FA-13 CIP / AUC — Construction-in-Progress / Assets-under-Construction (docs/46 god-service burn-down
// round 4). Plain class constructed in the AssetsService ctor BODY (not a DI provider); the facade keeps
// thin delegators and its positional ctor contract. Bodies moved VERBATIM from assets.service.ts.
// Open a CIP asset, accumulate GR/manual/project cost lines onto it (Dr 1520 CIP / Cr AP|Cash — the asset is
// NOT depreciated while under construction), then SETTLE it into a normal fixed asset under a maker-checker
// gate: the preparer raises a settlement REQUEST (with a mandatory reason) that posts NOTHING; a DIFFERENT
// user approves before the fixed_assets row + reclassification JE (Dr 1500 / Cr 1520) post effective.
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, asc, desc } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { cipAssets, cipCostLines } from '../../database/schema';
import type { DocNumberService } from '../../common/doc-number.service';
import type { LedgerService } from '../ledger/ledger.service';
import { n, fx, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';
import type { AcquireAssetDto, OpenCipDto, AddCipCostDto, SettleCipDto } from './dto';
import type { AcquirePort } from './assets-registration.service';

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

export class AssetsCipService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly ledger: LedgerService,
    private readonly acquire: AcquirePort,
  ) {}

  async openCip(dto: OpenCipDto, user: JwtUser) {
    const db = this.db;
    const cipNo = await this.docNo.nextDaily('CIP');
    await db.insert(cipAssets).values({
      tenantId: user.tenantId ?? null, cipNo, name: dto.name, categoryId: dto.category_id ?? null,
      status: 'Open', accumulatedCost: '0', location: dto.location ?? null, department: dto.department ?? null,
      notes: dto.notes ?? null, createdBy: user.username,
    });
    return { cip_no: cipNo, name: dto.name, status: 'Open', accumulated_cost: 0 };
  }

  private async openCipRow(cipNo: string, user: JwtUser) {
    const db = this.db;
    const conds = [eq(cipAssets.cipNo, cipNo)];
    if (user.tenantId != null) conds.push(eq(cipAssets.tenantId, user.tenantId));
    const [c] = await db.select().from(cipAssets).where(and(...conds)).limit(1);
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: `CIP ${cipNo} not found`, messageTh: 'ไม่พบสินทรัพย์ระหว่างก่อสร้าง' });
    return c;
  }

  // Add a cost line to a CIP asset. Posts Dr 1520 CIP / Cr 2000 AP (credit) or Cr 1000 Cash, and rolls the
  // accumulated cost up. Only an Open CIP accepts new cost.
  async addCipCost(cipNo: string, dto: AddCipCostDto, user: JwtUser) {
    const db = this.db;
    const c = await this.openCipRow(cipNo, user);
    if (c.status !== 'Open') throw new BadRequestException({ code: 'CIP_NOT_OPEN', message: `CIP ${cipNo} is ${c.status}, not Open`, messageTh: 'สินทรัพย์ระหว่างก่อสร้างนี้ไม่ได้เปิดรับต้นทุน' });
    const amount = round4(dto.amount);
    if (amount <= 0) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'amount must be > 0', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });
    const costDate = dto.cost_date ?? ymd();
    const [line] = await db.insert(cipCostLines).values({
      tenantId: c.tenantId ?? user.tenantId ?? null, cipId: Number(c.id), cipNo, sourceType: dto.source_type,
      sourceRef: dto.source_ref ?? null, description: dto.description ?? null, amount: fx(amount, 4),
      costDate, paySource: dto.pay_source, addedBy: user.username,
    }).returning({ id: cipCostLines.id });
    const je: any = await this.ledger.postEntry({
      date: costDate, source: 'CIP', sourceRef: `${cipNo}-L${Number(line!.id)}`, tenantId: c.tenantId ?? user.tenantId ?? null,
      memo: `CIP cost ${cipNo}${dto.source_ref ? ` (${dto.source_ref})` : ''}`, createdBy: user.username,
      lines: [{ account_code: '1520', debit: amount }, { account_code: dto.pay_source === 'cash' ? '1000' : '2000', credit: amount }],
    });
    const newTotal = round4(n(c.accumulatedCost) + amount);
    await db.update(cipCostLines).set({ glRef: je?.entry_no ?? null }).where(eq(cipCostLines.id, Number(line!.id)));
    await db.update(cipAssets).set({ accumulatedCost: fx(newTotal, 4) }).where(eq(cipAssets.id, Number(c.id)));
    return { cip_no: cipNo, line_id: Number(line!.id), amount, accumulated_cost: newTotal, journal_no: je?.entry_no ?? null };
  }

  async listCip(status: string | undefined, user: JwtUser) {
    const db = this.db;
    const conds = status ? [eq(cipAssets.status, status)] : [];
    if (user.tenantId != null) conds.push(eq(cipAssets.tenantId, user.tenantId));
    const rows = await db.select().from(cipAssets).where(conds.length ? and(...conds) : undefined).orderBy(desc(cipAssets.id)).limit(200);
    return { cip: rows.map(shapeCip), count: rows.length };
  }

  async getCip(cipNo: string, user: JwtUser) {
    const c = await this.openCipRow(cipNo, user);
    const rows = await this.db.select().from(cipCostLines).where(eq(cipCostLines.cipNo, cipNo)).orderBy(asc(cipCostLines.id));
    return { ...shapeCip(c), cost_lines: rows.map((r: any) => ({ line_id: Number(r.id), source_type: r.sourceType, source_ref: r.sourceRef, description: r.description, amount: n(r.amount), cost_date: r.costDate, pay_source: r.paySource, journal_no: r.glRef, added_by: r.addedBy })) };
  }

  // Maker: raise a settlement request. Validates the CIP is Open with cost accumulated and a reason is given.
  // Posts NOTHING; a DIFFERENT user must approve. Only one settlement can be pending (status = PendingSettlement).
  async settleCip(cipNo: string, dto: SettleCipDto, user: JwtUser) {
    const db = this.db;
    const c = await this.openCipRow(cipNo, user);
    if (c.status !== 'Open') throw new BadRequestException({ code: 'CIP_NOT_OPEN', message: `CIP ${cipNo} is ${c.status}, not Open`, messageTh: 'สินทรัพย์ระหว่างก่อสร้างนี้ตั้งเบิกไม่ได้' });
    if (n(c.accumulatedCost) <= 0) throw new BadRequestException({ code: 'CIP_NO_COST', message: 'CIP has no accumulated cost to capitalise', messageTh: 'ยังไม่มีต้นทุนสะสมให้ตั้งเป็นสินทรัพย์' });
    await db.update(cipAssets).set({
      status: 'PendingSettlement', settleName: dto.name ?? c.name, settleCategoryId: dto.category_id ?? c.categoryId ?? null,
      settleUsefulLifeMonths: dto.useful_life_months ?? null, settleSalvageValue: fx(dto.salvage_value, 4),
      settleTaxUsefulLifeMonths: dto.tax_useful_life_months ?? null, settleTaxInitialAllowancePct: dto.tax_initial_allowance_pct != null ? fx(dto.tax_initial_allowance_pct, 4) : null,
      settleReason: dto.reason, requestedBy: user.username, requestedAt: new Date(),
    }).where(eq(cipAssets.id, Number(c.id)));
    return { cip_no: cipNo, status: 'PendingSettlement', accumulated_cost: n(c.accumulatedCost), settle_reason: dto.reason, requested_by: user.username };
  }

  // FA-13 maker-checker: a DIFFERENT user approves the settlement → the fixed asset is created and the
  // reclassification JE (Dr 1500 / Cr 1520) posts EFFECTIVE for the accumulated construction cost.
  async approveCipSettlement(cipNo: string, user: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const c = await this.openCipRow(cipNo, user);
    if (c.status !== 'PendingSettlement') throw new BadRequestException({ code: 'NO_PENDING_SETTLEMENT', message: `No settlement pending approval for ${cipNo}`, messageTh: 'ไม่มีรายการตั้งสินทรัพย์ที่รออนุมัติ' });
    await assertMakerChecker(db, { user, maker: c.requestedBy, event: 'fa.cip-settlement.approve', ref: cipNo, amount: n(c.accumulatedCost), reason: selfApprovalReason, code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve a CIP settlement you requested', messageTh: 'แยกหน้าที่: ผู้ขอไม่สามารถอนุมัติการตั้งสินทรัพย์ของตนเองได้' });
    const cost = round4(n(c.accumulatedCost));
    const res = await this.acquire({
      name: c.settleName ?? c.name, category_id: c.settleCategoryId ?? c.categoryId ?? undefined,
      acquire_cost: cost, salvage_value: n(c.settleSalvageValue), useful_life_months: c.settleUsefulLifeMonths ?? undefined,
      acquire_source: 'credit', location: c.location ?? undefined, department: c.department ?? undefined, notes: c.notes ?? undefined,
      tax_useful_life_months: c.settleTaxUsefulLifeMonths ?? undefined,
      tax_initial_allowance_pct: c.settleTaxInitialAllowancePct != null ? n(c.settleTaxInitialAllowancePct) : undefined,
    } as AcquireAssetDto, user, { tenantId: c.tenantId ?? user.tenantId ?? null, sourceCipNo: cipNo, creditAccount: '1520' });
    await db.update(cipAssets).set({ status: 'Capitalized', settledAssetNo: res.asset_no, settleJournalNo: res.journal_no, approvedBy: user.username, approvedAt: new Date() }).where(eq(cipAssets.id, Number(c.id)));
    return { cip_no: cipNo, status: 'Capitalized', asset_no: res.asset_no, journal_no: res.journal_no, capitalized_cost: cost, approved_by: user.username, requested_by: c.requestedBy };
  }

  // Reject a pending settlement → the CIP re-opens for more cost / a corrected request.
  async rejectCipSettlement(cipNo: string, user: JwtUser, reason?: string) {
    const db = this.db;
    const c = await this.openCipRow(cipNo, user);
    if (c.status !== 'PendingSettlement') throw new BadRequestException({ code: 'NO_PENDING_SETTLEMENT', message: `No settlement pending approval for ${cipNo}`, messageTh: 'ไม่มีรายการตั้งสินทรัพย์ที่รออนุมัติ' });
    await db.update(cipAssets).set({ status: 'Open', rejectReason: reason ?? null, requestedBy: null, requestedAt: null }).where(eq(cipAssets.id, Number(c.id)));
    return { cip_no: cipNo, status: 'Open', rejected_by: user.username };
  }
}

function shapeCip(c: any) {
  return { cip_no: c.cipNo, name: c.name, category_id: c.categoryId != null ? Number(c.categoryId) : null, status: c.status, accumulated_cost: n(c.accumulatedCost), location: c.location ?? null, department: c.department ?? null, notes: c.notes ?? null, settle_reason: c.settleReason ?? null, settled_asset_no: c.settledAssetNo ?? null, settle_journal_no: c.settleJournalNo ?? null, requested_by: c.requestedBy ?? null, requested_at: c.requestedAt ?? null, approved_by: c.approvedBy ?? null, approved_at: c.approvedAt ?? null, reject_reason: c.rejectReason ?? null, created_by: c.createdBy ?? null };
}
