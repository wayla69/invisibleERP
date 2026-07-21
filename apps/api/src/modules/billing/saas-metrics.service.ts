import { rowsOf } from '../../common/db-rows';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import type { JwtUser } from '../../common/decorators';

const n = (v: any) => Number(v ?? 0);
const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// SaaS business metrics for the platform operator (HQ): MRR/ARR, plan mix, churn, and engagement
// (DAU/MAU). Recurring revenue + subscription counts come from subscriptions⋈plans; DAU/MAU are derived
// from distinct actors in audit_log (no new tracking table needed — every authenticated request is logged).
// HQ/Admin runs with RLS bypass so the aggregates span all tenants; a tenant-scoped caller would only see
// its own row (harmless). Read-only.
@Injectable()
export class SaasMetricsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async overview(_user: JwtUser) {
    const db = this.db;

    // Recurring revenue + status counts + per-plan mix (active subscriptions drive MRR).
    // 0456 — MRR sums each subscription's EFFECTIVE monthly price: the grandfathered snapshot while its
    // lock is active (grandfathered_until NULL = indefinite), else the plan's current list price.
    const planRows = await db.execute(sql`
      SELECT p.code, p.name,
             coalesce(p.price_monthly, 0)::float8 AS price,
             count(*) FILTER (WHERE s.status = 'Active')     AS active,
             count(*) FILTER (WHERE s.status = 'Trialing')   AS trialing,
             count(*) FILTER (WHERE s.status = 'PastDue')    AS past_due,
             count(*) FILTER (WHERE s.status = 'Canceled')   AS canceled,
             coalesce(sum(
               CASE WHEN s.status = 'Active' THEN
                 CASE WHEN s.grandfathered_price IS NOT NULL
                           AND (s.grandfathered_until IS NULL OR s.grandfathered_until > now())
                      THEN s.grandfathered_price ELSE coalesce(p.price_monthly, 0) END
               ELSE 0 END), 0)::float8 AS mrr_active
      FROM plans p LEFT JOIN subscriptions s ON s.plan_code = p.code
      GROUP BY p.code, p.name, p.price_monthly
      ORDER BY p.price_monthly`);
    const plans = rowsOf(planRows);

    let mrr = 0, active = 0, trialing = 0, pastDue = 0, canceled = 0;
    const byPlan = plans.map((r) => {
      const a = n(r.active), price = n(r.price), planMrr = n(r.mrr_active);
      mrr += planMrr; active += a; trialing += n(r.trialing); pastDue += n(r.past_due); canceled += n(r.canceled);
      return { plan: r.code, name: r.name, price_monthly: round2(price), active_subscriptions: a, mrr: round2(planMrr), trialing: n(r.trialing) };
    });

    // Churn (last 30 days): subscriptions canceled in the window vs the active base at the window start
    // (active now + canceled in window ≈ the base that could have churned).
    const [churnRow] = rowsOf(await db.execute(sql`
      SELECT count(*) FILTER (WHERE status = 'Canceled' AND created_at >= now() - interval '30 days') AS canceled_30d
      FROM subscriptions`));
    const canceled30d = n(churnRow?.canceled_30d);
    const churnBase = active + canceled30d;
    const churnRatePct = churnBase > 0 ? round2((canceled30d / churnBase) * 100) : 0;

    // Engagement — distinct actors in audit_log over the trailing day / 30 days (DAU/MAU + stickiness).
    const [eng] = rowsOf(await db.execute(sql`
      SELECT count(DISTINCT actor) FILTER (WHERE ts >= now() - interval '1 day')   AS dau,
             count(DISTINCT actor) FILTER (WHERE ts >= now() - interval '30 days') AS mau
      FROM audit_log WHERE actor IS NOT NULL`));
    const dau = n(eng?.dau), mau = n(eng?.mau);

    return {
      as_of: new Date().toISOString(),
      revenue: {
        mrr: round2(mrr),
        arr: round2(mrr * 12),
        arpu: active > 0 ? round2(mrr / active) : 0, // average revenue per active account
        currency: 'THB',
      },
      subscriptions: { active, trialing, past_due: pastDue, canceled, paying: active },
      churn: { canceled_30d: canceled30d, churn_rate_30d_pct: churnRatePct },
      engagement: { dau, mau, stickiness_pct: mau > 0 ? round2((dau / mau) * 100) : 0 },
      by_plan: byPlan,
    };
  }
}
