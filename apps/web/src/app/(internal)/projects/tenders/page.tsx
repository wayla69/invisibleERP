'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Send, Trophy, X, Rocket } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DocSelect } from '@/components/doc-select';

// Tender / estimating → award (docs/35 P3, PROJ-17). Build a priced estimate, track win/loss, and on a win
// award it — which seeds a project + a draft BoQ from the winning bid.
const tone: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = { estimating: 'secondary', submitted: 'outline', won: 'default', lost: 'destructive' };

export default function TendersPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['tenders'], queryFn: () => api('/api/tenders') });
  const [f, setF] = useState({ title: '', customer_name: '', project_code: '', markup_pct: '20', description: '', qty: '', unit_cost: '' });
  // Project register (GET /api/projects) — the project is picked from a dropdown, not typed.
  const projList = useQuery<any>({ queryKey: ['projects-for-picker'], queryFn: () => api('/api/projects'), retry: false });
  const projOptions = (projList.data?.projects ?? []).map((p: any) => ({ value: p.project_code, label: [p.name, p.status].filter(Boolean).join(' · ') || undefined }));
  const refresh = () => qc.invalidateQueries({ queryKey: ['tenders'] });

  const create = useMutation({
    mutationFn: () => api('/api/tenders', { method: 'POST', body: JSON.stringify({
      title: f.title, customer_name: f.customer_name || undefined, project_code: f.project_code || undefined, markup_pct: Number(f.markup_pct) || 0,
      lines: f.qty ? [{ description: f.description || undefined, qty: Number(f.qty), unit_cost: Number(f.unit_cost) || 0 }] : [],
    }) }),
    onSuccess: () => { notifySuccess(t('cx.t_toast_created')); setF({ title: '', customer_name: '', project_code: '', markup_pct: '20', description: '', qty: '', unit_cost: '' }); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const act = useMutation({
    mutationFn: (v: { no: string; path: string; body?: any }) => api(`/api/tenders/${v.no}/${v.path}`, { method: 'POST', body: JSON.stringify(v.body ?? {}) }),
    onSuccess: (_d, v) => { notifySuccess(v.path === 'award' ? t('cx.t_toast_award') : t('cx.t_toast_updated')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const d = q.data;
  return (
    <div>
      <PageHeader title={t('cx.t_title')} description={t('cx.t_desc')} />
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatCard label={t('cx.t_stat_total')} value={d?.count ?? '—'} />
        <StatCard label={t('cx.t_stat_winrate')} value={d ? `${d.win_rate_pct}%` : '—'} />
        <StatCard label={t('cx.t_stat_pipeline')} value={baht(d?.pipeline_bid_value ?? 0)} />
      </div>

      <Card className="mb-5 gap-3 p-5">
        <h3 className="text-base font-semibold">{t('cx.t_form')}</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="grid gap-1.5"><Label>{t('cx.t_f_title')}</Label><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={t('cx.t_ph_title')} /></div>
          <div className="grid gap-1.5"><Label>{t('cx.t_f_customer')}</Label><Input value={f.customer_name} onChange={(e) => setF({ ...f, customer_name: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('cx.t_f_project')}</Label><DocSelect value={f.project_code} onValueChange={(v) => setF({ ...f, project_code: v })} options={projOptions} placeholder={t('common.doc_select_ph')} emptyText={t('common.doc_none')} allowManual manualPlaceholder="PRJ-…" /></div>
          <div className="grid gap-1.5"><Label>{t('cx.t_f_markup')}</Label><Input type="number" min="0" value={f.markup_pct} onChange={(e) => setF({ ...f, markup_pct: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('cx.t_f_linedesc')}</Label><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder={t('cx.t_ph_line')} /></div>
          <div className="grid gap-1.5"><Label>{t('cx.t_f_qty')}</Label><Input type="number" min="0" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('cx.t_f_unitcost')}</Label><Input type="number" min="0" value={f.unit_cost} onChange={(e) => setF({ ...f, unit_cost: e.target.value })} /></div>
        </div>
        <div><Button onClick={() => create.mutate()} disabled={!f.title || create.isPending}><Plus className="size-4" /> {t('cx.t_btn_create')}</Button></div>
      </Card>

      <StateView q={q}>{d && (
        <DataTable
          rows={d.tenders ?? []}
          rowKey={(r: any) => r.tender_no}
          columns={[
            { key: 'tender_no', label: t('cx.col_no') },
            { key: 'title', label: t('cx.col_title') },
            { key: 'customer_name', label: t('cx.col_customer') },
            { key: 'estimated_cost', label: t('cx.t_col_est'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.estimated_cost)}</span> },
            { key: 'bid_price', label: t('cx.t_col_bid'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.bid_price)}</span> },
            { key: 'status', label: t('cx.col_status'), render: (r: any) => <Badge variant={tone[r.status] ?? 'secondary'}>{r.status}</Badge> },
            { key: 'awarded_project_code', label: t('cx.t_col_project'), render: (r: any) => r.awarded_project_code ?? '—' },
            { key: 'actions', label: '', align: 'right', render: (r: any) => (
              <div className="flex justify-end gap-1.5">
                {r.status === 'estimating' && <Button size="sm" variant="outline" onClick={() => act.mutate({ no: r.tender_no, path: 'submit' })}><Send className="size-3.5" /> {t('cx.t_btn_submit')}</Button>}
                {(r.status === 'estimating' || r.status === 'submitted') && <Button size="sm" variant="outline" onClick={() => act.mutate({ no: r.tender_no, path: 'outcome', body: { outcome: 'won' } })}><Trophy className="size-3.5" /> {t('cx.t_btn_won')}</Button>}
                {(r.status === 'estimating' || r.status === 'submitted') && <Button size="sm" variant="ghost" onClick={() => { const reason = prompt(t('cx.t_prompt_loss')); if (reason) act.mutate({ no: r.tender_no, path: 'outcome', body: { outcome: 'lost', reason } }); }}><X className="size-3.5" /> {t('cx.t_btn_lost')}</Button>}
                {r.status === 'won' && !r.awarded_project_code && <Button size="sm" onClick={() => act.mutate({ no: r.tender_no, path: 'award' })}><Rocket className="size-3.5" /> {t('cx.t_btn_award')}</Button>}
              </div>
            ) },
          ]}
        />
      )}</StateView>
    </div>
  );
}
