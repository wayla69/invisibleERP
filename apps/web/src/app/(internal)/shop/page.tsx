'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Plus, Minus, X, Zap, ShoppingCart, PackagePlus, Send, Layers, LayoutGrid, List as ListIcon, ImageOff, ClipboardList } from 'lucide-react';
import { api } from '@/lib/api';
import { useMe, hasPerm } from '@/lib/auth';
import { notifyError, notifySuccess } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { baht, num, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { statusVariant } from '@/components/ui';
import { cn } from '@/lib/utils';

type CatalogItem = {
  item_id: string; item_description: string | null; uom: string | null;
  unit_price: number; image_key: string | null; category: string; category_key: string;
  on_hand: number | null; last_price: number | null;
};
type Category = { key: string; label: string; count: number };
type CatalogPage = { items: CatalogItem[]; categories: Category[]; total: number; offset: number; limit: number; has_more: boolean; count: number };
type CartLine = { key: string; item_id: string; description: string; uom: string; unit_price: number; qty: number; urgent: boolean; custom: boolean };
type MyPr = { pr_no: string; pr_date: string | null; status: string; priority: string | null; lines: { item_id: string; request_qty: number }[] };

const PAGE = 24;
const VIEW_KEY = 'shop.view';
const CART_KEY = 'shop.cart';

// Rehydrate the basket saved on this device so an in-progress requisition survives a refresh / navigation.
function readCart(): CartLine[] {
  if (typeof window === 'undefined') return [];
  try {
    const arr = JSON.parse(window.localStorage.getItem(CART_KEY) ?? '[]');
    return Array.isArray(arr) ? arr.filter((l) => l && typeof l.key === 'string' && typeof l.item_id === 'string') : [];
  } catch { return []; }
}

// A stable pastel background for an item's placeholder tile (Shopee/Grab-style colourful grid) — derived
// from the item id so the same product always gets the same hue, no image needed.
function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

// Lazy product thumbnail. Only fetches the in-DB image when the item actually has one (image_key set);
// otherwise renders a coloured initial tile. react-query caches so a re-render never re-fetches.
function ProductThumb({ item, className }: { item: CatalogItem; className?: string }) {
  const hasImg = !!item.image_key;
  const img = useQuery<{ data_url: string }>({
    queryKey: ['catalog-img', item.item_id],
    queryFn: () => api(`/api/procurement/catalog/items/${encodeURIComponent(item.item_id)}/image`),
    enabled: hasImg,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const label = (item.item_description || item.item_id).trim();
  if (hasImg && img.data?.data_url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={img.data.data_url} alt={label} loading="lazy" className={cn('object-cover', className)} />;
  }
  const h = hueFor(item.item_id);
  return (
    <div
      className={cn('flex items-center justify-center', className)}
      style={{ background: `hsl(${h} 70% 92%)`, color: `hsl(${h} 45% 40%)` }}
      aria-hidden
    >
      {hasImg && !img.isError ? (
        <span className="size-6 animate-pulse rounded-full bg-black/10 dark:bg-white/10" />
      ) : label ? (
        <span className="text-2xl font-semibold">{label.slice(0, 1).toUpperCase()}</span>
      ) : (
        <ImageOff className="size-6 opacity-50" />
      )}
    </div>
  );
}

// Friendly "shop" front-end for a purchase requisition (perm: pr_raise). Staff browse the item master in a
// Grab/Shopee-style grid/list (category chips + infinite scroll), drop items into a basket (with an "urgent"
// flag for priority), can type a free-text request for anything not in the register, then check out — which
// raises ONE PR through the ordinary POST /api/procurement/prs path. It is only a request: Procurement
// reviews it, approves, and issues the PO (SoD R03/R04 unchanged). A custom line carries its typed text as
// the item_id so the buyer can reconcile it to a real code during PR→PO conversion, exactly like LINE.
export default function ShopPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const me = useMe();
  // Master-data holders (md_item) can jump straight to the category admin to (re)group the catalog.
  const canManageCategories = hasPerm(me.data, 'md_item', 'masterdata', 'exec');
  // The requester's own recent PRs (raised here or elsewhere) with live status — closes the loop on-screen.
  const myPrs = useQuery<{ prs: MyPr[] }>({ queryKey: ['my-prs'], queryFn: () => api('/api/procurement/prs?mine=true&limit=5'), refetchInterval: 30_000 });

  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [view, setView] = useState<'grid' | 'list'>(() =>
    (typeof window !== 'undefined' && window.localStorage.getItem(VIEW_KEY) === 'list') ? 'list' : 'grid');
  const [cart, setCart] = useState<CartLine[]>(readCart);
  const [remarks, setRemarks] = useState('');
  const [projectCode, setProjectCode] = useState('');
  const [requiredDate, setRequiredDate] = useState('');
  const [cName, setCName] = useState('');
  const [cUom, setCUom] = useState('');
  const [cQty, setCQty] = useState(1);
  const [cErr, setCErr] = useState(false);
  // Seed the custom-line counter past any rehydrated custom keys so new free-text lines never collide.
  const customSeq = useRef(cart.reduce((m, l) => (l.key.startsWith('c:') ? Math.max(m, Number(l.key.slice(2)) + 1) : m), 0));
  const sentinel = useRef<HTMLDivElement | null>(null);

  useEffect(() => { try { window.localStorage.setItem(VIEW_KEY, view); } catch { /* private mode */ } }, [view]);
  // Persist the basket on this device (per-device by design — a PR is company-wide but a half-built basket
  // is personal). Cleared on checkout via setCart([]).
  useEffect(() => {
    try {
      if (cart.length) window.localStorage.setItem(CART_KEY, JSON.stringify(cart));
      else window.localStorage.removeItem(CART_KEY);
    } catch { /* private mode */ }
  }, [cart]);
  // Debounce the search box so typing doesn't fire a request per keystroke.
  useEffect(() => { const id = setTimeout(() => setDebouncedQ(q.trim()), 250); return () => clearTimeout(id); }, [q]);

  const catalog = useInfiniteQuery({
    queryKey: ['catalog', debouncedQ, activeCat],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: String(PAGE), offset: String(pageParam) });
      if (debouncedQ) p.set('q', debouncedQ);
      if (activeCat) p.set('category', activeCat);
      return api<CatalogPage>(`/api/procurement/catalog?${p.toString()}`);
    },
    getNextPageParam: (last, all) => (last.has_more ? all.reduce((a, pg) => a + pg.items.length, 0) : undefined),
  });

  const pages = catalog.data?.pages ?? [];
  const items = useMemo(() => pages.flatMap((p) => p.items), [pages]);
  const categories = pages[0]?.categories ?? [];
  const total = pages[0]?.total ?? 0;

  // Auto-load the next page when the sentinel scrolls into view (infinite scroll, no pager buttons).
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && catalog.hasNextPage && !catalog.isFetchingNextPage) catalog.fetchNextPage();
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [catalog.hasNextPage, catalog.isFetchingNextPage, catalog.fetchNextPage, items.length]);

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
        project_code: projectCode.trim() || undefined,
        items: cart.map((l) => ({
          item_id: l.item_id,
          item_description: l.description || undefined,
          request_qty: l.qty,
          uom: l.uom || undefined,
          required_date: requiredDate || undefined,
          reason: l.urgent ? t('shop.urgent') : l.custom ? t('shop.custom_line') : undefined,
        })),
      }),
    }),
    onSuccess: (d) => {
      notifySuccess(t('shop.created', { no: d.pr_no }), t('shop.created_desc', { n: d.lines }));
      setCart([]); setRemarks(''); setProjectCode(''); setRequiredDate('');
      qc.invalidateQueries({ queryKey: ['prs'] });
      qc.invalidateQueries({ queryKey: ['my-prs'] });
    },
    onError: (e: any) => notifyError(e?.message ?? t('shop.failed')),
  });

  const checkout = () => { if (!cart.length) { notifyError(t('shop.empty_cart_err')); return; } mut.mutate(); };

  const catChip = (key: string | null, label: string, count?: number) => (
    <button
      key={key ?? '__all__'}
      type="button"
      onClick={() => setActiveCat(key)}
      className={cn(
        'whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition-colors',
        activeCat === key ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-accent',
      )}
    >
      {label}{typeof count === 'number' ? <span className="ml-1 text-xs opacity-70">{count}</span> : null}
    </button>
  );

  return (
    <div>
      <PageHeader
        title={t('shop.title')}
        description={t('shop.desc')}
        actions={
          <>
            {canManageCategories && (
              <Button asChild variant="outline" size="sm">
                <Link href="/setup/item-categories"><Layers className="size-4" /> {t('shop.manage_categories')}</Link>
              </Button>
            )}
            <Button asChild variant="outline" size="sm"><Link href="/requisitions">{t('shop.view_prs')}</Link></Button>
          </>
        }
      />

      <div className="grid items-start gap-4 lg:grid-cols-[1fr_360px]">
        {/* ── Catalog ─────────────────────────────────────────────── */}
        <div className="space-y-3">
          {/* Search + view toggle */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('shop.search_ph')} />
            </div>
            <div className="flex shrink-0 rounded-md border p-0.5">
              <Button size="icon" variant={view === 'grid' ? 'secondary' : 'ghost'} className="size-8" aria-label={t('shop.view_grid')} title={t('shop.view_grid')} onClick={() => setView('grid')}>
                <LayoutGrid className="size-4" />
              </Button>
              <Button size="icon" variant={view === 'list' ? 'secondary' : 'ghost'} className="size-8" aria-label={t('shop.view_list')} title={t('shop.view_list')} onClick={() => setView('list')}>
                <ListIcon className="size-4" />
              </Button>
            </div>
          </div>

          {/* Category chips (horizontal scroll, Shopee-style) */}
          {categories.length > 0 && (
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
              {catChip(null, t('shop.all_categories'), total)}
              {categories.map((c) => catChip(c.key, c.label, c.count))}
            </div>
          )}

          {total > 0 && <p className="text-xs text-muted-foreground">{t('shop.results_n', { n: total })}</p>}

          <StateView q={{ isLoading: catalog.isLoading, error: catalog.error }}>
            {items.length === 0 ? (
              <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                {debouncedQ || activeCat ? t('shop.no_items') : t('shop.empty_catalog')}
              </p>
            ) : view === 'grid' ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                {items.map((it) => {
                  const inCart = cartQty(it.item_id);
                  return (
                    <div key={it.item_id} className="group flex flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm transition-shadow hover:shadow-md">
                      <div className="relative aspect-square w-full overflow-hidden bg-muted">
                        <ProductThumb item={it} className="size-full" />
                        <button
                          type="button"
                          aria-label={t('shop.add_urgent')}
                          title={t('shop.add_urgent')}
                          onClick={() => addItem(it, true)}
                          className="absolute right-1.5 top-1.5 grid size-8 place-items-center rounded-full bg-background/85 text-amber-500 shadow-sm backdrop-blur transition hover:bg-background"
                        >
                          <Zap className="size-4" />
                        </button>
                        {inCart > 0 && <Badge className="absolute left-1.5 top-1.5">{inCart}</Badge>}
                      </div>
                      <div className="flex flex-1 flex-col gap-1 p-2.5">
                        <p className="line-clamp-2 text-sm font-medium leading-snug">{it.item_description || it.item_id}</p>
                        <p className="text-xs text-muted-foreground">{it.item_id}{it.uom ? ` · ${it.uom}` : ''}</p>
                        <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                          {it.on_hand != null && (
                            <span className={it.on_hand <= 0 ? 'font-medium text-destructive' : ''}>
                              {it.on_hand > 0 ? t('shop.on_hand', { n: num(it.on_hand) }) : t('shop.out_of_stock')}
                            </span>
                          )}
                          {it.last_price != null && it.last_price > 0 && <span>{t('shop.last_price', { price: baht(it.last_price) })}</span>}
                        </div>
                        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                          <span className="text-sm font-semibold">{it.unit_price > 0 ? baht(it.unit_price) : ''}</span>
                          <Button size="sm" className="h-8 gap-1 px-2.5" onClick={() => addItem(it)}><Plus className="size-4" /> {t('shop.add')}</Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="divide-y rounded-xl border">
                {items.map((it) => {
                  const inCart = cartQty(it.item_id);
                  return (
                    <div key={it.item_id} className="flex items-center gap-3 p-2.5">
                      <ProductThumb item={it} className="size-14 shrink-0 rounded-lg" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{it.item_description || it.item_id}</p>
                        <p className="text-xs text-muted-foreground">{it.item_id}{it.uom ? ` · ${it.uom}` : ''}</p>
                        <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                          {it.on_hand != null && (
                            <span className={it.on_hand <= 0 ? 'font-medium text-destructive' : ''}>
                              {it.on_hand > 0 ? t('shop.on_hand', { n: num(it.on_hand) }) : t('shop.out_of_stock')}
                            </span>
                          )}
                          {it.last_price != null && it.last_price > 0 && <span>{t('shop.last_price', { price: baht(it.last_price) })}</span>}
                        </div>
                        {it.unit_price > 0 && <p className="text-sm font-semibold">{baht(it.unit_price)}</p>}
                      </div>
                      {inCart > 0 && <Badge variant="secondary" className="shrink-0">{t('shop.in_cart')} · {inCart}</Badge>}
                      <Button size="sm" variant="outline" className="shrink-0" title={t('shop.add_urgent')} aria-label={t('shop.add_urgent')} onClick={() => addItem(it, true)}>
                        <Zap className="size-4 text-amber-500" />
                      </Button>
                      <Button size="sm" className="shrink-0" onClick={() => addItem(it)}><Plus className="size-4" /> {t('shop.add')}</Button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Infinite-scroll sentinel + loading state */}
            <div ref={sentinel} className="h-8" />
            {catalog.isFetchingNextPage && <p className="py-2 text-center text-xs text-muted-foreground">{t('shop.loading_more')}</p>}
          </StateView>
        </div>

        {/* ── Basket + custom request (sticky on desktop) ──────────── */}
        <div id="shop-basket" className="scroll-mt-4 space-y-4 lg:sticky lg:top-4">
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

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="shop-project">{t('shop.project_code')}</Label>
                  <Input id="shop-project" value={projectCode} onChange={(e) => setProjectCode(e.target.value)} placeholder={t('shop.project_code_ph')} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="shop-needby">{t('shop.required_date')}</Label>
                  <Input id="shop-needby" type="date" value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} />
                </div>
              </div>

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

          <Card className="gap-3">
            <CardHeader className="flex-row items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base"><ClipboardList className="size-5" /> {t('shop.my_prs_title')}</CardTitle>
              <Button asChild variant="ghost" size="sm" className="h-7"><Link href="/requisitions">{t('shop.view_all')}</Link></Button>
            </CardHeader>
            <CardContent>
              <StateView q={myPrs} skeleton={<div className="h-16 animate-pulse rounded-lg bg-muted" />}>
                {(myPrs.data?.prs ?? []).length === 0 ? (
                  <p className="py-2 text-center text-xs text-muted-foreground">{t('shop.my_prs_empty')}</p>
                ) : (
                  <ul className="divide-y">
                    {(myPrs.data?.prs ?? []).map((pr) => (
                      <li key={pr.pr_no}>
                        <Link href="/requisitions" className="flex items-center justify-between gap-2 py-2 hover:opacity-80">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{pr.pr_no}</p>
                            <p className="text-xs text-muted-foreground">{thaiDate(pr.pr_date)} · {t('shop.lines_n', { n: pr.lines?.length ?? 0 })}</p>
                          </div>
                          <Badge variant={statusVariant(pr.status)} className="shrink-0">{pr.status}</Badge>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </StateView>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Mobile-only floating cart — jumps down to the basket (which stacks below the catalog on phones). */}
      {cart.length > 0 && (
        <button
          type="button"
          onClick={() => document.getElementById('shop-basket')?.scrollIntoView({ behavior: 'smooth' })}
          aria-label={t('shop.view_cart')}
          className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-primary px-4 py-3 text-primary-foreground shadow-lg transition-transform active:scale-95 lg:hidden"
        >
          <ShoppingCart className="size-5" />
          <span className="text-sm font-semibold">{t('shop.lines_n', { n: cart.length })}</span>
        </button>
      )}
    </div>
  );
}
