'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Armchair, Flame, Plus, Receipt, Sparkles, Utensils, Wallet, X } from 'lucide-react';
import { api } from '@/lib/api';
import { DineInOrderDialog } from '@/components/dine-in-order-dialog';
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

type TableRow = {
  id: number; table_no: string; status: string; seats: number; pos_x: number; pos_y: number; width: number; height: number;
  session: { session_no: string; party_size: number; elapsed_min: number } | null;
  order: { order_no: string; status: string; total: number; waited_min: number } | null;
};

const STATUS_TH: Record<string, string> = { available: 'ว่าง', reserved: 'จอง', occupied: 'มีลูกค้า', bill_requested: 'เรียกเก็บเงิน', paying: 'กำลังชำระ', cleaning: 'ทำความสะอาด', out_of_service: 'งดใช้' };

// Status → token classes. text = label color, border = left/top accent, dot = floor-plan fill, bar = panel top accent.
const STATUS_TONE: Record<string, { text: string; border: string; fill: string; bar: string }> = {
  available: { text: 'text-success', border: 'border-l-success', fill: 'bg-success text-success-foreground', bar: 'border-t-success' },
  reserved: { text: 'text-info', border: 'border-l-info', fill: 'bg-info text-info-foreground', bar: 'border-t-info' },
  occupied: { text: 'text-info', border: 'border-l-info', fill: 'bg-info text-info-foreground', bar: 'border-t-info' },
  bill_requested: { text: 'text-warning-foreground dark:text-warning', border: 'border-l-warning', fill: 'bg-warning text-warning-foreground', bar: 'border-t-warning' },
  paying: { text: 'text-warning-foreground dark:text-warning', border: 'border-l-warning', fill: 'bg-warning text-warning-foreground', bar: 'border-t-warning' },
  cleaning: { text: 'text-muted-foreground', border: 'border-l-muted-foreground', fill: 'bg-muted text-muted-foreground', bar: 'border-t-muted-foreground' },
  out_of_service: { text: 'text-muted-foreground', border: 'border-l-muted', fill: 'bg-muted text-muted-foreground', bar: 'border-t-muted' },
};
const tone = (s: string) => STATUS_TONE[s] ?? STATUS_TONE.out_of_service;

export default function TablesPage() {
  const qc = useQueryClient();
  const board = useQuery<{ tables: TableRow[] }>({ queryKey: ['tables-status'], queryFn: () => api('/api/restaurant/tables/status'), refetchInterval: 4000 });
  const [sel, setSel] = useState<number | null>(null);
  const [orderTable, setOrderTable] = useState<number | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['tables-status'] });

  const tables = board.data?.tables ?? [];
  const selected = tables.find((t) => t.id === sel) ?? null;
  const ordering = tables.find((t) => t.id === orderTable) ?? null;

  return (
    <div>
      <PageHeader title="โต๊ะ (Floor plan)" description="สถานะโต๊ะแบบเรียลไทม์และผังร้าน" />
      <Tabs
        tabs={[
          { key: 'board', label: 'สถานะโต๊ะ', content: <Board tables={tables} q={board} onSelect={setSel} sel={sel} onOrder={setOrderTable} /> },
          { key: 'plan', label: 'ผังร้าน', content: <FloorPlan tables={tables} onSelect={setSel} sel={sel} onAdd={refresh} /> },
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

function Board({ tables, q, onSelect, sel, onOrder }: { tables: TableRow[]; q: any; onSelect: (id: number) => void; sel: number | null; onOrder: (id: number) => void }) {
  return (
    <StateView q={q}>
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
        {tables.length === 0 && <p className="text-sm text-muted-foreground">ยังไม่มีโต๊ะ — เพิ่มในแท็บ “ผังร้าน”</p>}
        {tables.map((t) => (
          <div
            key={t.id}
            className={cn(
              'rounded-lg border border-l-[6px] bg-card transition-colors',
              tone(t.status).border,
              sel === t.id && 'ring-2 ring-primary',
            )}
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
        ))}
      </div>
    </StateView>
  );
}

function FloorPlan({ tables, onSelect, sel, onAdd }: { tables: TableRow[]; onSelect: (id: number) => void; sel: number | null; onAdd: () => void }) {
  const [no, setNo] = useState('');
  const add = useMutation({ mutationFn: () => api('/api/restaurant/tables', { method: 'POST', body: JSON.stringify({ table_no: no, pos_x: 20 + ((tables.length % 5) * 120), pos_y: 20 + Math.floor(tables.length / 5) * 110 }) }), onSuccess: () => { setNo(''); onAdd(); } });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-[180px]" placeholder="เลขโต๊ะ เช่น A1" value={no} onChange={(e) => setNo(e.target.value)} />
        <Button disabled={!no || add.isPending} onClick={() => add.mutate()}>
          <Plus className="size-4" /> เพิ่มโต๊ะ
        </Button>
      </div>
      <div className="relative h-[420px] overflow-hidden rounded-lg border border-dashed bg-muted/40">
        {tables.map((t) => (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            title={STATUS_TH[t.status]}
            className={cn(
              'absolute flex flex-col items-center justify-center text-[13px] font-bold',
              tone(t.status).fill,
              sel === t.id && 'ring-[3px] ring-primary',
            )}
            style={{ left: t.pos_x, top: t.pos_y, width: t.width, height: t.height, borderRadius: t.width === t.height ? '50%' : 8 }}
          >
            {t.table_no}
            <div className="text-[10px] font-normal">{STATUS_TH[t.status]}</div>
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">แตะโต๊ะเพื่อจัดการ · สีบอกสถานะ</p>
    </div>
  );
}

function TablePanel({ t, onChange, onClose, onOrder }: { t: TableRow; onChange: () => void; onClose: () => void; onOrder: () => void }) {
  const [msg, setMsg] = useState('');
  const [qr, setQr] = useState('');
  const [item, setItem] = useState({ name: '', qty: '1', price: '', station: 'hot' });
  const [sessionId, setSessionId] = useState<number | null>(null);

  const open = useMutation({ mutationFn: () => api<{ session_id: number; public_token: string }>(`/api/restaurant/tables/${t.id}/open`, { method: 'POST', body: '{}' }), onSuccess: (r) => { setSessionId(r.session_id); setQr(`/qr/${r.public_token}`); setMsg('เปิดโต๊ะแล้ว'); onChange(); } });
  const addItem = useMutation({
    mutationFn: async () => {
      const items = [{ name: item.name, qty: Number(item.qty) || 1, unit_price: Number(item.price) || 0, station_code: item.station }];
      if (t.order) return api(`/api/restaurant/orders/${t.order.order_no}/items`, { method: 'POST', body: JSON.stringify({ items }) });
      return api('/api/restaurant/orders', { method: 'POST', body: JSON.stringify({ table_id: t.id, session_id: sessionId ?? undefined, items }) });
    },
    onSuccess: () => { setItem({ ...item, name: '', price: '' }); setMsg('เพิ่มรายการแล้ว'); onChange(); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const fire = useMutation({ mutationFn: () => api(`/api/restaurant/orders/${t.order!.order_no}/fire`, { method: 'POST', body: '{}' }), onSuccess: () => { setMsg('ส่งเข้าครัวแล้ว'); onChange(); } });
  const bill = useMutation({ mutationFn: () => api(`/api/restaurant/orders/${t.order!.order_no}/bill`, { method: 'POST', body: '{}' }), onSuccess: () => { setMsg('เรียกเก็บเงินแล้ว'); onChange(); } });
  const checkout = useMutation({ mutationFn: () => api<{ tax_invoice_no: string }>(`/api/restaurant/orders/${t.order!.order_no}/checkout`, { method: 'POST', body: JSON.stringify({ method: 'Cash' }) }), onSuccess: (r) => { setMsg(`ชำระเงินสำเร็จ · ใบกำกับภาษี ${r.tax_invoice_no ?? '-'}`); onChange(); } });
  const clear = useMutation({ mutationFn: () => api(`/api/restaurant/tables/${t.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'available' }) }), onSuccess: () => { setMsg('เคลียร์โต๊ะแล้ว'); onClose(); onChange(); } });

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

      {(t.session || sessionId) && t.status !== 'cleaning' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <Input className="min-w-[120px] flex-[2]" placeholder="ชื่ออาหาร" value={item.name} onChange={(e) => setItem({ ...item, name: e.target.value })} />
            <Input className="w-[70px]" type="number" placeholder="จำนวน" value={item.qty} onChange={(e) => setItem({ ...item, qty: e.target.value })} />
            <Input className="w-20" type="number" placeholder="ราคา" value={item.price} onChange={(e) => setItem({ ...item, price: e.target.value })} />
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
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => fire.mutate()} disabled={fire.isPending}><Flame className="size-4" /> ส่งเข้าครัว</Button>
              <Button variant="outline" onClick={() => bill.mutate()} disabled={bill.isPending}><Receipt className="size-4" /> เรียกเก็บเงิน</Button>
              <Button onClick={() => checkout.mutate()} disabled={checkout.isPending}><Wallet className="size-4" /> เช็คบิล (เงินสด) {baht(t.order.total)}</Button>
            </div>
          )}
        </div>
      )}
      {t.status === 'cleaning' && <Button onClick={() => clear.mutate()} disabled={clear.isPending}><Sparkles className="size-4" /> เคลียร์โต๊ะแล้ว (พร้อมรับลูกค้า)</Button>}
    </Card>
  );
}
