'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ReceiptText, ShieldCheck, ShieldAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable, type Column } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type XzReport = {
  id: number; till_session_id: number; report_type: string; status: string; generated_by: string;
  generated_at: string; gross_sales: number; total_cash: number; total_card: number; total_refund: number;
  cash_expected: number; cash_counted: number; variance: number; content_hash: string; hash_valid?: boolean;
};

export default function CloseOfDayPage() {
  const qc = useQueryClient();
  const [sessionNo, setSessionNo] = useState('');

  const list = useQuery<{ reports: XzReport[]; count: number }>({
    queryKey: ['xz-reports'],
    queryFn: () => api('/api/payments/xz-reports'),
  });

  const sign = useMutation({
    mutationFn: (s: string) => api(`/api/payments/till/${encodeURIComponent(s)}/z-report/sign`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (r: any) => {
      notifySuccess(r?.already ? 'รอบนี้ลงนามไว้แล้ว' : `ลงนามรายงาน Z สำเร็จ (#${r?.id})`);
      setSessionNo('');
      qc.invalidateQueries({ queryKey: ['xz-reports'] });
    },
    onError: (e: any) => notifyError(e?.message ?? 'ลงนามไม่สำเร็จ'),
  });

  const columns: Column<XzReport>[] = [
    { key: 'id', label: '#', render: (r) => `Z-${r.id}` },
    { key: 'generated_at', label: 'เวลา', render: (r) => new Date(r.generated_at).toLocaleString('th-TH') },
    { key: 'gross_sales', label: 'ยอดขาย', align: 'right', render: (r) => baht(r.gross_sales) },
    { key: 'total_cash', label: 'เงินสด', align: 'right', render: (r) => baht(r.total_cash) },
    { key: 'cash_counted', label: 'นับจริง', align: 'right', render: (r) => baht(r.cash_counted) },
    { key: 'variance', label: 'ผลต่าง', align: 'right', render: (r) => <span className={r.variance < 0 ? 'text-destructive' : ''}>{baht(r.variance)}</span> },
    { key: 'generated_by', label: 'ลงนามโดย' },
    {
      key: 'hash_valid', label: 'ความถูกต้อง', align: 'center',
      render: (r) => r.hash_valid === false
        ? <Badge variant="destructive"><ShieldAlert className="mr-1 h-3 w-3" />ถูกแก้ไข</Badge>
        : <Badge variant="secondary"><ShieldCheck className="mr-1 h-3 w-3" />ถูกต้อง</Badge>,
    },
  ];

  return (
    <div>
      <PageHeader title="ปิดกะ (Z-Report)" description="ลงนามรายงานปิดกะแบบกันแก้ไข (POS-07): สรุปยอด/เงินสด/ผลต่าง พร้อม content-hash ตรวจการถูกแก้ไข" />

      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">ลงนามรายงาน Z ของรอบที่ปิดแล้ว</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="sess">รหัสรอบเงินสด (TILL-…)</Label>
              <Input id="sess" value={sessionNo} onChange={(e) => setSessionNo(e.target.value)} placeholder="TILL-20260626-001" className="w-64" />
            </div>
            <Button disabled={!sessionNo || sign.isPending} onClick={() => sign.mutate(sessionNo)}>
              <ReceiptText className="mr-1.5 h-4 w-4" />{sign.isPending ? 'กำลังลงนาม…' : 'ลงนาม Z-Report'}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">ต้องปิดรอบเงินสดก่อน (เมนูขายหน้าร้าน) — ผู้จัดการ (สิทธิ์ pos_close) เป็นผู้ลงนาม</p>
        </CardContent>
      </Card>

      <DataTable
        rows={list.data?.reports ?? []}
        columns={columns}
        loading={list.isLoading}
        emptyState={{ icon: ReceiptText, title: 'ยังไม่มีรายงานปิดกะ', description: 'ลงนามรายงาน Z ของรอบที่ปิดแล้วเพื่อเก็บบันทึกแบบกันแก้ไข' }}
      />
    </div>
  );
}
