'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Search, Plus, Minus, ShoppingCart, Send, ImageOff, ArrowLeft, AlertTriangle, PackageCheck, Info, PackagePlus } from 'lucide-react';
import { api } from '@/lib/api';
import { useMe, hasPerm } from '@/lib/auth';
import { notifyError, notifySuccess, notifyInfo } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { baht, num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

// A shoppable BoQ line — the "shelf" the requester picks from. Only items already on the project's APPROVED
// budget appear here (the server restricts it); each carries its remaining budget so the buyer sees headroom.
type ShelfLine = {
  boq_line_id: number; item_no: string; item_description: string | null; uom: string | null;
  rate: number; budget: number; committed: number; remaining: number; image_key: string | null;
};
type Shelf = {
  project_code: string; project_name: string; boq_no: string | null; boq_status: string | null;
  tolerance_pct: number; lines: ShelfLine[]; budget_total: number; committed_total: number; remaining_total: number;
};
// A line in the PMR basket (qty against a BoQ line; est cost = qty × rate).
type PmrCart = Record<number, number>; // boq_line_id → qty
type PmrResult = { pmr_no: string; status: string; route: string; over_budget: boolean; est_cost: number; over_amount: number; linked_doc_no: string | null };

function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

// Lazy thumbnail for a BoQ line's item (reuses the pr_raise-gated catalog image endpoint, keyed by item_no).
function LineThumb({ line, className }: { line: ShelfLine; className?: string }) {
  const hasImg = !!line.image_key;
  const img = useQuery<{ data_url: string }>({
    queryKey: ['catalog-img', line.item_no],
    queryFn: () => api(`/api/procurement/catalog/items/${encodeURIComponent(line.item_no)}/image`),
    enabled: hasImg, staleTime: 5 * 60 * 1000, retry: false,
  });
  const label = (line.item_description || line.item_no).trim();
  if (hasImg && img.data?.data_url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={img.data.data_url} alt={label} loading="lazy" className={cn('object-cover', className)} />;
  }
  const h = hueFor(line.item_no);
  return (
    <div className={cn('flex items-center justify-center', className)} style={{ background: `hsl(${h} 70% 92%)`, color: `hsl(${h} 45% 40%)` }} aria-hidden>
      {label ? <span className="text-2xl font-semibold">{label.slice(0, 1).toUpperCase()}</span> : <ImageOff className="size-6 opacity-50" />}
    </div>
  );
}

// "Shop for a project" — a requester (pr_raise) shops ONLY what the project's approved BoQ budget already
// allows (the server restricts the shelf to approved material lines). Checkout raises a PMR (M2, PROJ-13):
// within budget it becomes a project-tagged PR (or is issued from on-hand stock); over budget it parks for
// an authoriser's approval (maker-checker). An item NOT on the budget must first be added to the project by
// an authorised person — it cannot be carted here.
export default function ShopProjectPage() {
  const { t } = useLang();
  const params = useParams<{ code: string }>();
  const code = decodeURIComponent(String(params?.code ?? ''));
  const [q, setQ] = useState('');
  const [cart, setCart] = useState<PmrCart>({});

  const shelf = useQuery<Shelf>({
    queryKey: ['pmr-shelf', code],
    queryFn: () => api(`/api/pmr/project/${encodeURIComponent(code)}/boq`),
  });

  const lines = shelf.data?.lines ?? [];
  const byId = useMemo(() => new Map(lines.map((l) => [l.boq_line_id, l])), [lines]);
  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return lines;
    return lines.filter((l) => `${l.item_no} ${l.item_description ?? ''}`.toLowerCase().includes(kw));
  }, [lines, q]);

  const setQty = (id: number, qty: number) => setCart((c) => {
    const next = { ...c };
    const q2 = Math.max(0, Math.floor(qty) || 0);
    if (q2 <= 0) delete next[id]; else next[id] = q2;
    return next;
  });
  const add = (id: number) => setQty(id, (cart[id] ?? 0) + 1);

  const cartLines = useMemo(
    () => Object.entries(cart).map(([id, qty]) => ({ line: byId.get(Number(id)), qty })).filter((x) => x.line) as { line: ShelfLine; qty: number }[],
    [cart, byId],
  );
  const estTotal = cartLines.reduce((s, { line, qty }) => s + line.rate * qty, 0);
  const tol = shelf.data?.tolerance_pct ?? 0;
  // A line is "over budget" (needs an authoriser) when its est cost exceeds the remaining budget + tolerance.
  const overCount = cartLines.filter(({ line, qty }) => line.rate * qty > line.remaining * (1 + tol / 100) + 0.005).length;

  const mut = useMutation({
    mutationFn: () => api<PmrResult>('/api/pmr', {
      method: 'POST',
      body: JSON.stringify({
        project_code: code,
        items: cartLines.map(({ line, qty }) => ({ boq_line_id: line.boq_line_id, item_no: line.item_no, qty, unit_cost: line.rate })),
      }),
    }),
    onSuccess: (r) => {
      if (r.status === 'pending') {
        notifyInfo(t('shop.proj.pmr_pending', { no: r.pmr_no }), t('shop.proj.pmr_pending_desc', { amt: baht(r.over_amount) }));
      } else if (r.route === 'issue') {
        notifySuccess(t('shop.proj.pmr_issued', { no: r.pmr_no }), t('shop.proj.pmr_issued_desc'));
      } else {
        notifySuccess(t('shop.proj.pmr_routed', { no: r.pmr_no }), t('shop.proj.pmr_routed_desc', { doc: r.linked_doc_no ?? '' }));
      }
      setCart({});
      shelf.refetch();
    },
    onError: (e: any) => notifyError(e?.message ?? t('shop.proj.failed')),
  });
  const checkout = () => { if (!cartLines.length) { notifyError(t('shop.proj.empty')); return; } mut.mutate(); };

  // Request-to-add flow (PROJ-15): an item NOT on the approved budget can't be carted — a requester proposes
  // it here and an authoriser (planner/exec) must approve before it becomes shoppable.
  const [reqOpen, setReqOpen] = useState(false);
  const [rqName, setRqName] = useState('');
  const [rqUom, setRqUom] = useState('');
  const [rqQty, setRqQty] = useState(1);
  const [rqRate, setRqRate] = useState(0);
  const boqReqs = useQuery<{ requests: { req_no: string; status: string; description: string | null; item_no: string | null; qty: number; rate: number; amount: number }[]; count: number; pending: number }>({
    queryKey: ['boq-requests', code],
    queryFn: () => api(`/api/pmr/project/${encodeURIComponent(code)}/boq-requests`),
  });
  const reqMut = useMutation({
    mutationFn: () => api('/api/pmr/boq-request', {
      method: 'POST',
      body: JSON.stringify({ project_code: code, item_no: rqName.trim().slice(0, 120), description: rqName.trim(), uom: rqUom.trim() || undefined, qty: rqQty, rate: rqRate }),
    }),
    onSuccess: () => {
      notifySuccess(t('shop.proj.req_sent'));
      setRqName(''); setRqUom(''); setRqQty(1); setRqRate(0); setReqOpen(false);
      boqReqs.refetch();
    },
    onError: (e: any) => notifyError(e?.message ?? t('shop.proj.req_failed')),
  });
  const submitReq = () => {
    if (!rqName.trim()) { notifyError(t('shop.proj.req_need_name')); return; }
    if (rqQty <= 0 || rqRate < 0) { notifyError(t('shop.proj.req_need_qty')); return; }
    reqMut.mutate();
  };
  const reqStatusVariant = (s: string) => (s === 'approved' ? 'default' : s === 'rejected' ? 'destructive' : 'secondary');

  // An authoriser (planner/exec) can approve/reject a pending budget-add request right here (maker-checker is
  // enforced server-side — you cannot approve your own). On approval the item joins the shelf.
  const me = useMe();
  const canApprove = hasPerm(me.data, 'planner', 'exec');
  const decideMut = useMutation({
    mutationFn: ({ reqNo, decision }: { reqNo: string; decision: 'approve' | 'reject' }) =>
      api(`/api/pmr/boq-request/${encodeURIComponent(reqNo)}/${decision}`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (_d, v) => {
      notifySuccess(v.decision === 'approve' ? t('shop.proj.req_approved') : t('shop.proj.req_rejected'));
      boqReqs.refetch(); shelf.refetch();
    },
    onError: (e: any) => notifyError(e?.message ?? t('shop.proj.req_failed')),
  });

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 pb-28 lg:pb-4">
      <PageHeader
        title={shelf.data?.project_name ? `${shelf.data.project_name}` : t('shop.proj.title')}
        description={t('shop.proj.subtitle', { code })}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/shop"><ArrowLeft className="size-4" /> {t('shop.proj.back')}</Link>
          </Button>
        }
      />

      <StateView q={shelf}>
      {!lines.length ? (
        <div className="mx-auto max-w-md rounded-xl border border-dashed p-8 text-center">
          <AlertTriangle className="mx-auto size-8 text-amber-500" />
          <p className="mt-3 font-medium">{t('shop.proj.no_budget')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('shop.proj.no_budget_desc')}</p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
          {/* ── Shelf (budgeted items) ─────────────────────────────── */}
          <div className="space-y-3">
            {/* Budget banner */}
            <Card>
              <CardContent className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-3 text-sm">
                <span className="flex items-center gap-1.5 font-medium"><PackageCheck className="size-4 text-emerald-600" /> {t('shop.proj.boq_no', { no: shelf.data?.boq_no ?? '—' })}</span>
                <span className="text-muted-foreground">{t('shop.proj.budget')}: <b className="text-foreground">{baht(shelf.data?.budget_total ?? 0)}</b></span>
                <span className="text-muted-foreground">{t('shop.proj.committed')}: <b className="text-foreground">{baht(shelf.data?.committed_total ?? 0)}</b></span>
                <span className="text-muted-foreground">{t('shop.proj.remaining')}: <b className="text-emerald-600">{baht(shelf.data?.remaining_total ?? 0)}</b></span>
              </CardContent>
            </Card>

            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('shop.proj.search_ph')} />
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]">
              {filtered.map((l) => {
                const qty = cart[l.boq_line_id] ?? 0;
                const est = l.rate * Math.max(qty, 0);
                const over = est > l.remaining * (1 + tol / 100) + 0.005;
                const soldOut = l.remaining <= 0.005;
                return (
                  <Card key={l.boq_line_id} className="flex flex-col overflow-hidden">
                    <div className="relative aspect-[4/3] w-full bg-muted">
                      <LineThumb line={l} className="size-full" />
                      {soldOut && <Badge variant="secondary" className="absolute left-1.5 top-1.5 text-[10px]">{t('shop.proj.no_headroom')}</Badge>}
                    </div>
                    <CardContent className="flex flex-1 flex-col gap-1.5 p-2.5">
                      <p className="line-clamp-2 text-sm font-medium leading-tight">{l.item_description || l.item_no}</p>
                      <p className="text-[11px] text-muted-foreground">{l.item_no}{l.uom ? ` · ${l.uom}` : ''}</p>
                      <div className="mt-auto space-y-0.5 text-[11px]">
                        <p className="text-muted-foreground">{t('shop.proj.rate')}: <b className="text-foreground">{baht(l.rate)}</b></p>
                        <p className={cn('text-muted-foreground', l.remaining <= 0 && 'text-destructive')}>{t('shop.proj.remaining')}: <b className={cn(l.remaining > 0 ? 'text-emerald-600' : 'text-destructive')}>{baht(l.remaining)}</b></p>
                      </div>
                      {qty > 0 ? (
                        <div className="flex items-center justify-between gap-1">
                          <div className="flex items-center gap-1">
                            <Button size="icon" variant="outline" className="size-7" aria-label="-" onClick={() => setQty(l.boq_line_id, qty - 1)}><Minus className="size-3.5" /></Button>
                            <Input type="number" min="0" value={qty} onChange={(e) => setQty(l.boq_line_id, +e.target.value)} className="h-7 w-12 px-1 text-center" />
                            <Button size="icon" variant="outline" className="size-7" aria-label="+" onClick={() => setQty(l.boq_line_id, qty + 1)}><Plus className="size-3.5" /></Button>
                          </div>
                          {over && <Badge variant="outline" className="border-amber-500 text-[9px] text-amber-600" title={t('shop.proj.over_hint')}>{t('shop.proj.over')}</Badge>}
                        </div>
                      ) : (
                        <Button size="sm" variant="secondary" className="h-8 w-full" onClick={() => add(l.boq_line_id)}>
                          <Plus className="size-4" /> {t('shop.proj.add')}
                        </Button>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
              {!filtered.length && <p className="col-span-full py-8 text-center text-sm text-muted-foreground">{t('shop.proj.no_match')}</p>}
            </div>

            {/* Request-to-add: an off-budget item must be approved into the project budget first (PROJ-15) */}
            <Card>
              <CardContent className="space-y-3 py-3">
                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  {t('shop.proj.not_in_budget')}
                </p>
                {!reqOpen ? (
                  <Button variant="outline" size="sm" onClick={() => setReqOpen(true)}>
                    <PackagePlus className="size-4" /> {t('shop.proj.req_open')}
                  </Button>
                ) : (
                  <div className="space-y-2 rounded-lg border p-3">
                    <p className="text-sm font-medium">{t('shop.proj.req_title')}</p>
                    <Input value={rqName} onChange={(e) => setRqName(e.target.value)} placeholder={t('shop.proj.req_name_ph')} />
                    <div className="flex flex-wrap gap-2">
                      <label className="flex items-center gap-1 text-xs text-muted-foreground">{t('shop.proj.req_qty')}
                        <Input type="number" min="1" value={rqQty} onChange={(e) => setRqQty(+e.target.value)} className="h-8 w-20" />
                      </label>
                      <label className="flex items-center gap-1 text-xs text-muted-foreground">{t('shop.proj.req_rate')}
                        <Input type="number" min="0" value={rqRate} onChange={(e) => setRqRate(+e.target.value)} className="h-8 w-24" />
                      </label>
                      <Input value={rqUom} onChange={(e) => setRqUom(e.target.value)} placeholder={t('shop.proj.req_uom_ph')} className="h-8 w-24" />
                    </div>
                    <p className="text-xs text-muted-foreground">{t('shop.proj.req_est', { amt: baht(Math.max(0, rqQty) * Math.max(0, rqRate)) })}</p>
                    <div className="flex gap-2">
                      <Button size="sm" disabled={reqMut.isPending} onClick={submitReq}><Send className="size-4" /> {reqMut.isPending ? t('shop.proj.submitting') : t('shop.proj.req_submit')}</Button>
                      <Button size="sm" variant="ghost" onClick={() => setReqOpen(false)}>{t('shop.proj.req_cancel')}</Button>
                    </div>
                  </div>
                )}
                {(boqReqs.data?.count ?? 0) > 0 && (
                  <div className="space-y-1 border-t pt-2">
                    <p className="text-xs font-medium text-muted-foreground">{t('shop.proj.req_list')}</p>
                    {boqReqs.data!.requests.slice(0, 6).map((r) => (
                      <div key={r.req_no} className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate">{r.description || r.item_no} · {num(r.qty)} × {baht(r.rate)}</span>
                        <div className="flex shrink-0 items-center gap-1">
                          {canApprove && r.status === 'pending' && (
                            <>
                              <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" disabled={decideMut.isPending} onClick={() => decideMut.mutate({ reqNo: r.req_no, decision: 'approve' })}>{t('shop.proj.req_approve')}</Button>
                              <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" disabled={decideMut.isPending} onClick={() => decideMut.mutate({ reqNo: r.req_no, decision: 'reject' })}>{t('shop.proj.req_reject')}</Button>
                            </>
                          )}
                          <Badge variant={reqStatusVariant(r.status)} className="text-[10px]">{t(`shop.proj.req_st_${r.status}`)}</Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* ── PMR basket (sticky) ────────────────────────────────── */}
          <div className="lg:sticky lg:top-4 lg:self-start">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base"><ShoppingCart className="size-5" /> {t('shop.proj.basket')} {cartLines.length > 0 && <Badge variant="secondary">{cartLines.length}</Badge>}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {!cartLines.length ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">{t('shop.proj.basket_empty')}</p>
                ) : (
                  <div className="space-y-2">
                    {cartLines.map(({ line, qty }) => (
                      <div key={line.boq_line_id} className="flex items-start justify-between gap-2 text-sm">
                        <div className="min-w-0">
                          <p className="truncate font-medium">{line.item_description || line.item_no}</p>
                          <p className="text-xs text-muted-foreground">{num(qty)} × {baht(line.rate)} = {baht(line.rate * qty)}</p>
                        </div>
                        <Button size="icon" variant="ghost" className="size-6 shrink-0" aria-label={t('shop.proj.remove')} onClick={() => setQty(line.boq_line_id, 0)}><Minus className="size-3.5" /></Button>
                      </div>
                    ))}
                    <div className="flex items-center justify-between border-t pt-2 text-sm font-medium">
                      <span>{t('shop.proj.est_total')}</span><span>{baht(estTotal)}</span>
                    </div>
                    {overCount > 0 && (
                      <p className="flex items-center gap-1.5 text-xs text-amber-600"><AlertTriangle className="size-3.5" /> {t('shop.proj.over_note', { n: overCount })}</p>
                    )}
                  </div>
                )}
                <Button className="w-full" disabled={mut.isPending || !cartLines.length} onClick={checkout}>
                  <Send className="size-4" /> {mut.isPending ? t('shop.proj.submitting') : t('shop.proj.submit')}
                </Button>
                <Button asChild variant="ghost" size="sm" className="w-full">
                  <Link href={`/projects/${encodeURIComponent(code)}`}>{t('shop.proj.view_project')}</Link>
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
      </StateView>
    </div>
  );
}
