'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PackagePlus, RefreshCw, AlertTriangle, FileText, PackageSearch, ArrowLeftRight, Truck } from 'lucide-react';
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
const statusVariant = (s: string) =>
  s === 'Suggested' ? 'info' : s === 'PR_Created' || s === 'Transfer_Done' ? 'success' : 'muted';

export default function ReplenishmentPage() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['replenishment'], queryFn: () => api('/api/replenishment/suggestions') });

  const recompute = useMutation({
    mutationFn: () => api<{ count: number }>('/api/replenishment/suggest', { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(`คำนวณใหม่แล้ว · พบ ${num(r.count)} รายการ`); qc.invalidateQueries({ queryKey: ['replenishment'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const autoTransfer = useMutation({
    mutationFn: () => api<{ doc_no: string | null; transfers: number }>('/api/replenishment/auto-transfer', { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (r) => { notifySuccess(r.doc_no ? `โอนสต๊อกแล้ว · ${r.doc_no} · ${num(r.transfers)} รายการ` : 'ไม่มีรายการที่ต้องโอน'); qc.invalidateQueries({ queryKey: ['replenishment'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const autoPr = useMutation({
    mutationFn: () => api<{ pr_no: string | null; lines: number }>('/api/replenishment/auto-pr', { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (r) => { notifySuccess(r.pr_no ? `สร้าง ${r.pr_no} · ${num(r.lines)} บรรทัด` : 'ไม่มีรายการที่ต้องสั่งซื้อ'); qc.invalidateQueries({ queryKey: ['replenishment'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const par = useQuery<any>({ queryKey: ['par-recommendations'], queryFn: () => api('/api/replenishment/par-recommendations') });
  const applyPar = useMutation({
    mutationFn: (v: { branch_id: number; item_id: string }) => api('/api/replenishment/par-recommendations/apply', { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: (r: any) => { notifySuccess(r?.applied ? `ปรับจุดสั่งซื้อเป็น ${num(r.reorder_point)} แล้ว` : 'ไม่มีคำแนะนำ'); qc.invalidateQueries({ queryKey: ['par-recommendations'] }); qc.invalidateQueries({ queryKey: ['replenishment'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const parRecs: any[] = (par.data?.recommendations ?? []).filter((r: any) => r.under_buffered);

  const suggestions: any[] = q.data?.suggestions ?? [];
  const transfers = suggestions.filter((s) => s.route === 'transfer');
  const purchases = suggestions.filter((s) => s.route !== 'transfer'); // 'buy' or legacy
  const openTransfers = transfers.filter((s) => s.status === 'Suggested');
  const openBuys = purchases.filter((s) => s.status === 'Suggested');
  const critical = suggestions.filter((s) => s.status === 'Suggested' && s.urgency === 'critical').length;
  const transferQty = openTransfers.reduce((a, s) => a + Number(s.transfer_qty || s.suggested_qty || 0), 0);
  const buyQty = openBuys.reduce((a, s) => a + Number(s.buy_qty || s.suggested_qty || 0), 0);

  return (
    <div>
      <PageHeader
        title="เติมสต๊อกอัตโนมัติ (Replenishment)"
        description="Min-Max แยกตามสาขา — เมื่อสาขาใดคงเหลือ ≤ จุดสั่งซื้อ ระบบจะ “โอนจากสาขาที่มีของเหลือก่อน” แล้วจึง “สั่งซื้อ” ส่วนที่ขาด"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled={recompute.isPending} onClick={() => recompute.mutate()}>
              <RefreshCw className="size-4" /> {recompute.isPending ? 'กำลังคำนวณ…' : 'คำนวณใหม่'}
            </Button>
            <Button variant="outline" disabled={autoTransfer.isPending || openTransfers.length === 0} onClick={() => autoTransfer.mutate()}>
              <ArrowLeftRight className="size-4" /> {autoTransfer.isPending ? 'กำลังโอน…' : 'โอนสต๊อก'}
            </Button>
            <Button disabled={autoPr.isPending || openBuys.length === 0} onClick={() => autoPr.mutate()}>
              <FileText className="size-4" /> {autoPr.isPending ? 'กำลังสร้าง PR…' : 'สร้างใบขอซื้อ (PR)'}
            </Button>
          </div>
        }
      />

      <div className="space-y-5">
        <StateView q={q}>
          {q.data && (
            <div className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard label="รายการโอน (รอดำเนินการ)" value={num(openTransfers.length)} icon={ArrowLeftRight} tone="primary" />
                <StatCard label="รายการสั่งซื้อ (รอดำเนินการ)" value={num(openBuys.length)} icon={PackagePlus} tone="info" />
                <StatCard label="วิกฤต (Critical)" value={num(critical)} icon={AlertTriangle} tone={critical > 0 ? 'danger' : 'default'} />
                <StatCard label="จำนวนโอน · ซื้อ รวม" value={`${num(transferQty)} · ${num(buyQty)}`} icon={Truck} tone="default" />
              </div>

              {/* ── โอนระหว่างสาขา (transfer-first) ── */}
              <section className="space-y-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground"><ArrowLeftRight className="size-4 text-primary" /> โอนระหว่างสาขา (Transfers)</h2>
                <DataTable
                  rows={transfers}
                  columns={[
                    { key: 'suggestion_no', label: 'เลขที่' },
                    { key: 'branch_name', label: 'สาขาที่ขาด', render: (r: any) => r.branch_name ?? `#${r.branch_id ?? '—'}` },
                    { key: 'from_branch_name', label: 'โอนจากสาขา', render: (r: any) => r.from_branch_name ?? `#${r.from_branch_id ?? '—'}` },
                    { key: 'item_id', label: 'รหัสสินค้า' },
                    { key: 'transfer_qty', label: 'จำนวนโอน', align: 'right', render: (r: any) => <span className="tabular font-medium">{num(r.transfer_qty || r.suggested_qty)}</span> },
                    { key: 'urgency', label: 'ความเร่งด่วน', render: (r: any) => <Badge variant={urgencyVariant(r.urgency)}>{r.urgency}</Badge> },
                    { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                  ]}
                  emptyState={{
                    icon: ArrowLeftRight,
                    title: 'ยังไม่มีรายการโอนระหว่างสาขา',
                    description: 'เมื่อมีสาขาที่ขาดสต๊อกและสาขาอื่นมีของเหลือ ระบบจะเสนอให้โอนก่อนสั่งซื้อ',
                  }}
                />
              </section>

              {/* ── สั่งซื้อจากซัพพลายเออร์ (buy residual) ── */}
              <section className="space-y-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground"><PackagePlus className="size-4 text-primary" /> สั่งซื้อจากซัพพลายเออร์ (Purchases)</h2>
                <DataTable
                  rows={purchases}
                  columns={[
                    { key: 'suggestion_no', label: 'เลขที่' },
                    { key: 'branch_name', label: 'สาขา', render: (r: any) => r.branch_name ?? (r.branch_id != null ? `#${r.branch_id}` : '— (รวม)') },
                    { key: 'item_id', label: 'รหัสสินค้า' },
                    { key: 'on_hand', label: 'คงเหลือ', align: 'right', render: (r: any) => <span className="tabular">{num(r.on_hand)}</span> },
                    { key: 'buy_qty', label: 'จำนวนสั่งซื้อ', align: 'right', render: (r: any) => <span className="tabular font-medium">{num(r.buy_qty || r.suggested_qty)}</span> },
                    { key: 'vendor', label: 'ซัพพลายเออร์', render: (r: any) => r.vendor ?? '—' },
                    { key: 'urgency', label: 'ความเร่งด่วน', render: (r: any) => <Badge variant={urgencyVariant(r.urgency)}>{r.urgency}</Badge> },
                    { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                    { key: 'pr_no', label: 'PR', render: (r: any) => r.pr_no ?? '—' },
                  ]}
                  emptyState={{
                    icon: PackageSearch,
                    title: 'ยังไม่มีรายการสั่งซื้อ',
                    description: 'กด “คำนวณใหม่” เพื่อให้ระบบวิเคราะห์สต๊อกแต่ละสาขาและเสนอจำนวนที่ควรสั่งซื้อ',
                  }}
                />
              </section>

              {/* ── จุดสั่งซื้อตามดีมานด์ (demand-driven par recommendations, INV-12) ── */}
              <section className="space-y-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground"><AlertTriangle className="size-4 text-warning" /> จุดสั่งซื้อต่ำกว่าดีมานด์ (Par recommendations)</h2>
                <p className="text-xs text-muted-foreground">จุดสั่งซื้อปัจจุบันต่ำกว่าอัตราการใช้จริง × lead time — แนะนำให้ปรับขึ้นเพื่อกันของขาด</p>
                <DataTable
                  rows={parRecs}
                  columns={[
                    { key: 'branch_id', label: 'สาขา', render: (r: any) => r.branch_id != null ? `#${r.branch_id}` : '—' },
                    { key: 'item_id', label: 'รหัสสินค้า' },
                    { key: 'avg_daily_usage', label: 'ใช้/วัน', align: 'right', render: (r: any) => <span className="tabular">{num(r.avg_daily_usage)}</span> },
                    { key: 'lead_time_days', label: 'lead (วัน)', align: 'right', render: (r: any) => <span className="tabular">{num(r.lead_time_days)}</span> },
                    { key: 'current_reorder_point', label: 'จุดสั่งซื้อปัจจุบัน', align: 'right', render: (r: any) => <span className="tabular">{num(r.current_reorder_point)}</span> },
                    { key: 'recommended_reorder_point', label: 'แนะนำ', align: 'right', render: (r: any) => <span className="tabular font-medium text-warning">{num(r.recommended_reorder_point)}</span> },
                    { key: 'apply', label: '', align: 'right', render: (r: any) => <Button size="sm" variant="outline" disabled={applyPar.isPending} onClick={() => applyPar.mutate({ branch_id: r.branch_id, item_id: r.item_id })}>ปรับ</Button> },
                  ]}
                  emptyState={{
                    icon: PackageSearch,
                    title: 'จุดสั่งซื้อเหมาะสมกับดีมานด์แล้ว',
                    description: 'ทุกสาขามีจุดสั่งซื้อสูงพอเทียบกับอัตราการใช้จริง × lead time',
                  }}
                />
              </section>
            </div>
          )}
        </StateView>
      </div>
    </div>
  );
}
