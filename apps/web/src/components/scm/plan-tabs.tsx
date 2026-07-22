// docs/54 Phase 3 — the planner workspace, mounted as extra tabs on /demand.
//
// NOTE: no 'use client' directive here BY DESIGN. These are imported only by the already-client
// /demand page, so they inherit its boundary; adding the directive would needlessly bump the
// check-use-client ratchet (see apps/web/src/components/state-view.tsx for the same pattern).

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, CheckCircle2, ClipboardCheck, FlaskConical, PackageSearch, Play, Send, TrendingUp,
} from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifyError, notifySuccess } from '@/lib/notify';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { StatCard } from '@/components/stat-card';
import { TrendAreaChart } from '@/components/charts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// ── API shapes (apps/api/src/modules/scm-planning) ────────────────────────────
interface PlanRun {
  id: number; runNo: string; runDate: string; scope: string; engine: string; status: string;
  branchCount: number | null; itemCount: number | null; seriesCount: number | null;
  horizonDays: number | null; error: string | null;
  metrics: { method?: string; branch_null_share?: number; plans?: number; lines?: number } | null;
  createdAt: string; completedAt: string | null;
}
interface OrderPlan {
  id: number; planNo: string; branchId: number | null; status: string;
  estTotalCost: string; expectedWasteCost: string | null; expectedFillRate: string | null;
  engine: string; createdBy: string | null; submittedBy: string | null; approvedBy: string | null;
  rejectReason: string | null; prNo: string | null; createdAt: string;
}
interface PlanLine {
  id: number; itemId: string; itemDescription: string | null; uom: string | null;
  suggestedQty: string; finalQty: string; unitCostEst: string;
  onHandQty: string | null; expiringQty: string | null; inTransitQty: string | null;
  coverageDays: string | null; stockoutRiskPct: string | null; reason: string;
  detail: Record<string, unknown> | null;
}
interface Forecast {
  id: number; branchId: number | null; itemId: string; level: string; method: string;
  horizon: number; startDate: string; mean: number[]; p10: number[] | null; p90: number[] | null;
  wape: string | null;
}
interface ScenarioLine {
  item_id: string; qty: number; unit_cost: number; est_cost: number;
  on_hand: number; in_transit: number; coverage_days: number | null;
}
interface SpikeEvent {
  id: number; branchId: number | null; itemId: string; day: string;
  actualQty: string; expectedQty: string; zScore: string | null; direction: string;
  status: string; detectedAt: string;
}

const n = (v: unknown) => Number(v ?? 0);

const statusTone = (s: string): 'success' | 'warning' | 'destructive' | 'default' =>
  s === 'Approved' || s === 'Converted' || s === 'Completed' ? 'success'
    : s === 'PendingApproval' || s === 'Running' ? 'warning'
      : s === 'Rejected' || s === 'Failed' ? 'destructive' : 'default';

// ── Tab 1 · Branch plans (runs + the forecast behind them) ────────────────────

export function BranchPlansTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [openRun, setOpenRun] = useState<number | null>(null);

  const runs = useQuery<{ runs: PlanRun[] }>({
    queryKey: ['scm-runs'],
    queryFn: () => api('/api/scm-planning/runs?limit=20'),
  });

  const plan = useMutation({
    mutationFn: () => api<{ run_no?: string; plans?: number; engine?: string; skipped?: boolean }>('/api/scm-planning/run', { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (r: { run_no?: string; plans?: number; engine?: string; skipped?: boolean }) => {
      notifySuccess(r.skipped
        ? t('scm.run_skipped')
        : `${t('scm.run_done')} ${r.run_no} · ${num(r.plans ?? 0)} ${t('scm.plans_created')}`);
      qc.invalidateQueries({ queryKey: ['scm-runs'] });
      qc.invalidateQueries({ queryKey: ['scm-plans'] });
    },
    onError: (e: Error) => notifyError(e.message),
  });

  const latest = runs.data?.runs?.[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="grid flex-1 gap-3 sm:grid-cols-3">
          <StatCard
            label={t('scm.kpi_last_run')}
            value={latest ? latest.runNo : '—'}
            hint={latest ? `${latest.status} · ${latest.engine}` : t('scm.no_runs')}
            icon={Play}
          />
          <StatCard
            label={t('scm.kpi_series')}
            value={num(latest?.seriesCount ?? 0)}
            hint={t('scm.kpi_series_hint')}
            icon={TrendingUp}
          />
          <StatCard
            label={t('scm.kpi_branches')}
            value={num(latest?.branchCount ?? 0)}
            hint={latest?.metrics?.branch_null_share
              ? `${t('scm.untagged_share')} ${(latest.metrics.branch_null_share * 100).toFixed(0)}%`
              : t('scm.kpi_branches_hint')}
            icon={PackageSearch}
          />
        </div>
        <Button onClick={() => plan.mutate()} disabled={plan.isPending}>
          <Play className="mr-1 size-4" />
          {plan.isPending ? t('scm.running') : t('scm.run_now')}
        </Button>
      </div>

      {/* A run whose demand pooled in the untagged unit means dine-in attribution is unset —
          surfaced here rather than left as a silent planning gap. */}
      {latest?.metrics?.branch_null_share != null && latest.metrics.branch_null_share > 0.2 && (
        <Card>
          <CardContent className="flex items-start gap-2 py-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <span>{t('scm.warn_untagged')}</span>
          </CardContent>
        </Card>
      )}

      <StateView q={runs}>
        <DataTable
          rows={runs.data?.runs ?? []}
          rowKey={(r) => r.id}
          onRowClick={(r) => setOpenRun(openRun === r.id ? null : r.id)}
          columns={[
            { key: 'runNo', label: t('scm.col_run'), render: (r) => <span className="font-medium">{r.runNo}</span> },
            { key: 'runDate', label: t('scm.col_date'), render: (r) => thaiDate(r.runDate) },
            { key: 'scope', label: t('scm.col_scope'), render: (r) => t(`scm.scope_${r.scope}`) },
            {
              key: 'engine',
              label: t('scm.col_engine'),
              render: (r) => (
                <Badge variant={r.engine === 'external' ? 'default' : 'secondary'}>
                  {r.engine === 'external' ? t('scm.engine_external') : t('scm.engine_fallback')}
                </Badge>
              ),
            },
            { key: 'seriesCount', label: t('scm.col_series'), align: 'right', render: (r) => num(r.seriesCount ?? 0) },
            {
              key: 'status',
              label: t('scm.col_status'),
              render: (r) => (
                <span title={r.error ?? undefined}>
                  <Badge variant={statusTone(r.status)}>{r.status}</Badge>
                </span>
              ),
            },
          ]}
        />
      </StateView>

      {openRun != null && <RunForecasts runId={openRun} />}
    </div>
  );
}

/** The forecast behind one run — the p10–p90 band is the point of a probabilistic forecast. */
function RunForecasts({ runId }: { runId: number }) {
  const { t } = useLang();
  const q = useQuery<{ forecasts: Forecast[] }>({
    queryKey: ['scm-forecasts', runId],
    queryFn: () => api(`/api/scm-planning/runs/${runId}/forecasts`),
  });
  const [pick, setPick] = useState(0);
  const rows = q.data?.forecasts ?? [];
  const f = rows[Math.min(pick, Math.max(rows.length - 1, 0))];

  const series = f
    ? f.mean.map((v, i) => ({
        d: `+${i + 1}`,
        mean: Math.round(v * 100) / 100,
        p10: f.p10 ? Math.round((f.p10[i] ?? 0) * 100) / 100 : null,
        p90: f.p90 ? Math.round((f.p90[i] ?? 0) * 100) / 100 : null,
      }))
    : [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">{t('scm.forecast_for_run')}</CardTitle>
        {rows.length > 1 && (
          <select
            className="h-8 rounded-md border bg-background px-2 text-sm"
            value={pick}
            onChange={(e) => setPick(Number(e.target.value))}
          >
            {rows.slice(0, 50).map((r, i) => (
              <option key={r.id} value={i}>
                {r.itemId}{r.branchId != null ? ` · ${t('scm.branch')} ${r.branchId}` : ''} ({r.method})
              </option>
            ))}
          </select>
        )}
      </CardHeader>
      <CardContent>
        <StateView q={q}>
          <>
            <TrendAreaChart data={series} xKey="d" yKey="mean" fmt={(v) => num(v)} />
            <p className="mt-2 text-xs text-muted-foreground">
              {f?.method}
              {f?.wape != null && ` · WAPE ${(n(f.wape) * 100).toFixed(1)}%`}
              {f?.p10 && ` · ${t('scm.band_hint')}`}
            </p>
          </>
        </StateView>
      </CardContent>
    </Card>
  );
}

// ── Tab 2 · Order plans (the maker-checker surface) ───────────────────────────

export function OrderPlansTab({ canApprove }: { canApprove: boolean }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);

  const plans = useQuery<{ plans: OrderPlan[] }>({
    queryKey: ['scm-plans'],
    queryFn: () => api('/api/scm-planning/plans?limit=50'),
  });

  const act = useMutation({
    mutationFn: ({ id, what, body }: { id: number; what: string; body?: unknown }) =>
      api<{ pr_no?: string; status?: string }>(`/api/scm-planning/plans/${id}/${what}`, { method: 'POST', body: JSON.stringify(body ?? {}) }),
    onSuccess: (r: { pr_no?: string; status?: string }) => {
      notifySuccess(r.pr_no ? `${t('scm.converted')} ${r.pr_no}` : `${t('scm.plan_now')} ${r.status}`);
      qc.invalidateQueries({ queryKey: ['scm-plans'] });
    },
    onError: (e: Error) => notifyError(e.message),
  });

  const rows = plans.data?.plans ?? [];
  const pending = rows.filter((p) => p.status === 'PendingApproval');

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label={t('scm.kpi_pending')} value={num(pending.length)} hint={t('scm.kpi_pending_hint')} icon={ClipboardCheck} />
        <StatCard
          label={t('scm.kpi_pending_value')}
          value={baht(pending.reduce((a, p) => a + n(p.estTotalCost), 0))}
          hint={t('scm.kpi_pending_value_hint')}
          icon={Send}
        />
        <StatCard
          label={t('scm.kpi_converted')}
          value={num(rows.filter((p) => p.status === 'Converted').length)}
          hint={t('scm.kpi_converted_hint')}
          icon={CheckCircle2}
        />
      </div>

      <StateView q={plans}>
        <DataTable
          rows={rows}
          rowKey={(p) => p.id}
          onRowClick={(p) => setOpen(open === p.id ? null : p.id)}
          columns={[
            { key: 'planNo', label: t('scm.col_plan'), render: (p) => <span className="font-medium">{p.planNo}</span> },
            { key: 'branchId', label: t('scm.col_branch'), render: (p) => (p.branchId ?? '—') },
            { key: 'estTotalCost', label: t('scm.col_value'), align: 'right', render: (p) => <span className="tabular">{baht(n(p.estTotalCost))}</span> },
            {
              key: 'expectedFillRate',
              label: t('scm.col_fill'),
              align: 'right',
              render: (p) => (p.expectedFillRate == null ? '—' : `${(n(p.expectedFillRate) * 100).toFixed(1)}%`),
            },
            { key: 'status', label: t('scm.col_status'), render: (p) => <Badge variant={statusTone(p.status)}>{p.status}</Badge> },
            { key: 'prNo', label: t('scm.col_pr'), render: (p) => p.prNo ?? '—' },
          ]}
        />
      </StateView>

      {open != null && (
        <PlanDetail
          planId={open}
          canApprove={canApprove}
          onAct={(what, body) => act.mutate({ id: open, what, body })}
          busy={act.isPending}
        />
      )}
    </div>
  );
}

function PlanDetail({
  planId, canApprove, onAct, busy,
}: {
  planId: number;
  canApprove: boolean;
  onAct: (what: string, body?: unknown) => void;
  busy: boolean;
}) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ plan: OrderPlan; lines: PlanLine[] }>({
    queryKey: ['scm-plan', planId],
    queryFn: () => api(`/api/scm-planning/plans/${planId}`),
  });

  const editLine = useMutation({
    mutationFn: ({ lineId, qty }: { lineId: number; qty: number }) =>
      api(`/api/scm-planning/plans/${planId}/lines/${lineId}`, { method: 'PUT', body: JSON.stringify({ final_qty: qty }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scm-plan', planId] });
      qc.invalidateQueries({ queryKey: ['scm-plans'] });
    },
    onError: (e: Error) => notifyError(e.message),
  });

  const plan = q.data?.plan;
  const lines = q.data?.lines ?? [];
  const editable = plan?.status === 'Draft' || plan?.status === 'Rejected';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {plan?.planNo} · <Badge variant={statusTone(plan?.status ?? '')}>{plan?.status}</Badge>
        </CardTitle>
        {plan?.rejectReason && (
          <p className="text-sm text-destructive">{t('scm.rejected_reason')}: {plan.rejectReason}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <StateView q={q}>
          <DataTable
            rows={lines}
            rowKey={(l) => l.id}
            columns={[
              { key: 'itemId', label: t('scm.col_item'), render: (l) => (
                <span>
                  <span className="font-medium">{l.itemId}</span>
                  {l.itemDescription && <span className="ml-1 text-muted-foreground">{l.itemDescription}</span>}
                </span>
              ) },
              { key: 'onHandQty', label: t('scm.col_onhand'), align: 'right', render: (l) => <span className="tabular">{num(n(l.onHandQty))}</span> },
              { key: 'expiringQty', label: t('scm.col_expiring'), align: 'right', render: (l) => (
                n(l.expiringQty) > 0
                  ? <span className="tabular text-amber-600">{num(n(l.expiringQty))}</span>
                  : <span className="tabular text-muted-foreground">0</span>
              ) },
              { key: 'inTransitQty', label: t('scm.col_intransit'), align: 'right', render: (l) => <span className="tabular">{num(n(l.inTransitQty))}</span> },
              { key: 'suggestedQty', label: t('scm.col_suggested'), align: 'right', render: (l) => <span className="tabular">{num(n(l.suggestedQty))}</span> },
              {
                key: 'finalQty',
                label: t('scm.col_final'),
                align: 'right',
                render: (l) => (editable ? (
                  <Input
                    type="number"
                    className="h-8 w-24 text-right"
                    defaultValue={n(l.finalQty)}
                    min={0}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v !== n(l.finalQty)) editLine.mutate({ lineId: l.id, qty: v });
                    }}
                  />
                ) : <span className="tabular">{num(n(l.finalQty))}</span>),
              },
              {
                key: 'stockoutRiskPct',
                label: t('scm.col_risk'),
                align: 'right',
                render: (l) => (l.stockoutRiskPct == null ? '—' : `${n(l.stockoutRiskPct).toFixed(1)}%`),
              },
              { key: 'reason', label: t('scm.col_reason'), render: (l) => (
                <span title={JSON.stringify(l.detail ?? {})}>{t(`scm.reason_${l.reason}`)}</span>
              ) },
            ]}
          />
        </StateView>

        <div className="flex flex-wrap gap-2">
          {editable && (
            <Button onClick={() => onAct('submit')} disabled={busy}>
              <Send className="mr-1 size-4" />{t('scm.submit')}
            </Button>
          )}
          {/* The approve/reject pair is rendered only for a holder of scm_approve — the server
              enforces it regardless (guard + maker ≠ checker), this just avoids a dead button. */}
          {plan?.status === 'PendingApproval' && canApprove && (
            <>
              <Button onClick={() => onAct('approve')} disabled={busy}>
                <CheckCircle2 className="mr-1 size-4" />{t('scm.approve')}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  const reason = window.prompt(t('scm.reject_prompt'));
                  if (reason?.trim()) onAct('reject', { reason: reason.trim() });
                }}
              >
                {t('scm.reject')}
              </Button>
            </>
          )}
          {plan?.status === 'Approved' && (
            <Button onClick={() => onAct('convert-to-pr')} disabled={busy}>
              {t('scm.convert')}
            </Button>
          )}
          {plan?.prNo && <span className="self-center text-sm text-muted-foreground">{t('scm.pr_created')}: {plan.prNo}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Tab 3 · Scenario what-if ──────────────────────────────────────────────────

export function ScenarioTab() {
  const { t } = useLang();
  const [items, setItems] = useState('');
  const [branch, setBranch] = useState('');
  const [multiplier, setMultiplier] = useState(1.5);
  const [priceMult, setPriceMult] = useState(1);
  const [horizon, setHorizon] = useState(7);

  const run = useMutation({
    mutationFn: () => api<{ lines?: ScenarioLine[]; est_total_cost?: number }>('/api/scm-planning/scenario', {
      method: 'POST',
      body: JSON.stringify({
        branch_id: branch ? Number(branch) : null,
        item_ids: items.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 25),
        horizon_days: horizon,
        demand_multiplier: multiplier,
        // docs/56 A2 — only send a price what-if when the operator moved it off 1 (neutral).
        ...(priceMult !== 1 ? { price_multiplier: priceMult } : {}),
      }),
    }),
    onError: (e: Error) => notifyError(e.message),
  });
  const res = run.data;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('scm.scenario_title')}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('scm.scenario_desc')}</p>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-4">
          <div>
            <Label>{t('scm.f_items')}</Label>
            <Input value={items} onChange={(e) => setItems(e.target.value)} placeholder="ING-CHK, ING-RICE" />
          </div>
          <div>
            <Label>{t('scm.f_branch')}</Label>
            <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={t('scm.f_branch_all')} />
          </div>
          <div>
            <Label>{t('scm.f_multiplier')}</Label>
            <Input type="number" step="0.1" min={0.1} max={5} value={multiplier} onChange={(e) => setMultiplier(Number(e.target.value))} />
          </div>
          <div>
            <Label>{t('scm.f_price_multiplier')}</Label>
            <Input type="number" step="0.05" min={0.1} max={5} value={priceMult} onChange={(e) => setPriceMult(Number(e.target.value))} />
          </div>
          <div>
            <Label>{t('scm.f_horizon')}</Label>
            <Input type="number" min={1} max={28} value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} />
          </div>
          <div className="sm:col-span-4">
            <Button onClick={() => run.mutate()} disabled={run.isPending || !items.trim()}>
              <FlaskConical className="mr-1 size-4" />
              {run.isPending ? t('scm.calculating') : t('scm.calculate')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {res && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t('scm.scenario_result')} · {baht(res.est_total_cost ?? 0)}
            </CardTitle>
            <p className="text-xs text-muted-foreground">{t('scm.scenario_advisory')}</p>
          </CardHeader>
          <CardContent>
            <DataTable
              rows={res.lines ?? []}
              rowKey={(l) => l.item_id}
              emptyText={t('scm.scenario_none')}
              columns={[
                { key: 'item_id', label: t('scm.col_item'), render: (l) => <span className="font-medium">{l.item_id}</span> },
                { key: 'on_hand', label: t('scm.col_onhand'), align: 'right', render: (l) => <span className="tabular">{num(l.on_hand)}</span> },
                { key: 'qty', label: t('scm.col_suggested'), align: 'right', render: (l) => <span className="tabular">{num(l.qty)}</span> },
                { key: 'est_cost', label: t('scm.col_value'), align: 'right', render: (l) => <span className="tabular">{baht(l.est_cost)}</span> },
                { key: 'coverage_days', label: t('scm.col_cover'), align: 'right', render: (l) => (l.coverage_days == null ? '—' : `${l.coverage_days.toFixed(1)}d`) },
              ]}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Tab 4 · Demand spikes ─────────────────────────────────────────────────────

export function SpikesTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ spikes: SpikeEvent[] }>({
    queryKey: ['scm-spikes'],
    queryFn: () => api('/api/scm-planning/spikes?limit=50'),
    refetchInterval: 60_000, // the SSE feed is best-effort; polling keeps the list honest
  });

  const scan = useMutation({
    mutationFn: () => api<{ spikes?: number; replans?: number }>('/api/scm-planning/spikes/scan', { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (r: { spikes?: number; replans?: number }) => {
      notifySuccess(`${t('scm.scan_done')}: ${num(r.spikes ?? 0)} · ${t('scm.replans')} ${num(r.replans ?? 0)}`);
      qc.invalidateQueries({ queryKey: ['scm-spikes'] });
    },
    onError: (e: Error) => notifyError(e.message),
  });

  const dismiss = useMutation({
    mutationFn: (id: number) => api(`/api/scm-planning/spikes/${id}/dismiss`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scm-spikes'] }),
    onError: (e: Error) => notifyError(e.message),
  });

  const rows = q.data?.spikes ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('scm.spikes_desc')}</p>
        <Button variant="outline" onClick={() => scan.mutate()} disabled={scan.isPending}>
          {scan.isPending ? t('scm.scanning') : t('scm.scan_now')}
        </Button>
      </div>
      <StateView q={q}>
        <DataTable
          rows={rows}
          rowKey={(s) => s.id}
          columns={[
            { key: 'day', label: t('scm.col_date'), render: (s) => thaiDate(s.day) },
            { key: 'itemId', label: t('scm.col_item'), render: (s) => <span className="font-medium">{s.itemId}</span> },
            { key: 'branchId', label: t('scm.col_branch'), render: (s) => (s.branchId ?? '—') },
            { key: 'expectedQty', label: t('scm.col_expected'), align: 'right', render: (s) => <span className="tabular">{num(n(s.expectedQty))}</span> },
            { key: 'actualQty', label: t('scm.col_actual'), align: 'right', render: (s) => <span className="tabular font-medium">{num(n(s.actualQty))}</span> },
            { key: 'zScore', label: 'z', align: 'right', render: (s) => (s.zScore == null ? '—' : n(s.zScore).toFixed(1)) },
            {
              key: 'direction',
              label: t('scm.col_dir'),
              render: (s) => (
                <Badge variant={s.direction === 'up' ? 'warning' : 'secondary'}>
                  {s.direction === 'up' ? t('scm.dir_up') : t('scm.dir_down')}
                </Badge>
              ),
            },
            { key: 'status', label: t('scm.col_status'), render: (s) => <Badge variant={statusTone(s.status)}>{s.status}</Badge> },
            {
              key: 'id',
              label: '',
              render: (s) => (s.status === 'Open' ? (
                <Button variant="ghost" size="sm" onClick={() => dismiss.mutate(s.id)}>{t('scm.dismiss')}</Button>
              ) : null),
            },
          ]}
        />
      </StateView>
    </div>
  );
}
