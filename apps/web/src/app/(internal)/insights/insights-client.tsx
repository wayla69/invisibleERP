'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Lightbulb, AlertTriangle, PackagePlus, Sparkles, Gauge, TrendingDown } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// ── API contract (apps/api/src/modules/analytics) ─────────────────────────────
interface Prediction {
  item_id: string; item_name: string; uom: string; current_stock: number; avg_daily_sales: number;
  lead_time_days: number; days_of_stock: number | null; predicted_stockout_date: string | null;
  reorder_point: number; urgency: 'critical' | 'warning' | 'ok'; confidence: string;
}
interface ReplResp { items: Prediction[]; count: number; critical: number; warning: number }
interface MovementAnomaly { item_id: string; item_name: string; movement_type: string; recent_qty: number; hist_avg: number; z_score: number; event_count: number; severity: 'critical' | 'warning' }
interface StocktakeVariance { item_id: string; item_name: string; stocktake_date: string | null; expected_qty: number; counted_qty: number; variance: number; variance_pct: number; severity: 'critical' | 'warning' }
interface AnomalyResp {
  movement_anomalies: MovementAnomaly[];
  stocktake_variances: StocktakeVariance[];
  summary: { total_anomalies: number; critical_count: number; warning_count: number; analysis_days: number; generated_at: string };
}
interface SummaryResp {
  replenishment: { critical: number; warning: number; top_items: Prediction[] };
  anomalies: { total_anomalies: number; critical_count: number; warning_count: number; analysis_days: number };
  insight: string;
}

type TFn = (key: string, vars?: Record<string, string | number>) => string;
const urgencyBadge = (u: string, t: TFn) =>
  u === 'critical' ? <Badge variant="destructive">{t('pb.sev_critical')}</Badge> : u === 'warning' ? <Badge variant="warning">{t('pb.sev_warning')}</Badge> : <Badge variant="success">{t('pb.sev_normal')}</Badge>;
const sevBadge = (s: string, t: TFn) => (s === 'critical' ? <Badge variant="destructive">{t('pb.sev_critical')}</Badge> : <Badge variant="warning">{t('pb.sev_warning')}</Badge>);

/** AI insight callout — renders the model's (or rule-based fallback) narrative text. */
function InsightCard({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="flex gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4">
      <Lightbulb className="mt-0.5 size-5 shrink-0 text-primary" />
      <p className="text-sm leading-relaxed whitespace-pre-line">{text}</p>
    </div>
  );
}

export default function InsightsWorkspace({ initialSummary }: { initialSummary?: unknown }) {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('pb.ins_title')}
        description={t('pb.ins_subtitle')}
      />
      <Tabs
        tabs={[
          { key: 'overview', label: t('pb.ins_tab_overview'), content: <OverviewTab initialData={initialSummary} /> },
          { key: 'anomalies', label: t('pb.ins_tab_anomalies'), content: <AnomaliesTab /> },
          { key: 'replenishment', label: t('pb.ins_tab_replenish'), content: <ReplenishmentTab /> },
        ]}
      />
    </div>
  );
}

function OverviewTab({ initialData }: { initialData?: unknown }) {
  const { t } = useLang();
  const q = useQuery<SummaryResp>({ queryKey: ['insights-summary'], queryFn: () => api('/api/analytics/dashboard-summary'), initialData: (initialData as SummaryResp | undefined) ?? undefined });
  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('pb.ins_repl_critical')} value={num(q.data.replenishment.critical)} icon={PackagePlus} tone="danger" />
            <StatCard label={t('pb.ins_repl_warning')} value={num(q.data.replenishment.warning)} tone="warning" />
            <StatCard label={t('pb.ins_anomalies_7d')} value={num(q.data.anomalies.total_anomalies)} icon={AlertTriangle} tone={q.data.anomalies.critical_count ? 'danger' : 'default'} hint={t('pb.ins_critical_n', { n: num(q.data.anomalies.critical_count) })} />
            <StatCard label={t('pb.ins_total_critical')} value={num(q.data.replenishment.critical + q.data.anomalies.critical_count)} icon={Gauge} tone="primary" />
          </div>

          <div>
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground"><Sparkles className="size-4" /> {t('pb.ins_ai_summary')}</h3>
            <InsightCard text={q.data.insight} />
          </div>

          <div>
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('pb.ins_top_replenish')}</h3>
            <DataTable
              rows={q.data.replenishment.top_items}
              rowKey={(r) => r.item_id}
              emptyText={t('pb.ins_empty_repl')}
              columns={[
                { key: 'item_name', label: t('pb.col_product'), render: (r) => <span className="font-medium">{r.item_name}</span> },
                { key: 'current_stock', label: t('pb.ins_col_stock'), align: 'right', render: (r) => <span className="tabular">{num(r.current_stock)} {r.uom}</span> },
                { key: 'days_of_stock', label: t('pb.ins_col_days_left'), align: 'right', render: (r) => <span className="tabular">{r.days_of_stock ?? '—'}</span> },
                { key: 'urgency', label: t('pb.col_level'), render: (r) => urgencyBadge(r.urgency, t) },
              ]}
            />
          </div>
        </div>
      )}
    </StateView>
  );
}

function AnomaliesTab() {
  const { t } = useLang();
  const [days, setDays] = useState(30);
  const q = useQuery<AnomalyResp>({ queryKey: ['insights-anomalies', days], queryFn: () => api(`/api/analytics/anomalies?days=${days}`) });
  const [insight, setInsight] = useState<{ key: string; text: string } | null>(null);

  const askInsight = useMutation({
    mutationFn: (a: MovementAnomaly) =>
      api<{ insight: string }>('/api/analytics/insight', { method: 'POST', body: JSON.stringify({ type: 'anomaly', data: a }) }),
    onSuccess: (r, a) => setInsight({ key: a.item_id + a.movement_type, text: r.insight }),
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {[7, 30, 90].map((d) => (
          <Button key={d} variant={days === d ? 'default' : 'outline'} size="sm" onClick={() => setDays(d)}>
            {t('pb.ins_days_n', { n: d })}
          </Button>
        ))}
      </div>

      <StateView q={q}>
        {q.data && (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label={t('pb.ins_total_anomalies')} value={num(q.data.summary.total_anomalies)} icon={AlertTriangle} tone="primary" />
              <StatCard label={t('pb.ins_critical_level')} value={num(q.data.summary.critical_count)} tone="danger" />
              <StatCard label={t('pb.sev_warning')} value={num(q.data.summary.warning_count)} tone="warning" />
            </div>

            {insight && <InsightCard text={insight.text} />}

            <div>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('pb.ins_movement_anomaly')}</h3>
              <DataTable
                rows={q.data.movement_anomalies}
                rowKey={(r) => r.item_id + r.movement_type}
                emptyState={{ icon: AlertTriangle, title: t('pb.ins_no_movement_title'), description: t('pb.ins_no_movement_desc') }}
                columns={[
                  { key: 'item_name', label: t('pb.col_product'), render: (r) => <span className="font-medium">{r.item_name}</span> },
                  { key: 'movement_type', label: t('pb.col_type'), render: (r) => <Badge variant="info">{r.movement_type}</Badge> },
                  { key: 'recent_qty', label: t('pb.ins_col_recent'), align: 'right', render: (r) => <span className="tabular">{num(r.recent_qty)}</span> },
                  { key: 'hist_avg', label: t('pb.ins_col_hist_avg'), align: 'right', render: (r) => <span className="tabular">{num(r.hist_avg)}</span> },
                  { key: 'z_score', label: 'Z-score', align: 'right', render: (r) => <span className="tabular">{r.z_score}</span> },
                  { key: 'severity', label: t('pb.col_level'), render: (r) => sevBadge(r.severity, t) },
                  {
                    key: '_ai',
                    label: 'AI',
                    sortable: false,
                    render: (r) => (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={askInsight.isPending}
                        onClick={() => askInsight.mutate(r)}
                      >
                        <Sparkles className="size-3.5" /> {t('pb.ins_advice')}
                      </Button>
                    ),
                  },
                ]}
              />
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('pb.ins_stocktake_var')}</h3>
              <DataTable
                rows={q.data.stocktake_variances}
                rowKey={(r) => r.item_id}
                emptyState={{ icon: TrendingDown, title: t('pb.ins_no_var_title'), description: t('pb.ins_no_var_desc') }}
                columns={[
                  { key: 'item_name', label: t('pb.col_product'), render: (r) => <span className="font-medium">{r.item_name}</span> },
                  { key: 'stocktake_date', label: t('pb.ins_col_count_date'), render: (r) => thaiDate(r.stocktake_date) },
                  { key: 'expected_qty', label: t('pb.ins_col_system'), align: 'right', render: (r) => <span className="tabular">{num(r.expected_qty)}</span> },
                  { key: 'counted_qty', label: t('pb.ins_col_counted'), align: 'right', render: (r) => <span className="tabular">{num(r.counted_qty)}</span> },
                  { key: 'variance', label: t('pb.col_variance'), align: 'right', render: (r) => <span className="tabular">{num(r.variance)}</span> },
                  { key: 'variance_pct', label: '%', align: 'right', render: (r) => <span className="tabular">{r.variance_pct}%</span> },
                  { key: 'severity', label: t('pb.col_level'), render: (r) => sevBadge(r.severity, t) },
                ]}
              />
            </div>
          </>
        )}
      </StateView>
    </div>
  );
}

function ReplenishmentTab() {
  const { t } = useLang();
  const q = useQuery<ReplResp>({ queryKey: ['insights-repl'], queryFn: () => api('/api/analytics/replenishment?limit=100') });
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="space-y-5">
      <StateView q={q}>
        {q.data && (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label={t('pb.ins_repl_count')} value={num(q.data.count)} icon={PackagePlus} tone="primary" />
            <StatCard label={t('pb.ins_urgent_critical')} value={num(q.data.critical)} tone="danger" />
            <StatCard label={t('pb.sev_warning')} value={num(q.data.warning)} tone="warning" />
          </div>
        )}
      </StateView>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.items}
            rowKey={(r) => r.item_id}
            onRowClick={(r) => setSelected((id) => (id === r.item_id ? null : r.item_id))}
            emptyState={{ icon: PackagePlus, title: t('pb.ins_empty_repl2_title'), description: t('pb.ins_empty_repl2_desc') }}
            columns={[
              { key: 'item_name', label: t('pb.col_product'), render: (r) => <span className="font-medium">{r.item_name}</span> },
              { key: 'current_stock', label: t('pb.ins_col_stock'), align: 'right', render: (r) => <span className="tabular">{num(r.current_stock)} {r.uom}</span> },
              { key: 'avg_daily_sales', label: t('pb.ins_col_avg_daily'), align: 'right', render: (r) => <span className="tabular">{num(r.avg_daily_sales)}</span> },
              { key: 'days_of_stock', label: t('pb.ins_col_days_left'), align: 'right', render: (r) => <span className="tabular">{r.days_of_stock ?? '—'}</span> },
              { key: 'lead_time_days', label: 'Lead time', align: 'right', render: (r) => <span className="tabular">{num(r.lead_time_days)}</span> },
              { key: 'reorder_point', label: t('pb.ins_col_reorder'), align: 'right', render: (r) => <span className="tabular">{num(r.reorder_point)}</span> },
              { key: 'predicted_stockout_date', label: t('pb.ins_col_stockout'), render: (r) => thaiDate(r.predicted_stockout_date) },
              { key: 'urgency', label: t('pb.col_level'), render: (r) => urgencyBadge(r.urgency, t) },
            ]}
          />
        )}
      </StateView>

      {selected && <ReplItemDetail itemId={selected} />}
    </div>
  );
}

function ReplItemDetail({ itemId }: { itemId: string }) {
  const { t } = useLang();
  const q = useQuery<Prediction & { insight: string }>({
    queryKey: ['insights-repl-item', itemId],
    queryFn: () => api(`/api/analytics/replenishment/${encodeURIComponent(itemId)}`),
  });
  return (
    <Card className="gap-4 border-primary/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4" /> {t('pb.ins_repl_advice', { name: q.data?.item_name ?? itemId })}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <StateView q={q}>
          {q.data && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard label={t('pb.ins_col_stock')} value={`${num(q.data.current_stock)} ${q.data.uom}`} tone="primary" />
                <StatCard label={t('pb.ins_col_avg_daily')} value={num(q.data.avg_daily_sales)} />
                <StatCard label={t('pb.ins_col_reorder')} value={num(q.data.reorder_point)} tone="warning" />
                <StatCard label={t('pb.ins_col_stockout')} value={q.data.predicted_stockout_date ? thaiDate(q.data.predicted_stockout_date) : '—'} tone={q.data.urgency === 'critical' ? 'danger' : 'default'} />
              </div>
              <InsightCard text={q.data.insight} />
            </div>
          )}
        </StateView>
      </CardContent>
    </Card>
  );
}
