'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Msg } from '@/components/tabs';
import { statusVariant } from '@/components/ui';

interface Line { item_id: string; order_qty: number; unit_price: number }

export default function ProcurementPage() {
  const qc = useQueryClient();
  const pos = useQuery<any>({ queryKey: ['proc-pos'], queryFn: () => api('/api/inventory/purchase-orders?limit=50') });
  const [vendor, setVendor] = useState('');
  const [lines, setLines] = useState<Line[]>([{ item_id: '', order_qty: 1, unit_price: 0 }]);
  const setLine = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const mut = useMutation({
    mutationFn: () => api<{ po_no: string; total_amount: number }>('/api/procurement/pos', {
      method: 'POST',
      body: JSON.stringify({ vendor_name: vendor || undefined, items: lines.filter((l) => l.item_id).map((l) => ({ item_id: l.item_id, order_qty: Number(l.order_qty), unit_price: Number(l.unit_price) })) }),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['proc-pos'] }),
  });

  return (
    <div>
      <PageHeader title="จัดซื้อ (Procurement)" description="สร้างใบสั่งซื้อและติดตามสถานะ" />

      <Card className="mb-6 max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">สร้าง PO</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="vendor">ผู้ขาย</Label>
            <Input id="vendor" value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="ชื่อผู้ขาย" />
          </div>
          <div className="space-y-2">
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-[2fr_1fr_1fr_auto] gap-2">
                <Input placeholder="Item ID" value={l.item_id} onChange={(e) => setLine(i, { item_id: e.target.value })} />
                <Input type="number" value={l.order_qty} onChange={(e) => setLine(i, { order_qty: +e.target.value })} />
                <Input type="number" value={l.unit_price} onChange={(e) => setLine(i, { unit_price: +e.target.value })} />
                <Button variant="destructive" size="icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                  <X className="size-4" />
                </Button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => setLines((ls) => [...ls, { item_id: '', order_qty: 1, unit_price: 0 }])}>
              <Plus className="size-4" /> รายการ
            </Button>
            <Button disabled={mut.isPending || !lines.some((l) => l.item_id)} onClick={() => mut.mutate()}>
              {mut.isPending ? 'กำลังบันทึก…' : 'สร้าง PO (สถานะ Pending)'}
            </Button>
          </div>
          {mut.error && <Msg>{(mut.error as Error).message}</Msg>}
          {mut.data && <Msg ok>✅ {mut.data.po_no} · {baht(mut.data.total_amount)}</Msg>}
        </CardContent>
      </Card>

      <h3 className="mb-3 text-sm font-semibold text-muted-foreground">ใบสั่งซื้อ</h3>
      <StateView q={pos}>
        {pos.data && (
          <DataTable
            rows={pos.data.purchase_orders}
            columns={[
              { key: 'PO_No', label: 'PO' },
              { key: 'PO_Date', label: 'วันที่', render: (r: any) => thaiDate(r.PO_Date) },
              { key: 'Supplier_Name', label: 'ผู้ขาย' },
              { key: 'Total_Amount', label: 'ยอด', align: 'right', render: (r: any) => baht(r.Total_Amount) },
              { key: 'Status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.Status)}>{r.Status}</Badge> },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}
