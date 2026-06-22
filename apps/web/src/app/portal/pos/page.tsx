'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Wallet, Wifi, WifiOff, RefreshCw, Banknote, QrCode, CreditCard, ScanLine } from 'lucide-react';
import { api } from '@/lib/api';
import { useOnline, useOutbox, enqueueSale } from '@/lib/offline';
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

function OfflineBar() {
  const online = useOnline();
  const { count, flush } = useOutbox();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const doFlush = async () => { setBusy(true); try { const r = await flush(); setMsg(`ซิงค์แล้ว ${r.synced} · ซ้ำ ${r.duplicate} · ค้าง ${r.remaining}`); } catch (e: any) { setMsg(`❌ ${e.message}`); } finally { setBusy(false); } };
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm">
      <span className={`inline-flex items-center gap-1.5 font-medium ${online ? 'text-emerald-600' : 'text-amber-600'}`}>
        {online ? <Wifi className="size-4" /> : <WifiOff className="size-4" />} {online ? 'ออนไลน์' : 'ออฟไลน์ — บันทึกในเครื่อง'}
      </span>
      {count > 0 && <Badge variant={statusVariant('open')}>ค้างซิงค์ {count}</Badge>}
      {count > 0 && online && <Button size="sm" variant="outline" disabled={busy} onClick={doFlush}><RefreshCw className={`size-4 ${busy ? 'animate-spin' : ''}`} /> ซิงค์เลย</Button>}
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
    </div>
  );
}

function NewSale() {
  const qc = useQueryClient();
  const online = useOnline();
  const { refresh } = useOutbox();
  const [lines, setLines] = useState<Line[]>([{ item_id: '', qty: 1, unit_price: 0, discount_pct: 0 }]);
  const [payment, setPayment] = useState('Cash');
  const [queued, setQueued] = useState('');
  const [payErr, setPayErr] = useState('');
  const [applyPricing, setApplyPricing] = useState(false);
  const [cashReceived, setCashReceived] = useState('');
  const scanRef = useRef<HTMLInputElement>(null);
  const setLine = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const reset = () => { setLines([{ item_id: '', qty: 1, unit_price: 0, discount_pct: 0 }]); setCashReceived(''); };

  const subtotal = lines.reduce((a, l) => a + Number(l.qty) * Number(l.unit_price) * (1 - Number(l.discount_pct) / 100), 0);
  const vat = subtotal * VAT;
  const total = subtotal + vat;
  // Only item lines with a positive quantity are sent — a zero-qty row is dropped, not posted as a free line.
  const cleanLines = () => lines.filter((l) => l.item_id && Number(l.qty) > 0).map((l) => ({ item_id: l.item_id, qty: Number(l.qty), unit_price: Number(l.unit_price), discount_pct: Number(l.discount_pct) }));
  const hasItems = lines.some((l) => l.item_id && Number(l.qty) > 0);
  const changeDue = payment === 'Cash' && cashReceived !== '' ? Math.round((Number(cashReceived) - total) * 100) / 100 : null;

  // Barcode / scan-gun workflow: the gun types the SKU then sends Enter. Merge into an existing line
  // (qty +1) or append a new one, clear the field, and keep focus so the next scan flows in — zero mouse.
  const onScan = (code: string) => {
    const sku = code.trim();
    if (!sku) return;
    setLines((ls) => {
      const idx = ls.findIndex((l) => l.item_id === sku);
      if (idx >= 0) return ls.map((l, j) => (j === idx ? { ...l, qty: Number(l.qty) + 1 } : l));
      const seeded = ls.length === 1 && !ls[0].item_id ? [] : ls; // replace the initial blank row
      return [...seeded, { item_id: sku, qty: 1, unit_price: 0, discount_pct: 0 }];
    });
  };

  const mut = useMutation({
    mutationFn: (method: string) => api<{ sale_no: string; total: number; points_earned: number }>('/api/portal/pos/sales', {
      method: 'POST',
      body: JSON.stringify({ payment_method: method, items: cleanLines(), apply_pricing: applyPricing }),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['portal-sales'] }); reset(); scanRef.current?.focus(); },
  });

  // Quick-tender: settle in one tap. Offline → queue to the outbox; online → post immediately.
  const tender = (method: string) => {
    setPayment(method);
    setQueued(''); setPayErr('');
    if (!cleanLines().length) return;
    // Cash short-tender guard: if a cash-received amount is entered it must cover the total.
    if (method === 'Cash' && cashReceived !== '' && Number(cashReceived) < total) {
      setPayErr(`เงินที่รับ (${baht(Number(cashReceived))}) น้อยกว่ายอดสุทธิ (${baht(total)})`);
      return;
    }
    if (online) { mut.mutate(method); return; }
    const s = enqueueSale({ captured_at: new Date().toISOString(), payment_method: method, lines: cleanLines() });
    setQueued(`📥 บันทึกออฟไลน์แล้ว (${s.client_uuid}) — จะซิงค์เมื่อกลับมาออนไลน์`);
    reset(); refresh();
  };

  // Keyboard tender shortcuts (queue-speed, no mouse): F2 cash · F4 card · F8 QR.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const map: Record<string, string> = { F2: 'Cash', F4: 'Card', F8: 'QR Code' };
      const method = map[e.key];
      if (method && hasItems && !mut.isPending) { e.preventDefault(); tender(method); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasItems, mut.isPending, lines, cashReceived, total, payment, online]);

  return (
    <Card className="max-w-3xl gap-4 p-5">
      <CardContent className="space-y-4 px-0">
        <h3 className="text-base font-semibold">ขายสินค้า</h3>
        <OfflineBar />

        {/* Scan field — autofocused; scan/type a SKU + Enter to add a line. */}
        <div className="grid gap-1">
          <Label htmlFor="scan">สแกนบาร์โค้ด / รหัสสินค้า</Label>
          <div className="flex items-center gap-2 rounded-md border border-input px-3 focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]">
            <ScanLine className="size-4 shrink-0 text-muted-foreground" />
            <input
              id="scan"
              ref={scanRef}
              autoFocus
              placeholder="สแกนหรือพิมพ์รหัสแล้วกด Enter"
              className="h-10 w-full bg-transparent text-base outline-none md:text-sm"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onScan(e.currentTarget.value); e.currentTarget.value = ''; } }}
            />
          </div>
        </div>

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
            <Input type="number" min={1} step={1} value={l.qty} onChange={(e) => setLine(i, { qty: +e.target.value })} />
            <Input type="number" min={0} step="0.01" value={l.unit_price} onChange={(e) => setLine(i, { unit_price: +e.target.value })} />
            <Input type="number" min={0} max={100} step="0.01" value={l.discount_pct} onChange={(e) => setLine(i, { discount_pct: +e.target.value })} />
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
          {payment === 'Cash' && (
            <div className="grid gap-2">
              <Label htmlFor="cash">เงินที่รับ</Label>
              <Input id="cash" type="number" min={0} step="0.01" className="w-32 tabular text-right" placeholder="0.00" value={cashReceived} onChange={(e) => setCashReceived(e.target.value)} />
            </div>
          )}
          <label className="flex items-center gap-1.5 self-end pb-2 text-sm" title="ใช้กฎราคา/โปรโมชั่นอัตโนมัติ (happy hour, ส่วนลด)">
            <input type="checkbox" checked={applyPricing} onChange={(e) => setApplyPricing(e.target.checked)} /> ใช้โปรโมชั่น
          </label>
          <div className="flex-1 text-right">
            <div className="text-sm text-muted-foreground">ยอดรวม {baht(subtotal)} + VAT 7% {baht(vat)}{applyPricing ? ' · ปรับตามโปรฯ ตอนชำระ' : ''}</div>
            <div className="text-3xl font-semibold">สุทธิ <strong className="tabular">{baht(total)}</strong></div>
            {changeDue != null && changeDue >= 0 && <div className="text-lg text-success">เงินทอน <strong className="tabular">{baht(changeDue)}</strong></div>}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <Button size="lg" disabled={mut.isPending || !hasItems} onClick={() => tender('Cash')}><Banknote className="size-4" /> เงินสด <kbd className="ml-1 text-xs opacity-70">F2</kbd></Button>
          <Button size="lg" disabled={mut.isPending || !hasItems} onClick={() => tender('QR Code')}><QrCode className="size-4" /> QR <kbd className="ml-1 text-xs opacity-70">F8</kbd></Button>
          <Button size="lg" disabled={mut.isPending || !hasItems} onClick={() => tender('Card')}><CreditCard className="size-4" /> บัตร <kbd className="ml-1 text-xs opacity-70">F4</kbd></Button>
        </div>
        <Button size="lg" variant="secondary" className="w-full" disabled={mut.isPending || !hasItems} onClick={() => tender(payment)}>
          <Wallet className="size-4" /> {mut.isPending ? 'กำลังบันทึก…' : online ? `ยืนยันการขาย (${payment})` : `บันทึกออฟไลน์ (${payment})`}
        </Button>
        {payErr && <Msg>{payErr}</Msg>}
        {mut.error && <Msg>{(mut.error as Error).message}</Msg>}
        {mut.data && <Msg ok>✅ ขายสำเร็จ {mut.data.sale_no} · สุทธิ {baht(mut.data.total)} · ได้แต้ม +{mut.data.points_earned}</Msg>}
        {queued && <Msg ok>{queued}</Msg>}
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
