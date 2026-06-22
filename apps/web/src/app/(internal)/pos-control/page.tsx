'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
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

const selectCls = 'h-9 rounded-md border border-input bg-transparent px-3 text-sm';

export default function PosControlPage() {
  return (
    <div>
      <PageHeader title="ควบคุม POS (พักบิล & อนุมัติ)" description="บิลที่พักไว้ (park/recall), การอนุมัติของผู้จัดการ, รหัสเหตุผล และบันทึกการตรวจสอบ (audit)" />
      <Tabs tabs={[
        { key: 'held', label: 'บิลที่พัก', content: <Held /> },
        { key: 'override', label: 'การอนุมัติ', content: <Overrides /> },
        { key: 'reasons', label: 'รหัสเหตุผล', content: <ReasonCodes /> },
        { key: 'audit', label: 'บันทึกตรวจสอบ', content: <AuditLog /> },
      ]} />
    </div>
  );
}

function ReasonCodes() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['reason-codes'], queryFn: () => api('/api/pos/audit/reason-codes') });
  const [f, setF] = useState({ code: '', label: '', applies_to: 'all' });
  const [msg, setMsg] = useState('');
  const save = useMutation({
    mutationFn: () => api('/api/pos/audit/reason-codes', { method: 'POST', body: JSON.stringify({ code: f.code, label: f.label, applies_to: f.applies_to }) }),
    onSuccess: () => { setMsg('✅ บันทึกแล้ว'); setF({ code: '', label: '', applies_to: 'all' }); qc.invalidateQueries({ queryKey: ['reason-codes'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/pos/audit/reason-codes/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['reason-codes'] }) });
  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">เพิ่มรหัสเหตุผล</h3>
        <div className="flex flex-wrap gap-2">
          <Input className="max-w-[140px]" placeholder="รหัส" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
          <Input className="max-w-[200px]" placeholder="คำอธิบาย" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
          <select className={selectCls} value={f.applies_to} onChange={(e) => setF({ ...f, applies_to: e.target.value })}>{['all', 'void', 'discount', 'price_override', 'no_sale', 'return', 'refund', 'paid_out'].map((a) => <option key={a} value={a}>{a}</option>)}</select>
          <Button disabled={!f.code || !f.label || save.isPending} onClick={() => save.mutate()}>บันทึก</Button>
        </div>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </Card>
      <StateView q={q}>
        {q.data && <DataTable rows={q.data.reason_codes} columns={[
          { key: 'code', label: 'รหัส' }, { key: 'label', label: 'คำอธิบาย' }, { key: 'applies_to', label: 'ใช้กับ' },
          { key: 'act', label: '', render: (r: any) => <Button size="sm" variant="destructive" onClick={() => del.mutate(r.id)}>ปิดใช้</Button> },
        ]} emptyText="ยังไม่มีรหัสเหตุผล" />}
      </StateView>
    </div>
  );
}

function AuditLog() {
  const q = useQuery<any>({ queryKey: ['pos-audit'], queryFn: () => api('/api/pos/audit?limit=100') });
  return (
    <StateView q={q}>
      {q.data && <DataTable rows={q.data.entries} columns={[
        { key: 'ts', label: 'เวลา', render: (r: any) => thaiDate(r.ts) },
        { key: 'actor', label: 'ผู้ทำ' },
        { key: 'action', label: 'การทำงาน', render: (r: any) => <Badge variant={statusVariant('open')}>{r.action}</Badge> },
        { key: 'entity_id', label: 'อ้างอิง' },
        { key: 'meta', label: 'เหตุผล/ผู้อนุมัติ', render: (r: any) => r.meta ? `${r.meta.reason_code ?? ''} ${r.meta.approved_by ? '· ' + r.meta.approved_by : ''}`.trim() || '—' : '—' },
      ]} emptyText="ยังไม่มีบันทึกตรวจสอบ" />}
    </StateView>
  );
}

function Held() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['held'], queryFn: () => api('/api/pos/held') });
  const act = useMutation({ mutationFn: (v: { no: string; op: string }) => api(`/api/pos/held/${v.no}/${v.op}`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['held'] }), onError: (e: any) => toast.error(e.message) });
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
            { key: 'act', label: '', render: (r: any) => <div className="flex gap-1"><Button size="sm" onClick={() => act.mutate({ no: r.hold_no, op: 'recall' })}>เรียกคืน</Button><Button size="sm" variant="destructive" onClick={() => { if (window.confirm(`ทิ้งบิลที่พักไว้ ${r.hold_no}? การกระทำนี้ย้อนกลับไม่ได้`)) act.mutate({ no: r.hold_no, op: 'discard' }); }}>ทิ้ง</Button></div> },
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
          <Button disabled={create.isPending} onClick={() => {
            // A void reverses a sale — require a reason + approver and confirm before recording.
            if (f.action === 'void') {
              if (!f.reason.trim() || !f.approved_by.trim()) { setMsg('❌ การยกเลิก (void) ต้องระบุเหตุผลและผู้อนุมัติ'); return; }
              if (!window.confirm(`ยืนยันการยกเลิกบิล ${f.sale_no || '(ไม่ระบุ)'}? การกระทำนี้ย้อนกลับไม่ได้`)) return;
            }
            create.mutate();
          }}>บันทึก</Button>
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
