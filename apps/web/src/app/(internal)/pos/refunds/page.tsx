'use client';

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Banknote, CheckCircle2, Clock, ShieldCheck, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable, type Column } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';

// POS Supervisor refund-authorization queue (SoD R08/R12: sell ≠ refund).
// pos_refund permission only — a Cashier (pos_sell) cannot access this screen.

interface RefundRequest {
  id: number; request_no: string; payment_no: string; sale_no: string; amount: number;
  reason: string | null; status: 'Pending' | 'Approved' | 'Rejected';
  requested_by: string; requested_at: string; approved_by: string | null; approved_at: string | null;
  reject_reason: string | null;
}
interface ListResp { requests: RefundRequest[]; count: number }

type Filter = 'Pending' | 'Approved' | 'Rejected' | '';

export default function PosRefundsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>('Pending');
  const [rejectId, setRejectId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const q = useQuery<ListResp>({
    queryKey: ['refund-requests', filter],
    queryFn: () => api(`/api/payments/refund-requests${filter ? `?status=${filter}` : ''}`),
  });
  const d = q.data;

  const approve = useMutation({
    mutationFn: (id: number) => api(`/api/payments/refund-requests/${id}/approve`, { method: 'POST', body: '{}' }),
    onSuccess: () => { notifySuccess('อนุมัติการคืนเงินสำเร็จ'); qc.invalidateQueries({ queryKey: ['refund-requests'] }); },
    onError: (e: any) => notifyError(e?.message ?? 'อนุมัติไม่สำเร็จ'),
  });

  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      api(`/api/payments/refund-requests/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
    onSuccess: () => { notifySuccess('ปฏิเสธการคืนเงินแล้ว'); setRejectId(null); setRejectReason(''); qc.invalidateQueries({ queryKey: ['refund-requests'] }); },
    onError: (e: any) => notifyError(e?.message ?? 'ปฏิเสธไม่สำเร็จ'),
  });

  const pending = d?.requests.filter((r) => r.status === 'Pending').length ?? 0;
  const approved = d?.requests.filter((r) => r.status === 'Approved').length ?? 0;
  const totalAmount = d?.requests.filter((r) => r.status === 'Pending').reduce((s, r) => s + r.amount, 0) ?? 0;

  const statusBadge = (s: string) =>
    s === 'Approved' ? <Badge variant="secondary" className="bg-green-100 text-green-800">อนุมัติ</Badge>
    : s === 'Rejected' ? <Badge variant="destructive">ปฏิเสธ</Badge>
    : <Badge variant="outline" className="text-yellow-700 border-yellow-400">รออนุมัติ</Badge>;

  const columns: Column<RefundRequest>[] = [
    { key: 'request_no', label: 'เลขที่คำขอ', render: (r) => <span className="font-medium">{r.request_no}</span> },
    { key: 'sale_no', label: 'เลขที่ขาย' },
    { key: 'payment_no', label: 'เลขที่ชำระ' },
    { key: 'amount', label: 'ยอดคืน', align: 'right', render: (r) => <span className="tabular font-medium">฿{num(r.amount)}</span> },
    { key: 'reason', label: 'เหตุผล', render: (r) => r.reason ?? '—' },
    { key: 'requested_by', label: 'ผู้ขอ' },
    { key: 'requested_at', label: 'วันที่ขอ', render: (r) => thaiDate(r.requested_at.split('T')[0]) },
    { key: 'status', label: 'สถานะ', render: (r) => statusBadge(r.status) },
    {
      key: 'id', label: 'การดำเนินการ',
      render: (r) => r.status === 'Pending' ? (
        <div className="flex gap-1.5">
          <Button size="sm" variant="secondary" className="h-7 gap-1 text-green-700 hover:bg-green-50"
            disabled={approve.isPending} onClick={() => approve.mutate(r.id)}>
            <CheckCircle2 className="size-3.5" />อนุมัติ
          </Button>
          <Button size="sm" variant="ghost" className="h-7 gap-1 text-destructive hover:bg-destructive/10"
            onClick={() => { setRejectId(r.id); setRejectReason(''); }}>
            <XCircle className="size-3.5" />ปฏิเสธ
          </Button>
        </div>
      ) : (
        <span className="text-sm text-muted-foreground">{r.approved_by ?? '—'}</span>
      ),
    },
  ];

  const selectCls = 'h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring';

  return (
    <ModulePage
      title="อนุมัติการคืนเงิน (Refund Authorization)"
      description="คิวคำขอคืนเงินรอการอนุมัติจาก POS Supervisor — การขาย (pos_sell) และการคืนเงิน (pos_refund) คนละคน (SoD R08)"
      query={q}
      toolbar={
        <select className={selectCls} value={filter} onChange={(e) => setFilter(e.target.value as Filter)}
          aria-label="กรองตามสถานะ">
          <option value="Pending">รออนุมัติ</option>
          <option value="Approved">อนุมัติแล้ว</option>
          <option value="Rejected">ปฏิเสธ</option>
          <option value="">ทั้งหมด</option>
        </select>
      }
      stats={
        <>
          <StatCard label="รออนุมัติ" value={num(pending)} icon={Clock} tone={pending > 0 ? 'warning' : 'default'} />
          <StatCard label="ยอดรวมรออนุมัติ" value={`฿${num(totalAmount)}`} icon={Banknote} hint="ผลรวมที่รออนุมัติ" />
          <StatCard label="อนุมัติแล้ววันนี้" value={num(approved)} icon={ShieldCheck} tone="success" />
        </>
      }
      statsClassName="xl:grid-cols-3"
    >
      <DataTable
        rows={d?.requests ?? []}
        rowKey={(r) => r.request_no}
        emptyState={{
          icon: CheckCircle2,
          title: filter === 'Pending' ? 'ไม่มีคำขอคืนเงินรออนุมัติ' : 'ไม่มีรายการ',
          description: filter === 'Pending' ? 'คำขอคืนเงินจากพนักงานขายจะปรากฏที่นี่' : 'ลองเปลี่ยนตัวกรอง',
        }}
        columns={columns}
      />

      {rejectId !== null && (
        <Dialog open onOpenChange={() => { setRejectId(null); setRejectReason(''); }}>
          <DialogContent>
            <DialogHeader><DialogTitle>ปฏิเสธการคืนเงิน</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <Label htmlFor="reject-reason">เหตุผล (ไม่บังคับ)</Label>
              <textarea id="reject-reason" className="min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
                value={rejectReason} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setRejectReason(e.target.value)}
                placeholder="ระบุเหตุผลการปฏิเสธ…" rows={3} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setRejectId(null); setRejectReason(''); }}>ยกเลิก</Button>
              <Button variant="destructive" disabled={reject.isPending}
                onClick={() => reject.mutate({ id: rejectId!, reason: rejectReason })}>
                ยืนยันการปฏิเสธ
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </ModulePage>
  );
}
