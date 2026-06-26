import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { workOrders, workOrderComponents, bomMaster, bomMasterLines, stockMovements } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
const r4 = (x: unknown) => Math.round((Number(x) || 0) * 10000) / 10000;

export interface CreateWoDto { bom_code: string; qty_planned: number; product_item_id?: string; product_name?: string }

@Injectable()
export class ManufacturingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly ledger: LedgerService,
  ) {}

  // Create a work order from a BOM — scale components + labor/overhead to the planned qty (BOM-standard cost).
  async createWorkOrder(dto: CreateWoDto, user: JwtUser) {
    const db = this.db as any;
    const qty = n(dto.qty_planned);
    if (qty <= 0) throw new BadRequestException({ code: 'BAD_QTY', message: 'qty_planned must be positive', messageTh: 'จำนวนผลิตต้องมากกว่าศูนย์' });
    const [bom] = await db.select().from(bomMaster).where(eq(bomMaster.bomCode, dto.bom_code)).limit(1);
    if (!bom) throw new NotFoundException({ code: 'BOM_NOT_FOUND', message: `BOM ${dto.bom_code} not found`, messageTh: 'ไม่พบสูตรการผลิต (BOM)' });

    const lines = await db.select().from(bomMasterLines).where(eq(bomMasterLines.bomId, Number(bom.id)));
    const yieldQty = n(bom.yieldQty) || 1;
    const factor = qty / yieldQty; // scale BOM (defined per yield) up to the planned qty

    const comps = lines.map((l: any) => {
      const baseQty = n(l.qtyUseUom);
      const unitCost = n(l.unitCost);
      const baseLine = n(l.lineCost) || baseQty * unitCost;
      return {
        itemId: l.itemId, itemDescription: l.itemDescription, uom: l.useUom,
        qtyRequired: r4(baseQty * factor), unitCost: r4(unitCost), lineCost: r2(baseLine * factor),
      };
    });
    const materialCost = r2(comps.reduce((a: number, c: any) => a + c.lineCost, 0));
    const laborCost = r2(n(bom.laborCost) * factor);
    const overheadCost = r2(n(bom.overheadCost) * factor);
    const totalCost = r2(materialCost + laborCost + overheadCost);
    const unitCost = r4(totalCost / qty);

    const woNo = await this.docNo.nextDaily('WO');
    const tenantId = user.tenantId ?? null;
    const [wo] = await db.insert(workOrders).values({
      tenantId, woNo, bomId: Number(bom.id), bomCode: bom.bomCode,
      productItemId: dto.product_item_id ?? bom.bomCode, productName: dto.product_name ?? bom.productName, uom: bom.yieldUom,
      qtyPlanned: fx(qty, 3), status: 'Open', materialCost: fx(materialCost, 2), laborCost: fx(laborCost, 2),
      overheadCost: fx(overheadCost, 2), totalCost: fx(totalCost, 2), unitCost: fx(unitCost, 4), createdBy: user.username,
    }).returning({ id: workOrders.id });
    if (comps.length)
      await db.insert(workOrderComponents).values(comps.map((c: any) => ({
        woId: Number(wo.id), tenantId, itemId: c.itemId, itemDescription: c.itemDescription, uom: c.uom,
        qtyRequired: fx(c.qtyRequired, 3), unitCost: fx(c.unitCost, 4), lineCost: fx(c.lineCost, 2),
      })));
    return this.get(woNo);
  }

  // Release/issue: consume components into WIP. Stock issues + GL Dr WIP / Cr Inventory(material) / Cr Mfg-Applied(labor+oh).
  async issue(woNo: string, user: JwtUser) {
    const db = this.db as any;
    const wo = await this.row(woNo);
    if (wo.status !== 'Open') throw new BadRequestException({ code: 'BAD_STATUS', message: `Work order is ${wo.status}, cannot issue`, messageTh: 'ใบสั่งผลิตไม่อยู่ในสถานะที่เบิกได้' });
    const tenantId = wo.tenantId ?? user.tenantId ?? null;
    if (await this.ledger.alreadyPosted('WO-ISSUE', woNo, tenantId)) return { already: true, wo_no: woNo };

    const comps = await db.select().from(workOrderComponents).where(eq(workOrderComponents.woId, Number(wo.id)));
    const now = new Date();
    for (const c of comps)
      await db.insert(stockMovements).values({
        moveDate: now, docNo: woNo, moveType: 'Issue', itemId: c.itemId, itemDescription: c.itemDescription,
        uom: c.uom, qty: fx(-n(c.qtyRequired), 3), refDoc: woNo, remarks: 'WO component issue', createdBy: user.username,
      });

    const material = n(wo.materialCost), labor = n(wo.laborCost), oh = n(wo.overheadCost);
    const applied = r2(labor + oh);
    const lines = [
      { account_code: '1250', debit: r2(material + applied), memo: `WIP ${woNo}` },
      { account_code: '1200', credit: material, memo: 'Materials issued' },
    ];
    if (applied > 0) lines.push({ account_code: '2380', credit: applied, memo: 'Labor + overhead applied' });
    const je: any = await this.ledger.postEntry({ source: 'WO-ISSUE', sourceRef: woNo, tenantId, memo: `Work order issue ${woNo}`, createdBy: user.username, lines });

    await db.update(workOrders).set({ status: 'Released', entryNoIssue: je.entry_no, startedAt: now }).where(eq(workOrders.id, Number(wo.id)));
    return { wo_no: woNo, status: 'Released', entry_no: je.entry_no, wip_cost: r2(material + applied) };
  }

  // Complete: receive finished goods. Stock receipt + GL Dr Finished Goods / Cr WIP (total cost).
  async complete(woNo: string, qtyProduced: number | undefined, user: JwtUser) {
    const db = this.db as any;
    const wo = await this.row(woNo);
    if (wo.status !== 'Released') throw new BadRequestException({ code: 'BAD_STATUS', message: `Work order is ${wo.status}, must be Released to complete`, messageTh: 'ต้องเบิกวัตถุดิบ (Released) ก่อนปิดงาน' });
    const tenantId = wo.tenantId ?? user.tenantId ?? null;
    if (await this.ledger.alreadyPosted('WO-DONE', woNo, tenantId)) return { already: true, wo_no: woNo };

    const produced = qtyProduced != null && n(qtyProduced) > 0 ? n(qtyProduced) : n(wo.qtyPlanned);
    const total = n(wo.totalCost), planned = n(wo.qtyPlanned);
    // YIELD VARIANCE: WIP was charged the full PLANNED-batch cost at issue. Value finished goods at the
    // standard unit cost × the ACTUAL quantity produced, and book the difference to 5810 — a yield LOSS
    // (produced < planned: e.g. spoilage/waste) DEBITS 5810; an over-yield CREDITS it. Full yield → variance
    // 0 → FG = full cost (unchanged). WIP is always fully relieved (FG + variance = total).
    const stdUnit = planned > 0 ? total / planned : 0;
    const fgValue = r2(stdUnit * produced);
    const variance = r2(total - fgValue);
    const now = new Date();
    await db.insert(stockMovements).values({
      moveDate: now, docNo: woNo, moveType: 'Stock In', itemId: wo.productItemId, itemDescription: wo.productName,
      uom: wo.uom, qty: fx(produced, 3), refDoc: woNo, remarks: 'WO finished goods receipt', createdBy: user.username,
    });

    const lines: any[] = [{ account_code: '1210', debit: fgValue, memo: 'Finished goods' }];
    if (variance > 0.005) lines.push({ account_code: '5810', debit: variance, memo: `Yield variance (loss) ${woNo}` });
    else if (variance < -0.005) lines.push({ account_code: '5810', credit: r2(-variance), memo: `Yield variance (gain) ${woNo}` });
    lines.push({ account_code: '1250', credit: total, memo: `WIP cleared ${woNo}` });
    const je: any = await this.ledger.postEntry({
      source: 'WO-DONE', sourceRef: woNo, tenantId, memo: `Work order complete ${woNo}`, createdBy: user.username, lines,
    });

    await db.update(workOrders).set({ status: 'Completed', qtyProduced: fx(produced, 3), entryNoComplete: je.entry_no, completedAt: now }).where(eq(workOrders.id, Number(wo.id)));
    return { wo_no: woNo, status: 'Completed', entry_no: je.entry_no, qty_planned: planned, qty_produced: produced, fg_value: fgValue, yield_variance: variance };
  }

  async list(user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(workOrders).orderBy(desc(workOrders.id)).limit(100);
    return { work_orders: rows.map((r: any) => this.fmt(r)), count: rows.length };
  }

  async get(woNo: string) {
    const db = this.db as any;
    const wo = await this.row(woNo);
    const comps = await db.select().from(workOrderComponents).where(eq(workOrderComponents.woId, Number(wo.id)));
    return {
      ...this.fmt(wo),
      components: comps.map((c: any) => ({ item_id: c.itemId, item_description: c.itemDescription, uom: c.uom, qty_required: n(c.qtyRequired), unit_cost: n(c.unitCost), line_cost: n(c.lineCost) })),
    };
  }

  private async row(woNo: string) {
    const [wo] = await (this.db as any).select().from(workOrders).where(eq(workOrders.woNo, woNo)).limit(1);
    if (!wo) throw new NotFoundException({ code: 'WO_NOT_FOUND', message: `Work order ${woNo} not found`, messageTh: 'ไม่พบใบสั่งผลิต' });
    return wo;
  }

  private fmt(r: any) {
    return {
      wo_no: r.woNo, bom_code: r.bomCode, product_item_id: r.productItemId, product_name: r.productName, uom: r.uom,
      qty_planned: n(r.qtyPlanned), qty_produced: n(r.qtyProduced), status: r.status,
      material_cost: n(r.materialCost), labor_cost: n(r.laborCost), overhead_cost: n(r.overheadCost),
      total_cost: n(r.totalCost), unit_cost: n(r.unitCost), entry_no_issue: r.entryNoIssue, entry_no_complete: r.entryNoComplete,
      // Yield variance (5810): the cost of the lost (or gained) yield on a completed WO — total batch cost
      // minus the standard cost of what was actually produced. Positive = loss, negative = over-yield gain.
      yield_variance: r.status === 'Completed' && n(r.qtyPlanned) > 0 ? r2(n(r.totalCost) - (n(r.totalCost) / n(r.qtyPlanned)) * n(r.qtyProduced)) : null,
      started_at: r.startedAt, completed_at: r.completedAt, created_at: r.createdAt,
    };
  }
}
