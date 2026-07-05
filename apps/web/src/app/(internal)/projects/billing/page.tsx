'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, CheckCircle2, Search, Printer } from 'lucide-react';
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

const selectCls = 'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring';
const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

// Progress billing / งวดงาน (docs/35 P1, PROJ-15). Value work by BoQ line, withhold retention, add output VAT,
// certify maker-checker. Pick a project → raise a claim against a BoQ line → certify.
export default function BillingPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [active, setActive] = useState('');
  const claims = useQuery<any>({ queryKey: ['pbill', active], queryFn: () => api(`/api/progress-billing/project/${active}`), enabled: !!active });
  const boq = useQuery<any>({ queryKey: ['pbill-boq', active], queryFn: () => api(`/api/projects/${active}/boq`), enabled: !!active });
  const [f, setF] = useState({ boq_line_id: '', pct: '', retention_pct: '10', vat_pct: '7' });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['pbill', active] }); };

  const create = useMutation({
    mutationFn: () => api('/api/progress-billing', { method: 'POST', body: JSON.stringify({ project_code: active, retention_pct: Number(f.retention_pct) || 0, vat_pct: Number(f.vat_pct) || 0, lines: [{ boq_line_id: Number(f.boq_line_id), pct_complete_to_date: Number(f.pct) || 0 }] }) }),
    onSuccess: () => { notifySuccess(t('cx.b_toast_created')); setF({ boq_line_id: '', pct: '', retention_pct: '10', vat_pct: '7' }); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const certify = useMutation({
    mutationFn: (no: string) => api(`/api/progress-billing/${no}/certify`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('cx.b_toast_certified')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const d = claims.data;
  return (
    <div>
      <PageHeader title={t('cx.b_title')} description={t('cx.b_desc')} />
      <Card className="mb-5 flex flex-wrap items-end gap-3 p-5">
        <div className="grid gap-1.5"><Label>{t('cx.f_project')}</Label><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="PRJ-…" /></div>
        <Button variant="outline" onClick={() => setActive(code.trim())} disabled={!code.trim()}><Search className="size-4" /> {t('cx.btn_openproject')}</Button>
      </Card>

      {active && (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <StatCard label={t('cx.b_stat_contract')} value={baht(d?.contract_amount ?? 0)} />
            <StatCard label={t('cx.b_stat_certified')} value={baht(d?.certified_to_date ?? 0)} />
            <StatCard label={t('cx.b_stat_retention')} value={baht(d?.retention_withheld ?? 0)} />
          </div>

          <Card className="mb-5 gap-3 p-5">
            <h3 className="text-base font-semibold">{t('cx.b_form', { code: active })}</h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="grid gap-1.5"><Label>{t('cx.b_f_boq')}</Label>
                <select className={selectCls} value={f.boq_line_id} onChange={(e) => setF({ ...f, boq_line_id: e.target.value })}>
                  <option value="">{t('cx.opt_pick')}</option>
                  {(boq.data?.lines ?? []).map((l: any) => <option key={l.id} value={l.id}>{l.description ?? l.item_no ?? `#${l.line_no}`} · {baht(l.budget_amount)}</option>)}
                </select>
              </div>
              <div className="grid gap-1.5"><Label>{t('cx.b_f_pct')}</Label><Input type="number" min="0" max="100" value={f.pct} onChange={(e) => setF({ ...f, pct: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('cx.b_f_retention')}</Label><Input type="number" min="0" max="100" value={f.retention_pct} onChange={(e) => setF({ ...f, retention_pct: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('cx.b_f_vat')}</Label><Input type="number" min="0" max="100" value={f.vat_pct} onChange={(e) => setF({ ...f, vat_pct: e.target.value })} /></div>
            </div>
            <div><Button onClick={() => create.mutate()} disabled={!f.boq_line_id || !f.pct || create.isPending}><Plus className="size-4" /> {t('cx.b_btn_create')}</Button></div>
          </Card>

          <StateView q={claims}>{d && (
            <DataTable
              rows={d.claims ?? []}
              rowKey={(r: any) => r.claim_no}
              columns={[
                { key: 'claim_no', label: t('cx.col_no') },
                { key: 'seq', label: t('cx.b_col_seq'), align: 'right' },
                { key: 'gross_this_claim', label: t('cx.b_col_gross'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.gross_this_claim)}</span> },
                { key: 'retention_amount', label: t('cx.b_col_retention'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.retention_amount)}</span> },
                { key: 'net_payable', label: t('cx.b_col_net'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.net_payable)}</span> },
                { key: 'status', label: t('cx.col_status'), render: (r: any) => <Badge variant={r.status === 'certified' ? 'default' : 'secondary'}>{r.status}</Badge> },
                { key: 'actions', label: '', align: 'right', render: (r: any) => (
                  <div className="flex justify-end gap-1.5">
                    {r.status === 'draft' && <Button size="sm" onClick={() => certify.mutate(r.claim_no)}><CheckCircle2 className="size-3.5" /> {t('cx.b_btn_certify')}</Button>}
                    <Button variant="ghost" size="sm" asChild title={t('doc.print_pdf')}>
                      <a href={`${BASE}/api/progress-billing/${encodeURIComponent(r.claim_no)}/pdf`} target="_blank" rel="noopener noreferrer"><Printer className="size-3.5" /></a>
                    </Button>
                  </div>
                ) },
              ]}
            />
          )}</StateView>
        </>
      )}
    </div>
  );
}
