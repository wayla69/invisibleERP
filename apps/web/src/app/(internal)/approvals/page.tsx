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
      )}
    </ModulePage>
  );
}
