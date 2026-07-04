'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleDollarSign, Coins, PlayCircle, ScrollText } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs, Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

const currentPeriod = () => new Date().toISOString().slice(0, 7); // YYYY-MM

interface Schedule {
  schedule_no: string;
  source_ref: string | null;
  total_amount: number;
  start_period: string;
  end_period: string;
  months: number;
  status: string;
  recognized_amount: number;
  remaining_amount: number;
  deferral_journal_no: string | null;
}
interface SchedulesResp { schedules: Schedule[]; count: number }
interface DeferredResp {
  as_of: string | null;
  deferred_balance: number;
  gl_unearned: number;
  reconciled: boolean;
  by_schedule: { schedule_no: string; total: number; recognized: number; remaining: number }[];
}

export default function RevenuePage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('fnx.rev.title')}
        description={t('fnx.rev.desc')}
      />
      <Tabs
        tabs={[
          { key: 'deferred', label: t('fnx.rev.tab_deferred'), content: <DeferredTab /> },
          { key: 'schedules', label: t('fnx.rev.tab_schedules'), content: <SchedulesTab /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── รายได้รอตัดบัญชี + เดินรายการรับรู้ ─────────────────────────
function DeferredTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<DeferredResp>({ queryKey: ['rev-deferred'], queryFn: () => api('/api/revenue/deferred') });
  const [period, setPeriod] = useState(currentPeriod());
  const [msg, setMsg] = useState('');

  const recognize = useMutation({
    mutationFn: () =>
      api<{ period: string; recognized_count: number; total_recognized: number }>(
        `/api/revenue/recognize?period=${encodeURIComponent(period)}`,
        { method: 'POST' },
      ),
    onSuccess: (r) => {
      setMsg(`✅ ${t('fnx.rev.recognize_ok', { count: r.recognized_count, total: baht(r.total_recognized), period: r.period })}`);
      qc.invalidateQueries({ queryKey: ['rev-deferred'] });
      qc.invalidateQueries({ queryKey: ['rev-schedules'] });
    },
    onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });

  return (
    <div className="space-y-5">
      <Card className="max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">{t('fnx.rev.run_title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-2">
              <Label htmlFor="rev-period">{t('fnx.rev.period_label')}</Label>
              <Input
                id="rev-period"
                className="max-w-[160px]"
                placeholder="2026-06"
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
              />
            </div>
            <Button
              disabled={recognize.isPending || !/^\d{4}-\d{2}$/.test(period)}
              onClick={() => recognize.mutate()}
            >
              <PlayCircle className="size-4" /> {recognize.isPending ? t('fnx.rev.recognizing') : t('fnx.rev.recognize_btn')}
            </Button>
          </div>
          <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label={t('fnx.rev.stat_deferred')} value={baht(q.data.deferred_balance)} icon={Coins} tone="primary" />
              <StatCard label={t('fnx.rev.stat_gl2400')} value={baht(q.data.gl_unearned)} icon={CircleDollarSign} />
              <StatCard
                label={t('fnx.rev.stat_recon')}
                value={<Badge variant={q.data.reconciled ? 'success' : 'destructive'}>{q.data.reconciled ? t('fnx.rev.recon_ok') : t('fnx.rev.recon_off')}</Badge>}
              />
            </div>
            <div>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('fnx.rev.by_schedule')}</h3>
              <DataTable
                rows={q.data.by_schedule}
                rowKey={(r) => r.schedule_no}
                columns={[
                  { key: 'schedule_no', label: t('fnx.rev.col_schedule_no') },
                  { key: 'total', label: t('fnx.rev.col_total'), align: 'right', render: (r) => <span className="tabular">{baht(r.total)}</span> },
                  { key: 'recognized', label: t('fnx.rev.col_recognized'), align: 'right', render: (r) => <span className="tabular">{baht(r.recognized)}</span> },
                  { key: 'remaining', label: t('fnx.rev.col_remaining'), align: 'right', render: (r) => <span className="tabular">{baht(r.remaining)}</span> },
                ]}
                emptyText={t('fnx.rev.empty_deferred')}
              />
            </div>
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── ตารางรับรู้รายได้ ─────────────────────────
function SchedulesTab() {
  const { t } = useLang();
  const q = useQuery<SchedulesResp>({ queryKey: ['rev-schedules'], queryFn: () => api('/api/revenue/schedules') });
  return (
    <ModulePage
      query={q}
      stats={
        q.data && (
          <>
            <StatCard label={t('fnx.rev.stat_count')} value={q.data.count} icon={ScrollText} tone="primary" />
            <StatCard
              label={t('fnx.rev.stat_total')}
              value={baht(q.data.schedules.reduce((a, s) => a + s.total_amount, 0))}
              icon={Coins}
            />
            <StatCard
              label={t('fnx.rev.stat_recognized')}
              value={baht(q.data.schedules.reduce((a, s) => a + s.recognized_amount, 0))}
              tone="success"
            />
            <StatCard
              label={t('fnx.rev.stat_remaining')}
              value={baht(q.data.schedules.reduce((a, s) => a + s.remaining_amount, 0))}
              tone="warning"
            />
          </>
        )
      }
    >
      {q.data && (
        <DataTable
          rows={q.data.schedules}
          rowKey={(r) => r.schedule_no}
          columns={[
            { key: 'schedule_no', label: t('fnx.rev.col_schedule_no'), render: (r) => <span className="font-medium">{r.schedule_no}</span> },
            { key: 'source_ref', label: t('fnx.rev.col_ref'), render: (r) => r.source_ref ?? '—' },
            { key: 'start_period', label: t('fnx.rev.col_start') },
            { key: 'end_period', label: t('fnx.rev.col_end') },
            { key: 'months', label: t('fnx.rev.col_months'), align: 'right', render: (r) => <span className="tabular">{r.months}</span> },
            { key: 'total_amount', label: t('fnx.rev.col_total'), align: 'right', render: (r) => <span className="tabular">{baht(r.total_amount)}</span> },
            { key: 'recognized_amount', label: t('fnx.rev.col_recognized'), align: 'right', render: (r) => <span className="tabular">{baht(r.recognized_amount)}</span> },
            { key: 'remaining_amount', label: t('fnx.rev.col_remaining'), align: 'right', render: (r) => <span className="tabular">{baht(r.remaining_amount)}</span> },
            { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
          ]}
          emptyText={t('fnx.rev.empty_schedules')}
        />
      )}
    </ModulePage>
  );
}
