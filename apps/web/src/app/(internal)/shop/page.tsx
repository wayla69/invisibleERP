'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Plus, Minus, X, Zap, ShoppingCart, PackagePlus, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { notifyError, notifySuccess } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { baht } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type CatalogItem = {
  item_id: string; item_description: string | null; uom: string | null;
  unit_price: number; image_key: string | null; category: string; category_key: string;
};
type Category = { key: string; label: string; count: number };
type CatalogResp = { items: CatalogItem[]; categories: Category[]; count: number };
type CartLine = { key: string; item_id: string; description: string; uom: string; unit_price: number; qty: number; urgent: boolean; custom: boolean };

// Friendly "shop" front-end for a purchase requisition (perm: pr_raise). Staff browse the item master
// grouped by product category, drop items into a basket (with an "urgent" flag for priority), can type a
// free-text request for anything not in the register, then check out — which raises ONE PR through the
// ordinary POST /api/procurement/prs path. It is only a request: Procurement reviews it, approves, and
// issues the PO (SoD R03/R04 unchanged). A custom line carries its typed text as the item_id so the buyer
// can reconcile it to a real code (or open a new one) during PR→PO conversion, exactly like the LINE flow.
export default function ShopPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const cat = useQuery<CatalogResp>({ queryKey: ['catalog'], queryFn: () => api('/api/procurement/catalog?limit=1000') });

  const [q, setQ] = useState('');
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [remarks, setRemarks] = useState('');
  const [cName, setCName] = useState('');
  const [cUom, setCUom] = useState('');
  const [cQty, setCQty] = useState(1);
  const [cErr, setCErr] = useState(false);
  const customSeq = useRef(0);

  const items = cat.data?.items ?? [];
  const categories = cat.data?.categories ?? [];

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return items.filter((it) => {
      if (activeCat && it.category_key !== activeCat) return false;
      if (!kw) return true;
      return it.item_id.toLowerCase().includes(kw) || (it.item_description ?? '').toLowerCase().includes(kw);
    });
  }, [items, q, activeCat]);

  // Group the visible items by category so the catalog reads as category sections (easy to scan/find).
  const groups = useMemo(() => {
    const m = new Map<string, { label: string; items: CatalogItem[] }>();
    for (const it of filtered) {
      const g = m.get(it.category_key) ?? { label: it.category, items: [] };
      g.items.push(it); m.set(it.category_key, g);
    }
    return [...m.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => a.label.localeCompare(b.label, 'th'));
  }, [filtered]);

  const cartQty = (itemId: string) => cart.find((l) => l.key === `i:${itemId}`)?.qty ?? 0;

  const addItem = (it: CatalogItem, urgent = false) => setCart((c) => {
    const key = `i:${it.item_id}`;
    const ex = c.find((l) => l.key === key);
    if (ex) return c.map((l) => (l.key === key ? { ...l, qty: l.qty + 1, urgent: l.urgent || urgent } : l));
    return [...c, { key, item_id: it.item_id, description: it.item_description ?? '', uom: it.uom ?? '', unit_price: it.unit_price, qty: 1, urgent, custom: false }];
  });
  const setQty = (key: string, qty: number) => setCart((c) => c.map((l) => (l.key === key ? { ...l, qty: Math.max(1, Math.floor(qty) || 1) } : l)));
  const toggleUrgent = (key: string) => setCart((c) => c.map((l) => (l.key === key ? { ...l, urgent: !l.urgent } : l)));
  const removeLine = (key: string) => setCart((c) => c.filter((l) => l.key !== key));

  const addCustom = () => {
    const name = cName.trim();
    if (!name) { setCErr(true); notifyError(t('shop.custom_need_name')); return; }
    const key = `c:${customSeq.current++}`;
    setCart((c) => [...c, { key, item_id: name.slice(0, 120), description: name, uom: cUom.trim(), unit_price: 0, qty: Math.max(1, Math.floor(cQty) || 1), urgent: false, custom: true }]);
    setCName(''); setCUom(''); setCQty(1); setCErr(false);
  };

  const anyUrgent = cart.some((l) => l.urgent);

  const mut = useMutation({
    mutationFn: () => api<{ pr_no: string; status: string; lines: number }>('/api/procurement/prs', {
      method: 'POST',
      body: JSON.stringify({
        remarks: remarks || undefined,
        priority: anyUrgent ? 'Urgent' : 'Normal',
        items: cart.map((l) => ({
          item_id: l.item_id,
          item_description: l.description || undefined,
          request_qty: l.qty,
          uom: l.uom || undefined,
          reason: l.urgent ? t('shop.urgent') : l.custom ? t('shop.custom_line') : undefined,
        })),
      }),
    }),
    onSuccess: (d) => {
      notifySuccess(t('shop.created', { no: d.pr_no }), t('shop.created_desc', { n: d.lines }));
      setCart([]); setRemarks('');
      qc.invalidateQueries({ queryKey: ['prs'] });
    },
    onError: (e: any) => notifyError(e?.message ?? t('shop.failed')),
  });

  const checkout = () => { if (!cart.length) { notifyError(t('shop.empty_cart_err')); return; } mut.mutate(); };

  return (
    <div>
      <PageHeader
        title={t('shop.title')}
        description={t('shop.desc')}
        actions={<Button asChild variant="outline" size="sm"><Link href="/requisitions">{t('shop.view_prs')}</Link></Button>}
      />

      <div className="grid items-start gap-4 lg:grid-cols-[1fr_360px]">
        {/* ── Catalog ─────────────────────────────────────────────── */}
        <div className="space-y-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('shop.search_ph')} />
          </div>

          {categories.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant={activeCat === null ? 'default' : 'outline'} className="rounded-full" onClick={() => setActiveCat(null)}>
                {t('shop.all_categories')}
              </Button>
              {categories.map((c) => (
                <Button key={c.key} size="sm" variant={activeCat === c.key ? 'default' : 'outline'} className="rounded-full" onClick={() => setActiveCat(activeCat === c.key ? null : c.key)}>
                  {c.label} <span className="ml-1 text-xs opacity-70">{c.count}</span>
                </Button>
              ))}
            </div>
          )}

          <StateView q={cat}>
            {items.length === 0 ? (
              <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{t('shop.empty_catalog')}</p>
            ) : groups.length === 0 ? (
              <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{t('shop.no_items')}</p>
            ) : (
              <div className="space-y-5">
                {groups.map((g) => (
                  <section key={g.key} className="space-y-2">
                    <h3 className="text-sm font-semibold text-muted-foreground">{g.label} <span className="opacity-60">· {g.items.length}</span></h3>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {g.items.map((it) => {
                        const inCart = cartQty(it.item_id);
                        return (
                          <div key={it.item_id} className="flex flex-col gap-2 rounded-xl border bg-card p-3 text-card-foreground shadow-sm">
                            <div className="flex-1">
                              <p className="line-clamp-2 text-sm font-medium leading-snug">{it.item_description || it.item_id}</p>
                              <p className="mt-0.5 text-xs text-muted-foreground">{it.item_id}{it.uom ? ` · ${it.uom}` : ''}</p>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-semibold">{it.unit_price > 0 ? baht(it.unit_price) : ''}</span>
                              {inCart > 0 && <Badge variant="secondary" className="text-[11px]">{t('shop.in_cart')} · {inCart}</Badge>}
                            </div>
                            <div className="flex gap-2">
                              <Button size="sm" className="flex-1" onClick={() => addItem(it)}><Plus className="size-4" /> {t('shop.add')}</Button>
                              <Button size="sm" variant="outline" title={t('shop.add_urgent')} aria-label={t('shop.add_urgent')} onClick={() => addItem(it, true)}>
                                <Zap className="size-4 text-amber-500" />
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </StateView>
        </div>

        {/* ── Basket + custom request (sticky on desktop) ──────────── */}
        <div className="space-y-4 lg:sticky lg:top-4">
          <Card className="gap-3">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShoppingCart className="size-5" /> {t('shop.basket')}
                {cart.length > 0 && <Badge variant="secondary">{t('shop.lines_n', { n: cart.length })}</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {cart.length === 0 ? (
                <div className="rounded-lg border border-dashed p-6 text-center">
                  <p className="text-sm font-medium">{t('shop.basket_empty')}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t('shop.basket_empty_hint')}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {cart.map((l) => (
                    <div key={l.key} className="space-y-2 rounded-lg border p-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{l.description || l.item_id}</p>
                          {l.custom ? (
                            <Badge variant="outline" className="mt-0.5 text-[10px]">{t('shop.custom_line')}</Badge>
                          ) : (
                            <p className="text-xs text-muted-foreground">{l.item_id}{l.uom ? ` · ${l.uom}` : ''}</p>
                          )}
                        </div>
                        <Button size="icon" variant="ghost" className="size-7 shrink-0" aria-label={t('shop.remove')} onClick={() => removeLine(l.key)}>
                          <X className="size-4" />
                        </Button>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1">
                          <Button size="icon" variant="outline" className="size-7" aria-label="-" onClick={() => setQty(l.key, l.qty - 1)}><Minus className="size-3.5" /></Button>
                          <Input type="number" min="1" value={l.qty} onChange={(e) => setQty(l.key, +e.target.value)} className="h-7 w-14 text-center" />
                          <Button size="icon" variant="outline" className="size-7" aria-label="+" onClick={() => setQty(l.key, l.qty + 1)}><Plus className="size-3.5" /></Button>
                        </div>
                        <Button size="sm" variant={l.urgent ? 'destructive' : 'outline'} className="h-7" onClick={() => toggleUrgent(l.key)}>
                          <Zap className="size-3.5" /> {t('shop.urgent')}
                        </Button>
                      </div>
                    </div>
                  ))}
                  {anyUrgent && <p className="text-xs font-medium text-destructive">⚡ {t('shop.has_urgent')}</p>}
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="shop-remarks">{t('shop.remarks')}</Label>
                <textarea
                  id="shop-remarks"
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  placeholder={t('shop.remarks_ph')}
                  className="min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
              </div>

              <Button className="w-full" disabled={mut.isPending || cart.length === 0} onClick={checkout}>
                <Send className="size-4" /> {mut.isPending ? t('shop.checkout_sending') : t('shop.checkout')}
              </Button>
            </CardContent>
          </Card>

          <Card className="gap-3">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><PackagePlus className="size-5" /> {t('shop.custom_title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-xs text-muted-foreground">{t('shop.custom_hint')}</p>
              <Input value={cName} aria-invalid={cErr && !cName.trim()} onChange={(e) => setCName(e.target.value)} placeholder={t('shop.custom_name_ph')} />
              <div className="flex gap-2">
                <Input type="number" min="1" value={cQty} onChange={(e) => setCQty(+e.target.value)} className="w-20" aria-label={t('shop.qty')} />
                <Input value={cUom} onChange={(e) => setCUom(e.target.value)} placeholder={t('shop.custom_uom_ph')} className="w-24" />
                <Button variant="secondary" className="flex-1" onClick={addCustom}><Plus className="size-4" /> {t('shop.custom_add')}</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
