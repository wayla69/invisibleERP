'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Rocket, LogOut, Plus, ShieldAlert, CheckCircle2, ListChecks } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const CATEGORIES = ['it_access', 'payroll', 'equipment', 'docs', 'training'];

// HR-5 (docs/42) — onboarding/offboarding lifecycle with the HR-05 access-revocation-completeness control:
// an offboarding cannot be completed while any is_access_revocation task is still pending. Reads gate
// hr/hr_admin/exec; writes hr/hr_admin (skipping an access-revocation task needs hr_admin/exec + a reason).
export default function OnboardingClient({ initialTemplates }: { initialTemplates?: any }) {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('hx.onb.title')} description={t('hx.onb.subtitle')} />
      <Tabs tabs={[
        { key: 'templates', label: t('hx.onb.tab_templates'), content: <Templates initialTemplates={initialTemplates} /> },
        { key: 'lifecycles', label: t('hx.onb.tab_lifecycles'), content: <Lifecycles /> },
        { key: 'exceptions', label: t('hx.onb.tab_exceptions'), content: <Exceptions /> },
      ]} />
    </div>
  );
}

function Templates({ initialTemplates }: { initialTemplates?: any }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['onb-templates'], queryFn: () => api('/api/hcm/lifecycle/templates'), initialData: initialTemplates });
  const [f, setF] = useState({ code: '', name: '', kind: 'onboarding' });
  const addTpl = useMutation({
    mutationFn: () => api('/api/hcm/lifecycle/templates', { method: 'POST', body: JSON.stringify({ code: f.code, name: f.name, kind: f.kind }) }),
    onSuccess: () => { notifySuccess(t('hx.onb.tpl_saved')); setF({ code: '', name: '', kind: 'onboarding' }); qc.invalidateQueries({ queryKey: ['onb-templates'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hx.onb.new_template')}</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5"><Label>{t('hx.onb.code')}</Label><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} className="w-40" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.onb.name')}</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className="w-56" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.onb.kind')}</Label>
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm">
              <option value="onboarding">{t('hx.onb.kind_onboarding')}</option>
              <option value="offboarding">{t('hx.onb.kind_offboarding')}</option>
            </select>
          </div>
          <Button onClick={() => addTpl.mutate()} disabled={!f.code || !f.name || addTpl.isPending}><Plus className="size-4" /> {t('fin.save')}</Button>
        </div>
      </Card>
      <StateView q={q}>{q.data && (
        (q.data.templates ?? []).length
          ? <div className="grid gap-4">{(q.data.templates ?? []).map((tpl: any) => <TemplateCard key={tpl.id} tpl={tpl} />)}</div>
          : <Card className="p-8 text-center text-sm text-muted-foreground">{t('hx.onb.tpl_empty')}</Card>
      )}</StateView>
    </div>
  );
}

function TemplateCard({ tpl }: { tpl: any }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const [f, setF] = useState({ title: '', category: 'docs', is_access_revocation: false });
  const addTask = useMutation({
    mutationFn: () => api(`/api/hcm/lifecycle/templates/${tpl.id}/tasks`, { method: 'POST', body: JSON.stringify({ title: f.title, category: f.category, is_access_revocation: f.is_access_revocation }) }),
    onSuccess: () => { notifySuccess(t('hx.onb.task_added')); setF({ title: '', category: 'docs', is_access_revocation: false }); qc.invalidateQueries({ queryKey: ['onb-templates'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <Card className="gap-3 p-5">
      <div className="flex flex-wrap items-center gap-2">
        {tpl.kind === 'offboarding' ? <LogOut className="size-4 text-muted-foreground" /> : <Rocket className="size-4 text-muted-foreground" />}
        <span className="font-semibold">{tpl.code}</span>
        <span className="text-sm text-muted-foreground">{tpl.name}</span>
        <Badge variant={tpl.kind === 'offboarding' ? 'warning' : 'secondary'}>{t(`hx.onb.kind_${tpl.kind}`)}</Badge>
      </div>
      <div className="grid gap-1.5">
        {(tpl.tasks ?? []).length === 0 && <div className="text-xs text-muted-foreground">{t('hx.onb.no_tasks')}</div>}
        {(tpl.tasks ?? []).map((tk: any) => (
          <div key={tk.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-6 text-xs text-muted-foreground">{tk.seq}.</span>
            <span>{tk.title}</span>
            <Badge variant="muted">{t(`hx.onb.cat_${tk.category}`)}</Badge>
            {tk.is_access_revocation && <Badge variant="destructive"><ShieldAlert className="size-3" /> {t('hx.onb.access_revocation')}</Badge>}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3 border-t pt-3">
        <div className="grid gap-1.5"><Label>{t('hx.onb.task_title')}</Label><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} className="w-56" /></div>
        <div className="grid gap-1.5"><Label>{t('hx.onb.category')}</Label>
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm">
            {CATEGORIES.map((c) => <option key={c} value={c}>{t(`hx.onb.cat_${c}`)}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-1.5 pb-2 text-sm"><input type="checkbox" checked={f.is_access_revocation} onChange={(e) => setF({ ...f, is_access_revocation: e.target.checked })} /> {t('hx.onb.access_revocation')}</label>
        <Button variant="outline" onClick={() => addTask.mutate()} disabled={!f.title || addTask.isPending}><Plus className="size-4" /> {t('hx.onb.add_task')}</Button>
      </div>
    </Card>
  );
}

function Lifecycles() {
  const { t } = useLang();
  const qc = useQueryClient();
  const templates = useQuery<any>({ queryKey: ['onb-templates'], queryFn: () => api('/api/hcm/lifecycle/templates') });
  const [emp, setEmp] = useState('');
  const [tplId, setTplId] = useState('');
  const q = useQuery<any>({ queryKey: ['onb-lifecycles', emp], queryFn: () => api(`/api/hcm/lifecycle${emp ? `?emp_code=${encodeURIComponent(emp)}` : ''}`), enabled: true });
  const start = useMutation({
    mutationFn: () => api('/api/hcm/lifecycle/start', { method: 'POST', body: JSON.stringify({ emp_code: emp, template_id: Number(tplId) }) }),
    onSuccess: () => { notifySuccess(t('hx.onb.started')); setTplId(''); qc.invalidateQueries({ queryKey: ['onb-lifecycles'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hx.onb.start_title')}</h3>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><ShieldAlert className="size-3.5" /> {t('hx.onb.hr05_hint')}</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5"><Label>{t('hr.emp_code')}</Label><Input value={emp} onChange={(e) => setEmp(e.target.value)} className="w-40" placeholder="EMP..." /></div>
          <div className="grid gap-1.5"><Label>{t('hx.onb.template')}</Label>
            <select value={tplId} onChange={(e) => setTplId(e.target.value)} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm">
              <option value="">—</option>
              {(templates.data?.templates ?? []).map((tp: any) => <option key={tp.id} value={tp.id}>{tp.code} · {t(`hx.onb.kind_${tp.kind}`)}</option>)}
            </select>
          </div>
          <Button onClick={() => start.mutate()} disabled={!emp || !tplId || start.isPending}><Plus className="size-4" /> {t('hx.onb.start_btn')}</Button>
        </div>
      </Card>
      <StateView q={q}>{q.data && (
        (q.data.lifecycles ?? []).length
          ? <div className="grid gap-4">{(q.data.lifecycles ?? []).map((lc: any) => <LifecycleCard key={lc.id} lc={lc} />)}</div>
          : <Card className="p-8 text-center text-sm text-muted-foreground">{t('hx.onb.lc_empty')}</Card>
      )}</StateView>
    </div>
  );
}

function LifecycleCard({ lc }: { lc: any }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['onb-lifecycles'] });
  const patch = useMutation({
    mutationFn: (v: { id: number; status: string; reason?: string }) => api(`/api/hcm/lifecycle/tasks/${v.id}`, { method: 'PATCH', body: JSON.stringify({ status: v.status, reason: v.reason }) }),
    onSuccess: () => { notifySuccess(t('hx.onb.task_updated')); invalidate(); },
    onError: (e: any) => notifyError(e.message),
  });
  const complete = useMutation({
    mutationFn: () => api(`/api/hcm/lifecycle/${lc.id}/complete`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('hx.onb.completed')); invalidate(); },
    onError: (e: any) => notifyError(e.message),
  });
  const skip = (id: number) => {
    const reason = window.prompt(t('hx.onb.skip_reason_prompt'));
    if (reason) patch.mutate({ id, status: 'skipped', reason });
  };
  return (
    <Card className="gap-3 p-5">
      <div className="flex flex-wrap items-center gap-2">
        {lc.kind === 'offboarding' ? <LogOut className="size-4 text-muted-foreground" /> : <Rocket className="size-4 text-muted-foreground" />}
        <span className="font-semibold">{lc.emp_code}</span>
        <Badge variant={lc.kind === 'offboarding' ? 'warning' : 'secondary'}>{t(`hx.onb.kind_${lc.kind}`)}</Badge>
        <Badge variant={lc.status === 'complete' ? 'success' : 'muted'}>{t(`hx.onb.status_${lc.status}`)}</Badge>
        <span className="text-xs text-muted-foreground">{lc.tasks_done}/{lc.tasks_total} {t('hx.onb.done_short')}</span>
        {lc.access_revocation_pending > 0 && <Badge variant="destructive"><ShieldAlert className="size-3" /> {lc.access_revocation_pending} {t('hx.onb.access_pending')}</Badge>}
      </div>
      <div className="grid gap-1.5">
        {(lc.tasks ?? []).map((tk: any) => (
          <div key={tk.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-6 text-xs text-muted-foreground">{tk.seq}.</span>
            {tk.status === 'done' ? <CheckCircle2 className="size-4 text-emerald-600" /> : <ListChecks className="size-4 text-muted-foreground" />}
            <span className={tk.status === 'done' ? 'line-through text-muted-foreground' : ''}>{tk.title}</span>
            <Badge variant="muted">{t(`hx.onb.cat_${tk.category}`)}</Badge>
            {tk.is_access_revocation && <Badge variant="destructive"><ShieldAlert className="size-3" /> {t('hx.onb.access_revocation')}</Badge>}
            <Badge variant={tk.status === 'done' ? 'success' : tk.status === 'skipped' ? 'warning' : 'muted'}>{t(`hx.onb.tstatus_${tk.status}`)}</Badge>
            {lc.status !== 'complete' && tk.status === 'pending' && (
              <span className="flex gap-1.5">
                <Button size="sm" variant="outline" onClick={() => patch.mutate({ id: tk.id, status: 'done' })} disabled={patch.isPending}>{t('hx.onb.mark_done')}</Button>
                <Button size="sm" variant="ghost" onClick={() => skip(tk.id)} disabled={patch.isPending}>{t('hx.onb.skip')}</Button>
              </span>
            )}
          </div>
        ))}
      </div>
      {lc.status !== 'complete' && (
        <div className="border-t pt-3"><Button onClick={() => complete.mutate()} disabled={complete.isPending}><CheckCircle2 className="size-4" /> {t('hx.onb.complete_btn')}</Button></div>
      )}
    </Card>
  );
}

function Exceptions() {
  const { t } = useLang();
  const [days, setDays] = useState('7');
  const q = useQuery<any>({ queryKey: ['onb-exceptions', days], queryFn: () => api(`/api/hcm/lifecycle/offboarding-exceptions?days=${Number(days) || 0}`) });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hx.onb.exc_title')}</h3>
        <p className="text-xs text-muted-foreground">{t('hx.onb.exc_hint')}</p>
        <div className="flex items-end gap-3">
          <div className="grid gap-1.5"><Label>{t('hx.onb.exc_days')}</Label><Input type="number" value={days} onChange={(e) => setDays(e.target.value)} className="w-24" /></div>
        </div>
      </Card>
      <StateView q={q}>{q.data && (
        (q.data.exceptions ?? []).length
          ? <div className="grid gap-3">{(q.data.exceptions ?? []).map((x: any) => (
              <Card key={x.lifecycle_id} className="gap-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{x.emp_code}</span>
                  <Badge variant="destructive">{x.days_open} {t('hx.onb.days_open')}</Badge>
                  <Badge variant="warning"><ShieldAlert className="size-3" /> {x.access_revocation_pending} {t('hx.onb.access_pending')}</Badge>
                  {x.started_by && <span className="text-xs text-muted-foreground">{t('hx.onb.started_by')}: {x.started_by}</span>}
                </div>
                <div className="grid gap-1 text-sm text-muted-foreground">
                  {(x.pending_tasks ?? []).map((pt: any) => <div key={pt.id}>• {pt.title} <span className="text-xs">({t(`hx.onb.cat_${pt.category}`)})</span></div>)}
                </div>
              </Card>
            ))}</div>
          : <Card className="p-8 text-center text-sm text-muted-foreground"><CheckCircle2 className="mx-auto mb-2 size-6 text-emerald-600" />{t('hx.onb.exc_clean')}</Card>
      )}</StateView>
    </div>
  );
}
