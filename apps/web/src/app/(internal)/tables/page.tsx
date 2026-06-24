'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Armchair, ArrowLeftRight, Flame, Plus, QrCode, Receipt, Sparkles, Split, Trash2, Utensils, Wallet, X } from 'lucide-react';
import { api } from '@/lib/api';
import { DineInOrderDialog } from '@/components/dine-in-order-dialog';
import { FloorPlan, STATUS_TH, tone, type TableRow, type ZoneRow } from '@/components/floor-plan';
import { cn } from '@/lib/utils';
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
  const qc = useQueryClient();
  const board = useQuery<{ tables: TableRow[] }>({ queryKey: ['tables-status'], queryFn: () => api('/api/restaurant/tables/status'), refetchInterval: 4000 });
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
      <PageHeader title="โต๊ะ (Floor plan)" description="สถานะโต๊ะแบบเรียลไทม์และผังร้าน" />
      <Tabs
        tabs={[
          { key: 'board', label: 'สถานะโต๊ะ', content: <Board tables={tables} zones={zones} q={board} onSelect={setSel} sel={sel} onOrder={setOrderTable} /> },
          { key: 'plan', label: 'ผังร้าน', content: <FloorPlan tables={tables} zones={zones} onSelect={setSel} sel={sel} onChange={refresh} onZonesChange={refreshZones} /> },
          { key: 'revenue', label: 'รายได้ต่อห้อง', content: <RoomRevenue /> },
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
  const [room, setRoom] = useState<number | 'all' | 'none'>('all');
  const busy = (ts: TableRow[]) => ts.filter((t) => ['occupied', 'bill_requested', 'paying'].includes(t.status)).length;
  const chip = (active: boolean) => cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors', active ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-accent');

  const card = (t: TableRow) => (
    <div
      key={t.id}
      className={cn('rounded-lg border border-l-[6px] bg-card transition-colors', tone(t.status).border, sel === t.id && 'ring-2 ring-primary')}
    >
      <button onClick={() => onSelect(t.id)} className="w-full rounded-t-lg p-2.5 text-left hover:bg-accent">
        <div className="flex items-center justify-between">
          <strong>โต๊ะ {t.table_no}</strong>
          <span className="text-sm text-muted-foreground">{t.seats} ที่</span>
        </div>
        <div className={cn('text-sm font-semibold', tone(t.status).text)}>{STATUS_TH[t.status]}</div>
        {t.order && <div className="text-xs text-muted-foreground tabular">{baht(t.order.total)} · รอ {t.order.waited_min}′</div>}
      </button>
      <div className="px-2.5 pb-2.5">
        <Button variant="outline" size="sm" className="w-full" onClick={() => onOrder(t.id)}>
          <Utensils className="size-4" /> สั่งอาหาร
        </Button>
      </div>
    </div>
  );

  // No rooms defined → keep the simple flat grid (unchanged for shops without rooms).
  if (zones.length === 0) {
    return (
      <StateView q={q}>
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
          {tables.length === 0 && <p className="text-sm text-muted-foreground">ยังไม่มีโต๊ะ — เพิ่มในแท็บ “ผังร้าน”</p>}
          {tables.map(card)}
        </div>
      </StateView>
    );
  }

  // Rooms exist → group tables by room, with a filter + per-room occupancy.
  const sections: { key: number | 'none'; name: string; color: string | null; tables: TableRow[] }[] = [
    ...zones.map((z) => ({ key: z.id as number | 'none', name: z.name, color: z.color, tables: tables.filter((t) => t.zone_id === z.id) })),
    { key: 'none' as const, name: 'ไม่มีห้อง', color: null as string | null, tables: tables.filter((t) => t.zone_id == null) },
  ].filter((s) => s.tables.length > 0);
  const shown = room === 'all' ? sections : sections.filter((s) => s.key === room);

  return (
    <StateView q={q}>
      <div className="mb-3 flex flex-wrap gap-2">
        <button onClick={() => setRoom('all')} className={chip(room === 'all')}>ทั้งหมด ({tables.length})</button>
        {sections.map((s) => (
          <button key={String(s.key)} onClick={() => setRoom(s.key)} className={chip(room === s.key)}>
            {s.color && <span className="size-2 rounded-full" style={{ background: s.color }} />}
            {s.name} · {busy(s.tables)}/{s.tables.length}
          </button>
        ))}
      </div>
      {tables.length === 0 && <p className="text-sm text-muted-foreground">ยังไม่มีโต๊ะ — เพิ่มในแท็บ “ผังร้าน”</p>}
      <div className="space-y-4">
        {shown.map((s) => (
          <section key={String(s.key)}>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              {s.color && <span className="size-2.5 rounded-full" style={{ background: s.color }} />}
              {s.name}
              <span className="font-normal text-muted-foreground">· {busy(s.tables)}/{s.tables.length} โต๊ะมีลูกค้า</span>
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

type RevRoom = { zone_id: number; name: string; color: string | null; revenue: number; sales: number; avg_sale: number };

function RoomRevenue() {
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
    { zone_id: 0, name: 'ไม่มีห้อง', color: null, revenue: unzoned.revenue, sales: unzoned.sales, avg_sale: unzoned.sales ? unzoned.revenue / unzoned.sales : 0 },
  ].filter((r) => r.zone_id !== 0 || r.sales > 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">ตั้งแต่ <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="mt-1 w-[170px]" /></label>
        <label className="text-sm">ถึง <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="mt-1 w-[170px]" /></label>
      </div>
      <StateView q={q}>
        {q.data && (
          <>
            <div className="flex flex-wrap gap-3">
              <div className="rounded-lg border bg-card p-3"><div className="text-xs text-muted-foreground">รายได้รวม</div><div className="text-2xl font-semibold tabular">{baht(q.data.total.revenue)}</div></div>
              <div className="rounded-lg border bg-card p-3"><div className="text-xs text-muted-foreground">จำนวนบิล</div><div className="text-2xl font-semibold tabular">{q.data.total.sales}</div></div>
            </div>
            <div className="space-y-2">
              {q.data.total.sales === 0 && <p className="text-sm text-muted-foreground">ยังไม่มีรายได้ในช่วงนี้</p>}
              {rows.map((r) => (
                <div key={r.zone_id} className="rounded-lg border bg-card p-3">
                  <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="flex items-center gap-2 font-medium">{r.color && <span className="size-2.5 rounded-full" style={{ background: r.color }} />}{r.name}</span>
                    <span className="text-muted-foreground tabular">{baht(r.revenue)} · {r.sales} บิล · เฉลี่ย {baht(r.avg_sale)}</span>
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

function TablePanel({ t, onChange, onClose, onOrder }: { t: TableRow; onChange: () => void; onClose: () => void; onOrder: () => void }) {
  const [msg, setMsg] = useState('');
  const [qr, setQr] = useState('');
  const [sticker, setSticker] = useState<{ url: string; qr_image: string } | null>(null);
  const [item, setItem] = useState({ name: '', qty: '1', price: '', station: 'hot' });
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [buffetOpen, setBuffetOpen] = useState(false);
  const [bPkg, setBPkg] = useState('');
  const [bPax, setBPax] = useState('2');

  const onErr = (e: any) => setMsg(`❌ ${e.message}`);
  const printQr = useMutation({ mutationFn: () => api<{ url: string; qr_image: string }>(`/api/restaurant/tables/${t.id}/qr?base=${encodeURIComponent(typeof window !== 'undefined' ? window.location.origin : '')}`), onSuccess: setSticker, onError: onErr });
  const tiers = useQuery<{ packages: { id: number; name: string; price_per_pax: number }[] }>({ queryKey: ['buffet-packages'], queryFn: () => api('/api/restaurant/buffet/packages'), enabled: buffetOpen });
  const startBuffet = useMutation({ mutationFn: () => api(`/api/restaurant/tables/${t.id}/buffet`, { method: 'POST', body: JSON.stringify({ package_id: Number(bPkg), pax: Number(bPax) || 1 }) }), onSuccess: () => { setMsg('เริ่มบุฟเฟต์แล้ว'); setBuffetOpen(false); onChange(); }, onError: onErr });
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTo, setMoveTo] = useState('');
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeFrom, setMergeFrom] = useState('');
  const [transferOpen, setTransferOpen] = useState(false);
  const [tItems, setTItems] = useState<number[]>([]);
  const [tTo, setTTo] = useState('');
  const allTables = useQuery<{ tables: { id: number; table_no: string; status: string }[] }>({ queryKey: ['tables-list'], queryFn: () => api('/api/restaurant/tables'), enabled: moveOpen || mergeOpen || transferOpen });
  const orderDetail = useQuery<{ items: { item_id: number; name: string; qty: number; amount: number; charge: boolean }[] }>({ queryKey: ['order-detail', t.order?.order_no], queryFn: () => api(`/api/restaurant/orders/${t.order!.order_no}`), enabled: transferOpen && !!t.order });
  const move = useMutation({ mutationFn: () => api(`/api/restaurant/tables/${t.id}/move`, { method: 'POST', body: JSON.stringify({ to_table_id: Number(moveTo) }) }), onSuccess: () => { setMsg('ย้ายโต๊ะแล้ว'); setMoveOpen(false); onClose(); onChange(); }, onError: onErr });
  const merge = useMutation({ mutationFn: () => api(`/api/restaurant/tables/${t.id}/merge`, { method: 'POST', body: JSON.stringify({ from_table_id: Number(mergeFrom) }) }), onSuccess: () => { setMsg('รวมโต๊ะแล้ว'); setMergeOpen(false); onChange(); }, onError: onErr });
  const transfer = useMutation({ mutationFn: () => api(`/api/restaurant/orders/${t.order!.order_no}/transfer-items`, { method: 'POST', body: JSON.stringify({ item_ids: tItems, to_table_id: Number(tTo) }) }), onSuccess: () => { setMsg('ย้ายรายการแล้ว'); setTransferOpen(false); setTItems([]); setTTo(''); onChange(); }, onError: onErr });
  const toggleItem = (id: number) => setTItems((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const open = useMutation({ mutationFn: () => api<{ session_id: number; public_token: string }>(`/api/restaurant/tables/${t.id}/open`, { method: 'POST', body: '{}' }), onSuccess: (r) => { setSessionId(r.session_id); setQr(`/qr/${r.public_token}`); setMsg('เปิดโต๊ะแล้ว'); onChange(); }, onError: onErr });
  const addItem = useMutation({
    mutationFn: async () => {
      const items = [{ name: item.name, qty: Number(item.qty) || 1, unit_price: Number(item.price) || 0, station_code: item.station }];
      if (t.order) return api(`/api/restaurant/orders/${t.order.order_no}/items`, { method: 'POST', body: JSON.stringify({ items }) });
      return api('/api/restaurant/orders', { method: 'POST', body: JSON.stringify({ table_id: t.id, session_id: sessionId ?? undefined, items }) });
    },
    onSuccess: () => { setItem({ ...item, name: '', price: '' }); setMsg('เพิ่มรายการแล้ว'); onChange(); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const fire = useMutation({ mutationFn: () => api(`/api/restaurant/orders/${t.order!.order_no}/fire`, { method: 'POST', body: '{}' }), onSuccess: () => { setMsg('ส่งเข้าครัวแล้ว'); onChange(); }, onError: onErr });
  const [fireCourse, setFireCourse] = useState('');
  const fireCourseM = useMutation({ mutationFn: () => api(`/api/restaurant/orders/${t.order!.order_no}/fire?course=${Number(fireCourse)}`, { method: 'POST', body: '{}' }), onSuccess: () => { setMsg(`ส่งครัวคอร์ส ${fireCourse} แล้ว`); setFireCourse(''); onChange(); }, onError: onErr });
  const bill = useMutation({ mutationFn: () => api(`/api/restaurant/orders/${t.order!.order_no}/bill`, { method: 'POST', body: '{}' }), onSuccess: () => { setMsg('เรียกเก็บเงินแล้ว'); onChange(); }, onError: onErr });
  const checkout = useMutation({ mutationFn: () => api<{ tax_invoice_no: string }>(`/api/restaurant/orders/${t.order!.order_no}/checkout`, { method: 'POST', body: JSON.stringify({ method: 'Cash' }) }), onSuccess: (r) => { setMsg(`ชำระเงินสำเร็จ · ใบกำกับภาษี ${r.tax_invoice_no ?? '-'}`); onChange(); }, onError: onErr });
  const clear = useMutation({ mutationFn: () => api(`/api/restaurant/tables/${t.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'available' }) }), onSuccess: () => { setMsg('เคลียร์โต๊ะแล้ว'); onClose(); onChange(); }, onError: onErr });
  const del = useMutation({ mutationFn: () => api(`/api/restaurant/tables/${t.id}`, { method: 'DELETE' }), onSuccess: () => { onClose(); onChange(); }, onError: onErr });
  const removeTable = () => { if (typeof window !== 'undefined' && !window.confirm(`ลบโต๊ะ ${t.table_no}? ประวัติการขายยังอยู่ครบ`)) return; del.mutate(); };

  return (
    <Card className={cn('mt-4 gap-4 border-t-4 p-5', tone(t.status).bar)}>
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-lg font-semibold">โต๊ะ {t.table_no} · <Badge variant={statusVariant(STATUS_TH[t.status])}>{STATUS_TH[t.status]}</Badge></h3>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={onOrder}><Utensils className="size-4" /> สั่งอาหาร</Button>
          <Button variant="ghost" size="icon" onClick={onClose}><X className="size-4" /></Button>
        </div>
      </div>
      <Msg ok={!msg.startsWith('❌')}>{msg}</Msg>

      {t.status === 'available' && <Button onClick={() => open.mutate()} disabled={open.isPending}><Armchair className="size-4" /> เปิดโต๊ะ (รับลูกค้า)</Button>}
      {qr && <div className="text-sm text-muted-foreground">QR ลูกค้า: <a href={qr} target="_blank" className="text-primary hover:underline">{qr}</a></div>}

      <div>
        <Button variant="outline" size="sm" onClick={() => printQr.mutate()} disabled={printQr.isPending}><QrCode className="size-4" /> QR ติดโต๊ะ (สำหรับพิมพ์)</Button>
        {sticker && (
          <div className="mt-2 flex items-center gap-3 rounded-lg border p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={sticker.qr_image} alt={`QR โต๊ะ ${t.table_no}`} className="size-28 rounded bg-white p-1" />
            <div className="min-w-0 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">สแกนเพื่อสั่งอาหาร — โต๊ะ {t.table_no}</p>
              <p className="break-all">{sticker.url}</p>
              <p className="mt-1">พิมพ์สติกเกอร์นี้ติดที่โต๊ะ — ลูกค้าสแกนเพื่อเปิดเซสชันและสั่งอาหารเอง</p>
            </div>
          </div>
        )}
      </div>

      {!t.order && t.status !== 'cleaning' && (
        <div>
          <Button variant="outline" size="sm" onClick={() => setBuffetOpen((v) => !v)}><Utensils className="size-4" /> เริ่มบุฟเฟต์</Button>
          {buffetOpen && (
            <div className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border p-3">
              <Select value={bPkg} onValueChange={setBPkg}>
                <SelectTrigger className="w-[200px]"><SelectValue placeholder="เลือกแพ็กเกจบุฟเฟต์" /></SelectTrigger>
                <SelectContent>
                  {(tiers.data?.packages ?? []).map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name} · {baht(p.price_per_pax)}/ท่าน</SelectItem>)}
                </SelectContent>
              </Select>
              <Input className="w-[90px]" type="number" min={1} step={1} placeholder="จำนวนคน" value={bPax} onChange={(e) => setBPax(e.target.value)} />
              <Button disabled={!bPkg || startBuffet.isPending} onClick={() => startBuffet.mutate()}>เริ่ม</Button>
            </div>
          )}
        </div>
      )}

      {(t.session || sessionId) && t.status !== 'cleaning' && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => { setMoveOpen((v) => !v); setMergeOpen(false); setTransferOpen(false); }}><ArrowLeftRight className="size-4" /> ย้ายโต๊ะ</Button>
            <Button variant="outline" size="sm" onClick={() => { setMergeOpen((v) => !v); setMoveOpen(false); setTransferOpen(false); }}><Sparkles className="size-4" /> รวมโต๊ะ</Button>
            {t.order && <Button variant="outline" size="sm" onClick={() => { setTransferOpen((v) => !v); setMoveOpen(false); setMergeOpen(false); }}><Split className="size-4" /> ย้ายรายการ</Button>}
          </div>
          {moveOpen && (
            <div className="flex flex-wrap items-end gap-2 rounded-lg border p-3">
              <Select value={moveTo} onValueChange={setMoveTo}>
                <SelectTrigger className="w-[200px]"><SelectValue placeholder="ย้ายไปโต๊ะว่าง…" /></SelectTrigger>
                <SelectContent>
                  {(allTables.data?.tables ?? []).filter((x) => x.id !== t.id && x.status === 'available').map((x) => <SelectItem key={x.id} value={String(x.id)}>โต๊ะ {x.table_no}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button disabled={!moveTo || move.isPending} onClick={() => move.mutate()}>ย้าย</Button>
            </div>
          )}
          {mergeOpen && (
            <div className="flex flex-wrap items-end gap-2 rounded-lg border p-3">
              <Select value={mergeFrom} onValueChange={setMergeFrom}>
                <SelectTrigger className="w-[220px]"><SelectValue placeholder="รวมโต๊ะอื่นเข้าโต๊ะนี้…" /></SelectTrigger>
                <SelectContent>
                  {(allTables.data?.tables ?? []).filter((x) => x.id !== t.id && ['occupied', 'bill_requested', 'paying'].includes(x.status)).map((x) => <SelectItem key={x.id} value={String(x.id)}>โต๊ะ {x.table_no}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button disabled={!mergeFrom || merge.isPending} onClick={() => merge.mutate()}>รวม</Button>
            </div>
          )}
          {transferOpen && t.order && (
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
                {orderDetail.isLoading && <span className="text-xs text-muted-foreground">กำลังโหลด…</span>}
                {orderDetail.data && (orderDetail.data.items ?? []).filter((i) => !i.charge).length === 0 && <span className="text-xs text-muted-foreground">ไม่มีรายการให้ย้าย</span>}
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <Select value={tTo} onValueChange={setTTo}>
                  <SelectTrigger className="w-[200px]"><SelectValue placeholder="ย้ายไปโต๊ะที่มีลูกค้า…" /></SelectTrigger>
                  <SelectContent>
                    {(allTables.data?.tables ?? []).filter((x) => x.id !== t.id && ['occupied', 'bill_requested', 'paying'].includes(x.status)).map((x) => <SelectItem key={x.id} value={String(x.id)}>โต๊ะ {x.table_no}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Button disabled={!tItems.length || !tTo || transfer.isPending} onClick={() => transfer.mutate()}>ย้าย {tItems.length} รายการ</Button>
              </div>
            </div>
          )}
        </div>
      )}

      {(t.session || sessionId) && t.status !== 'cleaning' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <Input className="min-w-[120px] flex-[2]" placeholder="ชื่ออาหาร" value={item.name} onChange={(e) => setItem({ ...item, name: e.target.value })} />
            <Input className="w-[70px]" type="number" min={1} step={1} placeholder="จำนวน" value={item.qty} onChange={(e) => setItem({ ...item, qty: e.target.value })} />
            <Input className="w-20" type="number" min={0} step="0.01" placeholder="ราคา" value={item.price} onChange={(e) => setItem({ ...item, price: e.target.value })} />
            <Select value={item.station} onValueChange={(v) => setItem({ ...item, station: v })}>
              <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="hot">ครัวร้อน</SelectItem>
                <SelectItem value="cold">ครัวเย็น</SelectItem>
                <SelectItem value="drinks">เครื่องดื่ม</SelectItem>
              </SelectContent>
            </Select>
            <Button disabled={!item.name || addItem.isPending} onClick={() => addItem.mutate()}><Plus className="size-4" /> เพิ่ม</Button>
          </div>
          {t.order && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={() => fire.mutate()} disabled={fire.isPending}><Flame className="size-4" /> ส่งเข้าครัว (ทั้งหมด)</Button>
              <span className="flex items-center gap-1">
                <Input className="w-16" type="number" min={1} step={1} placeholder="คอร์ส" value={fireCourse} onChange={(e) => setFireCourse(e.target.value)} />
                <Button variant="outline" disabled={!fireCourse || fireCourseM.isPending} onClick={() => fireCourseM.mutate()}><Flame className="size-4" /> ส่งคอร์ส</Button>
              </span>
              <Button variant="outline" onClick={() => bill.mutate()} disabled={bill.isPending}><Receipt className="size-4" /> เรียกเก็บเงิน</Button>
              <Button onClick={() => checkout.mutate()} disabled={checkout.isPending}><Wallet className="size-4" /> เช็คบิล (เงินสด) {baht(t.order.total)}</Button>
            </div>
          )}
        </div>
      )}
      {t.status === 'cleaning' && <Button onClick={() => clear.mutate()} disabled={clear.isPending}><Sparkles className="size-4" /> เคลียร์โต๊ะแล้ว (พร้อมรับลูกค้า)</Button>}

      {!t.session && (
        <Button variant="ghost" size="sm" className="self-start text-destructive hover:bg-destructive/10" onClick={removeTable} disabled={del.isPending}>
          <Trash2 className="size-4" /> ลบโต๊ะนี้
        </Button>
      )}
    </Card>
  );
}
