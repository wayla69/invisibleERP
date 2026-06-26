'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, X, Receipt, CircleDollarSign } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

// ── API contract (apps/api/src/modules/ess) ───────────────────────────────────
interface PendingClaim {
  id: number; claim_date: string | null; category: string | null; amount: number;
  description: string | null; status: string; emp_code: string | null; employee_name: string | null;
}

export default function ExpenseApprovalsPage() {
  const qc = useQueryClient();
  const q = useQuery<{ pending: PendingClaim[]; count: number }>({
    queryKey: ['ess-pending-expenses'],
    queryFn: () => api('/api/ess/expenses/pending'),
  });

  const decide = useMutation({
    mutationFn: (v: { id: number; approve: boolean }) =>
      api<{ id: number; status: string; ap_txn_no?: string | null }>(`/api/ess/expenses/${v.id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ approve: v.approve }),
      }),
    onSuccess: (r) => {
      notifySuccess(
        r.status === 'Approved' ? 'อนุมัติคำขอเบิกแล้ว' : 'ปฏิเสธคำขอเบิกแล้ว',
        r.ap_txn_no ? `ตั้งเจ้าหนี้ค่าใช้จ่าย ${r.ap_txn_no} (เข้าคิวจ่าย AP)` : undefined,
      );
      qc.invalidateQueries({ queryKey: ['ess-pending-expenses'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const rows = q.data?.pending ?? [];
  const total = rows.reduce((s, r) => s + (r.amount || 0), 0);

  return (
    <div>
      <PageHeader
        title="อนุมัติเบิกพนักงาน"
        description="คำขอเบิกค่าใช้จ่ายของพนักงานที่รออนุมัติ — อนุมัติแล้วจะตั้งเป็นเจ้าหนี้ค่าใช้จ่าย (Dr 5100 / Cr 2000) เข้าคิวจ่าย AP โดยอัตโนมัติ · อนุมัติรายการของตนเองไม่ได้ (แยกหน้าที่)"
      />

      <div className="space-y-5">
        <StateView q={q}>
          {q.data && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <StatCard label="คำขอที่รออนุมัติ" value={num(rows.length)} icon={Receipt} tone="primary" />
              <StatCard label="มูลค่ารวมที่รออนุมัติ" value={baht(total)} icon={CircleDollarSign} tone="warning" />
            </div>
          )}
        </StateView>

        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={rows}
              rowKey={(r) => r.id}
              emptyState={{ icon: Receipt, title: 'ไม่มีคำขอเบิกที่รออนุมัติ', description: 'คำขอเบิกค่าใช้จ่ายที่พนักงานส่งเข้ามาจะปรากฏที่นี่ให้คุณอนุมัติหรือปฏิเสธ' }}
              columns={[
                { key: 'employee_name', label: 'พนักงาน', render: (r) => <span className="font-medium">{r.employee_name ?? r.emp_code ?? '—'}</span> },
                { key: 'emp_code', label: 'รหัส', render: (r) => r.emp_code ?? '—' },
                { key: 'claim_date', label: 'วันที่', render: (r) => thaiDate(r.claim_date) },
                { key: 'category', label: 'หมวด', render: (r) => r.category ?? '—' },
                { key: 'description', label: 'รายละเอียด', render: (r) => r.description ?? '—' },
                { key: 'amount', label: 'จำนวนเงิน', align: 'right', render: (r) => <span className="tabular">{baht(r.amount)}</span> },
                { key: 'status', label: 'สถานะ', render: (r) => <Badge variant="warning">{r.status}</Badge> },
                {
                  key: '_act',
                  label: 'ดำเนินการ',
                  sortable: false,
                  render: (r) => (
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        disabled={decide.isPending}
                        onClick={() => decide.mutate({ id: r.id, approve: true })}
                      >
                        <Check className="size-3.5" /> อนุมัติ
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={decide.isPending}
                        onClick={() => decide.mutate({ id: r.id, approve: false })}
                      >
                        <X className="size-3.5" /> ปฏิเสธ
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          )}
        </StateView>
      </div>
    </div>
  );
}
