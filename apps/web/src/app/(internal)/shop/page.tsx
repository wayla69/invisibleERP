'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Plus, Minus, X, Zap, ShoppingCart, PackagePlus, Send, Layers, LayoutGrid, List as ListIcon, ImageOff, ClipboardList, Star, RefreshCw, AlertTriangle, ChevronDown, Bookmark, Trash2, ScanLine } from 'lucide-react';
import { api } from '@/lib/api';
import { useMe, hasPerm } from '@/lib/auth';
import { notifyError, notifySuccess, notifyInfo } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { baht, num, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
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
type MyPr = { pr_no: string; pr_date: string | null; status: string; priority: string | null; lines: { item_id: string; request_qty: number; uom?: string | null }[] };
type LowItem = { item_id: string; item_description: string | null; uom: string | null; on_hand: number; min_stock: number; suggested_qty: number; unit_price: number };
type BasketTemplate = { name: string; lines: { item_id: string; description: string; uom: string; qty: number }[] };

const PAGE = 24;
const VIEW_KEY = 'shop.view';
const CART_KEY = 'shop.cart';
const FAVS_KEY = 'shop.favs';
const TPL_KEY = 'shop.templates';

// Saved basket templates (a per-device "รายการประจำ" to reload a recurring set of items).
function readTemplates(): BasketTemplate[] {
  if (typeof window === 'undefined') return [];
  try {
    const arr = JSON.parse(window.localStorage.getItem(TPL_KEY) ?? '[]');
    return Array.isArray(arr) ? arr.filter((tp) => tp && typeof tp.name === 'string' && Array.isArray(tp.lines)) : [];
  } catch { return []; }
}

// Rehydrate the basket saved on this device so an in-progress requisition survives a refresh / navigation.
function readCart(): CartLine[] {
  if (typeof window === 'undefined') return [];
  try {
    const arr = JSON.parse(window.localStorage.getItem(CART_KEY) ?? '[]');
    return Array.isArray(arr) ? arr.filter((l) => l && typeof l.key === 'string' && typeof l.item_id === 'string') : [];
  } catch { return []; }
}

// Favourite item ids saved on this device (a per-device convenience, like the basket).
function readFavs(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const arr = JSON.parse(window.localStorage.getItem(FAVS_KEY) ?? '[]');
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
  } catch { return new Set(); }
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
  const router = useRouter();
  const me = useMe();
  // Master-data holders (md_item) can jump straight to the category admin to (re)group the catalog.
  const canManageCategories = hasPerm(me.data, 'md_item', 'masterdata', 'exec');
  // The requester's own recent PRs (raised here or elsewhere) with live status — closes the loop on-screen.
  const myPrs = useQuery<{ prs: MyPr[] }>({ queryKey: ['my-prs'], queryFn: () => api('/api/procurement/prs?mine=true&limit=5'), refetchInterval: 30_000 });
  // Items at/below their reorder point — a quick "top up the low stock" shortcut into the basket.
  const lowStock = useQuery<{ items: LowItem[]; count: number }>({ queryKey: ['low-stock'], queryFn: () => api('/api/procurement/low-stock?limit=20'), refetchInterval: 60_000 });
  // Projects the requester can shop INTO (those with an approved BoQ budget) — picking one opens the
  // budget-restricted project shop (raises a PMR against the BoQ, PROJ-12/13). Empty ⇒ the picker hides.
  const shopProjects = useQuery<{ projects: { code: string; name: string; status: string }[]; count: number }>({ queryKey: ['pmr-shop-projects'], queryFn: () => api('/api/pmr/projects') });

  const [q, setQ] = useState('');
  const [scan, setScan] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [view, setView] = useState<'grid' | 'list'>(() =>
    (typeof window !== 'undefined' && window.localStorage.getItem(VIEW_KEY) === 'list') ? 'list' : 'grid');
  const [cart, setCart] = useState<CartLine[]>(readCart);
  const [favs, setFavs] = useState<Set<string>>(readFavs);
  const [favOnly, setFavOnly] = useState(false);
  const [showLow, setShowLow] = useState(false);
  const [templates, setTemplates] = useState<BasketTemplate[]>(readTemplates);
  const [tplName, setTplName] = useState('');
  const [remarks, setRemarks] = useState('');
  // Basket bottom sheet (phones/tablets, below `xl`) — the floating basket button opens this instead of
  // scrolling to a sidebar, so checkout is reachable instantly regardless of how far down the catalog
  // scroll has gone (the catalog loads more items as you scroll, so "scroll to the basket" could be far).
  const [basketOpen, setBasketOpen] = useState(false);
  const [projectCode, setProjectCode] = useState('');
  const [requiredDate, setRequiredDate] = useState('');
  const [cName, setCName] = useState('');
  const [cUom, setCUom] = useState('');
  const [cQty, setCQty] = useState(1);
  const [cErr, setCErr] = useState(false);
  // Seed the custom-line counter past any rehydrated custom keys so new free-text lines never collide.
  const customSeq = useRef(cart.reduce((m, l) => (l.key.startsWith('c:') ? Math.max(m, Number(l.key.slice(2)) + 1) : m), 0));
  const sentinel = useRef<HTMLDivElement | null>(null);

  // Cross-device sync for favourites + basket templates (like the sidebar ★ pins). localStorage stays as the
  // instant/offline cache; GET/PUT /api/user-prefs is the shared source of truth once loaded. On first load
  // we UNION the server copy with whatever this device already had (so migrating loses nothing) and push the
  // union up. PUTs are debounced + accumulated so a burst of toggles becomes one write carrying both keys.
  const prefs = useQuery<{ shop_favs?: string[]; shop_templates?: BasketTemplate[] }>({ queryKey: ['user-prefs'], queryFn: () => api('/api/user-prefs') });
  const synced = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSave = useRef<{ shop_favs?: string[]; shop_templates?: BasketTemplate[] }>({});
  const queueSave = (body: { shop_favs?: string[]; shop_templates?: BasketTemplate[] }) => {
    Object.assign(pendingSave.current, body);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const b = pendingSave.current; pendingSave.current = {};
      api('/api/user-prefs', { method: 'PUT', body: JSON.stringify(b) }).catch(() => { /* offline: localStorage still holds it */ });
    }, 600);
  };
  useEffect(() => {
    if (synced.current) return;
    if (prefs.isError) { synced.current = true; return; }   // offline: keep local, allow future edits to try saving
    if (!prefs.data) return;
    synced.current = true;
    const srvFavs = Array.isArray(prefs.data.shop_favs) ? prefs.data.shop_favs : [];
    const srvTpls = Array.isArray(prefs.data.shop_templates) ? prefs.data.shop_templates : [];
    setFavs((local) => new Set([...local, ...srvFavs]));
    setTemplates((local) => {
      const byName = new Map<string, BasketTemplate>();
      for (const tp of srvTpls) byName.set(tp.name, tp);                    // server copy first…
      for (const tp of local) if (!byName.has(tp.name)) byName.set(tp.name, tp); // …then keep local-only names
      return [...byName.values()];
    });
  }, [prefs.data, prefs.isError]);

  useEffect(() => { try { window.localStorage.setItem(VIEW_KEY, view); } catch { /* private mode */ } }, [view]);
  // Persist the basket on this device (per-device by design — a PR is company-wide but a half-built basket
  // is personal). Cleared on checkout via setCart([]).
  useEffect(() => {
    try {
      if (cart.length) window.localStorage.setItem(CART_KEY, JSON.stringify(cart));
      else window.localStorage.removeItem(CART_KEY);
    } catch { /* private mode */ }
  }, [cart]);
  useEffect(() => {
    try { window.localStorage.setItem(FAVS_KEY, JSON.stringify([...favs])); } catch { /* private mode */ }
    if (synced.current) queueSave({ shop_favs: [...favs] });
  }, [favs]);
  useEffect(() => {
    try { window.localStorage.setItem(TPL_KEY, JSON.stringify(templates)); } catch { /* private mode */ }
    if (synced.current) queueSave({ shop_templates: templates });
  }, [templates]);
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
  const displayItems = useMemo(() => (favOnly ? items.filter((it) => favs.has(it.item_id)) : items), [items, favOnly, favs]);
  const categories = pages[0]?.categories ?? [];
  const total = pages[0]?.total ?? 0;

  const toggleFav = (itemId: string) => setFavs((s) => {
    const next = new Set(s);
    if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
    return next;
  });

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
  // Mirror of addItem for the grid card's inline stepper — drops the line once it hits zero instead of
  // clamping at 1, so the − button can remove the last unit without a separate trash action.
  const decItem = (itemId: string) => setCart((c) => {
    const key = `i:${itemId}`;
    const ex = c.find((l) => l.key === key);
    if (!ex) return c;
    if (ex.qty <= 1) return c.filter((l) => l.key !== key);
    return c.map((l) => (l.key === key ? { ...l, qty: l.qty - 1 } : l));
  });
  const setQty = (key: string, qty: number) => setCart((c) => c.map((l) => (l.key === key ? { ...l, qty: Math.max(1, Math.floor(qty) || 1) } : l)));
  const toggleUrgent = (key: string) => setCart((c) => c.map((l) => (l.key === key ? { ...l, urgent: !l.urgent } : l)));
  const removeLine = (key: string) => setCart((c) => c.filter((l) => l.key !== key));

  // Add a specific quantity of an item to the basket, merging into any existing line.
  const addToBasket = (itemId: string, qty: number, uom = '', description = '') => setCart((c) => {
    const key = `i:${itemId}`;
    const q = Math.max(1, Math.floor(qty) || 1);
    const i = c.findIndex((l) => l.key === key);
    if (i >= 0) return c.map((l, j) => (j === i ? { ...l, qty: l.qty + q } : l));
    return [...c, { key, item_id: itemId, description, uom, unit_price: 0, qty: q, urgent: false, custom: false }];
  });
  const fillLow = (it: LowItem) => addToBasket(it.item_id, it.suggested_qty, it.uom ?? '', it.item_description ?? '');
  const fillAllLow = () => {
    const its = lowStock.data?.items ?? [];
    if (!its.length) return;
    its.forEach(fillLow);
    notifySuccess(t('shop.low_filled', { n: its.length }));
  };

  // Barcode scan-to-add — a hardware scanner types the code then sends Enter, submitting this form.
  // First try an EXACT barcode match (a real scanned GTIN/EAN on the item master); if there's no barcode
  // hit, fall back to a code/name lookup (the scanner may have typed a plain item code, or a human typed a
  // name): exact single match ⇒ basket; no match ⇒ warn; several ⇒ push into the search box to narrow the grid.
  // Reuses the catalog endpoint (no camera lib, works with any USB scanner).
  const addScanned = (it: CatalogItem) => {
    addToBasket(it.item_id, 1, it.uom ?? '', it.item_description ?? '');
    notifySuccess(t('shop.scan_added', { name: it.item_description ?? it.item_id }));
    setScan('');
  };
  const onScan = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = scan.trim();
    if (!code) return;
    try {
      const byBarcode = await api<CatalogPage>(`/api/procurement/catalog?barcode=${encodeURIComponent(code)}&limit=1`);
      if (byBarcode.total === 1 && byBarcode.items[0]) { addScanned(byBarcode.items[0]); return; }
      const r = await api<CatalogPage>(`/api/procurement/catalog?q=${encodeURIComponent(code)}&limit=1`);
      if (r.total === 1 && r.items[0]) {
        addScanned(r.items[0]);
      } else if (r.total === 0) {
        notifyError(t('shop.scan_not_found', { code }));
      } else {
        setQ(code);
        setScan('');
        notifyInfo(t('shop.scan_multi', { n: r.total }));
      }
    } catch {
      notifyError(t('shop.scan_not_found', { code }));
    }
  };

  // Basket templates (รายการประจำ) — save the current cart under a name, reload/delete later.
  const saveTemplate = () => {
    const name = tplName.trim();
    if (!name) { notifyError(t('shop.tpl_need_name')); return; }
    if (!cart.length) { notifyError(t('shop.empty_cart_err')); return; }
    const lines = cart.map((l) => ({ item_id: l.item_id, description: l.description, uom: l.uom, qty: l.qty }));
    setTemplates((ts) => [...ts.filter((tp) => tp.name !== name), { name, lines }]);
    setTplName('');
    notifySuccess(t('shop.tpl_saved', { name }));
  };
  const loadTemplate = (tp: BasketTemplate) => {
    for (const ln of tp.lines) addToBasket(ln.item_id, ln.qty, ln.uom, ln.description);
    notifySuccess(t('shop.tpl_loaded', { name: tp.name }));
  };
  const deleteTemplate = (name: string) => setTemplates((ts) => ts.filter((tp) => tp.name !== name));

  // Re-order: drop a past PR's lines back into the basket (merging quantities into any existing line).
  const reorder = (pr: MyPr) => {
    setCart((c) => {
      const next = [...c];
      for (const ln of pr.lines ?? []) {
        const key = `i:${ln.item_id}`;
        const i = next.findIndex((l) => l.key === key);
        const qty = Math.max(1, Math.floor(ln.request_qty) || 1);
        if (i >= 0) next[i] = { ...next[i], qty: next[i].qty + qty };
        else next.push({ key, item_id: ln.item_id, description: '', uom: ln.uom ?? '', unit_price: 0, qty, urgent: false, custom: false });
      }
      return next;
    });
    notifySuccess(t('shop.reordered', { no: pr.pr_no }));
  };

  const addCustom = () => {
    const name = cName.trim();
    if (!name) { setCErr(true); notifyError(t('shop.custom_need_name')); return; }
    const key = `c:${customSeq.current++}`;
    setCart((c) => [...c, { key, item_id: name.slice(0, 120), description: name, uom: cUom.trim(), unit_price: 0, qty: Math.max(1, Math.floor(cQty) || 1), urgent: false, custom: true }]);
    setCName(''); setCUom(''); setCQty(1); setCErr(false);
  };

  const anyUrgent = cart.some((l) => l.urgent);
  // Reference-only subtotal for the mobile checkout bar — custom/free-text lines carry unit_price 0
  // (no catalog price), so this is a "known items" estimate, not the PR's final costed amount.
  const cartTotal = cart.reduce((s, l) => s + l.unit_price * l.qty, 0);

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
      setCart([]); setRemarks(''); setProjectCode(''); setRequiredDate(''); setBasketOpen(false);
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

  // The basket's lines + project/date/remarks + checkout button — rendered once in the desktop sidebar
  // Card and once inside the mobile/tablet bottom sheet (a plain render function, not a component, so
  // calling it twice never causes a remount/focus-loss; `idPrefix` keeps the two copies' input ids unique).
  const basketBody = (idPrefix: string) => (
    <>
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
          <Label htmlFor={`${idPrefix}-shop-project`}>{t('shop.project_code')}</Label>
          <Input id={`${idPrefix}-shop-project`} value={projectCode} onChange={(e) => setProjectCode(e.target.value)} placeholder={t('shop.project_code_ph')} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-shop-needby`}>{t('shop.required_date')}</Label>
          <Input id={`${idPrefix}-shop-needby`} type="date" value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-shop-remarks`}>{t('shop.remarks')}</Label>
        <textarea
          id={`${idPrefix}-shop-remarks`}
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
          placeholder={t('shop.remarks_ph')}
          className="min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </div>

      <Button className="w-full" disabled={mut.isPending || cart.length === 0} onClick={checkout}>
        <Send className="size-4" /> {mut.isPending ? t('shop.checkout_sending') : t('shop.checkout')}
      </Button>
    </>
  );

  // Placeholder shaped like the real grid/list so the initial catalog fetch doesn't flash a bare spinner —
  // smoother perceived load on the slower mobile connections this screen is built for.
  const catalogSkeleton = view === 'grid' ? (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className="flex flex-col overflow-hidden rounded-xl border bg-card">
          <Skeleton className="aspect-square w-full rounded-none" />
          <div className="space-y-1.5 p-1.5 sm:p-2">
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  ) : (
    <div className="divide-y rounded-xl border">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 p-2.5">
          <Skeleton className="size-14 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-3/5" />
            <Skeleton className="h-3 w-2/5" />
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div className={cn(cart.length > 0 && 'pb-24 lg:pb-0')}>
      <PageHeader title={t('shop.title')} description={t('shop.desc')} />

      {/* A standalone (not PageHeader-actions) row so it can wrap freely on a phone — the shared
          PageHeader actions slot is shrink-0 and would overflow the viewport with 3 items. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(shopProjects.data?.count ?? 0) > 0 && (
          <select
            aria-label={t('shop.proj.pick')}
            title={t('shop.proj.pick')}
            className="h-9 max-w-[13rem] rounded-md border bg-background px-2 text-sm"
            value=""
            onChange={(e) => { if (e.target.value) router.push(`/shop/project/${encodeURIComponent(e.target.value)}`); }}
          >
            <option value="" disabled>🗂️ {t('shop.proj.pick')}</option>
            {shopProjects.data!.projects.map((p) => <option key={p.code} value={p.code}>{p.code} — {p.name}</option>)}
          </select>
        )}
        {canManageCategories && (
          <Button asChild variant="outline" size="sm">
            <Link href="/setup/item-categories"><Layers className="size-4" /> {t('shop.manage_categories')}</Link>
          </Button>
        )}
        <Button asChild variant="outline" size="sm"><Link href="/requisitions">{t('shop.view_prs')}</Link></Button>
      </div>

      {/* Stacked (catalog full-width, basket below) up through tablet — only true desktop widths (xl+)
          get the side-by-side sidebar basket; phones and tablets use the floating basket button instead.
          `grid-cols-1` (explicit `minmax(0,1fr)`) below `xl` matters, not just cosmetic: with no column
          template at all, "grid" falls back to an implicit auto-sized track that grows to fit its content's
          max-content size instead of clamping to the container — the sticky search/chips bar's full-bleed
          `-mx-4` child was exactly such content, so the single "column" (and the whole page) rendered ~14px
          wider than the viewport on a real phone with a realistic (long, many-category) catalog. */}
      {/* Two-column (catalog + sticky basket sidebar) from `lg` (1024px) up — so landscape tablets and
          laptops get the sidebar instead of a single stretched column with the basket buried far below the
          infinite-scroll catalog. Portrait phones/tablets (below lg) keep the floating-basket bottom sheet. */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* ── Catalog ─────────────────────────────────────────────── */}
        {/* min-w-0: without it, a grid item defaults to min-width:auto (content's intrinsic size), so the
            category-chips row below — a horizontal-scroll flex of whitespace-nowrap chips — would force
            this whole track (and the page) wider than the viewport on a real phone with many categories,
            instead of scrolling within its own bounds. Bit production (193 items/8+ categories) though the
            4-category dev fixture never showed it. */}
        <div className="min-w-0 space-y-3">
          {/* Low-stock quick-add (items at/below their reorder point) */}
          {(lowStock.data?.count ?? 0) > 0 && (
            <div className="overflow-hidden rounded-xl border border-amber-500/40 bg-amber-500/5">
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <button type="button" onClick={() => setShowLow((v) => !v)} className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                  <AlertTriangle className="size-4 shrink-0 text-amber-500" />
                  <span className="truncate">{t('shop.low_stock_title')}</span>
                  <Badge variant="warning" className="shrink-0">{lowStock.data?.count}</Badge>
                  <ChevronDown className={cn('size-4 shrink-0 transition-transform', showLow && 'rotate-180')} />
                </button>
                <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={fillAllLow}>{t('shop.fill_all')}</Button>
              </div>
              {showLow && (
                <ul className="divide-y border-t">
                  {(lowStock.data?.items ?? []).map((it) => (
                    <li key={it.item_id} className="flex items-center gap-2 px-3 py-1.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{it.item_description || it.item_id}</p>
                        <p className="text-[11px] text-muted-foreground">{t('shop.on_hand', { n: num(it.on_hand) })} · {t('shop.min_n', { n: num(it.min_stock) })} · {t('shop.suggest_n', { n: num(it.suggested_qty) })}</p>
                      </div>
                      <Button size="sm" className="h-7 shrink-0" onClick={() => fillLow(it)}><Plus className="size-3.5" /> {t('shop.fill')}</Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Search + category chips stay pinned under the topbar while the grid scrolls — the
              Shopee/Grab app pattern (sticky just below the site header, at top-14 = its min-h-14). */}
          <div className="sticky top-14 z-10 -mx-4 space-y-2 border-b bg-background/95 px-4 pb-2 pt-1 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:pt-0 sm:backdrop-blur-none">
            {/* Search + scan + view toggle — stacks on a phone (search full-width on its own row,
                scan + view toggle share the second row) instead of squeezing all three into one line. */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('shop.search_ph')} />
              </div>
              <div className="flex items-center gap-2">
                <form onSubmit={onScan} className="relative flex-1 sm:w-48 sm:flex-none">
                  <ScanLine className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input className="pl-9" value={scan} onChange={(e) => setScan(e.target.value)} placeholder={t('shop.scan_ph')} aria-label={t('shop.scan_ph')} />
                </form>
                <div className="flex shrink-0 rounded-md border p-0.5">
                  <Button size="icon" variant={view === 'grid' ? 'secondary' : 'ghost'} className="size-8" aria-label={t('shop.view_grid')} title={t('shop.view_grid')} onClick={() => setView('grid')}>
                    <LayoutGrid className="size-4" />
                  </Button>
                  <Button size="icon" variant={view === 'list' ? 'secondary' : 'ghost'} className="size-8" aria-label={t('shop.view_list')} title={t('shop.view_list')} onClick={() => setView('list')}>
                    <ListIcon className="size-4" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Favourites toggle + category chips (horizontal scroll, Shopee-style) */}
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
              <button
                type="button"
                onClick={() => setFavOnly((v) => !v)}
                className={cn(
                  'flex items-center gap-1 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition-colors',
                  favOnly ? 'border-amber-500 bg-amber-500 text-white' : 'bg-background hover:bg-accent',
                )}
              >
                <Star className={cn('size-3.5', favOnly && 'fill-current')} /> {t('shop.favorites')}
                {favs.size > 0 && <span className="text-xs opacity-80">{favs.size}</span>}
              </button>
              {categories.length > 0 && catChip(null, t('shop.all_categories'), total)}
              {categories.map((c) => catChip(c.key, c.label, c.count))}
            </div>
          </div>

          {total > 0 && <p className="text-xs text-muted-foreground">{t('shop.results_n', { n: total })}</p>}

          <StateView q={{ isLoading: catalog.isLoading, error: catalog.error }} skeleton={catalogSkeleton}>
            {displayItems.length === 0 ? (
              <div className="mx-auto flex max-w-sm flex-col items-center gap-2 rounded-xl border border-dashed p-8 text-center">
                <div className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
                  {favOnly ? <Star className="size-6" /> : debouncedQ || activeCat ? <Search className="size-6" /> : <PackagePlus className="size-6" />}
                </div>
                <span className="text-sm font-medium text-foreground">
                  {favOnly ? t('shop.favorites') : debouncedQ || activeCat ? t('shop.no_items') : t('shop.empty_catalog')}
                </span>
                <p className="text-sm text-muted-foreground">
                  {favOnly ? t('shop.favorites_empty') : debouncedQ || activeCat ? t('shop.no_items_desc') : t('shop.empty_catalog_desc')}
                </p>
              </div>
            ) : view === 'grid' ? (
              /* Fixed 3 columns through tablet widths (phones + iPads alike) so the hero image scales down
                 with the tile instead of ballooning to fill a wide-but-lonely 2-up row — the auto-fill
                 minmax(11rem,…) track only kicks in once there's real desktop width (xl+) to spread into. */
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {displayItems.map((it) => {
                  const inCart = cartQty(it.item_id);
                  const fav = favs.has(it.item_id);
                  return (
                    <div key={it.item_id} className="group flex flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm transition-shadow hover:shadow-md">
                      {/* Image-forward: a square hero image (Shopee/Grab-style) so the photo, not the
                          text block, dominates the card. */}
                      <div className="relative aspect-square w-full overflow-hidden bg-muted">
                        <ProductThumb item={it} className="size-full" />
                        <button
                          type="button"
                          aria-label={t('shop.favorite')}
                          title={t('shop.favorite')}
                          onClick={() => toggleFav(it.item_id)}
                          className={cn('absolute left-1 top-1 grid size-6 place-items-center rounded-full bg-background/85 shadow-sm backdrop-blur transition hover:bg-background sm:left-1.5 sm:top-1.5 sm:size-8', fav ? 'text-amber-500' : 'text-muted-foreground')}
                        >
                          <Star className={cn('size-3 sm:size-4', fav && 'fill-current')} />
                        </button>
                        <button
                          type="button"
                          aria-label={t('shop.add_urgent')}
                          title={t('shop.add_urgent')}
                          onClick={() => addItem(it, true)}
                          className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-background/85 text-amber-500 shadow-sm backdrop-blur transition hover:bg-background sm:right-1.5 sm:top-1.5 sm:size-8"
                        >
                          <Zap className="size-3 sm:size-4" />
                        </button>
                      </div>
                      <div className="flex flex-1 flex-col gap-0.5 p-1.5 sm:p-2">
                        <p className="line-clamp-2 text-[11px] font-medium leading-snug sm:text-sm">{it.item_description || it.item_id}</p>
                        <p className="hidden truncate text-[11px] text-muted-foreground sm:block">{it.item_id}{it.uom ? ` · ${it.uom}` : ''}</p>
                        <div className="hidden flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground sm:flex">
                          {it.on_hand != null && (
                            <span className={it.on_hand <= 0 ? 'font-medium text-destructive' : ''}>
                              {it.on_hand > 0 ? t('shop.on_hand', { n: num(it.on_hand) }) : t('shop.out_of_stock')}
                            </span>
                          )}
                          {it.last_price != null && it.last_price > 0 && <span>{t('shop.last_price', { price: baht(it.last_price) })}</span>}
                        </div>
                        <div className="mt-auto flex items-end justify-between gap-1 pt-1">
                          {/* Price led large + bold in the brand colour — the one thing a Shopee/Grab
                              card wants you to notice first after the photo. */}
                          <span className="text-xs font-bold text-primary sm:text-base">{it.unit_price > 0 ? baht(it.unit_price) : ''}</span>
                          {/* Shopee-style: once the item's in the basket, the add button becomes a
                              −/qty/+ stepper right on the tile — no need to open the basket just to
                              bump a quantity. */}
                          {inCart > 0 ? (
                            <div className="flex shrink-0 items-center gap-0.5 rounded-full border bg-background">
                              <Button size="icon" variant="ghost" className="size-6 shrink-0 rounded-full sm:size-8" aria-label={t('shop.qty_decrease')} onClick={() => decItem(it.item_id)}><Minus className="size-3 sm:size-4" /></Button>
                              <span className="min-w-[1.25rem] text-center text-xs font-semibold tabular-nums sm:text-sm">{inCart}</span>
                              <Button size="icon" variant="ghost" className="size-6 shrink-0 rounded-full sm:size-8" aria-label={t('shop.add')} title={t('shop.add')} onClick={() => addItem(it)}><Plus className="size-3 sm:size-4" /></Button>
                            </div>
                          ) : (
                            <Button size="icon" className="size-6 shrink-0 rounded-full sm:size-8" aria-label={t('shop.add')} title={t('shop.add')} onClick={() => addItem(it)}><Plus className="size-3 sm:size-4" /></Button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="divide-y rounded-xl border">
                {displayItems.map((it) => {
                  const inCart = cartQty(it.item_id);
                  const fav = favs.has(it.item_id);
                  return (
                    <div key={it.item_id} className="flex items-center gap-2 p-2.5 sm:gap-3">
                      <button
                        type="button"
                        aria-label={t('shop.favorite')}
                        title={t('shop.favorite')}
                        onClick={() => toggleFav(it.item_id)}
                        className={cn('shrink-0 transition-colors', fav ? 'text-amber-500' : 'text-muted-foreground hover:text-foreground')}
                      >
                        <Star className={cn('size-4', fav && 'fill-current')} />
                      </button>
                      <ProductThumb item={it} className="size-12 shrink-0 rounded-lg sm:size-14" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{it.item_description || it.item_id}</p>
                        <p className="truncate text-xs text-muted-foreground">{it.item_id}{it.uom ? ` · ${it.uom}` : ''}</p>
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
                      {/* Trailing actions are icon-only on a phone (label appears from `sm`) so the row never
                          overflows the viewport — the overflow pushed the page wide and shifted the fixed
                          basket sheet off-screen. */}
                      {inCart > 0 && (
                        <Badge variant="secondary" className="shrink-0">
                          <span className="hidden sm:inline">{t('shop.in_cart')} · </span>{inCart}
                        </Badge>
                      )}
                      <Button size="icon" variant="outline" className="size-8 shrink-0 sm:hidden" title={t('shop.add_urgent')} aria-label={t('shop.add_urgent')} onClick={() => addItem(it, true)}>
                        <Zap className="size-4 text-amber-500" />
                      </Button>
                      <Button size="sm" variant="outline" className="hidden shrink-0 sm:inline-flex" title={t('shop.add_urgent')} aria-label={t('shop.add_urgent')} onClick={() => addItem(it, true)}>
                        <Zap className="size-4 text-amber-500" />
                      </Button>
                      <Button size="icon" className="size-8 shrink-0 sm:hidden" aria-label={t('shop.add')} title={t('shop.add')} onClick={() => addItem(it)}><Plus className="size-4" /></Button>
                      <Button size="sm" className="hidden shrink-0 sm:inline-flex" onClick={() => addItem(it)}><Plus className="size-4" /> {t('shop.add')}</Button>
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
        <div className="space-y-4 lg:sticky lg:top-4">
          {/* Below `lg` the basket lives in the floating-button bottom sheet instead (see below) — showing
              it again here too would duplicate DOM ids (project/date/remarks inputs) and double the
              already-long single-column scroll. */}
          <Card className="hidden gap-3 lg:block">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShoppingCart className="size-5" /> {t('shop.basket')}
                {cart.length > 0 && <Badge variant="secondary">{t('shop.lines_n', { n: cart.length })}</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {basketBody('d')}
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
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><Bookmark className="size-5" /> {t('shop.tpl_title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex gap-2">
                <Input value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder={t('shop.tpl_name_ph')} />
                <Button variant="secondary" className="shrink-0" disabled={cart.length === 0} onClick={saveTemplate}>{t('shop.tpl_save')}</Button>
              </div>
              {templates.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('shop.tpl_empty')}</p>
              ) : (
                <ul className="divide-y">
                  {templates.map((tp) => (
                    <li key={tp.name} className="flex items-center gap-2 py-1.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{tp.name}</p>
                        <p className="text-[11px] text-muted-foreground">{t('shop.lines_n', { n: tp.lines.length })}</p>
                      </div>
                      <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={() => loadTemplate(tp)}>{t('shop.tpl_load')}</Button>
                      <Button size="icon" variant="ghost" className="size-7 shrink-0" aria-label={t('shop.remove')} onClick={() => deleteTemplate(tp.name)}><Trash2 className="size-4" /></Button>
                    </li>
                  ))}
                </ul>
              )}
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
                      <li key={pr.pr_no} className="flex items-center gap-2 py-2">
                        <Link href="/requisitions" className="min-w-0 flex-1 hover:opacity-80">
                          <p className="truncate text-sm font-medium">{pr.pr_no}</p>
                          <p className="text-xs text-muted-foreground">{thaiDate(pr.pr_date)} · {t('shop.lines_n', { n: pr.lines?.length ?? 0 })}</p>
                        </Link>
                        <Badge variant={statusVariant(pr.status)} className="shrink-0">{pr.status}</Badge>
                        {(pr.lines?.length ?? 0) > 0 && (
                          <Button size="icon" variant="ghost" className="size-7 shrink-0" title={t('shop.reorder')} aria-label={t('shop.reorder')} onClick={() => reorder(pr)}>
                            <RefreshCw className="size-4" />
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </StateView>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Floating basket button (phones + tablets, Shopee/Grab pattern) — a corner pill, not a full-width
          bar, so it never competes with the catalog for screen space. Opens the basket in a bottom sheet
          rather than scrolling to a sidebar, so checkout is one tap away no matter how far down the
          (infinite-scroll) catalog the requester has browsed. */}
      {cart.length > 0 && (
        <button
          type="button"
          onClick={() => setBasketOpen(true)}
          aria-label={t('shop.view_cart')}
          className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-40 flex items-center gap-2 rounded-full bg-primary py-3 pl-4 pr-5 text-primary-foreground shadow-lg transition-transform active:scale-95 lg:hidden"
        >
          <span className="relative shrink-0">
            <ShoppingCart className="size-5" />
            <Badge variant="destructive" className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full p-0 px-1 text-[10px] leading-none">
              {cart.length}
            </Badge>
          </span>
          <span className="text-sm font-bold">{baht(cartTotal)}</span>
        </button>
      )}

      <Sheet open={basketOpen} onOpenChange={setBasketOpen}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto lg:hidden">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <ShoppingCart className="size-5" /> {t('shop.basket')}
              {cart.length > 0 && <Badge variant="secondary">{t('shop.lines_n', { n: cart.length })}</Badge>}
            </SheetTitle>
          </SheetHeader>
          <div className="space-y-3 px-4 pb-4">
            {basketBody('m')}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
