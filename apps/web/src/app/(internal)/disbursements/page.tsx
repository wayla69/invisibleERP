'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

// Treasury / finance disbursement surface (perm: approvals | gl_close). The CHECKER side of the AP
// maker-checker: accounting (creditors) books the bill and requests payment on /finance; finance
// approves & releases the cash here. Approver ≠ requester is enforced server-side (EXP-06 / SoD R07).
export default function DisbursementsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const pending = useQuery<any>({ queryKey: ['ap-disbursements'], queryFn: () => api('/api/finance/ap/payments/pending'), retry: false });
  const refresh = () => qc.invalidateQueries({ queryKey: ['ap-disbursements'] });

  // EXP-13 — payment runs awaiting approval (grouped). Approving a run releases every bill in it in one action.
  const runs = useQuery<any>({ queryKey: ['ap-payment-runs'], queryFn: () => api('/api/finance/ap/payment-runs/pending'), retry: false });
  const refreshAll = () => { refresh(); qc.invalidateQueries({ queryKey: ['ap-payment-runs'] }); };

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
  const approveRun = useMutation({
    mutationFn: (no: string) => api(`/api/finance/ap/payment-runs/${no}/approve`, { method: 'POST' }),
    onSuccess: (r: any) => { notifySuccess(t('disb.run_approved', { no: r.run_no, count: r.approved_count })); refreshAll(); },
    onError: (e: any) => notifyError(e.message),
  });
  const rejectRun = useMutation({
    mutationFn: (no: string) => api(`/api/finance/ap/payment-runs/${no}/reject`, { method: 'POST', body: JSON.stringify({ reason: 'rejected by approver' }) }),
    onSuccess: (r: any) => { notifySuccess(t('disb.run_rejected', { no: r.run_no })); refreshAll(); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div>
      <PageHeader title={t('disb.title')} description={t('disb.subtitle')} />

      {/* EXP-13 — combined payment runs (grouped approval), shown above the per-bill queue. */}
      {(runs.data?.runs?.length ?? 0) > 0 && (
        <Card className="mb-6">
          <CardContent className="pt-5">
            <div className="mb-3">
              <h2 className="text-sm font-semibold">{t('disb.runs_heading')}</h2>
              <p className="text-xs text-muted-foreground">{t('disb.runs_sub')}</p>
            </div>
            <DataTable
              rows={runs.data.runs}
              rowKey={(r: any) => r.run_no}
              columns={[
                { key: 'run_no', label: t('disb.col_run_no') },
                { key: 'line_count', label: t('disb.col_lines'), align: 'right' },
                { key: 'requested_by', label: t('disb.col_requested_by') },
                { key: 'total_amount', label: t('disb.col_total'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.total_amount)}</span> },
                { key: 'act', label: '', sortable: false, render: (r: any) => {
                  const busy = (approveRun.isPending && approveRun.variables === r.run_no) || (rejectRun.isPending && rejectRun.variables === r.run_no);
                  return (
                    <div className="flex gap-1">
                      <Button size="sm" disabled={busy} onClick={() => approveRun.mutate(r.run_no)}>{t('disb.approve_run')}</Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => rejectRun.mutate(r.run_no)}>{t('disb.reject')}</Button>
                    </div>
                  );
                } },
              ]}
            />
          </CardContent>
        </Card>
      )}

      <StateView q={pending}>
        {pending.data ? (
          <DataTable
            rows={pending.data.payments}
            rowKey={(r: any) => r.payment_no}
            emptyState={{ icon: CheckCheck, title: t('disb.empty_title'), description: t('disb.empty_desc') }}
            columns={[
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
        ) : (
          <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">{t('disb.no_perm')}</CardContent></Card>
        )}
      </StateView>
    </div>
  );
}
