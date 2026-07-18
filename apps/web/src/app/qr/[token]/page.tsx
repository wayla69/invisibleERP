'use client';

import { useEffect, useState, useCallback, useMemo, type ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { CheckCircle2, Clock, Minus, Plus, QrCode, ReceiptText, ShoppingCart, Smartphone, Sparkles, Star, Timer, Utensils } from 'lucide-react';
import { publicApi } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { baht } from '@/lib/format';

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
type MenuItem = { id: number; sku: string; name: string; name_en: string | null; price: number; is_available: boolean; available_now?: boolean; is_recommended?: boolean; description: string | null; image_url?: string | null; has_modifiers: boolean; modifier_groups: Group[] };
type Category = { id: number; code: string; name: string; items: MenuItem[] };
type Menu = { categories: Category[]; uncategorized: MenuItem[]; item_count: number };
type Tier = { id: number; code: string; name: string; name_en: string | null; price_per_pax: number; time_limit_min: number; overtime_fee_per_pax: number };
type CartLine = { key: string; sku: string; name: string; qty: number; unitPrice: number; optionIds: number[]; optionLabels: string[] };

// keyed on the server's kds_status codes (stable), not the Thai display text
const ITEM_COLOR: Record<string, string> = {
  new: 'text-muted-foreground',
  queued: 'text-info',
  preparing: 'text-warning-foreground dark:text-warning',
  ready: 'text-success',
  served: 'text-success',
};


export default function DinerPage() {
  // Global locale context (persisted per device) — the diner's th/en toggle drives the app-wide setting.
  const { lang, setLang, t } = useLang();
  const token = String(useParams().token ?? '');
  const [tab, setTab] = useState<'menu' | 'order'>('order');
  const [st, setSt] = useState<Status | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [tiers, setTiers] = useState<Tier[] | null>(null);
  const [err, setErr] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [catFilter, setCatFilter] = useState<number | 'all' | 'rec'>('all');   // diner menu category filter (0434)
  const [picker, setPicker] = useState<MenuItem | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [buffetOpen, setBuffetOpen] = useState(false);
  const [pay, setPay] = useState<{ payment_no: string; gateway_ref: string; total: number; qr_image: string | null; mock_settle: boolean } | null>(null);
  const [paid, setPaid] = useState(false);
  const [busy, setBusy] = useState(false);
  // show the English name when the diner picks EN (falls back to the Thai name)
  const nm = useCallback((o: { name: string; name_en?: string | null }) => (lang === 'en' ? (o.name_en || o.name) : o.name), [lang]);
  // item status: translate via the stable kds_status code; fall back to the server's Thai label
  const stLabel = useCallback((it: { kds_status: string; status_th: string }) => t(`pub.qr.st_${it.kds_status}`, undefined) === `pub.qr.st_${it.kds_status}` ? it.status_th : t(`pub.qr.st_${it.kds_status}`), [t]);

  const isBuffet = st?.order_mode === 'buffet';
  const hasOrder = !!st?.order;

  const load = useCallback(async () => {
    try { setSt(await publicApi<Status>(`/api/qr/t/${token}`)); setErr(''); }
    catch (e) { setErr(e instanceof Error ? e.message : t('pub.qr.load_failed')); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // one tappable menu card — shared by the recommended row and the per-category lists
  const renderItem = (it: MenuItem) => (
    <button key={it.id} type="button" onClick={() => onItemTap(it)} disabled={!orderable(it)}
      className={cn('flex items-center justify-between rounded-xl border bg-card p-3 text-left transition active:scale-[0.99]', orderable(it) ? 'hover:border-primary/60' : 'opacity-50')}>
      <div className="flex min-w-0 items-center gap-3">
        {it.image_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={it.image_url} alt="" className="size-16 shrink-0 rounded-lg object-cover" />
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            {it.is_recommended && <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" aria-label={t('pub.qr.recommended')} />}
            <span className="truncate">{nm(it)}</span>
            {!it.is_available && <Badge variant="secondary" className="text-[10px]">{t('pub.qr.sold_out')}</Badge>}
            {it.is_available && it.available_now === false && <Badge variant="secondary" className="text-[10px]">{t('pub.qr.not_selling')}</Badge>}
          </div>
          {it.description && <p className="truncate text-xs text-muted-foreground">{it.description}</p>}
        </div>
      </div>
      <div className="ml-3 flex shrink-0 items-center gap-2">
        <span className="text-sm font-semibold tabular">{isBuffet ? <span className="text-primary">{t('pub.qr.buffet')}</span> : baht(it.price)}</span>
        {orderable(it) && <span className="grid size-7 place-items-center rounded-full bg-primary/10 text-primary"><Plus className="size-4" /></span>}
      </div>
    </button>
  );

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

  const doBill = async () => { setBusy(true); setErr(''); try { await publicApi(`/api/qr/t/${token}/bill`, { method: 'POST' }); await load(); } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(false); } };
  const doPay = async () => { setBusy(true); try { setPay(await publicApi(`/api/qr/t/${token}/pay`, { method: 'POST' })); } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(false); } };
  const doConfirm = async () => { if (!pay) return; setBusy(true); try { await publicApi(`/api/qr/t/${token}/confirm`, { method: 'POST', body: JSON.stringify({ payment_no: pay.payment_no }) }); setPaid(true); } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(false); } };

  if (paid)
    return (
      <main className="mx-auto grid min-h-svh max-w-md place-items-center bg-muted/30 p-4">
        <Card className="w-full items-center gap-2 p-8 text-center">
          <CheckCircle2 className="size-14 text-success" />
          <h2 className="text-xl font-semibold">{t('pub.qr.paid_title')}</h2>
          <p className="text-sm text-muted-foreground">{t('pub.qr.paid_thanks')}</p>
        </Card>
      </main>
    );

  const allItems = menu ? [...menu.categories.flatMap((c) => c.items), ...menu.uncategorized] : [];
  const menuCats = menu ? menu.categories.filter((c) => c.items.length).concat(menu.uncategorized.length ? [{ id: 0, code: '_', name: t('pub.qr.cat_other'), items: menu.uncategorized }] : []) : [];
  const recommended = allItems.filter((it) => it.is_recommended && orderable(it));
  const shownCats = catFilter === 'all' ? menuCats : catFilter === 'rec' ? [] : menuCats.filter((c) => c.id === catFilter);
  const dishes = st?.order?.items.filter((i) => !i.charge) ?? [];
  const chargeLines = st?.order?.items.filter((i) => i.charge) ?? [];
  const canStartBuffet = !isBuffet && !hasOrder && (tiers?.length ?? 0) > 0;

  return (
    <main className="mx-auto min-h-svh max-w-md bg-muted/30 p-4 pb-24">
      <div className="mb-4 flex items-center gap-2">
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Utensils className="size-5" />
        </div>
        <h2 className="text-lg font-semibold">{t('pub.qr.table')} {st?.table_no ?? '…'}</h2>
        {isBuffet && st?.buffet && <BuffetChip b={st.buffet} />}
        <button type="button" onClick={() => setLang(lang === 'th' ? 'en' : 'th')}
          className="ml-auto rounded-md border px-2 py-1 text-xs font-semibold uppercase" aria-label="language">
          {lang === 'th' ? 'EN' : 'ไทย'}
        </button>
      </div>
      {err && <p className="mb-3 text-sm text-destructive">{err}</p>}

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'menu' | 'order')}>
        <TabsList className="mb-3 grid w-full grid-cols-2">
          <TabsTrigger value="menu"><Utensils className="mr-1.5 size-4" /> {t('pub.qr.tab_menu')}</TabsTrigger>
          <TabsTrigger value="order"><ReceiptText className="mr-1.5 size-4" /> {t('pub.qr.tab_order')}</TabsTrigger>
        </TabsList>

        {/* ── เมนู ── */}
        <TabsContent value="menu">
          {canStartBuffet && (
            <Card className="mb-4 gap-2 border-primary/40 bg-primary/5 p-4">
              <strong className="text-sm">{t('pub.qr.buffet_pick_title')}</strong>
              <p className="text-xs text-muted-foreground">{t('pub.qr.buffet_pick_desc')}</p>
              <Button onClick={() => setBuffetOpen(true)} className="mt-1 h-11 w-full"><Timer className="size-4" /> {t('pub.qr.buffet_start')}</Button>
            </Card>
          )}
          {isBuffet && st?.buffet && (
            <Card className="mb-4 gap-1 border-primary/40 bg-primary/5 p-3 text-sm">
              <div className="flex items-center justify-between">
                <strong>{st.buffet.package_name} · {t('pub.qr.pax_n', { n: st.buffet.pax ?? 0 })}</strong>
                <BuffetChip b={st.buffet} />
              </div>
              <p className="text-xs text-muted-foreground">{t('pub.qr.buffet_note')}</p>
            </Card>
          )}
          {!menu ? (
            <p className="text-sm text-muted-foreground">{t('pub.qr.menu_loading')}</p>
          ) : allItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('pub.qr.menu_empty')}</p>
          ) : (
            <>
              {/* category filter — sticky chip bar, horizontally scrollable on the phone */}
              {(menuCats.length > 1 || recommended.length > 0) && (
                <div className="sticky top-0 z-10 -mx-4 mb-3 flex gap-2 overflow-x-auto bg-muted/30 px-4 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  <FilterChip active={catFilter === 'all'} onClick={() => setCatFilter('all')}>{t('pub.qr.cat_all')}</FilterChip>
                  {recommended.length > 0 && (
                    <FilterChip active={catFilter === 'rec'} onClick={() => setCatFilter('rec')}>
                      <Star className="size-3.5 fill-current" /> {t('pub.qr.recommended')}
                    </FilterChip>
                  )}
                  {menuCats.map((c) => (
                    <FilterChip key={c.id} active={catFilter === c.id} onClick={() => setCatFilter(c.id)}>{c.name}</FilterChip>
                  ))}
                </div>
              )}

              {/* recommended row — surfaced first when viewing all, or as the sole list when filtered to it */}
              {recommended.length > 0 && (catFilter === 'all' || catFilter === 'rec') && (
                <section className="mb-4">
                  <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-amber-600 dark:text-amber-400">
                    <Sparkles className="size-4" /> {t('pub.qr.recommended_section')}
                  </h3>
                  <div className="grid gap-2">{recommended.map(renderItem)}</div>
                </section>
              )}

              {shownCats.map((c) => (
                <section key={c.id} className="mb-4">
                  <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{c.name}</h3>
                  <div className="grid gap-2">{c.items.map(renderItem)}</div>
                </section>
              ))}
            </>
          )}
        </TabsContent>

        {/* ── ออเดอร์ของฉัน ── */}
        <TabsContent value="order">
          {st?.order ? (
            <>
              <Card className="mb-3 gap-3 p-4">
                <div className="flex items-center justify-between">
                  <strong className="text-sm">{t('pub.qr.order_status')}</strong>
                  <span className="text-xs text-muted-foreground">
                    {st.order.waited_min > 0 ? t('pub.qr.waited', { n: st.order.waited_min }) : t('pub.qr.just_ordered')}
                  </span>
                </div>
                {st.order.ready_in_min > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-warning-foreground dark:text-warning">
                    <Clock className="size-4" /> {t('pub.qr.ready_in', { n: st.order.ready_in_min })}
                  </div>
                )}
                {dishes.length === 0 && <p className="text-sm text-muted-foreground">{t('pub.qr.no_dishes')}</p>}
                <div className="divide-y">
                  {dishes.map((it) => (
                    <div key={it.item_id} className="flex items-center justify-between py-1.5">
                      <span className="text-sm">{it.qty}× {it.name}</span>
                      <span className={cn('text-xs font-semibold', ITEM_COLOR[it.kds_status] ?? 'text-muted-foreground')}>
                        {stLabel(it)}
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
                  <div className="flex justify-between text-muted-foreground"><span>{t('pub.qr.subtotal')}</span><span className="tabular">{baht(st.bill.subtotal)}</span></div>
                  <div className="flex justify-between text-muted-foreground"><span>VAT 7%</span><span className="tabular">{baht(st.bill.vat)}</span></div>
                  <div className="mt-1 flex justify-between border-t pt-2 text-lg font-bold text-primary"><span>{t('pub.qr.grand_total')}</span><span className="tabular">{baht(st.bill.total)}</span></div>
                </Card>
              )}

              {!pay && (
                <>
                  {st.session_status === 'open' && (
                    <Button onClick={doBill} disabled={busy} variant="outline" className="h-12 w-full text-base">
                      <ReceiptText className="size-5" /> {t('pub.qr.request_bill')}
                    </Button>
                  )}
                  {st.session_status === 'bill_requested' && (
                    <Button onClick={doPay} disabled={busy} className="h-12 w-full text-base">
                      <Smartphone className="size-5" /> {t('pub.qr.pay_promptpay')}
                    </Button>
                  )}
                </>
              )}
              {pay && (
                <Card className="items-center gap-3 p-5 text-center">
                  <div className="font-medium">{t('pub.qr.scan_to_pay', { amt: baht(pay.total) })}</div>
                  {pay.qr_image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={pay.qr_image} alt="PromptPay QR" className="size-48 rounded-xl border bg-white p-2" />
                  ) : (
                    <div className="grid size-44 place-items-center gap-1 rounded-xl border-2 border-dashed border-primary/60 p-2 text-xs text-muted-foreground">
                      <QrCode className="size-10 text-primary/70" />
                      PromptPay QR<br />({pay.gateway_ref})
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">{t('pub.qr.scan_hint')}</p>
                  {pay.mock_settle ? (
                    <Button onClick={doConfirm} disabled={busy} className="h-12 w-full bg-success text-base text-success-foreground hover:bg-success/90">
                      {t('pub.qr.confirm_mock')}
                    </Button>
                  ) : (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Clock className="size-4" /> {t('pub.qr.waiting_confirm')}</p>
                  )}
                </Card>
              )}
            </>
          ) : (
            <div className="grid place-items-center gap-3 py-10 text-center">
              <p className="text-sm text-muted-foreground">{t('pub.qr.no_order')}</p>
              <Button onClick={() => setTab('menu')} variant="outline"><Utensils className="size-4" /> {t('pub.qr.open_menu')}</Button>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* ── floating cart bar ── */}
      {cartCount > 0 && (
        <div className="fixed inset-x-0 bottom-0 mx-auto max-w-md p-4">
          <Button onClick={() => setCartOpen(true)} className="h-14 w-full justify-between text-base shadow-lg">
            <span className="flex items-center gap-2"><ShoppingCart className="size-5" /> {t('pub.qr.cart')} ({cartCount})</span>
            <span className="tabular">{isBuffet ? t('pub.qr.buffet') : baht(cartTotal)}</span>
          </Button>
        </div>
      )}

      {picker && <ModifierPicker item={picker} buffet={isBuffet} onClose={() => setPicker(null)} onAdd={(line) => { addToCart(line); setPicker(null); }} />}
      <CartDialog open={cartOpen} onOpenChange={setCartOpen} cart={cart} setCart={setCart} total={cartTotal} buffet={isBuffet} busy={busy} onSubmit={submitOrder} />
      {buffetOpen && tiers && <BuffetStartDialog tiers={tiers} defaultPax={2} busy={busy} onClose={() => setBuffetOpen(false)} onStart={startBuffet} />}
    </main>
  );
}

// diner menu category filter chip
function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={cn('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm font-medium transition', active ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:border-primary/50')}>
      {children}
    </button>
  );
}

function BuffetChip({ b }: { b: Buffet }) {
  const { t } = useLang();
  if (b.expired) return <Badge variant="destructive" className="text-[10px]">{t('pub.qr.expired')}</Badge>;
  return <Badge variant="secondary" className="gap-1 text-[10px]"><Timer className="size-3" /> {t('pub.qr.mins_left', { n: b.minutes_left ?? 0 })}</Badge>;
}

// ── modifier picker (one item) ──
function ModifierPicker({ item, buffet, onClose, onAdd }: { item: MenuItem; buffet: boolean; onClose: () => void; onAdd: (l: CartLine) => void }) {
  const { t } = useLang();
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
                {g.required ? <Badge variant="destructive" className="text-[10px]">{t('pub.qr.required')}</Badge> : <span className="text-xs text-muted-foreground">{t('pub.qr.max_select', { n: g.max_select })}</span>}
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
            <span>{t('pub.qr.add_to_cart')}</span><span className="tabular">{buffet ? t('pub.qr.buffet') : baht(unitPrice)}</span>
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
  const { t } = useLang();
  const setQty = (key: string, delta: number) =>
    setCart((cur) => cur.flatMap((c) => (c.key === key ? (c.qty + delta <= 0 ? [] : [{ ...c, qty: c.qty + delta }]) : [c])));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t('pub.qr.my_cart')}</DialogTitle></DialogHeader>
        {cart.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('pub.qr.cart_empty')}</p>
        ) : (
          <div className="max-h-[55svh] space-y-3 overflow-y-auto">
            {cart.map((c) => (
              <div key={c.key} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{c.name}</div>
                  {c.optionLabels.length > 0 && <p className="text-xs text-muted-foreground">{c.optionLabels.join(' · ')}</p>}
                  <p className="text-xs text-muted-foreground tabular">{buffet ? t('pub.qr.buffet') : baht(c.unitPrice)}</p>
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
            <span>{t('pub.qr.send_order')}</span><span className="tabular">{buffet ? t('pub.qr.buffet') : baht(total)}</span>
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
  const { t } = useLang();
  const [pax, setPax] = useState(defaultPax);
  const [sel, setSel] = useState<number | null>(tiers[0]?.id ?? null);
  const tier = tiers.find((x) => x.id === sel);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t('pub.qr.buffet_start')}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-lg border p-3">
            <span className="text-sm font-medium">{t('pub.qr.pax_label')}</span>
            <div className="flex items-center gap-2">
              <Button size="icon" variant="outline" className="size-8" onClick={() => setPax((p) => Math.max(1, p - 1))}><Minus className="size-4" /></Button>
              <span className="w-6 text-center text-base tabular">{pax}</span>
              <Button size="icon" variant="outline" className="size-8" onClick={() => setPax((p) => p + 1)}><Plus className="size-4" /></Button>
            </div>
          </div>
          <div className="grid gap-2">
            {tiers.map((x) => (
              <button key={x.id} type="button" onClick={() => setSel(x.id)}
                className={cn('flex items-center justify-between rounded-lg border p-3 text-left transition', x.id === sel ? 'border-primary bg-primary/5' : 'hover:border-primary/40')}>
                <div>
                  <div className="text-sm font-medium">{x.name}</div>
                  <p className="text-xs text-muted-foreground">{t('pub.qr.tier_mins', { n: x.time_limit_min })}{x.overtime_fee_per_pax > 0 ? t('pub.qr.overtime', { amt: baht(x.overtime_fee_per_pax) }) : ''}</p>
                </div>
                <span className="text-sm font-semibold tabular">{t('pub.qr.per_pax', { amt: baht(x.price_per_pax) })}</span>
              </button>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => sel && onStart(sel, pax)} disabled={busy || !sel} className="h-12 w-full justify-between text-base">
            <span>{t('pub.qr.buffet_start')}</span><span className="tabular">{tier ? baht(tier.price_per_pax * pax) : ''}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
