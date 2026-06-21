'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Card } from '@/components/ui';
import { baht } from '@/lib/format';

interface Line { item_id: string; order_qty: number; unit_price: number }

export default function NewOrderPage() {
  const qc = useQueryClient();
  const [customer, setCustomer] = useState('');
  const [lines, setLines] = useState<Line[]>([{ item_id: '', order_qty: 1, unit_price: 0 }]);

  const total = lines.reduce((a, l) => a + Number(l.order_qty) * Number(l.unit_price), 0);

  const mut = useMutation({
    mutationFn: () =>
      api<{ order_no: string; total: number; points_earned: number }>('/api/pos/orders', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: customer || undefined,
          items: lines.filter((l) => l.item_id).map((l) => ({ item_id: l.item_id, order_qty: Number(l.order_qty), unit_price: Number(l.unit_price) })),
        }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
  });

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <div>
      <Link href="/pos">← กลับ</Link>
      <h1 style={{ marginTop: 8 }}>สร้างออเดอร์</h1>
      <Card style={{ maxWidth: 640 }}>
        <label className="label">ลูกค้า (Customer code)
          <input className="input" value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="เช่น T1 (เว้นว่าง = ไม่ระบุ)" />
        </label>
        <h4>รายการสินค้า</h4>
        {lines.map((l, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: 8, marginBottom: 8 }}>
            <input className="input" placeholder="Item ID" value={l.item_id} onChange={(e) => setLine(i, { item_id: e.target.value })} />
            <input className="input" type="number" placeholder="จำนวน" value={l.order_qty} onChange={(e) => setLine(i, { order_qty: +e.target.value })} />
            <input className="input" type="number" placeholder="ราคา" value={l.unit_price} onChange={(e) => setLine(i, { unit_price: +e.target.value })} />
            <button className="btn" style={{ background: 'var(--ruby)' }} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button className="btn" style={{ background: '#64748b' }} onClick={() => setLines((ls) => [...ls, { item_id: '', order_qty: 1, unit_price: 0 }])}>+ เพิ่มรายการ</button>

        <div style={{ marginTop: 16, fontSize: 18 }}>รวม: <strong>{baht(total)}</strong></div>
        <button className="btn" style={{ marginTop: 12 }} disabled={mut.isPending || !lines.some((l) => l.item_id)} onClick={() => mut.mutate()}>
          {mut.isPending ? 'กำลังบันทึก…' : 'ยืนยันออเดอร์'}
        </button>

        {mut.error && <p style={{ color: 'var(--ruby)' }}>{(mut.error as Error).message}</p>}
        {mut.data && (
          <Card style={{ marginTop: 12, background: '#ecfdf5' }}>
            ✅ สร้างสำเร็จ: <strong>{mut.data.order_no}</strong> · ยอด {baht(mut.data.total)} · แต้ม +{mut.data.points_earned}
          </Card>
        )}
      </Card>
    </div>
  );
}
