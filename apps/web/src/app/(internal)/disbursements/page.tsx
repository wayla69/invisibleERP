'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCheck, Download, ListChecks } from 'lucide-react';
import { api, apiDownload } from '@/lib/api';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useBatchActions, BatchBar, batchColumn } from '@/components/batch-actions';

// Treasury / finance disbursement surface (perm: approvals | gl_close). The CHECKER side of the AP
// maker-checker: accounting (creditors) books the bill and requests payment on /finance; finance
// approves & releases the cash here. Approver ≠ requester is enforced server-side (EXP-06 / SoD R07).
// The AP PAYMENT RUN section (EXP-13) adds the batch flow: propose by due-date cutoff (creditors) →
// line review → submit → approve (distinct approver) → execute → download the bank bulk-transfer file.
export default function DisbursementsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const pending = useQuery<any>({ queryKey: ['ap-disbursements'], queryFn: () => api('/api/finance/ap/payments/pending'), retry: false });
  const refresh = () => qc.invalidateQueries({ queryKey: ['ap-disbursements'] });

  const approve = useMutation({
    mutationFn: (no: string) => api(`/api/finance/ap/payments/${no}/approve`, { method: 'POST' }),
    onSuccess: (r: any) => { notifySuccess(t('disb.approved', { no: r.payment_no, status: r.bill_status })); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const reject = useMutation({
    mutationFn: (no: string) => api(`/api/finance/ap/payments/${no}/reject`, { method: 'POST', body: JSON.stringify({ reason: 'rejected by approver' }) }),
    onSuccess: (r: any) => { notifySuccess(t('disb.rejected', { no: r.payment_no })); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  // Batch approve/reject the single-bill queue — loops the same per-payment endpoints (SoD per item).
  const batch = useBatchActions<any>({
    items: pending.data?.payments ?? [],
    keyOf: (r) => String(r.payment_no),
    run: (r, action, reason) =>
      action === 'approve'
        ? api(`/api/finance/ap/payments/${r.payment_no}/approve`, { method: 'POST' })
        : api(`/api/finance/ap/payments/${r.payment_no}/reject`, { method: 'POST', body: JSON.stringify({ reason: reason || 'rejected by approver' }) }),
    onDone: refresh,
  });

  // ── AP payment runs (EXP-13) ──
  const [cutoff, setCutoff] = useState('');
  const [payDate, setPayDate] = useState('');
  const [bankId, setBankId] = useState('');
  const [whtCode, setWhtCode] = useState('');
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [fileFmt, setFileFmt] = useState('generic');
  const runs = useQuery<any>({ queryKey: ['ap-payment-runs'], queryFn: () => api('/api/finance/ap/payment-runs'), retry: false });
  const banks = useQuery<any>({ queryKey: ['bank-accounts-list'], queryFn: () => api('/api/bank/accounts'), retry: false });
  const runDetail = useQuery<any>({ queryKey: ['ap-payment-run', openRun], queryFn: () => api(`/api/finance/ap/payment-runs/${openRun}`), enabled: !!openRun, retry: false });
  const refreshRuns = () => { qc.invalidateQueries({ queryKey: ['ap-payment-runs'] }); if (openRun) qc.invalidateQueries({ queryKey: ['ap-payment-run', openRun] }); refresh(); };

  const propose = useMutation({
    mutationFn: () => api('/api/finance/ap/payment-runs/propose', { method: 'POST', body: JSON.stringify({ due_cutoff: cutoff, pay_date: payDate || undefined, bank_account_id: Number(bankId), wht_tax_code: whtCode || undefined }) }),
    onSuccess: (r: any) => { notifySuccess(t('disb.run_proposed', { no: r.run_no, n: r.line_count })); setOpenRun(r.run_no); refreshRuns(); },
    onError: (e: any) => notifyError(e.message),
  });
  const runAct = useMutation({
    mutationFn: (v: { no: string; act: string }) => api(`/api/finance/ap/payment-runs/${v.no}/${v.act}`, { method: 'POST', body: v.act === 'reject' ? JSON.stringify({ reason: 'rejected by approver' }) : undefined }),
    onSuccess: (r: any) => { notifySuccess(t('disb.run_acted', { no: r.run_no, status: r.status })); refreshRuns(); },
    onError: (e: any) => notifyError(e.message),
  });
  const removeLine = useMutation({
    mutationFn: (v: { no: string; lineId: number }) => api(`/api/finance/ap/payment-runs/${v.no}/lines`, { method: 'PATCH', body: JSON.stringify({ remove_line_ids: [v.lineId] }) }),
    onSuccess: () => { notifySuccess(t('disb.run_line_removed')); refreshRuns(); },
    onError: (e: any) => notifyError(e.message),
  });

  const statusBadge = (s: string) => {
    const variant = s === 'Executed' ? 'default' : s === 'Approved' ? 'secondary' : s === 'Rejected' || s === 'Cancelled' ? 'destructive' : 'outline';
    return <Badge variant={variant as any}>{s}</Badge>;
  };

  const d = runDetail.data;
  return (
    <div>
      <PageHeader title={t('disb.title')} description={t('disb.subtitle')} />

      <StateView q={pending}>
        {pending.data ? (
          <>
          <BatchBar
            eligibleCount={batch.eligibleCount}
            selectedCount={batch.selectedCount}
            running={batch.running}
            onSelectAll={batch.selectAll}
            onApprove={() => batch.runBatch('approve')}
            onReject={() => batch.runBatch('reject')}
            onClear={batch.clear}
          />
          <DataTable
            rows={pending.data.payments}
            rowKey={(r: any) => r.payment_no}
            emptyState={{ icon: CheckCheck, title: t('disb.empty_title'), description: t('disb.empty_desc') }}
            columns={[
              batchColumn<any>({ isSel: batch.isSel, isEligible: batch.isEligible, toggle: batch.toggle, refOf: (r) => String(r.payment_no) }),
              { key: 'payment_no', label: t('disb.col_request_no') },
              { key: 'txn_no', label: t('disb.col_ap_bill') },
              { key: 'vendor_name', label: t('fin.col_creditor') },
              { key: 'requested_by', label: t('disb.col_requested_by') },
              { key: 'amount', label: t('fin.col_amount2'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
              { key: 'act', label: '', sortable: false, render: (r: any) => {
                const busy = (approve.isPending && approve.variables === r.payment_no) || (reject.isPending && reject.variables === r.payment_no);
                return (
                  <div className="flex gap-1">
                    <Button size="sm" disabled={busy} onClick={() => approve.mutate(r.payment_no)}>{t('disb.approve_pay')}</Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => reject.mutate(r.payment_no)}>{t('disb.reject')}</Button>
                  </div>
                );
              } },
            ]}
          />
          </>
        ) : (
          <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">{t('disb.no_perm')}</CardContent></Card>
        )}
      </StateView>

      {/* ── AP payment runs (EXP-13): propose → review → approve → execute → bank file ── */}
      <div className="mt-8 space-y-4">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><ListChecks className="size-5" /> {t('disb.runs_title')}</h2>
        <p className="text-sm text-muted-foreground">{t('disb.runs_subtitle')}</p>

        <Card>
          <CardHeader><CardTitle className="text-base">{t('disb.run_propose_title')}</CardTitle></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="grid gap-2">
              <Label htmlFor="run-cutoff">{t('disb.run_cutoff')}</Label>
              <Input id="run-cutoff" type="date" value={cutoff} onChange={(e) => setCutoff(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="run-paydate">{t('disb.run_pay_date')}</Label>
              <Input id="run-paydate" type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="run-bank">{t('disb.run_bank')}</Label>
              <select id="run-bank" className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                value={bankId} onChange={(e) => setBankId(e.target.value)}>
                <option value="">—</option>
                {(banks.data?.accounts ?? []).filter((b: any) => b.status === 'Approved').map((b: any) => (
                  <option key={b.id} value={b.id}>{b.bank_name} {b.account_no}</option>
                ))}
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="run-wht">{t('disb.run_wht_code')}</Label>
              <Input id="run-wht" value={whtCode} onChange={(e) => setWhtCode(e.target.value)} placeholder={t('disb.run_wht_ph')} />
            </div>
            <div className="flex items-end">
              <Button disabled={!cutoff || !bankId || propose.isPending} onClick={() => propose.mutate()}>{t('disb.run_propose')}</Button>
            </div>
          </CardContent>
        </Card>

        <StateView q={runs}>
          {runs.data ? (
            <DataTable
              rows={runs.data.runs}
              rowKey={(r: any) => r.run_no}
              emptyState={{ icon: ListChecks, title: t('disb.runs_empty_title'), description: t('disb.runs_empty_desc') }}
              columns={[
                { key: 'run_no', label: t('disb.run_col_no'), render: (r: any) => <button className="underline-offset-2 hover:underline" onClick={() => setOpenRun(openRun === r.run_no ? null : r.run_no)}>{r.run_no}</button> },
                { key: 'status', label: t('disb.run_col_status'), render: (r: any) => statusBadge(r.status) },
                { key: 'due_cutoff', label: t('disb.run_col_cutoff') },
                { key: 'line_count', label: t('disb.run_col_lines'), align: 'right' },
                { key: 'total_net', label: t('disb.run_col_net'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.total_net)}</span> },
                { key: 'created_by', label: t('disb.run_col_proposed_by') },
                { key: 'act', label: '', sortable: false, render: (r: any) => {
                  const busy = runAct.isPending && (runAct.variables as any)?.no === r.run_no;
                  return (
                    <div className="flex flex-wrap gap-1">
                      {r.status === 'Draft' && <Button size="sm" disabled={busy} onClick={() => runAct.mutate({ no: r.run_no, act: 'submit' })}>{t('disb.run_submit')}</Button>}
                      {(r.status === 'Draft' || r.status === 'PendingApproval') && <Button size="sm" variant="outline" disabled={busy} onClick={() => runAct.mutate({ no: r.run_no, act: 'cancel' })}>{t('disb.run_cancel')}</Button>}
                      {r.status === 'PendingApproval' && <Button size="sm" disabled={busy} onClick={() => runAct.mutate({ no: r.run_no, act: 'approve' })}>{t('disb.run_approve')}</Button>}
                      {r.status === 'PendingApproval' && <Button size="sm" variant="outline" disabled={busy} onClick={() => runAct.mutate({ no: r.run_no, act: 'reject' })}>{t('disb.reject')}</Button>}
                      {r.status === 'Approved' && <Button size="sm" disabled={busy} onClick={() => runAct.mutate({ no: r.run_no, act: 'execute' })}>{t('disb.run_execute')}</Button>}
                    </div>
                  );
                } },
              ]}
            />
          ) : (
            <Card><CardContent className="py-6 text-center text-sm text-muted-foreground">{t('disb.no_perm')}</CardContent></Card>
          )}
        </StateView>

        {openRun && d ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                {d.run_no} {statusBadge(d.status)}
                <span className="text-sm font-normal text-muted-foreground">
                  {t('disb.run_totals', { amount: baht(d.total_amount), wht: baht(d.total_wht), net: baht(d.total_net) })}
                </span>
                {d.status === 'Executed' && (
                  <span className="text-sm font-normal text-muted-foreground">· {t('disb.run_cleared', { n: d.cleared_count, of: d.paid_count })}</span>
                )}
              </CardTitle>
              {(d.status === 'Approved' || d.status === 'Executed') && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <select className="h-8 rounded-md border border-input bg-transparent px-2 text-sm" value={fileFmt} onChange={(e) => setFileFmt(e.target.value)}>
                    <option value="generic">{t('disb.run_fmt_generic')}</option>
                    <option value="scb">SCB</option>
                    <option value="kbank">KBank</option>
                    <option value="bbl">BBL</option>
                    <option value="iso20022">ISO 20022 (pain.001)</option>
                  </select>
                  <Button size="sm" variant="outline" onClick={() => apiDownload(`/api/finance/ap/payment-runs/${d.run_no}/bank-file?format=${fileFmt}`, `${d.run_no}-${fileFmt}.${fileFmt === 'iso20022' ? 'xml' : 'csv'}`).then(() => { notifySuccess(t('disb.run_file_ok')); refreshRuns(); }).catch((e: any) => notifyError(e.message))}>
                    <Download className="size-4" /> {t('disb.run_file')}
                  </Button>
                  {d.file_hash && <span className="break-all text-xs text-muted-foreground">SHA-256: {d.file_hash}</span>}
                </div>
              )}
            </CardHeader>
            <CardContent>
              <DataTable
                rows={d.lines}
                rowKey={(l: any) => String(l.line_id)}
                columns={[
                  { key: 'txn_no', label: t('disb.col_ap_bill') },
                  { key: 'vendor_name', label: t('fin.col_creditor') },
                  { key: 'due_date', label: t('disb.run_col_due') },
                  { key: 'amount', label: t('fin.col_amount2'), align: 'right', render: (l: any) => <span className="tabular">{baht(l.amount)}</span> },
                  { key: 'wht_amount', label: t('disb.run_col_wht'), align: 'right', render: (l: any) => <span className="tabular">{baht(l.wht_amount)}</span> },
                  { key: 'net_amount', label: t('disb.run_col_net_line'), align: 'right', render: (l: any) => <span className="tabular">{baht(l.net_amount)}</span> },
                  { key: 'status', label: t('disb.run_col_status'), render: (l: any) => (
                    <span className="flex items-center gap-1">
                      {statusBadge(l.status)}
                      {l.cleared ? <Badge variant="secondary">{t('disb.run_line_cleared')}</Badge> : null}
                      {l.fail_reason ? <span className="text-xs text-destructive">{l.fail_reason}</span> : null}
                    </span>
                  ) },
                  { key: 'payment_no', label: t('disb.col_request_no') },
                  ...(d.status === 'Draft' ? [{ key: 'rm', label: '', sortable: false, render: (l: any) => (
                    <Button size="sm" variant="outline" disabled={removeLine.isPending} onClick={() => removeLine.mutate({ no: d.run_no, lineId: l.line_id })}>{t('disb.run_line_remove')}</Button>
                  ) }] : []),
                ]}
              />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
