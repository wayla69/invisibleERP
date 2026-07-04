'use client';

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ClipboardCheck, PackageMinus, SlidersHorizontal, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable, type Column } from '@/components/data-table';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StateView } from '@/components/state-view';
import { statusVariant } from '@/components/ui';

// Stock Adjustment screen (SoD R11: wh_adjust only).
// An Inventory Controller reviews and posts variance adjustments from counted stocktakes,
// and approves write-off requests. A Stock Counter (wh_count only) cannot access this screen.

interface Stocktake { st_no: string; st_date: string; counted_by: string; lines: number; variance_lines: number; status: string }
interface StockList { stocktakes: Stocktake[] }
interface Writeoff { id: number; writeoff_no: string; item_id: string; item_description?: string; qty: number; uom?: string; reason?: string; status: string; requested_by: string; requested_at: string }
interface WriteoffList { writeoffs: Writeoff[] }

export default function StockAdjustmentPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [directOpen, setDirectOpen] = useState(false);

  const pending = useQuery<StockList>({
    queryKey: ['stocktakes', 'Counted'],
    queryFn: () => api('/api/stocktake?limit=50'),
  });
  const counts = (pending.data?.stocktakes ?? []).filter((s) => s.status === 'Counted');

  const writeoffs = useQuery<WriteoffList>({
    queryKey: ['writeoffs', 'Pending'],
    queryFn: () => api('/api/inventory/writeoffs?status=Pending'),
  });

  const totalPending = counts.length + (writeoffs.data?.writeoffs.length ?? 0);

  const postCount = useMutation({
    mutationFn: (stNo: string) => api(`/api/stocktake/${encodeURIComponent(stNo)}/post`, { method: 'POST', body: '{}' }),
    onSuccess: (r: any, stNo) => {
      notifySuccess(t('iv.adj_post_success', { stNo, n: r?.variance_movements ?? 0 }));
      qc.invalidateQueries({ queryKey: ['stocktakes'] });
    },
    onError: (e: any) => notifyError(e?.message ?? t('iv.adj_post_error')),
  });

  const approveWo = useMutation({
    mutationFn: (id: number) => api(`/api/inventory/writeoffs/${id}/approve`, { method: 'POST', body: '{}' }),
    onSuccess: () => { notifySuccess(t('iv.adj_wo_approve_success')); qc.invalidateQueries({ queryKey: ['writeoffs'] }); },
    onError: (e: any) => notifyError(e?.message ?? t('iv.adj_approve_error')),
  });

  const rejectWo = useMutation({
    mutationFn: (id: number) => api(`/api/inventory/writeoffs/${id}/reject`, { method: 'POST', body: '{}' }),
    onSuccess: () => { notifySuccess(t('iv.adj_wo_reject_success')); qc.invalidateQueries({ queryKey: ['writeoffs'] }); },
    onError: (e: any) => notifyError(e?.message ?? t('iv.adj_reject_error')),
  });

  const countCols: Column<Stocktake>[] = [
    { key: 'st_no', label: t('dash.col_no'), render: (r) => <span className="font-medium">{r.st_no}</span> },
    { key: 'st_date', label: t('iv.adj_col_count_date'), render: (r) => thaiDate(r.st_date) },
    { key: 'counted_by', label: t('iv.adj_col_counted_by') },
    { key: 'lines', label: t('iv.adj_col_lines'), align: 'right', render: (r) => num(r.lines) },
    { key: 'variance_lines', label: t('iv.adj_col_variance_lines'), align: 'right', render: (r) => <span className={r.variance_lines > 0 ? 'font-medium text-destructive' : ''}>{num(r.variance_lines)}</span> },
    { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    {
      key: 'st_no', label: t('iv.adj_col_action'),
      render: (r) => (
        <Button size="sm" className="h-7 gap-1" disabled={postCount.isPending}
          onClick={() => postCount.mutate(r.st_no)}>
          <ClipboardCheck className="size-3.5" />{t('iv.adj_post_variance')}
        </Button>
      ),
    },
  ];

  const woCols: Column<Writeoff>[] = [
    { key: 'writeoff_no', label: t('iv.adj_col_wo_no'), render: (r) => <span className="font-medium">{r.writeoff_no}</span> },
    { key: 'item_id', label: t('iv.adj_col_item_code') },
    { key: 'item_description', label: t('iv.adj_col_item'), render: (r) => r.item_description ?? '—' },
    { key: 'qty', label: t('inv.col_qty'), align: 'right', render: (r) => <span className="tabular text-destructive">−{num(r.qty)} {r.uom ?? ''}</span> },
    { key: 'reason', label: t('iv.adj_col_reason'), render: (r) => r.reason ?? '—' },
    { key: 'requested_by', label: t('iv.adj_col_requested_by') },
    {
      key: 'id', label: t('iv.adj_col_action'),
      render: (r) => (
        <div className="flex gap-1.5">
          <Button size="sm" variant="secondary" className="h-7 gap-1 text-green-700"
            disabled={approveWo.isPending} onClick={() => approveWo.mutate(r.id)}>
            <CheckCircle2 className="size-3.5" />{t('fin.approve')}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 gap-1 text-destructive"
            disabled={rejectWo.isPending} onClick={() => rejectWo.mutate(r.id)}>
            <XCircle className="size-3.5" />{t('iv.adj_reject')}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <ModulePage
      title={t('iv.adj_title')}
      description={t('iv.adj_desc')}
      query={pending}
      actions={
        <Button size="sm" variant="outline" onClick={() => setDirectOpen(true)}>
          <SlidersHorizontal className="mr-1.5 size-4" />{t('iv.adj_direct')}
        </Button>
      }
      stats={
        <>
          <StatCard label={t('iv.adj_stat_pending')} value={num(totalPending)} icon={ClipboardCheck} tone={totalPending > 0 ? 'warning' : 'default'} />
          <StatCard label={t('iv.adj_stat_counts')} value={num(counts.length)} icon={ClipboardCheck} tone={counts.length > 0 ? 'primary' : 'default'} />
          <StatCard label={t('iv.adj_stat_wo')} value={num(writeoffs.data?.writeoffs.length ?? 0)} icon={PackageMinus} tone={(writeoffs.data?.writeoffs.length ?? 0) > 0 ? 'warning' : 'default'} />
        </>
      }
      statsClassName="xl:grid-cols-3"
    >
      <Tabs
        tabs={[
          {
            key: 'counts',
            label: t('iv.adj_tab_counts', { n: counts.length }),
            content: (
              <DataTable
                rows={counts}
                rowKey={(r) => r.st_no}
                emptyState={{ icon: ClipboardCheck, title: t('iv.adj_empty_counts_title'), description: t('iv.adj_empty_counts_desc') }}
                columns={countCols}
              />
            ),
          },
          {
            key: 'writeoffs',
            label: t('iv.adj_tab_wo', { n: writeoffs.data?.writeoffs.length ?? 0 }),
            content: (
              <StateView q={writeoffs}>
                <DataTable
                  rows={writeoffs.data?.writeoffs ?? []}
                  rowKey={(r) => r.writeoff_no}
                  emptyState={{ icon: PackageMinus, title: t('iv.adj_empty_wo_title'), description: t('iv.adj_empty_wo_desc') }}
                  columns={woCols}
                />
              </StateView>
            ),
          },
        ]}
      />

      {directOpen && <DirectAdjustDialog onClose={() => setDirectOpen(false)} onDone={() => { setDirectOpen(false); qc.invalidateQueries(); }} />}
    </ModulePage>
  );
}

function DirectAdjustDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useLang();
  const [itemId, setItemId] = useState('');
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');

  const adj = useMutation({
    mutationFn: () => api('/api/inventory/adjustments', { method: 'POST', body: JSON.stringify({ item_id: itemId, qty_delta: Number(delta), reason }) }),
    onSuccess: () => { notifySuccess(t('iv.adj_direct_success')); onDone(); },
    onError: (e: any) => notifyError(e?.message ?? t('iv.adj_direct_error')),
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('iv.adj_direct_title')}</DialogTitle></DialogHeader>
        <Card className="border-0 shadow-none p-0">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="adj-item">{t('iv.adj_col_item_code')}</Label>
              <Input id="adj-item" value={itemId} onChange={(e) => setItemId(e.target.value)} placeholder={t('iv.adj_item_ph')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="adj-delta">{t('iv.adj_delta_label')}</Label>
              <Input id="adj-delta" type="number" value={delta} onChange={(e) => setDelta(e.target.value)} placeholder={t('iv.adj_delta_ph')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="adj-reason">{t('iv.adj_col_reason')}</Label>
              <textarea id="adj-reason" className="min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
                value={reason} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setReason(e.target.value)}
                placeholder={t('iv.adj_reason_ph')} rows={2} />
            </div>
          </div>
        </Card>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('fin.cancel')}</Button>
          <Button disabled={!itemId || !delta || adj.isPending} onClick={() => adj.mutate()}>
            <SlidersHorizontal className="mr-1.5 size-4" />{t('iv.adj_submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
