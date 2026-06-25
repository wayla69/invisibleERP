'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { CircleDollarSign, HandCoins, Send, Wallet, X } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Petty-cash / employee advances register (EXP-07): the float-control view ops + finance lacked — every
// advance with its status, plus the OUTSTANDING (uncleared) total, with issue + settle actions.

const selectCls =
  'h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

interface Advance {
  advance_no: string; payee: string; purpose: string | null; amount: number; status: string;
  settled_expense: number; returned_cash: number; issued_by: string | null; issued_date: string | null; settled_date: string | null;
}
interface AdvancesResp { advances: Advance[]; count: number; outstanding: number }

export default function AdvancesPage() {
  return (
    <div>
      <PageHeader
        title="เงินทดรองจ่าย (Petty Cash / Advances)"
        description="ทะเบียนเงินทดรองจ่าย — ยอดที่ยังไม่เคลียร์ (outstanding float), ผู้รับ, สถานะ พร้อมเบิก/เคลียร์ (EXP-07)"
      />
      <Tabs
        tabs={[
          { key: 'register', label: 'ทะเบียน', content: <Register /> },
          { key: 'issue', label: 'เบิกเงินทดรอง', content: <IssueForm /> },
        ]}
      />
    </div>
  );
}

function Register() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [settle, setSettle] = useState<Advance | null>(null);
  const q = useQuery<AdvancesResp>({
    queryKey: ['advances', status],
    queryFn: () => api(`/api/finance/advances${status ? `?status=${status}` : ''}`),
    placeholderData: keepPreviousData,
  });
  const d = q.data;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="กรองตามสถานะ">
          <option value="">ทุกสถานะ</option>
          <option value="open">ค้างเคลียร์ (open)</option>
          <option value="settled">เคลียร์แล้ว (settled)</option>
        </select>
        {q.isFetching && !q.isLoading && <span className="text-xs text-muted-foreground">กำลังอัปเดต…</span>}
      </div>
      <StateView q={q}>
        {d && (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <StatCard label="รายการทั้งหมด" value={num(d.count)} icon={HandCoins} tone="primary" />
              <StatCard label="ยอดค้างเคลียร์ (Outstanding)" value={`฿${num(d.outstanding)}`} icon={Wallet} tone={d.outstanding > 0 ? 'warning' : 'success'} hint="เงินสดที่ยังไม่คืน/ยังไม่ล้างบัญชี" />
              <StatCard label="ค้างเคลียร์ (รายการ)" value={num(d.advances.filter((a) => a.status === 'open').length)} icon={CircleDollarSign} />
            </div>
            <DataTable
              rows={d.advances}
              rowKey={(r) => r.advance_no}
              emptyState={{ icon: HandCoins, title: 'ยังไม่มีเงินทดรองจ่าย', description: 'เบิกเงินทดรองที่แท็บ "เบิกเงินทดรอง" แล้วรายการจะแสดงที่นี่' }}
              columns={[
                { key: 'advance_no', label: 'เลขที่', render: (r) => <span className="font-medium">{r.advance_no}</span> },
                { key: 'payee', label: 'ผู้รับ' },
                { key: 'purpose', label: 'วัตถุประสงค์', render: (r) => r.purpose ?? '—' },
                { key: 'amount', label: 'จำนวน', align: 'right', render: (r) => <span className="tabular font-medium">฿{num(r.amount)}</span> },
                { key: 'status', label: 'สถานะ', render: (r) => (r.status === 'open' ? <Badge variant="warning">ค้างเคลียร์</Badge> : <Badge variant="success">เคลียร์แล้ว</Badge>) },
                { key: 'issued_by', label: 'เบิกโดย', render: (r) => r.issued_by ?? '—' },
                { key: 'issued_date', label: 'วันที่เบิก', render: (r) => (r.issued_date ? thaiDate(r.issued_date) : '—') },
                { key: 'act', label: '', render: (r) => (r.status === 'open' ? <Button size="sm" variant="outline" onClick={() => setSettle(r)}>เคลียร์</Button> : <span className="text-muted-foreground">—</span>) },
              ]}
            />
            {settle && <SettleCard advance={settle} onDone={() => { setSettle(null); qc.invalidateQueries({ queryKey: ['advances'] }); }} onClose={() => setSettle(null)} />}
          </>
        )}
      </StateView>
    </div>
  );
}

function SettleCard({ advance, onDone, onClose }: { advance: Advance; onDone: () => void; onClose: () => void }) {
  const [expense, setExpense] = useState('');
  const [returned, setReturned] = useState('');
  const sum = (Number(expense) || 0) + (Number(returned) || 0);
  const reconciles = Math.abs(sum - advance.amount) < 0.01;

  const submit = useMutation({
    mutationFn: () => api<any>(`/api/finance/advances/${encodeURIComponent(advance.advance_no)}/settle`, {
      method: 'POST',
      body: JSON.stringify({ settled_expense: Number(expense), returned_cash: Number(returned) }),
    }),
    onSuccess: () => { notifySuccess(`เคลียร์ ${advance.advance_no} แล้ว (ค่าใช้จ่าย ฿${num(expense)} · คืนเงิน ฿${num(returned)})`); onDone(); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Card className="mt-2 gap-3 p-5">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">เคลียร์เงินทดรอง {advance.advance_no} <span className="text-muted-foreground">(฿{num(advance.amount)})</span></h3>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="ปิด"><X className="size-4" /></Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="ad-exp">ค่าใช้จ่ายจริง (฿)</Label>
          <Input id="ad-exp" type="number" min="0" step="any" value={expense} onChange={(e) => setExpense(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ad-ret">เงินสดคืน (฿)</Label>
          <Input id="ad-ret" type="number" min="0" step="any" value={returned} onChange={(e) => setReturned(e.target.value)} />
        </div>
      </div>
      <p className={reconciles ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'}>
        ค่าใช้จ่าย + เงินคืน = ฿{num(sum)} {reconciles ? '✓ ตรงกับยอดเบิก' : `(ต้องเท่ากับ ฿${num(advance.amount)})`}
      </p>
      <Button className="w-fit" disabled={!reconciles || submit.isPending} onClick={() => submit.mutate()}>
        <Send className="size-4" /> {submit.isPending ? 'กำลังเคลียร์…' : 'เคลียร์เงินทดรอง'}
      </Button>
    </Card>
  );
}

function IssueForm() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ payee: '', amount: '', purpose: '' });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = useMutation({
    mutationFn: () => api<any>('/api/finance/advances', {
      method: 'POST',
      body: JSON.stringify({ payee: form.payee.trim(), amount: Number(form.amount), purpose: form.purpose.trim() || undefined }),
    }),
    onSuccess: (r) => { notifySuccess(`เบิกเงินทดรอง ${r.advance_no} — ${r.payee} ฿${num(r.amount)}`); setForm({ payee: '', amount: '', purpose: '' }); qc.invalidateQueries({ queryKey: ['advances'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const canSubmit = !!form.payee.trim() && Number(form.amount) > 0;

  return (
    <Card className="max-w-xl gap-3 p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="ad-payee">ผู้รับ (พนักงาน) <span className="text-destructive">*</span></Label>
          <Input id="ad-payee" value={form.payee} onChange={set('payee')} placeholder="เช่น EMP1 / ชื่อพนักงาน" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ad-amt">จำนวนเงิน (฿) <span className="text-destructive">*</span></Label>
          <Input id="ad-amt" type="number" min="0" step="any" value={form.amount} onChange={set('amount')} />
        </div>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="ad-purpose">วัตถุประสงค์</Label>
          <Input id="ad-purpose" value={form.purpose} onChange={set('purpose')} placeholder="เช่น ค่าเดินทางไปไซต์งาน" />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">ลงบัญชี: เดบิต 1180 เงินทดรองจ่าย / เครดิต 1000 เงินสด</p>
      <Button className="w-fit" disabled={!canSubmit || submit.isPending} onClick={() => submit.mutate()}>
        <HandCoins className="size-4" /> {submit.isPending ? 'กำลังเบิก…' : 'เบิกเงินทดรอง'}
      </Button>
    </Card>
  );
}
