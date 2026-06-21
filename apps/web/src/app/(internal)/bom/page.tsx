'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, DataTable, Badge, StateView } from '@/components/ui';
import { Tabs, Msg } from '@/components/tabs';
import { baht } from '@/lib/format';

const g = (r: any, ...keys: string[]) => { for (const k of keys) if (r[k] != null) return r[k]; return ''; };

function Library() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['bom-master'], queryFn: () => api('/api/bom/master') });
  const [code, setCode] = useState(''); const [name, setName] = useState(''); const [sell, setSell] = useState(0); const [labor, setLabor] = useState(0);
  const [lines, setLines] = useState([{ item_id: '', qty_use_uom: 1, conv_factor: 1 }]);
  const setLine = (i: number, p: any) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const add = useMutation({
    mutationFn: () => api<{ bom_code: string }>('/api/bom/master', { method: 'POST', body: JSON.stringify({ bom_code: code, product_name: name, selling_price: Number(sell), labor_cost: Number(labor), lines: lines.filter((l) => l.item_id).map((l) => ({ item_id: l.item_id, qty_use_uom: Number(l.qty_use_uom), conv_factor: Number(l.conv_factor) })) }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['bom-master'] }); setCode(''); setName(''); },
  });
  return (
    <>
      <Card style={{ maxWidth: 720, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>สร้าง/แก้สูตร (BoM)</h3>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input className="input" placeholder="รหัสสูตร" value={code} onChange={(e) => setCode(e.target.value)} />
          <input className="input" placeholder="ชื่อสินค้า" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input" style={{ maxWidth: 110 }} type="number" placeholder="ราคาขาย" value={sell} onChange={(e) => setSell(+e.target.value)} />
          <input className="input" style={{ maxWidth: 110 }} type="number" placeholder="ค่าแรง" value={labor} onChange={(e) => setLabor(+e.target.value)} />
        </div>
        <div className="label">วัตถุดิบ (Item ID · จำนวนใช้ · อัตราแปลง)</div>
        {lines.map((l, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: 8, margin: '6px 0' }}>
            <input className="input" placeholder="Item ID" value={l.item_id} onChange={(e) => setLine(i, { item_id: e.target.value })} />
            <input className="input" type="number" value={l.qty_use_uom} onChange={(e) => setLine(i, { qty_use_uom: +e.target.value })} />
            <input className="input" type="number" value={l.conv_factor} onChange={(e) => setLine(i, { conv_factor: +e.target.value })} />
            <button className="btn" style={{ background: 'var(--ruby)' }} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button className="btn" style={{ background: '#64748b' }} onClick={() => setLines((ls) => [...ls, { item_id: '', qty_use_uom: 1, conv_factor: 1 }])}>+ วัตถุดิบ</button>
        <button className="btn" style={{ marginLeft: 8 }} disabled={!code || add.isPending} onClick={() => add.mutate()}>บันทึกสูตร</button>
        {add.error && <Msg>{(add.error as Error).message}</Msg>}
        {add.data && <Msg ok>✅ บันทึก {add.data.bom_code}</Msg>}
      </Card>
      <StateView q={q}>
        {q.data && <DataTable rows={q.data.boms} columns={[
          { key: 'code', label: 'รหัส', render: (r) => g(r, 'bomCode', 'bom_code') },
          { key: 'product', label: 'สินค้า', render: (r) => g(r, 'productName', 'product_name') },
          { key: 'sell', label: 'ราคาขาย', render: (r) => baht(g(r, 'sellingPrice', 'selling_price')) },
          { key: 'cost', label: 'ต้นทุน/หน่วย', render: (r) => baht(g(r, 'costPerUnit', 'cost_per_unit')) },
          { key: 'margin', label: 'กำไร %', render: (r) => `${Number(g(r, 'marginPct', 'margin_pct') || 0).toFixed(1)}%` },
        ]} />}
      </StateView>
    </>
  );
}

function Submissions() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['bom-sub'], queryFn: () => api('/api/bom/submissions') });
  const approve = useMutation({ mutationFn: (id: number) => api(`/api/bom/submissions/${id}/approve`, { method: 'PATCH' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['bom-sub'] }) });
  return (
    <StateView q={q}>
      {q.data && <DataTable rows={q.data.submissions} columns={[
        { key: 'code', label: 'รหัส', render: (r) => g(r, 'bomCode', 'bom_code') },
        { key: 'product', label: 'สินค้า', render: (r) => g(r, 'productName', 'product_name') },
        { key: 'status', label: 'สถานะ', render: (r) => <Badge value={g(r, 'status') || 'Pending'} /> },
        { key: 'x', label: '', render: (r) => (g(r, 'status') === 'Approved' ? '✅' : <button className="btn" style={{ padding: '4px 10px' }} onClick={() => approve.mutate(g(r, 'id'))}>อนุมัติ</button>) },
      ]} />}
    </StateView>
  );
}

export default function Bom() {
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>🔬 สูตรผลิตกลาง (BoM Master)</h1>
      <Tabs tabs={[{ key: 'lib', label: 'คลังสูตร', content: <Library /> }, { key: 'sub', label: 'คำขออนุมัติจากลูกค้า', content: <Submissions /> }]} />
    </div>
  );
}
