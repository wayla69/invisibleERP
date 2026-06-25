'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CreditCard, Banknote, ListChecks, Layers } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { cn } from '@/lib/utils';
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

const selectCls = 'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

function Field({ label, htmlFor, hint, className, children }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function TerminalsPage() {
  return (
    <div>
      <PageHeader title="เครื่องรับบัตร & สรุปยอด (Terminals)" description="รับชำระผ่านบัตร (sale/pre-auth/capture/void/refund) และสรุปยอด (settlement)" />
      <Tabs tabs={[{ key: 'terminals', label: 'เครื่อง & ชำระ', content: <Terminals /> }, { key: 'settle', label: 'สรุปยอด', content: <Settlements /> }]} />
    </div>
  );
}

function Terminals() {
  const qc = useQueryClient();
  const terms = useQuery<any>({ queryKey: ['terminals'], queryFn: () => api('/api/payments/terminal/terminals') });
  const intents = useQuery<any>({ queryKey: ['intents'], queryFn: () => api('/api/payments/terminal/intents') });
  const [t, setT] = useState({ terminal_code: '', name: '' });
  const [c, setC] = useState({ terminal_code: '', amount: '', type: 'sale', sale_no: '', record_tender: false });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['terminals'] }); qc.invalidateQueries({ queryKey: ['intents'] }); };
  const reg = useMutation({ mutationFn: () => api('/api/payments/terminal/register', { method: 'POST', body: JSON.stringify({ terminal_code: t.terminal_code, name: t.name || undefined }) }), onSuccess: () => { notifySuccess('เพิ่มเครื่องแล้ว'); setT({ terminal_code: '', name: '' }); refresh(); }, onError: (e: any) => notifyError(e.message) });
  const charge = useMutation({ mutationFn: () => api('/api/payments/terminal/charge', { method: 'POST', body: JSON.stringify({ terminal_code: c.terminal_code || undefined, amount: Number(c.amount), type: c.type, sale_no: c.sale_no || undefined, record_tender: c.record_tender }) }), onSuccess: (r: any) => { notifySuccess(`${r.intent_no} → ${r.status}${r.payment_no ? ` · tender ${r.payment_no}` : ''}`); setC({ terminal_code: '', amount: '', type: 'sale', sale_no: '', record_tender: false }); refresh(); }, onError: (e: any) => notifyError(e.message) });
  const act = useMutation({ mutationFn: (v: { no: string; op: string; body?: any }) => api(`/api/payments/terminal/intents/${v.no}/${v.op}`, { method: 'POST', body: JSON.stringify(v.body ?? {}) }), onSuccess: () => refresh(), onError: (e: any) => notifyError(e.message) });

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">เพิ่มเครื่องรับบัตร</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <Field label="รหัสเครื่อง" htmlFor="t-code"><Input id="t-code" placeholder="เช่น TERM1" value={t.terminal_code} onChange={(e) => setT({ ...t, terminal_code: e.target.value })} /></Field>
            <Field label="ชื่อ (ไม่บังคับ)" htmlFor="t-name"><Input id="t-name" placeholder="เช่น เคาน์เตอร์หน้า" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} /></Field>
            <Button className="w-fit" disabled={!t.terminal_code || reg.isPending} onClick={() => reg.mutate()}><CreditCard className="size-4" /> {reg.isPending ? 'กำลังเพิ่ม…' : 'เพิ่มเครื่อง'}</Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">รับชำระ (ทดสอบ)</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="รหัสเครื่อง" htmlFor="c-term"><Input id="c-term" placeholder="เช่น TERM1" value={c.terminal_code} onChange={(e) => setC({ ...c, terminal_code: e.target.value })} /></Field>
              <Field label="จำนวน (บาท)" htmlFor="c-amt"><Input id="c-amt" type="number" inputMode="decimal" placeholder="0" value={c.amount} onChange={(e) => setC({ ...c, amount: e.target.value })} /></Field>
              <Field label="ประเภท" htmlFor="c-type">
                <select id="c-type" className={selectCls} value={c.type} onChange={(e) => setC({ ...c, type: e.target.value })}>
                  <option value="sale">ขาย (capture)</option><option value="preauth">กันวงเงิน (pre-auth)</option>
                </select>
              </Field>
              <Field label="เลขที่บิล (ไม่บังคับ)" htmlFor="c-sale"><Input id="c-sale" placeholder="SALE-…" value={c.sale_no} onChange={(e) => setC({ ...c, sale_no: e.target.value })} /></Field>
            </div>
            <label className="flex items-center gap-2 text-sm" title="บันทึกเป็นการชำระของบิล (ให้ปิดลิ้นชัก/รายงานเห็น)">
              <input type="checkbox" className="size-4 accent-primary" checked={c.record_tender} onChange={(e) => setC({ ...c, record_tender: e.target.checked })} /> ลงรายการชำระ (ผูกกับบิล)
            </label>
            <Button disabled={!c.amount || charge.isPending} onClick={() => charge.mutate()}><Banknote className="size-4" /> {charge.isPending ? 'กำลังรับชำระ…' : 'รับชำระ'}</Button>
          </CardContent>
        </Card>
      </div>
      <StateView q={terms}>{terms.data && <DataTable rows={terms.data.terminals} rowKey={(r: any) => r.terminal_code} columns={[{ key: 'terminal_code', label: 'รหัส' }, { key: 'name', label: 'ชื่อ', render: (r: any) => r.name || '—' }, { key: 'provider', label: 'ผู้ให้บริการ' }, { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status === 'active' ? 'active' : 'cancelled')}>{r.status}</Badge> }]} emptyState={{ icon: CreditCard, title: 'ยังไม่มีเครื่องรับบัตร', description: 'เพิ่มเครื่องรับบัตรเครื่องแรกด้วยฟอร์ม “เพิ่มเครื่องรับบัตร” ด้านบน' }} />}</StateView>
      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">รายการชำระ (Intents)</h3>
        <StateView q={intents}>
          {intents.data && (
            <DataTable
              rows={intents.data.intents}
              rowKey={(r: any) => r.intent_no}
              columns={[
                { key: 'intent_no', label: 'เลขที่' },
                { key: 'type', label: 'ประเภท' },
                { key: 'amount', label: 'ยอด', align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
                { key: 'captured_amount', label: 'จับยอด', align: 'right', render: (r: any) => <span className="tabular">{baht(r.captured_amount)}</span> },
                { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                { key: 'act', label: '', sortable: false, render: (r: any) => {
                  // Disable this row's actions while a mutation against it is in flight — a double-click
                  // must not fire a duplicate capture / void / refund (real money movement).
                  const busy = act.isPending && act.variables?.no === r.intent_no;
                  return (
                  <div className="flex gap-1">
                    {r.status === 'Authorized' && <Button size="sm" disabled={busy} onClick={() => act.mutate({ no: r.intent_no, op: 'capture' })}>จับยอด</Button>}
                    {r.status === 'Authorized' && <Button size="sm" variant="outline" disabled={busy} onClick={() => act.mutate({ no: r.intent_no, op: 'void' })}>ยกเลิก</Button>}
                    {r.status === 'Captured' && <Button size="sm" variant="destructive" disabled={busy} onClick={() => { const a = prompt('จำนวนคืนเงิน'); if (a) act.mutate({ no: r.intent_no, op: 'refund', body: { amount: Number(a) } }); }}>คืนเงิน</Button>}
                  </div>
                  );
                } },
              ]}
              emptyState={{ icon: ListChecks, title: 'ยังไม่มีรายการชำระ', description: 'รับชำระผ่านการ์ดด้วยฟอร์ม “รับชำระ (ทดสอบ)” เพื่อสร้างรายการแรก' }}
            />
          )}
        </StateView>
      </div>
    </div>
  );
}

function Settlements() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['settlements'], queryFn: () => api('/api/payments/terminal/settlements') });
  const [fee, setFee] = useState('2');
  const settle = useMutation({ mutationFn: () => api('/api/payments/terminal/settle', { method: 'POST', body: JSON.stringify({ fee_pct: Number(fee) }) }), onSuccess: (r: any) => { notifySuccess(`สรุปยอด ${r.batch_no}: ${r.txn_count} รายการ`); qc.invalidateQueries({ queryKey: ['settlements'] }); }, onError: (e: any) => notifyError(e.message) });
  const reconcile = useMutation({ mutationFn: (no: string) => api(`/api/payments/terminal/settlements/${no}/reconcile`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['settlements'] }) });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">สรุปยอดประจำรอบ (Settlement)</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-end gap-2">
            <Field label="ค่าธรรมเนียม %" htmlFor="s-fee" className="max-w-[140px]"><Input id="s-fee" type="number" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} /></Field>
            <Button disabled={settle.isPending} onClick={() => settle.mutate()}>{settle.isPending ? 'กำลังสรุป…' : 'สรุปยอดที่จับแล้ว'}</Button>
          </div>
        </CardContent>
      </Card>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.batches}
            rowKey={(r: any) => r.batch_no}
            columns={[
              { key: 'batch_no', label: 'เลขที่รอบ' },
              { key: 'batch_date', label: 'วันที่' },
              { key: 'gross', label: 'ยอดรวม', align: 'right', render: (r: any) => <span className="tabular">{baht(r.gross)}</span> },
              { key: 'fees', label: 'ค่าธรรมเนียม', align: 'right', render: (r: any) => <span className="tabular">{baht(r.fees)}</span> },
              { key: 'net', label: 'สุทธิ', align: 'right', render: (r: any) => <span className="tabular">{baht(r.net)}</span> },
              { key: 'txn_count', label: 'จำนวน', align: 'right' },
              { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status === 'Reconciled' ? 'paid' : 'open')}>{r.status}</Badge> },
              { key: 'act', label: '', sortable: false, render: (r: any) => r.status !== 'Reconciled' ? <Button size="sm" variant="outline" disabled={reconcile.isPending && reconcile.variables === r.batch_no} onClick={() => reconcile.mutate(r.batch_no)}>กระทบยอด</Button> : null },
            ]}
            emptyState={{ icon: Layers, title: 'ยังไม่มีรอบสรุปยอด', description: 'กด “สรุปยอดที่จับแล้ว” เพื่อปิดรอบและสร้าง batch สรุปยอดแรก' }}
          />
        )}
      </StateView>
    </div>
  );
}
