'use client';

import { useState } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { BarChart3, Clock, ShieldAlert, Users, TrendingUp, Soup } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { SimpleBarChart } from '@/components/charts';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { useLang } from '@/lib/i18n';

// Business-day (Asia/Bangkok) today, as YYYY-MM-DD.
function bkkToday(): string {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
const pct = (v: unknown) => `${Number(v ?? 0).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;

const QUADRANT: Record<string, 'success' | 'warning' | 'info' | 'muted'> = {
  Star: 'success', Plowhorse: 'warning', Puzzle: 'info', Dog: 'muted',
};
const AVAIL: Record<string, 'success' | 'warning' | 'destructive' | 'muted'> = {
  ok: 'success', low: 'warning', out: 'destructive', unknown: 'muted',
};

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="mb-4 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]">{children}</div>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="gap-3 p-4">
      <h3 className="text-sm font-semibold text-muted-foreground">{title}</h3>
      {children}
    </Card>
  );
}

export default function RestaurantAnalyticsPage() {
  const { t } = useLang();
  const [from, setFrom] = useState(bkkToday());
  const [to, setTo] = useState(bkkToday());
  const win = `from=${from}&to=${to}`;
  const useReport = <T,>(key: string, url: string): UseQueryResult<T> =>
    useQuery<T>({ queryKey: [key, from, to], queryFn: () => api<T>(url) });

  return (
    <div>
      <PageHeader
        title={t('mf.ra_title')}
        description={t('mf.ra_desc')}
        actions={
          <div className="flex items-end gap-2">
            <div className="grid gap-1"><Label htmlFor="from" className="text-xs">{t('mf.from')}</Label><Input id="from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="h-9 w-40" /></div>
            <div className="grid gap-1"><Label htmlFor="to" className="text-xs">{t('mf.to')}</Label><Input id="to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="h-9 w-40" /></div>
          </div>
        }
      />
      <Tabs
        tabs={[
          { key: 'menu', label: 'Menu engineering', content: <MenuEngineering url={`/api/analytics/menu-engineering?${win}`} /> },
          { key: 'daypart', label: t('mf.ra_tab_daypart'), content: <Daypart url={`/api/analytics/daypart?${win}`} /> },
          { key: 'voids', label: t('mf.ra_tab_voids'), content: <Voids url={`/api/analytics/voids-discounts?${win}`} /> },
          { key: 'staff', label: t('mf.ra_tab_staff'), content: <Staff url={`/api/analytics/staff-performance?${win}`} /> },
          { key: 'trend', label: t('mf.ra_tab_trend'), content: <Trend url={`/api/analytics/sales-trend?${win}`} /> },
          { key: 'avail', label: t('mf.ra_tab_avail'), content: <Availability /> },
        ]}
      />
    </div>
  );

  // ── Menu engineering matrix ──
  function MenuEngineering({ url }: { url: string }) {
    const q = useReport<any>('me', url);
    return (
      <StateView q={q}>
        {q.data && (
          <>
            <Grid>
              <StatCard label={t('mf.ra_items_sold')} value={num(q.data.summary.items)} icon={BarChart3} />
              <StatCard label={t('mf.ra_units_sold')} value={num(q.data.summary.units_sold)} />
              <StatCard label={t('mf.ra_total_contribution')} value={baht(q.data.summary.total_contribution)} tone="success" />
              <StatCard label="⭐ Star" value={num(q.data.summary.stars)} tone="success" />
              <StatCard label="🐴 Plowhorse" value={num(q.data.summary.plowhorses)} tone="warning" />
              <StatCard label="❓ Puzzle / 🐶 Dog" value={`${num(q.data.summary.puzzles)} / ${num(q.data.summary.dogs)}`} tone="info" />
            </Grid>
            <Section title={t('mf.ra_me_section')}>
              <DataTable
                rows={q.data.items}
                rowKey={(r: any) => r.item_id}
                emptyState={{ icon: BarChart3, title: t('mf.ra_me_empty_title'), description: t('mf.ra_adjust_dates') }}
                columns={[
                  { key: 'name', label: t('mf.col_dish') },
                  { key: 'quadrant', label: t('mf.ra_col_group'), render: (r: any) => <Badge variant={QUADRANT[r.quadrant] ?? 'muted'}>{r.quadrant_th} ({r.quadrant})</Badge> },
                  { key: 'qty', label: t('mf.ra_col_sold'), align: 'right', render: (r: any) => num(r.qty) },
                  { key: 'mix_share', label: t('mf.ra_col_share'), align: 'right', render: (r: any) => pct(Number(r.mix_share) * 100) },
                  { key: 'unit_margin', label: t('mf.ra_col_margin_per_dish'), align: 'right', render: (r: any) => baht(r.unit_margin) },
                  { key: 'contribution', label: t('mf.ra_col_total_margin'), align: 'right', render: (r: any) => baht(r.contribution) },
                  { key: 'action', label: t('mf.ra_col_advice'), render: (r: any) => <span className="text-xs text-muted-foreground">{r.action_th}</span> },
                ]}
              />
            </Section>
          </>
        )}
      </StateView>
    );
  }

  // ── Daypart / busiest hours ──
  function Daypart({ url }: { url: string }) {
    const q = useReport<any>('daypart', url);
    return (
      <StateView q={q}>
        {q.data && (
          <>
            <Grid>
              <StatCard label={t('mf.ra_revenue')} value={baht(q.data.summary.revenue)} tone="success" icon={Clock} />
              <StatCard label={t('mf.ra_txn_count')} value={num(q.data.summary.txns)} />
              <StatCard label={t('mf.ra_avg_ticket')} value={baht(q.data.summary.avg_ticket)} />
              <StatCard label={t('mf.ra_peak_hour')} value={q.data.summary.peak_hour != null ? `${q.data.summary.peak_hour}:00` : '—'} tone="info" />
              <StatCard label={t('mf.ra_peak_daypart')} value={q.data.by_daypart.find((d: any) => d.daypart === q.data.summary.peak_daypart)?.label_th ?? '—'} tone="info" />
            </Grid>
            <Section title={t('mf.ra_hourly_sales')}>
              <SimpleBarChart data={q.data.by_hour.filter((h: any) => h.revenue > 0)} xKey="hour" yKey="revenue" fmt={(v) => baht(v)} />
            </Section>
            <Section title={t('mf.ra_by_daypart')}>
              <DataTable
                rows={q.data.by_daypart}
                rowKey={(r: any) => r.daypart}
                emptyState={{ icon: Clock, title: t('mf.ra_no_sales_title'), description: t('mf.ra_adjust_dates') }}
                columns={[
                  { key: 'label_th', label: t('mf.ra_col_period') },
                  { key: 'revenue', label: t('mf.ra_revenue'), align: 'right', render: (r: any) => baht(r.revenue) },
                  { key: 'txns', label: t('mf.ra_col_bills'), align: 'right', render: (r: any) => num(r.txns) },
                  { key: 'avg_ticket', label: t('mf.ra_avg_ticket'), align: 'right', render: (r: any) => baht(r.avg_ticket) },
                ]}
              />
            </Section>
          </>
        )}
      </StateView>
    );
  }

  // ── Voids / discounts ──
  function Voids({ url }: { url: string }) {
    const q = useReport<any>('voids', url);
    return (
      <StateView q={q}>
        {q.data && (
          <>
            <Grid>
              <StatCard label={t('mf.ra_events')} value={num(q.data.summary.events)} icon={ShieldAlert} />
              <StatCard label={t('mf.ra_void_count')} value={num(q.data.summary.void_count)} tone="danger" />
              <StatCard label={t('mf.ra_void_rate')} value={pct(q.data.summary.void_rate_pct)} tone="warning" />
              <StatCard label={t('mf.ra_total_discount')} value={baht(q.data.summary.discount_amount)} />
            </Grid>
            <Section title={t('mf.ra_by_reason_title')}>
              <DataTable rows={q.data.by_reason} rowKey={(r: any, i) => r.reason_code + i} emptyState={{ icon: ShieldAlert, title: t('mf.ra_no_voids_title'), description: t('mf.ra_adjust_dates2') }} columns={[
                { key: 'reason_code', label: t('mf.ra_col_reason') },
                { key: 'count', label: t('mf.ra_col_times'), align: 'right', render: (r: any) => num(r.count) },
                { key: 'amount', label: t('mf.ra_col_value'), align: 'right', render: (r: any) => baht(r.amount) },
              ]} />
            </Section>
            <Section title={t('mf.ra_by_staff_title')}>
              <DataTable rows={q.data.by_actor} rowKey={(r: any, i) => r.requested_by + i} emptyState={{ icon: ShieldAlert, title: t('mf.ra_no_voids_title'), description: t('mf.ra_adjust_dates2') }} columns={[
                { key: 'requested_by', label: t('mf.ra_tab_staff') },
                { key: 'count', label: t('mf.ra_col_times'), align: 'right', render: (r: any) => num(r.count) },
                { key: 'amount', label: t('mf.ra_col_value'), align: 'right', render: (r: any) => baht(r.amount) },
              ]} />
            </Section>
          </>
        )}
      </StateView>
    );
  }

  // ── Staff performance ──
  function Staff({ url }: { url: string }) {
    const q = useReport<any>('staff', url);
    return (
      <StateView q={q}>
        {q.data && (
          <>
            <Grid>
              <StatCard label={t('mf.ra_tab_staff')} value={num(q.data.summary.staff)} icon={Users} />
              <StatCard label={t('mf.ra_total_revenue')} value={baht(q.data.summary.revenue)} tone="success" />
              <StatCard label={t('mf.ra_txn_count')} value={num(q.data.summary.sales)} />
            </Grid>
            <Section title={t('mf.ra_staff_perf')}>
              <DataTable rows={q.data.staff} rowKey={(r: any) => r.staff} emptyState={{ icon: Users, title: t('mf.ra_no_staff_title'), description: t('mf.ra_adjust_dates') }} columns={[
                { key: 'staff', label: t('mf.ra_tab_staff') },
                { key: 'sales', label: t('mf.ra_col_bills'), align: 'right', render: (r: any) => num(r.sales) },
                { key: 'revenue', label: t('mf.ra_revenue'), align: 'right', render: (r: any) => baht(r.revenue) },
                { key: 'avg_ticket', label: t('mf.ra_avg_ticket'), align: 'right', render: (r: any) => baht(r.avg_ticket) },
                { key: 'voids', label: t('mf.ra_col_voids'), align: 'right', render: (r: any) => `${num(r.voids)} (${baht(r.void_amount)})` },
                { key: 'discounts', label: t('mf.ra_col_discounts'), align: 'right', render: (r: any) => `${num(r.discounts)} (${baht(r.discount_amount)})` },
              ]} />
            </Section>
          </>
        )}
      </StateView>
    );
  }

  // ── Sales trend vs prior window ──
  function Trend({ url }: { url: string }) {
    const q = useReport<any>('trend', url);
    return (
      <StateView q={q}>
        {q.data && (
          <Grid>
            <StatCard
              label={t('mf.ra_revenue_current')}
              value={baht(q.data.current.revenue)}
              icon={TrendingUp}
              tone="success"
              trend={{ value: pct(q.data.revenue_delta_pct), direction: Number(q.data.revenue_delta) >= 0 ? 'up' : 'down' }}
              hint={t('mf.ra_prev_window', { amt: baht(q.data.previous.revenue), from: q.data.previous.from, to: q.data.previous.to })}
            />
            <StatCard label={t('mf.ra_txn_count')} value={num(q.data.current.txns)} hint={t('mf.ra_vs_prev', { delta: `${q.data.txn_delta >= 0 ? '+' : ''}${num(q.data.txn_delta)}` })} />
            <StatCard label={t('mf.ra_avg_ticket')} value={baht(q.data.current.avg_ticket)} hint={t('mf.ra_vs_prev', { delta: `${q.data.avg_ticket_delta >= 0 ? '+' : ''}${baht(q.data.avg_ticket_delta)}` })} />
            <StatCard label={t('mf.ra_window')} value={t('mf.days', { n: q.data.window_days })} />
          </Grid>
        )}
      </StateView>
    );
  }

  // ── Menu availability forecast (servings remaining) ── (current stock, not date-windowed)
  function Availability() {
    const q = useQuery<any>({ queryKey: ['availability'], queryFn: () => api('/api/menu/availability/forecast?low=5') });
    return (
      <StateView q={q}>
        {q.data && (
          <>
            <Grid>
              <StatCard label={t('mf.ra_dishes_with_recipe')} value={num(q.data.summary.dishes)} icon={Soup} />
              <StatCard label={t('mf.ra_out')} value={num(q.data.summary.out)} tone="danger" />
              <StatCard label={t('mf.ra_low')} value={num(q.data.summary.low)} tone="warning" />
              <StatCard label={t('mf.available')} value={num(q.data.summary.ok)} tone="success" />
              <StatCard label={t('mf.ra_low_ingredients')} value={num(q.data.summary.low_ingredients)} tone="warning" />
            </Grid>
            <Section title={t('mf.ra_servings_section')}>
              <DataTable rows={q.data.items} rowKey={(r: any) => r.sku} emptyState={{ icon: Soup, title: t('mf.ra_no_recipe_title'), description: t('mf.ra_no_recipe_desc') }} columns={[
                { key: 'name', label: t('mf.col_dish') },
                { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={AVAIL[r.status] ?? 'muted'}>{r.status}</Badge> },
                { key: 'servings_left', label: t('mf.ra_col_servings_left'), align: 'right', render: (r: any) => (r.servings_left == null ? '—' : num(r.servings_left)) },
                { key: 'limiting', label: t('mf.ra_col_limiting'), render: (r: any) => r.limiting_ingredient ? `${r.limiting_ingredient.description ?? r.limiting_ingredient.item_id} (${num(r.limiting_ingredient.stock)})` : '—' },
              ]} />
            </Section>
            {q.data.low_ingredients.length > 0 && (
              <Section title={t('mf.ra_low_ing_section')}>
                <DataTable rows={q.data.low_ingredients} rowKey={(r: any) => r.item_id} columns={[
                  { key: 'description', label: t('mf.col_material'), render: (r: any) => r.description ?? r.item_id },
                  { key: 'stock', label: t('mf.col_stock'), align: 'right', render: (r: any) => num(r.stock) },
                  { key: 'reorder_point', label: t('mf.ra_col_reorder'), align: 'right', render: (r: any) => num(r.reorder_point) },
                ]} />
              </Section>
            )}
          </>
        )}
      </StateView>
    );
  }
}
