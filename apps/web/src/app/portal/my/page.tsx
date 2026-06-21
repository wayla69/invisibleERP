'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, DataTable, Badge, StateView } from '@/components/ui';
import { Tabs, Msg } from '@/components/tabs';
import { baht } from '@/lib/format';

function Customers() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['my-cust'], queryFn: () => api('/api/portal/my/customers') });
  const [name, setName] = useState(''); const [phone, setPhone] = useState('');
  const add = useMutation({ mutationFn: () => api('/api/portal/my/customers', { method: 'POST', body: JSON.stringify({ customer_name: name, phone }) }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['my-cust'] }); setName(''); setPhone(''); } });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/portal/my/customers/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['my-cust'] }) });
  return (
    <>
      <Card style={{ maxWidth: 560, marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" placeholder="ชื่อลูกค้า" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input" placeholder="เบอร์โทร" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button className="btn" disabled={!name || add.isPending} onClick={() => add.mutate()}>เพิ่ม</button>
        </div>
        {add.error && <Msg>{(add.error as Error).message}</Msg>}
      </Card>
      <StateView q={q}>
        {q.data && <DataTable rows={q.data.customers} columns={[
          { key: 'customer_name', label: 'ชื่อ' }, { key: 'phone', label: 'โทร' }, { key: 'address', label: 'ที่อยู่' },
          { key: 'x', label: '', render: (r) => <button className="btn" style={{ background: 'var(--ruby)', padding: '4px 10px' }} onClick={() => del.mutate(r.id)}>ลบ</button> },
        ]} />}
      </StateView>
    </>
  );
}

function Suppliers() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['my-sup'], queryFn: () => api('/api/portal/my/suppliers') });
  const [name, setName] = useState(''); const [phone, setPhone] = useState('');
  const add = useMutation({ mutationFn: () => api('/api/portal/my/suppliers', { method: 'POST', body: JSON.stringify({ supplier_name: name, phone }) }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['my-sup'] }); setName(''); setPhone(''); } });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/portal/my/suppliers/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['my-sup'] }) });
  return (
    <>
      <Card style={{ maxWidth: 560, marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" placeholder="ชื่อซัพพลายเออร์" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input" placeholder="เบอร์โทร" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button className="btn" disabled={!name || add.isPending} onClick={() => add.mutate()}>เพิ่ม</button>
        </div>
      </Card>
      <StateView q={q}>
        {q.data && <DataTable rows={q.data.suppliers} columns={[
          { key: 'supplier_name', label: 'ชื่อ' }, { key: 'contact_name', label: 'ผู้ติดต่อ' }, { key: 'phone', label: 'โทร' },
          { key: 'x', label: '', render: (r) => <button className="btn" style={{ background: 'var(--ruby)', padding: '4px 10px' }} onClick={() => del.mutate(r.id)}>ลบ</button> },
        ]} />}
      </StateView>
    </>
  );
}

function Pos() {
  const q = useQuery<any>({ queryKey: ['my-po'], queryFn: () => api('/api/portal/my/purchase-orders') });
  return (
    <StateView q={q}>
      {q.data && <DataTable rows={q.data.purchase_orders} columns={[
        { key: 'po_no', label: 'เลขที่' }, { key: 'supplier_name', label: 'ผู้ขาย' },
        { key: 'total_amount', label: 'ยอด', render: (r) => baht(r.total_amount) },
        { key: 'status', label: 'สถานะ', render: (r) => <Badge value={r.status} /> },
      ]} />}
    </StateView>
  );
}

export default function MyBusiness() {
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>💼 ธุรกิจของฉัน (Mini-ERP)</h1>
      <Tabs tabs={[
        { key: 'c', label: '👥 ลูกค้าของฉัน', content: <Customers /> },
        { key: 's', label: '🏢 ซัพพลายเออร์', content: <Suppliers /> },
        { key: 'p', label: '🧾 ใบสั่งซื้อ', content: <Pos /> },
      ]} />
    </div>
  );
}
