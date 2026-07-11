'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, FilePlus2, CheckCircle2, Printer } from 'lucide-react';
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
import { NumberPromptDialog } from '@/components/number-prompt-dialog';
import { Select } from '@/components/form-controls';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

// Subcontractor management (docs/35 P2, PROJ-16). A subcontract reserves BoQ budget; the subcontractor's
// valuations are certified maker-checker → AP + WIP + retention payable + WHT.
export default function SubcontractsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  // Project register (GET /api/projects) — the project is picked from a dropdown, not typed.
  const projList = useQuery<any>({ queryKey: ['projects-for-picker'], queryFn: () => api('/api/projects'), retry: false });
  const projOptions = (projList.data?.projects ?? []).map((p: any) => ({ value: p.project_code, label: [p.name, p.status].filter(Boolean).join(' · ') || undefined }));
  const [active, setActive] = useState('');
  const subs = useQuery<any>({ queryKey: ['subcon', active], queryFn: () => api(`/api/subcontracts/project/${active}`), enabled: !!active });
  const boq = useQuery<any>({ queryKey: ['subcon-boq', active], queryFn: () => api(`/api/projects/${active}/boq`), enabled: !!active });
  const [f, setF] = useState({ vendor_name: '', boq_line_id: '', amount: '', retention_pct: '10', wht_pct: '3' });
  const [vals, setVals] = useState<Record<string, string>>({}); // subcontract_no → draft valuation_no
  const [pctFor, setPctFor] = useState<string | null>(null); // subcontract_no pending a valuation %
  const refresh = () => qc.invalidateQueries({ queryKey: ['subcon', active] });

  const create = useMutation({
    mutationFn: () => api('/api/subcontracts', { method: 'POST', body: JSON.stringify({ project_code: active, vendor_name: f.vendor_name || undefined, retention_pct: Number(f.retention_pct) || 0, wht_pct: Number(f.wht_pct) || 0, scope: [{ boq_line_id: Number(f.boq_line_id), amount: Number(f.amount) || 0 }] }) }),
    onSuccess: () => { notifySuccess(t('cx.s_toast_created')); setF({ vendor_name: '', boq_line_id: '', amount: '', retention_pct: '10', wht_pct: '3' }); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const raiseVal = useMutation({
    mutationFn: (v: { subNo: string; pct: number }) => api(`/api/subcontracts/${v.subNo}/valuations`, { method: 'POST', body: JSON.stringify({ pct_complete: v.pct }) }),
    onSuccess: (d: any, v) => { setVals((s) => ({ ...s, [v.subNo]: d.valuation_no })); notifySuccess(t('cx.s_toast_val', { no: d.valuation_no })); },
    onError: (e: any) => notifyError(e.message),
  });
  const certifyVal = useMutation({
    mutationFn: (valNo: string) => api(`/api/subcontracts/valuations/${valNo}/certify`, { method: 'POST' }),
    onSuccess: (_d, valNo) => { notifySuccess(t('cx.s_toast_valcert')); setVals((s) => { const n = { ...s }; Object.keys(n).forEach((k) => n[k] === valNo && delete n[k]); return n; }); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const d = subs.data;
  return (
    <div>
      <PageHeader title={t('cx.s_title')} description={t('cx.s_desc')} />
      <Card className="mb-5 flex flex-wrap items-end gap-3 p-5">
        <div className="grid gap-1.5"><Label>{t('cx.f_project')}</Label><DocSelect className="w-64" value={code} onValueChange={(v) => { setCode(v); if (v) setActive(v); }} options={projOptions} placeholder={t('common.doc_select_ph')} emptyText={t('common.doc_none')} allowManual manualPlaceholder="PRJ-…" /></div>
        <Button variant="outline" onClick={() => setActive(code.trim())} disabled={!code.trim()}><Search className="size-4" /> {t('cx.btn_openproject')}</Button>
      </Card>

      {active && (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <StatCard label={t('cx.s_stat_value')} value={baht(d?.subcontract_value ?? 0)} />
            <StatCard label={t('cx.s_stat_certified')} value={baht(d?.certified_to_date ?? 0)} />
            <StatCard label={t('cx.s_stat_retention')} value={baht(d?.retention_payable ?? 0)} />
          </div>

          <Card className="mb-5 gap-3 p-5">
            <h3 className="text-base font-semibold">{t('cx.s_form', { code: active })}</h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div className="grid gap-1.5"><Label>{t('cx.s_f_vendor')}</Label><Input value={f.vendor_name} onChange={(e) => setF({ ...f, vendor_name: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('cx.s_f_boq')}</Label>
                <Select value={f.boq_line_id} onChange={(e) => setF({ ...f, boq_line_id: e.target.value })}>
                  <option value="">{t('cx.opt_pick')}</option>
                  {(boq.data?.lines ?? []).map((l: any) => <option key={l.id} value={l.id}>{l.description ?? `#${l.line_no}`} · {baht(l.remaining ?? l.budget_amount)}</option>)}
                </Select>
              </div>
              <div className="grid gap-1.5"><Label>{t('cx.s_f_amount')}</Label><Input type="number" min="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('cx.s_f_retention')}</Label><Input type="number" min="0" value={f.retention_pct} onChange={(e) => setF({ ...f, retention_pct: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('cx.s_f_wht')}</Label><Input type="number" min="0" value={f.wht_pct} onChange={(e) => setF({ ...f, wht_pct: e.target.value })} /></div>
            </div>
            <div><Button onClick={() => create.mutate()} disabled={!f.boq_line_id || !f.amount || create.isPending}><Plus className="size-4" /> {t('cx.s_btn_create')}</Button></div>
          </Card>

          <StateView q={subs}>{d && (
            <DataTable
              rows={d.subcontracts ?? []}
              rowKey={(r: any) => r.subcontract_no}
              columns={[
                { key: 'subcontract_no', label: t('cx.col_no') },
                { key: 'vendor_name', label: t('cx.s_col_vendor') },
                { key: 'contract_value', label: t('cx.s_col_value'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.contract_value)}</span> },
                { key: 'certified_to_date', label: t('cx.s_col_certified'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.certified_to_date)}</span> },
                { key: 'status', label: t('cx.col_status'), render: (r: any) => <Badge variant={r.status === 'active' ? 'default' : 'secondary'}>{r.status}</Badge> },
                { key: 'actions', label: '', align: 'right', render: (r: any) => (
                  <div className="flex justify-end gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => setPctFor(r.subcontract_no)}><FilePlus2 className="size-3.5" /> {t('cx.s_btn_raiseval')}</Button>
                    {vals[r.subcontract_no] && <Button size="sm" onClick={() => certifyVal.mutate(vals[r.subcontract_no]!)}><CheckCircle2 className="size-3.5" /> {t('cx.s_btn_certifyval', { no: vals[r.subcontract_no] })}</Button>}
                    {vals[r.subcontract_no] && <Button variant="ghost" size="sm" asChild title={t('doc.print_pdf')}><a href={`${BASE}/api/subcontracts/valuations/${encodeURIComponent(vals[r.subcontract_no]!)}/pdf`} target="_blank" rel="noopener noreferrer"><Printer className="size-3.5" /></a></Button>}
                  </div>
                ) },
              ]}
            />
          )}</StateView>
        </>
      )}

      {pctFor && (
        <NumberPromptDialog
          title={t('cx.s_btn_raiseval')}
          fields={[{ key: 'pct', label: t('cx.s_prompt_pct'), min: 0, max: 100 }]}
          confirmLabel={t('cx.s_btn_raiseval')}
          busy={raiseVal.isPending}
          onConfirm={(get) => raiseVal.mutate({ subNo: pctFor, pct: get('pct') }, { onSuccess: () => setPctFor(null) })}
          onClose={() => setPctFor(null)}
        />
      )}
    </div>
  );
}
