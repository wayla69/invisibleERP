'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Wallet, CreditCard, Receipt } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Deposit { deposit_no: string; customer_name: string | null; purpose: string; amount: number; applied: number; refunded: number; remaining: number; status: string }
interface Account { account_no: string; name: string; credit_limit: number; balance: number; status: string }

export default function PaymentsDepthPage() {
  return (
    <div>
      <PageHeader title="มัดจำ & บัญชีเครดิต (Payments depth)" description="รับมัดจำล่วงหน้า · บัญชีเครดิตลูกค้า (วงเงิน + ชำระสกุลต่างประเทศ) · ค่าธรรมเนียมบัตร" />
      <Tabs tabs={[
        { key: 'deposits', label: 'มัดจำ', content: <Deposits /> },
        { key: 'accounts', label: 'บัญชีเครดิต', content: <Accounts /> },
        { key: 'surcharge', label: 'ค่าธรรมเนียมบัตร', content: <Surcharge /> },
      ]} />
    </div>
  );
}

function Deposits() {
  const qc = useQueryClient();
  const [amount, setAmount] = useState(''); const [name, setName] = useState('');
  const q = useQuery<{ deposits: Deposit[] }>({ queryKey: ['deposits'], queryFn: () => api('/api/payments/deposits') });
  const take = useMutation({
    mutationFn: () => api('/api/payments/deposits', { method: 'POST', body: JSON.stringify({ amount: Number(amount), customer_name: name || undefined }) }),
    onSuccess: () => { notifySuccess(`รับมัดจำ ${baht(Number(amount))}`); setAmount(''); setName(''); qc.invalidateQueries({ queryKey: ['deposits'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const apply = useMutation({ mutationFn: (no: string) => api(`/api/payments/deposits/${no}/apply`, { method: 'POST', body: JSON.stringify({}) }), onSuccess: () => qc.invalidateQueries({ queryKey: ['deposits'] }), onError: (e: Error) => notifyError(e.message) });
  const refund = useMutation({ mutationFn: (no: string) => api(`/api/payments/deposits/${no}/refund`, { method: 'POST', body: JSON.stringify({}) }), onSuccess: () => qc.invalidateQueries({ queryKey: ['deposits'] }), onError: (e: Error) => notifyError(e.message) });
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-sm">รับมัดจำใหม่</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div><Label>จำนวนเงิน</Label><Input value={amount} onChange={(e) => setAmount(e.target.value)} className="w-32" placeholder="500" /></div>
          <div><Label>ชื่อลูกค้า</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="คุณ…" /></div>
          <Button disabled={!amount || take.isPending} onClick={() => take.mutate()}>รับมัดจำ</Button>
        </CardContent>
      </Card>
      <StateView q={q}>
        <DataTable
          rows={q.data?.deposits ?? []}
          rowKey={(r) => r.deposit_no}
          columns={[
            { key: 'deposit_no', label: 'เลขที่' },
            { key: 'customer_name', label: 'ลูกค้า', render: (r) => r.customer_name ?? '—' },
            { key: 'amount', label: 'มัดจำ', align: 'right', render: (r) => baht(r.amount) },
            { key: 'remaining', label: 'คงเหลือ', align: 'right', render: (r) => <span className="tabular">{baht(r.remaining)}</span> },
            { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={r.status === 'open' ? 'info' : r.status === 'closed' || r.status === 'refunded' ? 'muted' : 'success'}>{r.status}</Badge> },
            { key: 'act', label: '', align: 'right', render: (r) => r.status === 'open' ? <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" onClick={() => apply.mutate(r.deposit_no)}>ใช้</Button><Button size="sm" variant="ghost" disabled={refund.isPending} onClick={() => refund.mutate(r.deposit_no)}>คืน</Button></div> : null },
          ]}
          emptyState={{ icon: Wallet, title: 'ยังไม่มีมัดจำ', description: 'รับมัดจำล่วงหน้าจากลูกค้าด้วยฟอร์มด้านบนเพื่อเริ่มต้น' }}
        />
      </StateView>
    </div>
  );
}

function Accounts() {
  const qc = useQueryClient();
  const [name, setName] = useState(''); const [limit, setLimit] = useState(''); const [sel, setSel] = useState<string | null>(null);
  const q = useQuery<{ accounts: Account[] }>({ queryKey: ['house-accounts'], queryFn: () => api('/api/payments/house-accounts') });
  const stmt = useQuery<any>({ queryKey: ['house-statement', sel], queryFn: () => api(`/api/payments/house-accounts/${sel}/statement`), enabled: !!sel });
  const open = useMutation({
    mutationFn: () => api('/api/payments/house-accounts', { method: 'POST', body: JSON.stringify({ name, credit_limit: limit ? Number(limit) : 0 }) }),
    onSuccess: () => { notifySuccess(`เปิดบัญชีเครดิต ${name}`); setName(''); setLimit(''); qc.invalidateQueries({ queryKey: ['house-accounts'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-sm">เปิดบัญชีเครดิต</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div><Label>ชื่อบัญชี</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="บริษัท…" /></div>
          <div><Label>วงเงินเครดิต</Label><Input value={limit} onChange={(e) => setLimit(e.target.value)} className="w-32" placeholder="10000" /></div>
          <Button disabled={!name || open.isPending} onClick={() => open.mutate()}>เปิดบัญชี</Button>
        </CardContent>
      </Card>
      <StateView q={q}>
        <DataTable
          rows={q.data?.accounts ?? []}
          rowKey={(r) => r.account_no}
          columns={[
            { key: 'account_no', label: 'เลขที่' },
            { key: 'name', label: 'ชื่อ' },
            { key: 'credit_limit', label: 'วงเงิน', align: 'right', render: (r) => baht(r.credit_limit) },
            { key: 'balance', label: 'ยอดค้าง', align: 'right', render: (r) => <span className="tabular">{baht(r.balance)}</span> },
            { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={r.status === 'active' ? 'success' : 'muted'}>{r.status}</Badge> },
            { key: 'act', label: '', align: 'right', render: (r) => <Button size="sm" variant="ghost" onClick={() => setSel(r.account_no)}>รายการ</Button> },
          ]}
          emptyState={{ icon: CreditCard, title: 'ยังไม่มีบัญชีเครดิต', description: 'เปิดบัญชีเครดิตให้ลูกค้าด้วยฟอร์มด้านบนเพื่อเริ่มตั้งวงเงิน' }}
        />
      </StateView>
      {sel && stmt.data && (
        <Card>
          <CardHeader><CardTitle className="text-sm">รายการเดินบัญชี {sel} — ยอดค้าง {baht(stmt.data.balance)}{stmt.data.available_credit != null ? ` · วงเงินคงเหลือ ${baht(stmt.data.available_credit)}` : ''}</CardTitle></CardHeader>
          <CardContent>
            <DataTable
              rows={stmt.data.entries ?? []}
              rowKey={(r: any) => r.entry_no}
              columns={[
                { key: 'created_at', label: 'เวลา', render: (r: any) => r.created_at ? new Date(r.created_at).toLocaleString('th-TH') : '—' },
                { key: 'type', label: 'ประเภท', render: (r: any) => <Badge variant={r.type === 'charge' ? 'warning' : 'success'}>{r.type}</Badge> },
                { key: 'amount', label: 'จำนวน', align: 'right', render: (r: any) => baht(r.amount) },
                { key: 'currency', label: 'สกุล', render: (r: any) => r.currency !== 'THB' ? `${r.currency}@${r.fx_rate}` : 'THB' },
                { key: 'balance_after', label: 'คงเหลือ', align: 'right', render: (r: any) => <span className="tabular">{baht(r.balance_after)}</span> },
              ]}
              emptyState={{ title: 'ยังไม่มีรายการเดินบัญชี' }}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Surcharge() {
  const qc = useQueryClient();
  const [method, setMethod] = useState('Card'); const [pct, setPct] = useState('');
  const q = useQuery<{ surcharges: { method: string; pct: number; active: boolean }[] }>({ queryKey: ['surcharges'], queryFn: () => api('/api/payments/surcharges') });
  const save = useMutation({
    mutationFn: () => api('/api/payments/surcharges', { method: 'POST', body: JSON.stringify({ method, pct: Number(pct) }) }),
    onSuccess: () => { notifySuccess(`ตั้งค่าธรรมเนียม ${method} ${pct}%`); setPct(''); qc.invalidateQueries({ queryKey: ['surcharges'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-sm flex items-center gap-2"><CreditCard className="h-4 w-4" />ตั้งค่าธรรมเนียมบัตร</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div><Label>ช่องทาง</Label><Input value={method} onChange={(e) => setMethod(e.target.value)} className="w-32" placeholder="Card" /></div>
          <div><Label>เปอร์เซ็นต์ (%)</Label><Input value={pct} onChange={(e) => setPct(e.target.value)} className="w-24" placeholder="3" /></div>
          <Button disabled={!method || pct === '' || save.isPending} onClick={() => save.mutate()}>บันทึก</Button>
        </CardContent>
      </Card>
      <StateView q={q}>
        <DataTable
          rows={q.data?.surcharges ?? []}
          rowKey={(r) => r.method}
          columns={[
            { key: 'method', label: 'ช่องทาง', render: (r) => <span className="flex items-center gap-2"><Receipt className="h-4 w-4 text-muted-foreground" />{r.method}</span> },
            { key: 'pct', label: 'ค่าธรรมเนียม', align: 'right', render: (r) => `${r.pct}%` },
            { key: 'active', label: 'สถานะ', render: (r) => <Badge variant={r.active ? 'success' : 'muted'}>{r.active ? 'ใช้งาน' : 'ปิด'}</Badge> },
          ]}
          emptyState={{ icon: Receipt, title: 'ยังไม่ได้ตั้งค่าธรรมเนียมบัตร', description: 'กำหนดเปอร์เซ็นต์ค่าธรรมเนียมต่อช่องทางด้วยฟอร์มด้านบน' }}
        />
      </StateView>
    </div>
  );
}
