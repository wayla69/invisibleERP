import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, gte, isNull, ne, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import {
  custPosItems, custPosSales, dineInOrderItems, dineInOrders, scmDemandBaselines, scmSpikeEvents,
} from '../../database/schema';
import { n, ymd } from '../../database/queries';
import { addDaysYmd } from '../demand-ml/forecast-algorithms';
import type { JwtUser } from '../../common/decorators';
import { JobQueueService } from '../jobs/job-queue.service';
import { ScmLiveService } from './scm-live.service';
import { ScmPlanningService } from './scm-planning.service';
import { SCM_REPLAN_JOB, type ScmSettingsView } from './scm-planning.types';

// docs/54 §3.6 / §5 — demand-spike detection as a WATERMARKED MICRO-BATCH.
//
// Deliberately NOT an inline hook in createSale/buildSale: those are golden-master-pinned money
// paths that run on multiple replicas, so an inline detector would add latency, a new failure mode
// and duplicate fires. A batch bounded by the scan cadence is well inside any ordering cadence.
//
// State per (branch,item): West's numerically stable EWMA + a two-sided CUSUM, advanced only over
// business days after `last_day`. That watermark is what makes a scan at ANY cadence idempotent.

const tzOffsetMin = (): number => {
  const raw = Number(process.env.BUSINESS_TZ_OFFSET_MIN ?? 420);
  return Number.isFinite(raw) ? Math.trunc(raw) : 420;
};

// Inlined as a literal, NOT interpolated — see the note in scm-extract.service.ts: an interpolated
// value becomes a parameter, and the same fragment in SELECT and GROUP BY gets different
// placeholders, which Postgres rejects with 42803.
const bizDayExpr = () => sql<string>`to_char((coalesce(${dineInOrderItems.servedAt}, ${dineInOrderItems.firedAt}, ${dineInOrderItems.createdAt}) + make_interval(mins => ${sql.raw(String(tzOffsetMin()))})), 'YYYY-MM-DD')`;

@Injectable()
export class ScmSpikeService {
  private readonly log = new Logger(ScmSpikeService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly planning: ScmPlanningService,
    private readonly jobs: JobQueueService,
    private readonly live: ScmLiveService,
  ) {}

  /** Daily (branch,item) demand since `from`, using the same channel partition as extraction. */
  private async dailyDemand(tenantId: number | null, from: string, dineInBranchId: number | null) {
    const retail: { branch: number | null; item: string | null; d: string; q: string }[] =
      await this.db.select({
        branch: custPosSales.branchId,
        item: custPosItems.itemId,
        d: sql<string>`${custPosSales.saleDate}`,
        q: sql<string>`coalesce(sum(${custPosItems.qty}), 0)`,
      })
        .from(custPosItems)
        .innerJoin(custPosSales, eq(custPosItems.saleId, custPosSales.id))
        .where(and(
          tenantId != null ? eq(custPosSales.tenantId, tenantId) : sql`true`,
          ne(custPosSales.status, 'Voided'),
          gte(custPosSales.saleDate, from),
          sql`coalesce(${custPosSales.paymentMethod}, 'Cash') not in ('Dine-in', 'Split')`,
        ))
        .groupBy(custPosSales.branchId, custPosItems.itemId, custPosSales.saleDate);

    const day = bizDayExpr();
    const dineIn: { item: string | null; d: string; q: string }[] = await this.db.select({
      item: dineInOrderItems.itemId,
      d: day,
      q: sql<string>`coalesce(sum(${dineInOrderItems.qty}), 0)`,
    })
      .from(dineInOrderItems)
      .innerJoin(dineInOrders, eq(dineInOrderItems.orderId, dineInOrders.id))
      .where(and(
        tenantId != null ? eq(dineInOrderItems.tenantId, tenantId) : sql`true`,
        isNull(dineInOrderItems.voidedAt),
        ne(dineInOrderItems.kdsStatus, 'voided'),
        sql`${day} >= ${from}`,
      ))
      .groupBy(dineInOrderItems.itemId, day);

    return [
      ...retail,
      ...dineIn.map((r) => ({ branch: dineInBranchId, item: r.item, d: r.d, q: r.q })),
    ];
  }

  /**
   * Fold new business days into each series' EWMA/CUSUM state and raise events on a breach.
   * Returns counts; safe to call at any cadence (the watermark makes re-runs no-ops).
   */
  async scanTenant(tenantId: number | null, actor: string): Promise<{ scanned: number; spikes: number; replans: number }> {
    const settings: ScmSettingsView = await this.planning.extract.settings(tenantId);
    const today = ymd();
    const from = addDaysYmd(today, -60);
    const rows = await this.dailyDemand(tenantId, from, settings.dine_in_branch_id);
    if (!rows.length) return { scanned: 0, spikes: 0, replans: 0 };

    const existing = await this.db.select().from(scmDemandBaselines).where(
      tenantId != null ? eq(scmDemandBaselines.tenantId, tenantId) : sql`true`,
    );
    const stateByKey = new Map(existing.map((b) => [`${b.branchId ?? ''}|${b.itemId}`, b]));

    // Group observations per series, ascending — the EWMA recursion is order-dependent.
    const byKey = new Map<string, { branchId: number | null; itemId: string; days: Map<string, number> }>();
    for (const r of rows) {
      if (!r.item) continue;
      const qty = Number(r.q);
      if (!Number.isFinite(qty)) continue;
      const key = `${r.branch ?? ''}|${r.item}`;
      const entry = byKey.get(key) ?? { branchId: r.branch ?? null, itemId: r.item, days: new Map() };
      entry.days.set(r.d, (entry.days.get(r.d) ?? 0) + qty);
      byKey.set(key, entry);
    }

    const alpha = settings.spike_ewma_alpha;
    const spikes: { branchId: number | null; itemId: string; day: string; actual: number; expected: number; z: number; cusum: number; direction: 'up' | 'down' }[] = [];
    let scanned = 0;

    for (const [key, entry] of byKey) {
      const prior = stateByKey.get(key);
      let mean = prior ? n(prior.ewmaMean) : 0;
      let variance = prior ? n(prior.ewmaVar) : 0;
      let cusumPos = prior ? n(prior.cusumPos) : 0;
      let cusumNeg = prior ? n(prior.cusumNeg) : 0;
      let obs = prior ? Number(prior.obsDays) : 0;
      const watermark = prior?.lastDay ?? null;
      const lastSpikeAt = prior?.lastSpikeAt ? new Date(prior.lastSpikeAt).getTime() : 0;

      const newDays = [...entry.days.keys()].filter((d) => (!watermark || d > watermark) && d <= today).sort();
      if (!newDays.length) continue;
      scanned++;

      for (const day of newDays) {
        const x = entry.days.get(day) ?? 0;

        // JUDGE FIRST, against the baseline as it stood BEFORE this observation. Scoring against
        // the post-update mean lets a big spike inflate its own reference and hide itself — a 6×
        // day scored z≈2 instead of z≈28 that way, which is the classic EWMA control-chart error.
        const sd = Math.sqrt(Math.max(variance, 0));
        const settled = obs > 10 && sd > 1e-6;
        if (settled) {
          const z = (x - mean) / sd;
          cusumPos = Math.max(0, cusumPos + z - settings.spike_cusum_k);
          cusumNeg = Math.max(0, cusumNeg - z - settings.spike_cusum_k);
          const cooledDown = Date.now() - lastSpikeAt > settings.spike_cooldown_hours * 3_600_000;
          const up = z >= settings.spike_z_threshold || cusumPos > settings.spike_cusum_h;
          const down = cusumNeg > settings.spike_cusum_h;
          // The volume floor applies to FIRING only, never to the CUSUM accumulation above —
          // otherwise a slow burn on a low-volume item would never accumulate at all.
          if ((up || down) && cooledDown && x >= settings.spike_min_qty) {
            spikes.push({
              branchId: entry.branchId, itemId: entry.itemId, day,
              actual: x, expected: mean, z,
              cusum: up ? cusumPos : cusumNeg,
              direction: up ? 'up' : 'down',
            });
            cusumPos = 0;
            cusumNeg = 0; // re-arm after firing
          }
        }

        // THEN fold the observation into the baseline (West's numerically stable EWMA update).
        if (obs === 0) {
          mean = x;
          variance = 0;
        } else {
          const diff = x - mean;
          const incr = alpha * diff;
          mean += incr;
          variance = (1 - alpha) * (variance + diff * incr);
        }
        obs++;
      }

      const firedNow = spikes.some((s) => s.branchId === entry.branchId && s.itemId === entry.itemId);
      const vals = {
        ewmaMean: String(mean), ewmaVar: String(Math.max(variance, 0)),
        cusumPos: String(cusumPos), cusumNeg: String(cusumNeg),
        obsDays: obs, lastDay: newDays[newDays.length - 1]!,
        ...(firedNow ? { lastSpikeAt: new Date() } : {}),
        updatedAt: new Date(),
      };
      if (prior) await this.db.update(scmDemandBaselines).set(vals).where(eq(scmDemandBaselines.id, prior.id));
      else {
        await this.db.insert(scmDemandBaselines).values({
          tenantId: tenantId ?? null, branchId: entry.branchId, itemId: entry.itemId, ...vals,
        });
      }
    }

    // Persist events. The (tenant, branch, item, day) unique index is the hard dedupe — one viral
    // evening produces ONE row, not forty, no matter how often the scan runs.
    const insertedByBranch = new Map<number | null, { ids: number[]; items: string[] }>();
    for (const s of spikes) {
      const inserted = await this.db.insert(scmSpikeEvents).values({
        tenantId: tenantId ?? null, branchId: s.branchId, itemId: s.itemId, day: s.day,
        actualQty: String(s.actual), expectedQty: String(Math.max(0, s.expected)),
        zScore: String(Math.round(s.z * 1000) / 1000),
        cusum: String(Math.round(s.cusum * 1000) / 1000),
        direction: s.direction, status: 'Open',
      }).onConflictDoNothing().returning({ id: scmSpikeEvents.id });
      if (!inserted.length) continue;
      const bucket = insertedByBranch.get(s.branchId) ?? { ids: [], items: [] };
      bucket.ids.push(inserted[0]!.id);
      bucket.items.push(s.itemId);
      insertedByBranch.set(s.branchId, bucket);
      try {
        this.live.publish({
          type: 'scm_spike', tenant_id: tenantId, branch_id: s.branchId, item_id: s.itemId,
          day: s.day, z: Math.round(s.z * 100) / 100, direction: s.direction,
        });
      } catch { /* the bus is optional */ }
    }

    // One replan job per branch, batching its spiking items — not one job per item.
    let replans = 0;
    if (settings.auto_replan) {
      for (const [branchId, bucket] of insertedByBranch) {
        if (!bucket.items.length) continue;
        await this.jobs.enqueue({
          jobType: SCM_REPLAN_JOB,
          payload: {
            run_date: today, branch_id: branchId,
            item_ids: [...new Set(bucket.items)], spike_event_ids: bucket.ids,
          },
          tenantId: tenantId ?? null,
          actor,
        });
        replans++;
      }
    }

    const total = [...insertedByBranch.values()].reduce((a, b) => a + b.ids.length, 0);
    if (total) this.log.log(`scm spike scan tenant=${tenantId}: ${total} new event(s), ${replans} replan job(s)`);
    return { scanned, spikes: total, replans };
  }

  scanForUser(user: JwtUser) {
    return this.scanTenant(user.tenantId ?? null, user.username);
  }
}
