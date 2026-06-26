'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

// Treasury / finance disbursement surface (perm: approvals | gl_close). The CHECKER side of the AP
// maker-checker: accounting (creditors) books the bill and requests payment on /finance; finance
// approves & releases the cash here. Approver ≠ requester is enforced server-side (EXP-06 / SoD R07).
export default function DisbursementsPage() {
  const qc = useQueryClient();
  const pending = useQuery<any>({ queryKey: ['ap-disbursements'], queryFn: () => api('/api/finance/ap/payments/pending'), retry: false });
  const refresh = () => qc.invalidateQueries({ queryKey: ['ap-disbursements'] });

  const approve = useMutation({
    mutationFn: (no: string) => api(`/api/finance/ap/payments/${no}/approve`, { method: 'POST' }),
    onSuccess: (r: any) => { notifySuccess(`อนุมัติจ่าย ${r.payment_no} — บิล ${r.bill_status}`); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const reject = useMutation({
    mutationFn: (no: string) => api(`/api/finance/ap/payments/${no}/reject`, { method: 'POST', body: JSON.stringify({ reason: 'rejected by approver' }) }),
    onSuccess: (r: any) => { notifySuccess(`ปฏิเสธคำขอ ${r.payment_no}`); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div>
      <PageHeader title="จ่ายเงินเจ้าหนี้ (Disbursements)" description="อนุมัติและตัดจ่ายคำขอจ่ายเจ้าหนี้ — สำหรับฝ่ายการเงิน (ผู้อนุมัติต้องไม่ใช่ผู้ขอจ่าย)" />

      <StateView q={pending}>
        {pending.data ? (
          <DataTable
            rows={pending.data.payments}
            rowKey={(r: any) => r.payment_no}
            emptyState={{ icon: CheckCheck, title: 'ไม่มีคำขอจ่ายรออนุมัติ', description: 'คำขอจ่ายที่บัญชีส่งเข้ามาจะแสดงที่นี่เพื่อให้การเงินอนุมัติและตัดจ่าย' }}
            columns={[
              { key: 'payment_no', label: 'เลขที่คำขอ' },
              { key: 'txn_no', label: 'บิล AP' },
              { key: 'vendor_name', label: 'เจ้าหนี้' },
              { key: 'requested_by', label: 'ผู้ขอจ่าย' },
              { key: 'amount', label: 'จำนวน', align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
              { key: 'act', label: '', sortable: false, render: (r: any) => {
                const busy = (approve.isPending && approve.variables === r.payment_no) || (reject.isPending && reject.variables === r.payment_no);
                return (
                  <div className="flex gap-1">
                    <Button size="sm" disabled={busy} onClick={() => approve.mutate(r.payment_no)}>อนุมัติจ่าย</Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => reject.mutate(r.payment_no)}>ปฏิเสธ</Button>
                  </div>
                );
              } },
            ]}
          />
        ) : (
          <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">คุณไม่มีสิทธิ์อนุมัติการจ่ายเงิน (ต้องมีสิทธิ์ approvals หรือ gl_close)</CardContent></Card>
        )}
      </StateView>
    </div>
  );
}
