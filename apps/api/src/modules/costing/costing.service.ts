import { Inject, Injectable } from '@nestjs/common';
import { eq, and, asc, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { itemCosting, costLayers, costMovements } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

type Method = 'FIFO' | 'AVG' | 'STD';
const r4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;
const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// Inventory costing (FIFO/AVG/STD). OPT-IN per (tenant,item): a method is active only when item_costing
// has a per-item row OR a tenant-default (item_id NULL). Configured items capitalize on receipt and post
// method-correct COGS on issue; everything else is untouched (legacy behaviour). Reuses LedgerService.
@Injectable()
export class CostingService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly ledger: LedgerService) {}

  // resolve effective config: per-item row → tenant default (item_id NULL) → null (costing inactive)
  async config(db: any, tenantId: number, itemId: string): Promise<{ method: Method; standardCost: number; rowId: number; itemRow: boolean } | null> {
    const [own] = await db.select().from(itemCosting).where(and(eq(itemCosting.tenantId, tenantId), eq(itemCosting.itemId, itemId))).limit(1);
    if (own) return { method: own.method as Method, standardCost: n(own.standardCost), rowId: Number(own.id), itemRow: true };
    const [def] = await db.select().from(itemCosting).where(and(eq(itemCosting.tenantId, tenantId), isNull(itemCosting.itemId))).limit(1);
    if (def) return { method: def.method as Method, standardCost: n(def.standardCost), rowId: Number(def.id), itemRow: false };
    return null;
  }

  async setMethod(tenantId: number, itemId: string | null, method: Method, standardCost: number | null, _user: JwtUser) {
    const db = this.db as any;
    await db.insert(itemCosting).values({ tenantId, itemId, method, standardCost: standardCost != null ? fx(standardCost, 4) : null })
      .onConflictDoUpdate({ target: [itemCosting.tenantId, itemCosting.itemId], set: { method, standardCost: standardCost != null ? fx(standardCost, 4) : null, updatedAt: new Date() } });
    return { tenant_id: tenantId, item_id: itemId, method, standard_cost: standardCost };
  }
  async listConfig(_user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(itemCosting).orderBy(asc(itemCosting.itemId));
    return { config: rows.map((r: any) => ({ item_id: r.itemId, method: r.method, standard_cost: n(r.standardCost), avg_cost: n(r.avgCost), on_hand: n(r.onHand) })) };
  }

  // ── RECEIPT — runs inside the GR tx (build cost basis). Returns the capitalization inputs for postReceiptGl. ──
  async onReceipt(db: any, p: { tenantId: number; itemId: string; qty: number; unitCost: number; grNo: string; date: string }): Promise<{ active: boolean; method?: Method; actualCost?: number; standardCost?: number }> {
    const cfg = await this.config(db, p.tenantId, p.itemId);
    if (!cfg || p.tenantId == null) return { active: false };
    const qty = r4(p.qty), cost = r4(p.unitCost);
    if (cfg.method === 'FIFO') {
      await db.insert(costLayers).values({ tenantId: p.tenantId, itemId: p.itemId, grNo: p.grNo, receiptDate: p.date, origQty: fx(qty, 4), remainingQty: fx(qty, 4), unitCost: fx(cost, 4) });
    } else if (cfg.method === 'AVG') {
      const [ic] = await db.select().from(itemCosting).where(and(eq(itemCosting.tenantId, p.tenantId), eq(itemCosting.itemId, p.itemId))).for('update').limit(1);
      const oh = n(ic?.onHand), oa = n(ic?.avgCost);
      const newOh = r4(oh + qty);
      const newAvg = newOh !== 0 ? r4((oh * oa + qty * cost) / newOh) : cost;
      if (ic) await db.update(itemCosting).set({ onHand: fx(newOh, 4), avgCost: fx(newAvg, 4), updatedAt: new Date() }).where(eq(itemCosting.id, ic.id));
      else await db.insert(itemCosting).values({ tenantId: p.tenantId, itemId: p.itemId, method: 'AVG', onHand: fx(newOh, 4), avgCost: fx(newAvg, 4) });
    } else { // STD — value at standard; track on_hand for valuation
      const [ic] = await db.select().from(itemCosting).where(and(eq(itemCosting.tenantId, p.tenantId), eq(itemCosting.itemId, p.itemId))).for('update').limit(1);
      if (ic) await db.update(itemCosting).set({ onHand: fx(r4(n(ic.onHand) + qty), 4), updatedAt: new Date() }).where(eq(itemCosting.id, ic.id));
    }
    await db.insert(costMovements).values({ tenantId: p.tenantId, itemId: p.itemId, moveDate: p.date, kind: 'RECEIPT', refDoc: p.grNo, qty: fx(qty, 4), unitCost: fx(cost, 4), extCost: fx(qty * cost, 4), method: cfg.method });
    return { active: true, method: cfg.method, actualCost: cost, standardCost: cfg.standardCost };
  }

  // post GR capitalization (once per GR, after the tx). FIFO/AVG: Dr 1200 / Cr 2000 at actual. STD: Dr 1200
  // at standard + PPV 5500 / Cr 2000 at actual. Idempotent on GRV/grNo.
  async postReceiptGl(p: { tenantId: number; grNo: string; date: string; lines: { itemId: string; qty: number; actualCost: number; method: Method; standardCost: number }[]; createdBy: string }) {
    if (!p.lines.length) return;
    if (await this.ledger.alreadyPosted('GRV', p.grNo)) return;
    let invDr = 0, apCr = 0, ppvDr = 0, ppvCr = 0;
    for (const l of p.lines) {
      const ext = l.qty * l.actualCost;
      apCr += ext;
      if (l.method === 'STD') {
        const std = l.qty * (l.standardCost || 0);
        invDr += std;
        const v = ext - std; // unfavorable (actual>std) → PPV debit; favorable → PPV credit
        if (v > 0) ppvDr += v; else ppvCr += -v;
      } else invDr += ext;
    }
    const lines = [
      { account_code: '1200', debit: r2(invDr) },
      ...(ppvDr > 0 ? [{ account_code: '5500', debit: r2(ppvDr) }] : []),
      ...(ppvCr > 0 ? [{ account_code: '5500', credit: r2(ppvCr) }] : []),
      { account_code: '2000', credit: r2(apCr) },
    ];
    await this.ledger.postEntry({ date: p.date, source: 'GRV', sourceRef: p.grNo, tenantId: p.tenantId, memo: `Inventory receipt ${p.grNo}`, createdBy: p.createdBy, lines });
  }

  // ── ISSUE/SALE — method-correct COGS for configured items. Dr 5000 / Cr 1200. Idempotent POS-COGS-V/saleNo. ──
  async onIssue(p: { tenantId: number; saleNo: string; date: string; lines: { itemId: string; qty: number }[]; createdBy: string }): Promise<{ cogs: number }> {
    const db = this.db as any;
    if (p.tenantId == null) return { cogs: 0 };
    let cogs = 0;
    for (const l of p.lines) {
      const cfg = await this.config(db, p.tenantId, l.itemId);
      if (!cfg) continue;
      const qty = r4(l.qty);
      let lineCost = 0;
      if (cfg.method === 'FIFO') {
        let need = qty;
        const layers = await db.select().from(costLayers).where(and(eq(costLayers.tenantId, p.tenantId), eq(costLayers.itemId, l.itemId), sql`${costLayers.remainingQty} > 0`)).orderBy(asc(costLayers.receiptDate), asc(costLayers.id)).for('update');
        let lastCost = 0;
        for (const lay of layers) {
          if (need <= 1e-9) break;
          const take = Math.min(need, n(lay.remainingQty)); lastCost = n(lay.unitCost);
          lineCost += take * n(lay.unitCost); need = r4(need - take);
          await db.update(costLayers).set({ remainingQty: fx(r4(n(lay.remainingQty) - take), 4) }).where(eq(costLayers.id, lay.id));
        }
        if (need > 1e-9) lineCost += need * lastCost; // oversold → cost the overshoot at the last layer's cost
      } else if (cfg.method === 'AVG') {
        const [ic] = await db.select().from(itemCosting).where(and(eq(itemCosting.tenantId, p.tenantId), eq(itemCosting.itemId, l.itemId))).for('update').limit(1);
        lineCost = qty * n(ic?.avgCost);
        if (ic) await db.update(itemCosting).set({ onHand: fx(r4(n(ic.onHand) - qty), 4), updatedAt: new Date() }).where(eq(itemCosting.id, ic.id));
      } else { // STD
        lineCost = qty * (cfg.standardCost || 0);
        const [ic] = await db.select().from(itemCosting).where(and(eq(itemCosting.tenantId, p.tenantId), eq(itemCosting.itemId, l.itemId))).for('update').limit(1);
        if (ic) await db.update(itemCosting).set({ onHand: fx(r4(n(ic.onHand) - qty), 4), updatedAt: new Date() }).where(eq(itemCosting.id, ic.id));
      }
      lineCost = r2(lineCost);
      await db.insert(costMovements).values({ tenantId: p.tenantId, itemId: l.itemId, moveDate: p.date, kind: 'ISSUE', refDoc: p.saleNo, qty: fx(-qty, 4), unitCost: fx(qty > 0 ? lineCost / qty : 0, 4), extCost: fx(-lineCost, 4), method: cfg.method });
      cogs = r2(cogs + lineCost);
    }
    if (cogs > 0 && !(await this.ledger.alreadyPosted('POS-COGS-V', p.saleNo))) {
      await this.ledger.postEntry({ date: p.date, source: 'POS-COGS-V', sourceRef: p.saleNo, tenantId: p.tenantId, memo: `Costed COGS ${p.saleNo}`, createdBy: p.createdBy, lines: [{ account_code: '5000', debit: cogs }, { account_code: '1200', credit: cogs }] });
    }
    return { cogs };
  }

  // ── valuation — qty × cost per item, ties to GL 1200 for the tenant ──
  async valuation(tenantId: number) {
    const db = this.db as any;
    const configs = await db.select().from(itemCosting).where(eq(itemCosting.tenantId, tenantId));
    const items: any[] = [];
    let total = 0;
    for (const c of configs) {
      if (!c.itemId) continue;
      let qty = 0, unitCost = 0;
      if (c.method === 'FIFO') {
        const layers = await db.select().from(costLayers).where(and(eq(costLayers.tenantId, tenantId), eq(costLayers.itemId, c.itemId)));
        const val = layers.reduce((a: number, l: any) => a + n(l.remainingQty) * n(l.unitCost), 0);
        qty = layers.reduce((a: number, l: any) => a + n(l.remainingQty), 0);
        unitCost = qty > 0 ? r4(val / qty) : 0;
      } else { qty = n(c.onHand); unitCost = c.method === 'STD' ? n(c.standardCost) : n(c.avgCost); }
      const value = r2(qty * unitCost);
      total = r2(total + value);
      items.push({ item_id: c.itemId, method: c.method, qty: r4(qty), unit_cost: r4(unitCost), value });
    }
    const [g] = await db.select({ v: sql<string>`coalesce(sum(${sql.raw('jl.debit')} - ${sql.raw('jl.credit')}),0)` })
      .from(sql`journal_lines jl`).innerJoin(sql`journal_entries je`, sql`jl.entry_id = je.id`)
      .where(sql`jl.account_code = '1200' AND je.tenant_id = ${tenantId}`);
    const gl1200 = r2(n(g?.v));
    return { items, total_value: total, gl_1200: gl1200, ties: Math.abs(total - gl1200) < 0.01 };
  }
}
