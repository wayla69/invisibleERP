'use client';

// LYL-17 — receipt-upload-for-points review queue. Members submit a photo of a purchase made outside our
// POS via the self-service app; staff (crm_points_adjust) approve/reject here. Approval grants points
// through the same earnInTx path POS checkout uses.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ReceiptText } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useBatchActions, BatchBar, batchColumn } from '@/components/batch-actions';

export default function ReceiptApprovalsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['loy-receipt-queue'], queryFn: () => api('/api/loyalty/receipts?status=Pending') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['loy-receipt-queue'] });

  const approve = useMutation({
    mutationFn: (id: number) => api<any>(`/api/loyalty/receipts/${id}/approve`, { method: 'POST' }),
    onSuccess: (r: any) => { notifySuccess(t('ly.ra_approved', { points: num(r.points_granted) })); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const reject = useMutation({
    mutationFn: (id: number) => api<any>(`/api/loyalty/receipts/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason: window.prompt(t('ly.ra_reject_prompt')) || undefined }) }),
    onSuccess: () => { notifySuccess(t('ly.ra_rejected')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const pending: any[] = q.data?.submissions ?? [];

  // Batch approve/reject — loops the same per-receipt endpoints; grant/deny stays server-side per item.
  const batch = useBatchActions<any>({
    items: pending,
    keyOf: (r) => String(r.id),
    run: (r, action, reason) =>
      action === 'approve'
        ? api(`/api/loyalty/receipts/${r.id}/approve`, { method: 'POST' })
        : api(`/api/loyalty/receipts/${r.id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
    onDone: refresh,
  });

  return (
    <div>
      <PageHeader title={t('ly.ra_title')} description={t('ly.ra_desc')} />
      <div className="space-y-4">
        <StatCard label={t('ly.ra_pending_count')} value={num(pending.length)} icon={ReceiptText} tone={pending.length ? 'warning' : 'success'} className="max-w-xs" />
        <Card className="gap-3 p-5">
          <p className="text-xs text-muted-foreground">{t('ly.ra_sod_note')}</p>
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
              {/* Phone/narrow: one card per submission instead of an 8-column table (with an image column)
                  a phone can only scroll sideways. Batch checkbox + inline approve/reject as thumb targets. */}
              <div className="space-y-3 sm:hidden">
                {pending.length === 0 ? (
                  <div className="rounded-xl border bg-card p-8 text-center">
                    <ReceiptText className="mx-auto size-8 text-muted-foreground opacity-40" />
                    <p className="mt-2 text-sm font-medium">{t('ly.ra_empty')}</p>
                  </div>
                ) : (
                  pending.map((r: any) => (
                    <div key={r.id} className="rounded-lg border bg-card p-3 text-sm">
                      <div className="flex items-start gap-3">
                        <input type="checkbox" className="mt-1 size-4 shrink-0" aria-label={`select ${r.id}`} checked={batch.isSel(r)} onChange={() => batch.toggle(r)} />
                        <img src={r.receipt_image} alt={t('ly.ra_receipt_alt')} className="h-20 w-16 shrink-0 rounded border object-cover" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="font-medium">#{r.member_id}</p>
                              <p className="text-xs text-muted-foreground">{r.store_name ?? '—'}</p>
                            </div>
                            <p className="tabular shrink-0 font-semibold">{baht(r.purchase_amount)}</p>
                          </div>
                          <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                            <span>{r.purchase_date ? thaiDate(r.purchase_date) : '—'}</span>
                            <span>· {t('ly.ra_col_points_est')} {num(r.claimed_points_preview)}</span>
                          </div>
                        </div>
                      </div>
                      <div className="mt-2 flex gap-2 border-t pt-2">
                        <Button size="sm" variant="outline" className="flex-1" disabled={approve.isPending} onClick={() => approve.mutate(r.id)}>{t('ly.ra_approve')}</Button>
                        <Button size="sm" variant="ghost" className="flex-1" disabled={reject.isPending} onClick={() => reject.mutate(r.id)}>{t('ly.ra_reject')}</Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
              <div className="hidden sm:block">
              <DataTable
                rows={pending}
                emptyState={{ icon: ReceiptText, title: t('ly.ra_empty') }}
                columns={[
                  batchColumn<any>({ isSel: batch.isSel, isEligible: batch.isEligible, toggle: batch.toggle, refOf: (r) => String(r.id) }),
                  { key: 'receipt_image', label: t('ly.ra_col_image'), render: (r: any) => <img src={r.receipt_image} alt={t('ly.ra_receipt_alt')} className="h-24 w-auto rounded border object-contain" /> },
                  { key: 'member_id', label: t('ly.col_member'), render: (r: any) => `#${r.member_id}` },
                  { key: 'store_name', label: t('ly.col_store'), render: (r: any) => r.store_name ?? '—' },
                  { key: 'purchase_date', label: t('ly.col_purchase_date'), render: (r: any) => (r.purchase_date ? thaiDate(r.purchase_date) : '—') },
                  { key: 'purchase_amount', label: t('ly.col_spend'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.purchase_amount)}</span> },
                  { key: 'claimed_points_preview', label: t('ly.ra_col_points_est'), align: 'right', render: (r: any) => <span className="tabular">{num(r.claimed_points_preview)}</span> },
                  { key: 'submitted_at', label: t('ly.ra_col_submitted'), render: (r: any) => thaiDate(r.submitted_at) },
                  { key: 'act', label: '', align: 'right', render: (r: any) => (
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" variant="outline" disabled={approve.isPending} onClick={() => approve.mutate(r.id)}>{t('ly.ra_approve')}</Button>
                      <Button size="sm" variant="ghost" disabled={reject.isPending} onClick={() => reject.mutate(r.id)}>{t('ly.ra_reject')}</Button>
                    </div>
                  ) },
                ]}
              />
              </div>
              </>
            )}
          </StateView>
        </Card>
      </div>
    </div>
  );
}
