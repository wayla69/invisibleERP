'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Flag, Goal, Layers, Plus, Scale, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
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
import { statusVariant } from '@/components/ui';

interface Version {
  id: number;
  version_no: string;
  name: string;
  fiscal_year: number;
  status: string;
  notes: string | null;
  created_by: string;
  created_at: string;
  submitted_at: string | null;
  approved_at: string | null;
}

export default function PlanningPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('pb.plan_title')}
        description={t('pb.plan_subtitle')}
      />
      <Tabs
        tabs={[
          { key: 'versions', label: t('pb.plan_tab_versions'), content: <Versions /> },
          { key: 'variance', label: t('pb.plan_tab_variance'), content: <Variance /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── เวอร์ชันงบประมาณ ─────────────────────────
function Versions() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ versions: Version[] }>({ queryKey: ['planning-versions'], queryFn: () => api('/api/planning/versions') });

  const [name, setName] = useState('');
  const [year, setYear] = useState(2026);

  const create = useMutation({
    mutationFn: () =>
      api<Version>('/api/planning/versions', {
        method: 'POST',
        body: JSON.stringify({ name, fiscal_year: Number(year) }),
      }),
    onSuccess: (v) => {
      notifySuccess(t('pb.plan_version_created', { no: v.version_no }));
      setName('');
      qc.invalidateQueries({ queryKey: ['planning-versions'] });
    },
    onError: (e: Error) => notifyError(e.message),
  });

  const action = useMutation({
    mutationFn: ({ id, verb }: { id: number; verb: 'submit' | 'approve' | 'baseline' }) =>
      api(`/api/planning/versions/${id}/${verb}`, { method: 'POST' }),
    onSuccess: (r: any) => {
      notifySuccess(`${r.version_no}: ${r.status}`);
      qc.invalidateQueries({ queryKey: ['planning-versions'] });
    },
    onError: (e: Error) => notifyError(e.message),
  });

  const versions = q.data?.versions ?? [];
  const counts = {
    total: versions.length,
    working: versions.filter((v) => v.status === 'Working').length,
    submitted: versions.filter((v) => v.status === 'Submitted').length,
    approved: versions.filter((v) => v.status === 'Approved' || v.status === 'Baseline').length,
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t('pb.plan_total_versions')} value={num(counts.total)} icon={Layers} tone="primary" />
        <StatCard label={t('pb.plan_working')} value={num(counts.working)} icon={Goal} tone="default" />
        <StatCard label={t('pb.plan_submitted')} value={num(counts.submitted)} icon={Send} tone={counts.submitted > 0 ? 'warning' : 'default'} />
        <StatCard label={t('pb.status_approved')} value={num(counts.approved)} icon={CheckCircle2} tone="success" />
      </div>

      <Card className="max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">{t('pb.plan_create_version')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="pv-name">{t('pb.plan_version_name')}</Label>
              <Input id="pv-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('pb.plan_ph_version')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pv-year">{t('pb.fiscal_year')}</Label>
              <Input id="pv-year" type="number" value={year} onChange={(e) => setYear(+e.target.value)} />
            </div>
          </div>
          <Button disabled={!name || create.isPending} onClick={() => create.mutate()}>
            <Plus className="size-4" /> {create.isPending ? t('pb.saving') : t('pb.plan_create_version_btn')}
          </Button>
        </CardContent>
      </Card>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('pb.plan_tab_versions')}</h3>
        <StateView q={q}>
          <DataTable
            rows={versions}
            columns={[
              { key: 'version_no', label: t('dash.col_no') },
              { key: 'name', label: t('pb.col_name') },
              { key: 'fiscal_year', label: t('pb.plan_col_year'), align: 'right', render: (r) => num(r.fiscal_year) },
              { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              { key: 'created_by', label: t('pb.plan_col_creator') },
              { key: 'created_at', label: t('dash.col_date'), render: (r) => thaiDate(r.created_at) },
              {
                key: 'actions',
                label: '',
                sortable: false,
                align: 'right',
                render: (r) => (
                  <div className="flex justify-end gap-2">
                    {r.status === 'Working' && (
                      <Button variant="outline" size="sm" disabled={action.isPending} onClick={() => action.mutate({ id: r.id, verb: 'submit' })}>
                        <Send className="size-3.5" /> {t('pb.plan_submit')}
                      </Button>
                    )}
                    {r.status === 'Submitted' && (
                      <Button variant="outline" size="sm" disabled={action.isPending} onClick={() => action.mutate({ id: r.id, verb: 'approve' })}>
                        <CheckCircle2 className="size-3.5" /> {t('pb.approve')}
                      </Button>
                    )}
                    {r.status === 'Approved' && (
                      <Button variant="outline" size="sm" disabled={action.isPending} onClick={() => action.mutate({ id: r.id, verb: 'baseline' })}>
                        <Flag className="size-3.5" /> {t('pb.plan_set_baseline')}
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
            emptyState={{
              icon: Layers,
              title: t('pb.plan_empty_title'),
              description: t('pb.plan_empty_desc'),
            }}
          />
        </StateView>
      </div>
    </div>
  );
}

// ───────────────────────── ผลต่าง 3 ทาง ─────────────────────────
interface VarLine {
  account_code: string;
  budget: number;
  forecast: number;
  actual: number;
  actual_vs_budget: number;
  actual_vs_forecast: number;
  forecast_vs_budget: number;
}
interface VarResp {
  version_id: number;
  scenario_id: number;
  period: string;
  lines: VarLine[];
  totals: { budget: number; forecast: number; actual: number; actual_vs_budget: number; actual_vs_forecast: number };
}

function Variance() {
  const { t } = useLang();
  const [versionId, setVersionId] = useState('');
  const [scenarioId, setScenarioId] = useState('');
  const [period, setPeriod] = useState('2026-06');
  const [ready, setReady] = useState(false);

  const q = useQuery<VarResp>({
    queryKey: ['planning-variance', versionId, scenarioId, period],
    queryFn: () => api(`/api/planning/versions/${versionId}/variance?scenario_id=${scenarioId}&period=${period}`),
    enabled: ready && !!versionId && !!scenarioId && !!period,
  });

  return (
    <div className="space-y-6">
      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="text-base">{t('pb.plan_select_vsp')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-2">
              <Label htmlFor="v-id">Version ID</Label>
              <Input id="v-id" type="number" className="w-32" value={versionId} onChange={(e) => setVersionId(e.target.value)} placeholder="1" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="s-id">Scenario ID</Label>
              <Input id="s-id" type="number" className="w-32" value={scenarioId} onChange={(e) => setScenarioId(e.target.value)} placeholder="1" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="v-period">{t('pb.period_ym')}</Label>
              <Input id="v-period" className="w-40" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-06" />
            </div>
            <Button disabled={!versionId || !scenarioId || !period} onClick={() => setReady(true)}>
              {t('pb.plan_calc_variance')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {ready && (
        <StateView q={q}>
          {q.data && (
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-5">
                <StatCard label={t('pb.plan_budget')} value={baht(q.data.totals.budget)} tone="primary" />
                <StatCard label={t('pb.plan_forecast')} value={baht(q.data.totals.forecast)} tone="info" />
                <StatCard label={t('pb.plan_actual')} value={baht(q.data.totals.actual)} tone="default" />
                <StatCard
                  label={t('pb.plan_actual_vs_budget')}
                  value={baht(q.data.totals.actual_vs_budget)}
                  tone={q.data.totals.actual_vs_budget >= 0 ? 'success' : 'danger'}
                />
                <StatCard
                  label={t('pb.plan_actual_vs_forecast')}
                  value={baht(q.data.totals.actual_vs_forecast)}
                  tone={q.data.totals.actual_vs_forecast >= 0 ? 'success' : 'danger'}
                />
              </div>
              <DataTable
                rows={q.data.lines}
                columns={[
                  { key: 'account_code', label: t('pb.col_account_code') },
                  { key: 'budget', label: t('pb.col_budget'), align: 'right', render: (r) => <span className="tabular">{baht(r.budget)}</span> },
                  { key: 'forecast', label: t('pb.plan_col_forecast'), align: 'right', render: (r) => <span className="tabular">{baht(r.forecast)}</span> },
                  { key: 'actual', label: t('pb.col_actual'), align: 'right', render: (r) => <span className="tabular">{baht(r.actual)}</span> },
                  {
                    key: 'actual_vs_budget',
                    label: t('pb.plan_actual_vs_budget'),
                    align: 'right',
                    render: (r) => <span className={`tabular ${r.actual_vs_budget >= 0 ? 'text-success' : 'text-destructive'}`}>{baht(r.actual_vs_budget)}</span>,
                  },
                  {
                    key: 'actual_vs_forecast',
                    label: t('pb.plan_actual_vs_forecast'),
                    align: 'right',
                    render: (r) => <span className={`tabular ${r.actual_vs_forecast >= 0 ? 'text-success' : 'text-destructive'}`}>{baht(r.actual_vs_forecast)}</span>,
                  },
                ]}
                emptyState={{
                  icon: Scale,
                  title: t('pb.plan_empty_var_title'),
                  description: t('pb.plan_empty_var_desc'),
                }}
              />
            </div>
          )}
        </StateView>
      )}
    </div>
  );
}
