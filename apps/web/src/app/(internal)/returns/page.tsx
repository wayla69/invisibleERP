'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Banknote, PackageCheck, Plus, Receipt, RotateCcw, SearchX, Undo2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useMe, hasPerm } from '@/lib/auth';
import { num, thaiDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ModulePage } from '@/components/module-page';
import { SearchInput } from '@/components/search-input';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Returns register (REV-07): tenant-wide view of POS returns/refunds for ops · finance · audit —
// refund method, amount, restocked status, GL journal + credit-note links, with a per-return drill-down.

const selectCls =
  'h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

interface Ret {
  return_no: string; sale_no: string; refund_no: string | null; refund_method: string | null;
  subtotal_returned: number; vat_returned: number; total_returned: number; restocked: boolean;
  journal_no: string | null; credit_note_no: string | null; status: string; return_date: string | null;
}
interface RegResp { returns: Ret[]; count: number; total_count: number; total_refunded: number; restocked_count: number }
interface RetDetail extends Ret { items: { item_id: string; name: string; qty: number; amount: number; restocked: boolean }[] }

interface SaleItem { id: number; itemId: string; itemDescription: string | null; qty: string; unitPrice: string; amount: string; uom: string | null }
interface SaleDetail { order: { saleNo: string; total: string; saleDate: string | null }; items: SaleItem[] }

export default function ReturnsPage() {
  const qc = useQueryClient();
  const me = useMe();
  const canRefund = hasPerm(me.data, 'pos_refund', 'pos', 'ar'); // SoD R12: authorize refunds = pos_refund duty
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [method, setMethod] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => { const t = setTimeout(() => setDebounced(search), 300); return () => clearTimeout(t); }, [search]);

  const q = useQuery<RegResp>({
    queryKey: ['returns-register', debounced, method],
    queryFn: () => api(`/api/pos/returns?limit=200${debounced ? `&search=${encodeURIComponent(debounced)}` : ''}${method ? `&method=${encodeURIComponent(method)}` : ''}`),
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  const filtering = debounced.length > 0 || !!method;

  return (
    <ModulePage
      title="คืนสินค้า & คืนเงิน (Returns Register)"
      description="ทะเบียนการคืนสินค้า/คืนเงินทั้งหมด — วิธีคืนเงิน, ยอดคืน, การคืนเข้าสต๊อก, ลิงก์บัญชี (REV-07)"
      query={q}
      actions={
        // SoD R12: creating/authorizing a return requires pos_refund (POS Supervisor) — a Cashier
        // (pos_sell only) can view the register but cannot issue refunds from this page.
        canRefund ? (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 size-4" />บันทึกคืนสินค้า
          </Button>
        ) : undefined
      }
      toolbar={
        <>
          <SearchInput value={search} onChange={setSearch} placeholder="ค้นหา เลขที่คืน / เลขที่ขาย…" ariaLabel="ค้นหารายการคืน" count={d ? `${num(d.count)} รายการ` : undefined} />
          <select className={selectCls} value={method} onChange={(e) => setMethod(e.target.value)} aria-label="กรองตามวิธีคืนเงิน">
            <option value="">ทุกวิธีคืนเงิน</option>
            <option value="Cash">เงินสด (Cash)</option>
            <option value="Transfer">โอน (Transfer)</option>
            <option value="Card">บัตร (Card)</option>
            <option value="StoreCredit">เครดิตร้าน (Store credit)</option>
          </select>
          {q.isFetching && !q.isLoading && <span className="text-xs text-muted-foreground">กำลังอัปเดต…</span>}
        </>
      }
      stats={
        d && (
          <>
            <StatCard label="จำนวนรายการคืน" value={num(d.total_count)} icon={Undo2} tone="primary" />
            <StatCard label="ยอดคืนเงินรวม" value={`฿${num(d.total_refunded)}`} icon={Banknote} hint="รวมภาษี" />
            <StatCard label="คืนเข้าสต๊อก" value={`${num(d.restocked_count)} / ${num(d.total_count)}`} icon={PackageCheck} tone={d.restocked_count > 0 ? 'success' : 'default'} hint="รายการที่คืนของเข้าคลัง" />
          </>
        )
      }
      statsClassName="xl:grid-cols-3"
    >
      {d && (
        <>
          <DataTable
            rows={d.returns}
            rowKey={(r) => r.return_no}
            emptyState={
              filtering
                ? { icon: SearchX, title: 'ไม่พบรายการคืนที่ตรงกับตัวกรอง', description: 'ลองปรับคำค้นหา หรือล้างตัวกรอง', action: <Button variant="outline" size="sm" onClick={() => { setSearch(''); setMethod(''); }}>ล้างตัวกรอง</Button> }
                : { icon: RotateCcw, title: 'ยังไม่มีรายการคืนสินค้า', description: 'การคืน/คืนเงินจะถูกบันทึกจากหน้า POS แล้วแสดงที่นี่ หรือคลิก "บันทึกคืนสินค้า"' }
            }
            columns={[
              { key: 'return_no', label: 'เลขที่คืน', render: (r) => <button onClick={() => setSelected(r.return_no)} className={cn('font-medium text-primary hover:underline', selected === r.return_no && 'underline')}>{r.return_no}</button> },
              { key: 'return_date', label: 'วันที่', render: (r) => (r.return_date ? thaiDate(r.return_date) : '—') },
              { key: 'sale_no', label: 'เลขที่ขาย' },
              { key: 'refund_method', label: 'วิธีคืนเงิน', render: (r) => <Badge variant="outline">{r.refund_method ?? '—'}</Badge> },
              { key: 'total_returned', label: 'ยอดคืน', align: 'right', render: (r) => <span className="tabular font-medium">฿{num(r.total_returned)}</span> },
              { key: 'restocked', label: 'คืนสต๊อก', render: (r) => (r.restocked ? <Badge variant="secondary">คืนแล้ว</Badge> : <span className="text-muted-foreground">—</span>) },
              { key: 'journal_no', label: 'บัญชี (JE)', render: (r) => r.journal_no ?? '—' },
            ]}
          />
          {selected && <ReturnDetail returnNo={selected} onClose={() => setSelected(null)} />}
        </>
      )}

      {createOpen && (
        <CreateReturnDialog
          onClose={() => setCreateOpen(false)}
          onDone={() => { setCreateOpen(false); qc.invalidateQueries({ queryKey: ['returns-register'] }); }}
        />
      )}
    </ModulePage>
  );
}

// ── Return detail panel ──
function ReturnDetail({ returnNo, onClose }: { returnNo: string; onClose: () => void }) {
  const q = useQuery<RetDetail>({ queryKey: ['return-detail', returnNo], queryFn: () => api(`/api/pos/returns/${encodeURIComponent(returnNo)}`) });
  const r = q.data;
  return (
    <Card className="mt-5 gap-3 p-5">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-semibold"><Receipt className="size-4" /> รายละเอียดการคืน {returnNo}</h3>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="ปิด"><X className="size-4" /></Button>
      </div>
      <StateView q={q}>
        {r && (
          <div className="space-y-4">
            <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <Info label="เลขที่ขายเดิม" value={r.sale_no} />
              <Info label="ใบคืนเงิน" value={r.refund_no ?? '—'} />
              <Info label="วิธีคืนเงิน" value={r.refund_method ?? '—'} />
              <Info label="วันที่" value={r.return_date ? thaiDate(r.return_date) : '—'} />
              <Info label="มูลค่าก่อนภาษี" value={`฿${num(r.subtotal_returned)}`} />
              <Info label="ภาษี (VAT)" value={`฿${num(r.vat_returned)}`} />
              <Info label="ยอดคืนรวม" value={`฿${num(r.total_returned)}`} />
              <Info label="ใบลดหนี้ / JE" value={`${r.credit_note_no ?? '—'} · ${r.journal_no ?? '—'}`} />
            </div>
            <DataTable
              rows={r.items}
              rowKey={(it) => it.item_id}
              columns={[
                { key: 'item_id', label: 'รหัส' },
                { key: 'name', label: 'สินค้า' },
                { key: 'qty', label: 'จำนวนคืน', align: 'right', render: (it) => <span className="tabular">{num(it.qty)}</span> },
                { key: 'amount', label: 'มูลค่า', align: 'right', render: (it) => <span className="tabular">฿{num(it.amount)}</span> },
                { key: 'restocked', label: 'คืนสต๊อก', render: (it) => (it.restocked ? <Badge variant="secondary">คืนแล้ว</Badge> : <span className="text-muted-foreground">—</span>) },
              ]}
            />
          </div>
        )}
      </StateView>
    </Card>
  );
}

// ── Create return dialog ──
const REFUND_METHODS = [
  { value: 'Cash', label: 'เงินสด (Cash)' },
  { value: 'Card', label: 'บัตรเครดิต (Card)' },
  { value: 'PromptPay', label: 'พร้อมเพย์ (PromptPay)' },
  { value: 'QR', label: 'QR Code' },
  { value: 'StoreCredit', label: 'เครดิตร้าน (Store Credit)' },
  { value: 'None', label: 'ไม่คืนเงิน (None)' },
] as const;

type ReturnItem = { sale_item_id: number; item_id: string; name: string; sold_qty: number; return_qty: number; unit_price: number };

function CreateReturnDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [saleNo, setSaleNo] = useState('');
  const [searched, setSearched] = useState('');
  const [items, setItems] = useState<ReturnItem[]>([]);
  const [refundMethod, setRefundMethod] = useState<string>('Cash');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<{ return_no: string; total_returned: number; refund_method: string } | null>(null);
  const [err, setErr] = useState('');

  const saleQ = useQuery<SaleDetail>({
    queryKey: ['sale-detail-return', searched],
    queryFn: () => api(`/api/pos/orders/${encodeURIComponent(searched)}`),
    enabled: searched.length > 0,
  });

  // When sale loads, init return items with qty = 0
  useEffect(() => {
    if (saleQ.data) {
      setItems(saleQ.data.items.map((it) => ({
        sale_item_id: it.id,
        item_id: it.itemId,
        name: it.itemDescription ?? it.itemId,
        sold_qty: Number(it.qty),
        return_qty: 0,
        unit_price: Number(it.unitPrice),
      })));
      setErr('');
    }
  }, [saleQ.data]);

  const mut = useMutation({
    mutationFn: (body: object) => api('/api/pos/returns', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (res: any) => setResult({ return_no: res.return_no, total_returned: res.total_returned, refund_method: res.refund_method }),
    onError: (e: any) => setErr(e?.message ?? 'เกิดข้อผิดพลาด'),
  });

  const doSearch = () => {
    const v = saleNo.trim();
    if (!v) return;
    setItems([]);
    setResult(null);
    setErr('');
    setSearched(v);
  };

  const setReturnQty = (idx: number, val: number) => setItems((prev) => prev.map((it, i) => i === idx ? { ...it, return_qty: Math.max(0, Math.min(it.sold_qty, val)) } : it));

  const handleSubmit = () => {
    const lines = items.filter((it) => it.return_qty > 0);
    if (!lines.length) { setErr('กรุณาระบุจำนวนสินค้าที่ต้องการคืน'); return; }
    mut.mutate({
      sale_no: searched,
      items: lines.map((it) => ({ sale_item_id: it.sale_item_id, qty: it.return_qty })),
      reason: reason || undefined,
      refund_method: refundMethod,
    });
  };

  const totalReturn = items.reduce((a, it) => a + it.return_qty * it.unit_price, 0);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>บันทึกคืนสินค้า</DialogTitle></DialogHeader>

        {result ? (
          <div className="space-y-3 py-2">
            <p className="font-medium text-success">คืนสินค้าสำเร็จ</p>
            <div className="rounded-lg border p-4 text-sm space-y-1">
              <div className="flex justify-between"><span className="text-muted-foreground">เลขที่คืน</span><span className="font-medium">{result.return_no}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">ยอดคืน</span><span className="font-medium">฿{num(result.total_returned)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">วิธีคืนเงิน</span><span>{result.refund_method}</span></div>
            </div>
            <DialogFooter>
              <Button onClick={onDone}>ปิด</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {/* Step 1: search sale */}
            <div className="space-y-1.5">
              <Label>เลขที่ขาย (Sale No.) *</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="SALE-0001-xxxxxx"
                  value={saleNo}
                  onChange={(e) => setSaleNo(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }}
                />
                <Button variant="outline" onClick={doSearch} disabled={saleQ.isFetching}>
                  {saleQ.isFetching ? 'ค้นหา…' : 'ค้นหา'}
                </Button>
              </div>
              {saleQ.isError && <p className="text-xs text-destructive">ไม่พบรายการขาย</p>}
            </div>

            {/* Step 2: pick items */}
            {items.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">เลือกสินค้าที่ต้องการคืน</p>
                <div className="divide-y rounded-lg border">
                  {items.map((it, idx) => (
                    <div key={it.sale_item_id} className="flex items-center gap-3 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{it.name}</p>
                        <p className="text-xs text-muted-foreground">฿{num(it.unit_price)} × {num(it.sold_qty)} ชิ้น</p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button type="button" className="flex size-7 items-center justify-center rounded border hover:bg-accent" onClick={() => setReturnQty(idx, it.return_qty - 1)}>−</button>
                        <input
                          type="number"
                          min={0}
                          max={it.sold_qty}
                          value={it.return_qty}
                          onChange={(e) => setReturnQty(idx, Number(e.target.value))}
                          className="w-14 rounded border px-2 py-1 text-center text-sm"
                        />
                        <button type="button" className="flex size-7 items-center justify-center rounded border hover:bg-accent" onClick={() => setReturnQty(idx, it.return_qty + 1)}>+</button>
                      </div>
                    </div>
                  ))}
                </div>
                {totalReturn > 0 && <p className="text-right text-sm font-medium">ยอดโดยประมาณ ฿{num(totalReturn)}</p>}
              </div>
            )}

            {/* Step 3: refund method + reason */}
            {items.length > 0 && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>วิธีคืนเงิน</Label>
                  <select className={selectCls + ' w-full'} value={refundMethod} onChange={(e) => setRefundMethod(e.target.value)}>
                    {REFUND_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label>เหตุผล (ไม่บังคับ)</Label>
                  <Input placeholder="สินค้าชำรุด, ลูกค้าเปลี่ยนใจ…" value={reason} onChange={(e) => setReason(e.target.value)} />
                </div>
              </div>
            )}

            {err && <p className="text-sm text-destructive">{err}</p>}

            <DialogFooter>
              <Button variant="outline" onClick={onClose}>ยกเลิก</Button>
              <Button onClick={handleSubmit} disabled={mut.isPending || items.length === 0}>
                {mut.isPending ? 'กำลังบันทึก…' : 'บันทึกคืนสินค้า'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><p className="text-xs text-muted-foreground">{label}</p><p className="font-medium tabular">{value}</p></div>;
}
