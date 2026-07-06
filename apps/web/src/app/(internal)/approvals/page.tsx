'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, Clock, AlarmClock, Coins } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useLang } from '@/lib/i18n';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';

// GOV-01 — unified pending-approvals monitor: every item awaiting independent (maker-checker) approval
// across the system, with its age, so the controller can chase stale approvals before close.

interface Item {
  type: string; control: string; ref: string; label: string; amount: number;
  requested_by: string | null; requested_at: string | null; age_days: number | null;
}
interface Resp { items: Item[]; count: number; by_type: Record<string, number>; oldest_age_days: number; overdue_days: number; overdue: number; total_amount: number }

const KNOWN_TYPES = ['journal', 'ap_payment', 'payroll', 'asset_revaluation', 'asset_disposal', 'inventory_writeoff', 'till_variance', 'refund'];

export default function ApprovalsPage() {
  const { t } = useLang();
  const typeLabel = (k: string) => (KNOWN_TYPES.includes(k) ? t(`appr.type_${k}`) : k);
  const qc = useQueryClient();
  const q = useQuery<Resp>({ queryKey: ['pending-approvals'], queryFn: () => api('/api/finance/approvals/pending'), refetchInterval: 30_000 });
  const d = q.data;
  const overdueDays = d?.overdue_days ?? 3;
  const refresh = () => qc.invalidateQueries({ queryKey: ['pending-approvals'] });

  // REV-13: a material till-close cash over/short is the one pending type with no dedicated module
  // screen, so the manager approves/rejects it inline here (SoD is enforced server-side: the approver
  // must differ from the cashier who closed → SOD_VIOLATION).
  // inline approve/reject for the pending types that have no dedicated module screen: a material till
  // variance (REV-13, ref=sessionNo) and a large refund (REV-16, ref=RR-<id>).
  const endpoint = (it: Item, action: 'approve' | 'reject') =>
    it.type === 'refund'
      ? `/api/payments/refund-requests/${it.ref.replace('RR-', '')}/${action}`
      : `/api/payments/till/variance/${it.ref}/${action}`;
  const approve = useMutation({
    mutationFn: (it: Item) => api<any>(endpoint(it, 'approve'), { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('appr.approved_ok')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const reject = useMutation({
    mutationFn: (it: Item) => api<any>(endpoint(it, 'reject'), { method: 'POST', body: JSON.stringify({ reason: window.prompt(t('appr.reject_reason_prompt')) || undefined }) }),
    onSuccess: () => { notifySuccess(t('appr.rejected_ok')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <ModulePage
      title={t('appr.title')}
      description={t('appr.subtitle')}
      query={q}
      stats={
        d && (
          <>
            <StatCard label={t('appr.stat_total')} value={num(d.count)} icon={ClipboardCheck} tone="primary" />
            <StatCard label={t('appr.stat_overdue', { days: overdueDays })} value={num(d.overdue)} icon={AlarmClock} tone={d.overdue > 0 ? 'danger' : 'success'} hint={t('appr.stat_overdue_hint')} />
            <StatCard label={t('appr.stat_oldest')} value={num(d.oldest_age_days)} icon={Clock} tone={d.oldest_age_days >= overdueDays ? 'warning' : 'default'} />
            <StatCard label={t('appr.stat_amount')} value={`฿${num(d.total_amount)}`} icon={Coins} tone="default" />
          </>
        )
      }
      statsClassName="xl:grid-cols-4"
    >
      {d && (
        <>
          {/* Phone/narrow: one card per pending item instead of a 9-column table that a phone can only
              horizontally scroll. A red left edge flags an overdue item so the queue still scans at a
              glance, and the inline approve/reject actions (till variance / refund) sit as full-width
              thumb targets — an approver is the most likely back-office user to act from a phone. */}
          <div className="space-y-3 sm:hidden">
            {d.items.length === 0 ? (
              <div className="rounded-xl border bg-card p-8 text-center">
                <ClipboardCheck className="mx-auto size-8 text-muted-foreground opacity-40" />
                <p className="mt-2 text-sm font-medium">{t('appr.empty_title')}</p>
                <p className="text-sm text-muted-foreground">{t('appr.empty_desc')}</p>
              </div>
            ) : (
              d.items.map((r, i) => {
                const overdue = r.age_days != null && r.age_days >= overdueDays;
                const canAct = r.type === 'till_variance' || r.type === 'refund';
                return (
                  <div key={`${r.control}-${r.ref}-${i}`} className={cn('rounded-lg border border-l-4 bg-card p-3 text-sm', overdue ? 'border-l-destructive' : 'border-l-muted-foreground/30')}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium">{typeLabel(r.type)}</p>
                        <p className="font-mono text-xs text-muted-foreground">{r.ref}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="tabular font-semibold">฿{num(r.amount)}</p>
                        <Badge variant="outline" className="mt-0.5 font-mono text-[10px]">{r.control}</Badge>
                      </div>
                    </div>
                    {r.label && <p className="mt-2 border-t pt-2 text-muted-foreground">{r.label}</p>}
                    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                      <span>{r.requested_by ?? '—'}</span>
                      {r.requested_at && <span>· {thaiDate(r.requested_at)}</span>}
                      {r.age_days != null && (
                        <span className={cn('font-medium', overdue && 'text-destructive')}>
                          · {t('appr.col_age')} {num(r.age_days)}{overdue ? ' ⚠' : ''}
                        </span>
                      )}
                    </div>
                    {canAct && (
                      <div className="mt-2 flex gap-2 border-t pt-2">
                        <Button size="sm" variant="outline" className="flex-1" disabled={approve.isPending || reject.isPending} onClick={() => approve.mutate(r)}>{t('fin.approve')}</Button>
                        <Button size="sm" variant="ghost" className="flex-1" disabled={approve.isPending || reject.isPending} onClick={() => reject.mutate(r)}>{t('appr.reject')}</Button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Desktop/tablet: the full register table (unchanged). */}
          <div className="hidden sm:block">
            <DataTable
              rows={d.items}
              rowKey={(r, i) => `${r.control}-${r.ref}-${i}`}
              emptyState={{ icon: ClipboardCheck, title: t('appr.empty_title'), description: t('appr.empty_desc') }}
              columns={[
                { key: 'control', label: t('appr.col_control'), render: (r) => <Badge variant="outline" className="font-mono">{r.control}</Badge> },
                { key: 'type', label: t('appr.col_type'), render: (r) => typeLabel(r.type) },
                { key: 'ref', label: t('appr.col_ref'), render: (r) => <span className="font-mono text-sm">{r.ref}</span> },
                { key: 'label', label: t('fin.col_detail'), render: (r) => <span className="text-muted-foreground">{r.label}</span> },
                { key: 'amount', label: t('appr.col_value'), align: 'right', render: (r) => <span className="tabular">฿{num(r.amount)}</span> },
                { key: 'requested_by', label: t('fin.col_requester'), render: (r) => r.requested_by ?? '—' },
                { key: 'age_days', label: t('appr.col_age'), align: 'right', render: (r) => r.age_days == null ? '—' : <span className={cn('tabular font-medium', r.age_days >= overdueDays ? 'text-destructive' : 'text-muted-foreground')}>{num(r.age_days)}{r.age_days >= overdueDays ? ' ⚠' : ''}</span> },
                { key: 'requested_at', label: t('appr.col_requested_at'), render: (r) => (r.requested_at ? thaiDate(r.requested_at) : '—') },
                { key: 'actions', label: '', align: 'right', render: (r) => (r.type === 'till_variance' || r.type === 'refund') ? (
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" disabled={approve.isPending || reject.isPending} onClick={() => approve.mutate(r)}>{t('fin.approve')}</Button>
                    <Button size="sm" variant="ghost" disabled={approve.isPending || reject.isPending} onClick={() => reject.mutate(r)}>{t('appr.reject')}</Button>
                  </div>
                ) : null },
              ]}
            />
          </div>
        </>
      )}

      {/* Detective exception reports (maker-checker audit G14/G16): single-user-by-design actions
          surfaced here for independent periodic review. */}
      <div className="grid gap-6 lg:grid-cols-2">
        <VoidRefundReport />
        <VoidedTaxInvoiceReport />
      </div>
    </ModulePage>
  );
}

// G14 (audit — detective): every POS void + refund in the window, for independent review.
function VoidRefundReport() {
  const { t } = useLang();
  const q = useQuery<{ voids: { payment_no: string; amount: number; by: string | null; at: string }[]; refunds: { refund_no: string; amount: number; reason: string | null; by: string | null; at: string }[]; void_count: number; refund_count: number; void_total: number; refund_total: number }>({
    queryKey: ['exc-voids-refunds'], queryFn: () => api('/api/payments/exceptions/voids-refunds'),
  });
  const d = q.data;
  const rows = [
    ...(d?.voids ?? []).map((v) => ({ kind: t('appr.exc_void'), ref: v.payment_no, amount: v.amount, detail: '—', by: v.by, at: v.at })),
    ...(d?.refunds ?? []).map((r) => ({ kind: t('appr.exc_refund'), ref: r.refund_no, amount: r.amount, detail: r.reason ?? '—', by: r.by, at: r.at })),
  ];
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">{t('appr.exc_vr_title')}</CardTitle></CardHeader>
      <CardContent>
        <p className="mb-3 text-xs text-muted-foreground">{t('appr.exc_vr_desc')}{d ? ` · ${t('appr.exc_vr_summary', { voids: d.void_count, refunds: d.refund_count })}` : ''}</p>
        <DataTable
          rows={rows}
          rowKey={(r, i) => `${r.ref}-${i}`}
          columns={[
            { key: 'kind', label: t('appr.exc_col_kind'), render: (r: any) => <Badge variant="outline">{r.kind}</Badge> },
            { key: 'ref', label: t('appr.col_ref'), render: (r: any) => <span className="font-mono text-xs">{r.ref}</span> },
            { key: 'amount', label: t('appr.col_value'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
            { key: 'by', label: t('fin.col_requester'), render: (r: any) => r.by ?? '—' },
            { key: 'at', label: t('appr.col_requested_at'), render: (r: any) => (r.at ? thaiDate(r.at) : '—') },
          ]}
          emptyState={{ title: t('appr.exc_none') }}
          dense
        />
      </CardContent>
    </Card>
  );
}

// G16 (audit — detective): every voided tax invoice in the window, for independent review.
function VoidedTaxInvoiceReport() {
  const { t } = useLang();
  const q = useQuery<{ voided: { doc_no: string; type: string; issue_date: string; grand_total: number; void_reason: string | null; created_by: string | null }[]; count: number; total: number }>({
    queryKey: ['exc-voided-tax'], queryFn: () => api('/api/tax-invoices/exceptions/voided'),
  });
  const rows = q.data?.voided ?? [];
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">{t('appr.exc_tax_title')}</CardTitle></CardHeader>
      <CardContent>
        <p className="mb-3 text-xs text-muted-foreground">{t('appr.exc_tax_desc')}{q.data ? ` · ${t('appr.exc_tax_summary', { n: q.data.count })}` : ''}</p>
        <DataTable
          rows={rows}
          rowKey={(r: any) => r.doc_no}
          columns={[
            { key: 'doc_no', label: t('appr.col_ref'), render: (r: any) => <span className="font-mono text-xs">{r.doc_no}</span> },
            { key: 'grand_total', label: t('appr.col_value'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.grand_total)}</span> },
            { key: 'void_reason', label: t('appr.exc_col_reason'), render: (r: any) => <span className="text-muted-foreground">{r.void_reason ?? '—'}</span> },
            { key: 'created_by', label: t('fin.col_requester'), render: (r: any) => r.created_by ?? '—' },
            { key: 'issue_date', label: t('appr.exc_col_issue_date'), render: (r: any) => (r.issue_date ? thaiDate(r.issue_date) : '—') },
          ]}
          emptyState={{ title: t('appr.exc_none') }}
          dense
        />
      </CardContent>
    </Card>
  );
}
