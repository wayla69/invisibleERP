import { BadRequestException, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { JwtUser } from '../../common/decorators';
import type { DrizzleDb } from '../../database/database.module';
import { allocationCycles, allocationTargets } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { currentTenantStore } from '../../common/tenant-context';
import { ymd, n } from '../../database/queries';
import { toMinor4, minorToNumber4 } from '../../common/money';
import type { AllocationCycleDto, PostEntryDto, JournalLineDto } from './ledger.service';

// GL allocation engine (GL-23, migration 0301). A periodic cost-allocation cycle distributes a source POOL
// (a fixed amount out of a source account / cost-center) to a set of targets by fixed RATIO, a measured
// DRIVER, or a STATISTICAL KEY (headcount / sqm). The three methods share one engine — a proportional split
// by each target's `basis` weight; the method only documents where that weight comes from (an explicit
// percentage vs. a measured driver vs. a statistical key figure). Each due run posts ONE balanced JE —
// Cr the source pool, Dr each target its proportional share (the last target absorbs the rounding remainder
// so Σdebits = pool exactly) — as a DRAFT through the normal maker-checker flow (GL-05), riding the same
// recurring rail as GL-08. Idempotent per period via the (tenant,source,source_ref,ledger) JE idempotency
// key (source_ref = ALC-<id>-<date>) + next_run_date advance, so a same-day re-run posts nothing new.
export class LedgerAllocationService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly postEntry: (dto: PostEntryDto) => Promise<{ entry_no: string | null }>,
  ) {}

  // Create a cycle + its targets. Validate the template UP FRONT (like createRecurring): a bad method /
  // frequency, a non-positive pool, no targets, or a zero total basis (nothing to divide by) is rejected so
  // a malformed cycle can never be saved and then post an unbalanced / zero JE every period.
  async createCycle(dto: AllocationCycleDto, user: JwtUser) {
    const db = this.db;
    if (!(ALLOCATION_METHODS as readonly string[]).includes(dto.method)) throw new BadRequestException({ code: 'BAD_METHOD', message: `method must be one of ${ALLOCATION_METHODS.join('/')}`, messageTh: 'วิธีปันส่วนไม่ถูกต้อง' });
    if (!(FREQUENCIES as readonly string[]).includes(dto.frequency)) throw new BadRequestException({ code: 'BAD_FREQUENCY', message: `frequency must be one of ${FREQUENCIES.join('/')}`, messageTh: 'รอบเวลาไม่ถูกต้อง' });
    const pool = round4(dto.poolAmount);
    if (!(pool > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'pool_amount must be > 0', messageTh: 'จำนวนเงินพูลต้องมากกว่าศูนย์' });
    if (!dto.sourceAccount) throw new BadRequestException({ code: 'BAD_SOURCE', message: 'source_account required', messageTh: 'ต้องระบุบัญชีต้นทาง' });
    const targets = dto.targets ?? [];
    if (!targets.length) throw new BadRequestException({ code: 'NO_TARGETS', message: 'at least one allocation target required', messageTh: 'ต้องมีปลายทางปันส่วนอย่างน้อยหนึ่งรายการ' });
    if (targets.some((tt) => n(tt.basis) < 0)) throw new BadRequestException({ code: 'BAD_BASIS', message: 'basis must be non-negative', messageTh: 'ค่าน้ำหนักต้องไม่ติดลบ' });
    const totalBasis = targets.reduce((a, tt) => a + n(tt.basis), 0);
    if (!(totalBasis > 0)) throw new BadRequestException({ code: 'NO_BASIS', message: 'total basis must be > 0 (nothing to allocate by)', messageTh: 'ผลรวมน้ำหนักต้องมากกว่าศูนย์' });

    const tenantId = dto.tenantId ?? currentTenantStore()?.tenantId ?? user.tenantId ?? null;
    const nextRun = dto.startDate ?? ymd();
    const cycleNo = await this.docNo.nextDaily('ALC');
    const [c] = await db.insert(allocationCycles).values({
      tenantId, cycleNo, name: dto.name, method: dto.method, frequency: dto.frequency,
      poolAmount: String(pool), sourceAccount: dto.sourceAccount, sourceCostCenter: dto.sourceCostCenter ?? null,
      ledgerCode: dto.ledgerCode ?? null, currency: dto.currency ?? 'THB', memo: dto.memo ?? null,
      active: 'true', nextRunDate: nextRun, createdBy: user.username,
    }).returning({ id: allocationCycles.id });
    const cycleId = Number(c!.id);
    await db.insert(allocationTargets).values(targets.map((tt, i) => ({
      tenantId, cycleId, targetAccount: tt.target_account ?? null, costCenter: tt.cost_center ?? null,
      basis: String(round4(n(tt.basis))), memo: tt.memo ?? null, sortOrder: i,
    })));
    return { id: cycleId, cycle_no: cycleNo, name: dto.name, method: dto.method, frequency: dto.frequency, pool_amount: pool, source_account: dto.sourceAccount, next_run_date: nextRun, targets: targets.length };
  }

  async listCycles(tenantId?: number) {
    const db = this.db;
    const where = tenantId != null ? eq(allocationCycles.tenantId, tenantId) : undefined;
    const cycles = await db.select().from(allocationCycles).where(where).orderBy(desc(allocationCycles.id));
    const out: AllocationCycleView[] = [];
    for (const c of cycles) {
      const tg = await db.select().from(allocationTargets).where(eq(allocationTargets.cycleId, c.id)).orderBy(asc(allocationTargets.sortOrder));
      out.push({
        id: Number(c.id), cycle_no: c.cycleNo, name: c.name, method: c.method, frequency: c.frequency,
        pool_amount: n(c.poolAmount), source_account: c.sourceAccount, source_cost_center: c.sourceCostCenter,
        ledger_code: c.ledgerCode, currency: c.currency, memo: c.memo, active: c.active === 'true',
        next_run_date: c.nextRunDate, last_run_date: c.lastRunDate, last_entry_no: c.lastEntryNo, created_by: c.createdBy,
        targets: tg.map((t) => ({ target_account: t.targetAccount ?? c.sourceAccount, cost_center: t.costCenter, basis: n(t.basis), memo: t.memo })),
      });
    }
    return { cycles: out, count: out.length };
  }

  async setCycleActive(id: number, active: boolean) {
    const db = this.db;
    const [c] = await db.select({ id: allocationCycles.id }).from(allocationCycles).where(eq(allocationCycles.id, id)).limit(1);
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: `Allocation cycle ${id} not found`, messageTh: 'ไม่พบรอบปันส่วน' });
    await db.update(allocationCycles).set({ active: active ? 'true' : 'false' }).where(eq(allocationCycles.id, id));
    return { id, active };
  }

  // Idempotent scheduled run: for every active cycle whose next_run_date has arrived, split the pool by the
  // targets' basis weights (exact minor-unit math, remainder to the last target) and post ONE balanced
  // DRAFT JE (Cr source / Dr targets), then roll next_run_date forward. source_ref = ALC-<id>-<date> so
  // ux_je_idem dedupes a same-day re-run at the DB layer.
  async runDueAllocations(user: JwtUser) {
    const db = this.db;
    const today = ymd();
    const due = await db.select().from(allocationCycles)
      .where(and(eq(allocationCycles.active, 'true'), sql`${allocationCycles.nextRunDate} <= ${today}`));
    const posted: { entry_no: string | null; cycle_id: number; cycle_no: string; pool: number }[] = [];
    for (const c of due) {
      const targets = await db.select().from(allocationTargets).where(eq(allocationTargets.cycleId, c.id)).orderBy(asc(allocationTargets.sortOrder));
      const shares = splitPool(n(c.poolAmount), targets.map((t) => n(t.basis)));
      // Skip a degenerate cycle (no targets / zero basis) rather than post a broken JE — create guards this,
      // but a later edit could leave one; a defensive skip keeps the sweep from throwing.
      if (!shares) continue;
      const pool = round4(n(c.poolAmount));
      const lines: JournalLineDto[] = [];
      targets.forEach((t, i) => {
        const amt = shares[i]!;
        if (amt <= 0) return;
        lines.push({ account_code: t.targetAccount ?? c.sourceAccount, debit: amt, cost_center: t.costCenter ?? null, memo: t.memo ?? `Alloc ${c.cycleNo}` });
      });
      lines.push({ account_code: c.sourceAccount, credit: pool, cost_center: c.sourceCostCenter ?? null, memo: `Alloc pool ${c.cycleNo}` });
      const res = await this.postEntry({
        date: today, source: 'Allocation', sourceRef: `ALC-${Number(c.id)}-${today}`,
        tenantId: c.tenantId ?? null, currency: c.currency ?? 'THB', memo: c.memo ?? c.name,
        lines, createdBy: `${user?.username ?? 'system'} (allocation)`,
        ledgerCode: c.ledgerCode ?? null, pendingApproval: true,
      });
      await db.update(allocationCycles).set({
        lastRunDate: today, lastEntryNo: res.entry_no ?? c.lastEntryNo,
        nextRunDate: addByFrequency(today, c.frequency),
      }).where(eq(allocationCycles.id, c.id));
      if (res.entry_no) posted.push({ entry_no: res.entry_no, cycle_id: Number(c.id), cycle_no: c.cycleNo, pool });
    }
    return { as_of: today, scanned: due.length, posted: posted.length, entries: posted };
  }
}

interface AllocationTargetView { target_account: string; cost_center: string | null; basis: number; memo: string | null }
interface AllocationCycleView {
  id: number; cycle_no: string; name: string; method: string; frequency: string; pool_amount: number;
  source_account: string; source_cost_center: string | null; ledger_code: string | null; currency: string | null;
  memo: string | null; active: boolean; next_run_date: string | null; last_run_date: string | null;
  last_entry_no: string | null; created_by: string | null; targets: AllocationTargetView[];
}

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

// Split a pool proportionally by weights in exact minor-4 units; the last positive-weight target absorbs the
// rounding remainder so Σshares = pool exactly (a balanced JE). Returns null for a degenerate split.
function splitPool(pool: number, weights: number[]): number[] | null {
  const poolM = toMinor4(pool);
  const wM = weights.map((w) => (w > 0 ? toMinor4(w) : 0n));
  const totalWM = wM.reduce((a, b) => a + b, 0n);
  if (totalWM <= 0n || poolM <= 0n) return null;
  // Index of the last target with a positive weight — it takes the remainder.
  let lastPos = -1;
  for (let i = 0; i < wM.length; i++) if (wM[i]! > 0n) lastPos = i;
  let allocated = 0n;
  const out: number[] = [];
  for (let i = 0; i < wM.length; i++) {
    if (wM[i]! <= 0n) { out.push(0); continue; }
    let sM: bigint;
    if (i === lastPos) { sM = poolM - allocated; } else { sM = (poolM * wM[i]!) / totalWM; allocated += sM; }
    out.push(minorToNumber4(sM));
  }
  return out;
}

// Cadence — shared shape with the recurring rail (daily/weekly/monthly).
const ALLOCATION_METHODS = ['ratio', 'driver', 'statistical'] as const;
const FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
function addByFrequency(dateStr: string, frequency: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (frequency === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (frequency === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCDate(d.getUTCDate() + 1); // daily (default)
  return d.toISOString().slice(0, 10);
}
