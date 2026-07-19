'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { statusVariant } from '@/components/ui';

function StockTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['portal-inv'], queryFn: () => api('/api/portal/inventory') });
  const [edit, setEdit] = useState<Record<number, { reorder_point?: number; reorder_qty?: number; current_stock?: number }>>({});
  const save = useMutation({
    mutationFn: (id: number) => api(`/api/portal/inventory/${id}`, { method: 'PATCH', body: JSON.stringify(edit[id]) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal-inv'] }),
  });
  return (
    <StateView q={q}>
      {q.data && (
        <DataTable rows={q.data.items} columns={[
          { key: 'item_id', label: t('pt.inv.col_code') },
          { key: 'item_description', label: t('pt.inv.col_item') },
          { key: 'current_stock', label: t('pt.inv.col_onhand'), align: 'right', render: (r) => <Input className="ml-auto h-8 w-20 text-right tabular" type="number" defaultValue={r.current_stock} onChange={(e) => setEdit((s) => ({ ...s, [r.id]: { ...s[r.id], current_stock: +e.target.value } }))} /> },
          { key: 'reorder_point', label: t('pt.inv.col_rop'), align: 'right', render: (r) => <Input className="ml-auto h-8 w-20 text-right tabular" type="number" defaultValue={r.reorder_point} onChange={(e) => setEdit((s) => ({ ...s, [r.id]: { ...s[r.id], reorder_point: +e.target.value } }))} /> },
          { key: 'reorder_qty', label: t('pt.inv.col_roq'), align: 'right', render: (r) => <Input className="ml-auto h-8 w-20 text-right tabular" type="number" defaultValue={r.reorder_qty} onChange={(e) => setEdit((s) => ({ ...s, [r.id]: { ...s[r.id], reorder_qty: +e.target.value } }))} /> },
          { key: 'low_stock', label: t('pt.col_status'), render: (r) => (r.low_stock ? <Badge variant="warning">{t('pt.inv.need_reorder')}</Badge> : <Check className="size-4 text-success" />) },
          { key: 'save', label: '', align: 'right', render: (r) => <Button size="sm" variant="outline" disabled={!edit[r.id]} onClick={() => save.mutate(r.id)}>{t('pt.save')}</Button> },
        ]} />
      )}
    </StateView>
  );
}

function PendingTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['portal-pending'], queryFn: () => api('/api/portal/pending-orders') });
  const submit = useMutation({
    mutationFn: (no: string) => api(`/api/portal/pending-orders/${encodeURIComponent(no)}/submit`, { method: 'PATCH' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal-pending'] }),
  });
  return (
    <StateView q={q}>
      {q.data && (q.data.pending_orders.length === 0
        ? <Card className="gap-0 p-5"><CardContent className="px-0 text-sm text-muted-foreground">{t('pt.inv.no_pending')}</CardContent></Card>
        : <div className="space-y-3">{q.data.pending_orders.map((p: any) => (
          <Card key={p.pending_no} className="gap-4 p-5">
            <CardContent className="space-y-3 px-0">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{p.pending_no}</strong>
                  <Badge variant={statusVariant(p.status)}>{p.status}</Badge>
                  <span className="text-sm text-muted-foreground">· {p.trigger_type} · {t('pt.inv.n_items', { n: num(p.total_items) })}</span>
                </div>
                {p.status === 'Draft' && (
                  <Button size="sm" disabled={submit.isPending} onClick={() => submit.mutate(p.pending_no)}>
                    <Send className="size-4" /> {t('pt.inv.submit_approve')}
                  </Button>
                )}
              </div>
              <DataTable
                dense
                rows={p.items}
                columns={[
                  { key: 'item', label: t('pt.inv.col_product'), render: (it: any) => it.item_description ?? it.item_id },
                  { key: 'suggested_qty', label: t('pt.inv.col_suggested'), align: 'right', render: (it: any) => num(it.suggested_qty) },
                  { key: 'final_qty', label: t('pt.inv.col_final'), align: 'right', render: (it: any) => num(it.final_qty) },
                  { key: 'trigger_reason', label: t('pt.inv.col_reason'), render: (it: any) => <span className="text-muted-foreground">{it.trigger_reason}</span> },
                ]}
              />
            </CardContent>
          </Card>
        ))}</div>)}
    </StateView>
  );
}

export default function PortalInventory() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('pt.inv.title')} description={t('pt.inv.desc')} />
      <Tabs tabs={[{ key: 'stock', label: t('pt.inv.tab_stock'), content: <StockTab /> }, { key: 'pending', label: t('pt.inv.tab_pending'), content: <PendingTab /> }]} />
    </div>
  );
}
