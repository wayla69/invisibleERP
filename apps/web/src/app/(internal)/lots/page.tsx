'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck2, GitBranch, Layers, PackageSearch, SearchX, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { statusVariant } from '@/components/ui';

const cols = (t: (k: string) => string) => [
  { key: 'lot_no', label: t('iv.lot_col_lot') },
  { key: 'item_id', label: t('iv.lot_item') },
  { key: 'location_id', label: t('iv.lot_location') },
  { key: 'balance', label: t('iv.lot_balance'), align: 'right' as const, render: (r: any) => num(r.balance) },
  { key: 'expiry_date', label: t('iv.lot_expiry'), render: (r: any) => thaiDate(r.expiry_date) },
  { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
];

export default function LotsPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('iv.lot_title')} description={t('iv.lot_desc')} />
      <Tabs tabs={[{ key: 'ledger', label: t('iv.lot_tab_ledger'), content: <Ledger /> }, { key: 'expiry', label: t('iv.lot_tab_expiry'), content: <Expiry /> }, { key: 'fefo', label: 'FEFO', content: <Fefo /> }, { key: 'trace', label: t('iv.lot_tab_trace'), content: <Trace /> }]} />
    </div>
  );
}

// INV-18 — lot genealogy trace (backward: GR → supplier; forward: pick/sale → customer) + hold/release.
function Trace() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [lot, setLot] = useState('');
  const [reason, setReason] = useState('');
  const q = useQuery<any>({ queryKey: ['lot-trace', lot], queryFn: () => api(`/api/lots/${encodeURIComponent(lot)}/trace`), enabled: !!lot });
  const hold = useMutation({
    mutationFn: () => api(`/api/lots/${encodeURIComponent(lot)}/hold`, { method: 'POST', body: JSON.stringify({ reason }) }),
    onSuccess: () => { notifySuccess(t('iv.lot_hold_success')); setReason(''); qc.invalidateQueries({ queryKey: ['lot-trace', lot] }); qc.invalidateQueries({ queryKey: ['lots-fefo'] }); },
    onError: (e: any) => notifyError(e?.message ?? 'Error'),
  });
  const release = useMutation({
    mutationFn: () => api(`/api/lots/${encodeURIComponent(lot)}/release`, { method: 'POST', body: JSON.stringify({ reason }) }),
    onSuccess: () => { notifySuccess(t('iv.lot_release_success')); setReason(''); qc.invalidateQueries({ queryKey: ['lot-trace', lot] }); qc.invalidateQueries({ queryKey: ['lots-fefo'] }); },
    onError: (e: any) => notifyError(e?.message ?? 'Error'),
  });
  const d = q.data;
  const held = d?.hold?.status === 'Held';
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('iv.lot_trace_desc')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-xs" placeholder={t('iv.lot_trace_ph')} value={lot} onChange={(e) => setLot(e.target.value.trim())} />
      </div>
      {lot && (
        <StateView q={q}>
          {d && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-3 rounded-lg border p-4">
                <div className="flex-1 min-w-[12rem]">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{d.lot_no}</span>
                    {held ? <Badge variant="destructive">{t('iv.lot_held_badge')}</Badge> : <Badge variant={statusVariant(d.lot?.status)}>{d.lot?.status}</Badge>}
                  </div>
                  <div className="text-sm text-muted-foreground">{d.lot?.item_id} · {d.lot?.item_description} · {num(d.lot?.balance)} {d.lot?.uom} · {thaiDate(d.lot?.expiry_date)}</div>
                </div>
                <Input className="max-w-xs" placeholder={held ? t('iv.lot_release_reason_ph') : t('iv.lot_hold_reason_ph')} value={reason} onChange={(e) => setReason(e.target.value)} />
                {held ? (
                  <Button variant="outline" onClick={() => release.mutate()} disabled={release.isPending}><ShieldCheck className="mr-1 h-4 w-4" />{t('iv.lot_release')}</Button>
                ) : (
                  <Button variant="destructive" onClick={() => hold.mutate()} disabled={hold.isPending}><ShieldAlert className="mr-1 h-4 w-4" />{t('iv.lot_hold')}</Button>
                )}
              </div>
              <div className="grid gap-5 lg:grid-cols-2">
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium"><GitBranch className="h-4 w-4 rotate-180" />{t('iv.lot_trace_backward')}</div>
                  <DataTable
                    rows={d.backward?.receipts ?? []}
                    columns={[
                      { key: 'gr_no', label: t('iv.lot_trace_gr') },
                      { key: 'po_no', label: t('iv.lot_trace_po') },
                      { key: 'vendor_name', label: t('iv.lot_trace_supplier') },
                    ]}
                    emptyState={{ icon: Layers, title: t('iv.lot_trace_none'), description: '' }}
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium"><GitBranch className="h-4 w-4" />{t('iv.lot_trace_forward')}</div>
                  <DataTable
                    rows={d.forward?.shipments ?? []}
                    columns={[
                      { key: 'ref_doc', label: t('iv.lot_trace_ref') },
                      { key: 'sale_no', label: t('iv.lot_trace_sale'), render: (r: any) => r.sale_no ?? r.source_ref ?? '—' },
                      { key: 'status', label: t('fin.col_status'), render: (r: any) => r.status ? <Badge variant={statusVariant(r.status)}>{r.status}</Badge> : '—' },
                    ]}
                    emptyState={{ icon: PackageSearch, title: t('iv.lot_trace_none'), description: '' }}
                  />
                </div>
              </div>
            </div>
          )}
        </StateView>
      )}
      {!lot && (
        <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
          <GitBranch className="mx-auto mb-2 h-8 w-8 opacity-50" />
          <div className="font-medium">{t('iv.lot_trace_empty_title')}</div>
          <div className="text-sm">{t('iv.lot_trace_empty_desc')}</div>
        </div>
      )}
    </div>
  );
}

function Ledger() {
  const { t } = useLang();
  const [item, setItem] = useState('');
  const q = useQuery<any>({ queryKey: ['lots', item], queryFn: () => api(`/api/lots${item ? `?item_id=${encodeURIComponent(item)}` : ''}`) });
  return (
    <div className="space-y-3">
      <Input className="max-w-xs" placeholder={t('iv.lot_filter_ph')} value={item} onChange={(e) => setItem(e.target.value)} />
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.lots}
            columns={cols(t)}
            emptyState={
              item
                ? {
                    icon: SearchX,
                    title: t('iv.lot_nomatch_title'),
                    description: t('iv.lot_nomatch_desc'),
                    action: (
                      <Button variant="outline" size="sm" onClick={() => setItem('')}>
                        {t('inv.clear_filter')}
                      </Button>
                    ),
                  }
                : { icon: Layers, title: t('iv.lot_empty_title'), description: t('iv.lot_empty_desc') }
            }
          />
        )}
      </StateView>
    </div>
  );
}

function Expiry() {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['lots-expiry'], queryFn: () => api('/api/lots/expiry') });
  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('iv.lot_stat_expired')} value={num(q.data.summary.expired)} tone="warning" />
            <StatCard label={t('iv.lot_stat_d0_7')} value={num(q.data.summary.d0_7)} tone="warning" />
            <StatCard label={t('iv.lot_stat_d8_30')} value={num(q.data.summary.d8_30)} />
            <StatCard label={t('iv.lot_stat_d31')} value={num(q.data.summary.d31_plus)} tone="success" />
          </div>
          <DataTable
            rows={[...q.data.buckets.expired, ...q.data.buckets.d0_7, ...q.data.buckets.d8_30]}
            columns={[...cols(t), { key: 'days_to_expiry', label: t('iv.lot_days_left'), align: 'right' as const, render: (r: any) => num(r.days_to_expiry) }]}
            emptyState={{ icon: CalendarCheck2, title: t('iv.lot_exp_empty_title'), description: t('iv.lot_exp_empty_desc') }}
          />
        </div>
      )}
    </StateView>
  );
}

function Fefo() {
  const { t } = useLang();
  const [item, setItem] = useState('');
  const q = useQuery<any>({ queryKey: ['lots-fefo', item], queryFn: () => api(`/api/lots/fefo/${encodeURIComponent(item)}`), enabled: !!item });
  return (
    <div className="space-y-3">
      <Input className="max-w-xs" placeholder={t('iv.lot_item_ph')} value={item} onChange={(e) => setItem(e.target.value)} />
      {item && (
        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={q.data.lots}
              columns={cols(t)}
              emptyState={{ icon: PackageSearch, title: t('iv.lot_fefo_empty_title'), description: t('iv.lot_fefo_empty_desc') }}
            />
          )}
        </StateView>
      )}
    </div>
  );
}
