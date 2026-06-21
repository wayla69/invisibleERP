'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, DataTable, Badge, StateView } from '@/components/ui';
import { Tabs, Msg } from '@/components/tabs';
import { num } from '@/lib/format';

function StockTab() {
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
          { key: 'item_id', label: 'รหัส' },
          { key: 'item_description', label: 'ชื่อสินค้า' },
          { key: 'current_stock', label: 'คงเหลือ', render: (r) => <input className="input" style={{ width: 80, padding: 4 }} type="number" defaultValue={r.current_stock} onChange={(e) => setEdit((s) => ({ ...s, [r.id]: { ...s[r.id], current_stock: +e.target.value } }))} /> },
          { key: 'reorder_point', label: 'จุดสั่งซื้อ', render: (r) => <input className="input" style={{ width: 80, padding: 4 }} type="number" defaultValue={r.reorder_point} onChange={(e) => setEdit((s) => ({ ...s, [r.id]: { ...s[r.id], reorder_point: +e.target.value } }))} /> },
          { key: 'reorder_qty', label: 'จำนวนสั่ง', render: (r) => <input className="input" style={{ width: 80, padding: 4 }} type="number" defaultValue={r.reorder_qty} onChange={(e) => setEdit((s) => ({ ...s, [r.id]: { ...s[r.id], reorder_qty: +e.target.value } }))} /> },
          { key: 'low_stock', label: '', render: (r) => (r.low_stock ? <Badge value="ต้องสั่ง" /> : '✅') },
          { key: 'save', label: '', render: (r) => <button className="btn" style={{ padding: '4px 10px' }} disabled={!edit[r.id]} onClick={() => save.mutate(r.id)}>บันทึก</button> },
        ]} />
      )}
    </StateView>
  );
}

function PendingTab() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['portal-pending'], queryFn: () => api('/api/portal/pending-orders') });
  const submit = useMutation({
    mutationFn: (no: string) => api(`/api/portal/pending-orders/${encodeURIComponent(no)}/submit`, { method: 'PATCH' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal-pending'] }),
  });
  return (
    <StateView q={q}>
      {q.data && (q.data.pending_orders.length === 0
        ? <Card><span className="label">ยังไม่มีใบสั่งซื้อรออนุมัติ</span></Card>
        : q.data.pending_orders.map((p: any) => (
          <Card key={p.pending_no} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div><strong>{p.pending_no}</strong> <Badge value={p.status} /> <span className="label">· {p.trigger_type} · {num(p.total_items)} รายการ</span></div>
              {p.status === 'Draft' && <button className="btn" disabled={submit.isPending} onClick={() => submit.mutate(p.pending_no)}>📤 ส่งขออนุมัติ</button>}
            </div>
            <table style={{ marginTop: 8 }}>
              <thead><tr><th>สินค้า</th><th>แนะนำ</th><th>สั่งจริง</th><th>เหตุผล</th></tr></thead>
              <tbody>{p.items.map((it: any, i: number) => <tr key={i}><td>{it.item_description ?? it.item_id}</td><td>{num(it.suggested_qty)}</td><td>{num(it.final_qty)}</td><td className="label">{it.trigger_reason}</td></tr>)}</tbody>
            </table>
          </Card>
        )))}
    </StateView>
  );
}

export default function PortalInventory() {
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>📦 สต๊อก &amp; สั่งซื้อซ้ำ</h1>
      <Tabs tabs={[{ key: 'stock', label: 'สต๊อกของฉัน', content: <StockTab /> }, { key: 'pending', label: 'ใบสั่งซื้ออัตโนมัติ', content: <PendingTab /> }]} />
    </div>
  );
}
