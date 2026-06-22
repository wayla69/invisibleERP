'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, CreditCard, Clock } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs, Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { statusVariant } from '@/components/ui';

export default function PosOpsPage() {
  return (
    <div>
      <PageHeader title="ลอยัลตี้ & แรงงาน (POS Ops)" description="ระดับสมาชิก (tier), บัตรของขวัญ PIN/เติมเงิน, บัญชีเชื่อ (house account) และลงเวลาทำงาน" />
      <Tabs tabs={[
        { key: 'tiers', label: 'ระดับสมาชิก', content: <Tiers /> },
        { key: 'gift', label: 'บัตรของขวัญ', content: <GiftCards /> },
        { key: 'house', label: 'บัญชีเชื่อ', content: <HouseAccounts /> },
        { key: 'labor', label: 'ลงเวลาทำงาน', content: <Labor /> },
      ]} />
    </div>
  );
}

function Tiers() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['loyalty-tiers'], queryFn: () => api('/api/loyalty/tiers') });
  const [f, setF] = useState({ tier: '', min_lifetime: '', earn_mult: '1', redeem_mult: '1' });
  const [msg, setMsg] = useState('');
  const save = useMutation({ mutationFn: () => api('/api/loyalty/tiers', { method: 'POST', body: JSON.stringify({ tier: f.tier, min_lifetime: Number(f.min_lifetime) || 0, earn_mult: Number(f.earn_mult) || 1, redeem_mult: Number(f.redeem_mult) || 1 }) }), onSuccess: () => { setMsg('✅ บันทึกแล้ว'); setF({ tier: '', min_lifetime: '', earn_mult: '1', redeem_mult: '1' }); qc.invalidateQueries({ queryKey: ['loyalty-tiers'] }); }, onError: (e: any) => setMsg(`❌ ${e.message}`) });
  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">เพิ่มระดับสมาชิก</h3>
        <div className="flex flex-wrap gap-2">
          <Input className="max-w-[140px]" placeholder="ชื่อระดับ" value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value })} />
          <Input className="max-w-[160px]" type="number" placeholder="แต้มสะสมขั้นต่ำ" value={f.min_lifetime} onChange={(e) => setF({ ...f, min_lifetime: e.target.value })} />
          <Input className="max-w-[120px]" type="number" placeholder="ตัวคูณสะสม" value={f.earn_mult} onChange={(e) => setF({ ...f, earn_mult: e.target.value })} />
          <Input className="max-w-[120px]" type="number" placeholder="ตัวคูณแลก" value={f.redeem_mult} onChange={(e) => setF({ ...f, redeem_mult: e.target.value })} />
          <Button disabled={!f.tier || save.isPending} onClick={() => save.mutate()}><Plus className="size-4" /> บันทึก</Button>
        </div>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </Card>
      <StateView q={q}>
        {q.data && <DataTable rows={q.data.tiers} columns={[
          { key: 'tier', label: 'ระดับ' }, { key: 'min_lifetime', label: 'แต้มขั้นต่ำ', align: 'right' },
          { key: 'earn_mult', label: 'คูณสะสม', align: 'right', render: (r: any) => `${r.earn_mult}×` },
          { key: 'redeem_mult', label: 'คูณแลก', align: 'right', render: (r: any) => `${r.redeem_mult}×` },
        ]} emptyText="ยังไม่มีระดับสมาชิก" />}
      </StateView>
    </div>
  );
}

function GiftCards() {
  const [card, setCard] = useState('');
  const [pin, setPin] = useState('');
  const [amount, setAmount] = useState('');
  const [msg, setMsg] = useState('');
  const setPinM = useMutation({ mutationFn: () => api(`/api/pos/giftcards/${card}/pin`, { method: 'POST', body: JSON.stringify({ pin }) }), onSuccess: () => setMsg('✅ ตั้ง PIN แล้ว'), onError: (e: any) => setMsg(`❌ ${e.message}`) });
  const check = useMutation({ mutationFn: () => api(`/api/pos/giftcards/${card}/balance?pin=${encodeURIComponent(pin)}`), onSuccess: (r: any) => setMsg(`💳 ยอดคงเหลือ ${baht(r.balance)} (${r.status})`), onError: (e: any) => setMsg(`❌ ${e.message}`) });
  const reload = useMutation({ mutationFn: () => api(`/api/pos/giftcards/${card}/reload`, { method: 'POST', body: JSON.stringify({ amount: Number(amount), pin: pin || undefined }) }), onSuccess: (r: any) => setMsg(`✅ เติมแล้ว · ยอดใหม่ ${baht(r.balance)}`), onError: (e: any) => setMsg(`❌ ${e.message}`) });
  return (
    <Card className="max-w-xl gap-3 p-5">
      <h3 className="text-base font-semibold">บัตรของขวัญ — PIN / เติมเงิน / ตรวจยอด</h3>
      <Input placeholder="เลขบัตร (เช่น GC-...)" value={card} onChange={(e) => setCard(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Input className="max-w-[120px]" placeholder="PIN" value={pin} onChange={(e) => setPin(e.target.value)} />
        <Input className="max-w-[120px]" type="number" placeholder="จำนวนเติม" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={!card || !pin || setPinM.isPending} onClick={() => setPinM.mutate()}>ตั้ง PIN</Button>
        <Button variant="outline" disabled={!card || check.isPending} onClick={() => check.mutate()}><CreditCard className="size-4" /> ตรวจยอด</Button>
        <Button disabled={!card || !amount || reload.isPending} onClick={() => reload.mutate()}>เติมเงิน</Button>
      </div>
      <Msg ok={msg.startsWith('✅') || msg.startsWith('💳')}>{msg}</Msg>
    </Card>
  );
}

function HouseAccounts() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['house-account'], queryFn: () => api('/api/pos/house-account') });
  const [f, setF] = useState({ sale_no: '', amount: '', due_date: '' });
  const [msg, setMsg] = useState('');
  const charge = useMutation({ mutationFn: () => api('/api/pos/house-account', { method: 'POST', body: JSON.stringify({ sale_no: f.sale_no, amount: Number(f.amount), due_date: f.due_date || undefined }) }), onSuccess: () => { setMsg('✅ บันทึกบัญชีเชื่อแล้ว'); setF({ sale_no: '', amount: '', due_date: '' }); qc.invalidateQueries({ queryKey: ['house-account'] }); }, onError: (e: any) => setMsg(`❌ ${e.message}`) });
  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">ขายลงบัญชีเชื่อ (→ ลูกหนี้)</h3>
        <div className="flex flex-wrap gap-2">
          <Input className="max-w-[180px]" placeholder="เลขที่บิล" value={f.sale_no} onChange={(e) => setF({ ...f, sale_no: e.target.value })} />
          <Input className="max-w-[120px]" type="number" placeholder="จำนวน" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          <Input className="max-w-[160px]" type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} />
          <Button disabled={!f.sale_no || !f.amount || charge.isPending} onClick={() => charge.mutate()}>ลงบัญชีเชื่อ</Button>
        </div>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </Card>
      <StateView q={q}>
        {q.data && (
          <>
            <div className="mb-2 text-right text-sm">ยอดค้างชำระรวม <strong>{baht(q.data.outstanding)}</strong></div>
            <DataTable rows={q.data.invoices} columns={[
              { key: 'invoice_no', label: 'เลขที่' }, { key: 'order_no', label: 'บิล' },
              { key: 'amount', label: 'ยอด', align: 'right', render: (r: any) => baht(r.amount) },
              { key: 'paid', label: 'ชำระแล้ว', align: 'right', render: (r: any) => baht(r.paid) },
              { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status === 'Paid' ? 'paid' : 'open')}>{r.status}</Badge> },
            ]} emptyText="ไม่มีบัญชีเชื่อค้างชำระ" />
          </>
        )}
      </StateView>
    </div>
  );
}

function Labor() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['labor-report'], queryFn: () => api('/api/pos/labor/report') });
  const [emp, setEmp] = useState('');
  const [msg, setMsg] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['labor-report'] });
  const cin = useMutation({ mutationFn: () => api('/api/pos/labor/clock-in', { method: 'POST', body: JSON.stringify({ emp_code: emp }) }), onSuccess: () => { setMsg('✅ ลงเวลาเข้าแล้ว'); refresh(); }, onError: (e: any) => setMsg(`❌ ${e.message}`) });
  const cout = useMutation({ mutationFn: () => api('/api/pos/labor/clock-out', { method: 'POST', body: JSON.stringify({ emp_code: emp }) }), onSuccess: (r: any) => { setMsg(`✅ ลงเวลาออก · ${r.hours} ชม.`); refresh(); }, onError: (e: any) => setMsg(`❌ ${e.message}`) });
  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">ลงเวลาทำงาน</h3>
        <div className="flex flex-wrap gap-2">
          <Input className="max-w-[180px]" placeholder="รหัสพนักงาน" value={emp} onChange={(e) => setEmp(e.target.value)} />
          <Button disabled={!emp || cin.isPending} onClick={() => cin.mutate()}><Clock className="size-4" /> เข้า</Button>
          <Button variant="outline" disabled={!emp || cout.isPending} onClick={() => cout.mutate()}>ออก</Button>
        </div>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </Card>
      <StateView q={q}>
        {q.data && (
          <>
            <div className="mb-2 text-sm text-muted-foreground">รวม {q.data.total_hours} ชม. · กำลังทำงาน {q.data.open_count} คน</div>
            <DataTable rows={q.data.entries} columns={[
              { key: 'emp_code', label: 'พนักงาน' },
              { key: 'clock_in', label: 'เข้า', render: (r: any) => thaiDate(r.clock_in) },
              { key: 'clock_out', label: 'ออก', render: (r: any) => thaiDate(r.clock_out) },
              { key: 'break_minutes', label: 'พัก (น)', align: 'right' },
              { key: 'hours', label: 'ชั่วโมง', align: 'right' },
            ]} emptyText="ยังไม่มีบันทึกเวลา" />
          </>
        )}
      </StateView>
    </div>
  );
}
