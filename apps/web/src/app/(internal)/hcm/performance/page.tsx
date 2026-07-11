'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Award, Target, ClipboardCheck, Check, Plus, X } from 'lucide-react';
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
import { statusVariant } from '@/components/ui';
import { Select } from '@/components/form-controls';

const today = () => new Date().toISOString().slice(0, 10);

export default function PerformancePage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('hx.perf.title')} description={t('hx.perf.subtitle')} />
      <Tabs tabs={[
        { key: 'cycles', label: t('hx.perf.tab_cycles'), content: <Cycles /> },
        { key: 'goals', label: t('hx.perf.tab_goals'), content: <Goals /> },
        { key: 'reviews', label: t('hx.perf.tab_reviews'), content: <Reviews /> },
      ]} />
    </div>
  );
}

function Cycles() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['perf-cycles'], queryFn: () => api('/api/hcm/performance/cycles') });
  const [f, setF] = useState({ name: '', period_start: today(), period_end: today() });
  const refresh = () => qc.invalidateQueries({ queryKey: ['perf-cycles'] });
  const add = useMutation({
    mutationFn: () => api('/api/hcm/performance/cycles', { method: 'POST', body: JSON.stringify({ name: f.name, period_start: f.period_start, period_end: f.period_end }) }),
    onSuccess: () => { notifySuccess(t('hx.perf.cycle_created')); setF({ ...f, name: '' }); refresh(); }, onError: (e: any) => notifyError(e.message),
  });
  const close = useMutation({ mutationFn: (id: number) => api(`/api/hcm/performance/cycles/${id}/close`, { method: 'POST', body: '{}' }), onSuccess: () => { notifySuccess(t('hx.perf.cycle_closed')); refresh(); }, onError: (e: any) => notifyError(e.message) });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hx.perf.new_cycle')}</h3>
        <div className="flex flex-wrap gap-3">
          <div className="grid gap-1.5"><Label>{t('hx.perf.cycle_name')}</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className="w-48" placeholder="H1-2026" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.perf.period_start')}</Label><Input type="date" value={f.period_start} onChange={(e) => setF({ ...f, period_start: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('hx.perf.period_end')}</Label><Input type="date" value={f.period_end} onChange={(e) => setF({ ...f, period_end: e.target.value })} /></div>
        </div>
        <div className="flex items-center gap-3"><Button onClick={() => add.mutate()} disabled={!f.name || add.isPending}><Plus className="size-4" /> {t('hx.perf.new_cycle')}</Button></div>
      </Card>
      <StateView q={q}>{q.data && <DataTable rows={q.data.cycles} columns={[
        { key: 'name', label: t('hx.perf.cycle') },
        { key: 'period_start', label: t('hx.perf.period_start') },
        { key: 'period_end', label: t('hx.perf.period_end') },
        { key: 'status', label: t('hx.perf.status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
        { key: 'act', label: '', sortable: false, render: (r: any) => r.status !== 'closed' ? <Button size="sm" variant="outline" disabled={close.isPending} onClick={() => close.mutate(r.id)}><X className="size-4" /> {t('hx.perf.close_cycle')}</Button> : <span className="text-xs text-muted-foreground">—</span> },
      ]} emptyState={{ icon: Award, title: t('hx.perf.empty_cycles'), description: t('hx.perf.empty_cycles_desc') }} />}</StateView>
    </div>
  );
}

function Goals() {
  const { t } = useLang();
  const qc = useQueryClient();
  const cyclesQ = useQuery<any>({ queryKey: ['perf-cycles'], queryFn: () => api('/api/hcm/performance/cycles') });
  const [f, setF] = useState({ cycle_id: '', emp_code: '', title: '', weight_pct: '', metric: '', target: '' });
  const goalsQ = useQuery<any>({ queryKey: ['perf-goals', f.cycle_id, f.emp_code], queryFn: () => api(`/api/hcm/performance/goals?${f.cycle_id ? `cycle_id=${f.cycle_id}` : ''}${f.emp_code ? `&emp_code=${encodeURIComponent(f.emp_code)}` : ''}`), enabled: !!f.cycle_id });
  const refresh = () => qc.invalidateQueries({ queryKey: ['perf-goals'] });
  const add = useMutation({
    mutationFn: () => api('/api/hcm/performance/goals', { method: 'POST', body: JSON.stringify({ cycle_id: Number(f.cycle_id), emp_code: f.emp_code, title: f.title, weight_pct: Number(f.weight_pct) || 0, metric: f.metric || undefined, target: f.target || undefined }) }),
    onSuccess: () => { notifySuccess(t('hx.perf.goal_added')); setF({ ...f, title: '', weight_pct: '', metric: '', target: '' }); refresh(); }, onError: (e: any) => notifyError(e.message),
  });
  const patch = useMutation({
    mutationFn: (v: { id: number; progress_pct: number }) => api(`/api/hcm/performance/goals/${v.id}`, { method: 'PATCH', body: JSON.stringify({ progress_pct: v.progress_pct }) }),
    onSuccess: () => { notifySuccess(t('hx.perf.goal_updated')); refresh(); }, onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hx.perf.add_goal')}</h3>
        <div className="flex flex-wrap gap-3">
          <div className="grid gap-1.5"><Label>{t('hx.perf.cycle')}</Label>
            <Select className="w-48" value={f.cycle_id} onChange={(e) => setF({ ...f, cycle_id: e.target.value })}>
              <option value="">—</option>
              {(cyclesQ.data?.cycles ?? []).map((c: any) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
            </Select>
          </div>
          <div className="grid gap-1.5"><Label>{t('hx.perf.emp_code')}</Label><Input value={f.emp_code} onChange={(e) => setF({ ...f, emp_code: e.target.value })} className="w-36" placeholder="EMP..." /></div>
          <div className="grid gap-1.5"><Label>{t('hx.perf.goal_title')}</Label><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} className="w-56" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.perf.weight_pct')}</Label><Input type="number" value={f.weight_pct} onChange={(e) => setF({ ...f, weight_pct: e.target.value })} className="w-24" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.perf.metric')}</Label><Input value={f.metric} onChange={(e) => setF({ ...f, metric: e.target.value })} className="w-36" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.perf.target')}</Label><Input value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} className="w-36" /></div>
        </div>
        <div className="flex items-center gap-3"><Button onClick={() => add.mutate()} disabled={!f.cycle_id || !f.emp_code || !f.title || add.isPending}><Plus className="size-4" /> {t('hx.perf.add_goal')}</Button></div>
      </Card>
      <StateView q={goalsQ}>{goalsQ.data && <DataTable rows={goalsQ.data.goals} columns={[
        { key: 'emp_code', label: t('hx.perf.emp_code') },
        { key: 'title', label: t('hx.perf.goal_title') },
        { key: 'weight_pct', label: t('hx.perf.weight_pct'), align: 'right' },
        { key: 'progress_pct', label: t('hx.perf.progress'), align: 'right' },
        { key: 'status', label: t('hx.perf.status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
        { key: 'act', label: '', sortable: false, render: (r: any) => <Button size="sm" variant="outline" disabled={patch.isPending} onClick={() => patch.mutate({ id: r.id, progress_pct: Math.min(100, Number(r.progress_pct) + 25) })}>+25%</Button> },
      ]} emptyState={{ icon: Target, title: t('hx.perf.empty_goals'), description: t('hx.perf.empty_goals_desc') }} />}</StateView>
    </div>
  );
}

function Reviews() {
  const { t } = useLang();
  const qc = useQueryClient();
  const cyclesQ = useQuery<any>({ queryKey: ['perf-cycles'], queryFn: () => api('/api/hcm/performance/cycles') });
  const [f, setF] = useState({ cycle_id: '', emp_code: '', self_rating: '' });
  const [mgr, setMgr] = useState({ manager_emp_code: '', manager_rating: '' });
  const reviewsQ = useQuery<any>({ queryKey: ['perf-reviews', f.cycle_id], queryFn: () => api(`/api/hcm/performance/reviews?${f.cycle_id ? `cycle_id=${f.cycle_id}` : ''}`), enabled: !!f.cycle_id });
  const refresh = () => qc.invalidateQueries({ queryKey: ['perf-reviews'] });
  const start = useMutation({
    mutationFn: () => api('/api/hcm/performance/reviews', { method: 'POST', body: JSON.stringify({ cycle_id: Number(f.cycle_id), emp_code: f.emp_code, self_rating: f.self_rating ? Number(f.self_rating) : undefined }) }),
    onSuccess: () => { notifySuccess(t('hx.perf.review_created')); setF({ ...f, emp_code: '', self_rating: '' }); refresh(); }, onError: (e: any) => notifyError(e.message),
  });
  const rate = useMutation({
    mutationFn: (id: number) => api(`/api/hcm/performance/reviews/${id}/manager`, { method: 'POST', body: JSON.stringify({ manager_emp_code: mgr.manager_emp_code, manager_rating: Number(mgr.manager_rating) || 0 }) }),
    onSuccess: () => { notifySuccess(t('hx.perf.rated')); refresh(); }, onError: (e: any) => notifyError(e.message),
  });
  const sign = useMutation({
    mutationFn: (id: number) => api(`/api/hcm/performance/reviews/${id}/sign`, { method: 'POST', body: '{}' }),
    onSuccess: () => { notifySuccess(t('hx.perf.signed')); refresh(); }, onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hx.perf.start_review')}</h3>
        <div className="flex flex-wrap gap-3">
          <div className="grid gap-1.5"><Label>{t('hx.perf.cycle')}</Label>
            <Select className="w-48" value={f.cycle_id} onChange={(e) => setF({ ...f, cycle_id: e.target.value })}>
              <option value="">—</option>
              {(cyclesQ.data?.cycles ?? []).map((c: any) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
            </Select>
          </div>
          <div className="grid gap-1.5"><Label>{t('hx.perf.emp_code')}</Label><Input value={f.emp_code} onChange={(e) => setF({ ...f, emp_code: e.target.value })} className="w-36" placeholder="EMP..." /></div>
          <div className="grid gap-1.5"><Label>{t('hx.perf.self_rating')}</Label><Input type="number" step="0.1" value={f.self_rating} onChange={(e) => setF({ ...f, self_rating: e.target.value })} className="w-24" /></div>
        </div>
        <div className="flex items-center gap-3"><Button onClick={() => start.mutate()} disabled={!f.cycle_id || !f.emp_code || start.isPending}><Plus className="size-4" /> {t('hx.perf.start_review')}</Button></div>
      </Card>
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hx.perf.rate')}</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5"><Label>{t('hx.perf.manager_emp_code')}</Label><Input value={mgr.manager_emp_code} onChange={(e) => setMgr({ ...mgr, manager_emp_code: e.target.value })} className="w-36" placeholder="EMP..." /></div>
          <div className="grid gap-1.5"><Label>{t('hx.perf.manager_rating')}</Label><Input type="number" step="0.1" value={mgr.manager_rating} onChange={(e) => setMgr({ ...mgr, manager_rating: e.target.value })} className="w-24" /></div>
        </div>
        <p className="text-xs text-muted-foreground">{t('hx.perf.subtitle')}</p>
      </Card>
      <StateView q={reviewsQ}>{reviewsQ.data && <DataTable rows={reviewsQ.data.reviews} columns={[
        { key: 'emp_code', label: t('hx.perf.emp_code') },
        { key: 'self_rating', label: t('hx.perf.self_rating'), align: 'right', render: (r: any) => r.self_rating ?? '—' },
        { key: 'manager_rating', label: t('hx.perf.manager_rating'), align: 'right', render: (r: any) => r.manager_rating ?? '—' },
        { key: 'calibrated_rating', label: t('hx.perf.calibrated_rating'), align: 'right', render: (r: any) => r.calibrated_rating ?? '—' },
        { key: 'status', label: t('hx.perf.status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
        { key: 'act', label: '', sortable: false, render: (r: any) => (
          <div className="flex gap-2">
            {r.status !== 'signed' && <Button size="sm" variant="outline" disabled={rate.isPending || !mgr.manager_emp_code} onClick={() => rate.mutate(r.id)}><ClipboardCheck className="size-4" /> {t('hx.perf.rate')}</Button>}
            {r.status !== 'signed' && r.manager_rating != null && <Button size="sm" variant="outline" disabled={sign.isPending} onClick={() => sign.mutate(r.id)}><Check className="size-4" /> {t('hx.perf.sign')}</Button>}
            {r.status === 'signed' && <span className="text-xs text-muted-foreground">{r.signed_by}</span>}
          </div>
        ) },
      ]} emptyState={{ icon: ClipboardCheck, title: t('hx.perf.empty_reviews'), description: t('hx.perf.empty_reviews_desc') }} />}</StateView>
    </div>
  );
}
