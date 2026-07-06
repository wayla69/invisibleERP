'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCheck, ListChecks, Workflow, X, Plus, Trash2, AlarmClock } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLang } from '@/lib/i18n';

interface Approval { instance_id: number; doc_type: string; doc_no: string; amount: number; current_step: number; created_by: string; on_behalf_of: string | null; due_at: string | null; overdue: boolean; escalated: boolean }
interface Step { step_no: number; approver_role: string | null; approver_user: string | null; min_amount: number; all_of_n: number; sla_hours: number | null; escalate_to_role: string | null; escalate_to_user: string | null; match_key: string | null; match_value: string | null }
interface Definition { id: number; doc_type: string; name: string; sla_hours: number | null; active: boolean; steps: Step[] }

export default function WorkflowPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('st.wf.title')} description={t('st.wf.desc')} />
      <Tabs tabs={[
        { key: 'inbox', label: t('st.wf.tab_inbox'), content: <MyApprovals /> },
        { key: 'defs', label: t('st.wf.tab_defs'), content: <Definitions /> },
        { key: 'readiness', label: t('st.wf.tab_readiness'), content: <Readiness /> },
      ]} />
    </div>
  );
}

function MyApprovals() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ items: Approval[] }>({ queryKey: ['wf-my-approvals'], queryFn: () => api('/api/workflow/my-approvals') });
  const act = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: 'approve' | 'reject' }) => api(`/api/workflow/instances/${id}/act`, { method: 'POST', body: JSON.stringify({ decision }) }),
    onSuccess: (r: any) => { notifySuccess(t('st.wf.action_done', { status: r.status })); qc.invalidateQueries({ queryKey: ['wf-my-approvals'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const sweep = useMutation({
    mutationFn: () => api('/api/workflow/run-escalations', { method: 'POST' }),
    onSuccess: (r: any) => { notifySuccess(t('st.wf.sweep_done', { escalated: r.escalated, reminded: r.reminded })); qc.invalidateQueries({ queryKey: ['wf-my-approvals'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const items = q.data?.items ?? [];
  const totalValue = items.reduce((s, i) => s + i.amount, 0);
  const overdue = items.filter((i) => i.overdue).length;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label={t('st.wf.pending_count')} value={num(items.length)} icon={ListChecks} tone={items.length > 0 ? 'warning' : 'success'} hint={t('st.wf.pending_hint')} />
        <StatCard label={t('st.wf.total_value')} value={baht(totalValue)} icon={Workflow} tone="primary" />
        <StatCard label={t('st.wf.overdue_sla')} value={num(overdue)} icon={AlarmClock} tone={overdue > 0 ? 'danger' : 'default'} />
      </div>
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" disabled={sweep.isPending} onClick={() => sweep.mutate()}><AlarmClock className="mr-1 size-4" />{t('st.wf.check_overdue')}</Button>
      </div>
      <StateView q={q}>
        <DataTable
          rows={items}
          rowKey={(r) => r.instance_id}
          columns={[
            { key: 'doc_type', label: t('st.wf.col_type'), render: (r) => <Badge variant="info">{r.doc_type}</Badge> },
            { key: 'doc_no', label: t('st.wf.col_docno'), render: (r) => <span>{r.doc_no}{r.overdue && <Badge variant="destructive" className="ml-2 text-[10px]">{t('st.wf.overdue')}</Badge>}{r.escalated && <Badge variant="warning" className="ml-1 text-[10px]">{t('st.wf.escalated')}</Badge>}</span> },
            { key: 'amount', label: t('st.wf.col_amount'), align: 'right', render: (r) => <span className="tabular">{baht(r.amount)}</span> },
            { key: 'current_step', label: t('st.wf.col_step'), align: 'right', render: (r) => num(r.current_step) },
            { key: 'created_by', label: t('st.wf.col_creator') },
            { key: 'on_behalf_of', label: t('st.wf.col_onbehalf'), render: (r) => r.on_behalf_of ?? '—' },
            { key: 'actions', label: '', sortable: false, align: 'right', render: (r) => (
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" disabled={act.isPending} onClick={() => act.mutate({ id: r.instance_id, decision: 'approve' })}><Check className="size-3.5" /> {t('fin.approve')}</Button>
                <Button variant="destructive" size="sm" disabled={act.isPending} onClick={() => act.mutate({ id: r.instance_id, decision: 'reject' })}><X className="size-3.5" /> {t('fin.rejected')}</Button>
              </div>
            ) },
          ]}
          emptyState={{ icon: CheckCheck, title: t('st.wf.empty_title'), description: t('st.wf.empty_desc') }}
        />
      </StateView>
    </div>
  );
}

// Cross-cutting control-integrity readiness (maker-checker audit): the engine AUTO-APPROVES a docType with no
// active workflow definition, so a deploy without seeded definitions silently has no second-person approval on
// PR/PO/BUDGET/PMR/BQR. This read-only panel surfaces which docTypes currently auto-approve.
function Readiness() {
  const { t } = useLang();
  const q = useQuery<{ doc_types: { doc_type: string; has_active_definition: boolean; auto_approves: boolean }[]; ready: boolean; missing: string[]; message: string }>({
    queryKey: ['wf-readiness'], queryFn: () => api('/api/workflow/readiness'),
  });
  return (
    <StateView q={q}>
      {q.data && (
        <Card className={q.data.ready ? '' : 'border-amber-300 dark:border-amber-700'}>
          <CardHeader><CardTitle className="flex items-center gap-2 text-sm">{q.data.ready ? <CheckCheck className="size-4" /> : <AlarmClock className="size-4" />} {t('st.wf.readiness_title')}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{q.data.ready ? t('st.wf.readiness_ok') : t('st.wf.readiness_warn')}</p>
            <DataTable
              rows={q.data.doc_types}
              rowKey={(r) => r.doc_type}
              columns={[
                { key: 'doc_type', label: t('st.wf.col_type'), render: (r) => <Badge variant="info">{r.doc_type}</Badge> },
                { key: 'status', label: t('st.wf.readiness_col_status'), render: (r) => r.has_active_definition ? <Badge variant="success">{t('st.wf.readiness_has_def')}</Badge> : <Badge variant="warning">{t('st.wf.readiness_auto')}</Badge> },
              ]}
            />
          </CardContent>
        </Card>
      )}
    </StateView>
  );
}

type DraftStep = { approver_kind: 'role' | 'user'; approver: string; min_amount: string; all_of_n: string; sla_hours: string; escalate_to_role: string; match_key: string; match_value: string };
const emptyStep = (): DraftStep => ({ approver_kind: 'role', approver: '', min_amount: '0', all_of_n: '1', sla_hours: '', escalate_to_role: '', match_key: '', match_value: '' });

function Definitions() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ definitions: Definition[] }>({ queryKey: ['wf-definitions'], queryFn: () => api('/api/workflow/definitions') });
  const [docType, setDocType] = useState('PR'); const [name, setName] = useState(''); const [sla, setSla] = useState(''); const [steps, setSteps] = useState<DraftStep[]>([emptyStep()]);
  const create = useMutation({
    mutationFn: () => api('/api/workflow/definitions', { method: 'POST', body: JSON.stringify({
      doc_type: docType, name, sla_hours: sla ? Number(sla) : undefined,
      steps: steps.map((s, i) => ({
        step_no: i + 1, min_amount: Number(s.min_amount) || 0, all_of_n: Number(s.all_of_n) || 1,
        ...(s.approver_kind === 'role' ? { approver_role: s.approver } : { approver_user: s.approver }),
        ...(s.sla_hours ? { sla_hours: Number(s.sla_hours) } : {}),
        ...(s.escalate_to_role ? { escalate_to_role: s.escalate_to_role } : {}),
        ...(s.match_key && s.match_value ? { match_key: s.match_key, match_value: s.match_value } : {}),
      })),
    }) }),
    onSuccess: () => { notifySuccess(t('st.wf.created', { name })); setName(''); setSla(''); setSteps([emptyStep()]); qc.invalidateQueries({ queryKey: ['wf-definitions'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) => api(`/api/workflow/definitions/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wf-definitions'] }),
  });
  const setStep = (i: number, patch: Partial<DraftStep>) => setSteps((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const defs = q.data?.definitions ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Workflow className="h-4 w-4" />{t('st.wf.create_flow')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div><Label>{t('st.wf.doc_type')}</Label>
              <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={docType} onChange={(e) => setDocType(e.target.value)}>
                {['PR', 'PO', 'AP_PAY', 'JE', 'BUDGET', 'EXPENSE'].map((dt) => <option key={dt} value={dt}>{dt}</option>)}
              </select>
            </div>
            <div><Label>{t('st.wf.flow_name')}</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('st.wf.flow_name_ph')} /></div>
            <div><Label>{t('st.wf.sla_default')}</Label><Input value={sla} onChange={(e) => setSla(e.target.value)} placeholder="24" /></div>
          </div>
          <div className="space-y-3">
            {steps.map((s, i) => (
              <div key={i} className="rounded-md border p-3">
                <div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold">{t('st.wf.step_n', { n: i + 1 })}</span>{steps.length > 1 && <Button size="sm" variant="ghost" onClick={() => setSteps((ss) => ss.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>}</div>
                <div className="grid gap-2 sm:grid-cols-4">
                  <div><Label className="text-xs">{t('st.wf.approver')}</Label>
                    <div className="flex gap-1">
                      <select className="h-9 rounded-md border bg-background px-1 text-xs" value={s.approver_kind} onChange={(e) => setStep(i, { approver_kind: e.target.value as 'role' | 'user' })}><option value="role">{t('st.wf.role')}</option><option value="user">{t('st.wf.user')}</option></select>
                      <Input className="h-9" value={s.approver} onChange={(e) => setStep(i, { approver: e.target.value })} placeholder={s.approver_kind === 'role' ? 'Procurement' : 'username'} />
                    </div>
                  </div>
                  <div><Label className="text-xs">{t('st.wf.min_amount')}</Label><Input value={s.min_amount} onChange={(e) => setStep(i, { min_amount: e.target.value })} /></div>
                  <div><Label className="text-xs">{t('st.wf.required_approvers')}</Label><Input value={s.all_of_n} onChange={(e) => setStep(i, { all_of_n: e.target.value })} /></div>
                  <div><Label className="text-xs">{t('st.wf.sla_hours')}</Label><Input value={s.sla_hours} onChange={(e) => setStep(i, { sla_hours: e.target.value })} placeholder={t('st.wf.sla_use_flow')} /></div>
                  <div><Label className="text-xs">{t('st.wf.escalate_to_role')}</Label><Input value={s.escalate_to_role} onChange={(e) => setStep(i, { escalate_to_role: e.target.value })} placeholder={t('st.wf.escalate_ph')} /></div>
                  <div><Label className="text-xs">{t('st.wf.dim_key')}</Label><Input value={s.match_key} onChange={(e) => setStep(i, { match_key: e.target.value })} placeholder="cost_center" /></div>
                  <div><Label className="text-xs">{t('st.wf.dim_value')}</Label><Input value={s.match_value} onChange={(e) => setStep(i, { match_value: e.target.value })} placeholder="IT" /></div>
                </div>
              </div>
            ))}
            <Button size="sm" variant="outline" onClick={() => setSteps((ss) => [...ss, emptyStep()])}><Plus className="mr-1 h-4 w-4" />{t('st.wf.add_step')}</Button>
          </div>
          <div className="flex items-center gap-3">
            <Button disabled={!name || steps.some((s) => !s.approver) || create.isPending} onClick={() => create.mutate()}>{t('st.wf.save_flow')}</Button>
          </div>
        </CardContent>
      </Card>

      <StateView q={q}>
        <div className="grid gap-4">
          {defs.length === 0 && <DataTable rows={[]} columns={[{ key: 'x', label: t('st.wf.tab_defs') }]} emptyText={t('st.wf.no_flows')} />}
          {defs.map((d) => (
            <div key={d.id}>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">{d.name} <span className="text-muted-foreground">· {d.doc_type}{d.sla_hours ? t('st.wf.sla_suffix', { h: d.sla_hours }) : ''}</span></h3>
                <Badge variant={d.active ? 'success' : 'muted'}>{d.active ? t('st.wf.active') : t('st.wf.inactive')}</Badge>
                <Button size="sm" variant="ghost" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: d.id, active: !d.active })}>{d.active ? t('st.wf.disable') : t('st.wf.enable')}</Button>
              </div>
              <DataTable
                rows={d.steps}
                rowKey={(s) => `${d.id}-${s.step_no}`}
                columns={[
                  { key: 'step_no', label: t('st.wf.col_step_short'), align: 'right', render: (s) => num(s.step_no) },
                  { key: 'approver', label: t('st.wf.approver'), render: (s) => s.approver_role ?? s.approver_user ?? '—' },
                  { key: 'min_amount', label: t('st.wf.min_amount'), align: 'right', render: (s) => <span className="tabular">{baht(s.min_amount)}</span> },
                  { key: 'dimension', label: t('st.wf.col_dimension'), render: (s) => s.match_key ? `${s.match_key}=${s.match_value}` : '—' },
                  { key: 'all_of_n', label: t('st.wf.col_persons'), align: 'right', render: (s) => num(s.all_of_n) },
                  { key: 'sla', label: 'SLA', align: 'right', render: (s) => s.sla_hours ? t('st.wf.hours_suffix', { h: s.sla_hours }) : '—' },
                  { key: 'escalate', label: t('st.wf.col_escalate_to'), render: (s) => s.escalate_to_role ?? s.escalate_to_user ?? '—' },
                ]}
                emptyText={t('st.wf.no_steps')}
              />
            </div>
          ))}
        </div>
      </StateView>
    </div>
  );
}
