'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock, ShieldCheck, ShieldAlert, Clock, FolderKanban, CheckCircle2, XCircle, ClipboardCheck, LayoutDashboard } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

const thisPeriod = () => new Date().toISOString().slice(0, 7);
const ragBadge = (rag: string) => <Badge variant={rag === 'red' ? 'destructive' : rag === 'amber' ? 'warning' : rag === 'green' ? 'success' : 'muted'}>{rag}</Badge>;

// PROJ-03 — period-end WIP/clearing close review + maker-checker sign-off, alongside the PMO-3 portfolio
// governance roll-up for the same period. Exec-only.
export default function ProjectClosePage() {
  const { t } = useLang();
  const router = useRouter();
  const qc = useQueryClient();
  const [period, setPeriod] = useState(thisPeriod());
  const refresh = () => { qc.invalidateQueries({ queryKey: ['close-reviews'] }); qc.invalidateQueries({ queryKey: ['close-review', period] }); };

  const listQ = useQuery<any>({ queryKey: ['close-reviews'], queryFn: () => api('/api/projects/close-reviews') });
  const reviewQ = useQuery<any>({ queryKey: ['close-review', period], queryFn: () => api(`/api/projects/close-review/${period}`) });
  const packQ = useQuery<any>({ queryKey: ['gov-pack', period], queryFn: () => api(`/api/projects/governance-pack?period=${period}`) });

  const prepare = useMutation({
    mutationFn: () => api(`/api/projects/close-review?period=${period}`, { method: 'POST', body: '{}' }),
    onSuccess: () => { notifySuccess(t('pj.toast_close_prepared', { period })); refresh(); }, onError: (e: any) => notifyError(e.message),
  });
  const approve = useMutation({
    mutationFn: (p: string) => api(`/api/projects/close-review/${p}/approve`, { method: 'POST', body: '{}' }),
    onSuccess: () => { notifySuccess(t('pj.toast_close_approved')); refresh(); }, onError: (e: any) => notifyError(e.message),
  });
  const reject = useMutation({
    mutationFn: (p: string) => api(`/api/projects/close-review/${p}/reject`, { method: 'POST', body: JSON.stringify({ reason: t('pj.reject_reason_default') }) }),
    onSuccess: () => { notifySuccess(t('pj.toast_close_rejected')); refresh(); }, onError: (e: any) => notifyError(e.message),
  });

  const r = reviewQ.data;
  const prepared = r && r.status !== 'None';
  const sum = packQ.data?.summary;

  return (
    <div>
      <PageHeader
        title={t('pj.close_title')}
        description={t('pj.close_desc')}
        actions={<div className="flex gap-2">
          <Button variant="outline" onClick={() => router.push('/projects/portfolio')}><LayoutDashboard className="size-4" /> {t('pj.btn_portfolio')}</Button>
        </div>}
      />

      <Card className="mb-5 gap-3 p-5">
        <h3 className="text-base font-semibold">{t('pj.select_period')}</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5"><Label>{t('pj.f_period')}</Label><Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="w-44" /></div>
          <Button onClick={() => prepare.mutate()} disabled={prepare.isPending || r?.status === 'Approved'}><ClipboardCheck className="size-4" /> {t('pj.btn_prepare_review')}</Button>
          {prepared && <Badge variant={statusVariant(r.status)}>{r.status}</Badge>}
        </div>
      </Card>

      {/* Selected-period review + maker-checker */}
      {prepared && (
        <div className="mb-5 grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('pj.stat_wip_full')} value={baht(r.wip_total)} icon={Clock} tone="info" />
            <StatCard label={t('pj.stat_clearing')} value={baht(r.clearing_balance)} icon={ShieldAlert} tone={Math.abs(r.clearing_balance) > 0 ? 'warning' : 'success'} hint={t('pj.clearing_hint')} />
            <StatCard label={t('pj.stat_open_projects')} value={r.open_projects} icon={FolderKanban} />
            <StatCard label={t('fin.col_status')} value={r.status} icon={r.status === 'Approved' ? ShieldCheck : Lock} tone={r.status === 'Approved' ? 'success' : r.status === 'Rejected' ? 'danger' : 'default'} />
          </div>
          <Card className="gap-3 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-muted-foreground">
                {t('pj.prepared_by')} <span className="font-medium text-foreground">{r.prepared_by ?? '—'}</span>
                {r.approved_by ? <> · {t('pj.approved_by')} <span className="font-medium text-foreground">{r.approved_by}</span></> : null}
                {r.rejection_reason ? <> · {t('pj.rejection_reason_label')} <span className="text-destructive">{r.rejection_reason}</span></> : null}
              </div>
              {r.status === 'Prepared' && (
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => reject.mutate(period)} disabled={reject.isPending}><XCircle className="size-4" /> {t('pj.btn_reject')}</Button>
                  <Button size="sm" onClick={() => approve.mutate(period)} disabled={approve.isPending}><CheckCircle2 className="size-4" /> {t('pj.btn_approve_not_preparer')}</Button>
                </div>
              )}
            </div>
          </Card>
        </div>
      )}

      {/* Portfolio governance roll-up for the period (PMO-3) */}
      {sum && (
        <Card className="mb-5 gap-3 p-5">
          <h3 className="text-base font-semibold">{t('pj.portfolio_gov_period', { period: packQ.data.period })}</h3>
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <StatCard label={t('pj.green')} value={sum.green} icon={ShieldCheck} tone="success" />
            <StatCard label={t('pj.yellow')} value={sum.amber} icon={ShieldAlert} tone="warning" />
            <StatCard label={t('pj.red')} value={sum.red} icon={ShieldAlert} tone={sum.red > 0 ? 'danger' : 'default'} />
            <StatCard label={t('pj.high_unmitigated')} value={sum.unmitigated_high} icon={ShieldAlert} tone={sum.unmitigated_high > 0 ? 'danger' : 'default'} />
            <StatCard label={t('pj.overdue_ms')} value={sum.overdue_milestones} icon={Clock} tone={sum.overdue_milestones > 0 ? 'warning' : 'default'} />
            <StatCard label={t('pj.pending_co')} value={sum.pending_change_orders} icon={ClipboardCheck} tone={sum.pending_change_orders > 0 ? 'warning' : 'default'} />
          </div>
          <DataTable
            rows={packQ.data.projects ?? []}
            rowKey={(x: any) => x.project_code}
            onRowClick={(x: any) => router.push(`/projects/${encodeURIComponent(x.project_code)}/status`)}
            columns={[
              { key: 'rag', label: t('pj.col_level'), sortable: false, render: (x: any) => ragBadge(x.rag) },
              { key: 'project_code', label: t('pj.col_code') },
              { key: 'name', label: t('pj.col_project') },
              { key: 'cpi', label: 'CPI', align: 'right', render: (x: any) => x.cpi ?? '—' },
              { key: 'spi', label: 'SPI', align: 'right', render: (x: any) => x.spi ?? '—' },
              { key: 'wip', label: 'WIP', align: 'right', render: (x: any) => <span className="tabular">{baht(x.wip)}</span> },
              { key: 'open_high_risks', label: t('pj.col_high_risks'), align: 'right' },
              { key: 'overdue_milestones', label: t('pj.col_overdue'), align: 'right' },
              { key: 'pending_change_orders', label: t('pj.col_pending_co'), align: 'right' },
            ]}
            emptyState={{ icon: FolderKanban, title: t('pj.empty_projects_title'), description: t('pj.empty_gov_desc') }}
          />
        </Card>
      )}

      {/* History of close reviews */}
      <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('pj.close_history')}</h3>
      <StateView q={listQ}>
        {listQ.data && (
          <DataTable
            rows={listQ.data.reviews ?? []}
            rowKey={(x: any) => x.period}
            onRowClick={(x: any) => setPeriod(x.period)}
            columns={[
              { key: 'period', label: t('pj.col_period') },
              { key: 'status', label: t('fin.col_status'), render: (x: any) => <Badge variant={statusVariant(x.status)}>{x.status}</Badge> },
              { key: 'wip_total', label: 'WIP', align: 'right', render: (x: any) => <span className="tabular">{baht(x.wip_total)}</span> },
              { key: 'clearing_balance', label: t('pj.col_clearing'), align: 'right', render: (x: any) => <span className={`tabular ${Math.abs(x.clearing_balance) > 0 ? 'text-warning-foreground dark:text-warning' : ''}`}>{baht(x.clearing_balance)}</span> },
              { key: 'open_projects', label: t('pj.open_th'), align: 'right' },
              { key: 'prepared_by', label: t('pj.prepared_by'), render: (x: any) => x.prepared_by ?? '—' },
              { key: 'approved_by', label: t('pj.approved_by'), render: (x: any) => x.approved_by ?? '—' },
            ]}
            emptyState={{ icon: Lock, title: t('pj.empty_close_title'), description: t('pj.empty_close_desc') }}
          />
        )}
      </StateView>
    </div>
  );
}
