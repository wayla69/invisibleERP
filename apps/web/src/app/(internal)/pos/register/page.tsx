'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ListChecks, Store, Utensils, X } from 'lucide-react';
import { api } from '@/lib/api';
import { thaiDate } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';
import { useTerminal } from '@/lib/terminal';
import { StateView } from '@/components/state-view';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MenuGrid } from '@/components/pos/menu-grid';
import { CartPanel } from '@/components/pos/cart-panel';
import { CheckoutPanel, type SettleResult } from '@/components/pos/checkout-panel';
import { ModifierDialog } from '@/components/pos/modifier-dialog';
import { TerminalBar } from '@/components/pos/terminal-bar';
import { addLine, cartTotals, newLineKey } from '@/components/pos/cart';
import { lineAmount, type CartLine, type MenuItem, type MenuResp } from '@/components/pos/types';

type Mode = 'quick' | 'dinein';
type Method = 'Cash' | 'PromptPay' | 'Card' | 'Transfer';

interface HeldCart { lines: CartLine[]; mode: Mode; tableId: number | null; tableNo: string | null; customerName: string }

export default function RegisterPage() {
  const qc = useQueryClient();
  const tm = useTerminal();
  const menu = useQuery<MenuResp>({ queryKey: ['menu'], queryFn: () => api('/api/menu') });

  const [lines, setLines] = useState<CartLine[]>([]);
  const [mode, setMode] = useState<Mode>('quick');
  const [tableId, setTableId] = useState<number | null>(null);
  const [tableNo, setTableNo] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState('');

  const [modSku, setModSku] = useState<string | null>(null);
  const [checkout, setCheckout] = useState(false);
  const [tablePicker, setTablePicker] = useState(false);
  const [heldOpen, setHeldOpen] = useState(false);

  const t = useMemo(() => cartTotals(lines), [lines]);

  // ── cart ops ──
  const pick = useCallback((it: MenuItem) => {
    if (it.has_modifiers) { setModSku(it.sku); return; }
    setLines((ls) => addLine(ls, {
      key: newLineKey(), item_id: it.id, sku: it.sku, name: it.name,
      unit_price: it.price, qty: 1, discount_pct: 0, station_code: it.station_code,
    }));
  }, []);
  const setQty = (key: string, delta: number) => setLines((ls) => ls.flatMap((l) => {
    if (l.key !== key) return [l];
    const qty = l.qty + delta;
    return qty <= 0 ? [] : [{ ...l, qty }];
  }));
  const removeLine = (key: string) => setLines((ls) => ls.filter((l) => l.key !== key));
  const clearCart = () => { setLines([]); setCustomerName(''); };
  const resetSale = () => { setLines([]); setCustomerName(''); setMode('quick'); setTableId(null); setTableNo(null); };

  // ── customer-facing display: mirror the cart (debounced) ──
  useEffect(() => {
    const id = setTimeout(() => {
      if (lines.length === 0) { tm.pushDisplay({ message: 'ยินดีต้อนรับ / Welcome' }); return; }
      tm.pushDisplay({
        message: tableNo ? `โต๊ะ ${tableNo}` : 'กำลังคิดเงิน',
        lines: lines.map((l) => ({ name: l.name, qty: l.qty, amount: lineAmount(l) })),
        subtotal: t.net, total: t.total,
      });
    }, 500);
    return () => clearTimeout(id);
  }, [lines, t.net, t.total, tableNo, tm]);

  // ── settle: create the order (re-priced + 86-checked server-side), fire kitchen for dine-in, checkout,
  //    then drive the hardware (customer display → print → drawer). Returns the authoritative sale. ──
  const settle = useCallback(async ({ method, discountPct, cashReceived }: { method: Method; discountPct: number; cashReceived?: number }): Promise<SettleResult> => {
    const items = lines.map((l) => ({ sku: l.sku, qty: l.qty, modifier_option_ids: l.modifier_option_ids, notes: l.notes }));
    const created = await api<{ order_no: string }>('/api/restaurant/orders', {
      method: 'POST',
      body: JSON.stringify({ table_id: tableId ?? undefined, items }),
    });
    const orderNo = created.order_no;
    if (mode === 'dinein') {
      await api(`/api/restaurant/orders/${orderNo}/fire`, { method: 'POST', body: '{}' }).catch(() => { /* kitchen fire best-effort */ });
    }
    const sale = await api<{ sale_no: string; total: number; total_with_tip?: number }>(`/api/restaurant/orders/${orderNo}/checkout`, {
      method: 'POST',
      body: JSON.stringify({ method, discount_pct: discountPct || undefined }),
    });
    const total = Number(sale.total ?? sale.total_with_tip ?? t.total);
    const change = cashReceived != null ? Math.round((cashReceived - total) * 100) / 100 : undefined;

    tm.pushDisplay({ message: 'ขอบคุณค่ะ/ครับ', total, amount_due: cashReceived ?? undefined, change });
    // Auto-print only when a printer is paired — otherwise the cashier prints on demand from the success
    // screen (avoids a surprise print dialog when no printer is set up yet).
    if (tm.printerConnected) tm.printReceipt(sale.sale_no).catch((e) => notifyError('พิมพ์ใบเสร็จไม่สำเร็จ — ' + (e as Error).message));
    if (method === 'Cash') void tm.kickDrawer({ saleNo: sale.sale_no, amount: total, reason: 'sale' });

    qc.invalidateQueries({ queryKey: ['orders'] });
    qc.invalidateQueries({ queryKey: ['pos-summary'] });
    return { sale_no: sale.sale_no, total, change };
  }, [lines, tableId, mode, t.total, tm, qc]);

  const finishSale = () => { setCheckout(false); resetSale(); tm.pushDisplay({ message: 'ยินดีต้อนรับ / Welcome' }); };

  // ── hold / recall ──
  const hold = async () => {
    if (!lines.length) return;
    try {
      const cart: HeldCart = { lines, mode, tableId, tableNo, customerName };
      const r = await api<{ hold_no: string }>('/api/pos/hold', {
        method: 'POST',
        body: JSON.stringify({ label: tableNo ? `โต๊ะ ${tableNo}` : undefined, customer_name: customerName || undefined, cart }),
      });
      notifySuccess(`พักบิลแล้ว · ${r.hold_no}`);
      resetSale();
    } catch (e) { notifyError((e as Error).message); }
  };
  const recall = (cart: HeldCart) => {
    setLines(cart.lines ?? []);
    setMode(cart.mode ?? 'quick');
    setTableId(cart.tableId ?? null);
    setTableNo(cart.tableNo ?? null);
    setCustomerName(cart.customerName ?? '');
    setHeldOpen(false);
  };

  return (
    <div className="flex flex-col">
      <TerminalBar terminal={tm} />

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Store className="size-5 text-primary" /> ขายหน้าร้าน
        </h1>
        <div className="flex flex-wrap items-center gap-1.5">
          {mode === 'dinein' && tableNo ? (
            <Badge variant="info" className="gap-1">
              <Utensils className="size-3" /> โต๊ะ {tableNo}
              <button aria-label="ยกเลิกโต๊ะ" onClick={() => { setMode('quick'); setTableId(null); setTableNo(null); }} className="ml-1 hover:text-foreground"><X className="size-3" /></button>
            </Badge>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setTablePicker(true)}><Utensils className="size-4" /> แนบโต๊ะ</Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setHeldOpen(true)}><ListChecks className="size-4" /> บิลที่พักไว้</Button>
          <Button asChild variant="ghost" size="sm"><Link href="/tables">บริการโต๊ะ/บุฟเฟต์ →</Link></Button>
        </div>
      </div>

      <StateView q={menu}>
        {menu.data && (
          <div className="grid h-[calc(100dvh-13.5rem)] min-h-[440px] gap-4 lg:grid-cols-[1fr_minmax(320px,360px)]">
            <MenuGrid data={menu.data} onPick={pick} className="h-full rounded-xl border bg-card p-3" />
            <CartPanel
              lines={lines}
              mode={mode}
              tableNo={tableNo}
              customerName={customerName || null}
              onQty={setQty}
              onRemove={removeLine}
              onClear={clearCart}
              onHold={hold}
              onCheckout={() => setCheckout(true)}
            />
          </div>
        )}
      </StateView>

      {modSku && (
        <ModifierDialog
          sku={modSku}
          onClose={() => setModSku(null)}
          onConfirm={(line) => setLines((ls) => addLine(ls, line))}
        />
      )}

      {checkout && lines.length > 0 && (
        <CheckoutPanel
          lines={lines}
          onSettle={settle}
          onReprint={(saleNo) => tm.printReceipt(saleNo)}
          onSendReceipt={(saleNo, channel, to) => api(`/api/pos/sales/${encodeURIComponent(saleNo)}/receipt/send`, { method: 'POST', body: JSON.stringify({ channel, to }) }).then(() => undefined)}
          onClose={() => setCheckout(false)}
          onFinish={finishSale}
        />
      )}

      {tablePicker && (
        <TableDialog
          onClose={() => setTablePicker(false)}
          onPick={(id, no) => { setTableId(id); setTableNo(no); setMode('dinein'); setTablePicker(false); }}
        />
      )}

      {heldOpen && <HeldDialog onClose={() => setHeldOpen(false)} onRecall={recall} />}
    </div>
  );
}

// ── attach-table picker ──
interface TableRow { id: number; table_no: string; status: string; seats: number }
function TableDialog({ onClose, onPick }: { onClose: () => void; onPick: (id: number, no: string) => void }) {
  const q = useQuery<{ tables: TableRow[] }>({ queryKey: ['tables-list'], queryFn: () => api('/api/restaurant/tables') });
  const tone = (s: string) => (['occupied', 'bill_requested', 'paying'].includes(s) ? 'warning' : s === 'available' ? 'success' : 'muted');
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>แนบโต๊ะ (ส่งครัว + แยกรายได้ตามโต๊ะ)</DialogTitle></DialogHeader>
        <StateView q={q}>
          {q.data && (
            q.data.tables.length === 0
              ? <p className="py-6 text-center text-sm text-muted-foreground">ยังไม่มีโต๊ะ — เพิ่มได้ที่หน้า “บริการโต๊ะ”</p>
              : (
                <div className="grid max-h-[55vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
                  {q.data.tables.map((tb) => (
                    <button
                      key={tb.id}
                      type="button"
                      onClick={() => onPick(tb.id, tb.table_no)}
                      className="flex flex-col items-center gap-1 rounded-lg border p-3 text-center transition-colors hover:border-primary hover:bg-accent"
                    >
                      <span className="font-semibold">{tb.table_no}</span>
                      <Badge variant={tone(tb.status)} className="text-[10px]">{tb.seats} ที่</Badge>
                    </button>
                  ))}
                </div>
              )
          )}
        </StateView>
      </DialogContent>
    </Dialog>
  );
}

// ── held-bills list ──
interface HeldRow { hold_no: string; label: string | null; customer_name: string | null; created_at: string }
function HeldDialog({ onClose, onRecall }: { onClose: () => void; onRecall: (cart: HeldCart) => void }) {
  const qc = useQueryClient();
  const q = useQuery<{ held: HeldRow[] }>({ queryKey: ['pos-held'], queryFn: () => api('/api/pos/held') });
  const doRecall = async (holdNo: string) => {
    try {
      const r = await api<{ cart: HeldCart }>(`/api/pos/held/${encodeURIComponent(holdNo)}/recall`, { method: 'POST', body: '{}' });
      onRecall(r.cart);
    } catch (e) { notifyError((e as Error).message); }
  };
  const discard = async (holdNo: string) => {
    try { await api(`/api/pos/held/${encodeURIComponent(holdNo)}/discard`, { method: 'POST', body: '{}' }); qc.invalidateQueries({ queryKey: ['pos-held'] }); }
    catch (e) { notifyError((e as Error).message); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>บิลที่พักไว้</DialogTitle></DialogHeader>
        <StateView q={q}>
          {q.data && (
            q.data.held.length === 0
              ? <p className="py-6 text-center text-sm text-muted-foreground">ไม่มีบิลที่พักไว้</p>
              : (
                <ul className="divide-y">
                  {q.data.held.map((h) => (
                    <li key={h.hold_no} className="flex items-center justify-between gap-2 py-2.5">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{h.label || h.customer_name || h.hold_no}</div>
                        <div className="text-xs text-muted-foreground">{h.hold_no} · {thaiDate(h.created_at)}</div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button size="sm" variant="outline" onClick={() => doRecall(h.hold_no)}>เรียกคืน</Button>
                        <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => discard(h.hold_no)}>ทิ้ง</Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )
          )}
        </StateView>
      </DialogContent>
    </Dialog>
  );
}
