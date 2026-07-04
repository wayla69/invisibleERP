'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Banknote, Bell, CalendarDays, Package, Receipt, ReceiptText, Target, TrendingUp, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StateView } from '@/components/state-view';
import { DataTable } from '@/components/data-table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TrendAreaChart, SimpleBarChart } from '@/components/charts';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';

interface Kpi {
  as_of: string;
  sales: { mtd: number; mtd_orders: number; ytd: number; avg_order_mtd: number };
  receivables: { open_ar: number; overdue_ar: number; overdue_count: number };
  payables: { open_ap: number };
  pipeline: { open_value: number; weighted_value: number; open_count: number };
}
interface SalesCube {
  period_type: string; start: string; end: string;
  rows: { period: string; total_sales: number; total_orders: number; avg_order: number; total_tax: number }[];
  totals: { total_sales: number; total_orders: number };
}
interface FinanceTrend {
  months: number;
  trend: { period: string; revenue: number; expense: number; gross_profit: number; margin_pct: number }[];
}
interface PipelineTrend {
  months: number;
  trend: { month: string; open: number; won: number; lost: number; open_value: number; won_value: number; total_created: number; win_rate_pct: number }[];
}
interface Snapshots {
  start: string; end: string;
  snapshots: { date: string; total_sales: number; total_orders: number; avg_order_value: number; open_ar: number; open_ap: number; pipeline_value: number; weighted_pipeline: number }[];
  count: number;
}
interface TopItems {
  start: string; end: string;
  items: { item_id: string; item_description: string; qty: number; revenue: number; tx_count: number }[];
  count: number;
}
interface AlertEvents {
  events: { id: number; rule_id: number | null; name: string; metric: string; value: number; threshold: number; severity: string; channel: string; message: string; fired_at: string }[];
}
interface AlertMetrics {
  metrics: { key: string; label: string; label_en: string; unit: string }[];
  operators: string[];
  channels: string[];
}

const SEVERITY_CLASS: Record<string, string> = {
  info: 'bg-blue-100 text-blue-800',
  warning: 'bg-yellow-100 text-yellow-800',
  critical: 'bg-red-100 text-red-800',
};

const OP_LABELS: Record<string, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=' };

function monthBounds(yyyymmdd: string): { start: string; end: string } {
  const parts = yyyymmdd.split('-').map(Number);
  const y = parts[0], m = parts[1];
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const end = new Date(y, m, 0).toISOString().slice(0, 10);
  return { start, end };
}

const EMPTY_FORM = { name: '', metric: '', operator: 'gte', threshold: '', severity: 'warning' };

export default function BiPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [drillPeriod, setDrillPeriod] = useState<{ start: string; end: string; label: string } | null>(null);
  const [alertDialogOpen, setAlertDialogOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  const kpi = useQuery<Kpi>({ queryKey: ['bi-kpi'], queryFn: () => api('/api/bi/kpi') });
  const cube = useQuery<SalesCube>({ queryKey: ['bi-cube'], queryFn: () => api('/api/bi/sales-cube?period=month&months=6') });
  const finance = useQuery<FinanceTrend>({ queryKey: ['bi-finance'], queryFn: () => api('/api/bi/finance-trend?months=6') });
  const pipeline = useQuery<PipelineTrend>({ queryKey: ['bi-pipeline'], queryFn: () => api('/api/bi/pipeline-trend?months=6') });
  const snaps = useQuery<Snapshots>({ queryKey: ['bi-snapshots'], queryFn: () => api('/api/bi/snapshots?days=30') });
  const alertEvents = useQuery<AlertEvents>({ queryKey: ['alert-events'], queryFn: () => api('/api/alerts/events?limit=5'), refetchInterval: 120_000 });
  const alertMetrics = useQuery<AlertMetrics>({ queryKey: ['alert-metrics'], queryFn: () => api('/api/alerts/metrics') });
  const topItems = useQuery<TopItems>({
    queryKey: ['bi-top-items', drillPeriod?.start, drillPeriod?.end],
    queryFn: () => api(`/api/bi/sales-cube/top-items?start=${drillPeriod!.start}&end=${drillPeriod!.end}&limit=20`),
    enabled: drillPeriod !== null,
  });

  const createAlert = useMutation<unknown, Error, typeof EMPTY_FORM>({
    mutationFn: (body) => api('/api/alerts/rules', { method: 'POST', body: JSON.stringify({ name: body.name, metric: body.metric, operator: body.operator, threshold: Number(body.threshold), severity: body.severity, channel: 'notification' }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['alert-events'] }); setAlertDialogOpen(false); setForm(EMPTY_FORM); },
  });

  const k = kpi.data;
  const cubeData = (cube.data?.rows ?? []).map((r) => ({ ...r, label: r.period.slice(0, 7) }));
  const financeData = (finance.data?.trend ?? []).map((r) => ({ ...r, label: r.period }));
  const pipelineData = pipeline.data?.trend ?? [];

  function handleBarClick(entry: any) {
    const bounds = monthBounds(entry.period as string);
    setDrillPeriod({ ...bounds, label: entry.label as string });
  }

  return (
    <div>
      <PageHeader
        title="BI Analytics"
        description={t('pb.bi_subtitle')}
        actions={
          <Button size="sm" variant="outline" onClick={() => setAlertDialogOpen(true)}>
            <Bell className="mr-2 h-4 w-4" />
            {t('pb.bi_create_alert')}
          </Button>
        }
      />

      <div className="space-y-6">
        <StateView q={kpi}>
          {k && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label={t('pb.bi_sales_mtd')} value={baht(k.sales.mtd)} icon={Banknote} tone="primary" hint={t('pb.bi_orders_n', { n: num(k.sales.mtd_orders) })} />
              <StatCard label={t('pb.bi_sales_ytd')} value={baht(k.sales.ytd)} icon={TrendingUp} tone="default" hint={t('pb.bi_avg_per_order', { v: baht(k.sales.avg_order_mtd) })} />
              <StatCard label={t('pb.bi_open_ar')} value={baht(k.receivables.open_ar)} icon={ReceiptText} tone={k.receivables.overdue_ar > 0 ? 'warning' : 'default'} hint={t('pb.bi_overdue_hint', { v: baht(k.receivables.overdue_ar), n: num(k.receivables.overdue_count) })} />
              <StatCard label={t('pb.bi_open_ap')} value={baht(k.payables.open_ap)} icon={Receipt} tone={k.payables.open_ap > 0 ? 'danger' : 'success'} hint={t('pb.bi_outstanding')} />
            </div>
          )}
        </StateView>

        <StateView q={kpi}>
          {k && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <StatCard label={t('pb.bi_pipeline_open')} value={baht(k.pipeline.open_value)} icon={Target} tone="info" hint={t('pb.bi_deals_n', { n: num(k.pipeline.open_count) })} />
              <StatCard label={t('pb.bi_pipeline_weighted')} value={baht(k.pipeline.weighted_value)} icon={Wallet} tone="info" hint={t('pb.bi_weighted_hint')} />
              <StatCard label={t('pb.bi_avg_order_mtd')} value={baht(k.sales.avg_order_mtd)} icon={TrendingUp} tone="default" hint={t('pb.bi_as_of', { d: thaiDate(k.as_of) })} />
            </div>
          )}
        </StateView>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('pb.bi_finance_trend')}</CardTitle>
            </CardHeader>
            <CardContent>
              <StateView q={finance}>
                {financeData.length ? (
                  <TrendAreaChart data={financeData} xKey="label" yKey="revenue" fmt={(v) => baht(v)} />
                ) : (
                  <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">{t('pb.bi_no_finance')}</div>
                )}
              </StateView>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {t('pb.bi_sales_cube')}
                <span className="ml-2 text-xs font-normal text-muted-foreground">{t('pb.bi_click_bar')}</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <StateView q={cube}>
                {cubeData.length ? (
                  <SimpleBarChart data={cubeData} xKey="label" yKey="total_sales" color="var(--chart-2)" fmt={(v) => baht(v)} onBarClick={handleBarClick} />
                ) : (
                  <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">{t('pb.bi_no_sales')}</div>
                )}
              </StateView>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-5">
          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle className="text-base">{t('pb.bi_pipeline_trend')}</CardTitle>
            </CardHeader>
            <CardContent>
              <StateView q={pipeline}>
                {pipelineData.length ? (
                  <SimpleBarChart data={pipelineData} xKey="month" yKey="open_value" color="var(--chart-3)" fmt={(v) => baht(v)} />
                ) : (
                  <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">{t('pb.bi_no_deals')}</div>
                )}
              </StateView>
            </CardContent>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">{t('pb.bi_pipeline_summary')}</CardTitle>
            </CardHeader>
            <CardContent>
              <StateView q={pipeline}>
                <DataTable
                  rows={pipelineData}
                  dense
                  columns={[
                    { key: 'month', label: t('pb.bi_col_month') },
                    { key: 'open', label: t('pb.bi_col_open'), align: 'right', render: (r) => num(r.open) },
                    { key: 'won', label: t('pb.bi_col_won'), align: 'right', render: (r) => num(r.won) },
                    { key: 'win_rate_pct', label: t('pb.bi_col_win_rate'), align: 'right', render: (r) => `${num(r.win_rate_pct)}%` },
                  ]}
                  emptyState={{ icon: Target, title: t('pb.bi_empty_pipeline_title'), description: t('pb.bi_empty_pipeline_desc') }}
                />
              </StateView>
            </CardContent>
          </Card>
        </div>

        {/* KPI Alert Events */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertCircle className="h-4 w-4 text-muted-foreground" />
              {t('pb.bi_recent_alerts')}
            </CardTitle>
            <Button size="sm" variant="outline" onClick={() => setAlertDialogOpen(true)}>
              <Bell className="mr-2 h-3.5 w-3.5" />
              {t('pb.bi_new_rule')}
            </Button>
          </CardHeader>
          <CardContent>
            <StateView q={alertEvents}>
              {(alertEvents.data?.events ?? []).length === 0 ? (
                <div className="grid h-24 place-items-center text-sm text-muted-foreground">{t('pb.bi_no_fired_alerts')}</div>
              ) : (
                <DataTable
                  rows={alertEvents.data?.events ?? []}
                  dense
                  columns={[
                    { key: 'name', label: t('pb.bi_col_rule'), render: (r) => <span className="font-medium">{r.name}</span> },
                    { key: 'metric', label: t('pb.bi_col_metric'), render: (r) => <span className="text-xs text-muted-foreground">{r.metric}</span> },
                    { key: 'value', label: t('pb.bi_col_value'), align: 'right', render: (r) => <span className="tabular-nums">{num(r.value)}</span> },
                    { key: 'severity', label: t('pb.bi_col_severity'), render: (r) => <Badge className={SEVERITY_CLASS[r.severity] ?? ''}>{r.severity}</Badge> },
                    { key: 'fired_at', label: t('pb.bi_col_time'), render: (r) => <span className="text-xs text-muted-foreground">{thaiDate(r.fired_at?.slice(0, 10))}</span> },
                  ]}
                  emptyState={{ icon: Bell, title: t('pb.bi_empty_alerts_title'), description: '' }}
                />
              )}
            </StateView>
          </CardContent>
        </Card>

        <div>
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('pb.bi_daily_snapshots')}</h3>
          <StateView q={snaps}>
            <DataTable
              rows={snaps.data?.snapshots ?? []}
              columns={[
                { key: 'date', label: t('dash.col_date'), render: (r) => thaiDate(r.date) },
                { key: 'total_sales', label: t('pb.col_sales'), align: 'right', render: (r) => <span className="tabular">{baht(r.total_sales)}</span> },
                { key: 'total_orders', label: t('pb.col_orders'), align: 'right', render: (r) => num(r.total_orders) },
                { key: 'open_ar', label: t('pb.bi_col_ar'), align: 'right', render: (r) => <span className="tabular">{baht(r.open_ar)}</span> },
                { key: 'open_ap', label: t('pb.bi_col_ap'), align: 'right', render: (r) => <span className="tabular">{baht(r.open_ap)}</span> },
                { key: 'pipeline_value', label: t('pb.bi_col_pipeline'), align: 'right', render: (r) => <span className="tabular">{baht(r.pipeline_value)}</span> },
              ]}
              emptyState={{ icon: CalendarDays, title: t('pb.bi_empty_snap_title'), description: t('pb.bi_empty_snap_desc') }}
            />
          </StateView>
        </div>
      </div>

      {/* Sales Cube Drill-down Sheet */}
      <Sheet open={drillPeriod !== null} onOpenChange={(o) => { if (!o) setDrillPeriod(null); }}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t('pb.bi_top_products', { label: drillPeriod?.label ?? '' })}</SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            <StateView q={topItems}>
              <DataTable
                rows={topItems.data?.items ?? []}
                columns={[
                  { key: 'item_description', label: t('pb.col_product'), render: (r) => <span className="font-medium">{r.item_description}</span> },
                  { key: 'qty', label: t('pb.bi_col_qty'), align: 'right', render: (r) => <span className="tabular-nums">{num(r.qty)}</span> },
                  { key: 'revenue', label: t('pb.bi_col_revenue'), align: 'right', render: (r) => <span className="tabular-nums">{baht(r.revenue)}</span> },
                  { key: 'tx_count', label: t('pb.bi_col_bills'), align: 'right', render: (r) => num(r.tx_count) },
                ]}
                emptyState={{ icon: Package, title: t('pb.bi_empty_items_title'), description: t('pb.bi_empty_items_desc') }}
              />
            </StateView>
          </div>
        </SheetContent>
      </Sheet>

      {/* Create KPI Alert Dialog */}
      <Dialog open={alertDialogOpen} onOpenChange={(o) => { if (!o) { setAlertDialogOpen(false); setForm(EMPTY_FORM); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('pb.bi_alert_dialog_title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label>{t('pb.bi_label_rule_name')}</Label>
              <Input placeholder={t('pb.bi_ph_rule_name')} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>{t('pb.bi_col_metric')}</Label>
              <Select value={form.metric} onValueChange={(v) => setForm((f) => ({ ...f, metric: v }))}>
                <SelectTrigger><SelectValue placeholder={t('pb.bi_ph_metric')} /></SelectTrigger>
                <SelectContent>
                  {(alertMetrics.data?.metrics ?? []).map((m) => (
                    <SelectItem key={m.key} value={m.key}>{m.label} ({m.unit})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label>{t('pb.bi_label_operator')}</Label>
                <Select value={form.operator} onValueChange={(v) => setForm((f) => ({ ...f, operator: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(alertMetrics.data?.operators ?? ['gt', 'gte', 'lt', 'lte', 'eq']).map((op) => (
                      <SelectItem key={op} value={op}>{OP_LABELS[op] ?? op}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{t('pb.bi_label_threshold')}</Label>
                <Input type="number" placeholder="0" value={form.threshold} onChange={(e) => setForm((f) => ({ ...f, threshold: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t('pb.bi_label_severity')}</Label>
              <Select value={form.severity} onValueChange={(v) => setForm((f) => ({ ...f, severity: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="info">{t('pb.bi_sev_info')}</SelectItem>
                  <SelectItem value="warning">{t('pb.bi_sev_warning')}</SelectItem>
                  <SelectItem value="critical">{t('pb.bi_sev_critical')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAlertDialogOpen(false); setForm(EMPTY_FORM); }}>{t('fin.cancel')}</Button>
            <Button
              disabled={!form.name || !form.metric || !form.threshold || createAlert.isPending}
              onClick={() => createAlert.mutate(form)}
            >
              {createAlert.isPending ? t('pb.saving') : t('fin.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
