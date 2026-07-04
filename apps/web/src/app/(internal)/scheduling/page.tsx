'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarRange, Clock, Percent, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { baht, num, thaiDate } from '@/lib/format';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { FormField } from '@/components/form-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { notifySuccess, notifyError } from '@/lib/notify';

// W4 — shift scheduling / roster + labor %.
interface Shift { id: number; emp_code: string; shift_date: string; start_time: string; end_time: string; hours: number; hourly_rate: number; position: string | null; status: string }
interface Summary { from: string; to: string; scheduled_hours: number; scheduled_cost: number; actual_hours: number; hours_variance: number; sales: number; labor_pct: number; by_staff: { emp_code: string; hours: number; cost: number; shifts: number }[] }

function weekStart() { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); }
function addDays(d: string, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); }

export default function SchedulingPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [from, setFrom] = useState(weekStart());
  const to = addDays(from, 6);
  const shifts = useQuery<{ shifts: Shift[]; count: number }>({ queryKey: ['shifts', from, to], queryFn: () => api(`/api/pos/labor/shifts?from=${from}&to=${to}`) });
  const summary = useQuery<Summary>({ queryKey: ['labor-summary', from, to], queryFn: () => api(`/api/pos/labor/labor-summary?from=${from}&to=${to}`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['shifts'] }); qc.invalidateQueries({ queryKey: ['labor-summary'] }); };

  const [form, setForm] = useState({ emp_code: '', shift_date: from, start_time: '09:00', end_time: '17:00', hourly_rate: '', position: '' });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const create = useMutation({
    mutationFn: () => api('/api/pos/labor/shifts', { method: 'POST', body: JSON.stringify({ emp_code: form.emp_code, shift_date: form.shift_date, start_time: form.start_time, end_time: form.end_time, hourly_rate: form.hourly_rate ? Number(form.hourly_rate) : undefined, position: form.position || undefined }) }),
    onSuccess: () => { notifySuccess(t('hx.sched.shift_added')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const cancel = useMutation({
    mutationFn: (id: number) => api(`/api/pos/labor/shifts/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('hx.sched.shift_cancelled')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const alerts = useQuery<{ alerts: any[]; count: number }>({ queryKey: ['labor-alerts'], queryFn: () => api('/api/pos/labor/alerts?resolved=false') });
  const checkAlert = useMutation({
    mutationFn: () => api('/api/pos/labor/labor-alert/check', { method: 'POST', body: JSON.stringify({ from, to, threshold: 35 }) }),
    onSuccess: (r: any) => { notifySuccess(r?.exceeded ? t('hx.sched.labor_over', { pct: num(r.labor_pct) }) : t('hx.sched.labor_within', { pct: num(r.labor_pct) })); qc.invalidateQueries({ queryKey: ['labor-alerts'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const resolveAlert = useMutation({
    mutationFn: (id: number) => api(`/api/pos/labor/alerts/${id}/resolve`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('hx.labor.alert_resolved')); qc.invalidateQueries({ queryKey: ['labor-alerts'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const sm = summary.data;
  return (
    <ModulePage
      title={t('hx.sched.title')}
      description={t('hx.sched.desc')}
      query={shifts}
      stats={sm && (
        <>
          <StatCard label={t('hx.sched.labor_pct_label')} value={`${num(sm.labor_pct)}%`} icon={Percent} tone={sm.labor_pct > 30 ? 'danger' : sm.labor_pct > 0 ? 'warning' : 'default'} hint={t('hx.sched.labor_pct_hint')} />
          <StatCard label={t('hx.sched.sched_hours')} value={num(sm.scheduled_hours)} icon={Clock} tone="primary" hint={t('hx.sched.actual_hint', { h: num(sm.actual_hours) })} />
          <StatCard label={t('hx.sched.sched_cost')} value={baht(sm.scheduled_cost)} icon={Users} tone="default" />
          <StatCard label={t('hx.sched.sales_period')} value={baht(sm.sales)} icon={CalendarRange} tone="default" />
        </>
      )}
      statsClassName="xl:grid-cols-4"
    >
      <div className="mb-4 flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setFrom(addDays(from, -7))}>{t('hx.sched.prev_week')}</Button>
        <span className="text-sm font-medium">{thaiDate(from)} – {thaiDate(to)}</span>
        <Button size="sm" variant="outline" onClick={() => setFrom(addDays(from, 7))}>{t('hx.sched.next_week')}</Button>
        <Button size="sm" variant="outline" disabled={checkAlert.isPending} onClick={() => checkAlert.mutate()}>{t('hx.sched.check_labor')}</Button>
      </div>

      {(alerts.data?.alerts?.length ?? 0) > 0 && (
        <div className="mb-4 space-y-2">
          {alerts.data!.alerts.map((a) => (
            <div key={a.id} className="flex items-center justify-between rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-2 text-sm">
              <span>⚠️ {t('hx.sched.alert_pre')} <b>{num(a.actual_pct)}%</b> {t('hx.sched.alert_mid', { threshold: num(a.threshold_pct) })} · {t('hx.sched.alert_period', { from: a.period_from, to: a.period_to })}</span>
              <Button size="sm" variant="ghost" onClick={() => resolveAlert.mutate(a.id)}>{t('hx.common.close')}</Button>
            </div>
          ))}
        </div>
      )}

      <div className="mb-4 rounded-xl border bg-card p-4">
        <h3 className="mb-3 text-sm font-semibold">{t('hx.sched.add_shift_title')}</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <FormField label={t('hx.sched.emp_code')}><Input value={form.emp_code} onChange={(e) => set('emp_code', e.target.value)} placeholder={t('hx.sched.emp_code_ph')} /></FormField>
          <FormField label={t('dash.col_date')}><Input type="date" value={form.shift_date} onChange={(e) => set('shift_date', e.target.value)} /></FormField>
          <FormField label={t('hx.sched.start')}><Input type="time" value={form.start_time} onChange={(e) => set('start_time', e.target.value)} /></FormField>
          <FormField label={t('hx.sched.end')}><Input type="time" value={form.end_time} onChange={(e) => set('end_time', e.target.value)} /></FormField>
          <FormField label={t('hx.sched.hourly_rate')}><Input type="number" min={0} value={form.hourly_rate} onChange={(e) => set('hourly_rate', e.target.value)} /></FormField>
          <div className="flex items-end"><Button disabled={create.isPending || !form.emp_code} onClick={() => create.mutate()}>{t('hx.sched.add_shift_btn')}</Button></div>
        </div>
      </div>

      {shifts.data && (
        <DataTable
          rows={shifts.data.shifts}
          rowKey={(r) => r.id}
          emptyState={{ icon: CalendarRange, title: t('hx.sched.empty_title'), description: t('hx.sched.empty_desc') }}
          columns={[
            { key: 'shift_date', label: t('dash.col_date'), render: (r) => thaiDate(r.shift_date) },
            { key: 'emp_code', label: t('hx.sched.col_emp'), render: (r) => <span className="font-medium">{r.emp_code}</span> },
            { key: 'position', label: t('hx.sched.col_position'), render: (r) => r.position || '—' },
            { key: 'time', label: t('hx.sched.col_time'), render: (r) => `${r.start_time}–${r.end_time}` },
            { key: 'hours', label: t('hx.sched.col_hours'), align: 'right', render: (r) => num(r.hours) },
            { key: 'cost', label: t('hx.sched.col_cost'), align: 'right', render: (r) => baht(r.hours * r.hourly_rate) },
            { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={r.status === 'cancelled' ? 'muted' : 'info'}>{r.status === 'cancelled' ? t('hx.sched.st_cancelled') : t('hx.sched.st_scheduled')}</Badge> },
            { key: 'actions', label: '', align: 'right', render: (r) => r.status !== 'cancelled' ? <Button size="sm" variant="ghost" onClick={() => cancel.mutate(r.id)}>{t('fin.cancel')}</Button> : null },
          ]}
        />
      )}
    </ModulePage>
  );
}
