'use client';

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ClipboardCheck, PackageMinus, SlidersHorizontal, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable, type Column } from '@/components/data-table';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StateView } from '@/components/state-view';
import { statusVariant } from '@/components/ui';

// Stock Adjustment screen (SoD R11: wh_adjust only).
// An Inventory Controller reviews and posts variance adjustments from counted stocktakes,
// and approves write-off requests. A Stock Counter (wh_count only) cannot access this screen.

interface Stocktake { st_no: string; st_date: string; counted_by: string; lines: number; variance_lines: number; status: string }
interface StockList { stocktakes: Stocktake[] }
interface Writeoff { id: number; writeoff_no: string; item_id: string; item_description?: string; qty: number; uom?: string; reason?: string; status: string; requested_by: string; requested_at: string }
interface WriteoffList { writeoffs: Writeoff[] }

export default function StockAdjustmentPage() {
  const qc = useQueryClient();
  const [directOpen, setDirectOpen] = useState(false);

  const pending = useQuery<StockList>({
    queryKey: ['stocktakes', 'Counted'],
    queryFn: () => api('/api/stocktake?limit=50'),
  });
  const counts = (pending.data?.stocktakes ?? []).filter((s) => s.status === 'Counted');

  const writeoffs = useQuery<WriteoffList>({
    queryKey: ['writeoffs', 'Pending'],
    queryFn: () => api('/api/inventory/writeoffs?status=Pending'),
  });

  const totalPending = counts.length + (writeoffs.data?.writeoffs.length ?? 0);

  const postCount = useMutation({
    mutationFn: (stNo: string) => api(`/api/stocktake/${encodeURIComponent(stNo)}/post`, { method: 'POST', body: '{}' }),
    onSuccess: (r: any, stNo) => {
      notifySuccess(`ลงบัญชีใบนับ ${stNo} (${r?.variance_movements ?? 0} รายการปรับ)`);
      qc.invalidateQueries({ queryKey: ['stocktakes'] });
    },
    onError: (e: any) => notifyError(e?.message ?? 'ลงบัญชีไม่สำเร็จ'),
  });

  const approveWo = useMutation({
    mutationFn: (id: number) => api(`/api/inventory/writeoffs/${id}/approve`, { method: 'POST', body: '{}' }),
    onSuccess: () => { notifySuccess('อนุมัติการตัดสต๊อกสำเร็จ'); qc.invalidateQueries({ queryKey: ['writeoffs'] }); },
    onError: (e: any) => notifyError(e?.message ?? 'อนุมัติไม่สำเร็จ'),
  });

  const rejectWo = useMutation({
    mutationFn: (id: number) => api(`/api/inventory/writeoffs/${id}/reject`, { method: 'POST', body: '{}' }),
    onSuccess: () => { notifySuccess('ปฏิเสธการตัดสต๊อกแล้ว'); qc.invalidateQueries({ queryKey: ['writeoffs'] }); },
    onError: (e: any) => notifyError(e?.message ?? 'ปฏิเสธไม่สำเร็จ'),
  });

  const countCols: Column<Stocktake>[] = [
    { key: 'st_no', label: 'เลขที่', render: (r) => <span className="font-medium">{r.st_no}</span> },
    { key: 'st_date', label: 'วันที่นับ', render: (r) => thaiDate(r.st_date) },
    { key: 'counted_by', label: 'ผู้นับ' },
    { key: 'lines', label: 'รายการ', align: 'right', render: (r) => num(r.lines) },
    { key: 'variance_lines', label: 'มีผลต่าง', align: 'right', render: (r) => <span className={r.variance_lines > 0 ? 'font-medium text-destructive' : ''}>{num(r.variance_lines)}</span> },
    { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    {
      key: 'st_no', label: 'การดำเนินการ',
      render: (r) => (
        <Button size="sm" className="h-7 gap-1" disabled={postCount.isPending}
          onClick={() => postCount.mutate(r.st_no)}>
          <ClipboardCheck className="size-3.5" />ลงบัญชีผลต่าง
        </Button>
      ),
    },
  ];

  const woCols: Column<Writeoff>[] = [
    { key: 'writeoff_no', label: 'เลขที่ตัดสต๊อก', render: (r) => <span className="font-medium">{r.writeoff_no}</span> },
    { key: 'item_id', label: 'รหัสสินค้า' },
    { key: 'item_description', label: 'สินค้า', render: (r) => r.item_description ?? '—' },
    { key: 'qty', label: 'จำนวน', align: 'right', render: (r) => <span className="tabular text-destructive">−{num(r.qty)} {r.uom ?? ''}</span> },
    { key: 'reason', label: 'เหตุผล', render: (r) => r.reason ?? '—' },
    { key: 'requested_by', label: 'ผู้ขอ' },
    {
      key: 'id', label: 'การดำเนินการ',
      render: (r) => (
        <div className="flex gap-1.5">
          <Button size="sm" variant="secondary" className="h-7 gap-1 text-green-700"
            disabled={approveWo.isPending} onClick={() => approveWo.mutate(r.id)}>
            <CheckCircle2 className="size-3.5" />อนุมัติ
          </Button>
          <Button size="sm" variant="ghost" className="h-7 gap-1 text-destructive"
            disabled={rejectWo.isPending} onClick={() => rejectWo.mutate(r.id)}>
            <XCircle className="size-3.5" />ปฏิเสธ
          </Button>
        </div>
      ),
    },
  ];

  return (
    <ModulePage
      title="อนุมัติปรับสต๊อก (Stock Adjustment)"
      description="Inventory Controller ลงบัญชีผลต่างจากใบนับสต๊อก และอนุมัติการตัดสต๊อก — ต้องมีสิทธิ์ wh_adjust เท่านั้น (SoD R11)"
      query={pending}
      actions={
        <Button size="sm" variant="outline" onClick={() => setDirectOpen(true)}>
          <SlidersHorizontal className="mr-1.5 size-4" />ปรับสต๊อกโดยตรง
        </Button>
      }
      stats={
        <>
          <StatCard label="รออนุมัติ" value={num(totalPending)} icon={ClipboardCheck} tone={totalPending > 0 ? 'warning' : 'default'} />
          <StatCard label="ใบนับรอลงบัญชี" value={num(counts.length)} icon={ClipboardCheck} tone={counts.length > 0 ? 'primary' : 'default'} />
          <StatCard label="ตัดสต๊อกรออนุมัติ" value={num(writeoffs.data?.writeoffs.length ?? 0)} icon={PackageMinus} tone={(writeoffs.data?.writeoffs.length ?? 0) > 0 ? 'warning' : 'default'} />
        </>
      }
      statsClassName="xl:grid-cols-3"
    >
      <Tabs
        tabs={[
          {
            key: 'counts',
            label: `ใบนับรอลงบัญชี (${counts.length})`,
            content: (
              <DataTable
                rows={counts}
                rowKey={(r) => r.st_no}
                emptyState={{ icon: ClipboardCheck, title: 'ไม่มีใบนับที่รอลงบัญชี', description: 'ใบนับที่ Stock Counter บันทึกเสร็จจะปรากฏที่นี่' }}
                columns={countCols}
              />
            ),
          },
          {
            key: 'writeoffs',
            label: `ตัดสต๊อกรออนุมัติ (${writeoffs.data?.writeoffs.length ?? 0})`,
            content: (
              <StateView q={writeoffs}>
                <DataTable
                  rows={writeoffs.data?.writeoffs ?? []}
                  rowKey={(r) => r.writeoff_no}
                  emptyState={{ icon: PackageMinus, title: 'ไม่มีการตัดสต๊อกที่รออนุมัติ', description: 'คำขอตัดสต๊อกจากพนักงานคลังจะปรากฏที่นี่' }}
                  columns={woCols}
                />
              </StateView>
            ),
          },
        ]}
      />

      {directOpen && <DirectAdjustDialog onClose={() => setDirectOpen(false)} onDone={() => { setDirectOpen(false); qc.invalidateQueries(); }} />}
    </ModulePage>
  );
}

function DirectAdjustDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [itemId, setItemId] = useState('');
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');

  const adj = useMutation({
    mutationFn: () => api('/api/inventory/adjustments', { method: 'POST', body: JSON.stringify({ item_id: itemId, qty_delta: Number(delta), reason }) }),
    onSuccess: () => { notifySuccess('ปรับสต๊อกสำเร็จ'); onDone(); },
    onError: (e: any) => notifyError(e?.message ?? 'ปรับสต๊อกไม่สำเร็จ'),
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>ปรับสต๊อกโดยตรง (Direct Adjustment)</DialogTitle></DialogHeader>
        <Card className="border-0 shadow-none p-0">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="adj-item">รหัสสินค้า</Label>
              <Input id="adj-item" value={itemId} onChange={(e) => setItemId(e.target.value)} placeholder="เช่น P001" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="adj-delta">ผลต่าง (+/-)</Label>
              <Input id="adj-delta" type="number" value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="เช่น -5 หรือ +10" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="adj-reason">เหตุผล</Label>
              <textarea id="adj-reason" className="min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
                value={reason} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setReason(e.target.value)}
                placeholder="เหตุผลในการปรับสต๊อก…" rows={2} />
            </div>
          </div>
        </Card>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>ยกเลิก</Button>
          <Button disabled={!itemId || !delta || adj.isPending} onClick={() => adj.mutate()}>
            <SlidersHorizontal className="mr-1.5 size-4" />ปรับสต๊อก
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
