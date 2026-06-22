import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { rmas, rmaLines, bins } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { WmsService } from './wms.service';
import { ReturnsService } from '../returns/returns.service';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// Customer Return Authorization. WMS does the physical restock (to a normal or quarantine bin); the money
// (refund/store-credit + GL reversal + COGS reversal) is delegated to ReturnsService — RMA adds no new GL.
@Injectable()
export class RmaService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly wms: WmsService,
    private readonly returns: ReturnsService,
  ) {}

  // open + authorize an RMA against an original sale
  async create(dto: { sale_no: string; reason?: string; customer_ref?: string; lines: { sale_item_id?: number; item_id: string; qty: number; lot_no?: string; uom?: string }[] }, user: JwtUser) {
    const db = this.db as any;
    if (!dto.lines?.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No lines', messageTh: 'ไม่มีรายการ' });
    const rmaNo = await this.docNo.nextDaily('RMA');
    const [r] = await db.insert(rmas).values({ tenantId: user.tenantId ?? null, rmaNo, saleNo: dto.sale_no, customerRef: dto.customer_ref ?? null, reason: dto.reason ?? null, status: 'Authorized', createdBy: user.username }).returning({ id: rmas.id });
    for (const l of dto.lines)
      await db.insert(rmaLines).values({ tenantId: user.tenantId ?? null, rmaId: Number(r.id), saleItemId: l.sale_item_id ?? null, itemId: l.item_id, qty: String(n(l.qty)), lotNo: l.lot_no ?? null, uom: l.uom ?? null, disposition: 'restock' });
    return { rma_no: rmaNo, status: 'Authorized', lines: dto.lines.length };
  }

  // mark received + inspected; set per-line disposition + (for restock/quarantine) the target bin
  async receive(rmaNo: string, dto: { lines: { rma_line_id: number; disposition: 'restock' | 'quarantine' | 'scrap'; restock_bin_code?: string }[] }, user: JwtUser) {
    const db = this.db as any;
    const [r] = await db.select().from(rmas).where(eq(rmas.rmaNo, rmaNo)).limit(1);
    if (!r) throw new NotFoundException({ code: 'RMA_NOT_FOUND', message: 'RMA not found', messageTh: 'ไม่พบ RMA' });
    if (r.status === 'Credited') throw new BadRequestException({ code: 'RMA_CLOSED', message: 'RMA already credited', messageTh: 'RMA ปิดแล้ว' });
    for (const dl of dto.lines) {
      let binId: number | null = null;
      if (dl.restock_bin_code) {
        const [b] = await db.select().from(bins).where(and(eq(bins.tenantId, user.tenantId as number), eq(bins.binCode, dl.restock_bin_code))).limit(1);
        if (!b) throw new NotFoundException({ code: 'BIN_NOT_FOUND', message: `Bin ${dl.restock_bin_code} not found`, messageTh: 'ไม่พบช่องเก็บ' });
        binId = Number(b.id);
      }
      await db.update(rmaLines).set({ disposition: dl.disposition, restockBinId: binId }).where(and(eq(rmaLines.id, dl.rma_line_id), eq(rmaLines.rmaId, Number(r.id))));
    }
    await db.update(rmas).set({ status: 'Inspected' }).where(eq(rmas.id, r.id));
    return { rma_no: rmaNo, status: 'Inspected' };
  }

  // physical restock (skip scrap) THEN financial credit via ReturnsService (idempotent: status freeze)
  async restock(rmaNo: string, dto: { refund_method: 'Cash' | 'Card' | 'StoreCredit' }, user: JwtUser) {
    const db = this.db as any;
    const [r] = await db.select().from(rmas).where(eq(rmas.rmaNo, rmaNo)).for('update').limit(1);
    if (!r) throw new NotFoundException({ code: 'RMA_NOT_FOUND', message: 'RMA not found', messageTh: 'ไม่พบ RMA' });
    if (r.status === 'Credited') return { rma_no: rmaNo, return_no: r.returnNo, restocked_bins: [], status: 'Credited', duplicate: true };
    const lines = await db.select().from(rmaLines).where(eq(rmaLines.rmaId, Number(r.id)));
    const restockedBins: any[] = [];
    for (const l of lines) {
      if (l.disposition === 'scrap' || !l.restockBinId) continue; // scrap → no bin move
      const [b] = await db.select().from(bins).where(eq(bins.id, Number(l.restockBinId))).limit(1);
      if (!b) continue;
      await this.wms.putaway({ bin_code: b.binCode, item_id: l.itemId, lot_no: l.lotNo ?? undefined, qty: n(l.qty), uom: l.uom ?? undefined }, user);
      restockedBins.push({ item_id: l.itemId, bin_code: b.binCode, qty: n(l.qty), disposition: l.disposition });
    }
    // money: refund + GL reversal + COGS reversal, all idempotent inside ReturnsService
    const ret = await this.returns.createReturn({ sale_no: r.saleNo, refund_method: dto.refund_method, reason: r.reason ?? 'RMA', items: lines.map((l: any) => ({ sale_item_id: l.saleItemId ?? undefined, item_id: l.itemId, qty: n(l.qty) })) } as any, user);
    await db.update(rmas).set({ status: 'Credited', returnNo: ret.return_no }).where(eq(rmas.id, r.id));
    return { rma_no: rmaNo, return_no: ret.return_no, restocked_bins: restockedBins, status: 'Credited' };
  }
}
