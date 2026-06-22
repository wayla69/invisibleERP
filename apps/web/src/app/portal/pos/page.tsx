'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs, Msg } from '@/components/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { statusVariant } from '@/components/ui';

interface Line { item_id: string; qty: number; unit_price: number; discount_pct: number }
const VAT = 0.07;

function NewSale() {
  const qc = useQueryClient();
  const [lines, setLines] = useState<Line[]>([{ item_id: '', qty: 1, unit_price: 0, discount_pct: 0 }]);
  const [payment, setPayment] = useState('Cash');
  const setLine = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const subtotal = lines.reduce((a, l) => a + Number(l.qty) * Number(l.unit_price) * (1 - Number(l.discount_pct) / 100), 0);
  const vat = subtotal * VAT;
  const total = subtotal + vat;

  const mut = useMutation({
    mutationFn: () => api<{ sale_no: string; total: number; points_earned: number }>('/api/portal/pos/sales', {
      method: 'POST',
      body: JSON.stringify({ payment_method: payment, items: lines.filter((l) => l.item_id).map((l) => ({ item_id: l.item_id, qty: Number(l.qty), unit_price: Number(l.unit_price), discount_pct: Number(l.discount_pct) })) }),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['portal-sales'] }); setLines([{ item_id: '', qty: 1, unit_price: 0, discount_pct: 0 }]); },
  });

  return (
    <Card className="max-w-3xl gap-4 p-5">
      <CardContent className="space-y-4 px-0">
        <h3 className="text-base font-semibold">ขายสินค้า</h3>

        <div className="grid grid-cols-[2fr_1fr_1fr_1fr_auto] gap-2 text-xs text-muted-foreground">
          <span>รหัสสินค้า</span>
          <span>จำนวน</span>
          <span>ราคา/หน่วย</span>
          <span>ส่วนลด %</span>
          <span />
        </div>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[2fr_1fr_1fr_1fr_auto] items-center gap-2">
            <Input placeholder="Item ID" value={l.item_id} onChange={(e) => setLine(i, { item_id: e.target.value })} />
            <Input type="number" value={l.qty} onChange={(e) => setLine(i, { qty: +e.target.value })} />
            <Input type="number" value={l.unit_price} onChange={(e) => setLine(i, { unit_price: +e.target.value })} />
            <Input type="number" value={l.discount_pct} onChange={(e) => setLine(i, { discount_pct: +e.target.value })} />
            <Button variant="destructive" size="icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        <Button variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, { item_id: '', qty: 1, unit_price: 0, discount_pct: 0 }])}>
          <Plus className="size-4" /> เพิ่มรายการ
        </Button>

        <div className="flex flex-wrap items-center gap-6">
          <div className="grid gap-2">
            <Label htmlFor="payment">การชำระเงิน</Label>
            <Select value={payment} onValueChange={setPayment}>
              <SelectTrigger id="payment" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Cash">Cash</SelectItem>
                <SelectItem value="QR Code">QR Code</SelectItem>
                <SelectItem value="Transfer">Transfer</SelectItem>
                <SelectItem value="Card">Card</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1 text-right">
            <div className="text-sm text-muted-foreground">ยอดรวม {baht(subtotal)} + VAT 7% {baht(vat)}</div>
            <div className="text-2xl">สุทธิ <strong className="tabular">{baht(total)}</strong></div>
          </div>
        </div>

        <Button className="w-full" disabled={mut.isPending || !lines.some((l) => l.item_id)} onClick={() => mut.mutate()}>
          <Wallet className="size-4" /> {mut.isPending ? 'กำลังบันทึก…' : 'ยืนยันการขาย'}
        </Button>
        {mut.error && <Msg>{(mut.error as Error).message}</Msg>}
        {mut.data && <Msg ok>✅ ขายสำเร็จ {mut.data.sale_no} · สุทธิ {baht(mut.data.total)} · ได้แต้ม +{mut.data.points_earned}</Msg>}
      </CardContent>
    </Card>
  );
}

function History() {
  const q = useQuery<any>({ queryKey: ['portal-sales'], queryFn: () => api('/api/portal/pos/sales?limit=50') });
  return (
    <StateView q={q}>
      {q.data && (
        <DataTable rows={q.data.sales} columns={[
          { key: 'sale_no', label: 'เลขที่' },
          { key: 'sale_date', label: 'วันที่', render: (r) => thaiDate(r.sale_date) },
          { key: 'total', label: 'ยอดสุทธิ', align: 'right', render: (r) => baht(r.total) },
          { key: 'points_earned', label: 'แต้ม', align: 'right', render: (r) => `+${num(r.points_earned)}` },
          { key: 'payment_method', label: 'ชำระ' },
          { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
        ]} />
      )}
    </StateView>
  );
}

export default function PortalPos() {
  return (
    <div>
      <PageHeader title="ขายสินค้า (POS)" description="บันทึกการขายและดูประวัติ" />
      <Tabs tabs={[{ key: 'new', label: 'ขายใหม่', content: <NewSale /> }, { key: 'hist', label: 'ประวัติการขาย', content: <History /> }]} />
    </div>
  );
}
