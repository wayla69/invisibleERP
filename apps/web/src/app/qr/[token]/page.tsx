'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { CheckCircle2, Clock, Minus, Plus, QrCode, ReceiptText, ShoppingCart, Smartphone, Utensils } from 'lucide-react';
import { publicApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

// ── types (mirror the public QR endpoints) ──
type Status = {
  table_no: string | null; session_status: string;
  order: { order_no: string; status: string; waited_min: number; ready_in_min: number; items: { item_id: number; name: string; qty: number; kds_status: string; status_th: string }[] } | null;
  bill: { subtotal: number; vat: number; total: number; settled: boolean } | null;
};
type Option = { option_id: number; name: string; price_delta: number; is_default: boolean };
type Group = { group_id: number; code: string; name: string; min_select: number; max_select: number; required: boolean; options: Option[] };
type MenuItem = { id: number; sku: string; name: string; name_en: string | null; price: number; is_available: boolean; description: string | null; has_modifiers: boolean; modifier_groups: Group[] };
type Category = { id: number; code: string; name: string; items: MenuItem[] };
type Menu = { categories: Category[]; uncategorized: MenuItem[]; item_count: number };
type CartLine = { key: string; sku: string; name: string; qty: number; unitPrice: number; optionIds: number[]; optionLabels: string[] };

const ITEM_COLOR: Record<string, string> = {
  'รับออเดอร์': 'text-muted-foreground',
  'รอคิว': 'text-info',
  'กำลังปรุง': 'text-warning-foreground dark:text-warning',
  'พร้อมเสิร์ฟ': 'text-success',
  'เสิร์ฟแล้ว': 'text-success',
};
const baht = (v: number) => `฿${Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function DinerPage() {
  const token = String(useParams().token ?? '');
  const [tab, setTab] = useState<'menu' | 'order'>('order');
  const [st, setSt] = useState<Status | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [err, setErr] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [picker, setPicker] = useState<MenuItem | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [pay, setPay] = useState<{ payment_no: string; gateway_ref: string; total: number } | null>(null);
  const [paid, setPaid] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setSt(await publicApi<Status>(`/api/qr/t/${token}`)); setErr(''); }
    catch (e) { setErr(e instanceof Error ? e.message : 'โหลดไม่สำเร็จ'); }
  }, [token]);

  useEffect(() => { load(); const i = setInterval(load, 5000); return () => clearInterval(i); }, [load]);

  // menu is fetched lazily on first switch to the menu tab
  useEffect(() => {
    if (tab !== 'menu' || menu) return;
    publicApi<Menu>(`/api/qr/t/${token}/menu`).then(setMenu).catch((e) => setErr(String((e as Error).message)));
  }, [tab, menu, token]);

  const cartCount = cart.reduce((a, c) => a + c.qty, 0);
  const cartTotal = cart.reduce((a, c) => a + c.unitPrice * c.qty, 0);

  const addToCart = (line: CartLine) =>
    setCart((cur) => {
      const i = cur.findIndex((c) => c.key === line.key);
      if (i >= 0) { const next = [...cur]; next[i] = { ...next[i], qty: next[i].qty + line.qty }; return next; }
      return [...cur, line];
    });

  const onItemTap = (it: MenuItem) => {
    if (!it.is_available) return;
    if (it.modifier_groups.length) { setPicker(it); return; }
    addToCart({ key: `${it.sku}`, sku: it.sku, name: it.name, qty: 1, unitPrice: it.price, optionIds: [], optionLabels: [] });
  };

  const submitOrder = async () => {
    if (!cart.length) return;
    setBusy(true);
    try {
      await publicApi(`/api/qr/t/${token}/order`, { method: 'POST', body: JSON.stringify({ items: cart.map((c) => ({ sku: c.sku, modifier_option_ids: c.optionIds, qty: c.qty })) }) });
      setCart([]); setCartOpen(false); setTab('order'); await load();
    } catch (e) { setErr(String((e as Error).message)); }
    finally { setBusy(false); }
  };

  const doBill = async () => { setBusy(true); try { await publicApi(`/api/qr/t/${token}/bill`, { method: 'POST' }); await load(); } finally { setBusy(false); } };
  const doPay = async () => { setBusy(true); try { setPay(await publicApi(`/api/qr/t/${token}/pay`, { method: 'POST' })); } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(false); } };
  const doConfirm = async () => { if (!pay) return; setBusy(true); try { await publicApi(`/api/qr/t/${token}/confirm`, { method: 'POST', body: JSON.stringify({ payment_no: pay.payment_no }) }); setPaid(true); } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(false); } };

  if (paid)
    return (
      <main className="mx-auto grid min-h-svh max-w-md place-items-center bg-muted/30 p-4">
        <Card className="w-full items-center gap-2 p-8 text-center">
          <CheckCircle2 className="size-14 text-success" />
          <h2 className="text-xl font-semibold">ชำระเงินสำเร็จ</h2>
          <p className="text-sm text-muted-foreground">ขอบคุณที่ใช้บริการ 🙏</p>
        </Card>
      </main>
    );

  const allItems = menu ? [...menu.categories.flatMap((c) => c.items), ...menu.uncategorized] : [];

  return (
    <main className="mx-auto min-h-svh max-w-md bg-muted/30 p-4 pb-24">
      <div className="mb-4 flex items-center gap-2">
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Utensils className="size-5" />
        </div>
        <h2 className="text-lg font-semibold">โต๊ะ {st?.table_no ?? '…'}</h2>
      </div>
      {err && <p className="mb-3 text-sm text-destructive">{err}</p>}

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'menu' | 'order')}>
        <TabsList className="mb-3 grid w-full grid-cols-2">
          <TabsTrigger value="menu"><Utensils className="mr-1.5 size-4" /> เมนู</TabsTrigger>
          <TabsTrigger value="order"><ReceiptText className="mr-1.5 size-4" /> ออเดอร์ของฉัน</TabsTrigger>
        </TabsList>

        {/* ── เมนู: browse + add to cart ── */}
        <TabsContent value="menu">
          {!menu ? (
            <p className="text-sm text-muted-foreground">กำลังโหลดเมนู…</p>
          ) : allItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">ยังไม่มีเมนู</p>
          ) : (
            menu.categories.filter((c) => c.items.length).concat(menu.uncategorized.length ? [{ id: 0, code: '_', name: 'อื่น ๆ', items: menu.uncategorized }] : []).map((c) => (
              <section key={c.id} className="mb-4">
                <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{c.name}</h3>
                <div className="grid gap-2">
                  {c.items.map((it) => (
                    <button key={it.id} type="button" onClick={() => onItemTap(it)} disabled={!it.is_available}
                      className={cn('flex items-center justify-between rounded-lg border bg-card p-3 text-left transition', it.is_available ? 'hover:border-primary/60' : 'opacity-50')}>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-medium">{it.name}{!it.is_available && <Badge variant="secondary" className="text-[10px]">หมด</Badge>}</div>
                        {it.description && <p className="truncate text-xs text-muted-foreground">{it.description}</p>}
                      </div>
                      <div className="ml-3 flex shrink-0 items-center gap-2">
                        <span className="text-sm font-semibold tabular">{baht(it.price)}</span>
                        {it.is_available && <span className="grid size-6 place-items-center rounded-full bg-primary/10 text-primary"><Plus className="size-4" /></span>}
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            ))
          )}
        </TabsContent>

        {/* ── ออเดอร์ของฉัน: live status + bill + pay (existing flow) ── */}
        <TabsContent value="order">
          {st?.order ? (
            <>
              <Card className="mb-3 gap-3 p-4">
                <div className="flex items-center justify-between">
                  <strong className="text-sm">สถานะออเดอร์</strong>
                  <span className="text-xs text-muted-foreground">
                    {st.order.waited_min > 0 ? `รอมาแล้ว ${st.order.waited_min} นาที` : 'เพิ่งสั่ง'}
                  </span>
                </div>
                {st.order.ready_in_min > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-warning-foreground dark:text-warning">
                    <Clock className="size-4" /> อาหารพร้อมในอีกประมาณ {st.order.ready_in_min} นาที
                  </div>
                )}
                <div className="divide-y">
                  {st.order.items.map((it) => (
                    <div key={it.item_id} className="flex items-center justify-between py-1.5">
                      <span className="text-sm">{it.qty}× {it.name}</span>
                      <span className={cn('text-xs font-semibold', ITEM_COLOR[it.status_th] ?? 'text-muted-foreground')}>
                        {it.status_th}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>

              {st.bill && (
                <Card className="mb-3 gap-1.5 p-4 text-sm">
                  <div className="flex justify-between text-muted-foreground"><span>มูลค่าสินค้า</span><span className="tabular">{baht(st.bill.subtotal)}</span></div>
                  <div className="flex justify-between text-muted-foreground"><span>VAT 7%</span><span className="tabular">{baht(st.bill.vat)}</span></div>
                  <div className="mt-1 flex justify-between border-t pt-2 text-lg font-bold text-primary"><span>รวมทั้งสิ้น</span><span className="tabular">{baht(st.bill.total)}</span></div>
                </Card>
              )}

              {!pay && (
                <>
                  {st.session_status === 'open' && (
                    <Button onClick={doBill} disabled={busy} variant="outline" className="h-12 w-full text-base">
                      <ReceiptText className="size-5" /> เรียกเก็บเงิน
                    </Button>
                  )}
                  {st.session_status === 'bill_requested' && (
                    <Button onClick={doPay} disabled={busy} className="h-12 w-full text-base">
                      <Smartphone className="size-5" /> ชำระด้วย PromptPay
                    </Button>
                  )}
                </>
              )}
              {pay && (
                <Card className="items-center gap-3 p-5 text-center">
                  <div className="font-medium">สแกนเพื่อชำระ {baht(pay.total)}</div>
                  <div className="grid size-44 place-items-center gap-1 rounded-xl border-2 border-dashed border-primary/60 p-2 text-xs text-muted-foreground">
                    <QrCode className="size-10 text-primary/70" />
                    PromptPay QR<br />({pay.gateway_ref})
                  </div>
                  <p className="text-xs text-muted-foreground">กำลังรอยืนยันการชำระเงิน…</p>
                  <Button onClick={doConfirm} disabled={busy} className="h-12 w-full bg-success text-base text-success-foreground hover:bg-success/90">
                    ยืนยันการชำระเงิน (จำลอง)
                  </Button>
                </Card>
              )}
            </>
          ) : (
            <div className="grid place-items-center gap-3 py-10 text-center">
              <p className="text-sm text-muted-foreground">ยังไม่มีรายการอาหาร</p>
              <Button onClick={() => setTab('menu')} variant="outline"><Utensils className="size-4" /> เปิดเมนูเพื่อสั่งอาหาร</Button>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* ── floating cart bar ── */}
      {cartCount > 0 && (
        <div className="fixed inset-x-0 bottom-0 mx-auto max-w-md p-4">
          <Button onClick={() => setCartOpen(true)} className="h-14 w-full justify-between text-base shadow-lg">
            <span className="flex items-center gap-2"><ShoppingCart className="size-5" /> ตะกร้า ({cartCount})</span>
            <span className="tabular">{baht(cartTotal)}</span>
          </Button>
        </div>
      )}

      {picker && <ModifierPicker item={picker} onClose={() => setPicker(null)} onAdd={(line) => { addToCart(line); setPicker(null); }} />}
      <CartDialog open={cartOpen} onOpenChange={setCartOpen} cart={cart} setCart={setCart} total={cartTotal} busy={busy} onSubmit={submitOrder} />
    </main>
  );
}

// ── modifier picker (one item) ──
function ModifierPicker({ item, onClose, onAdd }: { item: MenuItem; onClose: () => void; onAdd: (l: CartLine) => void }) {
  const [sel, setSel] = useState<Record<number, number[]>>(() => {
    const init: Record<number, number[]> = {};
    for (const g of item.modifier_groups) { const d = g.options.find((o) => o.is_default); init[g.group_id] = d ? [d.option_id] : []; }
    return init;
  });
  const toggle = (g: Group, oid: number) =>
    setSel((cur) => {
      const chosen = cur[g.group_id] ?? [];
      if (g.max_select <= 1) return { ...cur, [g.group_id]: chosen.includes(oid) && !g.required ? [] : [oid] };
      if (chosen.includes(oid)) return { ...cur, [g.group_id]: chosen.filter((x) => x !== oid) };
      if (chosen.length >= g.max_select) return cur;
      return { ...cur, [g.group_id]: [...chosen, oid] };
    });

  const missing = item.modifier_groups.find((g) => {
    const min = g.required ? Math.max(1, g.min_select) : g.min_select;
    return (sel[g.group_id]?.length ?? 0) < min;
  });
  const optionIds = Object.values(sel).flat();
  const byId = new Map(item.modifier_groups.flatMap((g) => g.options).map((o) => [o.option_id, o]));
  const unitPrice = useMemo(() => item.price + optionIds.reduce((a, id) => a + (byId.get(id)?.price_delta ?? 0), 0), [item.price, optionIds, byId]);

  const confirm = () => {
    if (missing) return;
    const labels = optionIds.map((id) => byId.get(id)?.name ?? '').filter(Boolean);
    onAdd({ key: `${item.sku}#${optionIds.slice().sort((a, b) => a - b).join(',')}`, sku: item.sku, name: item.name, qty: 1, unitPrice, optionIds, optionLabels: labels });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{item.name}</DialogTitle></DialogHeader>
        <div className="max-h-[55svh] space-y-4 overflow-y-auto">
          {item.modifier_groups.map((g) => (
            <div key={g.group_id}>
              <div className="mb-1.5 flex items-center gap-2 text-sm font-medium">
                {g.name}
                {g.required ? <Badge variant="destructive" className="text-[10px]">จำเป็น</Badge> : <span className="text-xs text-muted-foreground">เลือกได้สูงสุด {g.max_select}</span>}
              </div>
              <div className="grid gap-1.5">
                {g.options.map((o) => {
                  const active = (sel[g.group_id] ?? []).includes(o.option_id);
                  return (
                    <button key={o.option_id} type="button" onClick={() => toggle(g, o.option_id)}
                      className={cn('flex items-center justify-between rounded-lg border p-2.5 text-sm transition', active ? 'border-primary bg-primary/5' : 'hover:border-primary/40')}>
                      <span className="flex items-center gap-2">
                        <span className={cn('grid size-4 place-items-center rounded-full border', active && 'border-primary bg-primary text-primary-foreground')}>
                          {active && <CheckCircle2 className="size-3.5" />}
                        </span>
                        {o.name}
                      </span>
                      {o.price_delta > 0 && <span className="text-xs text-muted-foreground tabular">+{baht(o.price_delta)}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button onClick={confirm} disabled={!!missing} className="h-12 w-full justify-between text-base">
            <span>เพิ่มลงตะกร้า</span><span className="tabular">{baht(unitPrice)}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── cart review + submit ──
function CartDialog({ open, onOpenChange, cart, setCart, total, busy, onSubmit }: {
  open: boolean; onOpenChange: (o: boolean) => void; cart: CartLine[]; setCart: (f: (c: CartLine[]) => CartLine[]) => void; total: number; busy: boolean; onSubmit: () => void;
}) {
  const setQty = (key: string, delta: number) =>
    setCart((cur) => cur.flatMap((c) => (c.key === key ? (c.qty + delta <= 0 ? [] : [{ ...c, qty: c.qty + delta }]) : [c])));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>ตะกร้าของฉัน</DialogTitle></DialogHeader>
        {cart.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">ตะกร้าว่าง</p>
        ) : (
          <div className="max-h-[55svh] space-y-3 overflow-y-auto">
            {cart.map((c) => (
              <div key={c.key} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{c.name}</div>
                  {c.optionLabels.length > 0 && <p className="text-xs text-muted-foreground">{c.optionLabels.join(' · ')}</p>}
                  <p className="text-xs text-muted-foreground tabular">{baht(c.unitPrice)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button size="icon" variant="outline" className="size-7" onClick={() => setQty(c.key, -1)}><Minus className="size-3.5" /></Button>
                  <span className="w-5 text-center text-sm tabular">{c.qty}</span>
                  <Button size="icon" variant="outline" className="size-7" onClick={() => setQty(c.key, 1)}><Plus className="size-3.5" /></Button>
                </div>
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button onClick={onSubmit} disabled={busy || cart.length === 0} className="h-12 w-full justify-between text-base">
            <span>ส่งออเดอร์เข้าครัว</span><span className="tabular">{baht(total)}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
