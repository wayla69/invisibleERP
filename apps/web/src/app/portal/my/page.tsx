'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs, Msg } from '@/components/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { statusVariant } from '@/components/ui';

function Customers() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['my-cust'], queryFn: () => api('/api/portal/my/customers') });
  const [name, setName] = useState(''); const [phone, setPhone] = useState('');
  const add = useMutation({ mutationFn: () => api('/api/portal/my/customers', { method: 'POST', body: JSON.stringify({ customer_name: name, phone }) }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['my-cust'] }); setName(''); setPhone(''); } });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/portal/my/customers/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['my-cust'] }) });
  return (
    <div className="space-y-4">
      <Card className="max-w-xl gap-3 p-5">
        <CardContent className="space-y-3 px-0">
          <div className="flex flex-wrap gap-2">
            <Input className="flex-1" placeholder="ชื่อลูกค้า" value={name} onChange={(e) => setName(e.target.value)} />
            <Input className="flex-1" placeholder="เบอร์โทร" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <Button disabled={!name || add.isPending} onClick={() => add.mutate()}>เพิ่ม</Button>
          </div>
          {add.error && <Msg>{(add.error as Error).message}</Msg>}
        </CardContent>
      </Card>
      <StateView q={q}>
        {q.data && <DataTable rows={q.data.customers} columns={[
          { key: 'customer_name', label: 'ชื่อ' }, { key: 'phone', label: 'โทร' }, { key: 'address', label: 'ที่อยู่' },
          { key: 'x', label: '', align: 'right', render: (r) => <Button variant="destructive" size="icon" disabled={del.isPending} onClick={() => del.mutate(r.id)}><Trash2 className="size-4" /></Button> },
        ]} />}
      </StateView>
    </div>
  );
}

function Suppliers() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['my-sup'], queryFn: () => api('/api/portal/my/suppliers') });
  const [name, setName] = useState(''); const [phone, setPhone] = useState('');
  const add = useMutation({ mutationFn: () => api('/api/portal/my/suppliers', { method: 'POST', body: JSON.stringify({ supplier_name: name, phone }) }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['my-sup'] }); setName(''); setPhone(''); } });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/portal/my/suppliers/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['my-sup'] }) });
  return (
    <div className="space-y-4">
      <Card className="max-w-xl gap-3 p-5">
        <CardContent className="px-0">
          <div className="flex flex-wrap gap-2">
            <Input className="flex-1" placeholder="ชื่อซัพพลายเออร์" value={name} onChange={(e) => setName(e.target.value)} />
            <Input className="flex-1" placeholder="เบอร์โทร" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <Button disabled={!name || add.isPending} onClick={() => add.mutate()}>เพิ่ม</Button>
          </div>
        </CardContent>
      </Card>
      <StateView q={q}>
        {q.data && <DataTable rows={q.data.suppliers} columns={[
          { key: 'supplier_name', label: 'ชื่อ' }, { key: 'contact_name', label: 'ผู้ติดต่อ' }, { key: 'phone', label: 'โทร' },
          { key: 'x', label: '', align: 'right', render: (r) => <Button variant="destructive" size="icon" disabled={del.isPending} onClick={() => del.mutate(r.id)}><Trash2 className="size-4" /></Button> },
        ]} />}
      </StateView>
    </div>
  );
}

function Pos() {
  const q = useQuery<any>({ queryKey: ['my-po'], queryFn: () => api('/api/portal/my/purchase-orders') });
  return (
    <StateView q={q}>
      {q.data && <DataTable rows={q.data.purchase_orders} columns={[
        { key: 'po_no', label: 'เลขที่' }, { key: 'supplier_name', label: 'ผู้ขาย' },
        { key: 'total_amount', label: 'ยอด', align: 'right', render: (r) => baht(r.total_amount) },
        { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
      ]} />}
    </StateView>
  );
}

export default function MyBusiness() {
  return (
    <div>
      <PageHeader title="ธุรกิจของฉัน (Mini-ERP)" description="ลูกค้า ซัพพลายเออร์ และใบสั่งซื้อ" />
      <Tabs tabs={[
        { key: 'c', label: 'ลูกค้าของฉัน', content: <Customers /> },
        { key: 's', label: 'ซัพพลายเออร์', content: <Suppliers /> },
        { key: 'p', label: 'ใบสั่งซื้อ', content: <Pos /> },
      ]} />
    </div>
  );
}
