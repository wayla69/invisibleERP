'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { LineChart, FlaskConical, History, Target, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLang } from '@/lib/i18n';
import { Select } from '@/components/form-controls';
import { BranchPlansTab, OrderPlansTab, ScenarioTab, SpikesTab } from '@/components/scm/plan-tabs';

// ── API contract (apps/api/src/modules/demand-ml) ─────────────────────────────
interface Metrics { algorithm: string; wape: number; mase: number; rmse: number; bias: number; n_test: number }
interface ForecastResp {
  item_id: string; algorithm: string; selected_by: string; horizon: number; data_days: number;
  forecast: number[]; metrics: Metrics; candidates: Metrics[];
}
interface BacktestResp { item_id: string; data_days: number; test_size: number; candidates: Metrics[]; best: Metrics }
interface ForecastRow {
  itemId: string; algorithm: string; selectedBy: string; horizon: number; dataDays: number;
  wape: number; mase: number; rmse: number; bias: number; createdBy: string | null; createdAt: string;
}
interface AccuracyResp { runs: number; avg_wape: number | null; avg_mase: number | null; by_algorithm: { algorithm: string; runs: number; avg_wape: number | null }[] }

const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

// Mirrors apps/api/src/modules/demand-ml/forecast-algorithms.ts ALGOS keys exactly.
const ALGOS = ['', 'sma', 'ses', 'holt', 'seasonal_naive', 'croston', 'croston_sba', 'dow_seasonal', 'th_holiday', 'weather'];

export default function DemandPage() {
  const { t } = useLang();
  const me = useQuery<{ permissions?: string[]; role?: string }>({
    queryKey: ['me'],
    queryFn: () => api('/api/auth/me'),
    staleTime: 60_000,
  });
  // Only render the approve/reject pair for a holder of the checker duty. The server enforces it
  // regardless (permission guard + maker ≠ checker), so this only avoids showing a dead button.
  const canApprove = me.data?.role === 'Admin' || !!me.data?.permissions?.includes('scm_approve');

  return (
    <div>
      <PageHeader
        title={t('mf.dem_title')}
        description={t('mf.dem_desc')}
      />
      <Tabs
        tabs={[
          // docs/54 — supply-chain planning rides the existing demand workspace rather than a new
          // route: same audience, same data lineage, and it keeps the nav from growing another entry.
          { key: 'branch-plans', label: t('scm.tab_branch_plans'), content: <BranchPlansTab /> },
          { key: 'order-plans', label: t('scm.tab_order_plans'), content: <OrderPlansTab canApprove={canApprove} /> },
          { key: 'scenario', label: t('scm.tab_scenario'), content: <ScenarioTab /> },
          { key: 'spikes', label: t('scm.tab_spikes'), content: <SpikesTab /> },
          { key: 'forecast', label: t('mf.dem_tab_forecast'), content: <ForecastTab /> },
          { key: 'backtest', label: t('mf.dem_tab_backtest'), content: <BacktestTab /> },
          { key: 'history', label: t('mf.dem_tab_history'), content: <HistoryTab /> },
        ]}
      />
    </div>
  );
}

function MetricsTable({ rows, best }: { rows: Metrics[]; best?: string }) {
  const { t } = useLang();
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.algorithm}
      emptyText={t('mf.dem_no_metrics')}
      columns={[
        {
          key: 'algorithm',
          label: t('mf.dem_col_algo'),
          render: (r) => (
            <span className="font-medium">
              {r.algorithm} {best === r.algorithm && <Badge variant="success" className="ml-1">{t('mf.dem_best')}</Badge>}
            </span>
          ),
        },
        { key: 'wape', label: 'WAPE', align: 'right', render: (r) => <span className="tabular">{pct(r.wape)}</span> },
        { key: 'mase', label: 'MASE', align: 'right', render: (r) => <span className="tabular">{r.mase?.toFixed(2)}</span> },
        { key: 'rmse', label: 'RMSE', align: 'right', render: (r) => <span className="tabular">{num(Math.round(r.rmse))}</span> },
        { key: 'bias', label: 'Bias', align: 'right', render: (r) => <span className="tabular">{r.bias?.toFixed(2)}</span> },
        { key: 'n_test', label: t('mf.dem_col_ntest'), align: 'right', render: (r) => <span className="tabular">{num(r.n_test)}</span> },
      ]}
    />
  );
}

function ForecastTab() {
  const { t } = useLang();
  const [itemId, setItemId] = useState('');
  const [horizon, setHorizon] = useState('14');
  const [algorithm, setAlgorithm] = useState('');

  const run = useMutation({
    mutationFn: () =>
      api<ForecastResp>('/api/demand/forecast', {
        method: 'POST',
        body: JSON.stringify({ item_id: itemId, horizon: Number(horizon) || 14, algorithm: algorithm || undefined }),
      }),
    onError: (e: any) => notifyError(e.message),
  });

  const r = run.data;

  return (
    <div className="space-y-5">
      <Card className="max-w-3xl gap-4">
        <CardHeader><CardTitle className="text-base">{t('mf.dem_form_title')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="fc-item">{t('mf.dem_item_label')}</Label>
              <Input id="fc-item" value={itemId} onChange={(e) => setItemId(e.target.value)} placeholder={t('mf.dem_item_ph')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="fc-h">{t('mf.dem_horizon_label')}</Label>
              <Input id="fc-h" type="number" min="1" max="90" value={horizon} onChange={(e) => setHorizon(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="fc-algo">{t('mf.dem_col_algo')}</Label>
              <Select id="fc-algo"  value={algorithm} onChange={(e) => setAlgorithm(e.target.value)}>
                {ALGOS.map((a) => <option key={a} value={a}>{a === '' ? t('mf.dem_auto_select') : a}</option>)}
              </Select>
            </div>
          </div>
          <Button disabled={run.isPending || !itemId.trim()} onClick={() => run.mutate()}>
            <Sparkles className="size-4" /> {run.isPending ? t('mf.dem_forecasting') : t('mf.dem_tab_forecast')}
          </Button>
        </CardContent>
      </Card>

      {r && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('mf.dem_model_selected')} value={r.algorithm} icon={LineChart} tone="primary" hint={r.selected_by === 'lowest_wape' ? t('mf.dem_auto') : t('mf.dem_manual')} />
            <StatCard label={t('mf.dem_wape_label')} value={pct(r.metrics.wape)} tone="info" />
            <StatCard label={t('mf.dem_data_days')} value={num(r.data_days)} tone="default" />
            <StatCard label={t('mf.dem_total_forecast')} value={num(Math.round(r.forecast.reduce((a, b) => a + b, 0)))} tone="success" hint={t('mf.days', { n: r.horizon })} />
          </div>

          <div>
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('mf.dem_daily_forecast')}</h3>
            <DataTable
              rows={r.forecast.map((v, i) => ({ day: i + 1, qty: v }))}
              rowKey={(x) => x.day}
              pageSize={0}
              dense
              columns={[
                { key: 'day', label: t('mf.dem_col_day'), render: (x) => t('mf.dem_day_plus', { n: x.day }) },
                { key: 'qty', label: t('mf.dem_col_qty_forecast'), align: 'right', render: (x) => <span className="tabular">{num(Math.round(x.qty))}</span> },
              ]}
            />
          </div>

          <div>
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('mf.dem_compare_tested')}</h3>
            <MetricsTable rows={r.candidates} best={r.algorithm} />
          </div>
        </div>
      )}
    </div>
  );
}

function BacktestTab() {
  const { t } = useLang();
  const [itemId, setItemId] = useState('');
  const [testSize, setTestSize] = useState('7');

  const run = useMutation({
    mutationFn: () =>
      api<BacktestResp>('/api/demand/backtest', {
        method: 'POST',
        body: JSON.stringify({ item_id: itemId, test_size: Number(testSize) || undefined }),
      }),
    onError: (e: any) => notifyError(e.message),
  });

  const r = run.data;

  return (
    <div className="space-y-5">
      <Card className="max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">{t('mf.dem_backtest_title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">{t('mf.dem_backtest_hint')}</p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid grow gap-2">
              <Label htmlFor="bt-item">{t('mf.dem_item_label')}</Label>
              <Input id="bt-item" value={itemId} onChange={(e) => setItemId(e.target.value)} placeholder={t('mf.dem_item_ph')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bt-size">{t('mf.dem_testsize_label')}</Label>
              <Input id="bt-size" type="number" min="1" value={testSize} onChange={(e) => setTestSize(e.target.value)} className="max-w-[160px]" />
            </div>
            <Button disabled={run.isPending || !itemId.trim()} onClick={() => run.mutate()}>
              <FlaskConical className="size-4" /> {run.isPending ? t('mf.dem_testing') : t('mf.dem_test_btn')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {r && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label={t('mf.dem_model_recommend')} value={r.best.algorithm} icon={Target} tone="success" />
            <StatCard label={t('mf.dem_wape_best')} value={pct(r.best.wape)} tone="info" />
            <StatCard label={t('mf.dem_data_days')} value={num(r.data_days)} tone="default" />
          </div>
          <div>
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('mf.dem_all_results')}</h3>
            <MetricsTable rows={r.candidates} best={r.best.algorithm} />
          </div>
        </div>
      )}
    </div>
  );
}

function HistoryTab() {
  const { t } = useLang();
  const q = useQuery<{ count: number; forecasts: ForecastRow[] }>({ queryKey: ['demand-history'], queryFn: () => api('/api/demand/forecasts?limit=100') });
  const acc = useQuery<AccuracyResp>({ queryKey: ['demand-accuracy'], queryFn: () => api('/api/demand/accuracy') });

  return (
    <div className="space-y-5">
      <StateView q={acc}>
        {acc.data && (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label={t('mf.dem_forecast_count')} value={num(acc.data.runs)} icon={History} tone="primary" />
            <StatCard label={t('mf.dem_wape_avg')} value={pct(acc.data.avg_wape)} tone="info" />
            <StatCard label={t('mf.dem_mase_avg')} value={acc.data.avg_mase != null ? acc.data.avg_mase.toFixed(2) : '—'} tone="default" />
          </div>
        )}
      </StateView>

      {acc.data && acc.data.by_algorithm.length > 0 && (
        <div>
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('mf.dem_acc_by_algo')}</h3>
          <DataTable
            rows={acc.data.by_algorithm}
            rowKey={(r) => r.algorithm}
            columns={[
              { key: 'algorithm', label: t('mf.dem_col_algo'), render: (r) => <span className="font-medium">{r.algorithm}</span> },
              { key: 'runs', label: t('mf.dem_col_runs'), align: 'right', render: (r) => <span className="tabular">{num(r.runs)}</span> },
              { key: 'avg_wape', label: t('mf.dem_wape_avg'), align: 'right', render: (r) => <span className="tabular">{pct(r.avg_wape)}</span> },
            ]}
          />
        </div>
      )}

      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('mf.dem_recent_history')}</h3>
        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={q.data.forecasts}
              rowKey={(_r, i) => i}
              emptyState={{ icon: History, title: t('mf.dem_empty_title'), description: t('mf.dem_empty_desc') }}
              columns={[
                { key: 'createdAt', label: t('mf.dem_col_when'), render: (r) => thaiDate(r.createdAt) },
                { key: 'itemId', label: t('mf.col_product'), render: (r) => <span className="font-medium">{r.itemId}</span> },
                { key: 'algorithm', label: t('mf.col_model') },
                { key: 'horizon', label: t('mf.dem_col_horizon'), align: 'right', render: (r) => <span className="tabular">{num(r.horizon)}</span> },
                { key: 'wape', label: 'WAPE', align: 'right', render: (r) => <span className="tabular">{pct(r.wape)}</span> },
                { key: 'dataDays', label: t('mf.dem_col_datadays'), align: 'right', render: (r) => <span className="tabular">{num(r.dataDays)}</span> },
              ]}
            />
          )}
        </StateView>
      </div>
    </div>
  );
}
