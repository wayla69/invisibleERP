'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, CheckCircle2, XCircle, Lock, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

// QMS-1 (QC-01) — the NCR register + raise form + defect-code lookup. A financial disposition
// (scrap / use-as-is / return) must be approved by a DIFFERENT user than the raiser — the API returns
// 403 SOD_SELF_APPROVAL otherwise.
export default function NcrClient({ initialNcrs, initialDefects }: { initialNcrs?: any; initialDefects?: any }) {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('qc.ncr.title')} description={t('qc.ncr.subtitle')} />
      <Tabs tabs={[
        { key: 'register', label: t('qc.ncr.tab_register'), content: <Register initialNcrs={initialNcrs} /> },
        { key: 'raise', label: t('qc.ncr.tab_raise'), content: <Raise initialDefects={initialDefects} /> },
        { key: 'defects', label: t('qc.ncr.tab_defects'), content: <Defects initialDefects={initialDefects} /> },
      ]} />
    </div>
  );
}

const SEVERITIES = ['minor', 'major', 'critical'] as const;
const SOURCES = ['incoming', 'in_process', 'customer', 'supplier'] as const;
const DISPOSITIONS = ['scrap', 'use_as_is', 'return', 'rework'] as const;

const statusBadge = (t: (k: string) => string, sVal: string) =>
  sVal === 'dispositioned' ? <Badge variant="success">{t('qc.ncr.status_dispositioned')}</Badge>
  : sVal === 'closed' ? <Badge variant="secondary">{t('qc.ncr.status_closed')}</Badge>
  : sVal === 'pending_disposition' ? <Badge variant="warning">{t('qc.ncr.status_pending')}</Badge>
  : <Badge variant="outline">{t('qc.ncr.status_open')}</Badge>;

function Register({ initialNcrs }: { initialNcrs?: any }) {
  const { t, fmtNumber } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['qc-ncr'], queryFn: () => api('/api/quality/ncr'), initialData: initialNcrs });

  const post = (id: number, action: string) => api(`/api/quality/ncr/${id}/${action}`, { method: 'POST', body: JSON.stringify({}) });
  const onDone = (okMsg: string) => ({
    onSuccess: () => { notifySuccess(t(okMsg)); qc.invalidateQueries({ queryKey: ['qc-ncr'] }); },
    onError: (e: any) => notifyError(e?.message ?? 'error'),
  });
  const approve = useMutation({ mutationFn: (id: number) => post(id, 'disposition'), ...onDone('qc.ncr.approved_ok') });
  const reject = useMutation({ mutationFn: (id: number) => post(id, 'reject'), ...onDone('qc.ncr.rejected_ok') });
  const close = useMutation({ mutationFn: (id: number) => post(id, 'close'), ...onDone('qc.ncr.closed_ok') });

  const rows: any[] = q.data?.ncrs ?? [];
  return (
    <StateView q={q}>
      {rows.length === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground">{t('qc.ncr.empty')}</Card>
      ) : (
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="p-3">{t('qc.ncr.col_no')}</th>
              <th className="p-3">{t('qc.ncr.col_source')}</th>
              <th className="p-3">{t('qc.ncr.col_item')}</th>
              <th className="p-3">{t('qc.ncr.col_severity')}</th>
              <th className="p-3 text-right">{t('qc.ncr.col_qty')}</th>
              <th className="p-3">{t('qc.ncr.col_disposition')}</th>
              <th className="p-3 text-right">{t('qc.ncr.col_writeoff')}</th>
              <th className="p-3">{t('qc.ncr.col_raised_by')}</th>
              <th className="p-3">{t('qc.ncr.col_status')}</th>
              <th className="p-3 text-right">{t('qc.ncr.col_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b last:border-0">
                <td className="p-3 font-medium">{r.ncr_no}</td>
                <td className="p-3 text-xs text-muted-foreground">{t(`qc.ncr.source_${r.source}`)}</td>
                <td className="p-3">{r.item_id ?? '—'}</td>
                <td className="p-3"><SeverityBadge severity={r.severity} /></td>
                <td className="p-3 text-right">{fmtNumber(r.qty)}</td>
                <td className="p-3 text-xs">{r.proposed_disposition ? t(`qc.ncr.disp_${r.proposed_disposition}`) : t('qc.ncr.disp_none')}</td>
                <td className="p-3 text-right">{r.write_off_value ? fmtNumber(r.write_off_value) : '—'}</td>
                <td className="p-3 text-xs text-muted-foreground">{r.raised_by}</td>
                <td className="p-3">{statusBadge(t, r.status)}</td>
                <td className="p-3">
                  <div className="flex justify-end gap-2">
                    {r.status === 'pending_disposition' && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => approve.mutate(r.id)} disabled={approve.isPending}>
                          <CheckCircle2 className="size-4" /><span className="hidden sm:inline">{t('qc.ncr.btn_approve')}</span>
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => reject.mutate(r.id)} disabled={reject.isPending}>
                          <XCircle className="size-4" /><span className="hidden sm:inline">{t('qc.ncr.btn_reject')}</span>
                        </Button>
                      </>
                    )}
                    {r.status === 'dispositioned' && (
                      <Button size="sm" variant="ghost" onClick={() => close.mutate(r.id)} disabled={close.isPending}>
                        <Lock className="size-4" /><span className="hidden sm:inline">{t('qc.ncr.btn_close')}</span>
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      )}
    </StateView>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const { t } = useLang();
  const variant = severity === 'critical' ? 'destructive' : severity === 'major' ? 'warning' : 'secondary';
  return <Badge variant={variant as any}>{t(`qc.ncr.sev_${severity}`)}</Badge>;
}

function Raise({ initialDefects }: { initialDefects?: any }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const dq = useQuery<any>({ queryKey: ['qc-defects'], queryFn: () => api('/api/quality/defect-codes'), initialData: initialDefects });
  const [form, setForm] = useState<any>({ source: 'in_process', severity: 'minor', qty: 1, unit_cost: 0, proposed_disposition: '' });

  const raise = useMutation({
    mutationFn: () => api('/api/quality/ncr', { method: 'POST', body: JSON.stringify({
      source: form.source, ref_type: form.ref_type || undefined, ref_doc: form.ref_doc || undefined,
      item_id: form.item_id || undefined, defect_code: form.defect_code || undefined, severity: form.severity,
      qty: Number(form.qty) || 0, unit_cost: Number(form.unit_cost) || 0,
      description: form.description || undefined,
      proposed_disposition: form.proposed_disposition || undefined,
    }) }),
    onSuccess: () => { notifySuccess(t('qc.ncr.raised_ok')); setForm({ source: 'in_process', severity: 'minor', qty: 1, unit_cost: 0, proposed_disposition: '' }); qc.invalidateQueries({ queryKey: ['qc-ncr'] }); },
    onError: (e: any) => notifyError(e?.message ?? 'error'),
  });

  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });
  const defects: any[] = dq.data?.defect_codes ?? [];
  return (
    <Card className="max-w-2xl p-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('qc.ncr.f_source')}>
          <select className="w-full rounded-md border bg-background px-2 py-2" value={form.source} onChange={set('source')}>
            {SOURCES.map((sv) => <option key={sv} value={sv}>{t(`qc.ncr.source_${sv}`)}</option>)}
          </select>
        </Field>
        <Field label={t('qc.ncr.f_severity')}>
          <select className="w-full rounded-md border bg-background px-2 py-2" value={form.severity} onChange={set('severity')}>
            {SEVERITIES.map((sv) => <option key={sv} value={sv}>{t(`qc.ncr.sev_${sv}`)}</option>)}
          </select>
        </Field>
        <Field label={t('qc.ncr.f_ref_type')}><Input value={form.ref_type ?? ''} onChange={set('ref_type')} placeholder="WO / GR" /></Field>
        <Field label={t('qc.ncr.f_ref_doc')}><Input value={form.ref_doc ?? ''} onChange={set('ref_doc')} /></Field>
        <Field label={t('qc.ncr.f_item')}><Input value={form.item_id ?? ''} onChange={set('item_id')} /></Field>
        <Field label={t('qc.ncr.f_defect')}>
          <select className="w-full rounded-md border bg-background px-2 py-2" value={form.defect_code ?? ''} onChange={set('defect_code')}>
            <option value="">—</option>
            {defects.map((d) => <option key={d.id} value={d.code}>{d.code} {d.name ? `· ${d.name}` : ''}</option>)}
          </select>
        </Field>
        <Field label={t('qc.ncr.f_qty')}><Input type="number" value={form.qty} onChange={set('qty')} /></Field>
        <Field label={t('qc.ncr.f_unit_cost')}><Input type="number" value={form.unit_cost} onChange={set('unit_cost')} /></Field>
        <Field label={t('qc.ncr.f_disposition')}>
          <select className="w-full rounded-md border bg-background px-2 py-2" value={form.proposed_disposition} onChange={set('proposed_disposition')}>
            <option value="">—</option>
            {DISPOSITIONS.map((d) => <option key={d} value={d}>{t(`qc.ncr.disp_${d}`)}</option>)}
          </select>
        </Field>
        <Field label={t('qc.ncr.f_description')} full><Input value={form.description ?? ''} onChange={set('description')} /></Field>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{t('qc.ncr.hint_financial')}</p>
      <div className="mt-4">
        <Button onClick={() => raise.mutate()} disabled={raise.isPending}>
          <ShieldAlert className="size-4" />{t('qc.ncr.f_submit')}
        </Button>
      </div>
    </Card>
  );
}

function Defects({ initialDefects }: { initialDefects?: any }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['qc-defects'], queryFn: () => api('/api/quality/defect-codes'), initialData: initialDefects });
  const [form, setForm] = useState<any>({ code: '', name: '', category: '' });
  const add = useMutation({
    mutationFn: () => api('/api/quality/defect-codes', { method: 'POST', body: JSON.stringify({ code: form.code, name: form.name || undefined, category: form.category || undefined }) }),
    onSuccess: () => { notifySuccess(t('qc.ncr.dc_added_ok')); setForm({ code: '', name: '', category: '' }); qc.invalidateQueries({ queryKey: ['qc-defects'] }); },
    onError: (e: any) => notifyError(e?.message ?? 'error'),
  });
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });
  const rows: any[] = q.data?.defect_codes ?? [];
  return (
    <div className="grid gap-4">
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <Field label={t('qc.ncr.dc_code')}><Input value={form.code} onChange={set('code')} /></Field>
        <Field label={t('qc.ncr.dc_name')}><Input value={form.name} onChange={set('name')} /></Field>
        <Field label={t('qc.ncr.dc_category')}><Input value={form.category} onChange={set('category')} /></Field>
        <Button onClick={() => add.mutate()} disabled={add.isPending || !form.code}><Plus className="size-4" />{t('qc.ncr.dc_add')}</Button>
      </Card>
      <StateView q={q}>
        {rows.length === 0 ? (
          <Card className="p-6 text-sm text-muted-foreground">{t('qc.ncr.dc_empty')}</Card>
        ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="p-3">{t('qc.ncr.dc_code')}</th>
                <th className="p-3">{t('qc.ncr.dc_name')}</th>
                <th className="p-3">{t('qc.ncr.dc_category')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="border-b last:border-0">
                  <td className="p-3 font-medium">{d.code}</td>
                  <td className="p-3">{d.name ?? '—'}</td>
                  <td className="p-3 text-xs text-muted-foreground">{d.category ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        )}
      </StateView>
    </div>
  );
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <label className={`grid gap-1 text-sm ${full ? 'sm:col-span-2' : ''}`}>
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className="w-full rounded-md border bg-background px-2 py-2" />;
}
