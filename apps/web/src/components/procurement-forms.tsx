'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Msg } from '@/components/tabs';

// ── PR ──
interface PrLine { item_id: string; item_description: string; request_qty: number; uom: string; required_date: string }
const emptyPrLine = (): PrLine => ({ item_id: '', item_description: '', request_qty: 1, uom: '', required_date: '' });

function PrForm({ onDone }: { onDone: () => void }) {
  const [remarks, setRemarks] = useState('');
  const [priority, setPriority] = useState('');
  const [lines, setLines] = useState<PrLine[]>([emptyPrLine()]);
  const setLine = (i: number, p: Partial<PrLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const mut = useMutation({
    mutationFn: () => api<{ pr_no: string; status: string; lines: number }>('/api/procurement/prs', {
      method: 'POST',
      body: JSON.stringify({
        remarks: remarks || undefined,
        priority: priority || undefined,
        items: lines.filter((l) => l.item_id && Number(l.request_qty) > 0).map((l) => ({
          item_id: l.item_id,
          item_description: l.item_description || undefined,
          request_qty: Number(l.request_qty),
          uom: l.uom || undefined,
          required_date: l.required_date || undefined,
        })),
      }),
    }),
    onSuccess: () => onDone(),
  });

  const valid = lines.some((l) => l.item_id && Number(l.request_qty) > 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="pr-remarks">หมายเหตุ</Label>
          <Input id="pr-remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="หมายเหตุ (ถ้ามี)" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="pr-priority">ความสำคัญ</Label>
          <Input id="pr-priority" value={priority} onChange={(e) => setPriority(e.target.value)} placeholder="เช่น ปกติ / ด่วน" />
        </div>
      </div>
      <div className="space-y-2">
        <Label>รายการสินค้า</Label>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1.5fr_2fr_1fr_1fr_1.3fr_auto] gap-2">
            <Input placeholder="Item ID" value={l.item_id} onChange={(e) => setLine(i, { item_id: e.target.value })} />
            <Input placeholder="รายละเอียด" value={l.item_description} onChange={(e) => setLine(i, { item_description: e.target.value })} />
            <Input type="number" min="0" placeholder="จำนวน" value={l.request_qty} onChange={(e) => setLine(i, { request_qty: +e.target.value })} />
            <Input placeholder="หน่วย" value={l.uom} onChange={(e) => setLine(i, { uom: e.target.value })} />
            <Input type="date" value={l.required_date} onChange={(e) => setLine(i, { required_date: e.target.value })} />
            <Button variant="destructive" size="icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
              <X className="size-4" />
            </Button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => setLines((ls) => [...ls, emptyPrLine()])}>
          <Plus className="size-4" /> รายการ
        </Button>
        <Button disabled={mut.isPending || !valid} onClick={() => mut.mutate()}>
          {mut.isPending ? 'กำลังบันทึก…' : 'สร้าง PR'}
        </Button>
      </div>
      {mut.error && <Msg>{(mut.error as Error).message}</Msg>}
      {mut.data && <Msg ok>✅ สร้าง PR {mut.data.pr_no} · {mut.data.lines} รายการ · สถานะ {mut.data.status}</Msg>}
    </div>
  );
}

// ── PO ──
interface PoLine { item_id: string; item_description: string; order_qty: number; unit_price: number; uom: string; is_capital: boolean }
const emptyPoLine = (): PoLine => ({ item_id: '', item_description: '', order_qty: 1, unit_price: 0, uom: '', is_capital: false });

function PoForm({ onDone }: { onDone: () => void }) {
  const [vendorName, setVendorName] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<PoLine[]>([emptyPoLine()]);
  const setLine = (i: number, p: Partial<PoLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const mut = useMutation({
    mutationFn: () => api<{ po_no: string; status: string }>('/api/procurement/pos', {
      method: 'POST',
      body: JSON.stringify({
        vendor_name: vendorName || undefined,
        vendor_id: vendorId || undefined,
        expected_date: expectedDate || undefined,
        remarks: remarks || undefined,
        items: lines.filter((l) => l.item_id && Number(l.order_qty) > 0).map((l) => ({
          item_id: l.item_id,
          item_description: l.item_description || undefined,
          order_qty: Number(l.order_qty),
          unit_price: Number(l.unit_price),
          uom: l.uom || undefined,
          is_capital: l.is_capital || undefined,
        })),
      }),
    }),
    onSuccess: () => onDone(),
  });

  const valid = lines.some((l) => l.item_id && Number(l.order_qty) > 0 && Number(l.unit_price) >= 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="po-vendor">ผู้ขาย</Label>
          <Input id="po-vendor" value={vendorName} onChange={(e) => setVendorName(e.target.value)} placeholder="ชื่อผู้ขาย" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="po-vendor-id">รหัสผู้ขาย</Label>
          <Input id="po-vendor-id" value={vendorId} onChange={(e) => setVendorId(e.target.value)} placeholder="Vendor ID (ถ้ามี)" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="po-expected">วันที่คาดว่าจะได้รับ</Label>
          <Input id="po-expected" type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="po-remarks">หมายเหตุ</Label>
          <Input id="po-remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="หมายเหตุ (ถ้ามี)" />
        </div>
      </div>
      <div className="space-y-2">
        <Label>รายการสินค้า</Label>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1.5fr_2fr_1fr_1fr_1fr_auto_auto] items-center gap-2">
            <Input placeholder="Item ID" value={l.item_id} onChange={(e) => setLine(i, { item_id: e.target.value })} />
            <Input placeholder="รายละเอียด" value={l.item_description} onChange={(e) => setLine(i, { item_description: e.target.value })} />
            <Input type="number" min="0" placeholder="จำนวน" value={l.order_qty} onChange={(e) => setLine(i, { order_qty: +e.target.value })} />
            <Input type="number" min="0" step="0.01" placeholder="ราคา/หน่วย" value={l.unit_price} onChange={(e) => setLine(i, { unit_price: +e.target.value })} />
            <Input placeholder="หน่วย" value={l.uom} onChange={(e) => setLine(i, { uom: e.target.value })} />
            <label className="flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground" title="รายการทุน (สินทรัพย์ถาวร) — เมื่อรับของจะนำไปตั้งทะเบียนทรัพย์สิน">
              <input type="checkbox" checked={l.is_capital} onChange={(e) => setLine(i, { is_capital: e.target.checked })} /> ทุน
            </label>
            <Button variant="destructive" size="icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
              <X className="size-4" />
            </Button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => setLines((ls) => [...ls, emptyPoLine()])}>
          <Plus className="size-4" /> รายการ
        </Button>
        <Button disabled={mut.isPending || !valid} onClick={() => mut.mutate()}>
          {mut.isPending ? 'กำลังบันทึก…' : 'สร้าง PO'}
        </Button>
      </div>
      {mut.error && <Msg>{(mut.error as Error).message}</Msg>}
      {mut.data && <Msg ok>✅ สร้าง PO {mut.data.po_no} · สถานะ {mut.data.status}</Msg>}
    </div>
  );
}

// ── GR ──
interface GrLine { item_id: string; received_qty: number; lot_no: string; expiry_date: string; unit_cost: number | ''; uom: string }
const emptyGrLine = (): GrLine => ({ item_id: '', received_qty: 1, lot_no: '', expiry_date: '', unit_cost: '', uom: '' });

function GrForm({ onDone }: { onDone: () => void }) {
  const [poNo, setPoNo] = useState('');
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<GrLine[]>([emptyGrLine()]);
  const setLine = (i: number, p: Partial<GrLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const mut = useMutation({
    mutationFn: () => api<{ gr_no: string; po_no: string; po_status: string; lines: number }>('/api/procurement/grs', {
      method: 'POST',
      body: JSON.stringify({
        po_no: poNo,
        remarks: remarks || undefined,
        items: lines.filter((l) => l.item_id && Number(l.received_qty) > 0).map((l) => ({
          item_id: l.item_id,
          received_qty: Number(l.received_qty),
          lot_no: l.lot_no || undefined,
          expiry_date: l.expiry_date || undefined,
          unit_cost: l.unit_cost === '' ? undefined : Number(l.unit_cost),
          uom: l.uom || undefined,
        })),
      }),
    }),
    onSuccess: () => onDone(),
  });

  const valid = !!poNo && lines.some((l) => l.item_id && Number(l.received_qty) > 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:max-w-sm">
        <Label htmlFor="gr-po">เลขที่ใบสั่งซื้อ (PO No.)</Label>
        <Input id="gr-po" value={poNo} onChange={(e) => setPoNo(e.target.value)} placeholder="PO-…" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="gr-remarks">หมายเหตุ</Label>
        <Input id="gr-remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="หมายเหตุ (ถ้ามี)" />
      </div>
      <div className="space-y-2">
        <Label>รายการรับเข้า</Label>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1.5fr_1fr_1.3fr_1.3fr_1fr_1fr_auto] gap-2">
            <Input placeholder="Item ID" value={l.item_id} onChange={(e) => setLine(i, { item_id: e.target.value })} />
            <Input type="number" min="0" placeholder="รับ" value={l.received_qty} onChange={(e) => setLine(i, { received_qty: +e.target.value })} />
            <Input placeholder="Lot" value={l.lot_no} onChange={(e) => setLine(i, { lot_no: e.target.value })} />
            <Input type="date" value={l.expiry_date} onChange={(e) => setLine(i, { expiry_date: e.target.value })} />
            <Input type="number" min="0" step="0.01" placeholder="ต้นทุน" value={l.unit_cost} onChange={(e) => setLine(i, { unit_cost: e.target.value === '' ? '' : +e.target.value })} />
            <Input placeholder="หน่วย" value={l.uom} onChange={(e) => setLine(i, { uom: e.target.value })} />
            <Button variant="destructive" size="icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
              <X className="size-4" />
            </Button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => setLines((ls) => [...ls, emptyGrLine()])}>
          <Plus className="size-4" /> รายการ
        </Button>
        <Button disabled={mut.isPending || !valid} onClick={() => mut.mutate()}>
          {mut.isPending ? 'กำลังบันทึก…' : 'รับสินค้า (GR)'}
        </Button>
      </div>
      {mut.error && <Msg>{(mut.error as Error).message}</Msg>}
      {mut.data && <Msg ok>✅ รับสินค้า {mut.data.gr_no} · PO {mut.data.po_no} → {mut.data.po_status} · {mut.data.lines} รายการ</Msg>}
    </div>
  );
}

export function ProcurementForms({ poListQueryKey }: { poListQueryKey: unknown[] }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: poListQueryKey });

  return (
    <Tabs defaultValue="pr" className="gap-4">
      <TabsList className="flex-wrap">
        <TabsTrigger value="pr">สร้าง PR</TabsTrigger>
        <TabsTrigger value="po">สร้าง PO</TabsTrigger>
        <TabsTrigger value="gr">รับสินค้า GR</TabsTrigger>
      </TabsList>
      <TabsContent value="pr"><PrForm onDone={refresh} /></TabsContent>
      <TabsContent value="po"><PoForm onDone={refresh} /></TabsContent>
      <TabsContent value="gr"><GrForm onDone={refresh} /></TabsContent>
    </Tabs>
  );
}
