'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PackagePlus, RefreshCw, AlertTriangle, FileText, PackageSearch, ArrowLeftRight, Truck } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const urgencyVariant = (u: string) =>
  u === 'critical' ? 'destructive' : u === 'warning' ? 'warning' : u === 'ok' ? 'success' : 'secondary';
const statusVariant = (s: string) =>
  s === 'Suggested' ? 'info' : s === 'PR_Created' || s === 'Transfer_Done' ? 'success' : 'muted';

export default function ReplenishmentPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['replenishment'], queryFn: () => api('/api/replenishment/suggestions') });

  const recompute = useMutation({
    mutationFn: () => api<{ count: number }>('/api/replenishment/suggest', { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(t('iv.repl_toast_recomputed', { count: num(r.count) })); qc.invalidateQueries({ queryKey: ['replenishment'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const autoTransfer = useMutation({
    mutationFn: () => api<{ doc_no: string | null; transfers: number }>('/api/replenishment/auto-transfer', { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (r) => { notifySuccess(r.doc_no ? t('iv.repl_toast_transferred', { doc: r.doc_no, count: num(r.transfers) }) : t('iv.repl_toast_no_transfer')); qc.invalidateQueries({ queryKey: ['replenishment'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const autoPr = useMutation({
    mutationFn: () => api<{ pr_no: string | null; lines: number }>('/api/replenishment/auto-pr', { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (r) => { notifySuccess(r.pr_no ? t('iv.repl_toast_pr_created', { pr: r.pr_no, lines: num(r.lines) }) : t('iv.repl_toast_no_buy')); qc.invalidateQueries({ queryKey: ['replenishment'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const par = useQuery<any>({ queryKey: ['par-recommendations'], queryFn: () => api('/api/replenishment/par-recommendations') });
  const applyPar = useMutation({
    mutationFn: (v: { branch_id: number; item_id: string }) => api('/api/replenishment/par-recommendations/apply', { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: (r: any) => { notifySuccess(r?.applied ? t('iv.repl_toast_par_applied', { point: num(r.reorder_point) }) : t('iv.repl_toast_no_rec')); qc.invalidateQueries({ queryKey: ['par-recommendations'] }); qc.invalidateQueries({ queryKey: ['replenishment'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const parRecs: any[] = (par.data?.recommendations ?? []).filter((r: any) => r.under_buffered);

  const suggestions: any[] = q.data?.suggestions ?? [];
  const transfers = suggestions.filter((s) => s.route === 'transfer');
  const purchases = suggestions.filter((s) => s.route !== 'transfer'); // 'buy' or legacy
  const openTransfers = transfers.filter((s) => s.status === 'Suggested');
  const openBuys = purchases.filter((s) => s.status === 'Suggested');
  const critical = suggestions.filter((s) => s.status === 'Suggested' && s.urgency === 'critical').length;
  const transferQty = openTransfers.reduce((a, s) => a + Number(s.transfer_qty || s.suggested_qty || 0), 0);
  const buyQty = openBuys.reduce((a, s) => a + Number(s.buy_qty || s.suggested_qty || 0), 0);

  return (
    <div>
      <PageHeader
        title={t('iv.repl_title')}
        description={t('iv.repl_desc')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled={recompute.isPending} onClick={() => recompute.mutate()}>
              <RefreshCw className="size-4" /> {recompute.isPending ? t('iv.repl_recomputing') : t('iv.repl_recompute')}
            </Button>
            <Button variant="outline" disabled={autoTransfer.isPending || openTransfers.length === 0} onClick={() => autoTransfer.mutate()}>
              <ArrowLeftRight className="size-4" /> {autoTransfer.isPending ? t('iv.repl_transferring') : t('iv.repl_transfer')}
            </Button>
            <Button disabled={autoPr.isPending || openBuys.length === 0} onClick={() => autoPr.mutate()}>
              <FileText className="size-4" /> {autoPr.isPending ? t('iv.repl_creating_pr') : t('iv.repl_create_pr')}
            </Button>
          </div>
        }
      />

      <div className="space-y-5">
        <StateView q={q}>
          {q.data && (
            <div className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard label={t('iv.repl_stat_transfers')} value={num(openTransfers.length)} icon={ArrowLeftRight} tone="primary" />
                <StatCard label={t('iv.repl_stat_purchases')} value={num(openBuys.length)} icon={PackagePlus} tone="info" />
                <StatCard label={t('iv.repl_stat_critical')} value={num(critical)} icon={AlertTriangle} tone={critical > 0 ? 'danger' : 'default'} />
                <StatCard label={t('iv.repl_stat_qty_total')} value={`${num(transferQty)} · ${num(buyQty)}`} icon={Truck} tone="default" />
              </div>

              {/* ── โอนระหว่างสาขา (transfer-first) ── */}
              <section className="space-y-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground"><ArrowLeftRight className="size-4 text-primary" /> {t('iv.repl_sec_transfers')}</h2>
                <DataTable
                  rows={transfers}
                  columns={[
                    { key: 'suggestion_no', label: t('dash.col_no') },
                    { key: 'branch_name', label: t('iv.repl_col_branch_short'), render: (r: any) => r.branch_name ?? `#${r.branch_id ?? '—'}` },
                    { key: 'from_branch_name', label: t('iv.repl_col_from_branch'), render: (r: any) => r.from_branch_name ?? `#${r.from_branch_id ?? '—'}` },
                    { key: 'item_id', label: t('iv.repl_col_item') },
                    { key: 'transfer_qty', label: t('iv.repl_col_transfer_qty'), align: 'right', render: (r: any) => <span className="tabular font-medium">{num(r.transfer_qty || r.suggested_qty)}</span> },
                    { key: 'urgency', label: t('iv.repl_col_urgency'), render: (r: any) => <Badge variant={urgencyVariant(r.urgency)}>{r.urgency}</Badge> },
                    { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                  ]}
                  emptyState={{
                    icon: ArrowLeftRight,
                    title: t('iv.repl_transfers_empty_title'),
                    description: t('iv.repl_transfers_empty_desc'),
                  }}
                />
              </section>

              {/* ── สั่งซื้อจากซัพพลายเออร์ (buy residual) ── */}
              <section className="space-y-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground"><PackagePlus className="size-4 text-primary" /> {t('iv.repl_sec_purchases')}</h2>
                <DataTable
                  rows={purchases}
                  columns={[
                    { key: 'suggestion_no', label: t('dash.col_no') },
                    { key: 'branch_name', label: t('iv.repl_col_branch'), render: (r: any) => r.branch_name ?? (r.branch_id != null ? `#${r.branch_id}` : t('iv.repl_branch_all')) },
                    { key: 'item_id', label: t('iv.repl_col_item') },
                    { key: 'on_hand', label: t('iv.repl_col_on_hand'), align: 'right', render: (r: any) => <span className="tabular">{num(r.on_hand)}</span> },
                    { key: 'buy_qty', label: t('iv.repl_col_buy_qty'), align: 'right', render: (r: any) => <span className="tabular font-medium">{num(r.buy_qty || r.suggested_qty)}</span> },
                    { key: 'vendor', label: t('iv.repl_col_vendor'), render: (r: any) => r.vendor ?? '—' },
                    { key: 'urgency', label: t('iv.repl_col_urgency'), render: (r: any) => <Badge variant={urgencyVariant(r.urgency)}>{r.urgency}</Badge> },
                    { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                    { key: 'pr_no', label: t('iv.col_pr_no'), render: (r: any) => r.pr_no ?? '—' },
                  ]}
                  emptyState={{
                    icon: PackageSearch,
                    title: t('iv.repl_purchases_empty_title'),
                    description: t('iv.repl_purchases_empty_desc'),
                  }}
                />
              </section>

              {/* ── จุดสั่งซื้อตามดีมานด์ (demand-driven par recommendations, INV-12) ── */}
              <section className="space-y-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground"><AlertTriangle className="size-4 text-warning" /> {t('iv.repl_sec_par')}</h2>
                <p className="text-xs text-muted-foreground">{t('iv.repl_par_note')}</p>
                <DataTable
                  rows={parRecs}
                  columns={[
                    { key: 'branch_id', label: t('iv.repl_col_branch'), render: (r: any) => r.branch_id != null ? `#${r.branch_id}` : '—' },
                    { key: 'item_id', label: t('iv.repl_col_item') },
                    { key: 'avg_daily_usage', label: t('iv.repl_col_daily_usage'), align: 'right', render: (r: any) => <span className="tabular">{num(r.avg_daily_usage)}</span> },
                    { key: 'lead_time_days', label: t('iv.repl_col_lead'), align: 'right', render: (r: any) => <span className="tabular">{num(r.lead_time_days)}</span> },
                    { key: 'current_reorder_point', label: t('iv.repl_col_current_rop'), align: 'right', render: (r: any) => <span className="tabular">{num(r.current_reorder_point)}</span> },
                    { key: 'recommended_reorder_point', label: t('iv.repl_col_recommended'), align: 'right', render: (r: any) => <span className="tabular font-medium text-warning">{num(r.recommended_reorder_point)}</span> },
                    { key: 'apply', label: '', align: 'right', render: (r: any) => <Button size="sm" variant="outline" disabled={applyPar.isPending} onClick={() => applyPar.mutate({ branch_id: r.branch_id, item_id: r.item_id })}>{t('iv.repl_apply')}</Button> },
                  ]}
                  emptyState={{
                    icon: PackageSearch,
                    title: t('iv.repl_par_empty_title'),
                    description: t('iv.repl_par_empty_desc'),
                  }}
                />
              </section>
            </div>
          )}
        </StateView>
      </div>
    </div>
  );
}
