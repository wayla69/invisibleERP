'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CircleDollarSign, Package, ShieldCheck, Sparkles, Gauge } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { baht, thaiDate, num } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StateView } from '@/components/state-view';
import { DataTable } from '@/components/data-table';
import { Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { statusVariant } from '@/components/ui';

type Plan = { code: string; name: string; price_monthly: number; price_yearly?: number | null; features?: any };

export default function BillingPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const sub = useQuery<any>({ queryKey: ['subscription'], queryFn: () => api('/api/billing/subscription') });
  const plans = useQuery<{ plans: Plan[] }>({ queryKey: ['plans'], queryFn: () => api('/api/billing/plans') });
  const aiUsage = useQuery<any>({ queryKey: ['ai-usage'], queryFn: () => api('/api/billing/ai-usage') });
  // 1.4/1.5 — this month's metered usage (e-Tax docs / POS txns vs plan quota) + the overage charge history.
  const usage = useQuery<any>({ queryKey: ['billing-usage'], queryFn: () => api('/api/billing/usage') });
  const usageRuns = useQuery<any>({ queryKey: ['usage-overage-runs'], queryFn: () => api('/api/billing/usage-overage/runs') });
  const aiRuns = useQuery<any>({ queryKey: ['ai-overage-runs'], queryFn: () => api('/api/billing/ai-overage/runs') });
  const [msg, setMsg] = useState('');
  const [billInterval, setBillInterval] = useState<'monthly' | 'annual'>('monthly'); // 1.7 — annual billing toggle

  const change = useMutation({
    mutationFn: (args: { plan_code: string; interval: 'monthly' | 'annual' }) => api('/api/billing/change-plan', { method: 'POST', body: JSON.stringify(args) }),
    onSuccess: (d: any, args) => {
      // 1.6 — surface the mid-cycle proration the API now returns (net > 0 = prorated charge, < 0 = credit).
      const net = Number(d?.proration?.net ?? 0);
      const prorate = net > 0.005 ? ` · ${t('st.bill.proration_charge', { amount: baht(net) })}` : net < -0.005 ? ` · ${t('st.bill.proration_credit', { amount: baht(-net) })}` : '';
      setMsg(t('st.bill.plan_changed', { plan: args.plan_code }) + prorate);
      qc.invalidateQueries({ queryKey: ['subscription'] });
    },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  const currentCode = sub.data?.plan_code ?? sub.data?.plan?.code;
  // Render readable plan features. Internal pricing keys (AI ceiling/overage rate, per-unit meter rates) are
  // surfaced in the dedicated usage cards below, not dumped as raw numbers here; `suites` is gating data.
  const HIDDEN = new Set(['ai_tokens_daily_max', 'ai_overage_rate_thb_per_1k', 'custom', 'suites', 'etax_overage_rate_thb_per_doc', 'pos_overage_rate_thb_per_txn']);
  const featureList = (f: any): string[] => {
    if (Array.isArray(f)) return f.map(String);
    if (!f || typeof f !== 'object') return [];
    const labels: string[] = [];
    for (const [k, v] of Object.entries(f)) {
      if (HIDDEN.has(k)) continue;
      if (k === 'users') labels.push(Number(v) < 0 ? t('st.bill.users_unlimited') : t('st.bill.users_max', { count: String(v) }));
      else if (k === 'locations') labels.push(Number(v) < 0 ? t('st.bill.locations_unlimited') : t('st.bill.locations_count', { count: String(v) }));
      else if (k === 'ai_chat') labels.push(v ? t('st.bill.ai_included') : t('st.bill.ai_excluded'));
      else if (k === 'ai_tokens_daily') { if (Number(v) > 0) labels.push(t('st.bill.ai_tokens_daily', { count: num(Number(v) / 1000) })); }
      else if (k === 'etax_docs_monthly') { if (Number(v) !== 0) labels.push(Number(v) < 0 ? t('st.bill.feat_etax_unlimited') : t('st.bill.feat_etax_quota', { count: num(v) })); }
      else if (k === 'pos_txns_monthly') { if (Number(v) !== 0) labels.push(Number(v) < 0 ? t('st.bill.feat_pos_unlimited') : t('st.bill.feat_pos_quota', { count: num(v) })); }
      else if (k === 'reports') labels.push(t('st.bill.reports', { value: String(v) }));
      else labels.push(String(v));
    }
    return labels;
  };
  const ai = aiUsage.data;
  const overageCharge = Number(ai?.today?.projected_overage_thb ?? 0);

  return (
    <div>
      <PageHeader title={t('st.bill.title')} description={t('st.bill.subtitle')} />
      <div className="space-y-6">
        <StateView q={sub}>
          {sub.data && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label={t('st.bill.current_plan')} value={(currentCode ?? '—').toUpperCase()} icon={Package} tone="primary" />
              <StatCard label={t('fin.col_status')} value={<Badge variant={statusVariant(sub.data.status ?? 'Active')}>{sub.data.status ?? 'Active'}</Badge>} icon={ShieldCheck} />
              {sub.data.price_monthly != null && <StatCard label={t('st.bill.price_monthly')} value={baht(sub.data.price_monthly)} icon={CircleDollarSign} />}
              {sub.data.trial_ends_at && <StatCard label={t('st.bill.trial_until')} value={thaiDate(sub.data.trial_ends_at)} icon={CalendarClock} tone="warning" />}
            </div>
          )}
        </StateView>

        {/* AI usage — today's consumption vs the plan's included cap + hard ceiling, plus the metered overage
            charge so the AI cost is visible (PwC follow-up: connect the COGS meter to a price). */}
        {ai && Number(ai.daily_max) > 0 && (
          <Card className="gap-4 p-5">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              <strong className="text-sm">{t('st.bill.ai_today')}</strong>
              <span className="ml-auto text-xs text-muted-foreground">{t('st.bill.reset_midnight')}</span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label={t('st.bill.used_today')} value={t('st.bill.tokens_value', { count: num(ai.today?.total_tokens) })} icon={Gauge} tone={ai.today?.over_budget ? 'warning' : 'primary'} />
              <StatCard label={t('st.bill.plan_included')} value={t('st.bill.per_day_value', { count: num(ai.daily_limit) })} icon={Package} />
              <StatCard label={t('st.bill.hard_ceiling')} value={t('st.bill.per_day_value', { count: num(ai.daily_max) })} icon={ShieldCheck} />
              <StatCard
                label={t('st.bill.overage_label', { rate: Number(ai.overage_rate_thb_per_1k) })}
                value={baht(overageCharge)}
                icon={CircleDollarSign}
                tone={overageCharge > 0 ? 'warning' : undefined}
              />
            </div>
            {Number(ai.today?.overage_tokens ?? 0) > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('st.bill.overage_detail', { tokens: num(ai.today.overage_tokens), rate: Number(ai.overage_rate_thb_per_1k) })}
              </p>
            )}
          </Card>
        )}

        {/* 1.5 — this month's metered usage (e-Tax documents / POS transactions) vs the plan quota, with the
            projected overage charge per meter. Mirrors the AI card so every meter→price link is visible. */}
        {(usage.data?.meters ?? []).length > 0 && (
          <Card className="gap-4 p-5">
            <div className="flex items-center gap-2">
              <Gauge className="size-4 text-primary" />
              <strong className="text-sm">{t('st.bill.usage_month', { month: usage.data.month })}</strong>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {usage.data.meters.map((m: any) => {
                const label = m.meter === 'etax_docs' ? t('st.bill.meter_etax') : m.meter === 'pos_txns' ? t('st.bill.meter_pos') : m.meter;
                const quota = Number(m.included) < 0 ? t('st.bill.unlimited') : num(m.included);
                return (
                  <div key={m.meter} className="rounded-lg border p-4">
                    <div className="flex items-center justify-between">
                      <strong className="text-sm">{label}</strong>
                      {Number(m.overage_units) > 0
                        ? <Badge variant="warning">{t('st.bill.overage_units', { count: num(m.overage_units) })}</Badge>
                        : <Badge variant="success">{t('st.bill.within_quota')}</Badge>}
                    </div>
                    <div className="mt-1 text-2xl font-bold tabular-nums">{num(m.used)} <span className="text-sm font-normal text-muted-foreground">/ {quota}</span></div>
                    {Number(m.amount) > 0 && <p className="mt-1 text-xs text-muted-foreground">{t('st.bill.overage_amount', { amount: baht(m.amount), rate: String(m.rate_thb_per_unit) })}</p>}
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {/* Overage charge history — the collected side of the meters (AI + usage), most recent first. */}
        {((usageRuns.data?.runs ?? []).length > 0 || (aiRuns.data?.runs ?? []).length > 0) && (
          <Card className="gap-3 p-5">
            <strong className="text-sm">{t('st.bill.charge_history')}</strong>
            <DataTable
              dense
              rows={[
                ...(aiRuns.data?.runs ?? []).map((r: any) => ({ month: r.month, meter: 'AI', qty: `${num(r.overage_tokens)} tokens`, amount: r.amount, status: r.status })),
                ...(usageRuns.data?.runs ?? []).map((r: any) => ({ month: r.month, meter: r.meter === 'etax_docs' ? t('st.bill.meter_etax') : r.meter === 'pos_txns' ? t('st.bill.meter_pos') : r.meter, qty: num(r.overage_units), amount: r.amount, status: r.status })),
              ].sort((a, b) => String(b.month).localeCompare(String(a.month)))}
              rowKey={(r, i) => `${r.month}-${r.meter}-${i}`}
              columns={[
                { key: 'month', label: t('st.bill.col_month'), sortable: true, className: 'tabular-nums' },
                { key: 'meter', label: t('st.bill.col_meter'), sortable: true },
                { key: 'qty', label: t('st.bill.col_qty'), align: 'right', className: 'tabular-nums' },
                { key: 'amount', label: t('fin.col_amount'), align: 'right', sortable: true, render: (r) => <span className="tabular-nums">{baht(r.amount)}</span> },
                { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={r.status === 'invoiced' ? 'success' : 'secondary'}>{r.status}</Badge> },
              ]}
            />
          </Card>
        )}

        <div>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <h3 className="text-sm font-semibold text-muted-foreground">{t('st.bill.choose_plan')}</h3>
            <div className="ml-auto inline-flex rounded-lg border p-0.5 text-xs">
              <button type="button" className={cn('rounded-md px-3 py-1 font-medium', billInterval === 'monthly' && 'bg-primary text-primary-foreground')} onClick={() => setBillInterval('monthly')}>{t('st.bill.interval_monthly')}</button>
              <button type="button" className={cn('rounded-md px-3 py-1 font-medium', billInterval === 'annual' && 'bg-primary text-primary-foreground')} onClick={() => setBillInterval('annual')}>{t('st.bill.interval_annual')}</button>
            </div>
          </div>
          <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
          <StateView q={plans}>
            {plans.data && (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {plans.data.plans.map((p) => {
                  const current = p.code === currentCode;
                  return (
                    <Card key={p.code} className={cn('gap-3 p-5', current && 'border-2 border-primary')}>
                      <div className="flex items-center justify-between">
                        <strong className="text-lg">{p.name}</strong>
                        {current && <Badge variant="success">{t('st.bill.current')}</Badge>}
                      </div>
                      <div className="text-2xl font-bold text-primary">
                        {billInterval === 'annual' && p.price_yearly
                          ? <>{baht(p.price_yearly)}<span className="text-sm font-normal text-muted-foreground"> {t('st.bill.per_year')}</span></>
                          : <>{p.price_monthly > 0 ? baht(p.price_monthly) : t('st.bill.free')}{p.price_monthly > 0 && <span className="text-sm font-normal text-muted-foreground"> {t('st.bill.per_month')}</span>}</>}
                        {billInterval === 'annual' && !p.price_yearly && p.price_monthly > 0 && <div className="text-xs font-normal text-muted-foreground">{t('st.bill.annual_not_offered')}</div>}
                      </div>
                      <ul className="min-h-[60px] list-disc pl-5 text-sm text-muted-foreground">
                        {featureList(p.features).map((f, i) => <li key={i}>{f}</li>)}
                      </ul>
                      <Button
                        className="w-full"
                        variant={current ? 'secondary' : 'default'}
                        disabled={current || change.isPending}
                        onClick={() => change.mutate({ plan_code: p.code, interval: billInterval === 'annual' && p.price_yearly ? 'annual' : 'monthly' })}
                      >
                        {current ? t('st.bill.in_use') : t('st.bill.choose_this')}
                      </Button>
                    </Card>
                  );
                })}
              </div>
            )}
          </StateView>
        </div>
      </div>
    </div>
  );
}
