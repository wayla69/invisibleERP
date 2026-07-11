import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { items, invBalances, stockMovements, stocktakes, itemAbcClass, cycleCountPlans, cycleCountTasks } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { n, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// INV-3 / INV-17 — Cycle-count program with ABC classification + blind counts.
//
// This turns ad-hoc stocktakes (INV-04) into a governed PROGRAM. It SCHEDULES and BLINDS the count, then
// feeds the EXISTING stocktake post path (StockOpsService.postStocktake) — it never duplicates the variance
// maker-checker (SoD R11: counter ≠ poster) or the valued GL adjustment (inventory-ledger.postCountVariance).
//
// ABC: items are ranked per tenant by annual consumption VALUE (Σ issued qty × unit cost) and Pareto-banded
// A (top ~80% of cumulative value) / B (next ~15%) / C (last ~5%); the class drives the count cadence.
const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;
const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const A_PCT = 0.8, B_PCT = 0.95;                         // Pareto band edges (80 / 95)
export const DEFAULT_CADENCE: Record<string, number> = { A: 30, B: 90, C: 180 }; // days between counts
const CLASSES = ['A', 'B', 'C'] as const;

@Injectable()
export class CycleCountService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
  ) {}

  private tid(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'User is not bound to a tenant', messageTh: 'ผู้ใช้ไม่ได้ผูกกับร้าน/บริษัท' });
    return Number(user.tenantId);
  }

  private addDays(ymdDash: string | null, days: number): string | null {
    if (!ymdDash) return null;
    const d = new Date(`${ymdDash}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  // ── ABC classification ─────────────────────────────────────────────────────
  // Recompute the tenant's ABC classification from consumption value. Idempotent (replaces the snapshot).
  async recomputeAbc(user: JwtUser) {
    const db = this.db;
    const tenantId = this.tid(user);

    // Consumption qty per item — goods-issue movements (velocity signal), summed absolute.
    const moves = await db.select().from(stockMovements).where(and(eq(stockMovements.tenantId, tenantId), eq(stockMovements.moveType, 'Issue')));
    const consumed = new Map<string, number>();
    for (const m of moves) {
      if (!m.itemId) continue;
      consumed.set(m.itemId, (consumed.get(m.itemId) ?? 0) + Math.abs(n(m.qty)));
    }

    // Valued on-hand → unit cost basis (moving-average). Falls back to the item master unit price.
    const bals = await db.select().from(invBalances).where(eq(invBalances.tenantId, tenantId));
    const onHand = new Map<string, number>(), value = new Map<string, number>();
    for (const b of bals) {
      onHand.set(b.itemId, (onHand.get(b.itemId) ?? 0) + n(b.onHandQty));
      value.set(b.itemId, (value.get(b.itemId) ?? 0) + n(b.totalValue));
    }
    const itemRows = await db.select().from(items);
    const meta = new Map(itemRows.map((r) => [r.itemId, r]));

    // The tenant's inventory universe = items with a valued balance OR a consumption movement.
    const universe = new Set<string>([...consumed.keys(), ...onHand.keys()]);
    const rows = [...universe].map((itemId) => {
      const oh = onHand.get(itemId) ?? 0, tv = value.get(itemId) ?? 0;
      const unitCost = oh > 0 ? tv / oh : n(meta.get(itemId)?.unitPrice);
      const annualValue = round4((consumed.get(itemId) ?? 0) * unitCost);
      return { itemId, annualValue };
    });
    // Rank desc by value (ties broken by item_id for determinism).
    rows.sort((a, b) => (b.annualValue - a.annualValue) || (a.itemId < b.itemId ? -1 : 1));
    const total = rows.reduce((s, r) => s + r.annualValue, 0);

    const summary = { A: 0, B: 0, C: 0 };
    const now = new Date();
    // Classify by the cumulative % BEFORE this item (so the single dominant item is always A).
    let cumBefore = 0;
    const out: any[] = [];
    rows.forEach((r, i) => {
      const pctBefore = total > 0 ? cumBefore / total : 1;
      const cls = pctBefore < A_PCT ? 'A' : pctBefore < B_PCT ? 'B' : 'C';
      summary[cls as 'A' | 'B' | 'C']++;
      cumBefore += r.annualValue;
      const cumPct = total > 0 ? round4((cumBefore / total) * 100) : 0;
      out.push({ tenantId, itemId: r.itemId, class: cls, annualValue: String(r.annualValue), rank: i + 1, cumPct: String(cumPct), computedAt: now, computedBy: user.username });
    });

    await db.transaction(async (tx: any) => {
      await tx.delete(itemAbcClass).where(eq(itemAbcClass.tenantId, tenantId));
      if (out.length) await tx.insert(itemAbcClass).values(out);
    });
    await this.ensurePlans(tenantId);
    return { recomputed: rows.length, total_value: round2(total), tiers: summary, computed_at: ymd(now) };
  }

  // Seed the default cadence plans (A=30 / B=90 / C=180) for a tenant if none exist.
  private async ensurePlans(tenantId: number) {
    const existing = await this.db.select().from(cycleCountPlans).where(eq(cycleCountPlans.tenantId, tenantId));
    const have = new Set(existing.map((p) => p.class));
    const seed = CLASSES.filter((c) => !have.has(c)).map((c) => ({ tenantId, class: c, cadenceDays: DEFAULT_CADENCE[c]! }));
    if (seed.length) await this.db.insert(cycleCountPlans).values(seed);
  }

  private async plansMap(tenantId: number): Promise<Record<string, number>> {
    await this.ensurePlans(tenantId);
    const plans = await this.db.select().from(cycleCountPlans).where(eq(cycleCountPlans.tenantId, tenantId));
    const map: Record<string, number> = { ...DEFAULT_CADENCE };
    for (const p of plans) map[p.class] = p.cadenceDays;
    return map;
  }

  async listAbc(user: JwtUser) {
    const tenantId = this.tid(user);
    const rows = await this.db.select().from(itemAbcClass).where(eq(itemAbcClass.tenantId, tenantId));
    rows.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    const plans = await this.plansMap(tenantId);
    const metaRows = await this.db.select().from(items);
    const meta = new Map(metaRows.map((r) => [r.itemId, r]));
    const summary = { A: 0, B: 0, C: 0 } as Record<'A' | 'B' | 'C', number>;
    for (const r of rows) summary[r.class as 'A' | 'B' | 'C']++;
    return {
      classes: rows.map((r) => ({ item_id: r.itemId, item_description: meta.get(r.itemId)?.itemDescription ?? null, class: r.class, annual_value: n(r.annualValue), rank: r.rank, cum_pct: n(r.cumPct), computed_at: r.computedAt })),
      plans: CLASSES.map((c) => ({ class: c, cadence_days: plans[c] })),
      summary,
    };
  }

  // ── Cycle-count worklist (cadence-driven "due" list) ────────────────────────
  async dueWorklist(user: JwtUser) {
    const tenantId = this.tid(user);
    const abc = await this.db.select().from(itemAbcClass).where(eq(itemAbcClass.tenantId, tenantId));
    const plans = await this.plansMap(tenantId);
    const today = ymd();

    // Last POSTED count date per item (the count that actually adjusted the books).
    const posted = await this.db.select().from(stocktakes).where(and(eq(stocktakes.tenantId, tenantId), eq(stocktakes.status, 'Posted')));
    const lastCounted = new Map<string, string>();
    for (const s of posted) {
      if (!s.itemId || !s.stDate) continue;
      const cur = lastCounted.get(s.itemId);
      if (!cur || s.stDate > cur) lastCounted.set(s.itemId, s.stDate);
    }

    const metaRows = await this.db.select().from(items);
    const meta = new Map(metaRows.map((r) => [r.itemId, r]));

    const due: any[] = [];
    for (const a of abc) {
      const cadence = plans[a.class] ?? DEFAULT_CADENCE[a.class] ?? 180;
      const last = lastCounted.get(a.itemId) ?? null;
      const nextDue = this.addDays(last, cadence);           // null when never counted
      const isDue = !nextDue || nextDue <= today;
      if (!isDue) continue;
      const overdueDays = nextDue ? Math.max(0, Math.round((new Date(`${today}T00:00:00Z`).getTime() - new Date(`${nextDue}T00:00:00Z`).getTime()) / 86400000)) : null;
      due.push({
        item_id: a.itemId, item_description: meta.get(a.itemId)?.itemDescription ?? null, uom: meta.get(a.itemId)?.uom ?? null,
        class: a.class, cadence_days: cadence, annual_value: n(a.annualValue),
        last_counted: last, next_due: nextDue, never_counted: !last, overdue_days: overdueDays,
      });
    }
    // A first, then largest annual value / most overdue.
    due.sort((x, y) => (x.class < y.class ? -1 : x.class > y.class ? 1 : y.annual_value - x.annual_value));
    return { due, count: due.length, as_of: today };
  }

  // ── Blind count task generation ─────────────────────────────────────────────
  // Generates a BLIND count task: captures the system/book qty server-side into a Draft stocktake but NEVER
  // returns it to the counter. Count entry is submitCount(); posting is the EXISTING /api/stocktake/:no/post.
  async generateTask(dto: { item_ids?: string[]; location?: string; counted_by?: string }, user: JwtUser) {
    const db = this.db;
    const tenantId = this.tid(user);

    // Items to count: explicit list, else the whole due worklist.
    let itemIds = (dto.item_ids ?? []).filter(Boolean);
    if (!itemIds.length) itemIds = (await this.dueWorklist(user)).due.map((d: any) => d.item_id);
    if (!itemIds.length) throw new BadRequestException({ code: 'NO_ITEMS_DUE', message: 'No items are due for a cycle count', messageTh: 'ไม่มีสินค้าที่ถึงกำหนดตรวจนับ' });

    // Book on-hand per item (captured now; hidden from the counter). Tracked → inv_balances; else 0.
    const bals = await db.select().from(invBalances).where(eq(invBalances.tenantId, tenantId));
    const onHand = new Map<string, number>();
    for (const b of bals) onHand.set(b.itemId, (onHand.get(b.itemId) ?? 0) + n(b.onHandQty));
    const metaRows = await db.select().from(items);
    const meta = new Map(metaRows.map((r) => [r.itemId, r]));
    const abc = await db.select().from(itemAbcClass).where(eq(itemAbcClass.tenantId, tenantId));
    const classOf = new Map(abc.map((a) => [a.itemId, a.class]));

    const counter = dto.counted_by || user.username;
    const stNo = await this.docNo.nextDaily('ST');
    const taskNo = await this.docNo.nextDaily('CC');
    const stDate = ymd();
    const cadence = await this.plansMap(tenantId);
    // The task's cadence class = the highest-frequency (smallest cadence) class among its items.
    const taskClass: string | null = itemIds.map((i) => classOf.get(i)).filter((c): c is string => !!c).sort((a, b) => (cadence[a] ?? 999) - (cadence[b] ?? 999))[0] ?? null;
    const dueDate = ymd();

    const stRows = itemIds.map((itemId) => {
      const sys = round4(onHand.get(itemId) ?? 0);
      const m = meta.get(itemId);
      // physical_qty seeded = system so an UN-COUNTED line is a no-variance no-op if posted; the counter must
      // submit their independent count (submitCount) to create a real variance. system_qty is never revealed.
      return {
        tenantId, stNo, stDate, itemId, itemDescription: m?.itemDescription ?? null, uom: m?.uom ?? null,
        systemQty: String(sys), physicalQty: String(sys), difference: '0',
        countedBy: counter, status: 'Draft' as const, remarks: `Cycle count ${taskNo}`,
      };
    });

    await db.transaction(async (tx: any) => {
      await tx.insert(stocktakes).values(stRows);
      await tx.insert(cycleCountTasks).values({
        tenantId, taskNo, class: taskClass, location: dto.location ?? null, dueDate,
        status: 'Open', stNo, itemCount: itemIds.length, createdBy: user.username, countedBy: counter,
      });
    });

    // BLIND response: item list WITHOUT the system/book qty.
    return {
      task_no: taskNo, st_no: stNo, class: taskClass, location: dto.location ?? null, due_date: dueDate,
      status: 'Open', counted_by: counter,
      items: itemIds.map((itemId) => ({ item_id: itemId, item_description: meta.get(itemId)?.itemDescription ?? null, uom: meta.get(itemId)?.uom ?? null })),
    };
  }

  // Blind count entry — the counter submits physical counts; the system computes the (hidden) variance.
  async submitCount(taskNo: string, dto: { lines: { item_id: string; physical_qty: number }[] }, user: JwtUser) {
    const db = this.db;
    const tenantId = this.tid(user);
    if (!dto.lines?.length) throw new BadRequestException({ code: 'NO_LINES', message: 'No count lines', messageTh: 'ไม่มีรายการนับ' });
    const [task] = await db.select().from(cycleCountTasks).where(and(eq(cycleCountTasks.tenantId, tenantId), eq(cycleCountTasks.taskNo, taskNo))).limit(1);
    if (!task) throw new NotFoundException({ code: 'NOT_FOUND', message: `Cycle-count task ${taskNo} not found`, messageTh: 'ไม่พบใบงานตรวจนับ' });
    if (task.status === 'Cancelled') throw new BadRequestException({ code: 'TASK_CANCELLED', message: 'This task was cancelled', messageTh: 'ใบงานถูกยกเลิก' });
    const stNo = task.stNo!;

    let variance = 0;
    await db.transaction(async (tx: any) => {
      const stLines = await tx.select().from(stocktakes).where(and(eq(stocktakes.tenantId, tenantId), eq(stocktakes.stNo, stNo)));
      const byItem = new Map(stLines.map((l: any) => [l.itemId, l]));
      for (const line of dto.lines) {
        const st: any = byItem.get(line.item_id);
        if (!st) continue;                                  // item not part of this task → ignore
        const sys = n(st.systemQty);
        const phys = round4(line.physical_qty);
        const diff = round2(phys - sys);
        if (diff !== 0) variance++;
        await tx.update(stocktakes).set({ physicalQty: String(phys), difference: String(diff) })
          .where(and(eq(stocktakes.tenantId, tenantId), eq(stocktakes.stNo, stNo), eq(stocktakes.itemId, line.item_id)));
      }
      await tx.update(cycleCountTasks).set({ status: 'Counted', countedBy: task.countedBy ?? user.username, countedAt: new Date() })
        .where(and(eq(cycleCountTasks.tenantId, tenantId), eq(cycleCountTasks.taskNo, taskNo)));
    });
    // Posting is the EXISTING wh_adjust path: POST /api/stocktake/{st_no}/post (counter ≠ poster, INV-04).
    return { task_no: taskNo, st_no: stNo, status: 'Counted', counted_lines: dto.lines.length, variance_lines: variance, post_via: `/api/stocktake/${stNo}/post` };
  }

  async listTasks(user: JwtUser, limit = 100) {
    const tenantId = this.tid(user);
    const tasks = await this.db.select().from(cycleCountTasks).where(eq(cycleCountTasks.tenantId, tenantId));
    tasks.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
    // Derive Posted from the linked stocktake status (posting reuses the existing path, which is unaware of tasks).
    const stNos = tasks.map((t) => t.stNo).filter(Boolean) as string[];
    const posted = new Set<string>();
    if (stNos.length) {
      const stRows = await this.db.select().from(stocktakes).where(eq(stocktakes.tenantId, tenantId));
      for (const s of stRows) if (s.stNo && s.status === 'Posted') posted.add(s.stNo);
    }
    return {
      tasks: tasks.slice(0, limit).map((t) => ({
        task_no: t.taskNo, class: t.class, location: t.location, due_date: t.dueDate,
        status: t.stNo && posted.has(t.stNo) ? 'Posted' : t.status, st_no: t.stNo, item_count: t.itemCount,
        counted_by: t.countedBy, created_by: t.createdBy, created_at: t.createdAt,
      })),
      count: tasks.length,
    };
  }
}
