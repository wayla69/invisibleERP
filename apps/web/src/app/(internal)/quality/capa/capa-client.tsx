'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ClipboardCheck, ShieldCheck, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
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
import { statusVariant } from '@/components/ui';
import { Select } from '@/components/form-controls';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface Capa {
  id: number; capa_no: string; source_type: string | null; source_ref: string | null; title: string;
  problem_statement: string | null; root_cause: string | null; action_type: string; owner: string;
  target_date: string | null; status: string; effectiveness_result: string | null;
  verified_by: string | null; created_by: string | null;
}
interface CapaAction { id: number; capa_id: number; seq: number; description: string; owner: string | null; due_date: string | null; status: string; completed_by: string | null }

const ACTION_TYPES = ['corrective', 'preventive', 'both'];
const SOURCE_TYPES = ['manual', 'ncr', 'gr_claim', 'complaint', 'audit'];

// QMS-2 — CAPA (Corrective & Preventive Action) register (control QC-02). Three tabs: the CAPA register with
// a create form + row-drill into the action checklist and the effectiveness maker-checker, and the overdue
// detective worklist. Reads gate quality/quality_approve/exec; create/own/actions quality/exec; verify/reject
// quality_approve/exec — the verifier≠owner/creator rule (QC-02) is enforced in-app.
export default function CapaClient({ initialCapas }: { initialCapas?: unknown }) {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('qc.capa_title')} description={t('qc.capa_subtitle')} />
      <Tabs
        tabs={[
          { key: 'register', label: t('qc.tab_register'), content: <Register initialCapas={initialCapas} /> },
          { key: 'overdue', label: t('qc.tab_overdue'), content: <Overdue /> },
        ]}
      />
    </div>
  );
}

function Register({ initialCapas }: { initialCapas?: unknown }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ capas: Capa[]; count: number }>({ queryKey: ['capa-list'], queryFn: () => api('/api/quality/capa'), initialData: initialCapas as { capas: Capa[]; count: number } | undefined });

  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState('');
  const [rootCause, setRootCause] = useState('');
  const [actionType, setActionType] = useState('corrective');
  const [sourceType, setSourceType] = useState('manual');
  const [sourceRef, setSourceRef] = useState('');
  const [target, setTarget] = useState('');
  const [drill, setDrill] = useState<Capa | null>(null);

  const create = useMutation({
    mutationFn: () => api('/api/quality/capa', { method: 'POST', body: JSON.stringify({
      title, problem_statement: problem || undefined, root_cause: rootCause || undefined,
      action_type: actionType, source_type: sourceType, source_ref: sourceRef || undefined,
      target_date: target || undefined,
    }) }),
    onSuccess: (r: any) => { notifySuccess(t('qc.capa_created', { no: r.capa_no })); setTitle(''); setProblem(''); setRootCause(''); setSourceRef(''); qc.invalidateQueries({ queryKey: ['capa-list'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const capas = q.data?.capas ?? [];
  const open = capas.filter((c) => !['closed', 'cancelled'].includes(c.status)).length;
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        <ShieldCheck className="size-4 shrink-0" /> {t('qc.qc02_hint')}
      </div>

      <StateView q={q}>
        {q.data && (
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard label={t('qc.stat_total')} value={num(capas.length)} icon={ClipboardCheck} tone="primary" />
            <StatCard label={t('qc.stat_open')} value={num(open)} tone="warning" />
          </div>
        )}
      </StateView>

      <Card className="max-w-3xl gap-4">
        <CardHeader><CardTitle className="text-base">{t('qc.new_capa')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2 sm:col-span-2"><Label htmlFor="cp-title">{t('qc.f_title')}</Label><Input id="cp-title" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
            <div className="grid gap-2 sm:col-span-2"><Label htmlFor="cp-problem">{t('qc.f_problem')}</Label><Input id="cp-problem" value={problem} onChange={(e) => setProblem(e.target.value)} /></div>
            <div className="grid gap-2 sm:col-span-2"><Label htmlFor="cp-root">{t('qc.f_root_cause')}</Label><Input id="cp-root" value={rootCause} onChange={(e) => setRootCause(e.target.value)} /></div>
            <div className="grid gap-2"><Label htmlFor="cp-type">{t('qc.f_action_type')}</Label><Select id="cp-type" value={actionType} onChange={(e) => setActionType(e.target.value)}>{ACTION_TYPES.map((a) => <option key={a} value={a}>{a}</option>)}</Select></div>
            <div className="grid gap-2"><Label htmlFor="cp-target">{t('qc.f_target_date')}</Label><Input id="cp-target" type="date" value={target} onChange={(e) => setTarget(e.target.value)} /></div>
            <div className="grid gap-2"><Label htmlFor="cp-src">{t('qc.f_source_type')}</Label><Select id="cp-src" value={sourceType} onChange={(e) => setSourceType(e.target.value)}>{SOURCE_TYPES.map((sType) => <option key={sType} value={sType}>{sType}</option>)}</Select></div>
            <div className="grid gap-2"><Label htmlFor="cp-ref">{t('qc.f_source_ref')}</Label><Input id="cp-ref" value={sourceRef} onChange={(e) => setSourceRef(e.target.value)} placeholder="NCR-1 / CLAIM-42" /></div>
          </div>
          <Button disabled={create.isPending || !title.trim()} onClick={() => create.mutate()}><Plus className="size-4" /> {create.isPending ? t('qc.saving') : t('qc.new_capa')}</Button>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={capas}
            onRowClick={(r: Capa) => setDrill(r)}
            emptyState={{ icon: ClipboardCheck, title: t('qc.no_capas_title'), description: t('qc.no_capas_desc') }}
            columns={[
              { key: 'capa_no', label: t('qc.c_no') },
              { key: 'title', label: t('qc.f_title') },
              { key: 'action_type', label: t('qc.f_action_type'), render: (r: Capa) => <Badge variant="info">{r.action_type}</Badge> },
              { key: 'owner', label: t('qc.c_owner') },
              { key: 'target_date', label: t('qc.f_target_date'), render: (r: Capa) => thaiDate(r.target_date) },
              { key: 'status', label: t('qc.c_status'), render: (r: Capa) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              { key: 'effectiveness_result', label: t('qc.c_effectiveness'), render: (r: Capa) => r.effectiveness_result ? <Badge variant={r.effectiveness_result === 'effective' ? 'success' : 'destructive'}>{r.effectiveness_result}</Badge> : '—' },
            ]}
          />
        )}
      </StateView>

      {drill && <CapaDrawer capa={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}

// Row-drill: the action checklist + submit/verify/reject/cancel workflow (QC-02 maker-checker).
function CapaDrawer({ capa, onClose }: { capa: Capa; onClose: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<Capa & { actions: CapaAction[] }>({ queryKey: ['capa', capa.id], queryFn: () => api(`/api/quality/capa/${capa.id}`) });
  const [desc, setDesc] = useState('');
  const [due, setDue] = useState('');
  const [result, setResult] = useState('effective');

  const invalidate = () => { qc.invalidateQueries({ queryKey: ['capa', capa.id] }); qc.invalidateQueries({ queryKey: ['capa-list'] }); };
  const run = (fn: () => Promise<unknown>, msg: string) => fn().then(() => { notifySuccess(msg); invalidate(); }).catch((e: any) => notifyError(e.message));

  const addAction = useMutation({
    mutationFn: () => api(`/api/quality/capa/${capa.id}/actions`, { method: 'POST', body: JSON.stringify({ description: desc, due_date: due || undefined }) }),
    onSuccess: () => { notifySuccess(t('qc.action_added')); setDesc(''); setDue(''); invalidate(); },
    onError: (e: any) => notifyError(e.message),
  });

  const data = q.data;
  const status = data?.status ?? capa.status;
  const actions = data?.actions ?? [];
  const allDone = actions.length > 0 && actions.every((a) => a.status === 'done');
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader><DialogTitle>{capa.capa_no} · {capa.title}</DialogTitle></DialogHeader>
        <StateView q={q}>
          {data && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-muted-foreground">{t('qc.c_status')}:</span> <Badge variant={statusVariant(status)}>{status}</Badge></div>
                <div><span className="text-muted-foreground">{t('qc.c_owner')}:</span> {data.owner}</div>
                {data.root_cause && <div className="col-span-2"><span className="text-muted-foreground">{t('qc.f_root_cause')}:</span> {data.root_cause}</div>}
                {data.source_type && <div className="col-span-2"><span className="text-muted-foreground">{t('qc.f_source_type')}:</span> {data.source_type} · {data.source_ref}</div>}
                {data.verified_by && <div className="col-span-2"><span className="text-muted-foreground">{t('qc.c_verified_by')}:</span> {data.verified_by} → <Badge variant={data.effectiveness_result === 'effective' ? 'success' : 'destructive'}>{data.effectiveness_result}</Badge></div>}
              </div>

              {/* Action checklist */}
              <div className="space-y-2">
                <div className="text-sm font-medium">{t('qc.actions')}</div>
                {actions.length === 0 && <div className="text-sm text-muted-foreground">{t('qc.no_actions')}</div>}
                {actions.map((a) => (
                  <div key={a.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                    <span className="flex items-center gap-2">{a.status === 'done' ? <CheckCircle2 className="size-4 text-success" /> : <span className="size-4 rounded-full border border-border" />} #{a.seq} {a.description}{a.due_date ? ` · ${thaiDate(a.due_date)}` : ''}</span>
                    {a.status !== 'done' && !['closed', 'cancelled'].includes(status) && (
                      <Button size="sm" variant="outline" onClick={() => run(() => api(`/api/quality/capa/${capa.id}/actions/${a.id}/complete`, { method: 'POST' }), t('qc.action_done'))}>{t('qc.mark_done')}</Button>
                    )}
                  </div>
                ))}
              </div>

              {/* Add action (owner) */}
              {!['closed', 'cancelled'].includes(status) && (
                <div className="flex items-end gap-2">
                  <div className="grid flex-1 gap-2"><Label htmlFor="ca-desc">{t('qc.new_action')}</Label><Input id="ca-desc" value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
                  <div className="grid gap-2"><Label htmlFor="ca-due">{t('qc.f_due_date')}</Label><Input id="ca-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></div>
                  <Button disabled={addAction.isPending || !desc.trim()} onClick={() => addAction.mutate()}><Plus className="size-4" /></Button>
                </div>
              )}

              {/* Workflow actions */}
              <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                {['open', 'in_progress'].includes(status) && (
                  <Button size="sm" onClick={() => run(() => api(`/api/quality/capa/${capa.id}/submit`, { method: 'POST' }), t('qc.submitted'))}>{t('qc.submit')}</Button>
                )}
                {status === 'pending_verification' && (
                  <>
                    <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-2 text-sm"><AlertTriangle className="size-4" /> {allDone ? t('qc.verify_hint') : t('qc.actions_incomplete_hint')}</div>
                    <Select value={result} onChange={(e) => setResult(e.target.value)} className="w-40"><option value="effective">effective</option><option value="ineffective">ineffective</option></Select>
                    <Button size="sm" onClick={() => run(() => api(`/api/quality/capa/${capa.id}/verify`, { method: 'POST', body: JSON.stringify({ result }) }), t('qc.verified'))}>{t('qc.verify')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => run(() => api(`/api/quality/capa/${capa.id}/reject`, { method: 'POST', body: JSON.stringify({ reason: window.prompt(t('qc.reject_reason')) ?? '' }) }), t('qc.rejected'))}>{t('qc.reject')}</Button>
                  </>
                )}
                {!['closed', 'cancelled'].includes(status) && (
                  <Button size="sm" variant="ghost" onClick={() => run(() => api(`/api/quality/capa/${capa.id}/cancel`, { method: 'POST', body: JSON.stringify({}) }), t('qc.cancelled'))}>{t('qc.cancel')}</Button>
                )}
              </div>
            </div>
          )}
        </StateView>
      </DialogContent>
    </Dialog>
  );
}

function Overdue() {
  const { t } = useLang();
  const [days, setDays] = useState('0');
  const q = useQuery<{ as_of: string; capas: Capa[]; count: number }>({ queryKey: ['capa-overdue', days], queryFn: () => api(`/api/quality/capa/overdue?days=${Number(days) || 0}`) });
  const rows = q.data?.capas ?? [];
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        <AlertTriangle className="size-4 shrink-0" /> {t('qc.overdue_hint')}
      </div>
      <div className="flex items-end gap-2">
        <div className="grid gap-2"><Label htmlFor="ov-days">{t('qc.horizon_days')}</Label><Input id="ov-days" type="number" className="w-32" value={days} onChange={(e) => setDays(e.target.value)} /></div>
      </div>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={rows}
            emptyState={{ icon: ClipboardCheck, title: t('qc.no_overdue_title'), description: t('qc.no_overdue_desc') }}
            columns={[
              { key: 'capa_no', label: t('qc.c_no') },
              { key: 'title', label: t('qc.f_title') },
              { key: 'owner', label: t('qc.c_owner') },
              { key: 'target_date', label: t('qc.f_target_date'), render: (r: Capa) => thaiDate(r.target_date) },
              { key: 'status', label: t('qc.c_status'), render: (r: Capa) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}
