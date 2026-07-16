'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, Plane, Check, CalendarClock, Play } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { baht, num } from '@/lib/format';
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
import { Select } from '@/components/form-controls';

const today = () => new Date().toISOString().slice(0, 10);

export default function HcmPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('hr.hcm_title')} description={t('hr.hcm_subtitle')} />
      <Tabs tabs={[
        { key: 'time', label: t('hr.tab_time_ot'), content: <Timesheets /> },
        { key: 'leave', label: t('hr.tab_leave'), content: <Leave /> },
        { key: 'accrual', label: t('hr.tab_accrual'), content: <LeaveAccrual /> },
        { key: 'team-attendance', label: t('hr.tab_team_attendance'), content: <TeamAttendance /> },
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
            <Select className="w-56"  value={f.project_code} onChange={(e) => setF({ ...f, project_code: e.target.value, task_id: '' })}>
              <option value="">{t('hr.no_project')}</option>
              {(projQ.data?.projects ?? []).map((p: any) => <option key={p.project_code} value={p.project_code}>{p.project_code} · {p.name}</option>)}
            </Select>
          </div>
          {!!f.project_code && (
            <div className="grid gap-1.5"><Label>{t('hr.task_wbs')}</Label>
              <Select className="w-56"  value={f.task_id} onChange={(e) => setF({ ...f, task_id: e.target.value })}>
                <option value="">{t('hr.whole_project')}</option>
                {(tasksQ.data?.tasks ?? []).map((tk: any) => <option key={tk.id} value={String(tk.id)}>{tk.name}</option>)}
              </Select>
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
          <div className="grid gap-1.5"><Label>{t('hr.type')}</Label><Select value={f.leave_type} onChange={(e) => setF({ ...f, leave_type: e.target.value })}><option value="annual">{t('hr.leave_annual')}</option><option value="sick">{t('hr.leave_sick')}</option><option value="personal">{t('hr.leave_personal')}</option><option value="unpaid">{t('hr.leave_unpaid')}</option></Select></div>
          <div className="grid gap-1.5"><Label>{t('hr.from')}</Label><Input type="date" value={f.from_date} onChange={(e) => setF({ ...f, from_date: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('hr.to')}</Label><Input type="date" value={f.to_date} onChange={(e) => setF({ ...f, to_date: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('hr.days_count')}</Label><Input type="number" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} className="w-24" /></div>
          <div className="grid gap-1.5"><Label>{t('hr.paid_q')}</Label><Select value={f.paid} onChange={(e) => setF({ ...f, paid: e.target.value })}><option value="true">{t('hr.paid')}</option><option value="false">{t('hr.unpaid')}</option></Select></div>
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

// HR-2 (docs/42) — leave entitlement / accrual: balances, leave-type + policy config, and the periodic
// accrual run (control HR-02). Config + run require hr_admin/exec; reads hr/hr_admin/exec/ess.
function LeaveAccrual() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [empCode, setEmpCode] = useState('');
  const balancesQ = useQuery<any>({ queryKey: ['leave-balances', empCode], queryFn: () => api(`/api/hcm/leave/balances${empCode ? `?emp_code=${encodeURIComponent(empCode)}` : ''}`) });
  const typesQ = useQuery<any>({ queryKey: ['leave-types'], queryFn: () => api('/api/hcm/leave/types') });
  const policiesQ = useQuery<any>({ queryKey: ['leave-policies'], queryFn: () => api('/api/hcm/leave/policies') });

  const [tf, setTf] = useState({ code: '', name: '', accrual_method: 'monthly', accrual_rate_days: '', carryover_cap_days: '', max_balance_days: '' });
  const addType = useMutation({
    mutationFn: () => api('/api/hcm/leave/types', { method: 'POST', body: JSON.stringify({ code: tf.code, name: tf.name || tf.code, accrual_method: tf.accrual_method, accrual_rate_days: Number(tf.accrual_rate_days) || 0, carryover_cap_days: Number(tf.carryover_cap_days) || 0, max_balance_days: Number(tf.max_balance_days) || 0 }) }),
    onSuccess: () => { notifySuccess(t('hr.accrual_type_saved')); setTf({ ...tf, code: '', name: '', accrual_rate_days: '' }); qc.invalidateQueries({ queryKey: ['leave-types'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const [pf, setPf] = useState({ leave_type_code: '', job_grade: '', min_tenure_months: '', accrual_rate_days: '' });
  const addPolicy = useMutation({
    mutationFn: () => api('/api/hcm/leave/policies', { method: 'POST', body: JSON.stringify({ leave_type_code: pf.leave_type_code, job_grade: pf.job_grade || null, min_tenure_months: Number(pf.min_tenure_months) || 0, accrual_rate_days: Number(pf.accrual_rate_days) || 0 }) }),
    onSuccess: () => { notifySuccess(t('hr.accrual_policy_saved')); setPf({ ...pf, job_grade: '', min_tenure_months: '', accrual_rate_days: '' }); qc.invalidateQueries({ queryKey: ['leave-policies'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const [period, setPeriod] = useState(today().slice(0, 7));
  const runAccrual = useMutation({
    mutationFn: () => api<any>('/api/hcm/leave/accrual/run', { method: 'POST', body: JSON.stringify({ period }) }),
    onSuccess: (r: any) => { notifySuccess(t('hr.accrual_ran', { accrued: r.accrued, count: r.employees_count })); qc.invalidateQueries({ queryKey: ['leave-balances'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="grid gap-5">
      {/* Accrual run + leave-type config */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="gap-3 p-5">
          <h3 className="text-base font-semibold">{t('hr.accrual_run_title')}</h3>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5"><Label>{t('hr.period')}</Label><Input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-06" className="w-32" /></div>
            <Button onClick={() => runAccrual.mutate()} disabled={runAccrual.isPending}><Play className="size-4" /> {t('hr.accrual_run_btn')}</Button>
          </div>
        </Card>
        <Card className="gap-3 p-5">
          <h3 className="text-base font-semibold">{t('hr.accrual_types_title')}</h3>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5"><Label>{t('hr.col_code')}</Label><Input value={tf.code} onChange={(e) => setTf({ ...tf, code: e.target.value })} className="w-28" placeholder="ANNUAL" /></div>
            <div className="grid gap-1.5"><Label>{t('hr.name_label')}</Label><Input value={tf.name} onChange={(e) => setTf({ ...tf, name: e.target.value })} className="w-32" /></div>
            <div className="grid gap-1.5"><Label>{t('hr.col_method')}</Label><Select value={tf.accrual_method} onChange={(e) => setTf({ ...tf, accrual_method: e.target.value })}><option value="monthly">monthly</option><option value="anniversary">anniversary</option><option value="none">none</option></Select></div>
            <div className="grid gap-1.5"><Label>{t('hr.col_rate')}</Label><Input type="number" value={tf.accrual_rate_days} onChange={(e) => setTf({ ...tf, accrual_rate_days: e.target.value })} className="w-20" /></div>
            <div className="grid gap-1.5"><Label>{t('hr.col_carryover_cap')}</Label><Input type="number" value={tf.carryover_cap_days} onChange={(e) => setTf({ ...tf, carryover_cap_days: e.target.value })} className="w-20" /></div>
            <div className="grid gap-1.5"><Label>{t('hr.col_max_balance')}</Label><Input type="number" value={tf.max_balance_days} onChange={(e) => setTf({ ...tf, max_balance_days: e.target.value })} className="w-20" /></div>
            <Button variant="outline" onClick={() => addType.mutate()} disabled={!tf.code || addType.isPending}><Check className="size-4" /> {t('fin.save')}</Button>
          </div>
          <StateView q={typesQ}>{typesQ.data && <DataTable rows={typesQ.data.leave_types} columns={[
            { key: 'code', label: t('hr.col_code') }, { key: 'accrual_method', label: t('hr.col_method') },
            { key: 'accrual_rate_days', label: t('hr.col_rate'), align: 'right' }, { key: 'carryover_cap_days', label: t('hr.col_carryover_cap'), align: 'right' }, { key: 'max_balance_days', label: t('hr.col_max_balance'), align: 'right' },
          ]} emptyState={{ icon: CalendarClock, title: t('hr.accrual_types_title'), description: '' }} />}</StateView>
        </Card>
      </div>

      {/* Policy overrides */}
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hr.accrual_policies_title')}</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5"><Label>{t('hr.col_code')}</Label>
            <Select value={pf.leave_type_code} onChange={(e) => setPf({ ...pf, leave_type_code: e.target.value })}>
              <option value="">—</option>
              {(typesQ.data?.leave_types ?? []).map((x: any) => <option key={x.code} value={x.code}>{x.code}</option>)}
            </Select>
          </div>
          <div className="grid gap-1.5"><Label>{t('hr.col_grade')}</Label><Input value={pf.job_grade} onChange={(e) => setPf({ ...pf, job_grade: e.target.value })} className="w-24" placeholder="M2" /></div>
          <div className="grid gap-1.5"><Label>{t('hr.col_min_tenure')}</Label><Input type="number" value={pf.min_tenure_months} onChange={(e) => setPf({ ...pf, min_tenure_months: e.target.value })} className="w-24" /></div>
          <div className="grid gap-1.5"><Label>{t('hr.col_rate')}</Label><Input type="number" value={pf.accrual_rate_days} onChange={(e) => setPf({ ...pf, accrual_rate_days: e.target.value })} className="w-20" /></div>
          <Button variant="outline" onClick={() => addPolicy.mutate()} disabled={!pf.leave_type_code || addPolicy.isPending}><Check className="size-4" /> {t('fin.save')}</Button>
        </div>
        <StateView q={policiesQ}>{policiesQ.data && <DataTable rows={policiesQ.data.leave_policies} columns={[
          { key: 'leave_type_code', label: t('hr.col_code') }, { key: 'job_grade', label: t('hr.col_grade'), render: (r: any) => r.job_grade ?? '—' },
          { key: 'min_tenure_months', label: t('hr.col_min_tenure'), align: 'right' }, { key: 'accrual_rate_days', label: t('hr.col_rate'), align: 'right' },
        ]} emptyState={{ icon: CalendarClock, title: t('hr.accrual_policies_title'), description: '' }} />}</StateView>
      </Card>

      {/* Balances */}
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hr.accrual_balances_title')}</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5"><Label>{t('hr.emp_code')}</Label><Input value={empCode} onChange={(e) => setEmpCode(e.target.value)} className="w-36" placeholder="EMP..." /></div>
        </div>
        <StateView q={balancesQ}>{balancesQ.data && <DataTable rows={balancesQ.data.balances} columns={[
          { key: 'employee_id', label: '#' }, { key: 'leave_type_code', label: t('hr.col_code') }, { key: 'year', label: t('hr.col_year') },
          { key: 'accrued', label: t('hr.col_accrued'), align: 'right' }, { key: 'carryover', label: t('hr.col_carryover'), align: 'right' },
          { key: 'used', label: t('hr.day_unit'), align: 'right', render: (r: any) => r.used },
          { key: 'available', label: t('hr.col_available'), align: 'right', render: (r: any) => <Badge variant={r.available > 0 ? 'success' : 'muted'}>{r.available}</Badge> },
        ]} emptyState={{ icon: CalendarClock, title: t('hr.accrual_balances_title'), description: '' }} />}</StateView>
      </Card>
    </div>
  );
}

// Team attendance — the whole team's clock-in/out rolled up from the POS time-clock (GET /api/hcm/attendance),
// so an HR manager sees who worked and who is on the clock now. Read-only; optional single-day filter.
function TeamAttendance() {
  const { t } = useLang();
  const [date, setDate] = useState('');
  const q = useQuery<any>({ queryKey: ['hcm-team-attendance', date], queryFn: () => api(`/api/hcm/attendance${date ? `?date=${encodeURIComponent(date)}` : ''}`) });
  const s = q.data?.summary;
  const rows = q.data?.employees ?? [];
  const fmt = (x: string | null) => (x ? new Date(x).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—');

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="gap-1 p-5"><div className="text-sm text-muted-foreground">{t('hr.ta_employees')}</div><div className="text-2xl font-semibold tabular">{num(s?.employees ?? 0)}</div></Card>
        <Card className="gap-1 p-5"><div className="text-sm text-muted-foreground">{t('hr.ta_clocked_in_now')}</div><div className="text-2xl font-semibold tabular">{num(s?.currently_clocked_in ?? 0)}</div></Card>
        <Card className="gap-1 p-5"><div className="text-sm text-muted-foreground">{t('hr.ta_total_hours')}</div><div className="text-2xl font-semibold tabular">{num(s?.total_hours ?? 0)}</div></Card>
      </div>
      <Card className="gap-3 p-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5"><Label>{t('dash.col_date')}</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" /></div>
        </div>
        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={rows}
              rowKey={(r: any) => r.emp_code}
              emptyState={{ icon: Clock, title: t('hr.ta_empty_title'), description: t('hr.ta_empty_desc') }}
              columns={[
                { key: 'emp_code', label: t('hr.ta_col_employee'), render: (r: any) => <span>{r.name ?? r.emp_code}{r.name && <span className="ml-1 text-xs text-muted-foreground">{r.emp_code}</span>}</span> },
                { key: 'sessions', label: t('hr.ta_col_sessions'), align: 'right', render: (r: any) => <span className="tabular">{num(r.sessions)}</span> },
                { key: 'total_hours', label: t('hr.ta_col_hours'), align: 'right', render: (r: any) => <span className="tabular">{num(r.total_hours)}</span> },
                { key: 'last_clock_in', label: t('hr.ta_col_last'), render: (r: any) => fmt(r.last_clock_in) },
                { key: 'status', label: t('hr.ta_col_status'), render: (r: any) => (r.currently_clocked_in ? <Badge variant="success">{t('hr.att_clocked_in')}</Badge> : <Badge variant="muted">{t('hr.att_clocked_out')}</Badge>) },
              ]}
            />
          )}
        </StateView>
        <p className="text-xs text-muted-foreground">{t('hr.att_source_note')}</p>
      </Card>
    </div>
  );
}
