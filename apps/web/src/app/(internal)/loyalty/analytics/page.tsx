'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { BarChart3, Users, AlertTriangle, Coins, Ticket, TrendingDown } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Overview {
  members: { total: number; active: number; opted_in: number; at_risk: number };
  tier_mix: Record<string, number>;
  points: { open_balance: number; lifetime: number; earned: number; adjusted: number; redeemed: number; expired: number };
  redemption: { rewards_issued: number; rewards_used: number; coupons_issued: number; coupons_used: number; redemption_rate_pct: number };
  liability: { open_points: number; baht_per_point: number; fair_value: number; posted_2250: number };
  breakage_rate_pct: number; churn_rate_pct: number; active_rate_pct: number;
}
interface Churn { at_risk: { id: number; member_code: string; name: string; tier: string; balance: number; last_activity: string }[] }
interface Segments { profiled_members: number; total_spend: number; segments: { segment: string; members: number; total_spend: number; total_orders: number; avg_spend: number }[]; at_risk_value?: { members: number; predicted_ltv: number; threshold: number } }
interface LiveFeed { available: boolean; events: { kind: 'earn' | 'redeem'; member_id: number; points: number; balance_after: number; ref_doc: string; at?: string }[] }

// RFM segment → colour (Champions best → Lost worst; Unsegmented neutral).
const SEG_TONE: Record<string, string> = { Champions: 'bg-success', Loyal: 'bg-primary', New: 'bg-info', 'At Risk': 'bg-warning', Lost: 'bg-destructive', Unsegmented: 'bg-muted-foreground/40' };

function Stat({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: string; sub?: string; tone?: string }) {
  return (
    <Card className="gap-1">
      <CardContent className="pt-5">
        <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">{label}</span><span className={tone ?? 'text-muted-foreground'}>{icon}</span></div>
        <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

export default function LoyaltyAnalyticsPage() {
  const { t } = useLang();
  const ov = useQuery<Overview>({ queryKey: ['loy-analytics'], queryFn: () => api('/api/loyalty/analytics') });
  const churn = useQuery<Churn>({ queryKey: ['loy-churn'], queryFn: () => api('/api/loyalty/analytics/churn?limit=20') });
  const seg = useQuery<Segments>({ queryKey: ['loy-segments'], queryFn: () => api('/api/loyalty/analytics/segments') });
  const live = useQuery<LiveFeed>({ queryKey: ['loy-live'], queryFn: () => api('/api/loyalty/analytics/live?limit=12'), refetchInterval: 5000 });
  const maxTier = ov.data ? Math.max(1, ...Object.values(ov.data.tier_mix)) : 1;
  const maxSeg = seg.data ? Math.max(1, ...seg.data.segments.map((s) => s.members)) : 1;

  return (
    <div>
      <PageHeader title={t('ly.an_title')} description={t('ly.an_desc')}
        actions={<Link href="/loyalty/members"><Button variant="outline"><Users className="size-4" /> {t('ly.members')}</Button></Link>} />
      <StateView q={ov}>
        {ov.data && (
          <div className="space-y-6">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat icon={<Users className="size-4" />} label={t('ly.an_total_members')} value={num(ov.data.members.total)} sub={t('ly.an_members_sub', { active: num(ov.data.members.active), optin: num(ov.data.members.opted_in) })} />
              <Stat icon={<Coins className="size-4" />} label={t('ly.an_liability')} value={baht(ov.data.liability.fair_value)} sub={t('ly.an_liability_sub', { points: num(ov.data.liability.open_points), rate: ov.data.liability.baht_per_point, posted: num(ov.data.liability.posted_2250) })} tone="text-primary" />
              <Stat icon={<Ticket className="size-4" />} label={t('ly.an_redemption_rate')} value={`${ov.data.redemption.redemption_rate_pct}%`} sub={t('ly.an_redemption_sub', { used: num(ov.data.redemption.rewards_used + ov.data.redemption.coupons_used), issued: num(ov.data.redemption.rewards_issued + ov.data.redemption.coupons_issued) })} tone="text-success" />
              <Stat icon={<TrendingDown className="size-4" />} label={t('ly.an_breakage')} value={`${ov.data.breakage_rate_pct}%`} sub={t('ly.an_breakage_sub', { n: num(ov.data.points.expired) })} tone="text-warning" />
              <Stat icon={<AlertTriangle className="size-4" />} label={t('ly.an_churn')} value={`${ov.data.churn_rate_pct}%`} sub={t('ly.an_churn_sub', { n: num(ov.data.members.at_risk) })} tone="text-destructive" />
              <Stat icon={<BarChart3 className="size-4" />} label={t('ly.an_active_rate')} value={`${ov.data.active_rate_pct}%`} />
              <Stat icon={<Coins className="size-4" />} label={t('ly.an_open_balance')} value={num(ov.data.points.open_balance)} sub={t('ly.an_points_sub', { earned: num(ov.data.points.earned), redeemed: num(ov.data.points.redeemed), adjusted: num(ov.data.points.adjusted) })} />
            </div>

            <Card className="gap-3">
              <CardHeader className="pb-0">
                <CardTitle className="flex items-center gap-2 text-base">
                  <span className={`inline-block size-2 rounded-full ${live.data?.available ? 'bg-success animate-pulse' : 'bg-muted-foreground/40'}`} />
                  {t('ly.an_live_title')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {(live.data?.events?.length ?? 0) === 0
                  ? <p className="py-2 text-center text-sm text-muted-foreground">{t('ly.an_live_empty')}</p>
                  : (
                    <div className="space-y-1">
                      {live.data!.events.map((e, i) => (
                        <div key={`${e.ref_doc}-${i}`} className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-1.5 text-sm">
                          <span className="flex items-center gap-2">
                            <Badge variant="muted" className={e.kind === 'earn' ? 'text-success' : 'text-primary'}>{e.kind === 'earn' ? t('ly.an_earn') : t('ly.an_redeem')}</Badge>
                            <span className="text-muted-foreground">{t('ly.col_member')} #{e.member_id}</span>
                            <span className="text-xs text-muted-foreground">{e.ref_doc}</span>
                          </span>
                          <span className="tabular-nums">{e.kind === 'earn' ? '+' : '−'}{num(e.points)} {t('ly.an_pts')} <span className="text-xs text-muted-foreground">({t('ly.an_balance_after', { n: num(e.balance_after) })})</span></span>
                        </div>
                      ))}
                    </div>
                  )}
              </CardContent>
            </Card>

            <Card className="gap-3">
              <CardHeader className="pb-0"><CardTitle className="text-base">{t('ly.an_tier_mix')}</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {Object.entries(ov.data.tier_mix).sort((a, b) => b[1] - a[1]).map(([tier, c]) => (
                  <div key={tier} className="flex items-center gap-3">
                    <span className="w-20 shrink-0 text-sm">{tier}</span>
                    <div className="h-3 flex-1 rounded-full bg-muted"><div className="h-3 rounded-full bg-primary" style={{ width: `${(c / maxTier) * 100}%` }} /></div>
                    <span className="w-12 shrink-0 text-right text-sm tabular-nums">{num(c)}</span>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="gap-3">
              <CardHeader className="pb-0">
                <CardTitle className="flex items-center gap-2 text-base"><BarChart3 className="size-4 text-primary" /> {t('ly.an_rfm_title')}</CardTitle>
                {seg.data && <p className="text-xs text-muted-foreground">{t('ly.an_rfm_summary', { n: num(seg.data.profiled_members), spend: baht(seg.data.total_spend) })}{seg.data.at_risk_value && seg.data.at_risk_value.members > 0 ? t('ly.an_rfm_atrisk', { ltv: baht(seg.data.at_risk_value.predicted_ltv), n: num(seg.data.at_risk_value.members), threshold: seg.data.at_risk_value.threshold }) : ''}</p>}
              </CardHeader>
              <CardContent className="space-y-2">
                <StateView q={seg}>
                  {seg.data && seg.data.segments.map((s) => (
                    <Link key={s.segment} href={`/crm/members?segment=${encodeURIComponent(s.segment)}`} className="flex items-center gap-3 rounded-md px-1 py-0.5 hover:bg-muted/50" title={t('ly.an_seg_link_title')}>
                      <span className="w-20 shrink-0 text-sm">{s.segment}</span>
                      <div className="h-3 flex-1 rounded-full bg-muted"><div className={`h-3 rounded-full ${SEG_TONE[s.segment] ?? 'bg-primary'}`} style={{ width: `${(s.members / maxSeg) * 100}%` }} /></div>
                      <span className="w-10 shrink-0 text-right text-sm tabular-nums">{num(s.members)}</span>
                      <span className="hidden w-28 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:inline">{t('ly.an_avg', { n: num(s.avg_spend) })}</span>
                    </Link>
                  ))}
                </StateView>
              </CardContent>
            </Card>

            <Card className="gap-3">
              <CardHeader className="pb-0"><CardTitle className="flex items-center gap-2 text-base"><AlertTriangle className="size-4 text-destructive" /> {t('ly.an_winback_title')}</CardTitle></CardHeader>
              <CardContent>
                <StateView q={churn}>
                  {churn.data && (churn.data.at_risk.length === 0 ? <p className="py-2 text-center text-sm text-muted-foreground">{t('ly.an_no_churn')}</p> : (
                    <div className="space-y-1">
                      {churn.data.at_risk.map((m) => (
                        <Link key={m.id} href={`/loyalty/members/${m.id}`} className="flex items-center justify-between rounded-lg border border-border/60 p-2 hover:bg-muted/50">
                          <span className="text-sm"><span className="font-medium">{m.name ?? m.member_code}</span> <Badge variant="muted" className="ml-1">{m.tier}</Badge></span>
                          <span className="text-sm tabular-nums">{num(m.balance)} {t('ly.an_pts')}</span>
                        </Link>
                      ))}
                    </div>
                  ))}
                </StateView>
              </CardContent>
            </Card>
          </div>
        )}
      </StateView>
    </div>
  );
}
