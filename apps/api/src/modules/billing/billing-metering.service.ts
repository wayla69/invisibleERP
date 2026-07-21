import { BadRequestException } from '@nestjs/common';
import { eq, sql, and, desc } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { plans, subscriptions, aiTokenUsage, aiOverageBillingRuns, usageEvents, usageOverageBillingRuns } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { rowsOf } from '../../common/db-rows';
import { StripeBilling } from './stripe-gateway';

// docs/46 Phase 4c cut 4 — the USAGE METERING side of billing (AI-token ceiling+overage economics and the
// generic e-Tax/POS meters: usage views, monthly overage invoice lines, the idempotent scheduled billing
// runs and their read views), moved VERBATIM out of billing.service.ts. The AI and generic engines remain
// two deliberately-separate code paths for now — unifying them is a conscious behaviour-affecting dedup the
// docs/46 plan defers until both are characterized. A plain class constructed in the BillingService
// constructor BODY (the shared StripeBilling gateway is passed in); thin facade delegators keep the public
// API — and the ai_overage_billing / usage_overage_billing BI providers — byte-identical.
export class BillingMeteringService {
  constructor(private readonly db: DrizzleDb, private readonly stripe: StripeBilling) {}

  // Per-tenant AI token consumption (cost attribution / COGS visibility). The enforcement side — the daily
  // budget gate (AI_BUDGET_EXCEEDED) and the autocommit usage writes — lives in AgentService; this is the
  // read-only view of the same `ai_token_usage` rows, plus the plan's daily limit so the UI can show
  // "X of Y tokens used today". Read through the normal (tenant-scoped) connection.
  async aiUsage(tenantId: number) {
    const db = this.db;
    const [planRow] = await db.select({ features: plans.features })
      .from(subscriptions).leftJoin(plans, eq(subscriptions.planCode, plans.code))
      .where(and(eq(subscriptions.tenantId, tenantId), sql`${subscriptions.status} in ('Active','Trialing')`))
      .orderBy(desc(subscriptions.createdAt)).limit(1);
    const features: any = planRow?.features ?? {};
    const dailyLimit = features.ai_tokens_daily != null ? Number(features.ai_tokens_daily) : 50000; // included daily cap (default Pro-tier)
    // Hard ceiling + overage economics (ceiling + metered-overage model). A plan that omits the max has no
    // overage band → the included cap IS the ceiling. The rate prices the (included, max] band.
    const dailyMax = features.ai_tokens_daily_max != null ? Number(features.ai_tokens_daily_max) : dailyLimit;
    const overageRate = Number(features.ai_overage_rate_thb_per_1k ?? 0); // THB per 1,000 overage tokens
    const [today] = await db.select({ input: aiTokenUsage.inputTokens, output: aiTokenUsage.outputTokens, overage: aiTokenUsage.overageTokens })
      .from(aiTokenUsage)
      .where(and(eq(aiTokenUsage.tenantId, tenantId), sql`${aiTokenUsage.usageDate} = (now() AT TIME ZONE 'Asia/Bangkok')::date`))
      .limit(1);
    const tIn = today ? Number(today.input) : 0;
    const tOut = today ? Number(today.output) : 0;
    const tTotal = tIn + tOut;
    const tOverage = today ? Number(today.overage) : 0;
    // 30-day usage + overage (the billable accumulation the overage invoice line draws from).
    const [m] = await db.select({
      input: sql<number>`coalesce(sum(${aiTokenUsage.inputTokens}),0)`,
      output: sql<number>`coalesce(sum(${aiTokenUsage.outputTokens}),0)`,
      overage: sql<number>`coalesce(sum(${aiTokenUsage.overageTokens}),0)`,
    }).from(aiTokenUsage)
      .where(and(eq(aiTokenUsage.tenantId, tenantId), sql`${aiTokenUsage.usageDate} >= (now() AT TIME ZONE 'Asia/Bangkok')::date - INTERVAL '30 days'`));
    const mIn = Number(m?.input ?? 0);
    const mOut = Number(m?.output ?? 0);
    const mOverage = Number(m?.overage ?? 0);
    const round2 = (x: number) => Math.round(x * 100) / 100;
    return {
      daily_limit: dailyLimit,          // included finite cap (free band)
      daily_max: dailyMax,              // hard ceiling (absolute cutoff)
      overage_rate_thb_per_1k: overageRate,
      today: {
        input_tokens: tIn, output_tokens: tOut, total_tokens: tTotal,
        remaining: Math.max(0, dailyMax - tTotal),     // tokens left before the hard ceiling
        over_budget: tTotal >= dailyMax,               // hit the hard ceiling (blocked)
        overage_tokens: tOverage,                      // metered beyond the included cap
        projected_overage_thb: round2((tOverage / 1000) * overageRate),
      },
      last_30_days: {
        input_tokens: mIn, output_tokens: mOut, total_tokens: mIn + mOut,
        overage_tokens: mOverage,
        overage_charge_thb: round2((mOverage / 1000) * overageRate),
      },
    };
  }

  // AI overage invoice line for a billing month (YYYY-MM, Asia/Bangkok). Sums the metered overage tokens —
  // the band consumed ABOVE each day's included cap — and prices them at the plan's overage rate. This is the
  // line a monthly invoice run appends so heavy AI usage is billed (panel #3: connect the COGS meter to a
  // price). Returns a zero line when the plan has no overage rate or the tenant stayed within its cap.
  async aiOverageInvoice(tenantId: number, month?: string) {
    const db = this.db;
    const ym = (month && /^\d{4}-\d{2}$/.test(month)) ? month : null;
    const [planRow] = await db.select({ features: plans.features, plan_code: subscriptions.planCode })
      .from(subscriptions).leftJoin(plans, eq(subscriptions.planCode, plans.code))
      .where(and(eq(subscriptions.tenantId, tenantId), sql`${subscriptions.status} in ('Active','Trialing')`))
      .orderBy(desc(subscriptions.createdAt)).limit(1);
    const features: any = planRow?.features ?? {};
    // Rate is data-driven: per-plan feature is the source of truth; an optional global env override
    // (AI_OVERAGE_RATE_THB_PER_1K) lets ops re-price overage without a deploy. Real numbers drop in here.
    const envRate = process.env.AI_OVERAGE_RATE_THB_PER_1K;
    const overageRate = envRate && envRate.trim() ? Number(envRate) : Number(features.ai_overage_rate_thb_per_1k ?? 0); // THB / 1,000 overage tokens
    // Scope to the requested month (default: current Bangkok month). usage_date is already a Bangkok business date.
    const monthFilter = ym
      ? sql`to_char(${aiTokenUsage.usageDate}, 'YYYY-MM') = ${ym}`
      : sql`to_char(${aiTokenUsage.usageDate}, 'YYYY-MM') = to_char((now() AT TIME ZONE 'Asia/Bangkok')::date, 'YYYY-MM')`;
    const [agg] = await db.select({ overage: sql<number>`coalesce(sum(${aiTokenUsage.overageTokens}),0)` })
      .from(aiTokenUsage)
      .where(and(eq(aiTokenUsage.tenantId, tenantId), monthFilter));
    const overageTokens = Number(agg?.overage ?? 0);
    const amount = Math.round((overageTokens / 1000) * overageRate * 100) / 100;
    return {
      tenant_id: tenantId,
      month: ym ?? new Date().toISOString().slice(0, 7),
      plan_code: planRow?.plan_code ?? null,
      overage_tokens: overageTokens,
      overage_rate_thb_per_1k: overageRate,
      currency: 'THB',
      amount, // billable overage charge for the month
      line_description: `AI usage overage — ${overageTokens.toLocaleString()} tokens @ ${overageRate} THB/1k`,
    };
  }

  // ───────────────────── Monthly AI overage billing (scheduled action job — Wave 1) ─────────────────────
  // Charges each tenant's metered AI overage for a billing month as a Stripe invoice item, IDEMPOTENT per
  // (tenant, month) via the ai_overage_billing_runs UNIQUE. Runs from the BI scheduler (report type
  // 'ai_overage_billing') or POST /api/billing/ai-overage/run. Default month = the just-closed Bangkok month.
  // Operator scope: iterates the active/trialing subscriptions VISIBLE to the caller (RLS — the HQ scheduler
  // bypasses RLS and bills every tenant; a tenant-scoped caller bills only itself, harmless).
  // Idempotency ordering: we INSERT the run row FIRST (ON CONFLICT DO NOTHING); only the winner calls Stripe,
  // so a concurrent/retried run can never double-charge. The Stripe idempotencyKey is a second guard.
  async runAiOverageBilling(user: JwtUser, month?: string): Promise<{ month: string; processed_count: number; total_amount: number; processed: any[] }> {
    const db = this.db;
    const round2 = (x: number) => Math.round(x * 100) / 100;
    let billingMonth = month && /^\d{4}-\d{2}$/.test(month) ? month : '';
    if (!billingMonth) {
      const res: any = await db.execute(sql`SELECT to_char((now() AT TIME ZONE 'Asia/Bangkok')::date - INTERVAL '1 month', 'YYYY-MM') AS m`);
      const rows = rowsOf<{ m?: string }>(res);
      billingMonth = String(rows[0]?.m ?? new Date().toISOString().slice(0, 7));
    }
    const subs = await db.select({ tenantId: subscriptions.tenantId, cust: subscriptions.stripeCustomerId, createdAt: subscriptions.createdAt })
      .from(subscriptions).where(sql`${subscriptions.status} in ('Active','Trialing')`).orderBy(desc(subscriptions.createdAt));
    const seen = new Set<number>();
    const processed: any[] = [];
    let total = 0;
    for (const s of subs) {
      const tenantId = Number(s.tenantId);
      if (seen.has(tenantId)) continue; // one (latest) subscription per tenant
      seen.add(tenantId);
      const inv = await this.aiOverageInvoice(tenantId, billingMonth);
      if (inv.amount <= 0) continue; // nothing metered above the included cap this month
      // Reserve the (tenant, month) slot before charging — the UNIQUE makes this the idempotency gate.
      const ins = await db.insert(aiOverageBillingRuns).values({
        tenantId, billingMonth, overageTokens: inv.overage_tokens, rateThbPer1k: String(inv.overage_rate_thb_per_1k),
        amount: String(inv.amount), currency: inv.currency, status: 'pending', processedBy: user?.username ?? 'system:scheduler',
      }).onConflictDoNothing({ target: [aiOverageBillingRuns.tenantId, aiOverageBillingRuns.billingMonth] }).returning({ id: aiOverageBillingRuns.id });
      if (!ins.length) continue; // already billed this (tenant, month) → idempotent skip
      const runId = Number(ins[0]!.id);
      const charge = await this.stripe.createOverageInvoiceItem(s.cust ?? null, inv.amount, inv.line_description, `ai-overage:${tenantId}:${billingMonth}`);
      const status = charge.mock ? 'recorded' : 'invoiced';
      await db.update(aiOverageBillingRuns).set({ stripeInvoiceItemId: charge.id, status }).where(eq(aiOverageBillingRuns.id, runId));
      total += inv.amount;
      processed.push({ tenant_id: tenantId, month: billingMonth, overage_tokens: inv.overage_tokens, amount: inv.amount, currency: inv.currency, stripe_invoice_item_id: charge.id, status });
    }
    return { month: billingMonth, processed_count: processed.length, total_amount: round2(total), processed };
  }

  // History of AI-overage charges for a tenant (most recent first) — the read view of ai_overage_billing_runs.
  // History of AI-overage charges for a tenant (most recent first) — the read view of ai_overage_billing_runs.
  async listOverageRuns(tenantId: number, month?: string) {
    const db = this.db;
    const conds: any[] = [eq(aiOverageBillingRuns.tenantId, tenantId)];
    if (month && /^\d{4}-\d{2}$/.test(month)) conds.push(eq(aiOverageBillingRuns.billingMonth, month));
    const rows = await db.select().from(aiOverageBillingRuns).where(and(...conds)).orderBy(desc(aiOverageBillingRuns.billingMonth)).limit(36);
    return {
      runs: rows.map((r: any) => ({
        month: r.billingMonth, overage_tokens: Number(r.overageTokens), rate_thb_per_1k: Number(r.rateThbPer1k),
        amount: Number(r.amount), currency: r.currency, status: r.status, stripe_invoice_item_id: r.stripeInvoiceItemId, processed_at: r.processedAt,
      })),
    };
  }

  // ───────────────────── Generic usage metering → overage billing (1.5) ─────────────────────
  // The e-Tax-document and POS-transaction meters mirror AI tokens: per-event rows in usage_events, a monthly
  // included quota + per-unit overage price on the plan, and an idempotent monthly Stripe charge.
  static readonly USAGE_METERS: Record<string, { includedKey: string; rateKey: string; unit: string; label: string }> = {
    etax_docs: { includedKey: 'etax_docs_monthly', rateKey: 'etax_overage_rate_thb_per_doc', unit: 'doc', label: 'e-Tax documents' },
    pos_txns: { includedKey: 'pos_txns_monthly', rateKey: 'pos_overage_rate_thb_per_txn', unit: 'txn', label: 'POS transactions' },
  };

  // Overage invoice line for one meter for a billing month: count the tenant's metered events in the period,
  // subtract the plan's included monthly quota (−1 = unlimited ⇒ no overage), price the excess at the per-unit
  // rate. Returns a zero line when within quota, unlimited, or the plan has no rate.
  async usageOverageInvoice(tenantId: number, meter: string, month?: string) {
    const cfg = BillingMeteringService.USAGE_METERS[meter];
    if (!cfg) throw new BadRequestException({ code: 'UNKNOWN_METER', message: `Unknown meter ${meter}`, messageTh: `ไม่รู้จักมิเตอร์ ${meter}` });
    const db = this.db;
    const ym = (month && /^\d{4}-\d{2}$/.test(month)) ? month : new Date().toISOString().slice(0, 7);
    const [planRow] = await db.select({ features: plans.features, plan_code: subscriptions.planCode, branches: subscriptions.branches })
      .from(subscriptions).leftJoin(plans, eq(subscriptions.planCode, plans.code))
      .where(and(eq(subscriptions.tenantId, tenantId), sql`${subscriptions.status} in ('Active','Trialing')`))
      .orderBy(desc(subscriptions.createdAt)).limit(1);
    const features: any = planRow?.features ?? {};
    // 0455 — POS-line plans price and quota PER BRANCH: the included volume scales with the purchased
    // branch count (−1 = unlimited stays unlimited).
    const branchQty = features.per_branch === true ? Math.max(1, Number(planRow?.branches ?? 1)) : 1;
    const baseIncluded = Number(features[cfg.includedKey] ?? 0); // −1 = unlimited
    const included = baseIncluded === -1 ? -1 : baseIncluded * branchQty;
    const rate = Number(features[cfg.rateKey] ?? 0); // THB per unit
    const [agg] = await db.select({ n: sql<number>`count(*)` }).from(usageEvents)
      .where(and(eq(usageEvents.tenantId, tenantId), eq(usageEvents.meter, meter), eq(usageEvents.period, ym)));
    const used = Number(agg?.n ?? 0);
    const overageUnits = included < 0 ? 0 : Math.max(0, used - included);
    const amount = Math.round(overageUnits * rate * 100) / 100;
    return {
      tenant_id: tenantId, meter, month: ym, plan_code: planRow?.plan_code ?? null,
      used, included, overage_units: overageUnits, rate_thb_per_unit: rate, currency: 'THB', amount,
      line_description: `${cfg.label} overage — ${overageUnits.toLocaleString()} ${cfg.unit} @ ${rate} THB/${cfg.unit} (${ym})`,
    };
  }

  // Monthly usage-overage billing across every configured meter (scheduled action job). IDEMPOTENT per
  // (tenant, meter, month) via the usage_overage_billing_runs UNIQUE — the run row is INSERTed first
  // (ON CONFLICT DO NOTHING); only the winner calls Stripe. Mirrors runAiOverageBilling.
  async runUsageOverageBilling(user: JwtUser, month?: string): Promise<{ month: string; processed_count: number; total_amount: number; processed: any[] }> {
    const db = this.db;
    const round2 = (x: number) => Math.round(x * 100) / 100;
    let billingMonth = month && /^\d{4}-\d{2}$/.test(month) ? month : '';
    if (!billingMonth) {
      const res = await db.execute(sql`SELECT to_char((now() AT TIME ZONE 'Asia/Bangkok')::date - INTERVAL '1 month', 'YYYY-MM') AS m`);
      const rows = ((res as { rows?: { m?: string }[] }).rows ?? (res as { m?: string }[]));
      billingMonth = String(rows[0]?.m ?? new Date().toISOString().slice(0, 7));
    }
    const subs = await db.select({ tenantId: subscriptions.tenantId, cust: subscriptions.stripeCustomerId, createdAt: subscriptions.createdAt })
      .from(subscriptions).where(sql`${subscriptions.status} in ('Active','Trialing')`).orderBy(desc(subscriptions.createdAt));
    const seen = new Set<number>();
    const processed: Array<Record<string, unknown>> = [];
    let total = 0;
    for (const s of subs) {
      const tenantId = Number(s.tenantId);
      if (seen.has(tenantId)) continue;
      seen.add(tenantId);
      for (const meter of Object.keys(BillingMeteringService.USAGE_METERS)) {
        const inv = await this.usageOverageInvoice(tenantId, meter, billingMonth);
        if (inv.amount <= 0) continue;
        const ins = await db.insert(usageOverageBillingRuns).values({
          tenantId, meter, billingMonth, overageUnits: inv.overage_units, rateThbPerUnit: String(inv.rate_thb_per_unit),
          amount: String(inv.amount), currency: inv.currency, status: 'pending', processedBy: user?.username ?? 'system:scheduler',
        }).onConflictDoNothing({ target: [usageOverageBillingRuns.tenantId, usageOverageBillingRuns.meter, usageOverageBillingRuns.billingMonth] }).returning({ id: usageOverageBillingRuns.id });
        if (!ins.length) continue; // already billed this (tenant, meter, month)
        const runId = Number(ins[0]!.id);
        const charge = await this.stripe.createOverageInvoiceItem(s.cust ?? null, inv.amount, inv.line_description, `usage-overage:${meter}:${tenantId}:${billingMonth}`);
        const status = charge.mock ? 'recorded' : 'invoiced';
        await db.update(usageOverageBillingRuns).set({ stripeInvoiceItemId: charge.id, status }).where(eq(usageOverageBillingRuns.id, runId));
        total += inv.amount;
        processed.push({ tenant_id: tenantId, meter, month: billingMonth, overage_units: inv.overage_units, amount: inv.amount, currency: inv.currency, stripe_invoice_item_id: charge.id, status });
      }
    }
    return { month: billingMonth, processed_count: processed.length, total_amount: round2(total), processed };
  }

  // Read view of usage_overage_billing_runs for a tenant (most recent first).
  async listUsageOverageRuns(tenantId: number, meter?: string, month?: string) {
    const db = this.db;
    const conds: any[] = [eq(usageOverageBillingRuns.tenantId, tenantId)];
    if (meter && BillingMeteringService.USAGE_METERS[meter]) conds.push(eq(usageOverageBillingRuns.meter, meter));
    if (month && /^\d{4}-\d{2}$/.test(month)) conds.push(eq(usageOverageBillingRuns.billingMonth, month));
    const rows = await db.select().from(usageOverageBillingRuns).where(and(...conds)).orderBy(desc(usageOverageBillingRuns.billingMonth)).limit(72);
    return {
      runs: rows.map((r: any) => ({
        meter: r.meter, month: r.billingMonth, overage_units: Number(r.overageUnits), rate_thb_per_unit: Number(r.rateThbPerUnit),
        amount: Number(r.amount), currency: r.currency, status: r.status, stripe_invoice_item_id: r.stripeInvoiceItemId, processed_at: r.processedAt,
      })),
    };
  }

  // Current-month usage snapshot per meter (used/included/overage) — the tenant's live usage view.
  async usageSummary(tenantId: number, month?: string) {
    const meters = await Promise.all(Object.keys(BillingMeteringService.USAGE_METERS).map((m) => this.usageOverageInvoice(tenantId, m, month)));
    return { tenant_id: tenantId, month: meters[0]?.month ?? new Date().toISOString().slice(0, 7), meters };
  }
}
