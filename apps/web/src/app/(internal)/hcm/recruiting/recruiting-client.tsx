'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Briefcase, Users, FileText, Plus, ShieldAlert, Check, ArrowRight } from 'lucide-react';
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

// HR-4 (docs/42, Wave 2) — recruiting / ATS with the HR-04 maker-checker control. Reads gate hr/hr_admin/exec;
// writes hr/hr_admin; approvals (requisition + offer) hr_admin/exec. Requisitions must be approved by a
// different user before an application can advance to the offer/hired stages (REQUISITION_NOT_APPROVED), an
// offer must be authorized before it converts (OFFER_NOT_APPROVED), and a hire is headcount-bound.
export default function RecruitingClient({ initialReqs }: { initialReqs?: any }) {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('hx.rec.title')} description={t('hx.rec.subtitle')} />
      <Tabs tabs={[
        { key: 'requisitions', label: t('hx.rec.tab_requisitions'), content: <Requisitions initialReqs={initialReqs} /> },
        { key: 'pipeline', label: t('hx.rec.tab_pipeline'), content: <Pipeline /> },
        { key: 'offers', label: t('hx.rec.tab_offers'), content: <Offers /> },
      ]} />
    </div>
  );
}

const STAGE_ORDER = ['applied', 'screen', 'interview', 'offer', 'hired'];
const stageVariant = (st: string) => (st === 'hired' ? 'success' : st === 'rejected' ? 'destructive' : st === 'offer' ? 'warning' : 'secondary');
const reqVariant = (st: string) => (st === 'approved' ? 'success' : st === 'filled' ? 'secondary' : st === 'rejected' ? 'destructive' : 'warning');
const offerVariant = (st: string) => (st === 'accepted' ? 'success' : st === 'approved' ? 'warning' : st === 'declined' || st === 'withdrawn' ? 'destructive' : 'secondary');

function Requisitions({ initialReqs }: { initialReqs?: any }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['rec-reqs'], queryFn: () => api('/api/hcm/recruiting/requisitions'), initialData: initialReqs });
  const [f, setF] = useState({ req_no: '', position_code: '', headcount: '1', justification: '' });
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['rec-reqs'] }); };
  const add = useMutation({
    mutationFn: () => api('/api/hcm/recruiting/requisitions', { method: 'POST', body: JSON.stringify({ req_no: f.req_no || undefined, position_code: f.position_code || undefined, headcount: Number(f.headcount) || 1, justification: f.justification || undefined }) }),
    onSuccess: () => { notifySuccess(t('hx.rec.req_saved')); setF({ req_no: '', position_code: '', headcount: '1', justification: '' }); invalidate(); },
    onError: (e: any) => notifyError(e.message),
  });
  const approve = useMutation({
    mutationFn: (reqNo: string) => api(`/api/hcm/recruiting/requisitions/${reqNo}/approve`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('hx.rec.req_approved')); invalidate(); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hx.rec.new_requisition')}</h3>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><ShieldAlert className="size-3.5" /> {t('hx.rec.hr04_hint')}</p>
        <div className="flex flex-wrap gap-3">
          <div className="grid gap-1.5"><Label>{t('hx.rec.req_no')}</Label><Input value={f.req_no} onChange={(e) => setF({ ...f, req_no: e.target.value })} className="w-36" placeholder="REQ…" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.rec.position_code')}</Label><Input value={f.position_code} onChange={(e) => setF({ ...f, position_code: e.target.value })} className="w-36" placeholder="—" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.rec.headcount')}</Label><Input type="number" value={f.headcount} onChange={(e) => setF({ ...f, headcount: e.target.value })} className="w-24" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.rec.justification')}</Label><Input value={f.justification} onChange={(e) => setF({ ...f, justification: e.target.value })} className="w-64" /></div>
        </div>
        <div><Button onClick={() => add.mutate()} disabled={add.isPending}><Plus className="size-4" /> {t('fin.save')}</Button></div>
      </Card>
      <StateView q={q}>{q.data && <DataTable rows={q.data.requisitions} columns={[
        { key: 'req_no', label: t('hx.rec.req_no') },
        { key: 'position_code', label: t('hx.rec.position_code'), render: (r: any) => r.position_code ?? '—' },
        { key: 'headcount', label: t('hx.rec.headcount'), align: 'right', render: (r: any) => <Badge variant={r.hired >= r.headcount ? 'success' : 'secondary'}>{r.hired}/{r.headcount}</Badge> },
        { key: 'requested_by', label: t('hx.rec.requested_by'), render: (r: any) => r.requested_by ?? '—' },
        { key: 'approved_by', label: t('hx.rec.approved_by'), render: (r: any) => r.approved_by ?? '—' },
        { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={reqVariant(r.status)}>{r.status}</Badge> },
        { key: 'actions', label: '', render: (r: any) => (['pending', 'draft'].includes(r.status) ? <Button size="sm" variant="outline" onClick={() => approve.mutate(r.req_no)} disabled={approve.isPending}><Check className="size-3.5" /> {t('hx.rec.approve')}</Button> : null) },
      ]} emptyState={{ icon: Briefcase, title: t('hx.rec.req_empty'), description: t('hx.rec.new_requisition') }} />}</StateView>
    </div>
  );
}

function Pipeline() {
  const { t } = useLang();
  const qc = useQueryClient();
  const apps = useQuery<any>({ queryKey: ['rec-apps'], queryFn: () => api('/api/hcm/recruiting/applications') });
  const [cf, setCf] = useState({ cand_no: '', name: '', email: '', source: '' });
  const [af, setAf] = useState({ req_no: '', cand_no: '' });
  const addCand = useMutation({
    mutationFn: () => api('/api/hcm/recruiting/candidates', { method: 'POST', body: JSON.stringify({ cand_no: cf.cand_no || undefined, name: cf.name, email: cf.email || undefined, source: cf.source || undefined }) }),
    onSuccess: () => { notifySuccess(t('hx.rec.cand_saved')); setCf({ cand_no: '', name: '', email: '', source: '' }); qc.invalidateQueries({ queryKey: ['rec-cands'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const addApp = useMutation({
    mutationFn: () => api('/api/hcm/recruiting/applications', { method: 'POST', body: JSON.stringify({ req_no: af.req_no, cand_no: af.cand_no }) }),
    onSuccess: () => { notifySuccess(t('hx.rec.app_saved')); setAf({ req_no: '', cand_no: '' }); qc.invalidateQueries({ queryKey: ['rec-apps'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const advance = useMutation({
    mutationFn: ({ id, stage }: { id: number; stage: string }) => api(`/api/hcm/recruiting/applications/${id}/stage`, { method: 'PATCH', body: JSON.stringify({ stage }) }),
    onSuccess: () => { notifySuccess(t('hx.rec.stage_advanced')); qc.invalidateQueries({ queryKey: ['rec-apps'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const nextStage = (st: string) => { const i = STAGE_ORDER.indexOf(st); return i >= 0 && i < STAGE_ORDER.length - 1 ? STAGE_ORDER[i + 1] : null; };
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap gap-5">
        <Card className="grow gap-3 p-5">
          <h3 className="text-base font-semibold">{t('hx.rec.new_candidate')}</h3>
          <div className="flex flex-wrap gap-3">
            <div className="grid gap-1.5"><Label>{t('hx.rec.cand_no')}</Label><Input value={cf.cand_no} onChange={(e) => setCf({ ...cf, cand_no: e.target.value })} className="w-32" placeholder="CAND…" /></div>
            <div className="grid gap-1.5"><Label>{t('hx.rec.cand_name')}</Label><Input value={cf.name} onChange={(e) => setCf({ ...cf, name: e.target.value })} className="w-48" /></div>
            <div className="grid gap-1.5"><Label>{t('hx.rec.email')}</Label><Input value={cf.email} onChange={(e) => setCf({ ...cf, email: e.target.value })} className="w-48" /></div>
            <div className="grid gap-1.5"><Label>{t('hx.rec.source')}</Label><Input value={cf.source} onChange={(e) => setCf({ ...cf, source: e.target.value })} className="w-32" /></div>
          </div>
          <div><Button onClick={() => addCand.mutate()} disabled={!cf.name || addCand.isPending}><Plus className="size-4" /> {t('hx.rec.new_candidate')}</Button></div>
        </Card>
        <Card className="grow gap-3 p-5">
          <h3 className="text-base font-semibold">{t('hx.rec.new_application')}</h3>
          <div className="flex flex-wrap gap-3">
            <div className="grid gap-1.5"><Label>{t('hx.rec.req_no')}</Label><Input value={af.req_no} onChange={(e) => setAf({ ...af, req_no: e.target.value })} className="w-36" placeholder="REQ…" /></div>
            <div className="grid gap-1.5"><Label>{t('hx.rec.cand_no')}</Label><Input value={af.cand_no} onChange={(e) => setAf({ ...af, cand_no: e.target.value })} className="w-36" placeholder="CAND…" /></div>
          </div>
          <div><Button onClick={() => addApp.mutate()} disabled={!af.req_no || !af.cand_no || addApp.isPending}><Plus className="size-4" /> {t('hx.rec.new_application')}</Button></div>
        </Card>
      </div>
      <StateView q={apps}>{apps.data && <DataTable rows={apps.data.applications} columns={[
        { key: 'req_no', label: t('hx.rec.req_no'), render: (r: any) => r.req_no ?? r.requisition_id },
        { key: 'candidate_name', label: t('hx.rec.cand_name'), render: (r: any) => r.candidate_name ?? r.cand_no },
        { key: 'stage', label: t('hx.rec.stage'), render: (r: any) => <Badge variant={stageVariant(r.stage)}>{r.stage}</Badge> },
        { key: 'actions', label: '', render: (r: any) => { const nx = nextStage(r.stage); return nx ? <Button size="sm" variant="outline" onClick={() => advance.mutate({ id: r.id, stage: nx })} disabled={advance.isPending}>{t('hx.rec.advance')}: {nx} <ArrowRight className="size-3.5" /></Button> : null; } },
      ]} emptyState={{ icon: Users, title: t('hx.rec.pipeline_empty'), description: t('hx.rec.new_application') }} />}</StateView>
    </div>
  );
}

function Offers() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['rec-offers'], queryFn: () => api('/api/hcm/recruiting/offers') });
  const [f, setF] = useState({ application_id: '', offered_salary: '', offered_grade: '' });
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['rec-offers'] }); qc.invalidateQueries({ queryKey: ['rec-apps'] }); qc.invalidateQueries({ queryKey: ['rec-reqs'] }); };
  const add = useMutation({
    mutationFn: () => api('/api/hcm/recruiting/offers', { method: 'POST', body: JSON.stringify({ application_id: Number(f.application_id), offered_salary: Number(f.offered_salary) || 0, offered_grade: f.offered_grade || undefined }) }),
    onSuccess: () => { notifySuccess(t('hx.rec.offer_saved')); setF({ application_id: '', offered_salary: '', offered_grade: '' }); invalidate(); },
    onError: (e: any) => notifyError(e.message),
  });
  const approve = useMutation({
    mutationFn: (id: number) => api(`/api/hcm/recruiting/offers/${id}/approve`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('hx.rec.offer_approved')); invalidate(); },
    onError: (e: any) => notifyError(e.message),
  });
  const convert = useMutation({
    mutationFn: (id: number) => api(`/api/hcm/recruiting/offers/${id}/convert`, { method: 'POST' }),
    onSuccess: (r: any) => { notifySuccess(`${t('hx.rec.converted')} ${r?.emp_code ?? ''}`.trim()); invalidate(); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hx.rec.make_offer')}</h3>
        <div className="flex flex-wrap gap-3">
          <div className="grid gap-1.5"><Label>{t('hx.rec.application_id')}</Label><Input type="number" value={f.application_id} onChange={(e) => setF({ ...f, application_id: e.target.value })} className="w-32" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.rec.offered_salary')}</Label><Input type="number" value={f.offered_salary} onChange={(e) => setF({ ...f, offered_salary: e.target.value })} className="w-36" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.rec.offered_grade')}</Label><Input value={f.offered_grade} onChange={(e) => setF({ ...f, offered_grade: e.target.value })} className="w-28" /></div>
        </div>
        <div><Button onClick={() => add.mutate()} disabled={!f.application_id || add.isPending}><Plus className="size-4" /> {t('hx.rec.make_offer')}</Button></div>
      </Card>
      <StateView q={q}>{q.data && <DataTable rows={q.data.offers} columns={[
        { key: 'application_id', label: t('hx.rec.application_id') },
        { key: 'offered_salary', label: t('hx.rec.offered_salary'), align: 'right', render: (r: any) => Number(r.offered_salary ?? 0).toLocaleString() },
        { key: 'offered_grade', label: t('hx.rec.offered_grade'), render: (r: any) => r.offered_grade ?? '—' },
        { key: 'hired_emp_code', label: t('hx.rec.hired_emp'), render: (r: any) => r.hired_emp_code ?? '—' },
        { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={offerVariant(r.status)}>{r.status}</Badge> },
        { key: 'actions', label: '', render: (r: any) => (
          r.status === 'pending' ? <Button size="sm" variant="outline" onClick={() => approve.mutate(r.id)} disabled={approve.isPending}><Check className="size-3.5" /> {t('hx.rec.approve')}</Button>
          : r.status === 'approved' ? <Button size="sm" variant="outline" onClick={() => convert.mutate(r.id)} disabled={convert.isPending}><ArrowRight className="size-3.5" /> {t('hx.rec.convert')}</Button>
          : null
        ) },
      ]} emptyState={{ icon: FileText, title: t('hx.rec.offers_empty'), description: t('hx.rec.make_offer') }} />}</StateView>
    </div>
  );
}
