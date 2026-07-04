'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { api } from '@/lib/api';
import { notifyError, notifySuccess } from '@/lib/notify';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FormField } from '@/components/form-field';

// Shared line-error affordance: a red hint under a line row (shown only after a submit attempt). Line-level
// validation only kicks in once a line has an Item ID, so the trailing empty "add-a-line" row never nags.
function LineError({ show, msg }: { show: boolean; msg?: string | null }) {
  if (!show || !msg) return null;
  return <p className="col-span-full -mt-1 text-xs text-destructive" role="alert">{msg}</p>;
}

const posNum = (v: unknown) => Number(v) > 0;
const nonNeg = (v: unknown) => Number(v) >= 0;

// ── PR ──
interface PrLine { item_id: string; item_description: string; request_qty: number; uom: string; required_date: string }
const emptyPrLine = (): PrLine => ({ item_id: '', item_description: '', request_qty: 1, uom: '', required_date: '' });

export function PrForm({ onDone }: { onDone?: () => void }) {
  const [remarks, setRemarks] = useState('');
  const [priority, setPriority] = useState('');
  const [lines, setLines] = useState<PrLine[]>([emptyPrLine()]);
  const [showErrors, setShowErrors] = useState(false);
  const setLine = (i: number, p: Partial<PrLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const lineErr = (l: PrLine) => (l.item_id.trim() && !posNum(l.request_qty) ? 'จำนวนต้องมากกว่า 0' : null);
  const submittable = lines.filter((l) => l.item_id.trim() && posNum(l.request_qty));
  const formErr = submittable.length === 0 ? 'ต้องมีอย่างน้อย 1 รายการที่มี Item ID และจำนวนมากกว่า 0' : null;
  const invalid = !!formErr || lines.some((l) => lineErr(l));

  const mut = useMutation({
    mutationFn: () => api<{ pr_no: string; status: string; lines: number }>('/api/procurement/prs', {
      method: 'POST',
      body: JSON.stringify({
        remarks: remarks || undefined,
        priority: priority || undefined,
        items: submittable.map((l) => ({
          item_id: l.item_id,
          item_description: l.item_description || undefined,
          request_qty: Number(l.request_qty),
          uom: l.uom || undefined,
          required_date: l.required_date || undefined,
        })),
      }),
    }),
    onSuccess: (d) => { notifySuccess(`สร้าง PR ${d.pr_no}`, `${d.lines} รายการ · สถานะ ${d.status}`); onDone?.(); },
    onError: (e: any) => notifyError(e?.message ?? 'สร้าง PR ไม่สำเร็จ'),
  });

  const submit = () => { setShowErrors(true); if (invalid) { notifyError('กรุณาแก้ไขข้อมูลที่ไม่ถูกต้องก่อนบันทึก'); return; } mut.mutate(); };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField htmlFor="pr-remarks" label="หมายเหตุ">
          <Input id="pr-remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="หมายเหตุ (ถ้ามี)" />
        </FormField>
        <FormField htmlFor="pr-priority" label="ความสำคัญ" hint="เช่น ปกติ / ด่วน">
          <Input id="pr-priority" value={priority} onChange={(e) => setPriority(e.target.value)} placeholder="เช่น ปกติ / ด่วน" />
        </FormField>
      </div>
      <div className="space-y-2">
        <Label>รายการสินค้า</Label>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1.5fr_2fr_1fr_1fr_1.3fr_auto] gap-2">
            <Input placeholder="Item ID" value={l.item_id} aria-invalid={showErrors && !!lineErr(l)} onChange={(e) => setLine(i, { item_id: e.target.value })} />
            <Input placeholder="รายละเอียด" value={l.item_description} onChange={(e) => setLine(i, { item_description: e.target.value })} />
            <Input type="number" min="0" placeholder="จำนวน" value={l.request_qty} aria-invalid={showErrors && !!lineErr(l)} onChange={(e) => setLine(i, { request_qty: +e.target.value })} />
            <Input placeholder="หน่วย" value={l.uom} onChange={(e) => setLine(i, { uom: e.target.value })} />
            <Input type="date" value={l.required_date} onChange={(e) => setLine(i, { required_date: e.target.value })} />
            <Button variant="destructive" size="icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
              <X className="size-4" />
            </Button>
            <LineError show={showErrors} msg={lineErr(l)} />
          </div>
        ))}
        {showErrors && formErr && <p className="text-xs text-destructive" role="alert">{formErr}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => setLines((ls) => [...ls, emptyPrLine()])}>
          <Plus className="size-4" /> รายการ
        </Button>
        <Button disabled={mut.isPending} onClick={submit}>
          {mut.isPending ? 'กำลังบันทึก…' : 'สร้าง PR'}
        </Button>
      </div>
    </div>
  );
}

// ── PO ──
interface PoLine { item_id: string; item_description: string; order_qty: number; unit_price: number; uom: string; is_capital: boolean }
const emptyPoLine = (): PoLine => ({ item_id: '', item_description: '', order_qty: 1, unit_price: 0, uom: '', is_capital: false });

export function PoForm({ onDone }: { onDone?: () => void }) {
  const [vendorName, setVendorName] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<PoLine[]>([emptyPoLine()]);
  const [showErrors, setShowErrors] = useState(false);
  const setLine = (i: number, p: Partial<PoLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const vendorErr = !vendorName.trim() && !vendorId.trim() ? 'ระบุชื่อหรือรหัสผู้ขายอย่างน้อยหนึ่งอย่าง' : null;
  const lineErr = (l: PoLine) => {
    if (!l.item_id.trim()) return null;
    if (!posNum(l.order_qty)) return 'จำนวนต้องมากกว่า 0';
    if (!nonNeg(l.unit_price)) return 'ราคาต่อหน่วยต้องไม่ติดลบ';
    return null;
  };
  const submittable = lines.filter((l) => l.item_id.trim() && posNum(l.order_qty) && nonNeg(l.unit_price));
  const formErr = submittable.length === 0 ? 'ต้องมีอย่างน้อย 1 รายการที่มี Item ID และจำนวนมากกว่า 0' : null;
  const invalid = !!vendorErr || !!formErr || lines.some((l) => lineErr(l));

  const mut = useMutation({
    mutationFn: () => api<{ po_no: string; status: string }>('/api/procurement/pos', {
      method: 'POST',
      body: JSON.stringify({
        vendor_name: vendorName || undefined,
        vendor_id: vendorId || undefined,
        expected_date: expectedDate || undefined,
        remarks: remarks || undefined,
        items: submittable.map((l) => ({
          item_id: l.item_id,
          item_description: l.item_description || undefined,
          order_qty: Number(l.order_qty),
          unit_price: Number(l.unit_price),
          uom: l.uom || undefined,
          is_capital: l.is_capital || undefined,
        })),
      }),
    }),
    onSuccess: (d) => { notifySuccess(`สร้าง PO ${d.po_no}`, `สถานะ ${d.status}`); onDone?.(); },
    onError: (e: any) => notifyError(e?.message ?? 'สร้าง PO ไม่สำเร็จ'),
  });

  const submit = () => { setShowErrors(true); if (invalid) { notifyError('กรุณาแก้ไขข้อมูลที่ไม่ถูกต้องก่อนบันทึก'); return; } mut.mutate(); };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField htmlFor="po-vendor" label="ผู้ขาย" required error={showErrors ? vendorErr : undefined}>
          <Input id="po-vendor" value={vendorName} aria-invalid={showErrors && !!vendorErr} onChange={(e) => setVendorName(e.target.value)} placeholder="ชื่อผู้ขาย" />
        </FormField>
        <FormField htmlFor="po-vendor-id" label="รหัสผู้ขาย" hint="ระบุแทน/เพิ่มเติมจากชื่อผู้ขายได้">
          <Input id="po-vendor-id" value={vendorId} aria-invalid={showErrors && !!vendorErr} onChange={(e) => setVendorId(e.target.value)} placeholder="Vendor ID (ถ้ามี)" />
        </FormField>
        <FormField htmlFor="po-expected" label="วันที่คาดว่าจะได้รับ">
          <Input id="po-expected" type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
        </FormField>
        <FormField htmlFor="po-remarks" label="หมายเหตุ">
          <Input id="po-remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="หมายเหตุ (ถ้ามี)" />
        </FormField>
      </div>
      <div className="space-y-2">
        <Label>รายการสินค้า</Label>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1.5fr_2fr_1fr_1fr_1fr_auto_auto] items-center gap-2">
            <Input placeholder="Item ID" value={l.item_id} aria-invalid={showErrors && !!lineErr(l)} onChange={(e) => setLine(i, { item_id: e.target.value })} />
            <Input placeholder="รายละเอียด" value={l.item_description} onChange={(e) => setLine(i, { item_description: e.target.value })} />
            <Input type="number" min="0" placeholder="จำนวน" value={l.order_qty} aria-invalid={showErrors && !!lineErr(l)} onChange={(e) => setLine(i, { order_qty: +e.target.value })} />
            <Input type="number" min="0" step="0.01" placeholder="ราคา/หน่วย" value={l.unit_price} aria-invalid={showErrors && !!lineErr(l)} onChange={(e) => setLine(i, { unit_price: +e.target.value })} />
            <Input placeholder="หน่วย" value={l.uom} onChange={(e) => setLine(i, { uom: e.target.value })} />
            <label className="flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground" title="รายการทุน (สินทรัพย์ถาวร) — เมื่อรับของจะนำไปตั้งทะเบียนทรัพย์สิน">
              <input type="checkbox" checked={l.is_capital} onChange={(e) => setLine(i, { is_capital: e.target.checked })} /> ทุน
            </label>
            <Button variant="destructive" size="icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
              <X className="size-4" />
            </Button>
            <LineError show={showErrors} msg={lineErr(l)} />
          </div>
        ))}
        {showErrors && formErr && <p className="text-xs text-destructive" role="alert">{formErr}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => setLines((ls) => [...ls, emptyPoLine()])}>
          <Plus className="size-4" /> รายการ
        </Button>
        <Button disabled={mut.isPending} onClick={submit}>
          {mut.isPending ? 'กำลังบันทึก…' : 'สร้าง PO'}
        </Button>
      </div>
    </div>
  );
}

// ── GR ──
interface GrLine { item_id: string; received_qty: number; lot_no: string; expiry_date: string; unit_cost: number | ''; uom: string }
const emptyGrLine = (): GrLine => ({ item_id: '', received_qty: 1, lot_no: '', expiry_date: '', unit_cost: '', uom: '' });

export function GrForm({ onDone }: { onDone?: () => void }) {
  const [poNo, setPoNo] = useState('');
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<GrLine[]>([emptyGrLine()]);
  const [showErrors, setShowErrors] = useState(false);
  const setLine = (i: number, p: Partial<GrLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const poErr = !poNo.trim() ? 'ระบุเลขที่ใบสั่งซื้อ (PO No.)' : null;
  const lineErr = (l: GrLine) => {
    if (!l.item_id.trim()) return null;
    if (!posNum(l.received_qty)) return 'จำนวนรับต้องมากกว่า 0';
    if (l.unit_cost !== '' && !nonNeg(l.unit_cost)) return 'ต้นทุนต้องไม่ติดลบ';
    return null;
  };
  const submittable = lines.filter((l) => l.item_id.trim() && posNum(l.received_qty));
  const formErr = submittable.length === 0 ? 'ต้องมีอย่างน้อย 1 รายการที่มี Item ID และจำนวนรับมากกว่า 0' : null;
  const invalid = !!poErr || !!formErr || lines.some((l) => lineErr(l));

  const mut = useMutation({
    mutationFn: () => api<{ gr_no: string; po_no: string; po_status: string; lines: number }>('/api/procurement/grs', {
      method: 'POST',
      body: JSON.stringify({
        po_no: poNo,
        remarks: remarks || undefined,
        items: submittable.map((l) => ({
          item_id: l.item_id,
          received_qty: Number(l.received_qty),
          lot_no: l.lot_no || undefined,
          expiry_date: l.expiry_date || undefined,
          unit_cost: l.unit_cost === '' ? undefined : Number(l.unit_cost),
          uom: l.uom || undefined,
        })),
      }),
    }),
    onSuccess: (d) => { notifySuccess(`รับสินค้า ${d.gr_no}`, `PO ${d.po_no} → ${d.po_status} · ${d.lines} รายการ`); onDone?.(); },
    onError: (e: any) => notifyError(e?.message ?? 'รับสินค้าไม่สำเร็จ'),
  });

  const submit = () => { setShowErrors(true); if (invalid) { notifyError('กรุณาแก้ไขข้อมูลที่ไม่ถูกต้องก่อนบันทึก'); return; } mut.mutate(); };

  return (
    <div className="space-y-4">
      <FormField htmlFor="gr-po" label="เลขที่ใบสั่งซื้อ (PO No.)" required error={showErrors ? poErr : undefined} className="sm:max-w-sm">
        <Input id="gr-po" value={poNo} aria-invalid={showErrors && !!poErr} onChange={(e) => setPoNo(e.target.value)} placeholder="PO-…" />
      </FormField>
      <FormField htmlFor="gr-remarks" label="หมายเหตุ">
        <Input id="gr-remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="หมายเหตุ (ถ้ามี)" />
      </FormField>
      <div className="space-y-2">
        <Label>รายการรับเข้า</Label>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1.5fr_1fr_1.3fr_1.3fr_1fr_1fr_auto] gap-2">
            <Input placeholder="Item ID" value={l.item_id} aria-invalid={showErrors && !!lineErr(l)} onChange={(e) => setLine(i, { item_id: e.target.value })} />
            <Input type="number" min="0" placeholder="รับ" value={l.received_qty} aria-invalid={showErrors && !!lineErr(l)} onChange={(e) => setLine(i, { received_qty: +e.target.value })} />
            <Input placeholder="Lot" value={l.lot_no} onChange={(e) => setLine(i, { lot_no: e.target.value })} />
            <Input type="date" value={l.expiry_date} onChange={(e) => setLine(i, { expiry_date: e.target.value })} />
            <Input type="number" min="0" step="0.01" placeholder="ต้นทุน" value={l.unit_cost} aria-invalid={showErrors && !!lineErr(l)} onChange={(e) => setLine(i, { unit_cost: e.target.value === '' ? '' : +e.target.value })} />
            <Input placeholder="หน่วย" value={l.uom} onChange={(e) => setLine(i, { uom: e.target.value })} />
            <Button variant="destructive" size="icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
              <X className="size-4" />
            </Button>
            <LineError show={showErrors} msg={lineErr(l)} />
          </div>
        ))}
        {showErrors && formErr && <p className="text-xs text-destructive" role="alert">{formErr}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => setLines((ls) => [...ls, emptyGrLine()])}>
          <Plus className="size-4" /> รายการ
        </Button>
        <Button disabled={mut.isPending} onClick={submit}>
          {mut.isPending ? 'กำลังบันทึก…' : 'รับสินค้า (GR)'}
        </Button>
      </div>
    </div>
  );
}
