import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, asc, desc, sql, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { assetCategories, fixedAssets, depreciationRuns, depreciationLines, assetMovements, assetRevaluations, assetRegistrationRequests, journalEntries, grItems, goodsReceipts, items } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import { QrService } from '../qr/qr.service';
import { n, fx, ymd } from '../../database/queries';
import { buildAssetQrPayload, parseQrPayload } from '@ierp/shared';
import type { JwtUser } from '../../common/decorators';
import type { CreateCategoryDto, AcquireAssetDto, DisposeAssetDto, RegisterFromGrDto } from './dto';

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

@Injectable()
export class AssetsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly ledger: LedgerService,
    private readonly qr: QrService,
  ) {}

  async createCategory(dto: CreateCategoryDto, user: JwtUser) {
    const db = this.db;
    const [c] = await db.insert(assetCategories).values({
      tenantId: user.tenantId ?? null, code: dto.code, name: dto.name, defaultUsefulLifeYears: dto.default_useful_life_years,
      assetAccount: dto.asset_account, accumDepAccount: dto.accum_dep_account, depExpenseAccount: dto.dep_expense_account,
    }).onConflictDoNothing().returning();
    return c ? shapeCat(c) : { code: dto.code, note: 'exists' };
  }
  async listCategories(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(assetCategories).orderBy(asc(assetCategories.code));
    return { categories: rows.map(shapeCat), count: rows.length };
  }

  // acquisition: Dr 1500 Fixed Assets / Cr 1000 Cash (or 2000 AP) = acquire_cost. `opts` carries internal-only
  // context (the owning tenant + the source GR/PO when capitalised via FA-10) that a request body must not spoof.
  async acquire(dto: AcquireAssetDto, user: JwtUser, opts?: { tenantId?: number | null; sourceGrNo?: string | null; sourcePoNo?: string | null }) {
    const db = this.db;
    let life = dto.useful_life_months;
    if (life == null && dto.category_id != null) {
      const [cat] = await db.select().from(assetCategories).where(eq(assetCategories.id, dto.category_id)).limit(1);
      life = (cat?.defaultUsefulLifeYears ?? 5) * 12;
    }
    if (!life) throw new BadRequestException({ code: 'NO_LIFE', message: 'useful_life_months required', messageTh: 'ต้องระบุอายุการใช้งาน' });
    const cost = n(dto.acquire_cost);
    const tenantId = opts && 'tenantId' in opts ? (opts.tenantId ?? null) : (user.tenantId ?? null);
    const assetNo = await this.docNo.nextDaily('FA');
    const acquireDate = dto.acquire_date ?? ymd();
    await db.insert(fixedAssets).values({
      tenantId, assetNo, categoryId: dto.category_id ?? null, name: dto.name,
      acquireDate, acquireCost: fx(cost, 4), salvageValue: fx(dto.salvage_value, 4), usefulLifeMonths: life,
      status: 'active', accumulatedDepreciation: '0', netBookValue: fx(cost, 4), acquireSource: dto.acquire_source,
      location: dto.location ?? null, department: dto.department ?? null, serialNo: dto.serial_no ?? null,
      sourceGrNo: opts?.sourceGrNo ?? null, sourcePoNo: opts?.sourcePoNo ?? null,
      notes: dto.notes ?? null, createdBy: user.username,
    }).onConflictDoNothing();
    let journalNo: string | null = null;
    if (cost > 0 && !(await this.ledger.alreadyPosted('ASSET', assetNo))) {
      const je: any = await this.ledger.postEntry({
        date: acquireDate, source: 'ASSET', sourceRef: assetNo, tenantId,
        memo: `Asset acquisition ${assetNo} ${dto.name}`, createdBy: user.username,
        lines: [{ account_code: '1500', debit: cost }, { account_code: dto.acquire_source === 'credit' ? '2000' : '1000', credit: cost }],
      });
      journalNo = je?.entry_no ?? null;
    }
    return { asset_no: assetNo, journal_no: journalNo, net_book_value: cost };
  }

  // ── Procure-to-Capitalize (FA-10): register fixed assets from a goods receipt ───────────────────────
  // A GR line flagged is_capital is ELIGIBLE for capitalisation; creating the asset is a maker-checker
  // request so receiving goods and putting them on the asset register (and at what cost / life) are
  // segregated duties. Resolve the depreciation life from the GR line / item-master default category.

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
  async approveRegistration(regNo: string, user: JwtUser) {
    const db = this.db;
    const req = await this.pendingRegistration(regNo);
    if (req.requestedBy && req.requestedBy === user.username)
      throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve an asset registration you requested', messageTh: 'แยกหน้าที่: ผู้ขอไม่สามารถอนุมัติรายการของตนเองได้' });
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

  // monthly straight-line depreciation, posted PER TENANT (one balanced GL entry per shop, Dr 5200 / Cr
  // 1590) so each shop's trial balance ties — never one consolidated entry co-mingling every tenant's
  // assets under the caller's id. Idempotent per `${tenant}:${period}`. Null tenant = HQ-consolidated bucket.
  async runDepreciation(period: string, user: JwtUser) {
    const db = this.db;
    const [y, m] = period.split('-').map(Number) as [number, number];
    const endExcl = m < 12 ? `${y}-${String(m + 1).padStart(2, '0')}-01` : `${y + 1}-01-01`;
    const periodEnd = new Date(new Date(endExcl + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);

    // Compute each eligible asset's monthly charge, bucketed by owning tenant. A disposal-pending asset is
    // frozen (the Draft disposal JE was computed off its current NBV) — exclude it until the disposal resolves.
    const assets = await db.select().from(fixedAssets).where(and(eq(fixedAssets.status, 'active'), eq(fixedAssets.disposalPending, false)));
    const groups = new Map<string, { tenantId: number | null; computed: any[] }>();
    for (const a of assets) {
      if (String(a.acquireDate) > periodEnd) continue;                       // not yet in service
      if (a.lastDepreciatedPeriod && String(a.lastDepreciatedPeriod) >= period) continue; // already done
      const cost = n(a.acquireCost), salvage = n(a.salvageValue), nbv = n(a.netBookValue), accum = n(a.accumulatedDepreciation);
      if (nbv <= salvage) continue;
      const monthly = round4((cost - salvage) / a.usefulLifeMonths);
      const amount = Math.min(monthly, round4(nbv - salvage));
      if (amount <= 0) continue;
      const accumAfter = round4(accum + amount), nbvAfter = round4(nbv - amount);
      const tenantId: number | null = a.tenantId != null ? Number(a.tenantId) : null;
      const key = String(tenantId);
      if (!groups.has(key)) groups.set(key, { tenantId, computed: [] });
      groups.get(key)!.computed.push({ id: Number(a.id), amount, accumAfter, nbvAfter, status: nbvAfter <= salvage + 1e-6 ? 'fully_depreciated' : 'active' });
    }

    const runs: any[] = [];
    let aggTotal = 0, aggCount = 0;
    for (const { tenantId, computed } of groups.values()) {
      const srcRef = `${tenantId ?? ''}:${period}`;
      if (await this.ledger.alreadyPosted('DEP', srcRef)) continue; // idempotent per tenant+period
      const total = round4(computed.reduce((s, c) => s + c.amount, 0));
      if (total === 0) continue;
      const runNo = await this.docNo.nextDaily('DEP');
      const [run] = await db.insert(depreciationRuns).values({ tenantId, runNo, period, totalDepreciation: fx(total, 4), assetCount: computed.length, createdBy: user.username }).returning({ id: depreciationRuns.id });
      for (const c of computed) {
        await db.update(fixedAssets).set({ accumulatedDepreciation: fx(c.accumAfter, 4), netBookValue: fx(c.nbvAfter, 4), status: c.status, lastDepreciatedPeriod: period }).where(eq(fixedAssets.id, c.id));
        await db.insert(depreciationLines).values({ tenantId, runId: Number(run!.id), assetId: c.id, amount: fx(c.amount, 4), accumulatedAfter: fx(c.accumAfter, 4), nbvAfter: fx(c.nbvAfter, 4) });
      }
      const je: any = await this.ledger.postEntry({
        date: periodEnd, source: 'DEP', sourceRef: srcRef, tenantId,
        memo: `Depreciation ${period} (${computed.length} assets)`, createdBy: user.username,
        lines: [{ account_code: '5200', debit: total }, { account_code: '1590', credit: total }],
      });
      await db.update(depreciationRuns).set({ journalNo: je?.entry_no ?? null }).where(eq(depreciationRuns.id, run!.id));
      runs.push({ tenant_id: tenantId, run_no: runNo, journal_no: je?.entry_no ?? null, total_depreciation: total, asset_count: computed.length });
      aggTotal = round4(aggTotal + total); aggCount += computed.length;
    }

    if (!runs.length) {
      // either nothing depreciable, or every eligible tenant was already posted for this period
      const already = [...groups.values()].some((g) => g.computed.length);
      return { run_no: null, period, total_depreciation: 0, asset_count: 0, journal_no: null, runs: [], ...(already ? { already: true } : { note: 'no depreciable assets' }) };
    }
    // top-level run_no/journal_no kept for single-tenant callers (back-compat); `runs` carries the split.
    return { run_no: runs[0].run_no, period, total_depreciation: aggTotal, asset_count: aggCount, journal_no: runs[0].journal_no, runs };
  }

  // disposal: Dr 1590 accum + Dr 1000 proceeds ± 1510 / Cr 1500 cost. FA-09 maker-checker — a disposal
  // REQUEST posts the JE as a Draft (excluded from balances) and flags the asset disposal_pending WITHOUT
  // marking it disposed; a DIFFERENT user must approve before it is effective (asset-stripping control).
  async dispose(assetNo: string, dto: DisposeAssetDto, user: JwtUser) {
    const db = this.db;
    const [a] = await db.select().from(fixedAssets).where(eq(fixedAssets.assetNo, assetNo)).limit(1);
    if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Asset not found', messageTh: 'ไม่พบสินทรัพย์' });
    if (a.status === 'disposed') throw new BadRequestException({ code: 'ALREADY_DISPOSED', message: 'Asset already disposed', messageTh: 'สินทรัพย์ถูกจำหน่ายแล้ว' });
    if (a.disposalPending) throw new BadRequestException({ code: 'DISPOSAL_PENDING', message: 'A disposal of this asset is already pending approval', messageTh: 'มีรายการจำหน่ายสินทรัพย์นี้รออนุมัติอยู่แล้ว' });
    const cost = n(a.acquireCost), accum = n(a.accumulatedDepreciation), nbv = n(a.netBookValue), proceeds = n(dto.proceeds);
    const gainLoss = round4(proceeds - nbv);
    const lines: any[] = [{ account_code: '1590', debit: accum }, { account_code: '1000', debit: proceeds }, { account_code: '1500', credit: cost }];
    if (gainLoss > 0) lines.push({ account_code: '1510', credit: gainLoss });
    else if (gainLoss < 0) lines.push({ account_code: '1510', debit: -gainLoss });
    const date = dto.disposal_date ?? ymd();
    const je: any = await this.ledger.postEntry({
      date, source: 'DISP', sourceRef: assetNo, tenantId: a.tenantId ?? user.tenantId ?? null,
      memo: gainLoss >= 0 ? `Disposal gain ${gainLoss}` : `Disposal loss ${-gainLoss}`, createdBy: user.username, lines,
      pendingApproval: true,
    });
    await db.update(fixedAssets).set({ disposalPending: true, disposedDate: date, disposalProceeds: fx(proceeds, 4), disposalGainLoss: fx(gainLoss, 4), disposalRequestedBy: user.username }).where(eq(fixedAssets.id, a.id));
    return { asset_no: assetNo, status: 'pending_disposal', nbv_at_disposal: nbv, proceeds, gain_loss: gainLoss, journal_no: je?.entry_no ?? null };
  }

  // FA-09 maker-checker: a DIFFERENT user approves the pending disposal → the Draft JE becomes effective,
  // the asset is marked disposed, and any revaluation surplus is recycled to retained earnings (posted fresh
  // here — approval is the authorization). Reuses GL-05's approveEntry (approver ≠ requester, period re-check).
  async approveDisposal(assetNo: string, user: JwtUser) {
    const db = this.db;
    const [a] = await db.select().from(fixedAssets).where(eq(fixedAssets.assetNo, assetNo)).limit(1);
    if (!a || !a.disposalPending) throw new BadRequestException({ code: 'NO_PENDING_DISPOSAL', message: `No disposal pending approval for ${assetNo}`, messageTh: 'ไม่มีรายการจำหน่ายที่รออนุมัติสำหรับสินทรัพย์นี้' });
    const draft = await this.pendingDisposalJe(assetNo);
    await this.ledger.approveEntry(draft.entryNo, user);
    await db.update(fixedAssets).set({ status: 'disposed', disposalPending: false, disposalApprovedBy: user.username }).where(eq(fixedAssets.id, a.id));
    // Revaluation-reserve recycling (FA-07, IFRS): surplus held in 3200 transfers directly to retained
    // earnings (Dr 3200 / Cr 3100), not through P&L. Posted here (effective) once the disposal is approved.
    const [rev] = await db.select({ s: sql<string>`coalesce(sum(${assetRevaluations.delta}),0)` }).from(assetRevaluations)
      .where(and(eq(assetRevaluations.assetNo, assetNo), eq(assetRevaluations.kind, 'revaluation'), eq(assetRevaluations.status, 'Posted')));
    const surplus = round4(n(rev?.s));
    let recycleJe: any = null;
    if (surplus > 0) {
      recycleJe = await this.ledger.postEntry({
        date: a.disposedDate ?? ymd(), source: 'REVAL-RECYCLE', sourceRef: assetNo, tenantId: a.tenantId ?? user.tenantId ?? null,
        memo: `Revaluation surplus recycled to retained earnings on disposal of ${assetNo}`, createdBy: user.username,
        lines: [{ account_code: '3200', debit: surplus }, { account_code: '3100', credit: surplus }],
      });
    }
    return { asset_no: assetNo, status: 'disposed', proceeds: n(a.disposalProceeds), gain_loss: n(a.disposalGainLoss), journal_no: draft.entryNo, approved_by: user.username, prepared_by: a.disposalRequestedBy, revaluation_surplus_recycled: surplus, recycle_journal_no: recycleJe?.entry_no ?? null };
  }

  // Reject a pending disposal → voids the Draft JE; the asset stays in service (fields cleared).
  async rejectDisposal(assetNo: string, user: JwtUser, reason?: string) {
    const db = this.db;
    const [a] = await db.select().from(fixedAssets).where(eq(fixedAssets.assetNo, assetNo)).limit(1);
    if (!a || !a.disposalPending) throw new BadRequestException({ code: 'NO_PENDING_DISPOSAL', message: `No disposal pending approval for ${assetNo}`, messageTh: 'ไม่มีรายการจำหน่ายที่รออนุมัติสำหรับสินทรัพย์นี้' });
    const draft = await this.pendingDisposalJe(assetNo);
    await this.ledger.rejectEntry(draft.entryNo, user, reason);
    await db.update(fixedAssets).set({ disposalPending: false, disposedDate: null, disposalProceeds: null, disposalGainLoss: null, disposalRequestedBy: null }).where(eq(fixedAssets.id, a.id));
    return { asset_no: assetNo, status: 'active', rejected_by: user.username, journal_no: draft.entryNo };
  }

  private async pendingDisposalJe(assetNo: string) {
    const db = this.db;
    const [je] = await db.select({ entryNo: journalEntries.entryNo }).from(journalEntries)
      .where(and(eq(journalEntries.source, 'DISP'), eq(journalEntries.sourceRef, assetNo), eq(journalEntries.status, 'Draft'))).orderBy(desc(journalEntries.id)).limit(1);
    if (!je) throw new BadRequestException({ code: 'NO_PENDING_DISPOSAL', message: `No draft disposal entry for ${assetNo}`, messageTh: 'ไม่พบรายการบัญชีจำหน่ายที่รออนุมัติ' });
    return je;
  }

  // Revaluation / impairment (FA-07): adjust an asset's carrying amount to a new value. Upward → credit
  // the revaluation surplus (equity 3200); downward (impairment) → debit impairment loss (5820). The gross
  // 1500 moves by the delta so the register stays tied to the GL; accumulated depreciation is unchanged.
  async revalue(assetNo: string, dto: { new_value: number; reason?: string; reval_date?: string }, user: JwtUser) {
    const db = this.db;
    const [a] = await db.select().from(fixedAssets).where(eq(fixedAssets.assetNo, assetNo)).limit(1);
    if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Asset not found', messageTh: 'ไม่พบสินทรัพย์' });
    if (a.status === 'disposed') throw new BadRequestException({ code: 'ALREADY_DISPOSED', message: 'Asset already disposed', messageTh: 'สินทรัพย์ถูกจำหน่ายแล้ว' });
    const newValue = round4(dto.new_value);
    if (newValue < 0) throw new BadRequestException({ code: 'BAD_VALUE', message: 'new_value must be >= 0', messageTh: 'มูลค่าใหม่ต้องไม่ติดลบ' });
    const oldValue = n(a.netBookValue);
    const delta = round4(newValue - oldValue);
    if (delta === 0) throw new BadRequestException({ code: 'NO_CHANGE', message: 'new_value equals current net book value', messageTh: 'มูลค่าใหม่เท่ากับมูลค่าตามบัญชีเดิม' });
    // FA-08: only one revaluation may be pending approval at a time (the carrying value is deferred until
    // approval, so a second proposal would compute its delta off a stale base).
    const [pending] = await db.select().from(assetRevaluations).where(and(eq(assetRevaluations.assetNo, assetNo), eq(assetRevaluations.status, 'PendingApproval'))).limit(1);
    if (pending) throw new BadRequestException({ code: 'REVALUATION_PENDING', message: `A revaluation of ${assetNo} is already pending approval`, messageTh: 'มีรายการตีมูลค่าใหม่ของสินทรัพย์นี้รออนุมัติอยู่แล้ว' });
    const kind = delta > 0 ? 'revaluation' : 'impairment';
    const date = dto.reval_date ?? ymd();
    const lines: any[] = delta > 0
      ? [{ account_code: '1500', debit: delta }, { account_code: '3200', credit: delta }]      // upward: gross up, surplus to equity
      : [{ account_code: '5820', debit: -delta }, { account_code: '1500', credit: -delta }];    // impairment: loss, gross down
    // FA-08: post the JE as a DRAFT (excluded from balances) and DEFER the carrying-value change. A
    // different user must approve before the revaluation/impairment is effective.
    const je: any = await this.ledger.postEntry({
      // source_ref unique per event (old→new) so two revaluations of the same asset on the same day don't
      // collide on the JE idempotency key and silently dedupe.
      date, source: 'REVAL', sourceRef: `${assetNo}-${oldValue}-${newValue}-${date}`, tenantId: a.tenantId ?? user.tenantId ?? null,
      memo: `${kind === 'revaluation' ? 'Revaluation surplus' : 'Impairment'} ${assetNo}: ${oldValue} → ${newValue}`, createdBy: user.username, lines,
      pendingApproval: true,
    });
    await db.insert(assetRevaluations).values({
      tenantId: a.tenantId ?? null, assetId: Number(a.id), assetNo, revalDate: date, kind,
      oldValue: fx(oldValue, 4), newValue: fx(newValue, 4), delta: fx(delta, 4), reason: dto.reason ?? null,
      glRef: je?.entry_no ?? null, actionedBy: user.username, status: 'PendingApproval',
    });
    return { asset_no: assetNo, kind, old_value: oldValue, new_value: newValue, delta, status: 'PendingApproval', journal_no: je?.entry_no ?? null };
  }

  // FA-08 maker-checker: a DIFFERENT user approves the pending revaluation → the Draft JE becomes effective
  // AND the asset's carrying value moves. Reuses GL-05's approveEntry (approver ≠ preparer, period re-check).
  async approveRevaluation(assetNo: string, user: JwtUser) {
    const db = this.db;
    const rev = await this.pendingReval(assetNo);
    await this.ledger.approveEntry(rev.glRef!, user);
    const [a] = await db.select().from(fixedAssets).where(eq(fixedAssets.id, Number(rev.assetId))).limit(1);
    await db.update(fixedAssets).set({ netBookValue: fx(n(rev.newValue), 4), acquireCost: fx(round4(n(a?.acquireCost) + n(rev.delta)), 4) }).where(eq(fixedAssets.id, Number(rev.assetId)));
    await db.update(assetRevaluations).set({ status: 'Posted', approvedBy: user.username, approvedAt: new Date() }).where(eq(assetRevaluations.id, Number(rev.id)));
    return { asset_no: assetNo, kind: rev.kind, new_value: n(rev.newValue), delta: n(rev.delta), status: 'Posted', approved_by: user.username, prepared_by: rev.actionedBy, journal_no: rev.glRef };
  }

  // Reject a pending revaluation → voids the Draft JE; the carrying value never moved.
  async rejectRevaluation(assetNo: string, user: JwtUser, reason?: string) {
    const db = this.db;
    const rev = await this.pendingReval(assetNo);
    await this.ledger.rejectEntry(rev.glRef!, user, reason);
    await db.update(assetRevaluations).set({ status: 'Rejected' }).where(eq(assetRevaluations.id, Number(rev.id)));
    return { asset_no: assetNo, status: 'Rejected', rejected_by: user.username, journal_no: rev.glRef };
  }

  private async pendingReval(assetNo: string) {
    const db = this.db;
    const [rev] = await db.select().from(assetRevaluations).where(and(eq(assetRevaluations.assetNo, assetNo), eq(assetRevaluations.status, 'PendingApproval'))).orderBy(desc(assetRevaluations.id)).limit(1);
    if (!rev) throw new BadRequestException({ code: 'NO_PENDING_REVALUATION', message: `No revaluation pending approval for ${assetNo}`, messageTh: 'ไม่มีรายการตีมูลค่าใหม่ที่รออนุมัติสำหรับสินทรัพย์นี้' });
    return rev;
  }

  async listRevaluations(assetNo: string) {
    const db = this.db;
    const rows = await db.select().from(assetRevaluations).where(eq(assetRevaluations.assetNo, assetNo)).orderBy(desc(assetRevaluations.id));
    return { asset_no: assetNo, revaluations: rows.map((r: any) => ({ kind: r.kind, old_value: n(r.oldValue), new_value: n(r.newValue), delta: n(r.delta), reason: r.reason, reval_date: r.revalDate, status: r.status, journal_no: r.glRef, actioned_by: r.actionedBy, approved_by: r.approvedBy })), count: rows.length };
  }

  // ── QR asset tags ──────────────────────────────────────────────────────
  private async findAsset(assetNo: string, user: JwtUser) {
    const db = this.db;
    const conds = [eq(fixedAssets.assetNo, assetNo)];
    if (user.tenantId != null) conds.push(eq(fixedAssets.tenantId, user.tenantId)); // explicit predicate under Admin bypass
    const [a] = await db.select().from(fixedAssets).where(and(...conds)).limit(1);
    if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Asset not found', messageTh: 'ไม่พบสินทรัพย์' });
    return a;
  }

  async assetQr(assetNo: string, user: JwtUser) {
    const a = await this.findAsset(assetNo, user);
    const payload = buildAssetQrPayload({ assetNo: a.assetNo, name: a.name, loc: a.location ?? '', cat: '' });
    return { asset_no: a.assetNo, payload, data_url: await this.qr.dataUrl(payload) };
  }

  async assetLabels(_user: JwtUser, opts: { status?: string; cols?: number; rows?: number }) {
    const db = this.db;
    const where = opts.status ? eq(fixedAssets.status, opts.status as typeof fixedAssets.$inferSelect.status) : undefined;
    const rows = await db.select().from(fixedAssets).where(where).orderBy(asc(fixedAssets.assetNo));
    const labels = rows.map((a: any) => ({
      payload: buildAssetQrPayload({ assetNo: a.assetNo, name: a.name, loc: a.location ?? '', cat: '' }),
      title: a.assetNo,
      subtitle: a.name,
      lines: [a.location ? `📍 ${a.location}` : '', a.status].filter(Boolean) as string[],
      badge: 'ASSET TAG',
    }));
    return this.qr.labelsPdf(labels, opts.cols ?? 2, opts.rows ?? 4);
  }

  // Scan an asset tag → update its physical LOCATION / holder (not the accounting status enum).
  async scanUpdate(dto: { code: string; location?: string; assigned_to?: string; note?: string }, user: JwtUser) {
    const parsed = parseQrPayload(dto.code);
    const assetNo = (parsed.ASSET_ID || parsed.ITEM_ID || dto.code || '').trim();
    if (!assetNo) throw new BadRequestException({ code: 'NO_CODE', message: 'No asset code in QR', messageTh: 'ไม่พบรหัสทรัพย์สินใน QR' });
    const db = this.db;
    return db.transaction(async (tx: any) => {
      const conds = [eq(fixedAssets.assetNo, assetNo)];
      if (user.tenantId != null) conds.push(eq(fixedAssets.tenantId, user.tenantId));
      const [a] = await tx.select().from(fixedAssets).where(and(...conds)).limit(1).for('update');
      if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: `Asset ${assetNo} not found`, messageTh: 'ไม่พบสินทรัพย์' });
      const toLoc = dto.location ?? a.location ?? null;
      const set: any = { location: toLoc };
      if (dto.assigned_to !== undefined) set.assignedTo = dto.assigned_to;
      await tx.update(fixedAssets).set(set).where(eq(fixedAssets.id, a.id));
      await tx.insert(assetMovements).values({
        tenantId: a.tenantId ?? user.tenantId ?? null, assetId: Number(a.id), assetNo: a.assetNo,
        moveType: 'Scan Update', fromLocation: a.location ?? null, toLocation: toLoc,
        fromStatus: a.status, toStatus: a.status, note: dto.note ?? null, byUser: user.username,
      });
      return { asset_no: a.assetNo, location: toLoc, assigned_to: set.assignedTo ?? a.assignedTo ?? null };
    });
  }

  async assetRegister(_user: JwtUser, status?: string) {
    const db = this.db;
    const where = status ? eq(fixedAssets.status, status as typeof fixedAssets.$inferSelect.status) : undefined;
    const rows = await db.select().from(fixedAssets).where(where).orderBy(asc(fixedAssets.assetNo));
    const assets = rows.map(shapeAsset);
    return {
      assets, count: assets.length,
      total_cost: round4(assets.reduce((a: number, r: any) => a + r.acquire_cost, 0)),
      total_accum_dep: round4(assets.reduce((a: number, r: any) => a + r.accumulated_depreciation, 0)),
      total_nbv: round4(assets.reduce((a: number, r: any) => a + r.net_book_value, 0)),
    };
  }

  async depreciationSchedule(_user: JwtUser, assetNo: string) {
    const db = this.db;
    const [a] = await db.select().from(fixedAssets).where(eq(fixedAssets.assetNo, assetNo)).limit(1);
    if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Asset not found', messageTh: 'ไม่พบสินทรัพย์' });
    const rows = await db.select({ period: depreciationRuns.period, amount: depreciationLines.amount, accumulatedAfter: depreciationLines.accumulatedAfter, nbvAfter: depreciationLines.nbvAfter })
      .from(depreciationLines).innerJoin(depreciationRuns, eq(depreciationLines.runId, depreciationRuns.id)).where(eq(depreciationLines.assetId, Number(a.id))).orderBy(asc(depreciationRuns.period));
    return { asset: shapeAsset(a), schedule: rows.map((r: any) => ({ period: r.period, amount: n(r.amount), accumulated_after: n(r.accumulatedAfter), nbv_after: n(r.nbvAfter) })) };
  }

  async listRuns(_user: JwtUser, limit = 50) {
    const db = this.db;
    const rows = await db.select().from(depreciationRuns).orderBy(desc(depreciationRuns.id)).limit(limit);
    return { runs: rows.map((r: any) => ({ run_no: r.runNo, period: r.period, total_depreciation: n(r.totalDepreciation), asset_count: r.assetCount, journal_no: r.journalNo, posted_at: r.postedAt })), count: rows.length };
  }
}

function shapeCat(c: any) { return { id: Number(c.id), code: c.code, name: c.name, default_useful_life_years: c.defaultUsefulLifeYears, asset_account: c.assetAccount, accum_dep_account: c.accumDepAccount, dep_expense_account: c.depExpenseAccount }; }
function shapeReg(r: any) {
  return { reg_no: r.regNo, gr_no: r.grNo, po_no: r.poNo, gr_item_id: r.grItemId != null ? Number(r.grItemId) : null, item_id: r.itemId, name: r.name, category_id: r.categoryId != null ? Number(r.categoryId) : null, acquire_date: r.acquireDate, acquire_cost: n(r.acquireCost), salvage_value: n(r.salvageValue), useful_life_months: r.usefulLifeMonths, location: r.location ?? null, department: r.department ?? null, serial_no: r.serialNo ?? null, status: r.status, asset_no: r.assetNo ?? null, requested_by: r.requestedBy ?? null, requested_at: r.requestedAt, approved_by: r.approvedBy ?? null, approved_at: r.approvedAt ?? null, reject_reason: r.rejectReason ?? null };
}
function shapeAsset(a: any) {
  return { asset_no: a.assetNo, name: a.name, category_id: a.categoryId, status: a.status, acquire_date: a.acquireDate, acquire_cost: n(a.acquireCost), salvage_value: n(a.salvageValue), useful_life_months: a.usefulLifeMonths, accumulated_depreciation: n(a.accumulatedDepreciation), net_book_value: n(a.netBookValue), last_depreciated_period: a.lastDepreciatedPeriod, disposed_date: a.disposedDate, disposal_proceeds: a.disposalProceeds != null ? n(a.disposalProceeds) : null, disposal_gain_loss: a.disposalGainLoss != null ? n(a.disposalGainLoss) : null, disposal_pending: a.disposalPending === true, disposal_requested_by: a.disposalRequestedBy ?? null, disposal_approved_by: a.disposalApprovedBy ?? null, location: a.location ?? null, department: a.department ?? null, serial_no: a.serialNo ?? null, assigned_to: a.assignedTo ?? null, source_gr_no: a.sourceGrNo ?? null, source_po_no: a.sourcePoNo ?? null };
}
