'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ArrowLeft, CheckCircle2, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';

interface Line { item_id: string; order_qty: number; unit_price: number }

export default function NewOrderPage() {
  const qc = useQueryClient();
  const [customer, setCustomer] = useState('');
  const [lines, setLines] = useState<Line[]>([{ item_id: '', order_qty: 1, unit_price: 0 }]);

  const total = lines.reduce((a, l) => a + Number(l.order_qty) * Number(l.unit_price), 0);

  const mut = useMutation({
    mutationFn: () =>
      api<{ order_no: string; total: number; points_earned: number }>('/api/pos/orders', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: customer || undefined,
          items: lines.filter((l) => l.item_id && Number(l.order_qty) > 0).map((l) => ({ item_id: l.item_id, order_qty: Number(l.order_qty), unit_price: Number(l.unit_price) })),
        }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
  });

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <div>
      <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2 text-muted-foreground">
        <Link href="/pos">
          <ArrowLeft className="size-4" /> กลับ
        </Link>
      </Button>

      <PageHeader title="สร้างออเดอร์" description="เลือกสินค้าและสร้างรายการขายใหม่" />

      <div className="grid gap-6 lg:grid-cols-[1fr_360px] lg:items-start">
        {/* Items list */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">รายการสินค้า</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="customer">ลูกค้า (Customer code)</Label>
              <Input
                id="customer"
                value={customer}
                onChange={(e) => setCustomer(e.target.value)}
                placeholder="เช่น T1 (เว้นว่าง = ไม่ระบุ)"
              />
            </div>

            <Separator />

            <div className="hidden grid-cols-[2fr_1fr_1fr_auto] gap-3 px-1 text-xs font-medium text-muted-foreground sm:grid">
              <span>Item ID</span>
              <span className="text-right">จำนวน</span>
              <span className="text-right">ราคา</span>
              <span className="w-9" />
            </div>

            <div className="space-y-3">
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-2 gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-center">
                  <Input
                    className="col-span-2 sm:col-span-1"
                    placeholder="Item ID"
                    value={l.item_id}
                    onChange={(e) => setLine(i, { item_id: e.target.value })}
                  />
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    className="tabular text-right"
                    placeholder="จำนวน"
                    value={l.order_qty}
                    onChange={(e) => setLine(i, { order_qty: +e.target.value })}
                  />
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    className="tabular text-right"
                    placeholder="ราคา"
                    value={l.unit_price}
                    onChange={(e) => setLine(i, { unit_price: +e.target.value })}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive"
                    aria-label="ลบรายการ"
                    onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => setLines((ls) => [...ls, { item_id: '', order_qty: 1, unit_price: 0 }])}
            >
              <Plus className="size-4" /> เพิ่มรายการ
            </Button>
          </CardContent>
        </Card>

        {/* Cart / summary */}
        <Card className="lg:sticky lg:top-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShoppingCart className="size-4" /> สรุปออเดอร์
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">จำนวนรายการ</span>
              <span className="tabular font-medium">{lines.filter((l) => l.item_id).length}</span>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">รวมทั้งสิ้น</span>
              <span className="tabular text-2xl font-semibold tracking-tight">{baht(total)}</span>
            </div>

            <Button
              className="w-full"
              disabled={mut.isPending || !lines.some((l) => l.item_id && Number(l.order_qty) > 0)}
              onClick={() => mut.mutate()}
            >
              {mut.isPending ? 'กำลังบันทึก…' : 'ยืนยันออเดอร์'}
            </Button>

            {mut.error && (
              <Alert variant="destructive">
                <AlertDescription>{(mut.error as Error).message}</AlertDescription>
              </Alert>
            )}
            {mut.data && (
              <Alert className="border-success/30 text-success">
                <CheckCircle2 className="size-4" />
                <AlertDescription className="text-success/90">
                  สร้างสำเร็จ: <strong>{mut.data.order_no}</strong> · ยอด <span className="tabular">{baht(mut.data.total)}</span> · แต้ม +
                  <span className="tabular">{mut.data.points_earned}</span>
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
