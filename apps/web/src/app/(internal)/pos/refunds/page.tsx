'use client';

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Banknote, CheckCircle2, Clock, ShieldCheck, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable, type Column } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useLang } from '@/lib/i18n';

// POS Supervisor refund-authorization queue (SoD R08/R12: sell ≠ refund).
// pos_refund permission only — a Cashier (pos_sell) cannot access this screen.

interface RefundRequest {
  id: number; request_no: string; payment_no: string; sale_no: string; amount: number;
  reason: string | null; status: 'Pending' | 'Approved' | 'Rejected';
  requested_by: string; requested_at: string; approved_by: string | null; approved_at: string | null;
  reject_reason: string | null;
}
interface ListResp { requests: RefundRequest[]; count: number }

type Filter = 'Pending' | 'Approved' | 'Rejected' | '';

export default function PosRefundsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>('Pending');
  const [rejectId, setRejectId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const q = useQuery<ListResp>({
    queryKey: ['refund-requests', filter],
    queryFn: () => api(`/api/payments/refund-requests${filter ? `?status=${filter}` : ''}`),
  });
  const d = q.data;

  const approve = useMutation({
    mutationFn: (id: number) => api(`/api/payments/refund-requests/${id}/approve`, { method: 'POST', body: '{}' }),
    onSuccess: () => { notifySuccess(t('px.refund_approve_success')); qc.invalidateQueries({ queryKey: ['refund-requests'] }); },
    onError: (e: any) => notifyError(e?.message ?? t('px.refund_approve_failed')),
  });

  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      api(`/api/payments/refund-requests/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
    onSuccess: () => { notifySuccess(t('px.refund_reject_success')); setRejectId(null); setRejectReason(''); qc.invalidateQueries({ queryKey: ['refund-requests'] }); },
    onError: (e: any) => notifyError(e?.message ?? t('px.refund_reject_failed')),
  });

  const pending = d?.requests.filter((r) => r.status === 'Pending').length ?? 0;
  const approved = d?.requests.filter((r) => r.status === 'Approved').length ?? 0;
  const totalAmount = d?.requests.filter((r) => r.status === 'Pending').reduce((s, r) => s + r.amount, 0) ?? 0;

  const statusBadge = (s: string) =>
    s === 'Approved' ? <Badge variant="secondary" className="bg-green-100 text-green-800">{t('fin.approve')}</Badge>
    : s === 'Rejected' ? <Badge variant="destructive">{t('px.refund_reject')}</Badge>
    : <Badge variant="outline" className="text-yellow-700 border-yellow-400">{t('px.refund_pending')}</Badge>;

  const columns: Column<RefundRequest>[] = [
    { key: 'request_no', label: t('px.refund_col_request_no'), render: (r) => <span className="font-medium">{r.request_no}</span> },
    { key: 'sale_no', label: t('px.refund_col_sale_no') },
    { key: 'payment_no', label: t('px.refund_col_payment_no') },
    { key: 'amount', label: t('px.refund_col_amount'), align: 'right', render: (r) => <span className="tabular font-medium">฿{num(r.amount)}</span> },
    { key: 'reason', label: t('px.refund_col_reason'), render: (r) => r.reason ?? '—' },
    { key: 'requested_by', label: t('px.refund_col_requested_by') },
    { key: 'requested_at', label: t('px.refund_col_requested_at'), render: (r) => thaiDate(r.requested_at.split('T')[0]) },
    { key: 'status', label: t('fin.col_status'), render: (r) => statusBadge(r.status) },
    {
      key: 'id', label: t('px.refund_col_actions'),
      render: (r) => r.status === 'Pending' ? (
        <div className="flex gap-1.5">
          <Button size="sm" variant="secondary" className="h-7 gap-1 text-green-700 hover:bg-green-50"
            disabled={approve.isPending} onClick={() => approve.mutate(r.id)}>
            <CheckCircle2 className="size-3.5" />{t('fin.approve')}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 gap-1 text-destructive hover:bg-destructive/10"
            onClick={() => { setRejectId(r.id); setRejectReason(''); }}>
            <XCircle className="size-3.5" />{t('px.refund_reject')}
          </Button>
        </div>
      ) : (
        <span className="text-sm text-muted-foreground">{r.approved_by ?? '—'}</span>
      ),
    },
  ];

  const selectCls = 'h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring';

  return (
    <ModulePage
      title={t('px.refund_title')}
      description={t('px.refund_desc')}
      query={q}
      toolbar={
        <select className={selectCls} value={filter} onChange={(e) => setFilter(e.target.value as Filter)}
          aria-label={t('px.refund_filter_status_aria')}>
          <option value="Pending">{t('px.refund_pending')}</option>
          <option value="Approved">{t('px.refund_approved_filter')}</option>
          <option value="Rejected">{t('px.refund_reject')}</option>
          <option value="">{t('px.refund_all')}</option>
        </select>
      }
      stats={
        <>
          <StatCard label={t('px.refund_pending')} value={num(pending)} icon={Clock} tone={pending > 0 ? 'warning' : 'default'} />
          <StatCard label={t('px.refund_stat_total_pending')} value={`฿${num(totalAmount)}`} icon={Banknote} hint={t('px.refund_stat_total_pending_hint')} />
          <StatCard label={t('px.refund_stat_approved_today')} value={num(approved)} icon={ShieldCheck} tone="success" />
        </>
      }
      statsClassName="xl:grid-cols-3"
    >
      <DataTable
        rows={d?.requests ?? []}
        rowKey={(r) => r.request_no}
        emptyState={{
          icon: CheckCircle2,
          title: filter === 'Pending' ? t('px.refund_empty_title_pending') : t('px.refund_empty_title_other'),
          description: filter === 'Pending' ? t('px.refund_empty_desc_pending') : t('px.refund_empty_desc_other'),
        }}
        columns={columns}
      />

      {rejectId !== null && (
        <Dialog open onOpenChange={() => { setRejectId(null); setRejectReason(''); }}>
          <DialogContent>
            <DialogHeader><DialogTitle>{t('px.refund_reject_dialog_title')}</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <Label htmlFor="reject-reason">{t('px.refund_reason_optional_label')}</Label>
              <textarea id="reject-reason" className="min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
                value={rejectReason} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setRejectReason(e.target.value)}
                placeholder={t('px.refund_reject_reason_placeholder')} rows={3} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setRejectId(null); setRejectReason(''); }}>{t('fin.cancel')}</Button>
              <Button variant="destructive" disabled={reject.isPending}
                onClick={() => reject.mutate({ id: rejectId!, reason: rejectReason })}>
                {t('px.refund_confirm_reject')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </ModulePage>
  );
}
