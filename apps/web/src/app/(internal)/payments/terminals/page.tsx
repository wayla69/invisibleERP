'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CreditCard, Banknote, ListChecks, Layers } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';
import { useLang } from '@/lib/i18n';
import { Select } from '@/components/form-controls';
import { DocSelect } from '@/components/doc-select';


function Field({ label, htmlFor, hint, className, children }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function TerminalsPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('px.payterm_page_title')} description={t('px.payterm_page_desc')} />
      <Tabs tabs={[{ key: 'terminals', label: t('px.payterm_tab_terminals'), content: <Terminals /> }, { key: 'settle', label: t('px.payterm_tab_settle'), content: <Settlements /> }]} />
    </div>
  );
}

function Terminals() {
  const { t } = useLang();
  const qc = useQueryClient();
  const terms = useQuery<any>({ queryKey: ['terminals'], queryFn: () => api('/api/payments/terminal/terminals') });
  const intents = useQuery<any>({ queryKey: ['intents'], queryFn: () => api('/api/payments/terminal/intents') });
  const [frm, setFrm] = useState({ terminal_code: '', name: '' });
  const [c, setC] = useState({ terminal_code: '', amount: '', tip: '', type: 'sale', sale_no: '', record_tender: false });
  // Recent POS sales — the bill is picked from a dropdown, not typed (manual escape kept).
  const salesQ = useQuery<any>({ queryKey: ['pos-sales-for-picker'], queryFn: () => api('/api/pos/orders?limit=50'), retry: false });
  const saleOptions = (salesQ.data?.orders ?? []).map((o: any) => ({ value: o.Sale_No, label: [o.Status, baht(o.Total)].filter(Boolean).join(' · ') || undefined }));
  const refresh = () => { qc.invalidateQueries({ queryKey: ['terminals'] }); qc.invalidateQueries({ queryKey: ['intents'] }); };
  const reg = useMutation({ mutationFn: () => api('/api/payments/terminal/register', { method: 'POST', body: JSON.stringify({ terminal_code: frm.terminal_code, name: frm.name || undefined }) }), onSuccess: () => { notifySuccess(t('px.payterm_terminal_added')); setFrm({ terminal_code: '', name: '' }); refresh(); }, onError: (e: any) => notifyError(e.message) });
  const charge = useMutation({ mutationFn: () => api('/api/payments/terminal/charge', { method: 'POST', body: JSON.stringify({ terminal_code: c.terminal_code || undefined, amount: Number(c.amount), tip: c.tip ? Number(c.tip) : undefined, type: c.type, sale_no: c.sale_no || undefined, record_tender: c.record_tender }) }), onSuccess: (r: any) => { notifySuccess(`${r.intent_no} → ${r.status}${r.payment_no ? ` · tender ${r.payment_no}` : ''}`); setC({ terminal_code: '', amount: '', tip: '', type: 'sale', sale_no: '', record_tender: false }); refresh(); }, onError: (e: any) => notifyError(e.message) });
  const act = useMutation({ mutationFn: (v: { no: string; op: string; body?: any }) => api(`/api/payments/terminal/intents/${v.no}/${v.op}`, { method: 'POST', body: JSON.stringify(v.body ?? {}) }), onSuccess: () => refresh(), onError: (e: any) => notifyError(e.message) });

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">{t('px.payterm_add_terminal')}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <Field label={t('px.payterm_terminal_code')} htmlFor="t-code"><Input id="t-code" placeholder={t('px.payterm_eg_term1')} value={frm.terminal_code} onChange={(e) => setFrm({ ...frm, terminal_code: e.target.value })} /></Field>
            <Field label={t('px.payterm_name_optional')} htmlFor="t-name"><Input id="t-name" placeholder={t('px.payterm_eg_front_counter')} value={frm.name} onChange={(e) => setFrm({ ...frm, name: e.target.value })} /></Field>
            <Button className="w-fit" disabled={!frm.terminal_code || reg.isPending} onClick={() => reg.mutate()}><CreditCard className="size-4" /> {reg.isPending ? t('px.payterm_adding') : t('px.payterm_add_terminal_btn')}</Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">{t('px.payterm_charge_test')}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('px.payterm_terminal_code')} htmlFor="c-term"><Input id="c-term" placeholder={t('px.payterm_eg_term1')} value={c.terminal_code} onChange={(e) => setC({ ...c, terminal_code: e.target.value })} /></Field>
              <Field label={t('px.payterm_amount_baht')} htmlFor="c-amt"><Input id="c-amt" type="number" inputMode="decimal" placeholder="0" value={c.amount} onChange={(e) => setC({ ...c, amount: e.target.value })} /></Field>
              <Field label={t('px.payterm_tip')} htmlFor="c-tip"><Input id="c-tip" type="number" inputMode="decimal" placeholder="0" value={c.tip} onChange={(e) => setC({ ...c, tip: e.target.value })} /></Field>
              <Field label={t('px.payterm_type')} htmlFor="c-type">
                <Select id="c-type"  value={c.type} onChange={(e) => setC({ ...c, type: e.target.value })}>
                  <option value="sale">{t('px.payterm_opt_sale')}</option><option value="preauth">{t('px.payterm_opt_preauth')}</option>
                </Select>
              </Field>
              <Field label={t('px.payterm_sale_no_optional')} htmlFor="c-sale"><DocSelect id="c-sale" value={c.sale_no} onValueChange={(v) => setC({ ...c, sale_no: v })} options={saleOptions} placeholder={t('common.doc_select_ph')} emptyText={t('common.doc_none')} allowManual manualPlaceholder="SALE-…" /></Field>
            </div>
            <label className="flex items-center gap-2 text-sm" title={t('px.payterm_record_tender_title')}>
              <input type="checkbox" className="size-4 accent-primary" checked={c.record_tender} onChange={(e) => setC({ ...c, record_tender: e.target.checked })} /> {t('px.payterm_record_tender')}
            </label>
            <Button disabled={!c.amount || charge.isPending} onClick={() => charge.mutate()}><Banknote className="size-4" /> {charge.isPending ? t('px.payterm_charging') : t('px.payterm_charge_btn')}</Button>
          </CardContent>
        </Card>
      </div>
      <StateView q={terms}>{terms.data && <DataTable rows={terms.data.terminals} rowKey={(r: any) => r.terminal_code} columns={[{ key: 'terminal_code', label: t('px.payterm_col_code') }, { key: 'name', label: t('px.payterm_col_name'), render: (r: any) => r.name || '—' }, { key: 'provider', label: t('px.payterm_col_provider') }, { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status === 'active' ? 'active' : 'cancelled')}>{r.status}</Badge> }]} emptyState={{ icon: CreditCard, title: t('px.payterm_empty_terminals_title'), description: t('px.payterm_empty_terminals_desc') }} />}</StateView>
      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('px.payterm_intents_heading')}</h3>
        <StateView q={intents}>
          {intents.data && (
            <DataTable
              rows={intents.data.intents}
              rowKey={(r: any) => r.intent_no}
              columns={[
                { key: 'intent_no', label: t('dash.col_no') },
                { key: 'type', label: t('px.payterm_type') },
                { key: 'amount', label: t('fin.col_amount'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
                { key: 'captured_amount', label: t('px.payterm_col_captured'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.captured_amount)}</span> },
                { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                { key: 'act', label: '', sortable: false, render: (r: any) => {
                  // Disable this row's actions while a mutation against it is in flight — a double-click
                  // must not fire a duplicate capture / void / refund (real money movement).
                  const busy = act.isPending && act.variables?.no === r.intent_no;
                  return (
                  <div className="flex gap-1">
                    {r.status === 'Authorized' && <Button size="sm" disabled={busy} onClick={() => { const tp = prompt(t('px.payterm_capture_tip_prompt'), '0'); if (tp == null) return; act.mutate({ no: r.intent_no, op: 'capture', body: Number(tp) > 0 ? { tip: Number(tp) } : {} }); }}>{t('px.payterm_capture')}</Button>}
                    {r.status === 'Authorized' && <Button size="sm" variant="outline" disabled={busy} onClick={() => act.mutate({ no: r.intent_no, op: 'void' })}>{t('fin.cancel')}</Button>}
                    {r.status === 'Captured' && <Button size="sm" variant="destructive" disabled={busy} onClick={() => { const a = prompt(t('px.payterm_refund_amount_prompt')); if (a) act.mutate({ no: r.intent_no, op: 'refund', body: { amount: Number(a) } }); }}>{t('px.payterm_refund')}</Button>}
                  </div>
                  );
                } },
              ]}
              emptyState={{ icon: ListChecks, title: t('px.payterm_empty_intents_title'), description: t('px.payterm_empty_intents_desc') }}
            />
          )}
        </StateView>
      </div>
    </div>
  );
}

function Settlements() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['settlements'], queryFn: () => api('/api/payments/terminal/settlements') });
  const [fee, setFee] = useState('2');
  // C5 — acquirer settlement-report import (paste CSV: provider_ref,amount[,fee]); matched per intent.
  const [imp, setImp] = useState({ batch_no: '', csv: '' });
  const settle = useMutation({ mutationFn: () => api('/api/payments/terminal/settle', { method: 'POST', body: JSON.stringify({ fee_pct: Number(fee) }) }), onSuccess: (r: any) => { notifySuccess(t('px.payterm_settle_done', { batch_no: r.batch_no, count: r.txn_count })); qc.invalidateQueries({ queryKey: ['settlements'] }); }, onError: (e: any) => notifyError(e.message) });
  const reconcile = useMutation({ mutationFn: (no: string) => api(`/api/payments/terminal/settlements/${no}/reconcile`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['settlements'] }) });
  const importReport = useMutation({
    mutationFn: () => {
      const rows = imp.csv.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [ref, amt, f] = l.split(',').map((x) => x.trim());
        return { provider_ref: ref ?? '', amount: Number(amt ?? 0), fee: f ? Number(f) : undefined };
      });
      return api(`/api/payments/terminal/settlements/${imp.batch_no}/import`, { method: 'POST', body: JSON.stringify({ rows }) });
    },
    onSuccess: (r: any) => {
      (r.discrepancies === 0 ? notifySuccess : notifyError)(t(r.discrepancies === 0 ? 'px.payterm_import_ok' : 'px.payterm_import_diff', { matched: r.matched, diff: r.discrepancies }));
      setImp({ batch_no: '', csv: '' });
      qc.invalidateQueries({ queryKey: ['settlements'] });
    },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">{t('px.payterm_settle_card')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-end gap-2">
            <Field label={t('px.payterm_fee_pct')} htmlFor="s-fee" className="max-w-[140px]"><Input id="s-fee" type="number" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} /></Field>
            <Button disabled={settle.isPending} onClick={() => settle.mutate()}>{settle.isPending ? t('px.payterm_settling') : t('px.payterm_settle_captured')}</Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">{t('px.payterm_import_card')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Field label={t('px.payterm_col_batch_no')} htmlFor="i-batch"><Input id="i-batch" placeholder="STL-…" value={imp.batch_no} onChange={(e) => setImp({ ...imp, batch_no: e.target.value })} /></Field>
          <textarea className="min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs"
            placeholder={t('px.payterm_import_ph')} value={imp.csv} onChange={(e) => setImp({ ...imp, csv: e.target.value })} />
          <Button className="w-fit" disabled={!imp.batch_no || !imp.csv.trim() || importReport.isPending} onClick={() => importReport.mutate()}>{t('px.payterm_import_btn')}</Button>
        </CardContent>
      </Card>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.batches}
            rowKey={(r: any) => r.batch_no}
            columns={[
              { key: 'batch_no', label: t('px.payterm_col_batch_no') },
              { key: 'batch_date', label: t('dash.col_date') },
              { key: 'gross', label: t('px.payterm_col_gross'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.gross)}</span> },
              { key: 'fees', label: t('px.payterm_col_fees'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.fees)}</span> },
              { key: 'net', label: t('px.payterm_col_net'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.net)}</span> },
              { key: 'txn_count', label: t('inv.col_qty'), align: 'right' },
              { key: 'discrepancy_count', label: t('px.payterm_col_diff'), align: 'right', render: (r: any) => r.discrepancy_count > 0 ? <Badge variant="destructive">{r.discrepancy_count}</Badge> : (r.discrepancy_count ?? '—') },
              { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status === 'Reconciled' ? 'paid' : 'open')}>{r.status}</Badge> },
              { key: 'act', label: '', sortable: false, render: (r: any) => r.status !== 'Reconciled' ? <Button size="sm" variant="outline" disabled={reconcile.isPending && reconcile.variables === r.batch_no} onClick={() => reconcile.mutate(r.batch_no)}>{t('px.payterm_reconcile')}</Button> : null },
            ]}
            emptyState={{ icon: Layers, title: t('px.payterm_empty_settle_title'), description: t('px.payterm_empty_settle_desc') }}
          />
        )}
      </StateView>
    </div>
  );
}
