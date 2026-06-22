'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs, Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { statusVariant } from '@/components/ui';

export default function PosFiscalPage() {
  return (
    <div>
      <PageHeader title="ภาษีอิเล็กทรอนิกส์ (Fiscal)" description="สมุดบันทึกอิเล็กทรอนิกส์แบบ hash-chain (ตรวจสอบการแก้ไข) และการนำส่ง e-Tax Invoice กับกรมสรรพากร" />
      <Tabs tabs={[{ key: 'journal', label: 'สมุดบันทึก (Journal)', content: <Journal /> }, { key: 'etax', label: 'นำส่ง e-Tax', content: <Etax /> }]} />
    </div>
  );
}

function Journal() {
  const q = useQuery<any>({ queryKey: ['pos-journal'], queryFn: () => api('/api/pos/journal?limit=100') });
  const [verify, setVerify] = useState<any>(null);
  const run = useMutation({ mutationFn: () => api('/api/pos/journal/verify'), onSuccess: (r: any) => setVerify(r) });
  return (
    <div className="space-y-4">
      <Card className="flex-row items-center gap-3 p-5">
        <Button disabled={run.isPending} onClick={() => run.mutate()}><ShieldCheck className="size-4" /> ตรวจสอบความถูกต้องของสมุด</Button>
        {verify && (verify.ok
          ? <Badge variant={statusVariant('paid')}>ถูกต้อง · {verify.length} รายการ</Badge>
          : <Badge variant={statusVariant('cancelled')}>พบการแก้ไขที่ลำดับ {verify.broken_at} ({verify.reason})</Badge>)}
      </Card>
      <StateView q={q}>
        {q.data && (
          <DataTable rows={q.data.entries} columns={[
            { key: 'seq', label: 'ลำดับ', align: 'right' },
            { key: 'doc_type', label: 'ชนิด' },
            { key: 'doc_no', label: 'เลขที่' },
            { key: 'created_at', label: 'เวลา', render: (r: any) => thaiDate(r.created_at) },
            { key: 'hash', label: 'Hash', render: (r: any) => <span className="font-mono text-xs">{String(r.hash).slice(0, 16)}…</span> },
          ]} emptyText="ยังไม่มีรายการในสมุด" />
        )}
      </StateView>
    </div>
  );
}

function Etax() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['etax'], queryFn: () => api('/api/tax/etax?limit=100') });
  const [docNo, setDocNo] = useState('');
  const [msg, setMsg] = useState('');
  const submit = useMutation({
    mutationFn: () => api(`/api/tax/etax/submit/${docNo}`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (r: any) => { setMsg(`✅ ${r.doc_no} → ${r.status}${r.idempotent ? ' (ส่งซ้ำ)' : ''}`); qc.invalidateQueries({ queryKey: ['etax'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">นำส่งใบกำกับภาษีอิเล็กทรอนิกส์</h3>
        <div className="flex gap-2">
          <Input className="max-w-[240px]" placeholder="เลขที่เอกสาร (เช่น TIV-202606-0001)" value={docNo} onChange={(e) => setDocNo(e.target.value)} />
          <Button disabled={!docNo || submit.isPending} onClick={() => submit.mutate()}><Send className="size-4" /> นำส่ง</Button>
        </div>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </Card>
      <StateView q={q}>
        {q.data && (
          <DataTable rows={q.data.submissions} columns={[
            { key: 'doc_no', label: 'เลขที่' },
            { key: 'provider', label: 'ผู้ให้บริการ' },
            { key: 'provider_ref', label: 'อ้างอิง' },
            { key: 'submitted_at', label: 'นำส่งเมื่อ', render: (r: any) => thaiDate(r.submitted_at) },
            { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status === 'Accepted' ? 'paid' : r.status === 'Rejected' ? 'cancelled' : 'open')}>{r.status}</Badge> },
          ]} emptyText="ยังไม่มีการนำส่ง" />
        )}
      </StateView>
    </div>
  );
}
