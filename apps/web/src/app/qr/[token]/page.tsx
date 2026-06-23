'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { CheckCircle2, Clock, Minus, Plus, QrCode, ReceiptText, ShoppingCart, Smartphone, Timer, Utensils } from 'lucide-react';
import { publicApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

// ── types (mirror the public QR endpoints) ──
type Item = { item_id: number; name: string; qty: number; kds_status: string; status_th: string; amount: number; is_buffet: boolean; charge: boolean };
type Buffet = { package_name: string | null; pax: number | null; expires_at: string | null; minutes_left: number | null; expired: boolean };
type Status = {
  table_no: string | null; session_status: string; order_mode: 'a_la_carte' | 'buffet'; buffet: Buffet | null;
  order: { order_no: string; status: string; waited_min: number; ready_in_min: number; items: Item[] } | null;
  bill: { subtotal: number; vat: number; total: number; settled: boolean } | null;
};
type Option = { option_id: number; name: string; price_delta: number; is_default: boolean };
type Group = { group_id: number; code: string; name: string; min_select: number; max_select: number; required: boolean; options: Option[] };
type MenuItem = { id: number; sku: string; name: string; name_en: string | null; price: number; is_available: boolean; available_now?: boolean; description: string | null; has_modifiers: boolean; modifier_groups: Group[] };
type Category = { id: number; code: string; name: string; items: MenuItem[] };
type Menu = { categories: Category[]; uncategorized: MenuItem[]; item_count: number };
type Tier = { id: number; code: string; name: string; name_en: string | null; price_per_pax: number; time_limit_min: number; overtime_fee_per_pax: number };
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
  const [tiers, setTiers] = useState<Tier[] | null>(null);
  const [err, setErr] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [picker, setPicker] = useState<MenuItem | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [buffetOpen, setBuffetOpen] = useState(false);
  const [pay, setPay] = useState<{ payment_no: string; gateway_ref: string; total: number; qr_image: string | null; mock_settle: boolean } | null>(null);
  const [paid, setPaid] = useState(false);
  const [busy, setBusy] = useState(false);

  const isBuffet = st?.order_mode === 'buffet';
  const hasOrder = !!st?.order;

  const load = useCallback(async () => {
    try { setSt(await publicApi<Status>(`/api/qr/t/${token}`)); setErr(''); }
    catch (e) { setErr(e instanceof Error ? e.message : 'โหลดไม่สำเร็จ'); }
  }, [token]);

  useEffect(() => { load(); const i = setInterval(load, 5000); return () => clearInterval(i); }, [load]);

  // real PromptPay: settlement is out-of-band (PSP webhook). Poll until the tender settles, then show success.
  useEffect(() => {
    if (!pay || pay.mock_settle || paid) return;
    const check = async () => {
      try { const r = await publicApi<{ settled: boolean }>(`/api/qr/t/${token}/payment-status`); if (r.settled) setPaid(true); } catch { /* keep polling */ }
    };
    check(); const i = setInterval(check, 4000); return () => clearInterval(i);
  }, [pay, paid, token]);

  // menu + buffet tiers fetched lazily on first switch to the menu tab
  useEffect(() => {
    if (tab !== 'menu') return;
    if (!menu) publicApi<Menu>(`/api/qr/t/${token}/menu`).then(setMenu).catch((e) => setErr(String((e as Error).message)));
    if (!tiers) publicApi<{ tiers: Tier[] }>(`/api/qr/t/${token}/buffet/tiers`).then((r) => setTiers(r.tiers)).catch(() => setTiers([]));
  }, [tab, menu, tiers, token]);

  const cartCount = cart.reduce((a, c) => a + c.qty, 0);
  const cartTotal = cart.reduce((a, c) => a + c.unitPrice * c.qty, 0);

  const addToCart = (line: CartLine) =>
    setCart((cur) => {
      const i = cur.findIndex((c) => c.key === line.key);
      if (i >= 0) { const next = [...cur]; next[i] = { ...next[i], qty: next[i].qty + line.qty }; return next; }
      return [...cur, line];
    });

  const orderable = (it: MenuItem) => it.is_available && it.available_now !== false;
  const onItemTap = (it: MenuItem) => {
    if (!orderable(it)) return;
    if (it.modifier_groups.length) { setPicker(it); return; }
    addToCart({ key: `${it.sku}`, sku: it.sku, name: it.name, qty: 1, unitPrice: isBuffet ? 0 : it.price, optionIds: [], optionLabels: [] });
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

  const startBuffet = async (packageId: number, pax: number) => {
    setBusy(true);
    try { await publicApi(`/api/qr/t/${token}/buffet/start`, { method: 'POST', body: JSON.stringify({ package_id: packageId, pax }) }); setBuffetOpen(false); await load(); }
    catch (e) { setErr(String((e as Error).message)); }
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
  const dishes = st?.order?.items.filter((i) => !i.charge) ?? [];
  const chargeLines = st?.order?.items.filter((i) => i.charge) ?? [];
  const canStartBuffet = !isBuffet && !hasOrder && (tiers?.length ?? 0) > 0;

  return (
    <main className="mx-auto min-h-svh max-w-md bg-muted/30 p-4 pb-24">
      <div className="mb-4 flex items-center gap-2">
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Utensils className="size-5" />
        </div>
        <h2 className="text-lg font-semibold">โต๊ะ {st?.table_no ?? '…'}</h2>
        {isBuffet && st?.buffet && <BuffetChip b={st.buffet} />}
      </div>
      {err && <p className="mb-3 text-sm text-destructive">{err}</p>}

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'menu' | 'order')}>
        <TabsList className="mb-3 grid w-full grid-cols-2">
          <TabsTrigger value="menu"><Utensils className="mr-1.5 size-4" /> เมนู</TabsTrigger>
          <TabsTrigger value="order"><ReceiptText className="mr-1.5 size-4" /> ออเดอร์ของฉัน</TabsTrigger>
        </TabsList>

        {/* ── เมนู ── */}
        <TabsContent value="menu">
          {canStartBuffet && (
            <Card className="mb-4 gap-2 border-primary/40 bg-primary/5 p-4">
              <strong className="text-sm">เลือกบุฟเฟต์ (ทานได้ไม่อั้นตามเวลา)</strong>
              <p className="text-xs text-muted-foreground">เลือกแพ็กเกจบุฟเฟต์ก่อนเริ่มสั่งอาหาร หรือเลื่อนลงเพื่อสั่งแบบรายจาน</p>
              <Button onClick={() => setBuffetOpen(true)} className="mt-1 h-11 w-full"><Timer className="size-4" /> เริ่มบุฟเฟต์</Button>
            </Card>
          )}
          {isBuffet && st?.buffet && (
            <Card className="mb-4 gap-1 border-primary/40 bg-primary/5 p-3 text-sm">
              <div className="flex items-center justify-between">
                <strong>{st.buffet.package_name} · {st.buffet.pax} ท่าน</strong>
                <BuffetChip b={st.buffet} />
              </div>
              <p className="text-xs text-muted-foreground">เลือกอาหารได้ไม่อั้นภายในเวลาที่กำหนด · ทุกจานรวมในบุฟเฟต์แล้ว</p>
            </Card>
          )}
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
                    <button key={it.id} type="button" onClick={() => onItemTap(it)} disabled={!orderable(it)}
                      className={cn('flex items-center justify-between rounded-lg border bg-card p-3 text-left transition', orderable(it) ? 'hover:border-primary/60' : 'opacity-50')}>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-medium">{it.name}
                          {!it.is_available && <Badge variant="secondary" className="text-[10px]">หมด</Badge>}
                          {it.is_available && it.available_now === false && <Badge variant="secondary" className="text-[10px]">ยังไม่ถึงเวลาขาย</Badge>}
                        </div>
                        {it.description && <p className="truncate text-xs text-muted-foreground">{it.description}</p>}
                      </div>
                      <div className="ml-3 flex shrink-0 items-center gap-2">
                        <span className="text-sm font-semibold tabular">{isBuffet ? <span className="text-primary">บุฟเฟต์</span> : baht(it.price)}</span>
                        {orderable(it) && <span className="grid size-6 place-items-center rounded-full bg-primary/10 text-primary"><Plus className="size-4" /></span>}
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            ))
          )}
        </TabsContent>

        {/* ── ออเดอร์ของฉัน ── */}
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
                {dishes.length === 0 && <p className="text-sm text-muted-foreground">ยังไม่ได้สั่งอาหาร — เปิดแท็บเมนูเพื่อสั่ง</p>}
                <div className="divide-y">
                  {dishes.map((it) => (
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
                  {chargeLines.map((c) => (
                    <div key={c.item_id} className="flex justify-between text-muted-foreground"><span>{c.name}</span><span className="tabular">{baht(c.amount)}</span></div>
                  ))}
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
                  {pay.qr_image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={pay.qr_image} alt="PromptPay QR" className="size-48 rounded-xl border bg-white p-2" />
                  ) : (
                    <div className="grid size-44 place-items-center gap-1 rounded-xl border-2 border-dashed border-primary/60 p-2 text-xs text-muted-foreground">
                      <QrCode className="size-10 text-primary/70" />
                      PromptPay QR<br />({pay.gateway_ref})
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">เปิดแอปธนาคารแล้วสแกน QR เพื่อชำระด้วย PromptPay</p>
                  {pay.mock_settle ? (
                    <Button onClick={doConfirm} disabled={busy} className="h-12 w-full bg-success text-base text-success-foreground hover:bg-success/90">
                      ยืนยันการชำระเงิน (จำลอง)
                    </Button>
                  ) : (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Clock className="size-4" /> กำลังรอยืนยันการชำระเงินอัตโนมัติ…</p>
                  )}
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
            <span className="tabular">{isBuffet ? 'บุฟเฟต์' : baht(cartTotal)}</span>
          </Button>
        </div>
      )}

      {picker && <ModifierPicker item={picker} buffet={isBuffet} onClose={() => setPicker(null)} onAdd={(line) => { addToCart(line); setPicker(null); }} />}
      <CartDialog open={cartOpen} onOpenChange={setCartOpen} cart={cart} setCart={setCart} total={cartTotal} buffet={isBuffet} busy={busy} onSubmit={submitOrder} />
      {buffetOpen && tiers && <BuffetStartDialog tiers={tiers} defaultPax={2} busy={busy} onClose={() => setBuffetOpen(false)} onStart={startBuffet} />}
    </main>
  );
}

function BuffetChip({ b }: { b: Buffet }) {
  if (b.expired) return <Badge variant="destructive" className="text-[10px]">หมดเวลา</Badge>;
  return <Badge variant="secondary" className="gap-1 text-[10px]"><Timer className="size-3" /> เหลือ {b.minutes_left} นาที</Badge>;
}

// ── modifier picker (one item) ──
function ModifierPicker({ item, buffet, onClose, onAdd }: { item: MenuItem; buffet: boolean; onClose: () => void; onAdd: (l: CartLine) => void }) {
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
  const unitPrice = useMemo(() => (buffet ? 0 : item.price + optionIds.reduce((a, id) => a + (byId.get(id)?.price_delta ?? 0), 0)), [buffet, item.price, optionIds, byId]);

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
                      {!buffet && o.price_delta > 0 && <span className="text-xs text-muted-foreground tabular">+{baht(o.price_delta)}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button onClick={confirm} disabled={!!missing} className="h-12 w-full justify-between text-base">
            <span>เพิ่มลงตะกร้า</span><span className="tabular">{buffet ? 'บุฟเฟต์' : baht(unitPrice)}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── cart review + submit ──
function CartDialog({ open, onOpenChange, cart, setCart, total, buffet, busy, onSubmit }: {
  open: boolean; onOpenChange: (o: boolean) => void; cart: CartLine[]; setCart: (f: (c: CartLine[]) => CartLine[]) => void; total: number; buffet: boolean; busy: boolean; onSubmit: () => void;
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
                  <p className="text-xs text-muted-foreground tabular">{buffet ? 'บุฟเฟต์' : baht(c.unitPrice)}</p>
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
            <span>ส่งออเดอร์เข้าครัว</span><span className="tabular">{buffet ? 'บุฟเฟต์' : baht(total)}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── buffet tier picker (choose tier + headcount) ──
function BuffetStartDialog({ tiers, defaultPax, busy, onClose, onStart }: {
  tiers: Tier[]; defaultPax: number; busy: boolean; onClose: () => void; onStart: (packageId: number, pax: number) => void;
}) {
  const [pax, setPax] = useState(defaultPax);
  const [sel, setSel] = useState<number | null>(tiers[0]?.id ?? null);
  const tier = tiers.find((t) => t.id === sel);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>เริ่มบุฟเฟต์</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-lg border p-3">
            <span className="text-sm font-medium">จำนวนคน</span>
            <div className="flex items-center gap-2">
              <Button size="icon" variant="outline" className="size-8" onClick={() => setPax((p) => Math.max(1, p - 1))}><Minus className="size-4" /></Button>
              <span className="w-6 text-center text-base tabular">{pax}</span>
              <Button size="icon" variant="outline" className="size-8" onClick={() => setPax((p) => p + 1)}><Plus className="size-4" /></Button>
            </div>
          </div>
          <div className="grid gap-2">
            {tiers.map((t) => (
              <button key={t.id} type="button" onClick={() => setSel(t.id)}
                className={cn('flex items-center justify-between rounded-lg border p-3 text-left transition', t.id === sel ? 'border-primary bg-primary/5' : 'hover:border-primary/40')}>
                <div>
                  <div className="text-sm font-medium">{t.name}</div>
                  <p className="text-xs text-muted-foreground">{t.time_limit_min} นาที{t.overtime_fee_per_pax > 0 ? ` · เกินเวลา +${baht(t.overtime_fee_per_pax)}/ท่าน` : ''}</p>
                </div>
                <span className="text-sm font-semibold tabular">{baht(t.price_per_pax)}/ท่าน</span>
              </button>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => sel && onStart(sel, pax)} disabled={busy || !sel} className="h-12 w-full justify-between text-base">
            <span>เริ่มบุฟเฟต์</span><span className="tabular">{tier ? baht(tier.price_per_pax * pax) : ''}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
