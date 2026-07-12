'use client';

import { useState } from 'react';
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

const KNOWN_TYPES = ['journal', 'ap_payment', 'payroll', 'asset_revaluation', 'asset_disposal', 'inventory_writeoff', 'till_variance', 'refund', 'posting_rule', 'coa_change', 'masterdata_import', 'masterdata_change'];

export default function ApprovalsPage() {
  const { t } = useLang();
  const typeLabel = (k: string) => (KNOWN_TYPES.includes(k) ? t(`appr.type_${k}`) : k);
  const qc = useQueryClient();
  const q = useQuery<Resp>({ queryKey: ['pending-approvals'], queryFn: () => api('/api/finance/approvals/pending'), refetchInterval: 30_000 });
  const d = q.data;
  const overdueDays = d?.overdue_days ?? 3;
  const refresh = () => qc.invalidateQueries({ queryKey: ['pending-approvals'] });

  // Each pending type's single-item approve/reject REST endpoint. Batching is a pure UX convenience:
  // every call still hits the item's OWN maker-checker route, so its control + SoD (approver ≠ requester)
  // are enforced server-side exactly as a one-by-one approval — this screen adds no new authority.
  // fx_rate + budget approve by a composite body key (not a single path segment) → not batch-selectable
  // here; they are cleared on their own module screens.
  const BATCHABLE: Record<string, (ref: string, a: 'approve' | 'reject') => string> = {
    journal:             (r, a) => `/api/ledger/journal/${encodeURIComponent(r)}/${a}`,
    bank_adjustment:     (r, a) => `/api/ledger/journal/${encodeURIComponent(r)}/${a}`,
    ap_payment:          (r, a) => `/api/finance/ap/payments/${encodeURIComponent(r)}/${a}`,
    payroll:             (r, a) => `/api/payroll/runs/${encodeURIComponent(r)}/${a}`,
    asset_revaluation:   (r, a) => `/api/assets/${encodeURIComponent(r)}/revalue/${a}`,
    asset_disposal:      (r, a) => `/api/assets/${encodeURIComponent(r)}/dispose/${a}`,
    inventory_writeoff:  (r, a) => `/api/inventory/writeoffs/${r.replace('WO-', '')}/${a}`,
    petty_cash:          (r, a) => `/api/finance/petty-cash/requests/${encodeURIComponent(r)}/${a}`,
    till_variance:       (r, a) => `/api/payments/till/variance/${encodeURIComponent(r)}/${a}`,
    refund:              (r, a) => `/api/payments/refund-requests/${r.replace('RR-', '')}/${a}`,
    ar_cash_application: (r, a) => `/api/finance/ar/cash-application/${encodeURIComponent(r)}/${a}`,
    // COA-D1 governance queues — each still hits its own maker-checker route (GL-24 / GL-27 SoD, the
    // GL-27 platform-Admin gate, and MDM approver perms are all enforced server-side per item).
    posting_rule:        (r, a) => `/api/ledger/posting-rules/${r.replace('PRULE-', '')}/${a}`,
    coa_change:          (r, a) => `/api/ledger/accounts/change-requests/${r.replace('COA-', '')}/${a}`,
    masterdata_import:   (r, a) => `/api/admin/master-data/import-approvals/${encodeURIComponent(r)}/${a}`,
    masterdata_change:   (r, a) => `/api/masterdata/change-requests/${encodeURIComponent(r)}/${a}`,
  };
  const isBatchable = (it: Item) => it.type in BATCHABLE;
  const keyOf = (it: Item) => `${it.type}:${it.ref}`;

  // Selection + batch runner — approve/reject many at once. Each item fires its own endpoint
  // (Promise.allSettled), so a per-item SoD failure (approver = requester) only fails THAT item; the rest
  // still go through. A summary reports how many succeeded and the first error if any.
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const toggle = (it: Item) => setSel((s) => { const n = new Set(s); const k = keyOf(it); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const clearSel = () => setSel(new Set());
  const selectAll = () => setSel(new Set((d?.items ?? []).filter(isBatchable).map(keyOf)));

  async function runBatch(action: 'approve' | 'reject') {
    const chosen = (d?.items ?? []).filter((it) => isBatchable(it) && sel.has(keyOf(it)));
    if (!chosen.length) return;
    let reason: string | undefined;
    if (action === 'reject') {
      const r = window.prompt(t('appr.batch_confirm_reject', { n: String(chosen.length) }));
      if (r === null) return; // cancelled
      reason = r || undefined;
    }
    setRunning(true);
    const results = await Promise.allSettled(chosen.map((it) =>
      api<any>(BATCHABLE[it.type]!(it.ref, action), { method: 'POST', ...(action === 'reject' ? { body: JSON.stringify({ reason }) } : {}) }),
    ));
    setRunning(false);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const fails = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    const failNote = fails.length ? t('appr.batch_fail_note', { fail: String(fails.length), firstError: String(fails[0]!.reason?.message ?? 'error').slice(0, 60) }) : '';
    (fails.length ? notifyError : notifySuccess)(t('appr.batch_done', { ok: String(ok), failNote }));
    clearSel();
    refresh();
  }

  // Per-row single actions (kept for the mobile cards' inline buttons on the always-actionable types).
  const approve = useMutation({
    mutationFn: (it: Item) => api<any>(BATCHABLE[it.type]!(it.ref, 'approve'), { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('appr.approved_ok')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const reject = useMutation({
    mutationFn: (it: Item) => api<any>(BATCHABLE[it.type]!(it.ref, 'reject'), { method: 'POST', body: JSON.stringify({ reason: window.prompt(t('appr.reject_reason_prompt')) || undefined }) }),
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
          {/* Batch action bar — select several items and approve/reject them in one action. Each still
              goes through its own maker-checker endpoint (SoD per item), so this is convenience, not new
              authority. Shown once at least one batchable item is selected. */}
          {(() => {
            const batchCount = d.items.filter(isBatchable).length;
            return batchCount > 0 ? (
              <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-2 text-sm">
                <Button size="sm" variant="ghost" onClick={selectAll}>{t('appr.select_all')} ({batchCount})</Button>
                {sel.size > 0 && (
                  <>
                    <span className="font-medium">{t('appr.selected_n', { n: String(sel.size) })}</span>
                    <Button size="sm" disabled={running} onClick={() => runBatch('approve')}>{t('appr.approve_selected')}</Button>
                    <Button size="sm" variant="outline" disabled={running} onClick={() => runBatch('reject')}>{t('appr.reject_selected')}</Button>
                    <Button size="sm" variant="ghost" disabled={running} onClick={clearSel}>{t('appr.clear_sel')}</Button>
                  </>
                )}
              </div>
            ) : null;
          })()}

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
                      <div className="flex min-w-0 items-start gap-2">
                        {isBatchable(r) && (
                          <input type="checkbox" className="mt-1 size-4 shrink-0" aria-label={`select ${r.ref}`} checked={sel.has(keyOf(r))} onChange={() => toggle(r)} />
                        )}
                        <div className="min-w-0">
                          <p className="font-medium">{typeLabel(r.type)}</p>
                          <p className="font-mono text-xs text-muted-foreground">{r.ref}</p>
                        </div>
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
                { key: 'sel', label: '', sortable: false, render: (r) => isBatchable(r)
                  ? <input type="checkbox" aria-label={`select ${r.ref}`} checked={sel.has(keyOf(r))} onChange={() => toggle(r)} />
                  : <span className="text-xs text-muted-foreground" title={t('appr.not_batchable')}>—</span> },
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
