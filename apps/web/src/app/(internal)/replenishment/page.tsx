'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PackagePlus, RefreshCw, AlertTriangle, FileText, PackageSearch } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const urgencyVariant = (u: string) =>
  u === 'critical' ? 'destructive' : u === 'warning' ? 'warning' : u === 'ok' ? 'success' : 'secondary';

export default function ReplenishmentPage() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['replenishment'], queryFn: () => api('/api/replenishment/suggestions') });

  const recompute = useMutation({
    mutationFn: () => api<{ count: number }>('/api/replenishment/suggest', { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(`คำนวณใหม่แล้ว · พบ ${num(r.count)} รายการ`); qc.invalidateQueries({ queryKey: ['replenishment'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const autoPr = useMutation({
    mutationFn: () => api<{ pr_no: string | null; lines: number }>('/api/replenishment/auto-pr', { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (r) => { notifySuccess(r.pr_no ? `สร้าง ${r.pr_no} · ${num(r.lines)} บรรทัด` : 'ไม่มีรายการที่ต้องสั่งซื้อ'); qc.invalidateQueries({ queryKey: ['replenishment'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const suggestions: any[] = q.data?.suggestions ?? [];
  const open = suggestions.filter((s) => s.status === 'Suggested');
  const critical = open.filter((s) => s.urgency === 'critical').length;
  const totalQty = open.reduce((a, s) => a + Number(s.suggested_qty || 0), 0);

  return (
    <div>
      <PageHeader
        title="เติมสต๊อกอัตโนมัติ (Replenishment)"
        description="คำแนะนำเติมสต๊อกแบบ Min-Max — เมื่อคงเหลือ ≤ จุดสั่งซื้อ ระบบเสนอจำนวนที่ควรสั่ง"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled={recompute.isPending} onClick={() => recompute.mutate()}>
              <RefreshCw className="size-4" /> {recompute.isPending ? 'กำลังคำนวณ…' : 'คำนวณใหม่'}
            </Button>
            <Button disabled={autoPr.isPending || open.length === 0} onClick={() => autoPr.mutate()}>
              <FileText className="size-4" /> {autoPr.isPending ? 'กำลังสร้าง PR…' : 'สร้างใบขอซื้อ (PR)'}
            </Button>
          </div>
        }
      />

      <div className="space-y-5">
        <StateView q={q}>
          {q.data && (
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <StatCard label="คำแนะนำที่เปิดอยู่" value={num(open.length)} icon={PackagePlus} tone="primary" />
                <StatCard label="วิกฤต (Critical)" value={num(critical)} icon={AlertTriangle} tone={critical > 0 ? 'danger' : 'default'} />
                <StatCard label="จำนวนที่แนะนำให้สั่งรวม" value={num(totalQty)} icon={RefreshCw} tone="info" />
              </div>
              <DataTable
                rows={suggestions}
                columns={[
                  { key: 'suggestion_no', label: 'เลขที่' },
                  { key: 'item_id', label: 'รหัสสินค้า' },
                  { key: 'on_hand', label: 'คงเหลือ', align: 'right', render: (r: any) => <span className="tabular">{num(r.on_hand)}</span> },
                  { key: 'reorder_point', label: 'จุดสั่งซื้อ', align: 'right', render: (r: any) => <span className="tabular">{num(r.reorder_point)}</span> },
                  { key: 'suggested_qty', label: 'แนะนำให้สั่ง', align: 'right', render: (r: any) => <span className="tabular font-medium">{num(r.suggested_qty)}</span> },
                  { key: 'urgency', label: 'ความเร่งด่วน', render: (r: any) => <Badge variant={urgencyVariant(r.urgency)}>{r.urgency}</Badge> },
                  { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={r.status === 'Suggested' ? 'info' : r.status === 'PR_Created' ? 'success' : 'muted'}>{r.status}</Badge> },
                  { key: 'pr_no', label: 'PR', render: (r: any) => r.pr_no ?? '—' },
                ]}
                emptyState={{
                  icon: PackageSearch,
                  title: 'ยังไม่มีคำแนะนำเติมสต๊อก',
                  description: 'กด “คำนวณใหม่” เพื่อให้ระบบวิเคราะห์สต๊อกและเสนอจำนวนที่ควรสั่งซื้อ',
                }}
              />
            </div>
          )}
        </StateView>
      </div>
    </div>
  );
}
