'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, DataTable, Badge, StateView } from '@/components/ui';
import { Tabs, Msg } from '@/components/tabs';
import { baht, num, thaiDate } from '@/lib/format';

interface Line { item_id: string; qty: number; unit_price: number; discount_pct: number }
const VAT = 0.07;

function NewSale() {
  const qc = useQueryClient();
  const [lines, setLines] = useState<Line[]>([{ item_id: '', qty: 1, unit_price: 0, discount_pct: 0 }]);
  const [payment, setPayment] = useState('Cash');
  const setLine = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const subtotal = lines.reduce((a, l) => a + Number(l.qty) * Number(l.unit_price) * (1 - Number(l.discount_pct) / 100), 0);
  const vat = subtotal * VAT;
  const total = subtotal + vat;

  const mut = useMutation({
    mutationFn: () => api<{ sale_no: string; total: number; points_earned: number }>('/api/portal/pos/sales', {
      method: 'POST',
      body: JSON.stringify({ payment_method: payment, items: lines.filter((l) => l.item_id).map((l) => ({ item_id: l.item_id, qty: Number(l.qty), unit_price: Number(l.unit_price), discount_pct: Number(l.discount_pct) })) }),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['portal-sales'] }); setLines([{ item_id: '', qty: 1, unit_price: 0, discount_pct: 0 }]); },
  });

  return (
    <Card style={{ maxWidth: 720 }}>
      <h3 style={{ marginTop: 0 }}>ขายสินค้า</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr auto', gap: 8, fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
        <span>รหัสสินค้า</span><span>จำนวน</span><span>ราคา/หน่วย</span><span>ส่วนลด %</span><span></span>
      </div>
      {lines.map((l, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr auto', gap: 8, marginBottom: 8 }}>
          <input className="input" placeholder="Item ID" value={l.item_id} onChange={(e) => setLine(i, { item_id: e.target.value })} />
          <input className="input" type="number" value={l.qty} onChange={(e) => setLine(i, { qty: +e.target.value })} />
          <input className="input" type="number" value={l.unit_price} onChange={(e) => setLine(i, { unit_price: +e.target.value })} />
          <input className="input" type="number" value={l.discount_pct} onChange={(e) => setLine(i, { discount_pct: +e.target.value })} />
          <button className="btn" style={{ background: 'var(--ruby)' }} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button className="btn" style={{ background: '#64748b' }} onClick={() => setLines((ls) => [...ls, { item_id: '', qty: 1, unit_price: 0, discount_pct: 0 }])}>+ เพิ่มรายการ</button>

      <div style={{ marginTop: 16, display: 'flex', gap: 24, alignItems: 'center' }}>
        <label className="label">การชำระเงิน
          <select className="input" value={payment} onChange={(e) => setPayment(e.target.value)}>
            <option>Cash</option><option>QR Code</option><option>Transfer</option><option>Card</option>
          </select>
        </label>
        <div style={{ textAlign: 'right', flex: 1 }}>
          <div className="label">ยอดรวม {baht(subtotal)} + VAT 7% {baht(vat)}</div>
          <div style={{ fontSize: 22 }}>สุทธิ <strong>{baht(total)}</strong></div>
        </div>
      </div>
      <button className="btn" style={{ marginTop: 12, width: '100%' }} disabled={mut.isPending || !lines.some((l) => l.item_id)} onClick={() => mut.mutate()}>
        {mut.isPending ? 'กำลังบันทึก…' : '💰 ยืนยันการขาย'}
      </button>
      {mut.error && <Msg>{(mut.error as Error).message}</Msg>}
      {mut.data && <Msg ok>✅ ขายสำเร็จ {mut.data.sale_no} · สุทธิ {baht(mut.data.total)} · ได้แต้ม +{mut.data.points_earned}</Msg>}
    </Card>
  );
}

function History() {
  const q = useQuery<any>({ queryKey: ['portal-sales'], queryFn: () => api('/api/portal/pos/sales?limit=50') });
  return (
    <StateView q={q}>
      {q.data && (
        <DataTable rows={q.data.sales} columns={[
          { key: 'sale_no', label: 'เลขที่' },
          { key: 'sale_date', label: 'วันที่', render: (r) => thaiDate(r.sale_date) },
          { key: 'total', label: 'ยอดสุทธิ', render: (r) => baht(r.total) },
          { key: 'points_earned', label: 'แต้ม', render: (r) => `+${num(r.points_earned)}` },
          { key: 'payment_method', label: 'ชำระ' },
          { key: 'status', label: 'สถานะ', render: (r) => <Badge value={r.status} /> },
        ]} />
      )}
    </StateView>
  );
}

export default function PortalPos() {
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>🏪 ขายสินค้า (POS)</h1>
      <Tabs tabs={[{ key: 'new', label: 'ขายใหม่', content: <NewSale /> }, { key: 'hist', label: 'ประวัติการขาย', content: <History /> }]} />
    </div>
  );
}
