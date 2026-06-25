'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CreditCard, Banknote } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs, Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

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
  const [msg, setMsg] = useState('');
  const refresh = () => { qc.invalidateQueries({ queryKey: ['terminals'] }); qc.invalidateQueries({ queryKey: ['intents'] }); };
  const reg = useMutation({ mutationFn: () => api('/api/payments/terminal/register', { method: 'POST', body: JSON.stringify({ terminal_code: t.terminal_code, name: t.name || undefined }) }), onSuccess: () => { setMsg('✅ เพิ่มเครื่องแล้ว'); setT({ terminal_code: '', name: '' }); refresh(); }, onError: (e: any) => setMsg(`❌ ${e.message}`) });
  const charge = useMutation({ mutationFn: () => api('/api/payments/terminal/charge', { method: 'POST', body: JSON.stringify({ terminal_code: c.terminal_code || undefined, amount: Number(c.amount), type: c.type, sale_no: c.sale_no || undefined, record_tender: c.record_tender }) }), onSuccess: (r: any) => { setMsg(`✅ ${r.intent_no} → ${r.status}${r.payment_no ? ` · tender ${r.payment_no}` : ''}`); setC({ terminal_code: '', amount: '', type: 'sale', sale_no: '', record_tender: false }); refresh(); }, onError: (e: any) => setMsg(`❌ ${e.message}`) });
  const act = useMutation({ mutationFn: (v: { no: string; op: string; body?: any }) => api(`/api/payments/terminal/intents/${v.no}/${v.op}`, { method: 'POST', body: JSON.stringify(v.body ?? {}) }), onSuccess: () => refresh(), onError: (e: any) => setMsg(`❌ ${e.message}`) });
  const selectCls = 'h-9 rounded-md border border-input bg-transparent px-3 text-sm';

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="gap-3 p-5">
          <h3 className="text-base font-semibold">เพิ่มเครื่องรับบัตร</h3>
          <Input placeholder="รหัสเครื่อง (เช่น TERM1)" value={t.terminal_code} onChange={(e) => setT({ ...t, terminal_code: e.target.value })} />
          <Input placeholder="ชื่อ (เลือก)" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} />
          <Button className="w-fit" disabled={!t.terminal_code || reg.isPending} onClick={() => reg.mutate()}><CreditCard className="size-4" /> เพิ่มเครื่อง</Button>
        </Card>
        <Card className="gap-3 p-5">
          <h3 className="text-base font-semibold">รับชำระ (ทดสอบ)</h3>
          <div className="flex flex-wrap gap-2">
            <Input className="max-w-[140px]" placeholder="รหัสเครื่อง" value={c.terminal_code} onChange={(e) => setC({ ...c, terminal_code: e.target.value })} />
            <Input className="max-w-[120px]" type="number" placeholder="จำนวน" value={c.amount} onChange={(e) => setC({ ...c, amount: e.target.value })} />
            <select className={selectCls} value={c.type} onChange={(e) => setC({ ...c, type: e.target.value })}><option value="sale">ขาย (capture)</option><option value="preauth">กันวงเงิน (pre-auth)</option></select>
            <Input className="max-w-[150px]" placeholder="เลขที่บิล (เลือก)" value={c.sale_no} onChange={(e) => setC({ ...c, sale_no: e.target.value })} />
            <label className="flex items-center gap-1.5 text-sm" title="บันทึกเป็นการชำระของบิล (ให้ปิดลิ้นชัก/รายงานเห็น)"><input type="checkbox" checked={c.record_tender} onChange={(e) => setC({ ...c, record_tender: e.target.checked })} /> ลงรายการชำระ</label>
            <Button disabled={!c.amount || charge.isPending} onClick={() => charge.mutate()}><Banknote className="size-4" /> รับชำระ</Button>
          </div>
          <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
        </Card>
      </div>
      <StateView q={terms}>{terms.data && <DataTable rows={terms.data.terminals} columns={[{ key: 'terminal_code', label: 'รหัส' }, { key: 'name', label: 'ชื่อ' }, { key: 'provider', label: 'ผู้ให้บริการ' }, { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status === 'active' ? 'active' : 'cancelled')}>{r.status}</Badge> }]} emptyText="ยังไม่มีเครื่อง" />}</StateView>
      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">รายการชำระ (Intents)</h3>
        <StateView q={intents}>
          {intents.data && (
            <DataTable
              rows={intents.data.intents}
              columns={[
                { key: 'intent_no', label: 'เลขที่' },
                { key: 'type', label: 'ประเภท' },
                { key: 'amount', label: 'ยอด', align: 'right', render: (r: any) => baht(r.amount) },
                { key: 'captured_amount', label: 'จับยอด', align: 'right', render: (r: any) => baht(r.captured_amount) },
                { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                { key: 'act', label: '', render: (r: any) => {
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
              emptyText="ยังไม่มีรายการชำระ"
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
  const [msg, setMsg] = useState('');
  const settle = useMutation({ mutationFn: () => api('/api/payments/terminal/settle', { method: 'POST', body: JSON.stringify({ fee_pct: Number(fee) }) }), onSuccess: (r: any) => { setMsg(`✅ สรุปยอด ${r.batch_no}: ${r.txn_count} รายการ`); qc.invalidateQueries({ queryKey: ['settlements'] }); }, onError: (e: any) => setMsg(`❌ ${e.message}`) });
  const reconcile = useMutation({ mutationFn: (no: string) => api(`/api/payments/terminal/settlements/${no}/reconcile`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['settlements'] }) });
  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">สรุปยอดประจำรอบ (Settlement)</h3>
        <div className="flex items-end gap-2"><div className="grid gap-1.5"><Label>ค่าธรรมเนียม %</Label><Input className="max-w-[120px]" type="number" value={fee} onChange={(e) => setFee(e.target.value)} /></div><Button disabled={settle.isPending} onClick={() => settle.mutate()}>สรุปยอดที่จับแล้ว</Button></div>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </Card>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.batches}
            columns={[
              { key: 'batch_no', label: 'เลขที่รอบ' },
              { key: 'batch_date', label: 'วันที่' },
              { key: 'gross', label: 'ยอดรวม', align: 'right', render: (r: any) => baht(r.gross) },
              { key: 'fees', label: 'ค่าธรรมเนียม', align: 'right', render: (r: any) => baht(r.fees) },
              { key: 'net', label: 'สุทธิ', align: 'right', render: (r: any) => baht(r.net) },
              { key: 'txn_count', label: 'จำนวน', align: 'right' },
              { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status === 'Reconciled' ? 'paid' : 'open')}>{r.status}</Badge> },
              { key: 'act', label: '', render: (r: any) => r.status !== 'Reconciled' ? <Button size="sm" variant="outline" disabled={reconcile.isPending && reconcile.variables === r.batch_no} onClick={() => reconcile.mutate(r.batch_no)}>กระทบยอด</Button> : null },
            ]}
            emptyText="ยังไม่มีรอบสรุปยอด"
          />
        )}
      </StateView>
    </div>
  );
}
