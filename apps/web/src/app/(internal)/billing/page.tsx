'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CircleDollarSign, Package, ShieldCheck, Sparkles, Gauge } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { baht, thaiDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StateView } from '@/components/state-view';
import { Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { statusVariant } from '@/components/ui';

type Plan = { code: string; name: string; price_monthly: number; features?: any };

export default function BillingPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const sub = useQuery<any>({ queryKey: ['subscription'], queryFn: () => api('/api/billing/subscription') });
  const plans = useQuery<{ plans: Plan[] }>({ queryKey: ['plans'], queryFn: () => api('/api/billing/plans') });
  const aiUsage = useQuery<any>({ queryKey: ['ai-usage'], queryFn: () => api('/api/billing/ai-usage') });
  const [msg, setMsg] = useState('');

  const change = useMutation({
    mutationFn: (plan_code: string) => api('/api/billing/change-plan', { method: 'POST', body: JSON.stringify({ plan_code }) }),
    onSuccess: (_d, plan_code) => { setMsg(t('st.bill.plan_changed', { plan: plan_code })); qc.invalidateQueries({ queryKey: ['subscription'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  const currentCode = sub.data?.plan_code ?? sub.data?.plan?.code;
  // Render readable plan features. Internal AI-pricing keys (ceiling/overage rate) are surfaced in the
  // dedicated AI-usage card below, not dumped as raw numbers here.
  const HIDDEN = new Set(['ai_tokens_daily_max', 'ai_overage_rate_thb_per_1k', 'custom']);
  const featureList = (f: any): string[] => {
    if (Array.isArray(f)) return f.map(String);
    if (!f || typeof f !== 'object') return [];
    const labels: string[] = [];
    for (const [k, v] of Object.entries(f)) {
      if (HIDDEN.has(k)) continue;
      if (k === 'users') labels.push(Number(v) < 0 ? t('st.bill.users_unlimited') : t('st.bill.users_max', { count: String(v) }));
      else if (k === 'locations') labels.push(Number(v) < 0 ? t('st.bill.locations_unlimited') : t('st.bill.locations_count', { count: String(v) }));
      else if (k === 'ai_chat') labels.push(v ? t('st.bill.ai_included') : t('st.bill.ai_excluded'));
      else if (k === 'ai_tokens_daily') { if (Number(v) > 0) labels.push(t('st.bill.ai_tokens_daily', { count: (Number(v) / 1000).toLocaleString() })); }
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
              <StatCard label={t('st.bill.used_today')} value={t('st.bill.tokens_value', { count: Number(ai.today?.total_tokens ?? 0).toLocaleString() })} icon={Gauge} tone={ai.today?.over_budget ? 'warning' : 'primary'} />
              <StatCard label={t('st.bill.plan_included')} value={t('st.bill.per_day_value', { count: Number(ai.daily_limit).toLocaleString() })} icon={Package} />
              <StatCard label={t('st.bill.hard_ceiling')} value={t('st.bill.per_day_value', { count: Number(ai.daily_max).toLocaleString() })} icon={ShieldCheck} />
              <StatCard
                label={t('st.bill.overage_label', { rate: Number(ai.overage_rate_thb_per_1k) })}
                value={baht(overageCharge)}
                icon={CircleDollarSign}
                tone={overageCharge > 0 ? 'warning' : undefined}
              />
            </div>
            {Number(ai.today?.overage_tokens ?? 0) > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('st.bill.overage_detail', { tokens: Number(ai.today.overage_tokens).toLocaleString(), rate: Number(ai.overage_rate_thb_per_1k) })}
              </p>
            )}
          </Card>
        )}

        <div>
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('st.bill.choose_plan')}</h3>
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
                        {p.price_monthly > 0 ? baht(p.price_monthly) : t('st.bill.free')}
                        {p.price_monthly > 0 && <span className="text-sm font-normal text-muted-foreground"> {t('st.bill.per_month')}</span>}
                      </div>
                      <ul className="min-h-[60px] list-disc pl-5 text-sm text-muted-foreground">
                        {featureList(p.features).map((f, i) => <li key={i}>{f}</li>)}
                      </ul>
                      <Button
                        className="w-full"
                        variant={current ? 'secondary' : 'default'}
                        disabled={current || change.isPending}
                        onClick={() => change.mutate(p.code)}
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
