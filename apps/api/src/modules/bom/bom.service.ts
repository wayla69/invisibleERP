import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { sql, eq, and, inArray, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import {
  bomMaster, bomMasterLines, bomSubmissions, bomSubmissionLines,
  custBom, custBomLines, custProdRuns, custProdItems,
  customerInventory, custStockLog, items, tenants,
} from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import { ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';

const n = (v: unknown) => Number(v ?? 0);
const round2 = (x: number) => Math.round(x * 100) / 100;

export interface BomLineDto {
  item_id: string;
  item_description?: string;
  buy_uom?: string;
  use_uom?: string;
  conv_factor?: number;
  qty_use_uom?: number;
  unit_cost?: number;
  notes?: string;
}
export interface BomMasterDto {
  bom_code: string;
  product_name?: string;
  yield_qty?: number;
  yield_uom?: string;
  labor_cost?: number;
  overhead_cost?: number;
  other_cost?: number;
  selling_price?: number;
  notes?: string;
  lines?: BomLineDto[];
}
export interface PushDto { bom_codes: string[]; tenant_codes: string[] }
export interface PortalBomDto extends BomMasterDto { product_item_id?: string }
export interface ProductionRunDto { batch_qty?: number; run_date?: string }

// ─── parity costing ──────────────────────────────────────────────
// per line: qtyBuyUom = qtyUseUom / convFactor ; lineCost = qtyBuyUom * unitCost
// per BOM:  rawCost = Σ lineCost ; total = rawCost + labor + overhead + other
//           costPerUnit = total / max(yieldQty, 0.001)
//           margin% = (sellingPrice - costPerUnit)/max(sellingPrice,0.001)*100
function computeLine(line: BomLineDto, unitCostOverride?: number) {
  const conv = n(line.conv_factor) || 1;
  const qtyUse = n(line.qty_use_uom);
  const qtyBuy = qtyUse / conv;
  const unitCost = unitCostOverride != null ? unitCostOverride : n(line.unit_cost);
  const lineCost = qtyBuy * unitCost;
  return { qtyBuy, unitCost, lineCost: round2(lineCost) };
}

function computeBom(header: BomMasterDto, computedLines: { lineCost: number }[]) {
  const rawCost = computedLines.reduce((a, l) => a + l.lineCost, 0);
  const total = rawCost + n(header.labor_cost) + n(header.overhead_cost) + n(header.other_cost);
  const yieldQty = Math.max(n(header.yield_qty) || 1, 0.001);
  const costPerUnit = total / yieldQty;
  const selling = n(header.selling_price);
  const marginPct = ((selling - costPerUnit) / Math.max(selling, 0.001)) * 100;
  return {
    rawCost: round2(rawCost),
    total: round2(total),
    costPerUnit: round2(costPerUnit),
    marginPct: round2(marginPct),
  };
}

@Injectable()
export class BomService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly statusLog: StatusLogService,
  ) {}

  // resolve raw-material unit cost from items.unitPrice
  private async unitCostFor(db: any, itemId: string, fallback: number): Promise<number> {
    if (!itemId) return fallback;
    const [it] = await db.select({ p: items.unitPrice }).from(items).where(eq(items.itemId, itemId)).limit(1);
    return it != null ? n(it.p) : fallback;
  }

  private async resolveTenant(db: any, code: string | null) {
    if (!code) throw new BadRequestException({ code: 'NO_TENANT', message: 'No tenant resolved', messageTh: 'ไม่พบลูกค้า' });
    const [t] = await db.select().from(tenants).where(eq(tenants.code, code)).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Tenant not found', messageTh: 'ไม่พบลูกค้า' });
    return t;
  }

  // ───────────────────── HQ MASTER LIBRARY ─────────────────────
  async listMaster(limit: number, offset: number) {
    const db = this.db;
    const heads = await db.select().from(bomMaster).orderBy(desc(bomMaster.bomCode)).limit(limit).offset(offset);
    const out = [];
    for (const h of heads) {
      const lines = await db.select().from(bomMasterLines).where(eq(bomMasterLines.bomId, h.id));
      out.push(this.masterView(h, lines));
    }
    return { boms: out, count: out.length };
  }

  async getMaster(bomCode: string) {
    const db = this.db;
    const [h] = await db.select().from(bomMaster).where(eq(bomMaster.bomCode, bomCode)).limit(1);
    if (!h) throw new NotFoundException({ code: 'NOT_FOUND', message: 'BOM not found', messageTh: 'ไม่พบสูตรผลิต' });
    const lines = await db.select().from(bomMasterLines).where(eq(bomMasterLines.bomId, h.id));
    return this.masterView(h, lines);
  }

  private masterView(h: any, lines: any[]) {
    const cl = lines.map((l: any) => ({ lineCost: n(l.lineCost) }));
    const costing = computeBom({
      bom_code: h.bomCode, yield_qty: n(h.yieldQty), labor_cost: n(h.laborCost),
      overhead_cost: n(h.overheadCost), other_cost: n(h.otherCost), selling_price: n(h.sellingPrice),
    }, cl);
    return {
      bom_code: h.bomCode, product_name: h.productName, yield_qty: n(h.yieldQty), yield_uom: h.yieldUom,
      labor_cost: n(h.laborCost), overhead_cost: n(h.overheadCost), other_cost: n(h.otherCost),
      selling_price: n(h.sellingPrice), notes: h.notes, created_at: h.createdAt, created_by: h.createdBy,
      lines: lines.map((l: any) => ({
        item_id: l.itemId, item_description: l.itemDescription, buy_uom: l.buyUom, use_uom: l.useUom,
        conv_factor: n(l.convFactor), qty_use_uom: n(l.qtyUseUom), qty_buy_uom: n(l.qtyBuyUom),
        unit_cost: n(l.unitCost), line_cost: n(l.lineCost), notes: l.notes,
      })),
      ...costing,
    };
  }

  // POST/PATCH — INSERT OR REPLACE by bomCode (recompute costing). Returns full view.
  async upsertMaster(dto: BomMasterDto, user: JwtUser) {
    const db = this.db;
    if (!dto.bom_code) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'bom_code required', messageTh: 'ต้องระบุรหัสสูตร' });
    const inLines = dto.lines ?? [];

    // resolve unit costs from items master + compute line/bom costing
    const computed: { line: BomLineDto; qtyBuy: number; unitCost: number; lineCost: number }[] = [];
    for (const line of inLines) {
      const uc = await this.unitCostFor(db, line.item_id, n(line.unit_cost));
      const c = computeLine(line, uc);
      computed.push({ line, ...c });
    }
    const costing = computeBom(dto, computed);

    await db.transaction(async (tx: any) => {
      const [existing] = await tx.select({ id: bomMaster.id }).from(bomMaster).where(eq(bomMaster.bomCode, dto.bom_code)).limit(1);
      let bomId: number;
      const headVals = {
        bomCode: dto.bom_code, productName: dto.product_name ?? null,
        yieldQty: String(n(dto.yield_qty) || 1), yieldUom: dto.yield_uom ?? null,
        laborCost: String(n(dto.labor_cost)), overheadCost: String(n(dto.overhead_cost)),
        otherCost: String(n(dto.other_cost)), sellingPrice: String(n(dto.selling_price)),
        notes: dto.notes ?? null,
      };
      if (existing) {
        bomId = Number(existing.id);
        await tx.update(bomMaster).set(headVals).where(eq(bomMaster.id, bomId));
        await tx.delete(bomMasterLines).where(eq(bomMasterLines.bomId, bomId));
      } else {
        const [h] = await tx.insert(bomMaster).values({ ...headVals, createdAt: new Date(), createdBy: user.username })
          .returning({ id: bomMaster.id });
        bomId = Number(h.id);
      }
      if (computed.length) {
        await tx.insert(bomMasterLines).values(computed.map((c) => ({
          bomId, itemId: c.line.item_id, itemDescription: c.line.item_description ?? null,
          buyUom: c.line.buy_uom ?? null, useUom: c.line.use_uom ?? null,
          convFactor: String(n(c.line.conv_factor) || 1), qtyUseUom: String(n(c.line.qty_use_uom)),
          qtyBuyUom: String(c.qtyBuy), unitCost: String(c.unitCost), lineCost: String(c.lineCost),
          notes: c.line.notes ?? null,
        })));
      }
    });
    await this.statusLog.log('BOM', dto.bom_code, '', 'Saved', user.username);
    return { bom_code: dto.bom_code, lines: computed.length, ...costing };
  }

  async deleteMaster(bomCode: string, user: JwtUser) {
    const db = this.db;
    const [h] = await db.select({ id: bomMaster.id }).from(bomMaster).where(eq(bomMaster.bomCode, bomCode)).limit(1);
    if (!h) throw new NotFoundException({ code: 'NOT_FOUND', message: 'BOM not found', messageTh: 'ไม่พบสูตรผลิต' });
    await db.transaction(async (tx: any) => {
      await tx.delete(bomMasterLines).where(eq(bomMasterLines.bomId, Number(h.id)));
      await tx.delete(bomMaster).where(eq(bomMaster.id, Number(h.id)));
    });
    await this.statusLog.log('BOM', bomCode, '', 'Deleted', user.username);
    return { bom_code: bomCode, deleted: true };
  }

  // POST /api/bom/master/push — for each (bom x tenant): delete-then-insert into custBom + custBomLines
  async pushMaster(dto: PushDto, user: JwtUser) {
    const db = this.db;
    const bomCodes = dto.bom_codes ?? [];
    const tenantCodes = dto.tenant_codes ?? [];
    if (!bomCodes.length || !tenantCodes.length)
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'bom_codes and tenant_codes required', messageTh: 'ต้องระบุสูตรและลูกค้า' });

    let pushed = 0;
    await db.transaction(async (tx: any) => {
      // resolve tenants
      const tenantRows = await tx.select().from(tenants).where(inArray(tenants.code, tenantCodes));
      for (const bomCode of bomCodes) {
        const [h] = await tx.select().from(bomMaster).where(eq(bomMaster.bomCode, bomCode)).limit(1);
        if (!h) continue;
        const lines = await tx.select().from(bomMasterLines).where(eq(bomMasterLines.bomId, h.id));
        for (const t of tenantRows) {
          // delete-then-insert (tenant-scoped) — clear existing cust_bom for this code+tenant
          const existing = await tx.select({ id: custBom.id }).from(custBom)
            .where(and(eq(custBom.bomCode, bomCode), eq(custBom.tenantId, Number(t.id))));
          for (const e of existing) {
            await tx.delete(custBomLines).where(eq(custBomLines.custBomId, Number(e.id)));
            await tx.delete(custBom).where(eq(custBom.id, Number(e.id)));
          }
          const [cb] = await tx.insert(custBom).values({
            bomCode: h.bomCode, tenantId: Number(t.id), productName: h.productName, productItemId: null,
            yieldQty: h.yieldQty, yieldUom: h.yieldUom, laborCost: h.laborCost, overheadCost: h.overheadCost,
            otherCost: h.otherCost, sellingPrice: h.sellingPrice, active: true, notes: h.notes, createdAt: new Date(),
          }).returning({ id: custBom.id });
          if (lines.length) {
            await tx.insert(custBomLines).values(lines.map((l: any) => ({
              custBomId: Number(cb.id), tenantId: Number(t.id), itemId: l.itemId, itemDescription: l.itemDescription,
              buyUom: l.buyUom, useUom: l.useUom, convFactor: l.convFactor, qtyUseUom: l.qtyUseUom,
              qtyBuyUom: l.qtyBuyUom, unitCost: l.unitCost, lineCost: l.lineCost, notes: l.notes,
            })));
          }
          pushed++;
        }
      }
    });
    return { pushed, bom_codes: bomCodes.length, tenant_codes: tenantCodes.length };
  }

  // ───────────────────── SUBMISSIONS (tenant → HQ approval) ─────────────────────
  async listSubmissions(status: string | undefined, limit: number, offset: number) {
    const db = this.db;
    const where = status ? sql`${bomSubmissions.status}::text = ${status}` : undefined;
    const rows = await db.select({
      id: bomSubmissions.id, bom_code: bomSubmissions.bomCode, tenant_code: tenants.code,
      product_name: bomSubmissions.productName, yield_qty: bomSubmissions.yieldQty, yield_uom: bomSubmissions.yieldUom,
      selling_price: bomSubmissions.sellingPrice, status: bomSubmissions.status, submitted_at: bomSubmissions.submittedAt,
    }).from(bomSubmissions).leftJoin(tenants, eq(bomSubmissions.tenantId, tenants.id))
      .where(where).orderBy(desc(bomSubmissions.submittedAt)).limit(limit).offset(offset);
    return {
      submissions: rows.map((r: any) => ({ ...r, yield_qty: n(r.yield_qty), selling_price: n(r.selling_price) })),
      count: rows.length,
    };
  }

  // PATCH /api/bom/submissions/:id/approve — copy submission → bomMaster (+lines), status 'Approved'
  async approveSubmission(id: number, user: JwtUser) {
    const db = this.db;
    const [sub] = await db.select().from(bomSubmissions).where(eq(bomSubmissions.id, id)).limit(1);
    if (!sub) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Submission not found', messageTh: 'ไม่พบคำขอ' });
    // SoD maker-checker (audit #6): a BoM submission drives product-costing master data, so the approver must
    // differ from the submitter — a user holding both cust_bom (submit) and bom_master (approve) can no longer
    // self-approve. Enterprise ⇒ 403 SOD_SELF_APPROVAL; an SME tenant records a justified self-approval.
    await assertMakerChecker(db, { user, maker: sub.submittedBy, event: 'bom.submission.approve', ref: sub.bomCode ?? String(id), code: 'SOD_SELF_APPROVAL' });
    const subLines = await db.select().from(bomSubmissionLines).where(eq(bomSubmissionLines.submissionId, id));

    await db.transaction(async (tx: any) => {
      // upsert into bomMaster by bom_code (INSERT OR REPLACE)
      const [existing] = await tx.select({ id: bomMaster.id }).from(bomMaster).where(eq(bomMaster.bomCode, sub.bomCode!)).limit(1);
      const headVals = {
        bomCode: sub.bomCode, productName: sub.productName, yieldQty: sub.yieldQty, yieldUom: sub.yieldUom,
        laborCost: sub.laborCost, overheadCost: sub.overheadCost, otherCost: sub.otherCost, sellingPrice: sub.sellingPrice,
        notes: sub.notes,
      };
      let bomId: number;
      if (existing) {
        bomId = Number(existing.id);
        await tx.update(bomMaster).set(headVals).where(eq(bomMaster.id, bomId));
        await tx.delete(bomMasterLines).where(eq(bomMasterLines.bomId, bomId));
      } else {
        const [h] = await tx.insert(bomMaster).values({ ...headVals, createdAt: new Date(), createdBy: user.username })
          .returning({ id: bomMaster.id });
        bomId = Number(h.id);
      }
      if (subLines.length) {
        await tx.insert(bomMasterLines).values(subLines.map((l: any) => ({
          bomId, itemId: l.itemId, itemDescription: l.itemDescription, buyUom: l.buyUom, useUom: l.useUom,
          convFactor: l.convFactor, qtyUseUom: l.qtyUseUom, qtyBuyUom: l.qtyBuyUom,
          unitCost: l.unitCost, lineCost: l.lineCost, notes: l.notes,
        })));
      }
      await tx.update(bomSubmissions).set({ status: 'Approved' }).where(eq(bomSubmissions.id, id));
    });
    await this.statusLog.log('BOM_SUB', String(id), sub.status ?? '', 'Approved', user.username, sub.bomCode ?? undefined);
    return { id, bom_code: sub.bomCode, status: 'Approved' };
  }

  // ───────────────────── PORTAL (tenant BOM) ─────────────────────
  async listPortalBom(user: JwtUser) {
    const db = this.db;
    const t = await this.resolveTenant(db, user.customerName);
    const heads = await db.select().from(custBom).where(eq(custBom.tenantId, Number(t.id))).orderBy(desc(custBom.bomCode));
    const out = [];
    for (const h of heads) {
      const lines = await db.select().from(custBomLines).where(eq(custBomLines.custBomId, h.id));
      out.push({
        bom_code: h.bomCode, product_name: h.productName, product_item_id: h.productItemId,
        yield_qty: n(h.yieldQty), yield_uom: h.yieldUom, labor_cost: n(h.laborCost), overhead_cost: n(h.overheadCost),
        other_cost: n(h.otherCost), selling_price: n(h.sellingPrice), active: !!h.active, notes: h.notes,
        lines: lines.map((l: any) => ({
          item_id: l.itemId, item_description: l.itemDescription, buy_uom: l.buyUom, use_uom: l.useUom,
          conv_factor: n(l.convFactor), qty_use_uom: n(l.qtyUseUom), qty_buy_uom: n(l.qtyBuyUom),
          unit_cost: n(l.unitCost), line_cost: n(l.lineCost), notes: l.notes,
        })),
      });
    }
    return { boms: out, count: out.length };
  }

  // POST /api/portal/bom — tenant BOM (custBom+custBomLines) AND dual-write to bomSubmissions+lines (Pending)
  async createPortalBom(dto: PortalBomDto, user: JwtUser) {
    const db = this.db;
    if (!dto.bom_code) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'bom_code required', messageTh: 'ต้องระบุรหัสสูตร' });
    const t = await this.resolveTenant(db, user.customerName);
    const tenantId = Number(t.id);
    const inLines = dto.lines ?? [];

    // recompute costing (use items master cost when available)
    const computed: { line: BomLineDto; qtyBuy: number; unitCost: number; lineCost: number }[] = [];
    for (const line of inLines) {
      const uc = await this.unitCostFor(db, line.item_id, n(line.unit_cost));
      const c = computeLine(line, uc);
      computed.push({ line, ...c });
    }
    const costing = computeBom(dto, computed);

    let submissionId = 0;
    await db.transaction(async (tx: any) => {
      // ── tenant-side cust_bom (INSERT OR REPLACE by bom_code + tenant) ──
      const existing = await tx.select({ id: custBom.id }).from(custBom)
        .where(and(eq(custBom.bomCode, dto.bom_code), eq(custBom.tenantId, tenantId)));
      for (const e of existing) {
        await tx.delete(custBomLines).where(eq(custBomLines.custBomId, Number(e.id)));
        await tx.delete(custBom).where(eq(custBom.id, Number(e.id)));
      }
      const headVals = {
        bomCode: dto.bom_code, tenantId, productName: dto.product_name ?? null, productItemId: dto.product_item_id ?? null,
        yieldQty: String(n(dto.yield_qty) || 1), yieldUom: dto.yield_uom ?? null,
        laborCost: String(n(dto.labor_cost)), overheadCost: String(n(dto.overhead_cost)),
        otherCost: String(n(dto.other_cost)), sellingPrice: String(n(dto.selling_price)),
        active: true, notes: dto.notes ?? null, createdAt: new Date(),
      };
      const [cb] = await tx.insert(custBom).values(headVals).returning({ id: custBom.id });
      const linePayload = computed.map((c) => ({
        itemId: c.line.item_id, itemDescription: c.line.item_description ?? null,
        buyUom: c.line.buy_uom ?? null, useUom: c.line.use_uom ?? null,
        convFactor: String(n(c.line.conv_factor) || 1), qtyUseUom: String(n(c.line.qty_use_uom)),
        qtyBuyUom: String(c.qtyBuy), unitCost: String(c.unitCost), lineCost: String(c.lineCost), notes: c.line.notes ?? null,
      }));
      if (linePayload.length) {
        await tx.insert(custBomLines).values(linePayload.map((l) => ({ custBomId: Number(cb.id), tenantId, ...l })));
      }

      // ── dual-write HQ approval queue (bom_submissions, status Pending) ──
      const [sub] = await tx.insert(bomSubmissions).values({
        bomCode: dto.bom_code, tenantId, productName: dto.product_name ?? null,
        yieldQty: String(n(dto.yield_qty) || 1), yieldUom: dto.yield_uom ?? null,
        laborCost: String(n(dto.labor_cost)), overheadCost: String(n(dto.overhead_cost)),
        otherCost: String(n(dto.other_cost)), sellingPrice: String(n(dto.selling_price)),
        notes: dto.notes ?? null, submittedAt: new Date(), submittedBy: user.username, status: 'Pending',
      }).returning({ id: bomSubmissions.id });
      submissionId = Number(sub.id);
      if (linePayload.length) {
        await tx.insert(bomSubmissionLines).values(linePayload.map((l) => ({ submissionId, tenantId, ...l })));
      }
    });
    await this.statusLog.log('BOM_SUB', String(submissionId), '', 'Pending', user.username, dto.bom_code);
    return { bom_code: dto.bom_code, submission_id: submissionId, status: 'Pending', lines: computed.length, ...costing };
  }

  // POST /api/portal/bom/:code/production-runs
  // runNo via nextTenantStamped('PRD', code); required = qtyBuyUom*batchQty per line;
  // insert custProdRuns + custProdItems; decrement raw-material customerInventory (MAX 0) + log 'Production';
  // add finished good (+= yieldQty*batchQty) + log 'Production-FG'. Transaction.
  async createProductionRun(bomCode: string, dto: ProductionRunDto, user: JwtUser) {
    const db = this.db;
    const t = await this.resolveTenant(db, user.customerName);
    const tenantId = Number(t.id);
    const batchQty = n(dto.batch_qty) || 1;

    const [cb] = await db.select().from(custBom)
      .where(and(eq(custBom.bomCode, bomCode), eq(custBom.tenantId, tenantId))).limit(1);
    if (!cb) throw new NotFoundException({ code: 'NOT_FOUND', message: 'BOM not found for tenant', messageTh: 'ไม่พบสูตรผลิตของลูกค้า' });
    const lines = await db.select().from(custBomLines).where(eq(custBomLines.custBomId, cb.id));
    if (!lines.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'BOM has no lines', messageTh: 'สูตรผลิตไม่มีรายการ' });

    const runNo = this.docNo.nextTenantStamped('PRD', bomCode);
    const runDate = dto.run_date ?? ymd();
    const now = new Date();

    const totalCost = lines.reduce((a: number, l: any) => a + n(l.lineCost) * batchQty, 0);
    const yieldQty = n(cb.yieldQty) || 1;
    const fgQty = yieldQty * batchQty;
    const fgItemId = cb.productItemId || bomCode;
    const fgDesc = cb.productName ?? bomCode;

    await db.transaction(async (tx: any) => {
      const [run] = await tx.insert(custProdRuns).values({
        runNo, bomCode, tenantId, runDate, batchQty: String(batchQty),
        status: 'Completed', totalCost: String(round2(totalCost)), createdBy: user.username,
      }).returning({ id: custProdRuns.id });
      const runId = Number(run.id);

      for (const l of lines) {
        const required = n(l.qtyBuyUom) * batchQty;
        await tx.insert(custProdItems).values({
          runId, itemId: l.itemId, itemDescription: l.itemDescription,
          theoreticalQty: String(required), actualQty: String(required), variance: '0', uom: l.buyUom,
        });
        // decrement raw-material inventory (MAX 0)
        const [inv] = await tx.select().from(customerInventory)
          .where(and(eq(customerInventory.tenantId, tenantId), eq(customerInventory.itemId, l.itemId!))).limit(1);
        const before = n(inv?.currentStock);
        const after = Math.max(before - required, 0);
        if (inv) {
          await tx.update(customerInventory).set({ currentStock: String(after), lastUpdated: now })
            .where(eq(customerInventory.id, inv.id));
        } else {
          await tx.insert(customerInventory).values({
            tenantId, itemId: l.itemId, itemDescription: l.itemDescription, uom: l.buyUom,
            currentStock: String(after), lastUpdated: now,
          });
        }
        await tx.insert(custStockLog).values({
          tenantId, itemId: l.itemId, itemDescription: l.itemDescription, logDate: now, logType: 'Production',
          qtyChange: String(-required), balanceAfter: String(after), refDoc: runNo, createdBy: user.username,
        });
      }

      // add finished good (+= yieldQty * batchQty)
      const [fgInv] = await tx.select().from(customerInventory)
        .where(and(eq(customerInventory.tenantId, tenantId), eq(customerInventory.itemId, fgItemId))).limit(1);
      const fgBefore = n(fgInv?.currentStock);
      const fgAfter = fgBefore + fgQty;
      if (fgInv) {
        await tx.update(customerInventory).set({ currentStock: String(fgAfter), lastUpdated: now })
          .where(eq(customerInventory.id, fgInv.id));
      } else {
        await tx.insert(customerInventory).values({
          tenantId, itemId: fgItemId, itemDescription: fgDesc, uom: cb.yieldUom,
          currentStock: String(fgAfter), lastUpdated: now,
        });
      }
      await tx.insert(custStockLog).values({
        tenantId, itemId: fgItemId, itemDescription: fgDesc, logDate: now, logType: 'Production-FG',
        qtyChange: String(fgQty), balanceAfter: String(fgAfter), refDoc: runNo, createdBy: user.username,
      });
    });
    await this.statusLog.log('PRD', runNo, '', 'Completed', user.username, bomCode);
    return { run_no: runNo, bom_code: bomCode, batch_qty: batchQty, fg_qty: fgQty, total_cost: round2(totalCost), lines: lines.length };
  }
}
