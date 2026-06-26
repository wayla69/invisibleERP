'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, CreditCard, Clock, Award, Receipt, CalendarClock } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { cn } from '@/lib/utils';
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
import { statusVariant } from '@/components/ui';

/** Labelled form field — a label tied to its control, with an optional helper line. */
function Field({ label, htmlFor, hint, className, children }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

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
  const save = useMutation({ mutationFn: () => api('/api/loyalty/tiers', { method: 'POST', body: JSON.stringify({ tier: f.tier, min_lifetime: Number(f.min_lifetime) || 0, earn_mult: Number(f.earn_mult) || 1, redeem_mult: Number(f.redeem_mult) || 1 }) }), onSuccess: () => { notifySuccess('บันทึกแล้ว'); setF({ tier: '', min_lifetime: '', earn_mult: '1', redeem_mult: '1' }); qc.invalidateQueries({ queryKey: ['loyalty-tiers'] }); }, onError: (e: any) => notifyError(e.message) });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">เพิ่มระดับสมาชิก</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="ชื่อระดับ" htmlFor="t-tier"><Input id="t-tier" placeholder="เช่น Gold" value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value })} /></Field>
            <Field label="แต้มสะสมขั้นต่ำ" htmlFor="t-min"><Input id="t-min" type="number" inputMode="numeric" min={0} placeholder="0" value={f.min_lifetime} onChange={(e) => setF({ ...f, min_lifetime: e.target.value })} /></Field>
            <Field label="ตัวคูณสะสม" htmlFor="t-earn" hint="เช่น 1.5 = ได้แต้ม ×1.5"><Input id="t-earn" type="number" inputMode="decimal" step="0.1" value={f.earn_mult} onChange={(e) => setF({ ...f, earn_mult: e.target.value })} /></Field>
            <Field label="ตัวคูณแลก" htmlFor="t-redeem"><Input id="t-redeem" type="number" inputMode="decimal" step="0.1" value={f.redeem_mult} onChange={(e) => setF({ ...f, redeem_mult: e.target.value })} /></Field>
          </div>
          <Button disabled={!f.tier || save.isPending} onClick={() => save.mutate()}><Plus className="size-4" /> {save.isPending ? 'กำลังบันทึก…' : 'บันทึกระดับ'}</Button>
        </CardContent>
      </Card>
      <StateView q={q}>
        {q.data && <DataTable rows={q.data.tiers} rowKey={(r: any) => r.tier} columns={[
          { key: 'tier', label: 'ระดับ' }, { key: 'min_lifetime', label: 'แต้มขั้นต่ำ', align: 'right' },
          { key: 'earn_mult', label: 'คูณสะสม', align: 'right', render: (r: any) => `${r.earn_mult}×` },
          { key: 'redeem_mult', label: 'คูณแลก', align: 'right', render: (r: any) => `${r.redeem_mult}×` },
        ]} emptyState={{ icon: Award, title: 'ยังไม่มีระดับสมาชิก', description: 'เพิ่มระดับสมาชิกแรกในแบบฟอร์มด้านบนเพื่อกำหนดตัวคูณสะสมและแลกแต้ม' }} />}
      </StateView>
    </div>
  );
}

function GiftCards() {
  const [card, setCard] = useState('');
  const [pin, setPin] = useState('');
  const [amount, setAmount] = useState('');
  const setPinM = useMutation({ mutationFn: () => api(`/api/pos/giftcards/${card}/pin`, { method: 'POST', body: JSON.stringify({ pin }) }), onSuccess: () => notifySuccess('ตั้ง PIN แล้ว'), onError: (e: any) => notifyError(e.message) });
  const check = useMutation({ mutationFn: () => api(`/api/pos/giftcards/${card}/balance?pin=${encodeURIComponent(pin)}`), onSuccess: (r: any) => notifySuccess(`ยอดคงเหลือ ${baht(r.balance)} (${r.status})`), onError: (e: any) => notifyError(e.message) });
  const reload = useMutation({ mutationFn: () => api(`/api/pos/giftcards/${card}/reload`, { method: 'POST', body: JSON.stringify({ amount: Number(amount), pin: pin || undefined }) }), onSuccess: (r: any) => notifySuccess(`เติมแล้ว · ยอดใหม่ ${baht(r.balance)}`), onError: (e: any) => notifyError(e.message) });
  return (
    <Card className="max-w-xl">
      <CardHeader><CardTitle className="text-base">บัตรของขวัญ — PIN / เติมเงิน / ตรวจยอด</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <Field label="เลขบัตร" htmlFor="g-card"><Input id="g-card" placeholder="เช่น GC-0001" value={card} onChange={(e) => setCard(e.target.value)} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="PIN" htmlFor="g-pin"><Input id="g-pin" inputMode="numeric" placeholder="••••" value={pin} onChange={(e) => setPin(e.target.value)} /></Field>
          <Field label="จำนวนเติม (บาท)" htmlFor="g-amt"><Input id="g-amt" type="number" inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={!card || !pin || setPinM.isPending} onClick={() => setPinM.mutate()}>ตั้ง PIN</Button>
          <Button variant="outline" disabled={!card || check.isPending} onClick={() => check.mutate()}><CreditCard className="size-4" /> ตรวจยอด</Button>
          <Button disabled={!card || !amount || reload.isPending} onClick={() => reload.mutate()}>เติมเงิน</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function HouseAccounts() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['house-account'], queryFn: () => api('/api/pos/house-account') });
  const [f, setF] = useState({ sale_no: '', amount: '', due_date: '' });
  const charge = useMutation({ mutationFn: () => api('/api/pos/house-account', { method: 'POST', body: JSON.stringify({ sale_no: f.sale_no, amount: Number(f.amount), due_date: f.due_date || undefined }) }), onSuccess: () => { notifySuccess('บันทึกบัญชีเชื่อแล้ว'); setF({ sale_no: '', amount: '', due_date: '' }); qc.invalidateQueries({ queryKey: ['house-account'] }); }, onError: (e: any) => notifyError(e.message) });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">ขายลงบัญชีเชื่อ (→ ลูกหนี้)</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="เลขที่บิล" htmlFor="h-sale"><Input id="h-sale" placeholder="SALE-…" value={f.sale_no} onChange={(e) => setF({ ...f, sale_no: e.target.value })} /></Field>
            <Field label="จำนวน (บาท)" htmlFor="h-amt"><Input id="h-amt" type="number" inputMode="decimal" placeholder="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
            <Field label="ครบกำหนด" htmlFor="h-due"><Input id="h-due" type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></Field>
          </div>
          <Button disabled={!f.sale_no || !f.amount || charge.isPending} onClick={() => charge.mutate()}>{charge.isPending ? 'กำลังบันทึก…' : 'ลงบัญชีเชื่อ'}</Button>
        </CardContent>
      </Card>
      <StateView q={q}>
        {q.data && (
          <>
            <div className="mb-2 text-right text-sm">ยอดค้างชำระรวม <strong className="tabular">{baht(q.data.outstanding)}</strong></div>
            <DataTable rows={q.data.invoices} rowKey={(r: any) => r.invoice_no} columns={[
              { key: 'invoice_no', label: 'เลขที่' }, { key: 'order_no', label: 'บิล' },
              { key: 'amount', label: 'ยอด', align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
              { key: 'paid', label: 'ชำระแล้ว', align: 'right', render: (r: any) => <span className="tabular">{baht(r.paid)}</span> },
              { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status === 'Paid' ? 'paid' : 'open')}>{r.status}</Badge> },
            ]} emptyState={{ icon: Receipt, title: 'ไม่มีบัญชีเชื่อค้างชำระ', description: 'เมื่อขายลงบัญชีเชื่อ รายการลูกหนี้จะแสดงที่นี่' }} />
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
  const refresh = () => qc.invalidateQueries({ queryKey: ['labor-report'] });
  const cin = useMutation({ mutationFn: () => api('/api/pos/labor/clock-in', { method: 'POST', body: JSON.stringify({ emp_code: emp }) }), onSuccess: () => { notifySuccess('ลงเวลาเข้าแล้ว'); refresh(); }, onError: (e: any) => notifyError(e.message) });
  const cout = useMutation({ mutationFn: () => api('/api/pos/labor/clock-out', { method: 'POST', body: JSON.stringify({ emp_code: emp }) }), onSuccess: (r: any) => { notifySuccess(`ลงเวลาออก · ${r.hours} ชม.`); refresh(); }, onError: (e: any) => notifyError(e.message) });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">ลงเวลาทำงาน</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label="รหัสพนักงาน" htmlFor="l-emp" className="w-full sm:max-w-[220px]"><Input id="l-emp" placeholder="เช่น EMP001" value={emp} onChange={(e) => setEmp(e.target.value)} /></Field>
            <div className="flex gap-2">
              <Button disabled={!emp || cin.isPending} onClick={() => cin.mutate()}><Clock className="size-4" /> เข้า</Button>
              <Button variant="outline" disabled={!emp || cout.isPending} onClick={() => cout.mutate()}>ออก</Button>
            </div>
          </div>
        </CardContent>
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
              { key: 'clock_in_method', label: 'วิธี', render: (r: any) => r.clock_in_method ?? 'PIN' },
              { key: 'geofence_pass', label: 'พิกัด', align: 'center', render: (r: any) => r.geofence_pass === false ? <Badge variant="destructive">นอกพื้นที่</Badge> : r.geofence_pass === true ? <Badge variant="secondary">ในพื้นที่</Badge> : <span className="text-muted-foreground">—</span> },
            ]} emptyState={{ icon: CalendarClock, title: 'ยังไม่มีบันทึกเวลา', description: 'กรอกรหัสพนักงานแล้วกด “เข้า” เพื่อเริ่มลงเวลาทำงาน' }} />
          </>
        )}
      </StateView>
    </div>
  );
}
