'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
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
  const { t } = useLang();
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
            <Input className="flex-1" placeholder={t('pt.my.ph_customer')} value={name} onChange={(e) => setName(e.target.value)} />
            <Input className="flex-1" placeholder={t('pt.my.ph_phone')} value={phone} onChange={(e) => setPhone(e.target.value)} />
            <Button disabled={!name || add.isPending} onClick={() => add.mutate()}>{t('pt.add')}</Button>
          </div>
          {add.error && <Msg>{(add.error as Error).message}</Msg>}
        </CardContent>
      </Card>
      <StateView q={q}>
        {q.data && <DataTable rows={q.data.customers} columns={[
          { key: 'customer_name', label: t('pt.col_name') }, { key: 'phone', label: t('pt.col_phone') }, { key: 'address', label: t('pt.my.col_address') },
          { key: 'x', label: '', align: 'right', render: (r) => <Button variant="destructive" size="icon" disabled={del.isPending} onClick={() => del.mutate(r.id)}><Trash2 className="size-4" /></Button> },
        ]} />}
      </StateView>
    </div>
  );
}

function Suppliers() {
  const { t } = useLang();
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
            <Input className="flex-1" placeholder={t('pt.my.ph_supplier')} value={name} onChange={(e) => setName(e.target.value)} />
            <Input className="flex-1" placeholder={t('pt.my.ph_phone')} value={phone} onChange={(e) => setPhone(e.target.value)} />
            <Button disabled={!name || add.isPending} onClick={() => add.mutate()}>{t('pt.add')}</Button>
          </div>
        </CardContent>
      </Card>
      <StateView q={q}>
        {q.data && <DataTable rows={q.data.suppliers} columns={[
          { key: 'supplier_name', label: t('pt.col_name') }, { key: 'contact_name', label: t('pt.my.col_contact') }, { key: 'phone', label: t('pt.col_phone') },
          { key: 'x', label: '', align: 'right', render: (r) => <Button variant="destructive" size="icon" disabled={del.isPending} onClick={() => del.mutate(r.id)}><Trash2 className="size-4" /></Button> },
        ]} />}
      </StateView>
    </div>
  );
}

function Pos() {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['my-po'], queryFn: () => api('/api/portal/my/purchase-orders') });
  return (
    <StateView q={q}>
      {q.data && <DataTable rows={q.data.purchase_orders} columns={[
        { key: 'po_no', label: t('pt.col_no') }, { key: 'supplier_name', label: t('pt.my.col_vendor') },
        { key: 'total_amount', label: t('pt.my.col_amount'), align: 'right', render: (r) => baht(r.total_amount) },
        { key: 'status', label: t('pt.col_status'), render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
      ]} />}
    </StateView>
  );
}

export default function MyBusiness() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('pt.my.title')} description={t('pt.my.desc')} />
      <Tabs tabs={[
        { key: 'c', label: t('pt.my.tab_customers'), content: <Customers /> },
        { key: 's', label: t('pt.my.tab_suppliers'), content: <Suppliers /> },
        { key: 'p', label: t('pt.my.tab_pos'), content: <Pos /> },
      ]} />
    </div>
  );
}
