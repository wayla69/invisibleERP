'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, DataTable, Badge, StateView } from '@/components/ui';
import { baht, thaiDate } from '@/lib/format';

interface Line { item_id: string; order_qty: number; unit_price: number }

export default function ProcurementPage() {
  const qc = useQueryClient();
  const pos = useQuery<any>({ queryKey: ['proc-pos'], queryFn: () => api('/api/inventory/purchase-orders?limit=50') });
  const [vendor, setVendor] = useState('');
  const [lines, setLines] = useState<Line[]>([{ item_id: '', order_qty: 1, unit_price: 0 }]);
  const setLine = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const mut = useMutation({
    mutationFn: () => api<{ po_no: string; total_amount: number }>('/api/procurement/pos', {
      method: 'POST',
      body: JSON.stringify({ vendor_name: vendor || undefined, items: lines.filter((l) => l.item_id).map((l) => ({ item_id: l.item_id, order_qty: Number(l.order_qty), unit_price: Number(l.unit_price) })) }),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['proc-pos'] }),
  });

  return (
    <div>
      <h1 style={{ marginTop: 0 }}>🛒 จัดซื้อ (Procurement)</h1>

      <Card style={{ maxWidth: 640, marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>สร้าง PO</h3>
        <label className="label">ผู้ขาย<input className="input" value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="ชื่อผู้ขาย" /></label>
        {lines.map((l, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: 8, margin: '8px 0' }}>
            <input className="input" placeholder="Item ID" value={l.item_id} onChange={(e) => setLine(i, { item_id: e.target.value })} />
            <input className="input" type="number" value={l.order_qty} onChange={(e) => setLine(i, { order_qty: +e.target.value })} />
            <input className="input" type="number" value={l.unit_price} onChange={(e) => setLine(i, { unit_price: +e.target.value })} />
            <button className="btn" style={{ background: 'var(--ruby)' }} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button className="btn" style={{ background: '#64748b' }} onClick={() => setLines((ls) => [...ls, { item_id: '', order_qty: 1, unit_price: 0 }])}>+ รายการ</button>
        <button className="btn" style={{ marginLeft: 8 }} disabled={mut.isPending || !lines.some((l) => l.item_id)} onClick={() => mut.mutate()}>
          {mut.isPending ? 'กำลังบันทึก…' : 'สร้าง PO (สถานะ Pending)'}
        </button>
        {mut.error && <p style={{ color: 'var(--ruby)' }}>{(mut.error as Error).message}</p>}
        {mut.data && <p style={{ color: 'var(--navy)' }}>✅ {mut.data.po_no} · {baht(mut.data.total_amount)}</p>}
      </Card>

      <h3>ใบสั่งซื้อ</h3>
      <StateView q={pos}>
        {pos.data && (
          <DataTable
            rows={pos.data.purchase_orders}
            columns={[
              { key: 'PO_No', label: 'PO' },
              { key: 'PO_Date', label: 'วันที่', render: (r: any) => thaiDate(r.PO_Date) },
              { key: 'Supplier_Name', label: 'ผู้ขาย' },
              { key: 'Total_Amount', label: 'ยอด', render: (r: any) => baht(r.Total_Amount) },
              { key: 'Status', label: 'สถานะ', render: (r: any) => <Badge value={r.Status} /> },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}
