'use client';

// docs/48 — Marketing Mix Modeling workspace. Tabs over the MMM backend (api/mmm/*):
//   Ingest         — manually push per-channel sales + per-platform sentiment (for a store without an ETL).
//   Signals        — the ingested per-channel sales + per-platform sentiment the model reads.
//   Model          — run the attribution over a window with per-channel spend; browse + drill into prior runs.
//   Recommendation — the latest run's channel ROI + ROI-proportional "optimal" budget reallocation.
// Gated to the marketing/exec duty (same as the routes). Read-only analytics — no GL post.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, Play, TrendingUp, Wallet, Layers, Plus, Trash2, Sparkles, Upload } from 'lucide-react';
import { api } from '@/lib/api';
import { num, baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface ChannelResult {
  channel: string; spend: number; attributed_revenue: number;
  roi: number | null; sales_lift_contribution: number | null; optimal_budget_allocation: number | null;
}
interface RunHeader {
  run_no: string; window_days: number; total_spend: number;
  spend_by_channel: Record<string, number> | null; status: string; created_by: string; created_at: string;
}
interface Summary extends Partial<Omit<RunHeader, 'run_no'>> { has_run: boolean; run_no: string | null; results: ChannelResult[] }

const pct = (n: number | null | undefined) => (n == null ? '—' : `${num(n)}%`);
const roiFmt = (n: number | null | undefined) => (n == null ? '—' : `${num(n)}×`);

// The per-channel result columns, shared by the Recommendation tab and the run-detail dialog.
function resultColumns(t: (k: string) => string) {
  return [
    { key: 'channel', label: t('mmm.col_channel'), render: (r: ChannelResult) => r.channel },
    { key: 'spend', label: t('mmm.col_spend'), align: 'right' as const, render: (r: ChannelResult) => baht(r.spend) },
    { key: 'rev', label: t('mmm.col_attr_revenue'), align: 'right' as const, render: (r: ChannelResult) => baht(r.attributed_revenue) },
    { key: 'roi', label: t('mmm.col_roi'), align: 'right' as const, render: (r: ChannelResult) => roiFmt(r.roi) },
    { key: 'lift', label: t('mmm.col_lift'), align: 'right' as const, render: (r: ChannelResult) => pct(r.sales_lift_contribution) },
    { key: 'opt', label: t('mmm.col_optimal'), align: 'right' as const, render: (r: ChannelResult) => baht(r.optimal_budget_allocation) },
  ];
}

// Drill into a specific past run (BOLA-safe GET /api/mmm/runs/:runNo — filtered by tenant AND run_no).
function RunDetailDialog({ runNo, onClose }: { runNo: string | null; onClose: () => void }) {
  const { t } = useLang();
  const q = useQuery<RunHeader & { results: ChannelResult[] }>({
    queryKey: ['mmm-run', runNo], queryFn: () => api(`/api/mmm/runs/${runNo}`), enabled: runNo != null,
  });
  return (
    <Dialog open={runNo != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>{t('mmm.run_detail')} · {runNo}</DialogTitle></DialogHeader>
        <StateView q={q}>
          {q.data && (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <StatCard label={t('mmm.col_window')} value={`${num(q.data.window_days)}d`} icon={BarChart3} tone="primary" />
                <StatCard label={t('mmm.kpi_total_spend')} value={baht(q.data.total_spend)} icon={Wallet} tone="success" />
                <StatCard label={t('mmm.col_run_by')} value={q.data.created_by} icon={TrendingUp} tone="warning" />
              </div>
              <div className="max-h-96 overflow-y-auto">
                <DataTable rows={q.data.results} rowKey={(r) => r.channel} emptyState={{ icon: Layers, title: t('mmm.no_results') }} columns={resultColumns(t)} />
              </div>
            </div>
          )}
        </StateView>
      </DialogContent>
    </Dialog>
  );
}

// ── Ingest ──────────────────────────────────────────────────────────────────────────────────────────
interface SalesRow { bizDate: string; channel: string; revenue: string; units: string }
interface SentRow { bizDate: string; platform: string; mentions: string; sentiment: string }

function Ingest() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [sales, setSales] = useState<SalesRow[]>([{ bizDate: '', channel: '', revenue: '', units: '' }]);
  const [sent, setSent] = useState<SentRow[]>([{ bizDate: '', platform: '', mentions: '', sentiment: '' }]);
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['mmm-sales'] }); qc.invalidateQueries({ queryKey: ['mmm-sentiment'] }); };

  const ingestSales = useMutation({
    mutationFn: () => {
      const rows = sales
        .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.bizDate) && r.channel.trim() && Number.isFinite(Number(r.revenue)))
        .map((r) => ({ bizDate: r.bizDate, utmSource: r.channel.trim(), revenue: Number(r.revenue), unitsSold: r.units ? Math.trunc(Number(r.units)) : undefined }));
      if (!rows.length) throw new Error(t('mmm.ing_need_row'));
      return api<{ upserted: number }>('/api/mmm/ingest/sales-daily', { method: 'POST', body: JSON.stringify({ rows }) });
    },
    onSuccess: (r) => { notifySuccess(t('mmm.ing_done', { n: String(r.upserted) })); invalidate(); },
    onError: (e: any) => notifyError(e.message),
  });
  const ingestSent = useMutation({
    mutationFn: () => {
      const rows = sent
        .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.bizDate) && r.platform.trim() && Number.isFinite(Number(r.mentions)))
        .map((r) => ({ bizDate: r.bizDate, platform: r.platform.trim(), mentionCount: Math.max(0, Math.trunc(Number(r.mentions))), sentimentScore: r.sentiment ? Number(r.sentiment) : undefined }));
      if (!rows.length) throw new Error(t('mmm.ing_need_row'));
      return api<{ upserted: number }>('/api/mmm/ingest/sentiment', { method: 'POST', body: JSON.stringify({ rows }) });
    },
    onSuccess: (r) => { notifySuccess(t('mmm.ing_done', { n: String(r.upserted) })); invalidate(); },
    onError: (e: any) => notifyError(e.message),
  });

  const inputCls = 'rounded border px-2 py-1 text-sm';
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('mmm.ing_hint')}</p>

      <Card className="gap-3">
        <CardHeader><CardTitle className="text-base">{t('mmm.ing_sales')}</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {sales.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input type="date" value={r.bizDate} onChange={(e) => setSales((p) => p.map((x, idx) => idx === i ? { ...x, bizDate: e.target.value } : x))} className={`w-40 ${inputCls}`} />
              <input value={r.channel} onChange={(e) => setSales((p) => p.map((x, idx) => idx === i ? { ...x, channel: e.target.value } : x))} placeholder={t('mmm.ph_channel')} className={`w-40 ${inputCls}`} />
              <input type="number" value={r.revenue} onChange={(e) => setSales((p) => p.map((x, idx) => idx === i ? { ...x, revenue: e.target.value } : x))} placeholder={t('mmm.col_revenue')} className={`w-32 ${inputCls}`} />
              <input type="number" value={r.units} onChange={(e) => setSales((p) => p.map((x, idx) => idx === i ? { ...x, units: e.target.value } : x))} placeholder={t('mmm.col_units')} className={`w-24 ${inputCls}`} />
              <Button size="sm" variant="ghost" onClick={() => setSales((p) => p.length === 1 ? p : p.filter((_, idx) => idx !== i))} aria-label={t('mmm.remove')}><Trash2 className="size-3.5" /></Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setSales((p) => [...p, { bizDate: '', channel: '', revenue: '', units: '' }])}><Plus className="mr-1 size-3.5" />{t('mmm.ing_add_row')}</Button>
            <Button size="sm" disabled={ingestSales.isPending} onClick={() => ingestSales.mutate()}><Upload className="mr-1 size-3.5" />{t('mmm.ing_submit')}</Button>
          </div>
        </CardContent>
      </Card>

      <Card className="gap-3">
        <CardHeader><CardTitle className="text-base">{t('mmm.ing_sentiment')}</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {sent.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input type="date" value={r.bizDate} onChange={(e) => setSent((p) => p.map((x, idx) => idx === i ? { ...x, bizDate: e.target.value } : x))} className={`w-40 ${inputCls}`} />
              <input value={r.platform} onChange={(e) => setSent((p) => p.map((x, idx) => idx === i ? { ...x, platform: e.target.value } : x))} placeholder={t('mmm.col_platform')} className={`w-40 ${inputCls}`} />
              <input type="number" value={r.mentions} onChange={(e) => setSent((p) => p.map((x, idx) => idx === i ? { ...x, mentions: e.target.value } : x))} placeholder={t('mmm.col_mentions')} className={`w-28 ${inputCls}`} />
              <input type="number" step="0.1" min="-1" max="1" value={r.sentiment} onChange={(e) => setSent((p) => p.map((x, idx) => idx === i ? { ...x, sentiment: e.target.value } : x))} placeholder={t('mmm.ing_sentiment_ph')} className={`w-32 ${inputCls}`} />
              <Button size="sm" variant="ghost" onClick={() => setSent((p) => p.length === 1 ? p : p.filter((_, idx) => idx !== i))} aria-label={t('mmm.remove')}><Trash2 className="size-3.5" /></Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setSent((p) => [...p, { bizDate: '', platform: '', mentions: '', sentiment: '' }])}><Plus className="mr-1 size-3.5" />{t('mmm.ing_add_row')}</Button>
            <Button size="sm" disabled={ingestSent.isPending} onClick={() => ingestSent.mutate()}><Upload className="mr-1 size-3.5" />{t('mmm.ing_submit')}</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Signals ───────────────────────────────────────────────────────────────────────────────────────
function Signals() {
  const { t } = useLang();
  const salesQ = useQuery<{ window_days: number; channels: { channel: string; revenue: number; units: number }[] }>({
    queryKey: ['mmm-sales'], queryFn: () => api('/api/mmm/sales-daily?days=30'),
  });
  const sentQ = useQuery<{ window_days: number; platforms: { platform: string; mentions: number; avg_sentiment: number | null }[] }>({
    queryKey: ['mmm-sentiment'], queryFn: () => api('/api/mmm/sentiment?days=30'),
  });
  return (
    <div className="space-y-4">
      <StateView q={salesQ}>
        {salesQ.data && (
          <Card className="gap-3">
            <CardHeader><CardTitle className="text-base">{t('mmm.sales_by_channel')}</CardTitle></CardHeader>
            <CardContent>
              <DataTable rows={salesQ.data.channels} rowKey={(r) => r.channel} emptyState={{ icon: Layers, title: t('mmm.no_signals') }} columns={[
                { key: 'channel', label: t('mmm.col_channel'), render: (r) => r.channel },
                { key: 'revenue', label: t('mmm.col_revenue'), align: 'right', render: (r) => baht(r.revenue) },
                { key: 'units', label: t('mmm.col_units'), align: 'right', render: (r) => num(r.units) },
              ]} />
            </CardContent>
          </Card>
        )}
      </StateView>
      <StateView q={sentQ}>
        {sentQ.data && (
          <Card className="gap-3">
            <CardHeader><CardTitle className="text-base">{t('mmm.sentiment_by_platform')}</CardTitle></CardHeader>
            <CardContent>
              <DataTable rows={sentQ.data.platforms} rowKey={(r) => r.platform} emptyState={{ icon: Sparkles, title: t('mmm.no_signals') }} columns={[
                { key: 'platform', label: t('mmm.col_platform'), render: (r) => r.platform },
                { key: 'mentions', label: t('mmm.col_mentions'), align: 'right', render: (r) => num(r.mentions) },
                { key: 'sentiment', label: t('mmm.col_avg_sentiment'), align: 'right', render: (r) => (r.avg_sentiment == null ? '—' : String(r.avg_sentiment)) },
              ]} />
            </CardContent>
          </Card>
        )}
      </StateView>
    </div>
  );
}

// ── Model ─────────────────────────────────────────────────────────────────────────────────────────
interface SpendRow { channel: string; spend: string }

function Model() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [windowDays, setWindowDays] = useState('30');
  const [rows, setRows] = useState<SpendRow[]>([{ channel: '', spend: '' }]);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);

  const runsQ = useQuery<{ count: number; runs: RunHeader[] }>({ queryKey: ['mmm-runs'], queryFn: () => api('/api/mmm/runs') });

  const setRow = (i: number, patch: Partial<SpendRow>) => setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((prev) => [...prev, { channel: '', spend: '' }]);
  const removeRow = (i: number) => setRows((prev) => (prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i)));

  const run = useMutation({
    mutationFn: () => {
      const spendByChannel: Record<string, number> = {};
      for (const r of rows) {
        const ch = r.channel.trim();
        const amt = Number(r.spend);
        if (ch && Number.isFinite(amt) && amt >= 0) spendByChannel[ch] = amt;
      }
      const body: { windowDays?: number; spendByChannel?: Record<string, number> } = {};
      const wd = Number(windowDays);
      if (Number.isFinite(wd) && wd >= 1) body.windowDays = Math.min(Math.trunc(wd), 365);
      if (Object.keys(spendByChannel).length > 0) body.spendByChannel = spendByChannel;
      return api<{ run_no: string; channels: number }>('/api/mmm/run', { method: 'POST', body: JSON.stringify(body) });
    },
    onSuccess: (r) => {
      notifySuccess(t('mmm.run_done', { runNo: r.run_no, n: String(r.channels) }));
      qc.invalidateQueries({ queryKey: ['mmm-runs'] });
      qc.invalidateQueries({ queryKey: ['mmm-summary'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="space-y-4">
      <Card className="gap-3">
        <CardHeader><CardTitle className="text-base">{t('mmm.run_title')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <span className="w-40 text-muted-foreground">{t('mmm.window_days')}</span>
            <input type="number" min={1} max={365} value={windowDays} onChange={(e) => setWindowDays(e.target.value)}
              className="w-28 rounded border px-2 py-1 text-sm" />
          </label>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{t('mmm.spend_by_channel')}</p>
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <input value={r.channel} onChange={(e) => setRow(i, { channel: e.target.value })} placeholder={t('mmm.ph_channel')}
                  className="w-48 rounded border px-2 py-1 text-sm" />
                <input type="number" min={0} value={r.spend} onChange={(e) => setRow(i, { spend: e.target.value })} placeholder={t('mmm.ph_spend')}
                  className="w-36 rounded border px-2 py-1 text-sm" />
                <Button size="sm" variant="ghost" onClick={() => removeRow(i)} aria-label={t('mmm.remove')}><Trash2 className="size-3.5" /></Button>
              </div>
            ))}
            <Button size="sm" variant="secondary" onClick={addRow}><Plus className="mr-1 size-3.5" />{t('mmm.add_channel')}</Button>
          </div>
          <Button disabled={run.isPending} onClick={() => run.mutate()}><Play className="mr-1 size-3.5" />{t('mmm.run')}</Button>
        </CardContent>
      </Card>

      <StateView q={runsQ}>
        {runsQ.data && (
          <>
            <p className="text-xs text-muted-foreground">{t('mmm.runs_hint')}</p>
            <DataTable rows={runsQ.data.runs} rowKey={(r) => r.run_no} onRowClick={(r) => setSelectedRun(r.run_no)} emptyState={{ icon: BarChart3, title: t('mmm.no_runs') }} columns={[
              { key: 'run_no', label: t('mmm.col_run_no'), render: (r) => r.run_no },
              { key: 'window', label: t('mmm.col_window'), align: 'right', render: (r) => `${num(r.window_days)}d` },
              { key: 'spend', label: t('mmm.col_total_spend'), align: 'right', render: (r) => baht(r.total_spend) },
              { key: 'by', label: t('mmm.col_run_by'), render: (r) => r.created_by },
              { key: 'at', label: t('mmm.col_run_at'), render: (r) => (r.created_at ? new Date(r.created_at).toLocaleString() : '—') },
            ]} />
          </>
        )}
      </StateView>
      <RunDetailDialog runNo={selectedRun} onClose={() => setSelectedRun(null)} />
    </div>
  );
}

// ── Recommendation ──────────────────────────────────────────────────────────────────────────────────
function Recommendation() {
  const { t } = useLang();
  const q = useQuery<Summary>({ queryKey: ['mmm-summary'], queryFn: () => api('/api/mmm/summary') });
  const d = q.data;
  const topChannel = d?.results?.[0]?.channel ?? '—';
  return (
    <StateView q={q}>
      {d && !d.has_run && <p className="text-sm text-muted-foreground">{t('mmm.no_run_yet')}</p>}
      {d && d.has_run && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('mmm.kpi_run')} value={d.run_no ?? '—'} icon={BarChart3} tone="primary" />
            <StatCard label={t('mmm.kpi_total_spend')} value={baht(d.total_spend)} icon={Wallet} tone="success" />
            <StatCard label={t('mmm.kpi_channels')} value={num(d.results.length)} icon={Layers} tone="primary" />
            <StatCard label={t('mmm.kpi_top_channel')} value={topChannel} icon={TrendingUp} tone="warning" />
          </div>
          <Card className="gap-3">
            <CardHeader><CardTitle className="text-base">{t('mmm.rec_title')}</CardTitle></CardHeader>
            <CardContent>
              <DataTable rows={d.results} rowKey={(r) => r.channel} emptyState={{ icon: Layers, title: t('mmm.no_results') }} columns={resultColumns(t)} />
            </CardContent>
          </Card>
        </div>
      )}
    </StateView>
  );
}

export default function MmmPage() {
  const { t } = useLang();
  return (
    <div className="space-y-4">
      <PageHeader title={t('mmm.title')} description={t('mmm.subtitle')} />
      <Tabs tabs={[
        { key: 'ingest', label: t('mmm.tab_ingest'), content: <Ingest /> },
        { key: 'signals', label: t('mmm.tab_signals'), content: <Signals /> },
        { key: 'model', label: t('mmm.tab_model'), content: <Model /> },
        { key: 'rec', label: t('mmm.tab_rec'), content: <Recommendation /> },
      ]} />
    </div>
  );
}
