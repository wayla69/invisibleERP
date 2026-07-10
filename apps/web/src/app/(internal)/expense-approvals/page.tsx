'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, X, Receipt, CircleDollarSign } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { baht, num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useBatchActions, BatchBar, batchColumn } from '@/components/batch-actions';

// ── API contract (apps/api/src/modules/ess) ───────────────────────────────────
interface PendingClaim {
  id: number; claim_date: string | null; category: string | null; amount: number;
  description: string | null; status: string; emp_code: string | null; employee_name: string | null;
}

export default function ExpenseApprovalsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ pending: PendingClaim[]; count: number }>({
    queryKey: ['ess-pending-expenses'],
    queryFn: () => api('/api/ess/expenses/pending'),
  });

  const decide = useMutation({
    mutationFn: (v: { id: number; approve: boolean }) =>
      api<{ id: number; status: string; ap_txn_no?: string | null }>(`/api/ess/expenses/${v.id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ approve: v.approve }),
      }),
    onSuccess: (r) => {
      notifySuccess(
        r.status === 'Approved' ? t('hx.exp.approved_toast') : t('hx.exp.rejected_toast'),
        r.ap_txn_no ? t('hx.exp.ap_detail', { no: r.ap_txn_no }) : undefined,
      );
      qc.invalidateQueries({ queryKey: ['ess-pending-expenses'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const rows = q.data?.pending ?? [];
  const total = rows.reduce((s, r) => s + (r.amount || 0), 0);

  // Batch approve/reject — loops the same per-claim /decide endpoint; SoD enforced per item server-side.
  const batch = useBatchActions<PendingClaim>({
    items: rows,
    keyOf: (r) => String(r.id),
    run: (r, action) => api(`/api/ess/expenses/${r.id}/decide`, { method: 'POST', body: JSON.stringify({ approve: action === 'approve' }) }),
    onDone: () => qc.invalidateQueries({ queryKey: ['ess-pending-expenses'] }),
  });

  return (
    <div>
      <PageHeader
        title={t('hx.exp.title')}
        description={t('hx.exp.desc')}
      />

      <div className="space-y-5">
        <StateView q={q}>
          {q.data && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <StatCard label={t('hx.exp.stat_pending')} value={num(rows.length)} icon={Receipt} tone="primary" />
              <StatCard label={t('hx.exp.stat_total')} value={baht(total)} icon={CircleDollarSign} tone="warning" />
            </div>
          )}
        </StateView>

        <StateView q={q}>
          {q.data && (
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
            {/* Phone/narrow: one card per pending claim instead of a 9-column table a phone can only
                scroll sideways. Batch checkbox + inline approve/reject as full-width thumb targets. */}
            <div className="space-y-3 sm:hidden">
              {rows.length === 0 ? (
                <div className="rounded-xl border bg-card p-8 text-center">
                  <Receipt className="mx-auto size-8 text-muted-foreground opacity-40" />
                  <p className="mt-2 text-sm font-medium">{t('hx.exp.empty_title')}</p>
                  <p className="text-sm text-muted-foreground">{t('hx.exp.empty_desc')}</p>
                </div>
              ) : (
                rows.map((r) => (
                  <div key={r.id} className="rounded-lg border bg-card p-3 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-start gap-2">
                        <input type="checkbox" className="mt-1 size-4 shrink-0" aria-label={`select ${r.id}`} checked={batch.isSel(r)} onChange={() => batch.toggle(r)} />
                        <div className="min-w-0">
                          <p className="font-medium">{r.employee_name ?? r.emp_code ?? '—'}</p>
                          <p className="text-xs text-muted-foreground">{r.emp_code ?? '—'} · {thaiDate(r.claim_date)}</p>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="tabular font-semibold">{baht(r.amount)}</p>
                        <Badge variant="warning" className="mt-0.5 text-[10px]">{r.status}</Badge>
                      </div>
                    </div>
                    <p className="mt-2 border-t pt-2 text-muted-foreground">
                      {r.category ? <span className="mr-1 font-medium text-foreground">{r.category}</span> : null}
                      {r.description ?? '—'}
                    </p>
                    <div className="mt-2 flex gap-2 border-t pt-2">
                      <Button size="sm" className="flex-1" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, approve: true })}>
                        <Check className="size-3.5" /> {t('fin.approve')}
                      </Button>
                      <Button size="sm" variant="outline" className="flex-1" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, approve: false })}>
                        <X className="size-3.5" /> {t('fin.rejected')}
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="hidden sm:block">
            <DataTable
              rows={rows}
              rowKey={(r) => r.id}
              emptyState={{ icon: Receipt, title: t('hx.exp.empty_title'), description: t('hx.exp.empty_desc') }}
              columns={[
                batchColumn<PendingClaim>({ isSel: batch.isSel, isEligible: batch.isEligible, toggle: batch.toggle, refOf: (r) => String(r.id) }),
                { key: 'employee_name', label: t('hx.exp.col_employee'), render: (r) => <span className="font-medium">{r.employee_name ?? r.emp_code ?? '—'}</span> },
                { key: 'emp_code', label: t('hx.exp.col_code'), render: (r) => r.emp_code ?? '—' },
                { key: 'claim_date', label: t('dash.col_date'), render: (r) => thaiDate(r.claim_date) },
                { key: 'category', label: t('hx.exp.col_category'), render: (r) => r.category ?? '—' },
                { key: 'description', label: t('hx.exp.col_desc'), render: (r) => r.description ?? '—' },
                { key: 'amount', label: t('hx.exp.col_amount'), align: 'right', render: (r) => <span className="tabular">{baht(r.amount)}</span> },
                { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant="warning">{r.status}</Badge> },
                {
                  key: '_act',
                  label: t('hx.common.actions'),
                  sortable: false,
                  render: (r) => (
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        disabled={decide.isPending}
                        onClick={() => decide.mutate({ id: r.id, approve: true })}
                      >
                        <Check className="size-3.5" /> {t('fin.approve')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={decide.isPending}
                        onClick={() => decide.mutate({ id: r.id, approve: false })}
                      >
                        <X className="size-3.5" /> {t('fin.rejected')}
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
            </div>
            </>
          )}
        </StateView>
      </div>
    </div>
  );
}
