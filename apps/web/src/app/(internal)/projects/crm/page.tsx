'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Handshake, Plus, UserCheck, ArrowRightLeft, XCircle, Target, TrendingUp, FolderPlus, BarChart3 } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

const selectCls = 'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';
const STAGES = ['prospecting', 'qualification', 'proposal', 'negotiation', 'won', 'lost'] as const;
const stageBadge = (s: string) => <Badge variant={s === 'won' ? 'success' : s === 'lost' ? 'destructive' : 'secondary'}>{s}</Badge>;
const leadBadge = (s: string) => <Badge variant={s === 'converted' ? 'success' : s === 'lost' ? 'destructive' : s === 'qualified' ? 'info' : 'muted'}>{s}</Badge>;

// CRM sales pipeline management (REV-17) — leads → opportunities → convert a won deal into a project (CRM-WL).
export default function ProjectCrmPage() {
  const { t } = useLang();
  const router = useRouter();
  return (
    <div>
      <PageHeader
        title={t('pj.crm_title')}
        description={t('pj.crm_desc')}
        actions={<Button variant="outline" onClick={() => router.push('/projects/pipeline')}><BarChart3 className="size-4" /> {t('pj.btn_win_loss')}</Button>}
      />
      <Tabs tabs={[
        { key: 'opps', label: t('pj.tab_opps'), content: <Opportunities /> },
        { key: 'leads', label: t('pj.tab_leads'), content: <Leads /> },
      ]} />
    </div>
  );
}

function Leads() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['crm-leads'], queryFn: () => api('/api/crm/pipeline/leads') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['crm-leads'] });
  const [f, setF] = useState({ name: '', company: '', email: '', phone: '', source: '' });
  const create = useMutation({
    mutationFn: () => api('/api/crm/pipeline/leads', { method: 'POST', body: JSON.stringify({ name: f.name, company: f.company || undefined, email: f.email || undefined, phone: f.phone || undefined, source: f.source || undefined }) }),
    onSuccess: () => { notifySuccess(t('pj.toast_lead_added')); setF({ name: '', company: '', email: '', phone: '', source: '' }); refresh(); }, onError: (e: any) => notifyError(e.message),
  });
  const qualify = useMutation({ mutationFn: (no: string) => api(`/api/crm/pipeline/leads/${no}/qualify`, { method: 'POST', body: '{}' }), onSuccess: () => { notifySuccess(t('pj.toast_qualified')); refresh(); }, onError: (e: any) => notifyError(e.message) });
  const lose = useMutation({ mutationFn: (no: string) => api(`/api/crm/pipeline/leads/${no}/lose`, { method: 'POST', body: JSON.stringify({ reason: t('pj.lead_lose_reason') }) }), onSuccess: () => { notifySuccess(t('pj.toast_lead_lost')); refresh(); }, onError: (e: any) => notifyError(e.message) });

  const [conv, setConv] = useState<null | { lead_no: string; name: string }>(null);
  const [cf, setCf] = useState({ opportunity_name: '', amount: '', expected_close_date: '' });
  const convert = useMutation({
    mutationFn: () => api<any>(`/api/crm/pipeline/leads/${conv!.lead_no}/convert`, { method: 'POST', body: JSON.stringify({ opportunity_name: cf.opportunity_name || undefined, amount: Number(cf.amount) || undefined, expected_close_date: cf.expected_close_date || undefined }) }),
    onSuccess: (r: any) => { notifySuccess(t('pj.toast_lead_converted', { opp: r.opp_no })); setConv(null); setCf({ opportunity_name: '', amount: '', expected_close_date: '' }); refresh(); qc.invalidateQueries({ queryKey: ['crm-opps'] }); }, onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('pj.btn_add_lead')}</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="grid gap-1.5"><Label>{t('pj.f_contact_name')}</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('pj.f_company')}</Label><Input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('pj.f_source')}</Label><Input value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} placeholder={t('pj.ph_source')} /></div>
          <div className="grid gap-1.5"><Label>{t('pj.f_email')}</Label><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('pj.f_phone')}</Label><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
        </div>
        <div><Button onClick={() => create.mutate()} disabled={!f.name || create.isPending}><Plus className="size-4" /> {t('pj.btn_add_lead')}</Button></div>
      </Card>
      <StateView q={q}>{q.data && (
        <DataTable
          rows={q.data.leads ?? []}
          rowKey={(r: any) => r.lead_no}
          columns={[
            { key: 'lead_no', label: t('dash.col_no') },
            { key: 'name', label: t('pj.col_contact'), render: (r: any) => `${r.name}${r.company ? ` · ${r.company}` : ''}` },
            { key: 'source', label: t('pj.f_source'), render: (r: any) => r.source ?? '—' },
            { key: 'owner', label: t('pj.col_manager'), render: (r: any) => r.owner ?? '—' },
            { key: 'status', label: t('fin.col_status'), render: (r: any) => leadBadge(r.status) },
            { key: 'act', label: '', sortable: false, render: (r: any) => (
              <div className="flex justify-end gap-1">
                {r.status === 'new' && <Button size="sm" variant="ghost" title={t('pj.tip_qualify')} onClick={() => qualify.mutate(r.lead_no)}><UserCheck className="size-4" /></Button>}
                {(r.status === 'new' || r.status === 'qualified') && <Button size="sm" variant="ghost" title={t('pj.tip_convert_opp')} onClick={() => { setConv({ lead_no: r.lead_no, name: r.company || r.name }); setCf({ opportunity_name: `${r.company || r.name} opportunity`, amount: '', expected_close_date: '' }); }}><ArrowRightLeft className="size-4" /></Button>}
                {(r.status === 'new' || r.status === 'qualified') && <Button size="sm" variant="ghost" title={t('pj.tip_close_lost')} onClick={() => lose.mutate(r.lead_no)}><XCircle className="size-4" /></Button>}
              </div>
            ) },
          ]}
          emptyState={{ icon: Handshake, title: t('pj.empty_leads_title'), description: t('pj.empty_leads_desc') }}
        />
      )}</StateView>

      <Dialog open={!!conv} onOpenChange={(o) => !o && setConv(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('pj.dlg_convert_lead')} — {conv?.name}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5"><Label>{t('pj.f_opp_name')}</Label><Input value={cf.opportunity_name} onChange={(e) => setCf({ ...cf, opportunity_name: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>{t('pj.f_est_amount')}</Label><Input type="number" min="0" value={cf.amount} onChange={(e) => setCf({ ...cf, amount: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('pj.f_expected_close')}</Label><Input type="date" value={cf.expected_close_date} onChange={(e) => setCf({ ...cf, expected_close_date: e.target.value })} /></div>
            </div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setConv(null)}>{t('pj.btn_close')}</Button><Button onClick={() => convert.mutate()} disabled={convert.isPending}>{t('pj.btn_convert')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Opportunities() {
  const { t } = useLang();
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['crm-opps'], queryFn: () => api('/api/crm/pipeline/opportunities') });
  const sumQ = useQuery<any>({ queryKey: ['crm-summary'], queryFn: () => api('/api/crm/pipeline/summary') });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['crm-opps'] }); qc.invalidateQueries({ queryKey: ['crm-summary'] }); };
  const [f, setF] = useState({ name: '', amount: '', probability: '10', expected_close_date: '' });
  const create = useMutation({
    mutationFn: () => api('/api/crm/pipeline/opportunities', { method: 'POST', body: JSON.stringify({ name: f.name, amount: Number(f.amount) || undefined, probability: Number(f.probability) || undefined, expected_close_date: f.expected_close_date || undefined }) }),
    onSuccess: () => { notifySuccess(t('pj.add_opp')); setF({ name: '', amount: '', probability: '10', expected_close_date: '' }); refresh(); }, onError: (e: any) => notifyError(e.message),
  });
  const setStage = useMutation({
    mutationFn: (v: { oppNo: string; stage: string }) => api(`/api/crm/pipeline/opportunities/${v.oppNo}/stage`, { method: 'PATCH', body: JSON.stringify({ stage: v.stage, lost_reason: v.stage === 'lost' ? t('pj.lost_reason_default') : undefined }) }),
    onSuccess: () => { notifySuccess(t('pj.toast_stage_updated')); refresh(); }, onError: (e: any) => notifyError(e.message),
  });

  // Convert a WON opportunity into a project (CRM-WL) via /api/projects/from-opportunity/:oppNo.
  const [conv, setConv] = useState<null | { opp_no: string; name: string; amount: number }>(null);
  const [pf, setPf] = useState({ project_code: '', billing_type: 'Fixed', budget_amount: '', start_date: '', end_date: '' });
  const convert = useMutation({
    mutationFn: () => api<any>(`/api/projects/from-opportunity/${conv!.opp_no}`, { method: 'POST', body: JSON.stringify({ project_code: pf.project_code || undefined, billing_type: pf.billing_type, budget_amount: Number(pf.budget_amount) || undefined, start_date: pf.start_date || undefined, end_date: pf.end_date || undefined }) }),
    onSuccess: (r: any) => { notifySuccess(r?.already ? t('pj.toast_opp_already_converted', { code: r.project_code }) : t('pj.toast_created', { code: r.project_code })); setConv(null); router.push(`/projects/${encodeURIComponent(r.project_code)}`); }, onError: (e: any) => notifyError(e.message),
  });

  const s = sumQ.data;
  return (
    <div className="grid gap-5">
      {s && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label={t('pj.stat_open_amount')} value={baht(s.open_amount)} icon={Target} tone="primary" />
          <StatCard label={t('pj.stat_weighted_forecast')} value={baht(s.weighted_forecast)} icon={TrendingUp} tone="info" hint={t('pj.weighted_hint')} />
          <StatCard label={t('pj.stat_won')} value={baht(s.won_amount)} icon={TrendingUp} tone="success" />
          <StatCard label={t('pj.stat_win_rate')} value={`${Math.round((s.win_rate ?? 0) * 100)}%`} icon={BarChart3} tone="default" />
        </div>
      )}
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('pj.add_opp')}</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="grid gap-1.5"><Label>{t('pj.f_deal_name')}</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('pj.amount_th')}</Label><Input type="number" min="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('pj.f_probability_pct')}</Label><Input type="number" min="0" max="100" value={f.probability} onChange={(e) => setF({ ...f, probability: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('pj.f_expected_close')}</Label><Input type="date" value={f.expected_close_date} onChange={(e) => setF({ ...f, expected_close_date: e.target.value })} /></div>
        </div>
        <div><Button onClick={() => create.mutate()} disabled={!f.name || create.isPending}><Plus className="size-4" /> {t('pj.btn_add')}</Button></div>
      </Card>
      <StateView q={q}>{q.data && (
        <DataTable
          rows={q.data.opportunities ?? []}
          rowKey={(r: any) => r.opp_no}
          columns={[
            { key: 'opp_no', label: t('dash.col_no') },
            { key: 'name', label: t('pj.col_deal') },
            { key: 'amount', label: t('pj.amount_th'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
            { key: 'probability', label: t('pj.col_prob'), align: 'right', render: (r: any) => `${r.probability}%` },
            { key: 'weighted', label: t('pj.col_weighted'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.weighted)}</span> },
            { key: 'expected_close_date', label: t('pj.col_expected_close'), render: (r: any) => r.expected_close_date ?? '—' },
            { key: 'stage', label: t('pj.col_stage'), sortable: false, render: (r: any) => (r.stage === 'won' || r.stage === 'lost') ? stageBadge(r.stage) : (
              <select className={`${selectCls} w-36`} value={r.stage} onChange={(e) => setStage.mutate({ oppNo: r.opp_no, stage: e.target.value })}>
                {STAGES.map((st) => <option key={st} value={st}>{t(`pj.pipe_stage_${st}`)}</option>)}
              </select>
            ) },
            { key: 'act', label: '', sortable: false, render: (r: any) => r.stage === 'won'
              ? <Button size="sm" variant="outline" title={t('pj.tip_convert_project')} onClick={() => { setConv({ opp_no: r.opp_no, name: r.name, amount: r.amount }); setPf({ project_code: '', billing_type: 'Fixed', budget_amount: '', start_date: '', end_date: '' }); }}><FolderPlus className="size-4" /> {t('pj.btn_to_project')}</Button>
              : <span className="text-xs text-muted-foreground">—</span> },
          ]}
          emptyState={{ icon: Target, title: t('pj.empty_opps_title'), description: t('pj.empty_opps_desc') }}
        />
      )}</StateView>

      <Dialog open={!!conv} onOpenChange={(o) => !o && setConv(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('pj.dlg_convert_opp')} — {conv?.name}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">{t('pj.contract_from_deal', { amount: baht(conv?.amount ?? 0) })}</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>{t('pj.f_project_code')}</Label><Input value={pf.project_code} onChange={(e) => setPf({ ...pf, project_code: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('pj.billing_type')}</Label>
                <select className={selectCls} value={pf.billing_type} onChange={(e) => setPf({ ...pf, billing_type: e.target.value })}>
                  <option value="Fixed">{t('pj.bt_fixed')}</option><option value="TM">{t('pj.bt_tm')}</option>
                </select>
              </div>
              <div className="grid gap-1.5"><Label>{t('pj.f_budget')}</Label><Input type="number" min="0" value={pf.budget_amount} onChange={(e) => setPf({ ...pf, budget_amount: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('pj.f_start')}</Label><Input type="date" value={pf.start_date} onChange={(e) => setPf({ ...pf, start_date: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('pj.f_end')}</Label><Input type="date" value={pf.end_date} onChange={(e) => setPf({ ...pf, end_date: e.target.value })} /></div>
            </div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setConv(null)}>{t('pj.btn_close')}</Button><Button onClick={() => convert.mutate()} disabled={convert.isPending}>{t('pj.create_project')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
