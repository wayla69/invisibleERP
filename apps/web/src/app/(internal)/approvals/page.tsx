'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, Clock, AlarmClock, Coins } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { notifySuccess, notifyError } from '@/lib/notify';

// GOV-01 — unified pending-approvals monitor: every item awaiting independent (maker-checker) approval
// across the system, with its age, so the controller can chase stale approvals before close.

interface Item {
  type: string; control: string; ref: string; label: string; amount: number;
  requested_by: string | null; requested_at: string | null; age_days: number | null;
}
interface Resp { items: Item[]; count: number; by_type: Record<string, number>; oldest_age_days: number; overdue_days: number; overdue: number; total_amount: number }

const TYPE_TH: Record<string, string> = {
  journal: 'รายการบัญชี (JE)', ap_payment: 'จ่ายเจ้าหนี้ (AP)', payroll: 'เงินเดือน',
  asset_revaluation: 'ตีมูลค่าสินทรัพย์', asset_disposal: 'จำหน่ายสินทรัพย์', inventory_writeoff: 'ตัดสต๊อก',
  till_variance: 'เงินสดขาด/เกิน (ปิดกะ)',
};

export default function ApprovalsPage() {
  const qc = useQueryClient();
  const q = useQuery<Resp>({ queryKey: ['pending-approvals'], queryFn: () => api('/api/finance/approvals/pending'), refetchInterval: 30_000 });
  const d = q.data;
  const overdueDays = d?.overdue_days ?? 3;
  const refresh = () => qc.invalidateQueries({ queryKey: ['pending-approvals'] });

  // REV-13: a material till-close cash over/short is the one pending type with no dedicated module
  // screen, so the manager approves/rejects it inline here (SoD is enforced server-side: the approver
  // must differ from the cashier who closed → SOD_VIOLATION).
  const approve = useMutation({
    mutationFn: (sessionNo: string) => api<any>(`/api/payments/till/variance/${sessionNo}/approve`, { method: 'POST' }),
    onSuccess: () => { notifySuccess('อนุมัติผลต่างเงินสด — ลงบัญชีเงินสดขาด/เกินแล้ว'); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const reject = useMutation({
    mutationFn: (sessionNo: string) => api<any>(`/api/payments/till/variance/${sessionNo}/reject`, { method: 'POST', body: JSON.stringify({ reason: window.prompt('เหตุผลที่ปฏิเสธ (ไม่บังคับ)') || undefined }) }),
    onSuccess: () => { notifySuccess('ปฏิเสธผลต่างเงินสด — ยกเลิกรายการบัญชีร่าง'); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <ModulePage
      title="รายการรออนุมัติ (Pending approvals)"
      description="ทุกรายการที่รอการอนุมัติแบบแบ่งแยกหน้าที่ (maker-checker) ทั้งระบบ พร้อมอายุการค้าง — เพื่อไล่ตามรายการที่ค้างนานก่อนปิดงวด (GOV-01)"
      query={q}
      stats={
        d && (
          <>
            <StatCard label="รออนุมัติทั้งหมด" value={num(d.count)} icon={ClipboardCheck} tone="primary" />
            <StatCard label={`ค้างเกิน ${overdueDays} วัน`} value={num(d.overdue)} icon={AlarmClock} tone={d.overdue > 0 ? 'danger' : 'success'} hint="ควรเร่งรัด/escalate" />
            <StatCard label="ค้างนานสุด (วัน)" value={num(d.oldest_age_days)} icon={Clock} tone={d.oldest_age_days >= overdueDays ? 'warning' : 'default'} />
            <StatCard label="มูลค่ารวมที่รออนุมัติ" value={`฿${num(d.total_amount)}`} icon={Coins} tone="default" />
          </>
        )
      }
      statsClassName="xl:grid-cols-4"
    >
      {d && (
        <DataTable
          rows={d.items}
          rowKey={(r, i) => `${r.control}-${r.ref}-${i}`}
          emptyState={{ icon: ClipboardCheck, title: 'ไม่มีรายการรออนุมัติ', description: 'ทุกรายการได้รับการอนุมัติแล้ว — ไม่มีงานค้างในระบบ maker-checker' }}
          columns={[
            { key: 'control', label: 'การควบคุม', render: (r) => <Badge variant="outline" className="font-mono">{r.control}</Badge> },
            { key: 'type', label: 'ประเภท', render: (r) => TYPE_TH[r.type] ?? r.type },
            { key: 'ref', label: 'อ้างอิง', render: (r) => <span className="font-mono text-sm">{r.ref}</span> },
            { key: 'label', label: 'รายละเอียด', render: (r) => <span className="text-muted-foreground">{r.label}</span> },
            { key: 'amount', label: 'มูลค่า', align: 'right', render: (r) => <span className="tabular">฿{num(r.amount)}</span> },
            { key: 'requested_by', label: 'ผู้ขอ', render: (r) => r.requested_by ?? '—' },
            { key: 'age_days', label: 'ค้าง (วัน)', align: 'right', render: (r) => r.age_days == null ? '—' : <span className={cn('tabular font-medium', r.age_days >= overdueDays ? 'text-destructive' : 'text-muted-foreground')}>{num(r.age_days)}{r.age_days >= overdueDays ? ' ⚠' : ''}</span> },
            { key: 'requested_at', label: 'วันที่ขอ', render: (r) => (r.requested_at ? thaiDate(r.requested_at) : '—') },
            { key: 'actions', label: '', align: 'right', render: (r) => r.type === 'till_variance' ? (
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="outline" disabled={approve.isPending || reject.isPending} onClick={() => approve.mutate(r.ref)}>อนุมัติ</Button>
                <Button size="sm" variant="ghost" disabled={approve.isPending || reject.isPending} onClick={() => reject.mutate(r.ref)}>ปฏิเสธ</Button>
              </div>
            ) : null },
          ]}
        />
      )}
    </ModulePage>
  );
}
