'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, Network, Users, Plus, ShieldAlert } from 'lucide-react';
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

// HR-1 (docs/42) — organisation structure, positions & effective-dated assignments with the HR-01
// headcount-governance control. Reads gate hr/hr_admin/exec; writes hr_admin/exec (an over-establishment
// assignment needs an exec override → HEADCOUNT_EXCEEDED otherwise).
export default function OrgClient({ initialChart }: { initialChart?: any }) {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('hx.org.title')} description={t('hx.org.subtitle')} />
      <Tabs tabs={[
        { key: 'chart', label: t('hx.org.tab_chart'), content: <OrgChart initialChart={initialChart} /> },
        { key: 'depts', label: t('hx.org.tab_departments'), content: <Departments /> },
        { key: 'positions', label: t('hx.org.tab_positions'), content: <Positions /> },
        { key: 'assignments', label: t('hx.org.tab_assignments'), content: <Assignments /> },
      ]} />
    </div>
  );
}

function OrgChart({ initialChart }: { initialChart?: any }) {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['org-chart'], queryFn: () => api('/api/hcm/org/chart'), initialData: initialChart });
  const DeptNode = ({ d, depth }: { d: any; depth: number }) => (
    <div className="grid gap-2" style={{ marginInlineStart: depth * 16 }}>
      <div className="flex items-center gap-2">
        <Building2 className="size-4 text-muted-foreground" />
        <span className="font-semibold">{d.dept_code}</span>
        <span className="text-sm text-muted-foreground">{d.name}</span>
        {d.cost_center && <Badge variant="secondary">{d.cost_center}</Badge>}
      </div>
      {(d.positions ?? []).map((p: any) => (
        <div key={p.id} className="ms-6 flex flex-wrap items-center gap-2 text-sm">
          <Users className="size-3.5 text-muted-foreground" />
          <span className="font-medium">{p.title}</span>
          <span className="text-xs text-muted-foreground">{p.position_code}</span>
          <Badge variant={p.vacancies > 0 ? 'warning' : p.current_headcount > p.budgeted_headcount ? 'destructive' : 'success'}>
            {p.current_headcount}/{p.budgeted_headcount} {t('hx.org.hc_short')}
          </Badge>
          {(p.assignees ?? []).map((a: any) => (
            <span key={a.emp_code} className="text-xs text-muted-foreground">{a.name}{a.is_primary ? '' : ' *'}</span>
          ))}
        </div>
      ))}
      {(d.children ?? []).map((c: any) => <DeptNode key={c.id} d={c} depth={depth + 1} />)}
    </div>
  );
  return (
    <StateView q={q}>{q.data && (
      <div className="grid gap-5">
        <div className="flex flex-wrap gap-4">
          {[['departments', q.data.totals?.departments], ['positions', q.data.totals?.positions], ['budgeted_headcount', q.data.totals?.budgeted_headcount], ['filled_headcount', q.data.totals?.filled_headcount]].map(([k, v]) => (
            <Card key={String(k)} className="min-w-36 gap-1 p-4"><div className="text-xs text-muted-foreground">{t(`hx.org.total_${k}`)}</div><div className="text-2xl font-semibold">{Number(v ?? 0)}</div></Card>
          ))}
        </div>
        <Card className="gap-4 p-5">
          {(q.data.tree ?? []).length ? (q.data.tree ?? []).map((d: any) => <DeptNode key={d.id} d={d} depth={0} />) : <div className="text-sm text-muted-foreground">{t('hx.org.chart_empty')}</div>}
          {(q.data.unassigned_positions ?? []).length > 0 && (
            <div className="grid gap-2 border-t pt-3">
              <div className="text-sm font-medium">{t('hx.org.no_department')}</div>
              {(q.data.unassigned_positions ?? []).map((p: any) => <div key={p.id} className="ms-6 text-sm">{p.title} <span className="text-xs text-muted-foreground">{p.position_code}</span></div>)}
            </div>
          )}
        </Card>
      </div>
    )}</StateView>
  );
}

function Departments() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['org-depts'], queryFn: () => api('/api/hcm/org/departments') });
  const [f, setF] = useState({ dept_code: '', name: '', parent_dept_code: '', cost_center: '', manager_emp_code: '' });
  const add = useMutation({
    mutationFn: () => api('/api/hcm/org/departments', { method: 'POST', body: JSON.stringify({ dept_code: f.dept_code, name: f.name, parent_dept_code: f.parent_dept_code || undefined, cost_center: f.cost_center || undefined, manager_emp_code: f.manager_emp_code || undefined }) }),
    onSuccess: () => { notifySuccess(t('hx.org.dept_saved')); setF({ dept_code: '', name: '', parent_dept_code: '', cost_center: '', manager_emp_code: '' }); qc.invalidateQueries({ queryKey: ['org-depts'] }); qc.invalidateQueries({ queryKey: ['org-chart'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hx.org.new_department')}</h3>
        <div className="flex flex-wrap gap-3">
          <div className="grid gap-1.5"><Label>{t('hx.org.dept_code')}</Label><Input value={f.dept_code} onChange={(e) => setF({ ...f, dept_code: e.target.value })} className="w-36" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.org.name')}</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className="w-52" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.org.parent_dept')}</Label><Input value={f.parent_dept_code} onChange={(e) => setF({ ...f, parent_dept_code: e.target.value })} className="w-36" placeholder="—" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.org.cost_center')}</Label><Input value={f.cost_center} onChange={(e) => setF({ ...f, cost_center: e.target.value })} className="w-36" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.org.manager')}</Label><Input value={f.manager_emp_code} onChange={(e) => setF({ ...f, manager_emp_code: e.target.value })} className="w-36" placeholder="EMP..." /></div>
        </div>
        <div><Button onClick={() => add.mutate()} disabled={!f.dept_code || !f.name || add.isPending}><Plus className="size-4" /> {t('fin.save')}</Button></div>
      </Card>
      <StateView q={q}>{q.data && <DataTable rows={q.data.departments} columns={[
        { key: 'dept_code', label: t('hx.org.dept_code') }, { key: 'name', label: t('hx.org.name') },
        { key: 'parent_dept_code', label: t('hx.org.parent_dept'), render: (r: any) => r.parent_dept_code ?? '—' },
        { key: 'cost_center', label: t('hx.org.cost_center'), render: (r: any) => r.cost_center ?? '—' },
        { key: 'manager_emp_code', label: t('hx.org.manager'), render: (r: any) => r.manager_emp_code ?? '—' },
      ]} emptyState={{ icon: Building2, title: t('hx.org.dept_empty'), description: t('hx.org.new_department') }} />}</StateView>
    </div>
  );
}

function Positions() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['org-positions'], queryFn: () => api('/api/hcm/org/positions') });
  const [f, setF] = useState({ position_code: '', title: '', dept_code: '', job_grade: '', reports_to_position_code: '', budgeted_headcount: '1' });
  const add = useMutation({
    mutationFn: () => api('/api/hcm/org/positions', { method: 'POST', body: JSON.stringify({ position_code: f.position_code, title: f.title, dept_code: f.dept_code || undefined, job_grade: f.job_grade || undefined, reports_to_position_code: f.reports_to_position_code || undefined, budgeted_headcount: Number(f.budgeted_headcount) || 0 }) }),
    onSuccess: () => { notifySuccess(t('hx.org.position_saved')); setF({ position_code: '', title: '', dept_code: '', job_grade: '', reports_to_position_code: '', budgeted_headcount: '1' }); qc.invalidateQueries({ queryKey: ['org-positions'] }); qc.invalidateQueries({ queryKey: ['org-chart'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hx.org.new_position')}</h3>
        <div className="flex flex-wrap gap-3">
          <div className="grid gap-1.5"><Label>{t('hx.org.position_code')}</Label><Input value={f.position_code} onChange={(e) => setF({ ...f, position_code: e.target.value })} className="w-36" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.org.title_label')}</Label><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} className="w-52" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.org.dept_code')}</Label><Input value={f.dept_code} onChange={(e) => setF({ ...f, dept_code: e.target.value })} className="w-32" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.org.job_grade')}</Label><Input value={f.job_grade} onChange={(e) => setF({ ...f, job_grade: e.target.value })} className="w-24" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.org.reports_to')}</Label><Input value={f.reports_to_position_code} onChange={(e) => setF({ ...f, reports_to_position_code: e.target.value })} className="w-36" placeholder="—" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.org.budgeted_headcount')}</Label><Input type="number" value={f.budgeted_headcount} onChange={(e) => setF({ ...f, budgeted_headcount: e.target.value })} className="w-24" /></div>
        </div>
        <div><Button onClick={() => add.mutate()} disabled={!f.position_code || !f.title || add.isPending}><Plus className="size-4" /> {t('fin.save')}</Button></div>
      </Card>
      <StateView q={q}>{q.data && <DataTable rows={q.data.positions} columns={[
        { key: 'position_code', label: t('hx.org.position_code') }, { key: 'title', label: t('hx.org.title_label') },
        { key: 'dept_code', label: t('hx.org.dept_code'), render: (r: any) => r.dept_code ?? '—' },
        { key: 'job_grade', label: t('hx.org.job_grade'), render: (r: any) => r.job_grade ?? '—' },
        { key: 'headcount', label: t('hx.org.headcount'), align: 'right', render: (r: any) => <Badge variant={r.current_headcount > r.budgeted_headcount ? 'destructive' : r.current_headcount < r.budgeted_headcount ? 'warning' : 'success'}>{r.current_headcount}/{r.budgeted_headcount}</Badge> },
      ]} emptyState={{ icon: Network, title: t('hx.org.position_empty'), description: t('hx.org.new_position') }} />}</StateView>
    </div>
  );
}

function Assignments() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['org-assignments'], queryFn: () => api('/api/hcm/org/assignments') });
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ emp_code: '', position_code: '', effective_date: today, override_reason: '' });
  const add = useMutation({
    mutationFn: () => api<any>('/api/hcm/org/assignments', { method: 'POST', body: JSON.stringify({ emp_code: f.emp_code, position_code: f.position_code, effective_date: f.effective_date, override_reason: f.override_reason || undefined }) }),
    onSuccess: (r: any) => { notifySuccess(r?.headcount_overridden ? t('hx.org.assign_overridden') : t('hx.org.assign_saved')); setF({ ...f, emp_code: '', override_reason: '' }); qc.invalidateQueries({ queryKey: ['org-assignments'] }); qc.invalidateQueries({ queryKey: ['org-chart'] }); qc.invalidateQueries({ queryKey: ['org-positions'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hx.org.new_assignment')}</h3>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><ShieldAlert className="size-3.5" /> {t('hx.org.hr01_hint')}</p>
        <div className="flex flex-wrap gap-3">
          <div className="grid gap-1.5"><Label>{t('hr.emp_code')}</Label><Input value={f.emp_code} onChange={(e) => setF({ ...f, emp_code: e.target.value })} className="w-36" placeholder="EMP..." /></div>
          <div className="grid gap-1.5"><Label>{t('hx.org.position_code')}</Label><Input value={f.position_code} onChange={(e) => setF({ ...f, position_code: e.target.value })} className="w-40" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.org.effective_date')}</Label><Input type="date" value={f.effective_date} onChange={(e) => setF({ ...f, effective_date: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('hx.org.override_reason')}</Label><Input value={f.override_reason} onChange={(e) => setF({ ...f, override_reason: e.target.value })} className="w-52" placeholder={t('hx.org.override_optional')} /></div>
        </div>
        <div><Button onClick={() => add.mutate()} disabled={!f.emp_code || !f.position_code || add.isPending}><Plus className="size-4" /> {t('hx.org.assign_btn')}</Button></div>
      </Card>
      <StateView q={q}>{q.data && <DataTable rows={q.data.assignments} columns={[
        { key: 'emp_code', label: t('hr.emp_code') }, { key: 'position_code', label: t('hx.org.position_code') },
        { key: 'effective_date', label: t('hx.org.effective_date') },
        { key: 'is_primary', label: t('hx.org.primary'), render: (r: any) => r.is_primary ? <Badge variant="success">{t('hx.org.primary')}</Badge> : '—' },
        { key: 'active', label: t('fin.col_status'), render: (r: any) => <Badge variant={r.active ? 'success' : 'muted'}>{r.active ? t('hx.common.active') : t('hx.org.ended')}</Badge> },
      ]} emptyState={{ icon: Users, title: t('hx.org.assign_empty'), description: t('hx.org.new_assignment') }} />}</StateView>
    </div>
  );
}
