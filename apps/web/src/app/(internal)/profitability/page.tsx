'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ListChecks, PieChart, PlayCircle, Tags, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { SimpleBarChart } from '@/components/charts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const currentPeriod = () => new Date().toISOString().slice(0, 7);

interface Segment { id: number; segment_type: string; code: string; name: string }
interface SegmentsResp { segments: Segment[]; count: number }
interface Rule { id: number; name: string; from_account_code: string; to_segment_type: string; driver: string }
interface RulesResp { rules: Rule[]; count: number }
interface ReportSeg {
  segment_type: string;
  code: string;
  name: string;
  allocated_costs: number;
  contribution_margin: number;
}
interface ReportResp {
  period: string;
  entity_net_income: number;
  segments: ReportSeg[];
  run_id: number | null;
}

export default function ProfitabilityPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('pb.prof_title')}
        description={t('pb.prof_subtitle')}
      />
      <Tabs
        tabs={[
          { key: 'report', label: t('pb.prof_tab_report'), content: <ReportTab /> },
          { key: 'segments', label: t('pb.prof_tab_segments'), content: <SegmentsTab /> },
          { key: 'rules', label: t('pb.prof_tab_rules'), content: <RulesTab /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── รายงานกำไรตามมิติ ─────────────────────────
function ReportTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [period, setPeriod] = useState(currentPeriod());
  const [segmentType, setSegmentType] = useState('');

  const q = useQuery<ReportResp>({
    queryKey: ['profit-report', period, segmentType],
    queryFn: () =>
      api(`/api/profitability/report?period=${encodeURIComponent(period)}${segmentType ? `&segment_type=${encodeURIComponent(segmentType)}` : ''}`),
    enabled: /^\d{4}-\d{2}$/.test(period),
  });

  const run = useMutation({
    mutationFn: () =>
      api<{ run_id: number; rules_applied: number; lines_created: number; status: string }>('/api/profitability/run', {
        method: 'POST',
        body: JSON.stringify({ period }),
      }),
    onSuccess: (r) => {
      notifySuccess(t('pb.prof_run_success', { id: r.run_id, rules: r.rules_applied, lines: r.lines_created }));
      qc.invalidateQueries({ queryKey: ['profit-report'] });
    },
    onError: (e: Error) => notifyError(e.message),
  });

  const chartData = q.data?.segments.map((s) => ({ name: s.name || s.code, margin: s.contribution_margin })) ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-2">
          <Label htmlFor="profit-period">{t('pb.period_ym')}</Label>
          <Input id="profit-period" className="max-w-[160px]" placeholder="2026-06" value={period} onChange={(e) => setPeriod(e.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="profit-segtype">{t('pb.prof_segtype_label')}</Label>
          <Input id="profit-segtype" className="max-w-[200px]" placeholder={t('pb.prof_ph_segtype')} value={segmentType} onChange={(e) => setSegmentType(e.target.value)} />
        </div>
        <Button variant="outline" disabled={run.isPending || !/^\d{4}-\d{2}$/.test(period)} onClick={() => run.mutate()}>
          <PlayCircle className="size-4" /> {run.isPending ? t('pb.prof_allocating') : t('pb.prof_run_allocation')}
        </Button>
      </div>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard
                label={t('pb.prof_net_income')}
                value={baht(q.data.entity_net_income)}
                icon={Wallet}
                tone={q.data.entity_net_income >= 0 ? 'success' : 'danger'}
              />
              <StatCard label={t('pb.prof_segment_count')} value={q.data.segments.length} icon={PieChart} tone="primary" />
              <StatCard
                label={t('pb.prof_total_allocated')}
                value={baht(q.data.segments.reduce((a, s) => a + s.allocated_costs, 0))}
                tone="warning"
                hint={q.data.run_id != null ? t('pb.prof_run_ref', { id: q.data.run_id }) : t('pb.prof_no_run')}
              />
            </div>

            {chartData.length > 0 && (
              <Card className="gap-4 p-5">
                <CardHeader className="p-0">
                  <CardTitle className="text-base">{t('pb.prof_cm_by_segment')}</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <SimpleBarChart data={chartData} xKey="name" yKey="margin" fmt={(v) => baht(v)} />
                </CardContent>
              </Card>
            )}

            <DataTable
              rows={q.data.segments}
              rowKey={(r) => `${r.segment_type}-${r.code}`}
              columns={[
                { key: 'segment_type', label: t('pb.prof_col_segment') },
                { key: 'code', label: t('pb.col_code') },
                { key: 'name', label: t('pb.col_name'), render: (r) => <span className="font-medium">{r.name}</span> },
                { key: 'allocated_costs', label: t('pb.prof_col_allocated'), align: 'right', render: (r) => <span className="tabular">{baht(r.allocated_costs)}</span> },
                {
                  key: 'contribution_margin',
                  label: t('pb.prof_col_cm'),
                  align: 'right',
                  render: (r) => (
                    <span className={`tabular ${r.contribution_margin < 0 ? 'font-semibold text-destructive' : ''}`}>{baht(r.contribution_margin)}</span>
                  ),
                },
              ]}
              emptyState={
                segmentType
                  ? {
                      icon: PieChart,
                      title: t('pb.prof_empty_filter_title'),
                      description: t('pb.prof_empty_filter_desc'),
                      action: (
                        <Button variant="outline" size="sm" onClick={() => setSegmentType('')}>
                          {t('inv.clear_filter')}
                        </Button>
                      ),
                    }
                  : {
                      icon: PieChart,
                      title: t('pb.prof_empty_title'),
                      description: t('pb.prof_empty_desc'),
                    }
              }
            />
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── มิติ (segments) ─────────────────────────
function SegmentsTab() {
  const { t } = useLang();
  const q = useQuery<SegmentsResp>({ queryKey: ['profit-segments'], queryFn: () => api('/api/profitability/segments') });
  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard label={t('pb.prof_segment_count')} value={q.data.count} icon={Tags} tone="primary" />
          </div>
          <DataTable
            rows={q.data.segments}
            rowKey={(r) => r.id}
            columns={[
              { key: 'segment_type', label: t('pb.prof_col_segtype') },
              { key: 'code', label: t('pb.col_code'), render: (r) => <span className="font-medium">{r.code}</span> },
              { key: 'name', label: t('pb.col_name') },
            ]}
            emptyState={{
              icon: Tags,
              title: t('pb.prof_empty_seg_title'),
              description: t('pb.prof_empty_seg_desc'),
            }}
          />
        </div>
      )}
    </StateView>
  );
}

// ───────────────────────── กฎการปันส่วน ─────────────────────────
function RulesTab() {
  const { t } = useLang();
  const q = useQuery<RulesResp>({ queryKey: ['profit-rules'], queryFn: () => api('/api/profitability/rules') });
  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard label={t('pb.prof_rule_count')} value={q.data.count} icon={PieChart} tone="primary" />
          </div>
          <DataTable
            rows={q.data.rules}
            rowKey={(r) => r.id}
            columns={[
              { key: 'name', label: t('pb.prof_col_rule_name'), render: (r) => <span className="font-medium">{r.name}</span> },
              { key: 'from_account_code', label: t('pb.prof_col_from_account') },
              { key: 'to_segment_type', label: t('pb.prof_col_to_segment') },
              { key: 'driver', label: t('pb.prof_col_driver') },
            ]}
            emptyState={{
              icon: ListChecks,
              title: t('pb.prof_empty_rules_title'),
              description: t('pb.prof_empty_rules_desc'),
            }}
          />
        </div>
      )}
    </StateView>
  );
}
