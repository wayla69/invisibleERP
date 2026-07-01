'use client';

// LYL-17 — receipt-upload-for-points review queue. Members submit a photo of a purchase made outside our
// POS via the self-service app; staff (crm_points_adjust) approve/reject here. Approval grants points
// through the same earnInTx path POS checkout uses.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ReceiptText } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function ReceiptApprovalsPage() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['loy-receipt-queue'], queryFn: () => api('/api/loyalty/receipts?status=Pending') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['loy-receipt-queue'] });

  const approve = useMutation({
    mutationFn: (id: number) => api<any>(`/api/loyalty/receipts/${id}/approve`, { method: 'POST' }),
    onSuccess: (r: any) => { notifySuccess(`อนุมัติแล้ว — บันทึกแต้ม ${num(r.points_granted)} แต้ม`); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const reject = useMutation({
    mutationFn: (id: number) => api<any>(`/api/loyalty/receipts/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason: window.prompt('เหตุผลที่ปฏิเสธ (ไม่บังคับ)') || undefined }) }),
    onSuccess: () => { notifySuccess('ปฏิเสธใบเสร็จแล้ว'); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const pending: any[] = q.data?.submissions ?? [];
  return (
    <div>
      <PageHeader title="อนุมัติใบเสร็จสะสมแต้ม" description="ตรวจสอบรูปใบเสร็จที่สมาชิกอัปโหลด (ซื้อนอกช่องทาง POS) แล้วอนุมัติ/ปฏิเสธก่อนบันทึกแต้ม (LYL-17)" />
      <div className="space-y-4">
        <StatCard label="รอตรวจสอบ" value={num(pending.length)} icon={ReceiptText} tone={pending.length ? 'warning' : 'success'} className="max-w-xs" />
        <Card className="gap-3 p-5">
          <p className="text-xs text-muted-foreground">ผู้อนุมัติต้องมีสิทธิ์แยกหน้าที่ (crm_points_adjust) — แต้มจะถูกบันทึกก็ต่อเมื่ออนุมัติเท่านั้น</p>
          <StateView q={q}>
            {q.data && (
              <DataTable
                rows={pending}
                emptyState={{ icon: ReceiptText, title: 'ไม่มีใบเสร็จที่รอตรวจสอบ' }}
                columns={[
                  { key: 'receipt_image', label: 'รูปใบเสร็จ', render: (r: any) => <img src={r.receipt_image} alt="ใบเสร็จ" className="h-24 w-auto rounded border object-contain" /> },
                  { key: 'member_id', label: 'สมาชิก', render: (r: any) => `#${r.member_id}` },
                  { key: 'store_name', label: 'ร้านค้า', render: (r: any) => r.store_name ?? '—' },
                  { key: 'purchase_date', label: 'วันที่ซื้อ', render: (r: any) => (r.purchase_date ? thaiDate(r.purchase_date) : '—') },
                  { key: 'purchase_amount', label: 'ยอดซื้อ', align: 'right', render: (r: any) => <span className="tabular">{baht(r.purchase_amount)}</span> },
                  { key: 'claimed_points_preview', label: 'แต้มโดยประมาณ', align: 'right', render: (r: any) => <span className="tabular">{num(r.claimed_points_preview)}</span> },
                  { key: 'submitted_at', label: 'ส่งเมื่อ', render: (r: any) => thaiDate(r.submitted_at) },
                  { key: 'act', label: '', align: 'right', render: (r: any) => (
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" variant="outline" disabled={approve.isPending} onClick={() => approve.mutate(r.id)}>อนุมัติ</Button>
                      <Button size="sm" variant="ghost" disabled={reject.isPending} onClick={() => reject.mutate(r.id)}>ปฏิเสธ</Button>
                    </div>
                  ) },
                ]}
              />
            )}
          </StateView>
        </Card>
      </div>
    </div>
  );
}
