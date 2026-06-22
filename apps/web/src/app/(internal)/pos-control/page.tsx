'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs, Msg } from '@/components/tabs';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

const selectCls = 'h-9 rounded-md border border-input bg-transparent px-3 text-sm';

export default function PosControlPage() {
  return (
    <div>
      <PageHeader title="ควบคุม POS (พักบิล & อนุมัติ)" description="บิลที่พักไว้ (park/recall) และบันทึกการอนุมัติของผู้จัดการ (void/ส่วนลด/แก้ราคา)" />
      <Tabs tabs={[{ key: 'held', label: 'บิลที่พัก', content: <Held /> }, { key: 'override', label: 'การอนุมัติ', content: <Overrides /> }]} />
    </div>
  );
}

function Held() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['held'], queryFn: () => api('/api/pos/held') });
  const act = useMutation({ mutationFn: (v: { no: string; op: string }) => api(`/api/pos/held/${v.no}/${v.op}`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['held'] }) });
  return (
    <StateView q={q}>
      {q.data && (
        <DataTable
          rows={q.data.held}
          columns={[
            { key: 'hold_no', label: 'เลขที่' },
            { key: 'label', label: 'ป้าย/โต๊ะ' },
            { key: 'customer_name', label: 'ลูกค้า' },
            { key: 'created_by', label: 'พักโดย' },
            { key: 'created_at', label: 'เวลา', render: (r: any) => thaiDate(r.created_at) },
            { key: 'act', label: '', render: (r: any) => <div className="flex gap-1"><Button size="sm" onClick={() => act.mutate({ no: r.hold_no, op: 'recall' })}>เรียกคืน</Button><Button size="sm" variant="destructive" onClick={() => act.mutate({ no: r.hold_no, op: 'discard' })}>ทิ้ง</Button></div> },
          ]}
          emptyText="ไม่มีบิลที่พักไว้"
        />
      )}
    </StateView>
  );
}

function Overrides() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['overrides'], queryFn: () => api('/api/pos/overrides') });
  const [f, setF] = useState({ action: 'discount', sale_no: '', amount: '', reason: '', approved_by: '' });
  const [msg, setMsg] = useState('');
  const create = useMutation({
    mutationFn: () => api('/api/pos/override', { method: 'POST', body: JSON.stringify({ action: f.action, sale_no: f.sale_no || undefined, amount: f.amount ? Number(f.amount) : undefined, reason: f.reason || undefined, approved_by: f.approved_by || undefined }) }),
    onSuccess: (r: any) => { setMsg(`✅ บันทึก ${r.override_no}`); setF({ action: 'discount', sale_no: '', amount: '', reason: '', approved_by: '' }); qc.invalidateQueries({ queryKey: ['overrides'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">บันทึกการอนุมัติ</h3>
        <div className="flex flex-wrap gap-2">
          <select className={selectCls} value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}>{['void', 'discount', 'price_override', 'no_sale', 'return'].map((a) => <option key={a} value={a}>{a}</option>)}</select>
          <Input className="max-w-[140px]" placeholder="เลขที่บิล" value={f.sale_no} onChange={(e) => setF({ ...f, sale_no: e.target.value })} />
          <Input className="max-w-[110px]" type="number" placeholder="จำนวน" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          <Input className="max-w-[160px]" placeholder="เหตุผล" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
          <Input className="max-w-[140px]" placeholder="ผู้อนุมัติ" value={f.approved_by} onChange={(e) => setF({ ...f, approved_by: e.target.value })} />
          <Button disabled={create.isPending} onClick={() => create.mutate()}>บันทึก</Button>
        </div>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </Card>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.overrides}
            columns={[
              { key: 'override_no', label: 'เลขที่' },
              { key: 'action', label: 'การทำงาน' },
              { key: 'sale_no', label: 'บิล' },
              { key: 'amount', label: 'จำนวน', align: 'right', render: (r: any) => r.amount != null ? baht(r.amount) : '—' },
              { key: 'reason', label: 'เหตุผล' },
              { key: 'requested_by', label: 'ขอโดย' },
              { key: 'approved_by', label: 'อนุมัติโดย' },
            ]}
            emptyText="ยังไม่มีรายการอนุมัติ"
          />
        )}
      </StateView>
    </div>
  );
}
