'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, Gauge, Package, Receipt, RefreshCw, TrendingUp } from 'lucide-react';
import { api } from '@/lib/api';
import { useRealtime } from '@/hooks/use-realtime';
import { useLang } from '@/lib/i18n';
import { baht, num, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StateView } from '@/components/state-view';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TrendAreaChart, SimpleBarChart } from '@/components/charts';
import { TodayActions } from '@/components/today-actions';
import { GettingStarted } from '@/components/getting-started';
import { statusVariant } from '@/components/ui';

interface Dash {
  today: { sales: number; orders: number };
  month: { sales: number; orders: number };
  low_stock_count: number;
  outstanding_ap: number;
  top_items_today: { Item_Description: string; qty: number; revenue: number }[];
  recent_orders: { Sale_No: string; Sale_Date: string; Total: number; Status: string; Payment_Method: string }[];
}
interface Trend {
  days: number;
  trend: { date: string; sales: number; orders: number }[];
}
interface Widget { key: string; label: string; label_en: string; unit: string; value: number }

/** Consistent loading/error/empty placeholder for the chart cards (whose queries aren't gated by StateView). */
function ChartState({ q, height, empty, loading, failed }: { q: { isLoading: boolean; error: unknown }; height: number; empty: string; loading: string; failed: string }) {
  const msg = q.isLoading ? loading : q.error ? failed : empty;
  return <div className="grid place-items-center text-sm text-muted-foreground" style={{ height }}>{msg}</div>;
}

export default function DashboardPage() {
  const qc = useQueryClient();
  const { t } = useLang();
  // "เรียลไทม์": refresh the headline figures every 60s (and on demand) so the overview stays live.
  const q = useQuery<Dash>({ queryKey: ['dashboard'], queryFn: () => api('/api/dashboard'), refetchInterval: 60_000 });
  const trend = useQuery<Trend>({ queryKey: ['dashboard-trend'], queryFn: () => api('/api/dashboard/sales-trend?days=14') });
  const mine = useQuery<{ role: string; configured: boolean; widgets: Widget[] }>({ queryKey: ['dashboard-mine'], queryFn: () => api('/api/dashboard/layout/me') });
  const d = q.data;

  const refreshing = q.isFetching || trend.isFetching || mine.isFetching;
  const refresh = () => { for (const k of ['dashboard', 'dashboard-trend', 'dashboard-mine']) qc.invalidateQueries({ queryKey: [k] }); };
  // Streaming analytics (docs/22 Phase B): live-refresh the headline figures the instant a KPI snapshot is
  // pushed, instead of waiting for the 60s poll. `connected` drives a live/offline badge.
  const { connected } = useRealtime((e) => { if (e.type === 'kpi_refresh') refresh(); }, { path: '/api/bi/live/stream' });

  const trendData = (trend.data?.trend ?? []).map((r) => ({ ...r, label: thaiDate(r.date) }));
  const topItems = (d?.top_items_today ?? []).slice(0, 6).map((r) => ({ name: r.Item_Description, revenue: r.revenue }));
  const myWidgets = mine.data?.widgets ?? [];

  return (
    <div>
      <PageHeader
        title={t('dash.title')}
        description={t('dash.subtitle')}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={connected ? 'success' : 'muted'} className="gap-1" title={connected ? t('dash.live_tip') : t('dash.offline_tip')}>
              <span className={`inline-block size-1.5 rounded-full ${connected ? 'bg-success animate-pulse' : 'bg-muted-foreground'}`} /> {connected ? t('dash.live') : t('dash.offline')}
            </Badge>
            <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing} aria-label={t('dash.refresh_aria')}>
              <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} /> {t('dash.refresh')}
            </Button>
          </div>
        }
      />

      {/* First-run guidance: surfaces the onboarding checklist right on the landing page for a new tenant,
          deep-linking each pending step. Self-hides once setup is complete or for users without access. */}
      <GettingStarted />

      {/* Action launcher (PEAK-Board style): live, clickable "what needs doing today" counts. Sits above
          the metrics so the landing page leads with tasks, not just numbers. Cards self-hide by permission. */}
      <TodayActions lowStock={d?.low_stock_count} />

      {/* Role-based KPI band — skeleton while it loads so it doesn't pop in under the headline figures */}
      {mine.isLoading ? (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
      ) : myWidgets.length > 0 ? (
        <div className="mb-6">
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('dash.role_kpis')}</h3>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {myWidgets.map((w) => (
              <StatCard key={w.key} label={w.label} value={w.unit === 'baht' ? baht(w.value) : num(w.value)} icon={Gauge} tone="default" hint={w.label_en} />
            ))}
          </div>
        </div>
      ) : null}

      <StateView q={q}>
        {d && (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label={t('dash.today_sales')} value={baht(d.today.sales)} icon={Banknote} tone="primary" hint={t('dash.orders_n', { n: num(d.today.orders) })} />
              <StatCard label={t('dash.month_sales')} value={baht(d.month.sales)} icon={TrendingUp} tone="default" hint={t('dash.orders_n', { n: num(d.month.orders) })} />
              <StatCard label={t('dash.low_stock')} value={num(d.low_stock_count)} icon={Package} tone={d.low_stock_count > 0 ? 'warning' : 'success'} hint={t('dash.need_restock')} />
              <StatCard label={t('dash.outstanding_ap')} value={baht(d.outstanding_ap)} icon={Receipt} tone={d.outstanding_ap > 0 ? 'danger' : 'success'} hint={t('dash.ap_due')} />
            </div>

            <div className="grid gap-4 lg:grid-cols-5">
              <Card className="lg:col-span-3">
                <CardHeader>
                  <CardTitle className="text-base">{t('dash.trend_title')}</CardTitle>
                </CardHeader>
                <CardContent>
                  {trendData.length && !trend.isLoading && !trend.error ? (
                    <div role="img" aria-label={t('dash.trend_aria')}>
                      <TrendAreaChart data={trendData} xKey="label" yKey="sales" fmt={(v) => baht(v)} />
                    </div>
                  ) : (
                    <ChartState q={trend} height={260} empty={t('dash.no_sales_data')} loading={t('dash.loading')} failed={t('dash.load_failed')} />
                  )}
                </CardContent>
              </Card>
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle className="text-base">{t('dash.top_items')}</CardTitle>
                </CardHeader>
                <CardContent>
                  {topItems.length ? (
                    <div role="img" aria-label={t('dash.top_items_aria')}>
                      <SimpleBarChart data={topItems} xKey="name" yKey="revenue" color="var(--chart-2)" fmt={(v) => baht(v)} />
                    </div>
                  ) : (
                    <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">{t('dash.no_sales_today')}</div>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('dash.top_items')}</h3>
                <DataTable
                  rows={d.top_items_today}
                  rowKey={(r, i) => `${r.Item_Description}-${i}`}
                  emptyText={t('dash.no_sales_today')}
                  columns={[
                    { key: 'Item_Description', label: t('dash.col_item') },
                    { key: 'qty', label: t('dash.col_qty'), align: 'right', render: (r) => num(r.qty) },
                    { key: 'revenue', label: t('dash.col_revenue'), align: 'right', render: (r) => <span className="tabular">{baht(r.revenue)}</span> },
                  ]}
                />
              </div>
              <div>
                <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('dash.recent_orders')}</h3>
                <DataTable
                  rows={d.recent_orders}
                  rowKey={(r) => r.Sale_No}
                  emptyText={t('dash.no_orders')}
                  columns={[
                    { key: 'Sale_No', label: t('dash.col_no') },
                    { key: 'Sale_Date', label: t('dash.col_date'), render: (r) => thaiDate(r.Sale_Date) },
                    { key: 'Total', label: t('dash.col_total'), align: 'right', render: (r) => <span className="tabular">{baht(r.Total)}</span> },
                    { key: 'Payment_Method', label: t('dash.col_payment') },
                    { key: 'Status', label: t('dash.col_status'), render: (r) => <Badge variant={statusVariant(r.Status)}>{r.Status}</Badge> },
                  ]}
                />
              </div>
            </div>
          </div>
        )}
      </StateView>
    </div>
  );
}
