// Customer Intelligence drill-down (docs/60 Phase 2, MKT-18) — the "who + what to do" tab of
// /marketing-intel. NO 'use client' directive: imported only by the already-'use client' page, so it
// inherits that boundary (keeps the use-client ratchet flat — same pattern as budget-planner.tsx).
//
// Per-customer scores (CLV / churn / next-best-action) the external platform pushed onto customer_profiles
// are ADVISORY: this is a read-only drill-down, and the only contact path is the consent-gated campaign
// draft (Create campaign → activateSegment) that a human edits + sends.
import { useMemo, useState, type CSSProperties } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Users, Megaphone, TrendingDown, Crown, Sparkles, ArrowDownUp } from 'lucide-react';
import { api } from '@/lib/api';
import { num, baht } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { StateView } from '@/components/state-view';
import { Button } from '@/components/ui/button';

const HUES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];
const tintBg = (h: string, pct = 9): CSSProperties => ({ background: `color-mix(in oklch, ${h} ${pct}%, var(--card))`, borderColor: `color-mix(in oklch, ${h} 16%, var(--border))` });
const softText = (h: string): CSSProperties => ({ color: `color-mix(in oklch, ${h} 66%, var(--foreground))` });
const fill = (h: string): string => `color-mix(in oklch, ${h} 78%, var(--card))`;

// next-best-action code → hue (warm = grow, cool = retain/win-back). Falls back to lilac.
const NBA_HUE: Record<string, string> = {
  WINBACK: 'var(--chart-1)', REACTIVATE: 'var(--chart-1)',
  VIP_CARE: 'var(--chart-4)', UPSELL: 'var(--chart-3)', CROSS_SELL: 'var(--chart-3)',
  NURTURE: 'var(--chart-2)', RETAIN: 'var(--chart-5)',
};

interface SegCount { segment: string; members: number }
interface Cust {
  customer_no: string | null; name: string | null;
  clv: number | null; churn_risk: number | null; nba: string | null;
  own_churn_risk: number | null; own_predicted_ltv: number | null;
  total_spend: number | null; last_order_at: string | null;
}
interface Drill { segment: string; sort: string; count: number; customers: Cust[] }

// churn probability [0,1] → a soft red-ward hue by band (low = mint, high = rose).
const churnHue = (p: number | null): string => (p == null ? 'var(--chart-5)' : p >= 0.6 ? 'var(--chart-1)' : p >= 0.35 ? 'var(--chart-4)' : 'var(--chart-3)');

export function CustomerIntel() {
  const { t } = useLang();
  const segQ = useQuery<{ segments: SegCount[] }>({ queryKey: ['marketing-intel', 'segments'], queryFn: () => api('/api/marketing-intel/segments') });
  const segments = useMemo(() => (Array.isArray(segQ.data?.segments) ? segQ.data!.segments : []), [segQ.data]);

  const [segment, setSegment] = useState<string | null>(null);
  const [sort, setSort] = useState<'clv' | 'churn'>('clv');
  const active = segment ?? segments[0]?.segment ?? null;

  const drillQ = useQuery<Drill>({
    queryKey: ['marketing-intel', 'drill', active, sort],
    queryFn: () => api(`/api/marketing-intel/segment/${encodeURIComponent(active!)}/customers?sort=${sort}`),
    enabled: !!active,
  });

  const activate = useMutation({
    mutationFn: (seg: string) => api('/api/marketing-intel/segments/activate', { method: 'POST', body: JSON.stringify({ segment: seg }) }),
    onSuccess: () => notifySuccess(t('mi.activate_done')),
    onError: (e: any) => notifyError(e?.body?.error?.code === 'EMPTY_SEGMENT' ? t('mi.activate_empty') : (e?.message ?? 'error')),
  });

  const customers = Array.isArray(drillQ.data?.customers) ? drillQ.data!.customers : [];

  return (
    <StateView q={segQ}>
      {segQ.data && (!segments.length ? (
        <div className="rounded-2xl border border-dashed p-12 text-center" style={tintBg('var(--chart-3)', 8)}>
          <Sparkles className="mx-auto mb-3 size-8" style={softText('var(--chart-3)')} />
          <p className="text-base font-semibold">{t('mi.ci_no_data')}</p>
        </div>
      ) : (
        <div className="space-y-5">
          <div>
            <h2 className="text-lg font-semibold">{t('mi.ci_title')}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{t('mi.ci_subtitle')}</p>
          </div>

          {/* Segment picker chips */}
          <div className="flex flex-wrap gap-2">
            {segments.map((s, i) => {
              const hue = HUES[i % HUES.length];
              const on = active === s.segment;
              return (
                <button
                  key={s.segment}
                  onClick={() => setSegment(s.segment)}
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-all ${on ? 'shadow-sm' : 'opacity-80 hover:opacity-100'}`}
                  style={on ? { ...tintBg(hue, 18), color: `color-mix(in oklch, ${hue} 72%, var(--foreground))` } : tintBg(hue, 7)}
                >
                  <Users className="size-3.5" /> {s.segment}
                  <span className="rounded-full bg-background/70 px-1.5 text-xs tabular-nums">{num(s.members)}</span>
                </button>
              );
            })}
          </div>

          {/* Sort toggle + create-campaign */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex overflow-hidden rounded-lg border text-sm">
              {(['clv', 'churn'] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setSort(k)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 transition-colors ${sort === k ? 'font-semibold' : 'text-muted-foreground hover:text-foreground'}`}
                  style={sort === k ? tintBg('var(--chart-2)', 14) : undefined}
                >
                  <ArrowDownUp className="size-3.5" /> {k === 'clv' ? t('mi.ci_sort_clv') : t('mi.ci_sort_churn')}
                </button>
              ))}
            </div>
            {active && (
              <Button size="sm" variant="outline" className="bg-background/60" disabled={activate.isPending} onClick={() => activate.mutate(active)}>
                <Megaphone className="size-4" /> {t('mi.ci_campaign')}
              </Button>
            )}
          </div>

          {/* Customer list */}
          <StateView q={drillQ}>
            {drillQ.data && (customers.length === 0 ? (
              <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{t('mi.ci_empty')}</p>
            ) : (
              <div className="grid gap-2">
                {customers.map((c, i) => {
                  const nbaHue = c.nba ? (NBA_HUE[c.nba] ?? 'var(--chart-5)') : 'var(--chart-5)';
                  const chHue = churnHue(c.churn_risk);
                  return (
                    <div key={c.customer_no ?? i} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border p-3" style={tintBg(HUES[i % HUES.length], 6)}>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{c.name ?? c.customer_no ?? '—'}</div>
                        <div className="truncate text-xs text-muted-foreground tabular-nums">
                          {c.customer_no}{c.total_spend != null ? ` · ${t('mi.col_monetary')} ${baht(c.total_spend)}` : ''}{c.last_order_at ? ` · ${new Date(c.last_order_at).toLocaleDateString()}` : ''}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold tabular-nums" style={softText('var(--chart-3)')}>{c.clv != null ? baht(c.clv) : '—'}</div>
                        <div className="text-[11px] text-muted-foreground">{t('mi.ci_clv')}</div>
                      </div>
                      <div className="w-24 text-right">
                        <div className="inline-flex items-center gap-1 text-sm font-semibold tabular-nums" style={softText(chHue)}>
                          <TrendingDown className="size-3.5" /> {c.churn_risk != null ? `${num(c.churn_risk * 100, 0)}%` : '—'}
                        </div>
                        <div className="text-[11px] text-muted-foreground">{t('mi.ci_churn')}</div>
                      </div>
                      {c.nba && (
                        <span className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold shadow-sm" style={{ ...tintBg(nbaHue, 16), color: `color-mix(in oklch, ${nbaHue} 70%, var(--foreground))` }}>
                          <Crown className="size-3" /> {t(`mi.nba_${c.nba.toLowerCase()}`)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </StateView>
        </div>
      ))}
    </StateView>
  );
}
