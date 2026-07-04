'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Armchair, ArrowLeftRight, Flame, Plus, QrCode, Receipt, Sparkles, Split, Trash2, Utensils, Wallet, Wifi, WifiOff, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useRealtime } from '@/hooks/use-realtime';
import { DineInOrderDialog } from '@/components/dine-in-order-dialog';
import { FloorPlan, statusTh, tone, type TableRow, type ZoneRow } from '@/components/floor-plan';
import { cn } from '@/lib/utils';
import { useLang } from '@/lib/i18n';
import { baht } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Tabs, Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { statusVariant } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// TableRow / STATUS_TH / STATUS_TONE / tone live in components/floor-plan and are imported above —
// the floor-plan editor and this page share the same status palette and row shape.

export default function TablesPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  // Live via SSE: a table freed/occupied/fired on another terminal updates this board at once; polling
  // drops to a 20s fallback while the stream is connected.
  const { connected } = useRealtime((e) => { if (e.type === 'table' || e.type === 'kds_item') qc.invalidateQueries({ queryKey: ['tables-status'] }); });
  const board = useQuery<{ tables: TableRow[] }>({ queryKey: ['tables-status'], queryFn: () => api('/api/restaurant/tables/status'), refetchInterval: connected ? 20000 : 4000 });
  const zonesQ = useQuery<{ zones: ZoneRow[] }>({ queryKey: ['floor-zones'], queryFn: () => api('/api/restaurant/zones') });
  const [sel, setSel] = useState<number | null>(null);
  const [orderTable, setOrderTable] = useState<number | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['tables-status'] });
  const refreshZones = () => qc.invalidateQueries({ queryKey: ['floor-zones'] });

  const tables = board.data?.tables ?? [];
  const zones = zonesQ.data?.zones ?? [];
  const selected = tables.find((t) => t.id === sel) ?? null;
  const ordering = tables.find((t) => t.id === orderTable) ?? null;

  return (
    <div>
      <PageHeader
        title={t('px.tbl_page_title')}
        description={t('px.tbl_page_desc')}
        actions={
          <Badge variant={connected ? 'success' : 'muted'} className="gap-1">
            {connected ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />} {connected ? t('px.tbl_realtime') : t('px.tbl_connecting')}
          </Badge>
        }
      />
      <Tabs
        tabs={[
          { key: 'board', label: t('px.tbl_tab_board'), content: <Board tables={tables} zones={zones} q={board} onSelect={setSel} sel={sel} onOrder={setOrderTable} /> },
          { key: 'plan', label: t('px.tbl_tab_plan'), content: <FloorPlan tables={tables} zones={zones} onSelect={setSel} sel={sel} onChange={refresh} onZonesChange={refreshZones} /> },
          { key: 'revenue', label: t('px.tbl_tab_revenue'), content: <RoomRevenue /> },
        ]}
      />
      {selected && <TablePanel t={selected} onChange={refresh} onClose={() => setSel(null)} onOrder={() => setOrderTable(selected.id)} />}
      {ordering && (
        <DineInOrderDialog
          tableId={ordering.id}
          tableNo={ordering.table_no}
          orderNo={ordering.order?.order_no ?? null}
          onChange={refresh}
          onClose={() => setOrderTable(null)}
        />
      )}
    </div>
  );
}

function Board({ tables, zones, q, onSelect, sel, onOrder }: { tables: TableRow[]; zones: ZoneRow[]; q: any; onSelect: (id: number) => void; sel: number | null; onOrder: (id: number) => void }) {
  const { t } = useLang();
  const [room, setRoom] = useState<number | 'all' | 'none'>('all');
  const busy = (ts: TableRow[]) => ts.filter((row) => ['occupied', 'bill_requested', 'paying'].includes(row.status)).length;
  const chip = (active: boolean) => cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors', active ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-accent');

  const card = (row: TableRow) => (
    <div
      key={row.id}
      className={cn('rounded-lg border border-l-[6px] bg-card transition-colors', tone(row.status).border, sel === row.id && 'ring-2 ring-primary')}
    >
      <button onClick={() => onSelect(row.id)} className="w-full rounded-t-lg p-2.5 text-left hover:bg-accent">
        <div className="flex items-center justify-between">
          <strong>{t('px.tbl_table_label', { no: row.table_no })}</strong>
          <span className="text-sm text-muted-foreground">{t('px.tbl_seats', { n: row.seats })}</span>
        </div>
        <div className={cn('text-sm font-semibold', tone(row.status).text)}>{statusTh(t, row.status)}</div>
        {row.order && <div className="text-xs text-muted-foreground tabular">{baht(row.order.total)} · {t('px.tbl_waited', { min: row.order.waited_min })}</div>}
      </button>
      <div className="px-2.5 pb-2.5">
        <Button variant="outline" size="sm" className="w-full" onClick={() => onOrder(row.id)}>
          <Utensils className="size-4" /> {t('px.tbl_order_food')}
        </Button>
      </div>
    </div>
  );

  // No rooms defined → keep the simple flat grid (unchanged for shops without rooms).
  if (zones.length === 0) {
    return (
      <StateView q={q}>
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
          {tables.length === 0 && <p className="text-sm text-muted-foreground">{t('px.tbl_no_tables_hint')}</p>}
          {tables.map(card)}
        </div>
      </StateView>
    );
  }

  // Rooms exist → group tables by room, with a filter + per-room occupancy.
  const sections: { key: number | 'none'; name: string; color: string | null; tables: TableRow[] }[] = [
    ...zones.map((z) => ({ key: z.id as number | 'none', name: z.name, color: z.color, tables: tables.filter((t) => t.zone_id === z.id) })),
    { key: 'none' as const, name: t('px.tbl_no_room'), color: null as string | null, tables: tables.filter((row) => row.zone_id == null) },
  ].filter((s) => s.tables.length > 0);
  const shown = room === 'all' ? sections : sections.filter((s) => s.key === room);

  return (
    <StateView q={q}>
      <div className="mb-3 flex flex-wrap gap-2">
        <button onClick={() => setRoom('all')} className={chip(room === 'all')}>{t('px.tbl_all')} ({tables.length})</button>
        {sections.map((s) => (
          <button key={String(s.key)} onClick={() => setRoom(s.key)} className={chip(room === s.key)}>
            {s.color && <span className="size-2 rounded-full" style={{ background: s.color }} />}
            {s.name} · {busy(s.tables)}/{s.tables.length}
          </button>
        ))}
      </div>
      {tables.length === 0 && <p className="text-sm text-muted-foreground">{t('px.tbl_no_tables_hint')}</p>}
      <div className="space-y-4">
        {shown.map((s) => (
          <section key={String(s.key)}>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              {s.color && <span className="size-2.5 rounded-full" style={{ background: s.color }} />}
              {s.name}
              <span className="font-normal text-muted-foreground">· {busy(s.tables)}/{s.tables.length} {t('px.tbl_tables_occupied')}</span>
            </h3>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
              {s.tables.map(card)}
            </div>
          </section>
        ))}
      </div>
    </StateView>
  );
}

type RevRoom = { zone_id: number; name: string; color: string | null; active?: boolean; revenue: number; sales: number; avg_sale: number };

function RoomRevenue() {
  const { t } = useLang();
  const today = (() => { const d = new Date(); const p = (x: number) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const q = useQuery<{ from: string; to: string; rooms: RevRoom[]; unzoned: { revenue: number; sales: number }; total: { revenue: number; sales: number } }>({
    queryKey: ['zone-revenue', from, to],
    queryFn: () => api(`/api/restaurant/zones/revenue?from=${from}&to=${to}`),
  });
  const rooms = q.data?.rooms ?? [];
  const unzoned = q.data?.unzoned ?? { revenue: 0, sales: 0 };
  const max = Math.max(1, ...rooms.map((r) => r.revenue), unzoned.revenue);
  const rows: RevRoom[] = [
    ...rooms,
    { zone_id: 0, name: t('px.tbl_no_room'), color: null, active: true, revenue: unzoned.revenue, sales: unzoned.sales, avg_sale: unzoned.sales ? unzoned.revenue / unzoned.sales : 0 },
  ].filter((r) => r.zone_id !== 0 || r.sales > 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">{t('px.tbl_from')} <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="mt-1 w-[170px]" /></label>
        <label className="text-sm">{t('px.tbl_to')} <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="mt-1 w-[170px]" /></label>
      </div>
      <StateView q={q}>
        {q.data && (
          <>
            <div className="flex flex-wrap gap-3">
              <div className="rounded-lg border bg-card p-3"><div className="text-xs text-muted-foreground">{t('px.tbl_total_revenue')}</div><div className="text-2xl font-semibold tabular">{baht(q.data.total.revenue)}</div></div>
              <div className="rounded-lg border bg-card p-3"><div className="text-xs text-muted-foreground">{t('px.tbl_bill_count')}</div><div className="text-2xl font-semibold tabular">{q.data.total.sales}</div></div>
            </div>
            <div className="space-y-2">
              {q.data.total.sales === 0 && <p className="text-sm text-muted-foreground">{t('px.tbl_no_revenue')}</p>}
              {rows.map((r) => (
                <div key={r.zone_id} className="rounded-lg border bg-card p-3">
                  <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="flex items-center gap-2 font-medium">{r.color && <span className="size-2.5 rounded-full" style={{ background: r.color }} />}{r.name}{r.active === false && <span className="text-xs font-normal text-muted-foreground">{t('px.tbl_deleted')}</span>}</span>
                    <span className="text-muted-foreground tabular">{baht(r.revenue)} · {t('px.tbl_bills', { n: r.sales })} · {t('px.tbl_avg')} {baht(r.avg_sale)}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${(r.revenue / max) * 100}%` }} /></div>
                </div>
              ))}
            </div>
          </>
        )}
      </StateView>
    </div>
  );
}

function TablePanel({ t: tbl, onChange, onClose, onOrder }: { t: TableRow; onChange: () => void; onClose: () => void; onOrder: () => void }) {
  const { t } = useLang();
  const [msg, setMsg] = useState('');
  const [qr, setQr] = useState('');
  const [sticker, setSticker] = useState<{ url: string; qr_image: string } | null>(null);
  const [item, setItem] = useState({ name: '', qty: '1', price: '', station: 'hot' });
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [buffetOpen, setBuffetOpen] = useState(false);
  const [bPkg, setBPkg] = useState('');
  const [bPax, setBPax] = useState('2');

  const onErr = (e: any) => setMsg(`❌ ${e.message}`);
  const printQr = useMutation({ mutationFn: () => api<{ url: string; qr_image: string }>(`/api/restaurant/tables/${tbl.id}/qr?base=${encodeURIComponent(typeof window !== 'undefined' ? window.location.origin : '')}`), onSuccess: setSticker, onError: onErr });
  const tiers = useQuery<{ packages: { id: number; name: string; price_per_pax: number }[] }>({ queryKey: ['buffet-packages'], queryFn: () => api('/api/restaurant/buffet/packages'), enabled: buffetOpen });
  const startBuffet = useMutation({ mutationFn: () => api(`/api/restaurant/tables/${tbl.id}/buffet`, { method: 'POST', body: JSON.stringify({ package_id: Number(bPkg), pax: Number(bPax) || 1 }) }), onSuccess: () => { setMsg(t('px.tbl_buffet_started')); setBuffetOpen(false); onChange(); }, onError: onErr });
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTo, setMoveTo] = useState('');
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeFrom, setMergeFrom] = useState('');
  const [transferOpen, setTransferOpen] = useState(false);
  const [tItems, setTItems] = useState<number[]>([]);
  const [tTo, setTTo] = useState('');
  const allTables = useQuery<{ tables: { id: number; table_no: string; status: string }[] }>({ queryKey: ['tables-list'], queryFn: () => api('/api/restaurant/tables'), enabled: moveOpen || mergeOpen || transferOpen });
  const orderDetail = useQuery<{ items: { item_id: number; name: string; qty: number; amount: number; charge: boolean }[] }>({ queryKey: ['order-detail', tbl.order?.order_no], queryFn: () => api(`/api/restaurant/orders/${tbl.order!.order_no}`), enabled: transferOpen && !!tbl.order });
  const move = useMutation({ mutationFn: () => api(`/api/restaurant/tables/${tbl.id}/move`, { method: 'POST', body: JSON.stringify({ to_table_id: Number(moveTo) }) }), onSuccess: () => { setMsg(t('px.tbl_table_moved')); setMoveOpen(false); onClose(); onChange(); }, onError: onErr });
  const merge = useMutation({ mutationFn: () => api(`/api/restaurant/tables/${tbl.id}/merge`, { method: 'POST', body: JSON.stringify({ from_table_id: Number(mergeFrom) }) }), onSuccess: () => { setMsg(t('px.tbl_tables_merged')); setMergeOpen(false); onChange(); }, onError: onErr });
  const transfer = useMutation({ mutationFn: () => api(`/api/restaurant/orders/${tbl.order!.order_no}/transfer-items`, { method: 'POST', body: JSON.stringify({ item_ids: tItems, to_table_id: Number(tTo) }) }), onSuccess: () => { setMsg(t('px.tbl_items_transferred')); setTransferOpen(false); setTItems([]); setTTo(''); onChange(); }, onError: onErr });
  const toggleItem = (id: number) => setTItems((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const open = useMutation({ mutationFn: () => api<{ session_id: number; public_token: string }>(`/api/restaurant/tables/${tbl.id}/open`, { method: 'POST', body: '{}' }), onSuccess: (r) => { setSessionId(r.session_id); setQr(`/qr/${r.public_token}`); setMsg(t('px.tbl_table_opened')); onChange(); }, onError: onErr });
  const addItem = useMutation({
    mutationFn: async () => {
      const items = [{ name: item.name, qty: Number(item.qty) || 1, unit_price: Number(item.price) || 0, station_code: item.station }];
      if (tbl.order) return api(`/api/restaurant/orders/${tbl.order.order_no}/items`, { method: 'POST', body: JSON.stringify({ items }) });
      return api('/api/restaurant/orders', { method: 'POST', body: JSON.stringify({ table_id: tbl.id, session_id: sessionId ?? undefined, items }) });
    },
    onSuccess: () => { setItem({ ...item, name: '', price: '' }); setMsg(t('px.tbl_item_added')); onChange(); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const fire = useMutation({ mutationFn: () => api(`/api/restaurant/orders/${tbl.order!.order_no}/fire`, { method: 'POST', body: '{}' }), onSuccess: () => { setMsg(t('px.tbl_sent_to_kitchen')); onChange(); }, onError: onErr });
  const [fireCourse, setFireCourse] = useState('');
  const fireCourseM = useMutation({ mutationFn: () => api(`/api/restaurant/orders/${tbl.order!.order_no}/fire?course=${Number(fireCourse)}`, { method: 'POST', body: '{}' }), onSuccess: () => { setMsg(t('px.tbl_course_fired', { course: fireCourse })); setFireCourse(''); onChange(); }, onError: onErr });
  const bill = useMutation({ mutationFn: () => api(`/api/restaurant/orders/${tbl.order!.order_no}/bill`, { method: 'POST', body: '{}' }), onSuccess: () => { setMsg(t('px.tbl_bill_requested_msg')); onChange(); }, onError: onErr });
  const checkout = useMutation({ mutationFn: () => api<{ tax_invoice_no: string }>(`/api/restaurant/orders/${tbl.order!.order_no}/checkout`, { method: 'POST', body: JSON.stringify({ method: 'Cash' }) }), onSuccess: (r) => { setMsg(t('px.tbl_checkout_success', { no: r.tax_invoice_no ?? '-' })); onChange(); }, onError: onErr });
  const clear = useMutation({ mutationFn: () => api(`/api/restaurant/tables/${tbl.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'available' }) }), onSuccess: () => { setMsg(t('px.tbl_table_cleared')); onClose(); onChange(); }, onError: onErr });
  const del = useMutation({ mutationFn: () => api(`/api/restaurant/tables/${tbl.id}`, { method: 'DELETE' }), onSuccess: () => { onClose(); onChange(); }, onError: onErr });
  const removeTable = () => { if (typeof window !== 'undefined' && !window.confirm(t('px.tbl_remove_confirm', { no: tbl.table_no }))) return; del.mutate(); };

  return (
    <Card className={cn('mt-4 gap-4 border-t-4 p-5', tone(tbl.status).bar)}>
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-lg font-semibold">{t('px.tbl_table_label', { no: tbl.table_no })} · <Badge variant={statusVariant(statusTh(t, tbl.status))}>{statusTh(t, tbl.status)}</Badge></h3>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={onOrder}><Utensils className="size-4" /> {t('px.tbl_order_food')}</Button>
          <Button variant="ghost" size="icon" onClick={onClose}><X className="size-4" /></Button>
        </div>
      </div>
      <Msg ok={!msg.startsWith('❌')}>{msg}</Msg>

      {tbl.status === 'available' && <Button onClick={() => open.mutate()} disabled={open.isPending}><Armchair className="size-4" /> {t('px.tbl_open_table')}</Button>}
      {qr && <div className="text-sm text-muted-foreground">{t('px.tbl_customer_qr')} <a href={qr} target="_blank" className="text-primary hover:underline">{qr}</a></div>}

      <div>
        <Button variant="outline" size="sm" onClick={() => printQr.mutate()} disabled={printQr.isPending}><QrCode className="size-4" /> {t('px.tbl_table_qr_print')}</Button>
        {sticker && (
          <div className="mt-2 flex items-center gap-3 rounded-lg border p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={sticker.qr_image} alt={t('px.tbl_qr_alt', { no: tbl.table_no })} className="size-28 rounded bg-white p-1" />
            <div className="min-w-0 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">{t('px.tbl_scan_to_order', { no: tbl.table_no })}</p>
              <p className="break-all">{sticker.url}</p>
              <p className="mt-1">{t('px.tbl_sticker_hint')}</p>
            </div>
          </div>
        )}
      </div>

      {!tbl.order && tbl.status !== 'cleaning' && (
        <div>
          <Button variant="outline" size="sm" onClick={() => setBuffetOpen((v) => !v)}><Utensils className="size-4" /> {t('px.tbl_start_buffet')}</Button>
          {buffetOpen && (
            <div className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border p-3">
              <Select value={bPkg} onValueChange={setBPkg}>
                <SelectTrigger className="w-[200px]"><SelectValue placeholder={t('px.tbl_select_buffet_pkg')} /></SelectTrigger>
                <SelectContent>
                  {(tiers.data?.packages ?? []).map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name} · {baht(p.price_per_pax)}{t('px.tbl_per_pax')}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input className="w-[90px]" type="number" min={1} step={1} placeholder={t('px.tbl_pax_count')} value={bPax} onChange={(e) => setBPax(e.target.value)} />
              <Button disabled={!bPkg || startBuffet.isPending} onClick={() => startBuffet.mutate()}>{t('px.tbl_start')}</Button>
            </div>
          )}
        </div>
      )}

      {(tbl.session || sessionId) && tbl.status !== 'cleaning' && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => { setMoveOpen((v) => !v); setMergeOpen(false); setTransferOpen(false); }}><ArrowLeftRight className="size-4" /> {t('px.tbl_move_table')}</Button>
            <Button variant="outline" size="sm" onClick={() => { setMergeOpen((v) => !v); setMoveOpen(false); setTransferOpen(false); }}><Sparkles className="size-4" /> {t('px.tbl_merge_table')}</Button>
            {tbl.order && <Button variant="outline" size="sm" onClick={() => { setTransferOpen((v) => !v); setMoveOpen(false); setMergeOpen(false); }}><Split className="size-4" /> {t('px.tbl_transfer_items')}</Button>}
          </div>
          {moveOpen && (
            <div className="flex flex-wrap items-end gap-2 rounded-lg border p-3">
              <Select value={moveTo} onValueChange={setMoveTo}>
                <SelectTrigger className="w-[200px]"><SelectValue placeholder={t('px.tbl_move_to_empty')} /></SelectTrigger>
                <SelectContent>
                  {(allTables.data?.tables ?? []).filter((x) => x.id !== tbl.id && x.status === 'available').map((x) => <SelectItem key={x.id} value={String(x.id)}>{t('px.tbl_table_label', { no: x.table_no })}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button disabled={!moveTo || move.isPending} onClick={() => move.mutate()}>{t('px.tbl_move')}</Button>
            </div>
          )}
          {mergeOpen && (
            <div className="flex flex-wrap items-end gap-2 rounded-lg border p-3">
              <Select value={mergeFrom} onValueChange={setMergeFrom}>
                <SelectTrigger className="w-[220px]"><SelectValue placeholder={t('px.tbl_merge_placeholder')} /></SelectTrigger>
                <SelectContent>
                  {(allTables.data?.tables ?? []).filter((x) => x.id !== tbl.id && ['occupied', 'bill_requested', 'paying'].includes(x.status)).map((x) => <SelectItem key={x.id} value={String(x.id)}>{t('px.tbl_table_label', { no: x.table_no })}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button disabled={!mergeFrom || merge.isPending} onClick={() => merge.mutate()}>{t('px.tbl_merge')}</Button>
            </div>
          )}
          {transferOpen && tbl.order && (
            <div className="flex flex-col gap-2 rounded-lg border p-3">
              <div className="grid max-h-48 gap-1 overflow-y-auto">
                {(orderDetail.data?.items ?? []).filter((i) => !i.charge).map((i) => (
                  <label key={i.item_id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex items-center gap-2">
                      <input type="checkbox" className="size-4" checked={tItems.includes(i.item_id)} onChange={() => toggleItem(i.item_id)} />
                      {i.qty}× {i.name}
                    </span>
                    <span className="text-xs text-muted-foreground tabular">{baht(i.amount)}</span>
                  </label>
                ))}
                {orderDetail.isLoading && <span className="text-xs text-muted-foreground">{t('dash.loading')}</span>}
                {orderDetail.data && (orderDetail.data.items ?? []).filter((i) => !i.charge).length === 0 && <span className="text-xs text-muted-foreground">{t('px.tbl_no_items_to_transfer')}</span>}
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <Select value={tTo} onValueChange={setTTo}>
                  <SelectTrigger className="w-[200px]"><SelectValue placeholder={t('px.tbl_transfer_to_occupied')} /></SelectTrigger>
                  <SelectContent>
                    {(allTables.data?.tables ?? []).filter((x) => x.id !== tbl.id && ['occupied', 'bill_requested', 'paying'].includes(x.status)).map((x) => <SelectItem key={x.id} value={String(x.id)}>{t('px.tbl_table_label', { no: x.table_no })}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Button disabled={!tItems.length || !tTo || transfer.isPending} onClick={() => transfer.mutate()}>{t('px.tbl_move_n_items', { n: tItems.length })}</Button>
              </div>
            </div>
          )}
        </div>
      )}

      {(tbl.session || sessionId) && tbl.status !== 'cleaning' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <Input className="min-w-[120px] flex-[2]" placeholder={t('px.tbl_food_name')} value={item.name} onChange={(e) => setItem({ ...item, name: e.target.value })} />
            <Input className="w-[70px]" type="number" min={1} step={1} placeholder={t('inv.col_qty')} value={item.qty} onChange={(e) => setItem({ ...item, qty: e.target.value })} />
            <Input className="w-20" type="number" min={0} step="0.01" placeholder={t('px.tbl_price')} value={item.price} onChange={(e) => setItem({ ...item, price: e.target.value })} />
            <Select value={item.station} onValueChange={(v) => setItem({ ...item, station: v })}>
              <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="hot">{t('px.tbl_station_hot')}</SelectItem>
                <SelectItem value="cold">{t('px.tbl_station_cold')}</SelectItem>
                <SelectItem value="drinks">{t('px.tbl_station_drinks')}</SelectItem>
              </SelectContent>
            </Select>
            <Button disabled={!item.name || addItem.isPending} onClick={() => addItem.mutate()}><Plus className="size-4" /> {t('px.tbl_add')}</Button>
          </div>
          {tbl.order && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={() => fire.mutate()} disabled={fire.isPending}><Flame className="size-4" /> {t('px.tbl_fire_all')}</Button>
              <span className="flex items-center gap-1">
                <Input className="w-16" type="number" min={1} step={1} placeholder={t('px.tbl_course')} value={fireCourse} onChange={(e) => setFireCourse(e.target.value)} />
                <Button variant="outline" disabled={!fireCourse || fireCourseM.isPending} onClick={() => fireCourseM.mutate()}><Flame className="size-4" /> {t('px.tbl_fire_course')}</Button>
              </span>
              <Button variant="outline" onClick={() => bill.mutate()} disabled={bill.isPending}><Receipt className="size-4" /> {t('px.tbl_request_bill')}</Button>
              <Button onClick={() => checkout.mutate()} disabled={checkout.isPending}><Wallet className="size-4" /> {t('px.tbl_checkout_cash')} {baht(tbl.order.total)}</Button>
            </div>
          )}
        </div>
      )}
      {tbl.status === 'cleaning' && <Button onClick={() => clear.mutate()} disabled={clear.isPending}><Sparkles className="size-4" /> {t('px.tbl_clear_table')}</Button>}

      {!tbl.session && (
        <Button variant="ghost" size="sm" className="self-start text-destructive hover:bg-destructive/10" onClick={removeTable} disabled={del.isPending}>
          <Trash2 className="size-4" /> {t('px.tbl_delete_this_table')}
        </Button>
      )}
    </Card>
  );
}
