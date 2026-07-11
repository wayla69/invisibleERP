'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Coins, ShieldAlert, Plus, HeartPulse, ArrowRightLeft } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
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

// HR-6 (docs/42, Wave 2) — compensation bands + benefits with the HR-06 comp-change maker-checker within band.
// Reads gate hr/hr_admin/exec; writes hr/hr_admin; approvals hr_admin/exec (an out-of-band change needs the
// explicit override → OUT_OF_BAND otherwise; the approver must differ from the requester → SOD_SELF_APPROVAL).
export default function CompClient({ initialGrades }: { initialGrades?: any }) {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('hx.comp.title')} description={t('hx.comp.subtitle')} />
      <Tabs tabs={[
        { key: 'grades', label: t('hx.comp.tab_grades'), content: <Grades initialGrades={initialGrades} /> },
        { key: 'changes', label: t('hx.comp.tab_changes'), content: <Changes /> },
        { key: 'plans', label: t('hx.comp.tab_plans'), content: <Plans /> },
        { key: 'enrollments', label: t('hx.comp.tab_enrollments'), content: <Enrollments /> },
      ]} />
    </div>
  );
}

function Grades({ initialGrades }: { initialGrades?: any }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['comp-grades'], queryFn: () => api('/api/hcm/comp/grades'), initialData: initialGrades });
  const [f, setF] = useState({ grade_code: '', name: '', min_salary: '', mid_salary: '', max_salary: '' });
  const add = useMutation({
    mutationFn: () => api('/api/hcm/comp/grades', { method: 'POST', body: JSON.stringify({ grade_code: f.grade_code, name: f.name, min_salary: Number(f.min_salary) || 0, mid_salary: Number(f.mid_salary) || 0, max_salary: Number(f.max_salary) || 0 }) }),
    onSuccess: () => { notifySuccess(t('hx.comp.grade_saved')); setF({ grade_code: '', name: '', min_salary: '', mid_salary: '', max_salary: '' }); qc.invalidateQueries({ queryKey: ['comp-grades'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hx.comp.new_grade')}</h3>
        <div className="flex flex-wrap gap-3">
          <div className="grid gap-1.5"><Label>{t('hx.comp.grade_code')}</Label><Input value={f.grade_code} onChange={(e) => setF({ ...f, grade_code: e.target.value })} className="w-28" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.org.name')}</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className="w-44" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.comp.min_salary')}</Label><Input type="number" value={f.min_salary} onChange={(e) => setF({ ...f, min_salary: e.target.value })} className="w-28" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.comp.mid_salary')}</Label><Input type="number" value={f.mid_salary} onChange={(e) => setF({ ...f, mid_salary: e.target.value })} className="w-28" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.comp.max_salary')}</Label><Input type="number" value={f.max_salary} onChange={(e) => setF({ ...f, max_salary: e.target.value })} className="w-28" /></div>
        </div>
        <div><Button onClick={() => add.mutate()} disabled={!f.grade_code || !f.name || add.isPending}><Plus className="size-4" /> {t('fin.save')}</Button></div>
      </Card>
      <StateView q={q}>{q.data && <DataTable rows={q.data.grades} columns={[
        { key: 'grade_code', label: t('hx.comp.grade_code') }, { key: 'name', label: t('hx.org.name') },
        { key: 'min_salary', label: t('hx.comp.min_salary'), align: 'right' },
        { key: 'mid_salary', label: t('hx.comp.mid_salary'), align: 'right' },
        { key: 'max_salary', label: t('hx.comp.max_salary'), align: 'right' },
        { key: 'currency', label: t('hx.comp.currency') },
      ]} emptyState={{ icon: Coins, title: t('hx.comp.grade_empty'), description: t('hx.comp.new_grade') }} />}</StateView>
    </div>
  );
}

function Changes() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['comp-changes'], queryFn: () => api('/api/hcm/comp/changes') });
  const [f, setF] = useState({ emp_code: '', change_type: 'merit', new_salary: '', new_grade: '', reason: '', override: false });
  const add = useMutation({
    mutationFn: () => api<any>('/api/hcm/comp/changes', { method: 'POST', body: JSON.stringify({ emp_code: f.emp_code, change_type: f.change_type, new_salary: Number(f.new_salary) || 0, new_grade: f.new_grade || undefined, reason: f.reason || undefined, override: f.override || undefined }) }),
    onSuccess: (r: any) => { notifySuccess(r?.out_of_band_overridden ? t('hx.comp.change_overridden') : t('hx.comp.change_saved')); setF({ ...f, emp_code: '', new_salary: '', reason: '', override: false }); qc.invalidateQueries({ queryKey: ['comp-changes'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'approve' | 'reject' }) => api(`/api/hcm/comp/changes/${id}/${action}`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('hx.common.update_status')); qc.invalidateQueries({ queryKey: ['comp-changes'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hx.comp.new_change')}</h3>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><ShieldAlert className="size-3.5" /> {t('hx.comp.hr06_hint')}</p>
        <div className="flex flex-wrap gap-3">
          <div className="grid gap-1.5"><Label>{t('hr.emp_code')}</Label><Input value={f.emp_code} onChange={(e) => setF({ ...f, emp_code: e.target.value })} className="w-36" placeholder="EMP..." /></div>
          <div className="grid gap-1.5"><Label>{t('hx.comp.change_type')}</Label>
            <select className="h-9 rounded-md border bg-background px-2 text-sm" value={f.change_type} onChange={(e) => setF({ ...f, change_type: e.target.value })}>
              {['hire', 'merit', 'promotion', 'adjustment'].map((k) => <option key={k} value={k}>{t(`hx.comp.type_${k}`)}</option>)}
            </select>
          </div>
          <div className="grid gap-1.5"><Label>{t('hx.comp.new_salary')}</Label><Input type="number" value={f.new_salary} onChange={(e) => setF({ ...f, new_salary: e.target.value })} className="w-32" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.comp.target_grade')}</Label><Input value={f.new_grade} onChange={(e) => setF({ ...f, new_grade: e.target.value })} className="w-24" placeholder="G5" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.comp.reason')}</Label><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} className="w-48" /></div>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={f.override} onChange={(e) => setF({ ...f, override: e.target.checked })} /> {t('hx.comp.override_band')}</label>
        <div><Button onClick={() => add.mutate()} disabled={!f.emp_code || !f.new_salary || add.isPending}><Plus className="size-4" /> {t('hx.comp.request_btn')}</Button></div>
      </Card>
      <StateView q={q}>{q.data && <DataTable rows={q.data.changes} columns={[
        { key: 'emp_code', label: t('hr.emp_code') },
        { key: 'change_type', label: t('hx.comp.change_type'), render: (r: any) => t(`hx.comp.type_${r.change_type}`) },
        { key: 'new_salary', label: t('hx.comp.new_salary'), align: 'right' },
        { key: 'new_grade', label: t('hx.comp.target_grade'), render: (r: any) => r.new_grade ?? '—' },
        { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={r.status === 'approved' ? 'success' : r.status === 'rejected' ? 'destructive' : 'warning'}>{t(`hx.comp.st_${r.status}`)}</Badge> },
        { key: 'requested_by', label: t('hx.comp.requested_by'), render: (r: any) => r.requested_by ?? '—' },
        { key: 'actions', label: t('hx.common.actions'), render: (r: any) => r.status === 'pending' ? (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => act.mutate({ id: r.id, action: 'approve' })} disabled={act.isPending}>{t('hx.comp.approve')}</Button>
            <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: r.id, action: 'reject' })} disabled={act.isPending}>{t('hx.comp.reject')}</Button>
          </div>
        ) : '—' },
      ]} emptyState={{ icon: ArrowRightLeft, title: t('hx.comp.change_empty'), description: t('hx.comp.new_change') }} />}</StateView>
    </div>
  );
}

function Plans() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['comp-plans'], queryFn: () => api('/api/hcm/comp/benefit-plans') });
  const [f, setF] = useState({ plan_code: '', name: '', category: 'health', employer_cost: '', employee_cost: '' });
  const add = useMutation({
    mutationFn: () => api('/api/hcm/comp/benefit-plans', { method: 'POST', body: JSON.stringify({ plan_code: f.plan_code, name: f.name, category: f.category, employer_cost: Number(f.employer_cost) || 0, employee_cost: Number(f.employee_cost) || 0 }) }),
    onSuccess: () => { notifySuccess(t('hx.comp.plan_saved')); setF({ plan_code: '', name: '', category: 'health', employer_cost: '', employee_cost: '' }); qc.invalidateQueries({ queryKey: ['comp-plans'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hx.comp.new_plan')}</h3>
        <div className="flex flex-wrap gap-3">
          <div className="grid gap-1.5"><Label>{t('hx.comp.plan_code')}</Label><Input value={f.plan_code} onChange={(e) => setF({ ...f, plan_code: e.target.value })} className="w-28" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.org.name')}</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className="w-44" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.comp.category')}</Label>
            <select className="h-9 rounded-md border bg-background px-2 text-sm" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              {['health', 'dental', 'life', 'provident_fund', 'allowance'].map((k) => <option key={k} value={k}>{t(`hx.comp.cat_${k}`)}</option>)}
            </select>
          </div>
          <div className="grid gap-1.5"><Label>{t('hx.comp.employer_cost')}</Label><Input type="number" value={f.employer_cost} onChange={(e) => setF({ ...f, employer_cost: e.target.value })} className="w-28" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.comp.employee_cost')}</Label><Input type="number" value={f.employee_cost} onChange={(e) => setF({ ...f, employee_cost: e.target.value })} className="w-28" /></div>
        </div>
        <div><Button onClick={() => add.mutate()} disabled={!f.plan_code || !f.name || add.isPending}><Plus className="size-4" /> {t('fin.save')}</Button></div>
      </Card>
      <StateView q={q}>{q.data && <DataTable rows={q.data.plans} columns={[
        { key: 'plan_code', label: t('hx.comp.plan_code') }, { key: 'name', label: t('hx.org.name') },
        { key: 'category', label: t('hx.comp.category'), render: (r: any) => t(`hx.comp.cat_${r.category}`) },
        { key: 'employer_cost', label: t('hx.comp.employer_cost'), align: 'right' },
        { key: 'employee_cost', label: t('hx.comp.employee_cost'), align: 'right' },
      ]} emptyState={{ icon: HeartPulse, title: t('hx.comp.plan_empty'), description: t('hx.comp.new_plan') }} />}</StateView>
    </div>
  );
}

function Enrollments() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['comp-enrollments'], queryFn: () => api('/api/hcm/comp/enrollments') });
  const [f, setF] = useState({ emp_code: '', plan_code: '' });
  const add = useMutation({
    mutationFn: () => api('/api/hcm/comp/enrollments', { method: 'POST', body: JSON.stringify({ emp_code: f.emp_code, plan_code: f.plan_code }) }),
    onSuccess: () => { notifySuccess(t('hx.comp.enroll_saved')); setF({ emp_code: '', plan_code: '' }); qc.invalidateQueries({ queryKey: ['comp-enrollments'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const end = useMutation({
    mutationFn: (id: number) => api(`/api/hcm/comp/enrollments/${id}/end`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('hx.comp.enroll_ended')); qc.invalidateQueries({ queryKey: ['comp-enrollments'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hx.comp.new_enrollment')}</h3>
        <div className="flex flex-wrap gap-3">
          <div className="grid gap-1.5"><Label>{t('hr.emp_code')}</Label><Input value={f.emp_code} onChange={(e) => setF({ ...f, emp_code: e.target.value })} className="w-36" placeholder="EMP..." /></div>
          <div className="grid gap-1.5"><Label>{t('hx.comp.plan_code')}</Label><Input value={f.plan_code} onChange={(e) => setF({ ...f, plan_code: e.target.value })} className="w-32" /></div>
        </div>
        <div><Button onClick={() => add.mutate()} disabled={!f.emp_code || !f.plan_code || add.isPending}><Plus className="size-4" /> {t('hx.comp.enroll_btn')}</Button></div>
      </Card>
      <StateView q={q}>{q.data && <DataTable rows={q.data.enrollments} columns={[
        { key: 'emp_code', label: t('hr.emp_code') },
        { key: 'plan_code', label: t('hx.comp.plan_code'), render: (r: any) => r.plan_code ?? '—' },
        { key: 'enrolled_date', label: t('hx.comp.enrolled_date') },
        { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={r.active ? 'success' : 'muted'}>{r.active ? t('hx.common.active') : t('hx.comp.ended')}</Badge> },
        { key: 'actions', label: t('hx.common.actions'), render: (r: any) => r.active ? <Button size="sm" variant="ghost" onClick={() => end.mutate(r.id)} disabled={end.isPending}>{t('hx.comp.end_btn')}</Button> : '—' },
      ]} emptyState={{ icon: HeartPulse, title: t('hx.comp.enroll_empty'), description: t('hx.comp.new_enrollment') }} />}</StateView>
    </div>
  );
}
