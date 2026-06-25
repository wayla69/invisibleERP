'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Boxes, CheckCircle2, Layers, PackagePlus, Scale, Send, TriangleAlert, Wallet, History as HistoryIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Perpetual inventory valuation sub-ledger (INV-06): valued receipts/issues/adjustments + moving-average or
// FIFO/FEFO cost layers, with a GL reconciliation tie-out (sub-ledger value ↔ account 1200).

const selectCls =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

const METHOD_LABEL: Record<string, string> = { moving_avg: 'ถัวเฉลี่ย', fifo: 'FIFO', fefo: 'FEFO' };

interface ValItem { item_id: string; item_description?: string; location_id: string; on_hand_qty: number; avg_cost: number; total_value: number; costing_method: string }
interface ValResp { items: ValItem[]; count: number; total_value: number }
interface ReconResp { sub_ledger_value: number; gl_inventory: number; difference: number; reconciled: boolean }

export default function InventoryLedgerPage() {
  return (
    <div>
      <PageHeader
        title="บัญชีสต๊อก & มูลค่า (Perpetual Sub-ledger)"
        description="มูลค่าสต๊อกแบบต่อเนื่อง (ถัวเฉลี่ย / FIFO / FEFO) พร้อมกระทบยอดกับบัญชีแยกประเภท (1200)"
      />
      <Tabs
        tabs={[
          { key: 'valuation', label: 'มูลค่า & กระทบยอด', content: <Valuation /> },
          { key: 'receipt', label: 'รับเข้า (Receipt)', content: <ReceiptForm /> },
          { key: 'issue', label: 'เบิก (Issue)', content: <IssueForm /> },
          { key: 'adjust', label: 'ปรับปรุง (Adjust)', content: <AdjustForm /> },
          { key: 'layers', label: 'ชั้นต้นทุน (Layers)', content: <LayersView /> },
          { key: 'moves', label: 'ความเคลื่อนไหว', content: <MovesView /> },
        ]}
      />
    </div>
  );
}

// Shared <datalist> of known tracked items so the issue/adjust forms autocomplete item ids.
function useItemList() {
  const q = useQuery<ValResp>({ queryKey: ['inv-valuation'], queryFn: () => api('/api/inventory/valuation') });
  return q.data?.items ?? [];
}
function ItemDatalist({ id, items }: { id: string; items: ValItem[] }) {
  const seen = new Set<string>();
  return (
    <datalist id={id}>
      {items.filter((i) => !seen.has(i.item_id) && seen.add(i.item_id)).map((i) => (
        <option key={i.item_id} value={i.item_id}>{i.item_description ?? i.item_id}</option>
      ))}
    </datalist>
  );
}

// ───────────────────────── Valuation + reconciliation ─────────────────────────
function Valuation() {
  const val = useQuery<ValResp>({ queryKey: ['inv-valuation'], queryFn: () => api('/api/inventory/valuation'), placeholderData: keepPreviousData });
  const rec = useQuery<ReconResp>({ queryKey: ['inv-reconcile'], queryFn: () => api('/api/inventory/reconciliation') });
  const d = val.data;
  const r = rec.data;

  return (
    <StateView q={val}>
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="มูลค่าสต๊อกรวม" value={`฿${num(d?.total_value ?? 0)}`} icon={Wallet} tone="primary" hint="ตามต้นทุนปัจจุบัน" />
          <StatCard label="รายการ (item/คลัง)" value={num(d?.count ?? 0)} icon={Boxes} />
          <StatCard label="ยอดบัญชีคุม GL 1200" value={r ? `฿${num(r.gl_inventory)}` : '—'} icon={Scale} hint="จากการลงบัญชีของ sub-ledger" />
          <StatCard
            label={r?.reconciled ? 'กระทบยอดตรง' : 'กระทบยอดต่าง'}
            value={r ? `฿${num(r.difference)}` : '—'}
            icon={r?.reconciled ? CheckCircle2 : TriangleAlert}
            tone={r ? (r.reconciled ? 'success' : 'danger') : undefined}
            hint={r?.reconciled ? 'sub-ledger = GL' : 'ต้องตรวจสอบ'}
          />
        </div>

        {d && (
          <DataTable
            rows={d.items}
            rowKey={(r2) => `${r2.item_id}@${r2.location_id}`}
            emptyState={{ icon: Wallet, title: 'ยังไม่มีมูลค่าสต๊อก', description: 'บันทึก "รับเข้า (Receipt)" เพื่อเริ่มต้นบัญชีสต๊อกแบบมีต้นทุน' }}
            columns={[
              { key: 'item_id', label: 'รหัส', render: (r2) => <span className="font-medium">{r2.item_id}</span> },
              { key: 'item_description', label: 'สินค้า' },
              { key: 'location_id', label: 'คลัง' },
              { key: 'on_hand_qty', label: 'คงเหลือ', align: 'right', render: (r2) => <span className="tabular">{num(r2.on_hand_qty)}</span> },
              { key: 'avg_cost', label: 'ต้นทุน/หน่วย', align: 'right', render: (r2) => <span className="tabular">฿{num(r2.avg_cost)}</span> },
              { key: 'total_value', label: 'มูลค่ารวม', align: 'right', render: (r2) => <span className="tabular font-medium">฿{num(r2.total_value)}</span> },
              { key: 'costing_method', label: 'วิธีต้นทุน', render: (r2) => <Badge variant="outline">{METHOD_LABEL[r2.costing_method] ?? r2.costing_method}</Badge> },
            ]}
          />
        )}
      </div>
    </StateView>
  );
}

// ───────────────────────── Receipt (valued goods-in) ─────────────────────────
function ReceiptForm() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ item_id: '', item_description: '', location_id: 'WH-MAIN', qty: '', unit_cost: '', costing_method: 'moving_avg', lot_no: '', expiry_date: '', ref_type: '', ref_id: '' });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const layered = form.costing_method === 'fifo' || form.costing_method === 'fefo';

  const submit = useMutation({
    mutationFn: () => api<any>('/api/inventory/receipts', {
      method: 'POST',
      body: JSON.stringify({
        item_id: form.item_id.trim(),
        item_description: form.item_description.trim() || undefined,
        location_id: form.location_id.trim() || undefined,
        qty: Number(form.qty),
        unit_cost: Number(form.unit_cost),
        costing_method: form.costing_method,
        lot_no: layered && form.lot_no.trim() ? form.lot_no.trim() : undefined,
        expiry_date: layered && form.expiry_date ? form.expiry_date : undefined,
        ref_type: form.ref_type.trim() || undefined,
        ref_id: form.ref_id.trim() || undefined,
      }),
    }),
    onSuccess: (r) => {
      notifySuccess(r.deduped ? `รับเข้าซ้ำ (${r.move_no}) — ไม่บันทึกซ้ำ` : `รับเข้า ${r.move_no} · คงเหลือ ${num(r.balance_qty)} @ ฿${num(r.avg_cost)}`);
      setForm((f) => ({ ...f, qty: '', unit_cost: '', lot_no: '', expiry_date: '', ref_id: '' }));
      invalidateLedger(qc);
    },
    onError: (e: any) => notifyError(e.message),
  });

  const canSubmit = !!form.item_id.trim() && Number(form.qty) > 0 && Number(form.unit_cost) >= 0;

  return (
    <Card className="max-w-2xl gap-3 p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="rc-item" label="รหัสสินค้า" required><Input id="rc-item" value={form.item_id} onChange={set('item_id')} placeholder="เช่น SUGAR" /></Field>
        <Field id="rc-desc" label="ชื่อสินค้า (เลือก)"><Input id="rc-desc" value={form.item_description} onChange={set('item_description')} /></Field>
        <Field id="rc-qty" label="จำนวน" required><Input id="rc-qty" type="number" min="0" step="any" value={form.qty} onChange={set('qty')} /></Field>
        <Field id="rc-cost" label="ต้นทุน/หน่วย (฿)" required><Input id="rc-cost" type="number" min="0" step="any" value={form.unit_cost} onChange={set('unit_cost')} /></Field>
        <Field id="rc-loc" label="คลัง"><Input id="rc-loc" value={form.location_id} onChange={set('location_id')} /></Field>
        <Field id="rc-method" label="วิธีคิดต้นทุน" hint="ตั้งครั้งแรกที่รับเข้า แล้วล็อกไว้">
          <select id="rc-method" className={selectCls} value={form.costing_method} onChange={set('costing_method')}>
            <option value="moving_avg">ถัวเฉลี่ยเคลื่อนที่ (Moving avg)</option>
            <option value="fifo">FIFO (เข้าก่อน-ออกก่อน)</option>
            <option value="fefo">FEFO (หมดอายุก่อน-ออกก่อน)</option>
          </select>
        </Field>
        {layered && <Field id="rc-lot" label="Lot (เลือก)"><Input id="rc-lot" value={form.lot_no} onChange={set('lot_no')} placeholder="เช่น L1" /></Field>}
        {layered && <Field id="rc-exp" label="วันหมดอายุ (เลือก)" hint="FEFO เบิกล็อตใกล้หมดก่อน"><Input id="rc-exp" type="date" value={form.expiry_date} onChange={set('expiry_date')} /></Field>}
        <Field id="rc-rt" label="อ้างอิง: ประเภท (เลือก)" hint="กันบันทึกซ้ำ เช่น GRN"><Input id="rc-rt" value={form.ref_type} onChange={set('ref_type')} placeholder="GRN" /></Field>
        <Field id="rc-ri" label="อ้างอิง: เลขที่ (เลือก)"><Input id="rc-ri" value={form.ref_id} onChange={set('ref_id')} placeholder="GRN-001" /></Field>
      </div>
      <p className="text-xs text-muted-foreground">ลงบัญชี: เดบิต 1200 สินค้าคงคลัง / เครดิต 2000 เจ้าหนี้</p>
      <Button className="w-fit" disabled={!canSubmit || submit.isPending} onClick={() => submit.mutate()}>
        <PackagePlus className="size-4" /> {submit.isPending ? 'กำลังบันทึก…' : 'รับเข้า'}
      </Button>
    </Card>
  );
}

// ───────────────────────── Issue (valued goods-out → COGS) ─────────────────────────
function IssueForm() {
  const qc = useQueryClient();
  const items = useItemList();
  const [form, setForm] = useState({ item_id: '', location_id: 'WH-MAIN', qty: '', ref_type: '', ref_id: '' });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = useMutation({
    mutationFn: () => api<any>('/api/inventory/issues', {
      method: 'POST',
      body: JSON.stringify({ item_id: form.item_id.trim(), location_id: form.location_id.trim() || undefined, qty: Number(form.qty), ref_type: form.ref_type.trim() || undefined, ref_id: form.ref_id.trim() || undefined }),
    }),
    onSuccess: (r) => {
      notifySuccess(`เบิก ${r.move_no} · ตัดต้นทุน(COGS) ฿${num(r.value)} · คงเหลือ ${num(r.balance_qty)}`);
      setForm((f) => ({ ...f, qty: '', ref_id: '' }));
      invalidateLedger(qc);
    },
    onError: (e: any) => notifyError(e.message),
  });
  const canSubmit = !!form.item_id.trim() && Number(form.qty) > 0;

  return (
    <Card className="max-w-2xl gap-3 p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="is-item" label="รหัสสินค้า" required><Input id="is-item" list="inv-items" value={form.item_id} onChange={set('item_id')} placeholder="เลือก / พิมพ์รหัส" /></Field>
        <Field id="is-qty" label="จำนวนเบิก" required><Input id="is-qty" type="number" min="0" step="any" value={form.qty} onChange={set('qty')} /></Field>
        <Field id="is-loc" label="คลัง"><Input id="is-loc" value={form.location_id} onChange={set('location_id')} /></Field>
        <Field id="is-rt" label="อ้างอิง (เลือก)"><Input id="is-rt" value={form.ref_id} onChange={set('ref_id')} placeholder="WO / MI" /></Field>
      </div>
      <ItemDatalist id="inv-items" items={items} />
      <p className="text-xs text-muted-foreground">ตัดต้นทุนตามวิธีของสินค้า (ถัวเฉลี่ย / FEFO) · ลงบัญชี: เดบิต 5000 ต้นทุนขาย / เครดิต 1200 · เบิกเกินคงเหลือถูกปฏิเสธ (NEG_STOCK)</p>
      <Button className="w-fit" disabled={!canSubmit || submit.isPending} onClick={() => submit.mutate()}>
        <Send className="size-4" /> {submit.isPending ? 'กำลังบันทึก…' : 'เบิก'}
      </Button>
    </Card>
  );
}

// ───────────────────────── Adjustment (count variance / shrinkage) ─────────────────────────
function AdjustForm() {
  const qc = useQueryClient();
  const items = useItemList();
  const [form, setForm] = useState({ item_id: '', location_id: 'WH-MAIN', qty_delta: '', reason: '' });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = useMutation({
    mutationFn: () => api<any>('/api/inventory/adjustments', {
      method: 'POST',
      body: JSON.stringify({ item_id: form.item_id.trim(), location_id: form.location_id.trim() || undefined, qty_delta: Number(form.qty_delta), reason: form.reason.trim() }),
    }),
    onSuccess: (r) => {
      notifySuccess(`ปรับปรุง ${r.move_no} · มูลค่า ฿${num(r.value)} · คงเหลือ ${num(r.balance_qty)}`);
      setForm((f) => ({ ...f, qty_delta: '', reason: '' }));
      invalidateLedger(qc);
    },
    onError: (e: any) => notifyError(e.message),
  });
  const canSubmit = !!form.item_id.trim() && Number(form.qty_delta) !== 0 && !!form.reason.trim();

  return (
    <Card className="max-w-2xl gap-3 p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="aj-item" label="รหัสสินค้า" required><Input id="aj-item" list="inv-items-aj" value={form.item_id} onChange={set('item_id')} placeholder="เลือก / พิมพ์รหัส" /></Field>
        <Field id="aj-delta" label="ส่วนต่าง (+/−)" required hint="ติดลบ = ของขาด/เสีย"><Input id="aj-delta" type="number" step="any" value={form.qty_delta} onChange={set('qty_delta')} placeholder="-10" /></Field>
        <Field id="aj-loc" label="คลัง"><Input id="aj-loc" value={form.location_id} onChange={set('location_id')} /></Field>
        <Field id="aj-reason" label="เหตุผล" required hint="จำเป็นต่อการควบคุม (ตรวจสอบได้)"><Input id="aj-reason" value={form.reason} onChange={set('reason')} placeholder="เช่น ของเสีย / นับใหม่" /></Field>
      </div>
      <ItemDatalist id="inv-items-aj" items={items} />
      <p className="text-xs text-muted-foreground">ของขาด: เดบิต 5810 / เครดิต 1200 · ต้องระบุเหตุผล (REASON_REQUIRED) · สิทธิ์ wh_adjust แยกจากการนับ (R11)</p>
      <Button className="w-fit" disabled={!canSubmit || submit.isPending} onClick={() => submit.mutate()}>
        <Scale className="size-4" /> {submit.isPending ? 'กำลังบันทึก…' : 'ปรับปรุงสต๊อก'}
      </Button>
    </Card>
  );
}

// ───────────────────────── Cost layers (FIFO/FEFO) ─────────────────────────
function LayersView() {
  const q = useQuery<any>({ queryKey: ['inv-layers'], queryFn: () => api('/api/inventory/layers') });
  return (
    <StateView q={q}>
      {q.data && (
        <DataTable
          rows={q.data.layers}
          rowKey={(r: any, i: number) => `${r.item_id}-${i}`}
          emptyState={{ icon: Layers, title: 'ไม่มีชั้นต้นทุน', description: 'ชั้นต้นทุนจะเกิดเมื่อรับเข้าสินค้าที่ใช้วิธี FIFO หรือ FEFO' }}
          columns={[
            { key: 'item_id', label: 'รหัส', render: (r: any) => <span className="font-medium">{r.item_id}</span> },
            { key: 'location_id', label: 'คลัง' },
            { key: 'lot_no', label: 'Lot', render: (r: any) => r.lot_no ?? '—' },
            { key: 'expiry_date', label: 'หมดอายุ', render: (r: any) => (r.expiry_date ? thaiDate(r.expiry_date) : '—') },
            { key: 'remaining_qty', label: 'คงเหลือ', align: 'right', render: (r: any) => <span className="tabular">{num(r.remaining_qty)}</span> },
            { key: 'unit_cost', label: 'ต้นทุน/หน่วย', align: 'right', render: (r: any) => <span className="tabular">฿{num(r.unit_cost)}</span> },
            { key: 'layer_value', label: 'มูลค่าชั้น', align: 'right', render: (r: any) => <span className="tabular font-medium">฿{num(r.layer_value)}</span> },
          ]}
        />
      )}
    </StateView>
  );
}

// ───────────────────────── Valued move ledger (audit trail) ─────────────────────────
const MOVE_LABEL: Record<string, string> = { receipt: 'รับเข้า', issue: 'เบิก', adjust: 'ปรับปรุง', transfer: 'โอน' };
function MovesView() {
  const q = useQuery<any>({ queryKey: ['inv-moves'], queryFn: () => api('/api/inventory/moves?limit=200') });
  return (
    <StateView q={q}>
      {q.data && (
        <DataTable
          rows={q.data.moves}
          rowKey={(r: any, i: number) => `${r.move_no}-${i}`}
          emptyState={{ icon: HistoryIcon, title: 'ยังไม่มีความเคลื่อนไหว', description: 'บันทึกการรับเข้า / เบิก / ปรับปรุง แล้วประวัติจะแสดงที่นี่' }}
          columns={[
            { key: 'move_no', label: 'เลขที่' },
            { key: 'move_date', label: 'วันที่', render: (r: any) => thaiDate(r.move_date) },
            { key: 'move_type', label: 'ประเภท', render: (r: any) => <Badge variant="outline">{MOVE_LABEL[r.move_type] ?? r.move_type}</Badge> },
            { key: 'item_id', label: 'สินค้า' },
            { key: 'qty', label: 'จำนวน', align: 'right', render: (r: any) => <span className={cn('tabular', Number(r.qty) < 0 && 'text-destructive')}>{num(r.qty)}</span> },
            { key: 'total_cost', label: 'มูลค่า', align: 'right', render: (r: any) => <span className="tabular">฿{num(r.total_cost)}</span> },
            { key: 'gl_entry_no', label: 'JE', render: (r: any) => r.gl_entry_no ?? '—' },
          ]}
        />
      )}
    </StateView>
  );
}

// ── helpers ──
function Field({ id, label, required, hint, children }: { id: string; label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>
        {label}
        {required && <span className="ml-0.5 text-destructive" aria-hidden>*</span>}
      </Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function invalidateLedger(qc: ReturnType<typeof useQueryClient>) {
  for (const k of ['inv-valuation', 'inv-reconcile', 'inv-layers', 'inv-moves']) qc.invalidateQueries({ queryKey: [k] });
}
