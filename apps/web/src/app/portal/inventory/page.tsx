'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { statusVariant } from '@/components/ui';

function StockTab() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['portal-inv'], queryFn: () => api('/api/portal/inventory') });
  const [edit, setEdit] = useState<Record<number, { reorder_point?: number; reorder_qty?: number; current_stock?: number }>>({});
  const save = useMutation({
    mutationFn: (id: number) => api(`/api/portal/inventory/${id}`, { method: 'PATCH', body: JSON.stringify(edit[id]) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal-inv'] }),
  });
  return (
    <StateView q={q}>
      {q.data && (
        <DataTable rows={q.data.items} columns={[
          { key: 'item_id', label: 'รหัส' },
          { key: 'item_description', label: 'ชื่อสินค้า' },
          { key: 'current_stock', label: 'คงเหลือ', align: 'right', render: (r) => <Input className="ml-auto h-8 w-20 text-right tabular" type="number" defaultValue={r.current_stock} onChange={(e) => setEdit((s) => ({ ...s, [r.id]: { ...s[r.id], current_stock: +e.target.value } }))} /> },
          { key: 'reorder_point', label: 'จุดสั่งซื้อ', align: 'right', render: (r) => <Input className="ml-auto h-8 w-20 text-right tabular" type="number" defaultValue={r.reorder_point} onChange={(e) => setEdit((s) => ({ ...s, [r.id]: { ...s[r.id], reorder_point: +e.target.value } }))} /> },
          { key: 'reorder_qty', label: 'จำนวนสั่ง', align: 'right', render: (r) => <Input className="ml-auto h-8 w-20 text-right tabular" type="number" defaultValue={r.reorder_qty} onChange={(e) => setEdit((s) => ({ ...s, [r.id]: { ...s[r.id], reorder_qty: +e.target.value } }))} /> },
          { key: 'low_stock', label: 'สถานะ', render: (r) => (r.low_stock ? <Badge variant="warning">ต้องสั่ง</Badge> : <Check className="size-4 text-success" />) },
          { key: 'save', label: '', align: 'right', render: (r) => <Button size="sm" variant="outline" disabled={!edit[r.id]} onClick={() => save.mutate(r.id)}>บันทึก</Button> },
        ]} />
      )}
    </StateView>
  );
}

function PendingTab() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['portal-pending'], queryFn: () => api('/api/portal/pending-orders') });
  const submit = useMutation({
    mutationFn: (no: string) => api(`/api/portal/pending-orders/${encodeURIComponent(no)}/submit`, { method: 'PATCH' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal-pending'] }),
  });
  return (
    <StateView q={q}>
      {q.data && (q.data.pending_orders.length === 0
        ? <Card className="gap-0 p-5"><CardContent className="px-0 text-sm text-muted-foreground">ยังไม่มีใบสั่งซื้อรออนุมัติ</CardContent></Card>
        : <div className="space-y-3">{q.data.pending_orders.map((p: any) => (
          <Card key={p.pending_no} className="gap-4 p-5">
            <CardContent className="space-y-3 px-0">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{p.pending_no}</strong>
                  <Badge variant={statusVariant(p.status)}>{p.status}</Badge>
                  <span className="text-sm text-muted-foreground">· {p.trigger_type} · {num(p.total_items)} รายการ</span>
                </div>
                {p.status === 'Draft' && (
                  <Button size="sm" disabled={submit.isPending} onClick={() => submit.mutate(p.pending_no)}>
                    <Send className="size-4" /> ส่งขออนุมัติ
                  </Button>
                )}
              </div>
              <DataTable
                dense
                rows={p.items}
                columns={[
                  { key: 'item', label: 'สินค้า', render: (it: any) => it.item_description ?? it.item_id },
                  { key: 'suggested_qty', label: 'แนะนำ', align: 'right', render: (it: any) => num(it.suggested_qty) },
                  { key: 'final_qty', label: 'สั่งจริง', align: 'right', render: (it: any) => num(it.final_qty) },
                  { key: 'trigger_reason', label: 'เหตุผล', render: (it: any) => <span className="text-muted-foreground">{it.trigger_reason}</span> },
                ]}
              />
            </CardContent>
          </Card>
        ))}</div>)}
    </StateView>
  );
}

export default function PortalInventory() {
  return (
    <div>
      <PageHeader title="สต๊อก & สั่งซื้อซ้ำ" description="จัดการสต๊อกและใบสั่งซื้ออัตโนมัติ" />
      <Tabs tabs={[{ key: 'stock', label: 'สต๊อกของฉัน', content: <StockTab /> }, { key: 'pending', label: 'ใบสั่งซื้ออัตโนมัติ', content: <PendingTab /> }]} />
    </div>
  );
}
