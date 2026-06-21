'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, Badge, StateView } from '@/components/ui';
import { Tabs, Msg } from '@/components/tabs';
import { baht } from '@/lib/format';

type TableRow = {
  id: number; table_no: string; status: string; seats: number; pos_x: number; pos_y: number; width: number; height: number;
  session: { session_no: string; party_size: number; elapsed_min: number } | null;
  order: { order_no: string; status: string; total: number; waited_min: number } | null;
};

const STATUS_TH: Record<string, string> = { available: 'ว่าง', reserved: 'จอง', occupied: 'มีลูกค้า', bill_requested: 'เรียกเก็บเงิน', paying: 'กำลังชำระ', cleaning: 'ทำความสะอาด', out_of_service: 'งดใช้' };
const STATUS_COLOR: Record<string, string> = { available: '#34d399', reserved: '#a78bfa', occupied: '#60a5fa', bill_requested: '#fbbf24', paying: '#f472b6', cleaning: '#9ca3af', out_of_service: '#d1d5db' };

export default function TablesPage() {
  const qc = useQueryClient();
  const board = useQuery<{ tables: TableRow[] }>({ queryKey: ['tables-status'], queryFn: () => api('/api/restaurant/tables/status'), refetchInterval: 4000 });
  const [sel, setSel] = useState<number | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['tables-status'] });

  const tables = board.data?.tables ?? [];
  const selected = tables.find((t) => t.id === sel) ?? null;

  return (
    <div>
      <h1 style={{ marginTop: 0 }}>🍽️ โต๊ะ (Floor plan)</h1>
      <Tabs
        tabs={[
          { key: 'board', label: '📋 สถานะโต๊ะ', content: <Board tables={tables} q={board} onSelect={setSel} sel={sel} /> },
          { key: 'plan', label: '🗺️ ผังร้าน', content: <FloorPlan tables={tables} onSelect={setSel} sel={sel} onAdd={refresh} /> },
        ]}
      />
      {selected && <TablePanel t={selected} onChange={refresh} onClose={() => setSel(null)} />}
    </div>
  );
}

function Board({ tables, q, onSelect, sel }: { tables: TableRow[]; q: any; onSelect: (id: number) => void; sel: number | null }) {
  return (
    <StateView q={q}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
        {tables.length === 0 && <p className="label">ยังไม่มีโต๊ะ — เพิ่มในแท็บ “ผังร้าน”</p>}
        {tables.map((t) => (
          <button key={t.id} onClick={() => onSelect(t.id)} style={{ textAlign: 'left', border: sel === t.id ? '2px solid var(--navy)' : '0.5px solid var(--border)', borderLeft: `6px solid ${STATUS_COLOR[t.status]}`, borderRadius: 8, padding: 10, background: 'var(--bg, #fff)', cursor: 'pointer' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><strong>โต๊ะ {t.table_no}</strong><span className="label">{t.seats} ที่</span></div>
            <div style={{ fontSize: 13, color: STATUS_COLOR[t.status], fontWeight: 600 }}>{STATUS_TH[t.status]}</div>
            {t.order && <div className="label" style={{ fontSize: 12 }}>{baht(t.order.total)} · รอ {t.order.waited_min}′</div>}
          </button>
        ))}
      </div>
    </StateView>
  );
}

function FloorPlan({ tables, onSelect, sel, onAdd }: { tables: TableRow[]; onSelect: (id: number) => void; sel: number | null; onAdd: () => void }) {
  const [no, setNo] = useState('');
  const add = useMutation({ mutationFn: () => api('/api/restaurant/tables', { method: 'POST', body: JSON.stringify({ table_no: no, pos_x: 20 + ((tables.length % 5) * 120), pos_y: 20 + Math.floor(tables.length / 5) * 110 }) }), onSuccess: () => { setNo(''); onAdd(); } });
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input className="input" placeholder="เลขโต๊ะ เช่น A1" value={no} onChange={(e) => setNo(e.target.value)} style={{ maxWidth: 180 }} />
        <button className="btn" disabled={!no || add.isPending} onClick={() => add.mutate()}>+ เพิ่มโต๊ะ</button>
      </div>
      <div style={{ position: 'relative', height: 420, border: '0.5px dashed var(--border)', borderRadius: 8, background: 'var(--bg-soft, #f8fafc)', overflow: 'hidden' }}>
        {tables.map((t) => (
          <button key={t.id} onClick={() => onSelect(t.id)} title={STATUS_TH[t.status]}
            style={{ position: 'absolute', left: t.pos_x, top: t.pos_y, width: t.width, height: t.height, borderRadius: t.width === t.height ? '50%' : 8, background: STATUS_COLOR[t.status], color: '#1a1a1a', border: sel === t.id ? '3px solid var(--navy)' : '0', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
            {t.table_no}<div style={{ fontSize: 10, fontWeight: 400 }}>{STATUS_TH[t.status]}</div>
          </button>
        ))}
      </div>
      <p className="label" style={{ fontSize: 12, marginTop: 6 }}>แตะโต๊ะเพื่อจัดการ · สีบอกสถานะ</p>
    </div>
  );
}

function TablePanel({ t, onChange, onClose }: { t: TableRow; onChange: () => void; onClose: () => void }) {
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
    <Card style={{ marginTop: 16, borderTop: `4px solid ${STATUS_COLOR[t.status]}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>โต๊ะ {t.table_no} · <Badge value={STATUS_TH[t.status]} /></h3>
        <button className="btn" style={{ padding: '4px 10px' }} onClick={onClose}>✕</button>
      </div>
      <Msg ok={!msg.startsWith('❌')}>{msg}</Msg>

      {t.status === 'available' && <button className="btn" onClick={() => open.mutate()} disabled={open.isPending}>🪑 เปิดโต๊ะ (รับลูกค้า)</button>}
      {qr && <div className="label" style={{ marginTop: 8 }}>QR ลูกค้า: <a href={qr} target="_blank" style={{ color: 'var(--navy)' }}>{qr}</a></div>}

      {(t.session || sessionId) && t.status !== 'cleaning' && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <input className="input" placeholder="ชื่ออาหาร" value={item.name} onChange={(e) => setItem({ ...item, name: e.target.value })} style={{ flex: 2, minWidth: 120 }} />
            <input className="input" type="number" placeholder="จำนวน" value={item.qty} onChange={(e) => setItem({ ...item, qty: e.target.value })} style={{ width: 70 }} />
            <input className="input" type="number" placeholder="ราคา" value={item.price} onChange={(e) => setItem({ ...item, price: e.target.value })} style={{ width: 80 }} />
            <select className="input" value={item.station} onChange={(e) => setItem({ ...item, station: e.target.value })} style={{ width: 110 }}>
              <option value="hot">ครัวร้อน</option><option value="cold">ครัวเย็น</option><option value="drinks">เครื่องดื่ม</option>
            </select>
            <button className="btn" disabled={!item.name || addItem.isPending} onClick={() => addItem.mutate()}>+ เพิ่ม</button>
          </div>
          {t.order && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <button className="btn" onClick={() => fire.mutate()} disabled={fire.isPending}>🔥 ส่งเข้าครัว</button>
              <button className="btn" onClick={() => bill.mutate()} disabled={bill.isPending}>🧾 เรียกเก็บเงิน</button>
              <button className="btn" style={{ background: 'var(--navy)' }} onClick={() => checkout.mutate()} disabled={checkout.isPending}>💵 เช็คบิล (เงินสด) {baht(t.order.total)}</button>
            </div>
          )}
        </div>
      )}
      {t.status === 'cleaning' && <button className="btn" style={{ marginTop: 10 }} onClick={() => clear.mutate()} disabled={clear.isPending}>🧹 เคลียร์โต๊ะแล้ว (พร้อมรับลูกค้า)</button>}
    </Card>
  );
}
