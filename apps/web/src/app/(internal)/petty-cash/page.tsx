'use client';

// Petty cash imprest float (วงเงิน) + direct-expense / advance maker-checker with document tracking (EXP-08).
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { HandCoins, Wallet, ReceiptText } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
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

const selectCls = 'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';
const reqStatusVariant = (s: string) => (s === 'Approved' ? 'success' : s === 'Rejected' ? 'destructive' : s === 'Settled' ? 'secondary' : 'warning');
const reqStatusTh = (s: string) => ({ PendingApproval: 'รออนุมัติ', Approved: 'อนุมัติแล้ว', Rejected: 'ปฏิเสธ', Settled: 'เคลียร์แล้ว' } as Record<string, string>)[s] ?? s;

export default function PettyCashPage() {
  return (
    <div>
      <PageHeader title="กองทุนเงินสดย่อย & ค่าใช้จ่าย (Petty cash)" description="วงเงินกองทุน · เปิดค่าใช้จ่ายตรง/เงินเบิกล่วงหน้า · อนุมัติแบบแยกหน้าที่ · ติดตามเอกสาร (EXP-08)" />
      <Tabs
        tabs={[
          { key: 'funds', label: 'กองทุน (Funds)', content: <FundsTab /> },
          { key: 'requests', label: 'เปิดค่าใช้จ่าย / เบิกล่วงหน้า', content: <RequestsTab /> },
          { key: 'approvals', label: 'อนุมัติ (Maker-checker)', content: <ApprovalsTab /> },
        ]}
      />
    </div>
  );
}

function FundsTab() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['pc-funds'], queryFn: () => api('/api/finance/petty-cash/funds') });
  const [code, setCode] = useState(''); const [name, setName] = useState(''); const [floatLimit, setFloatLimit] = useState(''); const [initial, setInitial] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['pc-funds'] });

  const create = useMutation({
    mutationFn: () => api<any>('/api/finance/petty-cash/funds', { method: 'POST', body: JSON.stringify({ fund_code: code, name: name || undefined, float_limit: Number(floatLimit), initial_amount: initial ? Number(initial) : undefined }) }),
    onSuccess: (r: any) => { notifySuccess(`เปิดกองทุน ${r.fund_code} (วงเงิน ${baht(r.float_limit)})`); setCode(''); setName(''); setFloatLimit(''); setInitial(''); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const replenish = useMutation({
    mutationFn: (fundCode: string) => { const amt = window.prompt('จำนวนเงินเติมกองทุน'); if (!amt) throw new Error('ยกเลิก'); return api<any>(`/api/finance/petty-cash/funds/${fundCode}/replenish`, { method: 'POST', body: JSON.stringify({ amount: Number(amt) }) }); },
    onSuccess: (r: any) => { notifySuccess(`เติมกองทุน ${r.fund_code} → คงเหลือ ${baht(r.balance)}`); refresh(); },
    onError: (e: any) => { if (e.message !== 'ยกเลิก') notifyError(e.message); },
  });

  const funds: any[] = q.data?.funds ?? [];
  return (
    <div className="space-y-5">
      <Card className="max-w-3xl gap-4 p-5">
        <h3 className="text-base font-semibold">เปิดกองทุนเงินสดย่อย (กำหนดวงเงิน)</h3>
        <div className="grid gap-4 sm:grid-cols-4">
          <div className="grid gap-1.5"><Label>รหัสกองทุน</Label><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="PCF-1" /></div>
          <div className="grid gap-1.5"><Label>ชื่อ/แผนก</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="สำนักงานใหญ่" /></div>
          <div className="grid gap-1.5"><Label>วงเงิน (Float)</Label><Input type="number" min="0" value={floatLimit} onChange={(e) => setFloatLimit(e.target.value)} placeholder="5000" /></div>
          <div className="grid gap-1.5"><Label>เงินตั้งต้น</Label><Input type="number" min="0" value={initial} onChange={(e) => setInitial(e.target.value)} placeholder="5000" /></div>
        </div>
        <div><Button disabled={!code || !floatLimit || create.isPending} onClick={() => create.mutate()}><Wallet className="size-4" /> เปิดกองทุน</Button></div>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={funds}
            columns={[
              { key: 'fund_code', label: 'รหัส' },
              { key: 'name', label: 'ชื่อ', render: (r: any) => r.name ?? '—' },
              { key: 'float_limit', label: 'วงเงิน', align: 'right', render: (r: any) => <span className="tabular">{baht(r.float_limit)}</span> },
              { key: 'balance', label: 'คงเหลือ', align: 'right', render: (r: any) => <span className="tabular">{baht(r.balance)}</span> },
              { key: 'available', label: 'เติมได้อีก', align: 'right', render: (r: any) => <span className="tabular text-muted-foreground">{baht(r.available)}</span> },
              { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={r.status === 'active' ? 'success' : 'muted'}>{r.status}</Badge> },
              { key: 'act', label: '', align: 'right', render: (r: any) => <Button size="sm" variant="outline" disabled={replenish.isPending} onClick={() => replenish.mutate(r.fund_code)}>เติมเงิน</Button> },
            ]}
            emptyState={{ icon: Wallet, title: 'ยังไม่มีกองทุน', description: 'เปิดกองทุนเงินสดย่อยพร้อมกำหนดวงเงินด้านบน' }}
          />
        )}
      </StateView>
    </div>
  );
}

function RequestsTab() {
  const qc = useQueryClient();
  const funds = useQuery<any>({ queryKey: ['pc-funds'], queryFn: () => api('/api/finance/petty-cash/funds') });
  const q = useQuery<any>({ queryKey: ['pc-requests'], queryFn: () => api('/api/finance/petty-cash/requests') });
  const [fundCode, setFundCode] = useState(''); const [kind, setKind] = useState('expense'); const [payee, setPayee] = useState(''); const [amount, setAmount] = useState(''); const [docRef, setDocRef] = useState(''); const [purpose, setPurpose] = useState('');
  const refresh = () => { qc.invalidateQueries({ queryKey: ['pc-requests'] }); qc.invalidateQueries({ queryKey: ['pc-funds'] }); qc.invalidateQueries({ queryKey: ['pc-pending'] }); };

  const create = useMutation({
    mutationFn: () => api<any>('/api/finance/petty-cash/requests', { method: 'POST', body: JSON.stringify({ fund_code: fundCode, kind, payee: payee || undefined, amount: Number(amount), doc_ref: docRef || undefined, purpose: purpose || undefined }) }),
    onSuccess: (r: any) => { notifySuccess(`ส่งคำขอ ${r.req_no} (${baht(r.amount)}) — รอผู้อื่นอนุมัติ`); setPayee(''); setAmount(''); setDocRef(''); setPurpose(''); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const settle = useMutation({
    mutationFn: (reqNo: string) => { const sp = window.prompt('ยอดใช้จ่ายจริง (settled expense)'); if (sp == null) throw new Error('ยกเลิก'); const rc = window.prompt('เงินคืนกองทุน (returned cash)', '0') ?? '0'; return api<any>(`/api/finance/petty-cash/requests/${reqNo}/settle`, { method: 'POST', body: JSON.stringify({ settled_expense: Number(sp), returned_cash: Number(rc) }) }); },
    onSuccess: () => { notifySuccess('เคลียร์เงินเบิกล่วงหน้าแล้ว'); refresh(); },
    onError: (e: any) => { if (e.message !== 'ยกเลิก') notifyError(e.message); },
  });

  const fundList: any[] = funds.data?.funds ?? [];
  return (
    <div className="space-y-5">
      <Card className="max-w-4xl gap-4 p-5">
        <h3 className="text-base font-semibold">เปิดค่าใช้จ่ายโดยตรง / เงินเบิกล่วงหน้า</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-1.5"><Label>กองทุน</Label>
            <select className={selectCls} value={fundCode} onChange={(e) => setFundCode(e.target.value)}>
              <option value="">— เลือกกองทุน —</option>
              {fundList.map((f: any) => <option key={f.fund_code} value={f.fund_code}>{f.fund_code} (คงเหลือ {baht(f.balance)})</option>)}
            </select>
          </div>
          <div className="grid gap-1.5"><Label>ประเภท</Label>
            <select className={selectCls} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="expense">ค่าใช้จ่ายโดยตรง (Expense)</option>
              <option value="advance">เงินเบิกล่วงหน้า (Advance)</option>
            </select>
          </div>
          <div className="grid gap-1.5"><Label>จำนวนเงิน</Label><Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label>ผู้รับ / ผู้เบิก</Label><Input value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="ชื่อ" /></div>
          <div className="grid gap-1.5"><Label>เลขที่เอกสาร/ใบเสร็จ</Label><Input value={docRef} onChange={(e) => setDocRef(e.target.value)} placeholder="RCPT-001" /></div>
          <div className="grid gap-1.5"><Label>รายละเอียด</Label><Input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="ค่าเดินทาง" /></div>
        </div>
        <div><Button disabled={!fundCode || !amount || create.isPending} onClick={() => create.mutate()}><ReceiptText className="size-4" /> ส่งคำขอ</Button></div>
        <p className="text-xs text-muted-foreground">คำขอจะยังไม่ลงบัญชี จนกว่าจะมี “คนอื่น” อนุมัติ (แบ่งแยกหน้าที่) และต้องไม่เกินยอดคงเหลือในกองทุน</p>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.requests}
            columns={[
              { key: 'req_no', label: 'เลขที่' },
              { key: 'kind', label: 'ประเภท', render: (r: any) => <Badge variant={r.kind === 'advance' ? 'secondary' : 'default'}>{r.kind === 'advance' ? 'เบิกล่วงหน้า' : 'ค่าใช้จ่าย'}</Badge> },
              { key: 'payee', label: 'ผู้รับ', render: (r: any) => r.payee ?? '—' },
              { key: 'amount', label: 'จำนวน', align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
              { key: 'doc_ref', label: 'เอกสาร', render: (r: any) => r.doc_ref ?? '—' },
              { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={reqStatusVariant(r.status)}>{reqStatusTh(r.status)}</Badge> },
              { key: 'act', label: '', align: 'right', render: (r: any) => (r.kind === 'advance' && r.status === 'Approved' ? <Button size="sm" variant="outline" disabled={settle.isPending} onClick={() => settle.mutate(r.req_no)}>เคลียร์</Button> : null) },
            ]}
            emptyState={{ icon: ReceiptText, title: 'ยังไม่มีรายการ' }}
          />
        )}
      </StateView>
    </div>
  );
}

function ApprovalsTab() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['pc-pending'], queryFn: () => api('/api/finance/petty-cash/requests?status=PendingApproval') });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['pc-pending'] }); qc.invalidateQueries({ queryKey: ['pc-requests'] }); qc.invalidateQueries({ queryKey: ['pc-funds'] }); };
  const approve = useMutation({
    mutationFn: (reqNo: string) => api<any>(`/api/finance/petty-cash/requests/${reqNo}/approve`, { method: 'POST' }),
    onSuccess: (r: any) => { notifySuccess(`อนุมัติ ${r.req_no} — ลงบัญชีแล้ว (คงเหลือกองทุน ${baht(r.fund_balance)})`); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const reject = useMutation({
    mutationFn: (reqNo: string) => api<any>(`/api/finance/petty-cash/requests/${reqNo}/reject`, { method: 'POST', body: JSON.stringify({ reason: window.prompt('เหตุผลที่ปฏิเสธ (ไม่บังคับ)') || undefined }) }),
    onSuccess: () => { notifySuccess('ปฏิเสธคำขอแล้ว'); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const pending: any[] = q.data?.requests ?? [];
  return (
    <div className="space-y-4">
      <StatCard label="คำขอรออนุมัติ" value={num(pending.length)} icon={HandCoins} tone={pending.length ? 'warning' : 'success'} className="max-w-xs" />
      <Card className="gap-3 p-5">
        <p className="text-xs text-muted-foreground">ผู้อนุมัติต้องเป็นคนละคนกับผู้ขอ (แบ่งแยกหน้าที่) — ลงบัญชีและตัดยอดกองทุนเมื่ออนุมัติเท่านั้น</p>
        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={pending}
              emptyState={{ icon: HandCoins, title: 'ไม่มีคำขอที่รออนุมัติ' }}
              columns={[
                { key: 'req_no', label: 'เลขที่' },
                { key: 'kind', label: 'ประเภท', render: (r: any) => (r.kind === 'advance' ? 'เบิกล่วงหน้า' : 'ค่าใช้จ่าย') },
                { key: 'payee', label: 'ผู้รับ', render: (r: any) => r.payee ?? '—' },
                { key: 'amount', label: 'จำนวน', align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
                { key: 'doc_ref', label: 'เอกสาร', render: (r: any) => r.doc_ref ?? '—' },
                { key: 'requested_by', label: 'ผู้ขอ', render: (r: any) => <span className="text-xs text-muted-foreground">{r.requested_by ?? '—'}</span> },
                { key: 'act', label: '', align: 'right', render: (r: any) => (
                  <div className="flex justify-end gap-1.5">
                    <Button size="sm" variant="outline" disabled={approve.isPending} onClick={() => approve.mutate(r.req_no)}>อนุมัติ</Button>
                    <Button size="sm" variant="ghost" disabled={reject.isPending} onClick={() => reject.mutate(r.req_no)}>ปฏิเสธ</Button>
                  </div>
                ) },
              ]}
            />
          )}
        </StateView>
      </Card>
    </div>
  );
}
