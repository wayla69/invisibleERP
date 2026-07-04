'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, Plane, Check } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

const selectCls = 'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';
const today = () => new Date().toISOString().slice(0, 10);

export default function HcmPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('hr.hcm_title')} description={t('hr.hcm_subtitle')} />
      <Tabs tabs={[
        { key: 'time', label: t('hr.tab_time_ot'), content: <Timesheets /> },
        { key: 'leave', label: t('hr.tab_leave'), content: <Leave /> },
      ]} />
    </div>
  );
}

function Timesheets() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['timesheets'], queryFn: () => api('/api/hcm/timesheets') });
  // Project spine (PROJ-04): allocate billable time to a project/task so approval posts project labour → WIP.
  const projQ = useQuery<any>({ queryKey: ['ts-projects'], queryFn: () => api('/api/projects') });
  const [f, setF] = useState({ emp_code: '', work_date: today(), regular_hours: '', ot_hours: '', project_code: '', task_id: '', billable: true });
  const tasksQ = useQuery<any>({ queryKey: ['ts-tasks', f.project_code], queryFn: () => api(`/api/projects/${encodeURIComponent(f.project_code)}/tasks`), enabled: !!f.project_code });
  const add = useMutation({
    mutationFn: () => api('/api/hcm/timesheets', { method: 'POST', body: JSON.stringify({ emp_code: f.emp_code, work_date: f.work_date, regular_hours: Number(f.regular_hours) || 0, ot_hours: Number(f.ot_hours) || 0, project_code: f.project_code || undefined, task_id: f.task_id ? Number(f.task_id) : undefined, billable: f.billable }) }),
    onSuccess: () => { notifySuccess(t('hr.ts_saved')); setF({ ...f, regular_hours: '', ot_hours: '' }); qc.invalidateQueries({ queryKey: ['timesheets'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  // Maker-checker approval (PROJ-04): an approver ≠ submitter signs off; billable project time then posts to WIP.
  const approve = useMutation({
    mutationFn: (id: number) => api<any>(`/api/hcm/timesheets/${id}/approve`, { method: 'POST', body: '{}' }),
    onSuccess: (r: any) => { notifySuccess(r?.project_posted ? t('hr.ts_approved_posted', { cost: baht(r.labor_cost), entry: r.entry_no }) : t('fin.approved')); qc.invalidateQueries({ queryKey: ['timesheets'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hr.ts_form_title')}</h3>
        <div className="flex flex-wrap gap-3">
          <div className="grid gap-1.5"><Label>{t('hr.emp_code')}</Label><Input value={f.emp_code} onChange={(e) => setF({ ...f, emp_code: e.target.value })} className="w-36" placeholder="EMP..." /></div>
          <div className="grid gap-1.5"><Label>{t('dash.col_date')}</Label><Input type="date" value={f.work_date} onChange={(e) => setF({ ...f, work_date: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('hr.regular_hours_short')}</Label><Input type="number" value={f.regular_hours} onChange={(e) => setF({ ...f, regular_hours: e.target.value })} className="w-24" /></div>
          <div className="grid gap-1.5"><Label>{t('hr.ot_hours_short')}</Label><Input type="number" value={f.ot_hours} onChange={(e) => setF({ ...f, ot_hours: e.target.value })} className="w-24" /></div>
        </div>
        {/* PROJ-04 — allocate to a project & task (optional). Billable project time posts to WIP on approval. */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5"><Label>{t('hr.project_optional')}</Label>
            <select className={`${selectCls} w-56`} value={f.project_code} onChange={(e) => setF({ ...f, project_code: e.target.value, task_id: '' })}>
              <option value="">{t('hr.no_project')}</option>
              {(projQ.data?.projects ?? []).map((p: any) => <option key={p.project_code} value={p.project_code}>{p.project_code} · {p.name}</option>)}
            </select>
          </div>
          {!!f.project_code && (
            <div className="grid gap-1.5"><Label>{t('hr.task_wbs')}</Label>
              <select className={`${selectCls} w-56`} value={f.task_id} onChange={(e) => setF({ ...f, task_id: e.target.value })}>
                <option value="">{t('hr.whole_project')}</option>
                {(tasksQ.data?.tasks ?? []).map((tk: any) => <option key={tk.id} value={String(tk.id)}>{tk.name}</option>)}
              </select>
            </div>
          )}
          {!!f.project_code && (
            <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={f.billable} onChange={(e) => setF({ ...f, billable: e.target.checked })} /> {t('hr.billable_label')}</label>
          )}
        </div>
        <div className="flex items-center gap-3"><Button onClick={() => add.mutate()} disabled={!f.emp_code || add.isPending}><Clock className="size-4" /> {t('fin.save')}</Button></div>
      </Card>
      <StateView q={q}>{q.data && <DataTable rows={q.data.timesheets} columns={[
        { key: 'work_date', label: t('dash.col_date') },
        { key: 'project_code', label: t('hr.col_project'), render: (r: any) => r.project_code ? <Badge variant="secondary">{r.project_code}</Badge> : <span className="text-xs text-muted-foreground">—</span> },
        { key: 'regular_hours', label: t('hr.regular_hours_short'), align: 'right' }, { key: 'ot_hours', label: t('hr.ot_hours_short'), align: 'right' },
        { key: 'billable', label: t('hr.col_billable'), render: (r: any) => r.project_code ? (r.billable ? <Badge variant="success">billable</Badge> : <Badge variant="muted">non-billable</Badge>) : '—' },
        { key: 'status', label: t('fin.col_status'), render: (r: any) => r.status ? <Badge variant={statusVariant(r.status)}>{r.status}</Badge> : '—' },
        { key: 'act', label: '', sortable: false, render: (r: any) => r.status === 'Pending' ? <Button size="sm" variant="outline" disabled={approve.isPending} onClick={() => approve.mutate(r.id)}><Check className="size-4" /> {t('fin.approve')}</Button> : (r.entry_no ? <span className="text-xs text-muted-foreground">{r.entry_no}</span> : <span className="text-xs text-muted-foreground">—</span>) },
      ]} emptyState={{ icon: Clock, title: t('hr.ts_empty_title'), description: t('hr.ts_empty_desc') }} />}</StateView>
    </div>
  );
}

function Leave() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['leave'], queryFn: () => api('/api/hcm/leave') });
  const [f, setF] = useState({ emp_code: '', leave_type: 'annual', from_date: today(), to_date: today(), days: '', paid: 'true' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['leave'] });
  const req = useMutation({
    mutationFn: () => api('/api/hcm/leave', { method: 'POST', body: JSON.stringify({ emp_code: f.emp_code, leave_type: f.leave_type, from_date: f.from_date, to_date: f.to_date, days: Number(f.days) || 0, paid: f.paid === 'true' }) }),
    onSuccess: () => { notifySuccess(t('hr.leave_submitted')); setF({ ...f, days: '' }); refresh(); }, onError: (e: any) => notifyError(e.message),
  });
  const approve = useMutation({ mutationFn: (id: number) => api(`/api/hcm/leave/${id}/approve`, { method: 'POST', body: JSON.stringify({}) }), onSuccess: refresh });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hr.leave_request_title')}</h3>
        <div className="flex flex-wrap gap-3">
          <div className="grid gap-1.5"><Label>{t('hr.emp_code')}</Label><Input value={f.emp_code} onChange={(e) => setF({ ...f, emp_code: e.target.value })} className="w-36" /></div>
          <div className="grid gap-1.5"><Label>{t('hr.type')}</Label><select className={selectCls} value={f.leave_type} onChange={(e) => setF({ ...f, leave_type: e.target.value })}><option value="annual">{t('hr.leave_annual')}</option><option value="sick">{t('hr.leave_sick')}</option><option value="personal">{t('hr.leave_personal')}</option><option value="unpaid">{t('hr.leave_unpaid')}</option></select></div>
          <div className="grid gap-1.5"><Label>{t('hr.from')}</Label><Input type="date" value={f.from_date} onChange={(e) => setF({ ...f, from_date: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('hr.to')}</Label><Input type="date" value={f.to_date} onChange={(e) => setF({ ...f, to_date: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('hr.days_count')}</Label><Input type="number" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} className="w-24" /></div>
          <div className="grid gap-1.5"><Label>{t('hr.paid_q')}</Label><select className={selectCls} value={f.paid} onChange={(e) => setF({ ...f, paid: e.target.value })}><option value="true">{t('hr.paid')}</option><option value="false">{t('hr.unpaid')}</option></select></div>
        </div>
        <div className="flex items-center gap-3"><Button onClick={() => req.mutate()} disabled={!f.emp_code || !f.days || req.isPending}><Plane className="size-4" /> {t('hr.leave_submit_btn')}</Button></div>
      </Card>
      <StateView q={q}>{q.data && <DataTable rows={q.data.leave_requests} columns={[
        { key: 'leave_type', label: t('hr.type') }, { key: 'from_date', label: t('hr.from') }, { key: 'to_date', label: t('hr.to') }, { key: 'days', label: t('hr.day_unit'), align: 'right' },
        { key: 'paid', label: t('hr.col_paid'), render: (r: any) => (r.paid ? t('hr.paid_short_yes') : t('hr.paid_short_no')) },
        { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
        { key: 'act', label: '', sortable: false, render: (r: any) => r.status === 'Pending' ? <Button size="sm" variant="outline" disabled={approve.isPending} onClick={() => approve.mutate(r.id)}><Check className="size-4" /> {t('fin.approve')}</Button> : <span className="text-xs text-muted-foreground">—</span> },
      ]} emptyState={{ icon: Plane, title: t('hr.leave_empty_title'), description: t('hr.leave_empty_desc') }} />}</StateView>
    </div>
  );
}
