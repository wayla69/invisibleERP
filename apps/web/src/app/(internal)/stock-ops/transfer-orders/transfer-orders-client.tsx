'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Truck, PackageCheck, Send, Plus, Trash2, Clock, FileText } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';
import { Select } from '@/components/form-controls';

interface Line { item_id: string; item_description?: string; uom?: string; qty: number }

// INV-2 / INV-16 — two-step inter-warehouse transfer orders. Ship relieves the source into Goods-in-Transit
// (Dr 1255 / Cr 1200); an independent custodian receives (Dr 1200 / Cr 1255). The in-transit aging tab is the
// period-end cutoff report. Custody SoD: the shipper cannot receive their own transfer (SOD_SELF_APPROVAL).
export default function TransferOrdersClient({ initialOrders, initialAging }: { initialOrders?: any; initialAging?: any }) {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('iv.to_title')} description={t('iv.to_desc')} />
      <Tabs tabs={[
        { key: 'new', label: t('iv.to_tab_new'), content: <NewOrder /> },
        { key: 'orders', label: t('iv.to_tab_orders'), content: <Orders initial={initialOrders} /> },
        { key: 'aging', label: t('iv.to_tab_aging'), content: <Aging initial={initialAging} /> },
      ]} />
    </div>
  );
}

function NewOrder() {
  const { t } = useLang();
  const qc = useQueryClient();
  const stock = useQuery<any>({ queryKey: ['stock', 'all'], queryFn: () => api('/api/inventory/stock?limit=500') });
  const items: any[] = stock.data?.items ?? [];
  const byId = useMemo(() => Object.fromEntries(items.map((i) => [i.Item_ID, i])), [items]);

  const [from, setFrom] = useState('WH-MAIN');
  const [to, setTo] = useState('WH-2');
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState('');

  function add() {
    if (!itemId || qty === '') return;
    const it = byId[itemId];
    setLines((ls) => [...ls.filter((l) => l.item_id !== itemId), { item_id: itemId, item_description: it?.Item_Description, uom: it?.UOM, qty: Number(qty) }]);
    setItemId(''); setQty('');
  }

  const save = useMutation({
    mutationFn: () => api<any>('/api/stock-ops/transfer-orders', { method: 'POST', body: JSON.stringify({ from_location: from, to_location: to, remarks: remarks || undefined, lines }) }),
    onSuccess: (r) => { notifySuccess(t('iv.to_created', { no: r.to_no })); setLines([]); setRemarks(''); qc.invalidateQueries({ queryKey: ['transfer-orders'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5"><Label htmlFor="to-from">{t('iv.to_from')}</Label><Input id="to-from" className="max-w-[160px]" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label htmlFor="to-to">{t('iv.to_to')}</Label><Input id="to-to" className="max-w-[160px]" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <div className="grid gap-1.5 min-w-[200px] flex-1"><Label htmlFor="to-rmk">{t('iv.to_remarks')}</Label><Input id="to-rmk" value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5 min-w-[220px] flex-1">
            <Label htmlFor="to-item">{t('iv.to_item')}</Label>
            <Select id="to-item" value={itemId} onChange={(e) => setItemId(e.target.value)}>
              <option value="">{t('iv.to_select')}</option>
              {items.map((i) => <option key={i.Item_ID} value={i.Item_ID}>{i.Item_ID} — {i.Item_Description}</option>)}
            </Select>
          </div>
          <div className="grid gap-1.5"><Label htmlFor="to-qty">{t('iv.to_qty')}</Label><Input id="to-qty" type="number" className="max-w-[140px]" value={qty} onChange={(e) => setQty(e.target.value)} /></div>
          <Button disabled={!itemId || qty === ''} onClick={add}><Plus className="size-4" /> {t('iv.to_add')}</Button>
        </div>
      </Card>

      {lines.length > 0 && (
        <Card className="gap-3 p-5">
          <DataTable
            rows={lines}
            columns={[
              { key: 'item_id', label: t('inv.col_code') },
              { key: 'item_description', label: t('iv.to_item') },
              { key: 'qty', label: t('iv.to_qty'), align: 'right', render: (r: any) => <span className="tabular">{num(r.qty)}</span> },
              { key: 'act', label: '', render: (r: any) => <Button variant="ghost" size="icon" onClick={() => setLines((ls) => ls.filter((x) => x.item_id !== r.item_id))}><Trash2 className="size-4" /></Button> },
            ]}
          />
          <Button disabled={save.isPending || from === to} onClick={() => save.mutate()}>{save.isPending ? t('iv.to_creating') : t('iv.to_create_btn', { n: lines.length })}</Button>
        </Card>
      )}
      {stock.isError && <StateView q={stock}><div /></StateView>}
    </div>
  );
}

function Orders({ initial }: { initial?: any }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['transfer-orders'], queryFn: () => api('/api/stock-ops/transfer-orders'), initialData: initial });
  const [sel, setSel] = useState<string | null>(null);
  const detail = useQuery<any>({ queryKey: ['transfer-order', sel], queryFn: () => api(`/api/stock-ops/transfer-orders/${sel}`), enabled: !!sel });

  const ship = useMutation({
    mutationFn: (no: string) => api<any>(`/api/stock-ops/transfer-orders/${no}/ship`, { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(t('iv.to_shipped_ok', { no: r.to_no, v: num(r.in_transit_value) })); qc.invalidateQueries({ queryKey: ['transfer-orders'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const receive = useMutation({
    mutationFn: (no: string) => api<any>(`/api/stock-ops/transfer-orders/${no}/receive`, { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(t('iv.to_received_ok', { no: r.to_no })); qc.invalidateQueries({ queryKey: ['transfer-orders'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="space-y-4">
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.transfer_orders}
            columns={[
              { key: 'to_no', label: t('iv.to_col_no') },
              { key: 'status', label: t('iv.to_col_status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              { key: 'from_location', label: t('iv.to_col_from') },
              { key: 'to_location', label: t('iv.to_col_to') },
              { key: 'shipped_by', label: t('iv.to_col_shipped_by'), render: (r: any) => r.shipped_by ?? '—' },
              { key: 'received_by', label: t('iv.to_col_received_by'), render: (r: any) => r.received_by ?? '—' },
              { key: 'act', label: '', render: (r: any) => (
                <div className="flex justify-end gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setSel(r.to_no)}>{t('iv.to_view')}</Button>
                  {r.status === 'Draft' && <Button size="sm" disabled={ship.isPending} onClick={() => ship.mutate(r.to_no)}><Send className="size-4" /> {t('iv.to_ship')}</Button>}
                  {r.status === 'Shipped' && <Button size="sm" disabled={receive.isPending} onClick={() => receive.mutate(r.to_no)}><PackageCheck className="size-4" /> {t('iv.to_receive')}</Button>}
                </div>
              ) },
            ]}
            emptyState={{ icon: Truck, title: t('iv.to_empty_title'), description: t('iv.to_empty_desc') }}
          />
        )}
      </StateView>
      {sel && (
        <Card className="gap-3 p-5">
          <div className="flex items-center justify-between"><h3 className="text-base font-semibold">{t('iv.to_lines', { no: sel })}</h3><Button variant="ghost" size="sm" onClick={() => setSel(null)}>{t('iv.to_close')}</Button></div>
          <StateView q={detail}>
            {detail.data && (
              <DataTable
                rows={detail.data.lines}
                columns={[
                  { key: 'item_id', label: t('inv.col_code') },
                  { key: 'item_description', label: t('iv.to_item') },
                  { key: 'qty', label: t('iv.to_qty'), align: 'right', render: (r: any) => num(r.qty) },
                  { key: 'unit_cost', label: t('iv.to_unit_cost'), align: 'right', render: (r: any) => num(r.unit_cost) },
                  { key: 'line_value', label: t('iv.to_line_value'), align: 'right', render: (r: any) => num(r.line_value) },
                ]}
                emptyState={{ icon: FileText, title: t('iv.to_empty_title') }}
              />
            )}
          </StateView>
        </Card>
      )}
    </div>
  );
}

function Aging({ initial }: { initial?: any }) {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['transfer-orders', 'aging'], queryFn: () => api('/api/stock-ops/transfer-orders/in-transit/aging'), initialData: initial });
  return (
    <div className="space-y-4">
      <StateView q={q}>
        {q.data && (
          <>
            <div className="flex flex-wrap gap-4">
              <Card className="gap-1 p-4"><span className="text-sm text-muted-foreground"><Clock className="mr-1 inline size-4" />{t('iv.to_aging_open')}</span><span className="text-2xl font-semibold tabular">{num(q.data.open_count)}</span></Card>
              <Card className="gap-1 p-4"><span className="text-sm text-muted-foreground">{t('iv.to_aging_value')}</span><span className="text-2xl font-semibold tabular">{num(q.data.total_in_transit_value)}</span></Card>
            </div>
            <DataTable
              rows={q.data.items}
              columns={[
                { key: 'to_no', label: t('iv.to_col_no') },
                { key: 'from_location', label: t('iv.to_col_from') },
                { key: 'to_location', label: t('iv.to_col_to') },
                { key: 'shipped_at', label: t('iv.to_col_shipped_by'), render: (r: any) => r.shipped_at ? thaiDate(r.shipped_at) : '—' },
                { key: 'days_in_transit', label: t('iv.to_col_days'), align: 'right', render: (r: any) => <span className="tabular">{num(r.days_in_transit)}</span> },
                { key: 'aging_bucket', label: t('iv.to_col_bucket'), render: (r: any) => <Badge variant={r.aging_bucket === '31+' ? 'destructive' : r.aging_bucket === '8-30' ? 'warning' : 'secondary'}>{r.aging_bucket}</Badge> },
                { key: 'value', label: t('iv.to_col_value'), align: 'right', render: (r: any) => <span className="tabular">{num(r.value)}</span> },
              ]}
              emptyState={{ icon: PackageCheck, title: t('iv.to_aging_empty') }}
            />
          </>
        )}
      </StateView>
    </div>
  );
}
