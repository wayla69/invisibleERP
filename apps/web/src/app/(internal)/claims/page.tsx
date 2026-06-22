'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs, Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { statusVariant } from '@/components/ui';

export default function ClaimsPage() {
  return (
    <div>
      <PageHeader title="จัดการเคลม (Claims)" description="เคลมจากลูกค้า (ขาย) และเคลมผู้ขาย (รับเข้า)" />
      <Tabs tabs={[{ key: 'sales', label: 'เคลมการขาย', content: <SalesClaims /> }, { key: 'gr', label: 'เคลมผู้ขาย (GR)', content: <GrClaims /> }]} />
    </div>
  );
}

function SalesClaims() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['sales-claims'], queryFn: () => api('/api/claims/sales') });
  const [reason, setReason] = useState<Record<number, string>>({});
  const [msg, setMsg] = useState('');
  const decide = useMutation({
    mutationFn: (v: { id: number; decision: 'approve' | 'reject' }) => api(`/api/claims/sales/${v.id}`, { method: 'PATCH', body: JSON.stringify({ decision: v.decision, reject_reason: reason[v.id] }) }),
    onSuccess: () => { setMsg('✅ บันทึกแล้ว'); qc.invalidateQueries({ queryKey: ['sales-claims'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  return (
    <div className="space-y-3">
      <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.claims}
            columns={[
              { key: 'order_no', label: 'ออเดอร์' },
              { key: 'item_description', label: 'สินค้า' },
              { key: 'claimed_qty', label: 'จำนวน', align: 'right', render: (r: any) => num(r.claimed_qty) },
              { key: 'reason', label: 'เหตุผล' },
              { key: 'admin_status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.admin_status)}>{r.admin_status}</Badge> },
              {
                key: 'act', label: 'ดำเนินการ', render: (r: any) => r.admin_status === 'Waiting' ? (
                  <div className="flex items-center gap-1">
                    <Button size="sm" onClick={() => decide.mutate({ id: r.id, decision: 'approve' })}>อนุมัติ</Button>
                    <Input className="h-8 w-32" placeholder="เหตุผลปฏิเสธ" value={reason[r.id] ?? ''} onChange={(e) => setReason((s) => ({ ...s, [r.id]: e.target.value }))} />
                    <Button size="sm" variant="destructive" onClick={() => decide.mutate({ id: r.id, decision: 'reject' })}>ปฏิเสธ</Button>
                  </div>
                ) : '—',
              },
            ]}
            emptyText="ไม่มีรายการเคลม"
          />
        )}
      </StateView>
    </div>
  );
}

function GrClaims() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['gr-claims'], queryFn: () => api('/api/claims/gr') });
  const [f, setF] = useState({ gr_no: '', item_id: '', claim_qty: '', reason: '' });
  const [msg, setMsg] = useState('');
  const create = useMutation({
    mutationFn: () => api('/api/claims/gr', { method: 'POST', body: JSON.stringify({ gr_no: f.gr_no || undefined, item_id: f.item_id || undefined, claim_qty: f.claim_qty ? Number(f.claim_qty) : undefined, reason: f.reason || undefined }) }),
    onSuccess: (r: any) => { setMsg(`✅ สร้างเคลม ${r.claim_no}`); setF({ gr_no: '', item_id: '', claim_qty: '', reason: '' }); qc.invalidateQueries({ queryKey: ['gr-claims'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const resolve = useMutation({
    mutationFn: (v: { no: string; status: string }) => api(`/api/claims/gr/${v.no}`, { method: 'PATCH', body: JSON.stringify({ status: v.status }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gr-claims'] }),
  });
  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">แจ้งเคลมผู้ขาย</h3>
        <div className="grid gap-2 sm:grid-cols-4">
          <Input placeholder="GR No." value={f.gr_no} onChange={(e) => setF({ ...f, gr_no: e.target.value })} />
          <Input placeholder="รหัสสินค้า" value={f.item_id} onChange={(e) => setF({ ...f, item_id: e.target.value })} />
          <Input type="number" placeholder="จำนวนเคลม" value={f.claim_qty} onChange={(e) => setF({ ...f, claim_qty: e.target.value })} />
          <Input placeholder="เหตุผล" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        </div>
        <Button className="w-fit" disabled={create.isPending} onClick={() => create.mutate()}>สร้างเคลม</Button>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </Card>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.claims}
            columns={[
              { key: 'claim_no', label: 'เลขที่' },
              { key: 'gr_no', label: 'GR' },
              { key: 'item_id', label: 'สินค้า' },
              { key: 'claim_qty', label: 'จำนวน', align: 'right', render: (r: any) => num(r.claim_qty) },
              { key: 'reason', label: 'เหตุผล' },
              { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              { key: 'act', label: '', render: (r: any) => r.status === 'Open' ? <div className="flex gap-1"><Button size="sm" onClick={() => resolve.mutate({ no: r.claim_no, status: 'Resolved' })}>ปิดเคลม</Button><Button size="sm" variant="destructive" onClick={() => resolve.mutate({ no: r.claim_no, status: 'Rejected' })}>ปฏิเสธ</Button></div> : '—' },
            ]}
            emptyText="ไม่มีเคลมผู้ขาย"
          />
        )}
      </StateView>
    </div>
  );
}
