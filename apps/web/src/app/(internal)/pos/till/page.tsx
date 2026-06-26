'use client';

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Banknote, CheckCircle2, CircleDollarSign, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable, type Column } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Till management screen (SoD: pos_till only — segregated from pos_sell cashier duty).
// Covers: open/close sessions, cash movements (paid-in/out/drop), variance approval.

type TillStatus = 'Open' | 'Closed' | 'Variance';
interface XzReport {
  id: number; till_session_id: number; report_type: string; status: TillStatus;
  generated_by: string; generated_at: string; gross_sales: number; total_cash: number;
  total_card: number; total_refund: number; cash_expected: number; cash_counted: number;
  variance: number; content_hash: string; hash_valid?: boolean;
}
interface XzListResp { reports: XzReport[]; count: number }

export default function PosTillPage() {
  const qc = useQueryClient();
  const [openFloat, setOpenFloat] = useState('');
  const [openDialogOpen, setOpenDialogOpen] = useState(false);
  const [varianceId, setVarianceId] = useState<{ sessionNo: string; variance: number } | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const q = useQuery<XzListResp>({
    queryKey: ['xz-reports'],
    queryFn: () => api('/api/payments/xz-reports?limit=50'),
  });
  const d = q.data;

  const openTill = useMutation({
    mutationFn: (openingFloat: number) =>
      api('/api/payments/till/open', { method: 'POST', body: JSON.stringify({ opening_float: openingFloat }) }),
    onSuccess: (r: any) => {
      notifySuccess(`เปิดลิ้นชักเงินสด (${r?.session_no}) สำเร็จ`);
      setOpenDialogOpen(false);
      setOpenFloat('');
      qc.invalidateQueries({ queryKey: ['xz-reports'] });
    },
    onError: (e: any) => notifyError(e?.message ?? 'เปิดลิ้นชักไม่สำเร็จ'),
  });

  const approveVariance = useMutation({
    mutationFn: (sessionNo: string) =>
      api(`/api/payments/till/variance/${encodeURIComponent(sessionNo)}/approve`, { method: 'POST', body: '{}' }),
    onSuccess: () => { notifySuccess('อนุมัติผลต่างสำเร็จ'); setVarianceId(null); qc.invalidateQueries({ queryKey: ['xz-reports'] }); },
    onError: (e: any) => notifyError(e?.message ?? 'อนุมัติไม่สำเร็จ'),
  });

  const rejectVariance = useMutation({
    mutationFn: ({ sessionNo, reason }: { sessionNo: string; reason: string }) =>
      api(`/api/payments/till/variance/${encodeURIComponent(sessionNo)}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
    onSuccess: () => { notifySuccess('ปฏิเสธผลต่างสำเร็จ'); setVarianceId(null); setRejectReason(''); qc.invalidateQueries({ queryKey: ['xz-reports'] }); },
    onError: (e: any) => notifyError(e?.message ?? 'ปฏิเสธไม่สำเร็จ'),
  });

  const openSessions = d?.reports.filter((r) => r.status === 'Open').length ?? 0;
  const varianceSessions = d?.reports.filter((r) => r.status === 'Variance').length ?? 0;
  const totalSales = d?.reports.reduce((s, r) => s + r.gross_sales, 0) ?? 0;

  const statusBadge = (r: XzReport) =>
    r.status === 'Variance'
      ? <Badge variant="destructive" className="gap-1"><AlertTriangle className="size-3" />ผลต่าง</Badge>
      : r.variance !== 0 && r.status === 'Closed'
        ? <Badge variant="outline" className="text-orange-700 border-orange-400">ปิด (มีผลต่าง)</Badge>
        : r.status === 'Open'
          ? <Badge variant="secondary" className="bg-green-100 text-green-800">เปิดอยู่</Badge>
          : <Badge variant="outline">ปิดแล้ว</Badge>;

  const columns: Column<XzReport>[] = [
    { key: 'id', label: '#', render: (r) => `S-${r.till_session_id}` },
    { key: 'generated_at', label: 'เวลาเปิด', render: (r) => new Date(r.generated_at).toLocaleString('th-TH') },
    { key: 'gross_sales', label: 'ยอดขาย', align: 'right', render: (r) => baht(r.gross_sales) },
    { key: 'total_cash', label: 'เงินสด', align: 'right', render: (r) => baht(r.total_cash) },
    { key: 'cash_counted', label: 'นับจริง', align: 'right', render: (r) => baht(r.cash_counted) },
    {
      key: 'variance', label: 'ผลต่าง', align: 'right',
      render: (r) => <span className={r.variance !== 0 ? 'font-medium text-destructive' : 'text-muted-foreground'}>{baht(r.variance)}</span>,
    },
    { key: 'generated_by', label: 'เปิดโดย' },
    { key: 'status', label: 'สถานะ', render: (r) => statusBadge(r) },
    {
      key: 'id', label: 'การดำเนินการ',
      render: (r) => r.status === 'Variance' ? (
        <div className="flex gap-1.5">
          <Button size="sm" variant="secondary" className="h-7 gap-1 text-green-700 hover:bg-green-50"
            disabled={approveVariance.isPending}
            onClick={() => setVarianceId({ sessionNo: String(r.till_session_id), variance: r.variance })}>
            <CheckCircle2 className="size-3.5" />อนุมัติ
          </Button>
          <Button size="sm" variant="ghost" className="h-7 gap-1 text-destructive hover:bg-destructive/10"
            onClick={() => { setVarianceId({ sessionNo: String(r.till_session_id), variance: r.variance }); setRejectReason(''); }}>
            <XCircle className="size-3.5" />ปฏิเสธ
          </Button>
        </div>
      ) : null,
    },
  ];

  return (
    <ModulePage
      title="จัดการลิ้นชัก (Till Management)"
      description="เปิด-ปิดลิ้นชักเงินสด, อนุมัติผลต่างตอนปิดกะ — ต้องมีสิทธิ์ pos_till เท่านั้น (แยกจากแคชเชียร์ pos_sell)"
      query={q}
      actions={
        <Button size="sm" onClick={() => setOpenDialogOpen(true)}>
          <CircleDollarSign className="mr-1.5 size-4" />เปิดลิ้นชักใหม่
        </Button>
      }
      stats={
        <>
          <StatCard label="ลิ้นชักที่เปิดอยู่" value={num(openSessions)} icon={CircleDollarSign} tone={openSessions > 0 ? 'primary' : 'default'} />
          <StatCard label="รออนุมัติผลต่าง" value={num(varianceSessions)} icon={AlertTriangle} tone={varianceSessions > 0 ? 'warning' : 'default'} />
          <StatCard label="ยอดขายรวม" value={baht(totalSales)} icon={Banknote} hint="เซสชันปัจจุบัน" />
        </>
      }
      statsClassName="xl:grid-cols-3"
    >
      <DataTable
        rows={d?.reports ?? []}
        rowKey={(r) => r.id}
        emptyState={{ icon: CircleDollarSign, title: 'ยังไม่มีเซสชันลิ้นชัก', description: 'คลิก "เปิดลิ้นชักใหม่" เพื่อเริ่มต้นกะ' }}
        columns={columns}
      />

      {/* Open till dialog */}
      <Dialog open={openDialogOpen} onOpenChange={setOpenDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>เปิดลิ้นชักเงินสด</DialogTitle></DialogHeader>
          <Card className="border-0 shadow-none">
            <CardHeader className="p-0 pb-3"><CardTitle className="text-sm text-muted-foreground">เงินทอนตั้งต้น (Opening float)</CardTitle></CardHeader>
            <CardContent className="p-0">
              <div className="space-y-2">
                <Label htmlFor="float">ยอดเงินทอน (฿)</Label>
                <Input id="float" type="number" min="0" step="0.01" placeholder="0.00"
                  value={openFloat} onChange={(e) => setOpenFloat(e.target.value)} />
              </div>
            </CardContent>
          </Card>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenDialogOpen(false)}>ยกเลิก</Button>
            <Button disabled={openTill.isPending}
              onClick={() => openTill.mutate(parseFloat(openFloat || '0'))}>
              เปิดลิ้นชัก
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Variance approval dialog */}
      {varianceId && (
        <Dialog open onOpenChange={() => { setVarianceId(null); setRejectReason(''); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="size-5 text-destructive" />
                ผลต่างเงินสด: {baht(varianceId.variance)}
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">อนุมัติหรือปฏิเสธผลต่างเงินสดตอนปิดกะ (ต้องเป็นคนละคนกับผู้ปิดกะ)</p>
            <div className="space-y-2">
              <Label htmlFor="var-reason">เหตุผล (กรณีปฏิเสธ)</Label>
              <textarea id="var-reason" className="min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
                value={rejectReason} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setRejectReason(e.target.value)}
                placeholder="ระบุเหตุผล…" rows={2} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setVarianceId(null); setRejectReason(''); }}>ยกเลิก</Button>
              <Button variant="destructive" disabled={rejectVariance.isPending}
                onClick={() => rejectVariance.mutate({ sessionNo: varianceId.sessionNo, reason: rejectReason })}>
                ปฏิเสธ
              </Button>
              <Button disabled={approveVariance.isPending}
                onClick={() => approveVariance.mutate(varianceId.sessionNo)}>
                <CheckCircle2 className="mr-1.5 size-4" />อนุมัติผลต่าง
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </ModulePage>
  );
}
