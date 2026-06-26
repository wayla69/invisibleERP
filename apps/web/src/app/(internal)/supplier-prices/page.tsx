'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Tag, History, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { ModulePage } from '@/components/module-page';
import { DataTable } from '@/components/data-table';
import { StatCard } from '@/components/stat-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';

interface SupplierPrice {
  id: number; vendor_id: number; vendor_name: string | null;
  item_id: string; item_description: string | null;
  uom: string; currency: string; unit_price: number; min_qty: number;
  effective_from: string; effective_to: string | null; notes: string | null;
}
interface PriceHistory {
  id: number; uom: string; currency: string; unit_price: number; min_qty: number;
  effective_from: string; effective_to: string | null; status: string; notes: string | null;
  created_by: string | null; created_at: string | null;
}
interface ListResp { prices: SupplierPrice[]; count: number }
interface HistoryResp { vendor_id: number; item_id: string; history: PriceHistory[] }

const today = new Date().toISOString().slice(0, 10);
const EMPTY = { vendor_id: '', item_id: '', item_description: '', uom: 'EA', currency: 'THB', unit_price: '', min_qty: '1', effective_from: today, notes: '' };

export default function SupplierPricesPage() {
  const qc = useQueryClient();
  const [vendorFilter, setVendorFilter] = useState('');
  const [itemFilter, setItemFilter] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [historyRow, setHistoryRow] = useState<SupplierPrice | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [err, setErr] = useState('');

  const params = new URLSearchParams();
  if (vendorFilter) params.set('vendor_id', vendorFilter);
  if (itemFilter) params.set('item_id', itemFilter);
  const qs = params.toString();

  const q = useQuery<ListResp>({
    queryKey: ['supplier-prices', vendorFilter, itemFilter],
    queryFn: () => api(`/api/procurement/supplier-prices${qs ? `?${qs}` : ''}`),
  });

  const hq = useQuery<HistoryResp>({
    queryKey: ['supplier-price-history', historyRow?.vendor_id, historyRow?.item_id],
    queryFn: () => api(`/api/procurement/supplier-prices/history?vendor_id=${historyRow!.vendor_id}&item_id=${encodeURIComponent(historyRow!.item_id)}`),
    enabled: historyRow != null,
  });

  const mut = useMutation({
    mutationFn: (body: object) => api('/api/procurement/supplier-prices', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['supplier-prices'] }); setCreateOpen(false); setForm(EMPTY); setErr(''); },
    onError: (e: any) => setErr(e?.message ?? 'เกิดข้อผิดพลาด'),
  });

  const handleSubmit = () => {
    if (!form.vendor_id || !form.item_id || !form.unit_price || !form.effective_from) { setErr('กรุณากรอกข้อมูลที่จำเป็น'); return; }
    mut.mutate({ vendor_id: Number(form.vendor_id), item_id: form.item_id, item_description: form.item_description || undefined, uom: form.uom || 'EA', currency: form.currency || 'THB', unit_price: Number(form.unit_price), min_qty: Number(form.min_qty) || 1, effective_from: form.effective_from, notes: form.notes || undefined });
  };

  const d = q.data;

  return (
    <ModulePage
      title="ราคาซัพพลายเออร์ (Supplier Price Lists)"
      description="รายการราคาซื้อที่ตรวจสอบแล้วต่อผู้ขาย-สินค้า พร้อมประวัติเวอร์ชัน — ใช้ป้อนส่วนต่างราคาใน scorecard"
      query={q}
      actions={
        <Button size="sm" onClick={() => { setForm(EMPTY); setErr(''); setCreateOpen(true); }}>
          <Plus className="mr-1.5 size-4" />บันทึกราคาใหม่
        </Button>
      }
      toolbar={
        <>
          <Input className="w-40" placeholder="Vendor ID" value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)} aria-label="กรองตาม vendor_id" />
          <Input className="w-48" placeholder="รหัสสินค้า (item_id)" value={itemFilter} onChange={(e) => setItemFilter(e.target.value)} aria-label="กรองตาม item_id" />
        </>
      }
      stats={d && (
        <>
          <StatCard label="รายการราคาที่ใช้งาน" value={num(d.count)} icon={Tag} tone="primary" />
        </>
      )}
    >
      {d && (
        <DataTable
          rows={d.prices}
          rowKey={(r) => String(r.id)}
          emptyState={{ icon: Tag, title: 'ยังไม่มีรายการราคา', description: 'เพิ่มราคาซัพพลายเออร์โดยคลิก "บันทึกราคาใหม่"' }}
          columns={[
            { key: 'vendor_name', label: 'ซัพพลายเออร์', render: (r) => <span className="font-medium">{r.vendor_name ?? `#${r.vendor_id}`}</span> },
            { key: 'item_id', label: 'รหัสสินค้า', render: (r) => <span className="font-mono text-xs">{r.item_id}</span> },
            { key: 'item_description', label: 'ชื่อสินค้า', render: (r) => r.item_description ?? '—' },
            { key: 'uom', label: 'หน่วย' },
            { key: 'unit_price', label: 'ราคาต่อหน่วย', align: 'right', render: (r) => <span className="tabular font-medium">{num(r.unit_price)} {r.currency}</span> },
            { key: 'min_qty', label: 'ปริมาณขั้นต่ำ', align: 'right', render: (r) => <span className="tabular">{num(r.min_qty)}</span> },
            { key: 'effective_from', label: 'มีผลตั้งแต่', render: (r) => r.effective_from },
            { key: 'effective_to', label: 'ถึงวันที่', render: (r) => r.effective_to ?? <Badge variant="outline" className="text-xs">ไม่มีกำหนด</Badge> },
            { key: 'history', label: '', render: (r) => (
              <Button size="icon" variant="ghost" title="ประวัติเวอร์ชัน" onClick={() => setHistoryRow(r)}>
                <History className="size-4" />
              </Button>
            )},
          ]}
        />
      )}

      {/* Create / version price dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>บันทึกราคาซัพพลายเออร์</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="sp-vid">Vendor ID *</Label>
              <Input id="sp-vid" type="number" placeholder="1" value={form.vendor_id} onChange={(e) => setForm((f) => ({ ...f, vendor_id: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sp-iid">รหัสสินค้า (item_id) *</Label>
              <Input id="sp-iid" placeholder="ITEM-001" value={form.item_id} onChange={(e) => setForm((f) => ({ ...f, item_id: e.target.value }))} />
            </div>
            <div className="col-span-2 space-y-1">
              <Label htmlFor="sp-idesc">ชื่อสินค้า</Label>
              <Input id="sp-idesc" placeholder="ชื่อสินค้า (ไม่บังคับ)" value={form.item_description} onChange={(e) => setForm((f) => ({ ...f, item_description: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sp-uom">หน่วย</Label>
              <Input id="sp-uom" placeholder="EA" value={form.uom} onChange={(e) => setForm((f) => ({ ...f, uom: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sp-cur">สกุลเงิน</Label>
              <Input id="sp-cur" placeholder="THB" value={form.currency} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sp-price">ราคาต่อหน่วย *</Label>
              <Input id="sp-price" type="number" step="0.0001" placeholder="0.00" value={form.unit_price} onChange={(e) => setForm((f) => ({ ...f, unit_price: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sp-minqty">ปริมาณขั้นต่ำ</Label>
              <Input id="sp-minqty" type="number" step="0.0001" placeholder="1" value={form.min_qty} onChange={(e) => setForm((f) => ({ ...f, min_qty: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sp-from">มีผลตั้งแต่ *</Label>
              <Input id="sp-from" type="date" value={form.effective_from} onChange={(e) => setForm((f) => ({ ...f, effective_from: e.target.value }))} />
            </div>
            <div className="col-span-2 space-y-1">
              <Label htmlFor="sp-notes">หมายเหตุ</Label>
              <Input id="sp-notes" placeholder="หมายเหตุ (ไม่บังคับ)" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>
          {err && <p className="text-sm text-destructive">{err}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>ยกเลิก</Button>
            <Button onClick={handleSubmit} disabled={mut.isPending}>{mut.isPending ? 'กำลังบันทึก…' : 'บันทึก'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Version history sheet */}
      <Sheet open={historyRow != null} onOpenChange={(o) => { if (!o) setHistoryRow(null); }}>
        <SheetContent className="w-[560px] sm:max-w-[560px]">
          <SheetHeader>
            <SheetTitle>ประวัติราคา: {historyRow?.item_description ?? historyRow?.item_id} / {historyRow?.vendor_name ?? `Vendor #${historyRow?.vendor_id}`}</SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            {hq.isLoading && <p className="text-sm text-muted-foreground">กำลังโหลด…</p>}
            {hq.data && (
              <DataTable
                rows={hq.data.history}
                rowKey={(r) => String(r.id)}
                emptyState={{ icon: History, title: 'ไม่มีประวัติ', description: '' }}
                columns={[
                  { key: 'unit_price', label: 'ราคา', align: 'right', render: (r) => <span className="tabular">{num(r.unit_price)} {r.currency}</span> },
                  { key: 'effective_from', label: 'ตั้งแต่', render: (r) => r.effective_from },
                  { key: 'effective_to', label: 'ถึง', render: (r) => r.effective_to ?? '—' },
                  { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={r.status === 'active' ? 'success' : 'secondary'}>{r.status === 'active' ? 'ใช้งาน' : 'เก่า'}</Badge> },
                  { key: 'created_by', label: 'โดย', render: (r) => r.created_by ?? '—' },
                ]}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </ModulePage>
  );
}
