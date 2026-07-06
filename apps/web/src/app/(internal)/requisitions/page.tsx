'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, MessageCircle, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DataTable, type Column } from '@/components/data-table';
import { PrForm } from '@/components/procurement-forms';

type PrLine = { id: number; item_id: string; item_description: string | null; request_qty: number; uom: string | null; reason: string | null; po_no: string | null; line_status: string | null };
type Pr = { pr_no: string; pr_date: string | null; requested_by: string | null; status: string; priority: string | null; approved_by: string | null; lines: PrLine[] };
type ItemMatch = { item_id: string; item_description: string | null; uom: string | null; unit_price: number; last_price: number | null };
type VendorMatch = { id: number; name: string; vendor_code: string | null };
// Per-item supplier suggestion (preferred → cheapest active price → last PO vendor) driving the PR→PO auto-group.
type SupplierSuggestion = { vendor_id: number; vendor_name: string | null; unit_price: number; uom: string | null; currency: string; preferred: boolean; source: 'pricelist' | 'last_po' };
type ItemSuggestion = { suggested: SupplierSuggestion | null; candidates: SupplierSuggestion[] };

// Company-wide requisition surface (perm: pr_raise) — anyone in the company can raise a purchase
// requisition. A PR is only a request: it is routed to Procurement for approval and conversion to a PO.
// Buying (PO) and receiving (GR) live on their own pages owned by Procurement / Warehouse (SoD R03/R04).
export default function RequisitionsPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('iv.req_title')} description={t('iv.req_desc')} />

      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="text-base">{t('iv.req_card_title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <PrForm />
          <p className="mt-4 text-xs text-muted-foreground">
            {t('iv.req_form_note')}
          </p>
        </CardContent>
      </Card>

      <LowStockCard />
      <PrListCard />
      <LineLinkCard />
    </div>
  );
}

type LowStockItem = { item_id: string; item_description: string | null; uom: string | null; on_hand: number; min_stock: number; suggested_qty: number; unit_price: number };

// "สินค้าใกล้หมด" — items whose on-hand has fallen to/below their reorder point (items.min_stock). Each row
// carries a suggested top-up qty (editable); ticking items and pressing "เปิด PR เติมของ" raises ONE PR for
// the selection through the ordinary createPr path. Mirrors the LINE chat `low`/`reorder` commands.
function LowStockCard() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ items: LowStockItem[]; count: number }>({
    queryKey: ['low-stock'], queryFn: () => api('/api/procurement/low-stock?limit=100'), refetchInterval: 30_000,
  });
  const [qty, setQty] = useState<Record<string, number>>({});
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const rows = q.data?.items ?? [];
  const qtyOf = (it: LowStockItem) => qty[it.item_id] ?? it.suggested_qty;
  const isPicked = (it: LowStockItem) => picked[it.item_id] ?? true; // default: all selected
  const chosen = rows.filter(isPicked);

  const raise = useMutation({
    mutationFn: () => api('/api/procurement/prs', {
      method: 'POST',
      body: JSON.stringify({
        remarks: 'เติมสต็อกสินค้าใกล้หมด', priority: 'Normal',
        items: chosen.map((it) => ({ item_id: it.item_id, item_description: it.item_description ?? undefined, request_qty: qtyOf(it), uom: it.uom ?? undefined, reason: 'ต่ำกว่าจุดสั่งซื้อ' })),
      }),
    }),
    onSuccess: (r: any) => {
      notifySuccess(t('iv.req_toast_low_raised', { pr: r?.pr_no ?? '', count: chosen.length }));
      qc.invalidateQueries({ queryKey: ['prs'] });
      qc.invalidateQueries({ queryKey: ['low-stock'] });
    },
    onError: (e: any) => notifyError(e?.message ?? t('iv.req_toast_pr_failed')),
  });

  if (!q.isLoading && rows.length === 0) return null; // nothing low → hide the card entirely

  return (
    <Card className="mt-6 gap-4 border-amber-300/60">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">{t('iv.req_low_stock')}{q.data ? ` (${q.data.count})` : ''}</CardTitle>
        <Button size="sm" disabled={raise.isPending || chosen.length === 0} onClick={() => raise.mutate()}>
          {raise.isPending ? t('iv.req_opening') : t('iv.req_open_pr_topup', { count: chosen.length })}
        </Button>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">{t('dash.loading')}</p>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{t('iv.req_low_note')}</p>
            {rows.map((it) => (
              <div key={it.item_id} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
                <input type="checkbox" checked={isPicked(it)} onChange={(e) => setPicked((p) => ({ ...p, [it.item_id]: e.target.checked }))} aria-label={t('iv.req_select_aria', { id: it.item_id })} />
                <span className="min-w-40 flex-1 font-medium">{it.item_id}{it.item_description ? <span className="ml-1 font-normal text-muted-foreground">— {it.item_description}</span> : null}</span>
                <Badge variant="destructive">{t('iv.req_remaining_label')} {it.on_hand}{it.uom ? ` ${it.uom}` : ''}</Badge>
                <span className="text-xs text-muted-foreground">{t('iv.req_reorder_point')} {it.min_stock}</span>
                <div className="flex items-center gap-1">
                  <Label htmlFor={`q-${it.item_id}`} className="text-xs">{t('iv.req_order')}</Label>
                  <Input id={`q-${it.item_id}`} type="number" min={1} className="w-24" value={qtyOf(it)} onChange={(e) => setQty((s) => ({ ...s, [it.item_id]: Math.max(1, Number(e.target.value) || 1) }))} />
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// The requisition register — every PR (raised on this page OR from LINE chat) with its status and lines.
// Procurement/planner/exec see all PRs and can approve/reject a Pending one (maker-checker: the engine
// still blocks self-approval); a plain requester sees their own and can cancel a still-Pending PR.
const STATUS_BADGE: Record<string, { key: string; variant: 'success' | 'info' | 'muted' | 'destructive' }> = {
  Approved: { key: 'iv.req_status_approved', variant: 'success' },
  Converted: { key: 'iv.req_status_converted', variant: 'success' },
  PartiallyConverted: { key: 'iv.req_status_partial', variant: 'info' },
  Pending: { key: 'iv.req_status_pending', variant: 'info' },
  Rejected: { key: 'iv.req_status_rejected', variant: 'destructive' },
  Cancelled: { key: 'iv.req_status_cancelled', variant: 'muted' },
  Draft: { key: 'iv.req_status_draft', variant: 'muted' },
};
// A left-edge accent so a phone-width card list still reads status at a glance without a full column for it.
const STATUS_ACCENT: Record<string, string> = {
  Approved: 'border-l-success', Converted: 'border-l-success', PartiallyConverted: 'border-l-info',
  Pending: 'border-l-info', Rejected: 'border-l-destructive',
  Cancelled: 'border-l-muted-foreground/30', Draft: 'border-l-muted-foreground/30',
};

// One PR line: description leads (wraps in full — an approver needs to read the whole request, not a
// truncated hint), qty/uom sits apart on its own line so it never runs on into the description text.
function PrLineItem({ l }: { l: PrLine }) {
  return (
    <li className="flex items-baseline justify-between gap-3">
      <span>
        <span className="font-medium">{l.item_description || l.item_id}</span>
        {l.item_description ? <span className="ml-1 text-xs text-muted-foreground">({l.item_id})</span> : null}
        {l.reason ? <span className="text-xs text-muted-foreground"> — {l.reason}</span> : null}
        {l.po_no ? <span className="ml-1 rounded bg-emerald-50 px-1 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">→ {l.po_no}</span> : null}
      </span>
      <span className="shrink-0 tabular text-xs font-medium text-muted-foreground">{l.request_qty}{l.uom ? ` ${l.uom}` : ''}</span>
    </li>
  );
}

// Approve/reject/convert/cancel — identical decision for the phone-card list and the desktop table row.
function PrActions({ pr, canApprove, decide, cancel, onConvert }: {
  pr: Pr; canApprove: boolean; decide: ReturnType<typeof useMutation<any, any, { prNo: string; approve: boolean }>>;
  cancel: ReturnType<typeof useMutation<any, any, string>>; onConvert: (pr: Pr) => void;
}) {
  const { t } = useLang();
  const isPending = pr.status === 'Pending';
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {canApprove && isPending && (
        <>
          <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ prNo: pr.pr_no, approve: true })}>{t('fin.approve')}</Button>
          <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ prNo: pr.pr_no, approve: false })}>{t('iv.req_reject')}</Button>
        </>
      )}
      {canApprove && (pr.status === 'Approved' || pr.status === 'PartiallyConverted') && (
        <Button size="sm" onClick={() => onConvert(pr)}>{t('iv.req_create_po')}</Button>
      )}
      {!canApprove && isPending && (
        <Button size="sm" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate(pr.pr_no)}>{t('fin.cancel')}</Button>
      )}
    </div>
  );
}

function PrListCard() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [converting, setConverting] = useState<Pr | null>(null);
  const q = useQuery<{ prs: Pr[]; can_approve: boolean }>({
    queryKey: ['prs'], queryFn: () => api('/api/procurement/prs?limit=50'), refetchInterval: 20_000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['prs'] });
  const decide = useMutation({
    mutationFn: ({ prNo, approve }: { prNo: string; approve: boolean }) => api(`/api/procurement/prs/${prNo}/approve`, { method: 'PATCH', body: JSON.stringify({ approve }) }),
    onSuccess: (_r, v) => { notifySuccess(v.approve ? t('iv.req_toast_approved') : t('iv.req_toast_rejected')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const cancel = useMutation({
    mutationFn: (prNo: string) => api(`/api/procurement/prs/${prNo}/cancel`, { method: 'PATCH' }),
    onSuccess: () => { notifySuccess(t('iv.req_toast_cancelled')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const prs = q.data?.prs ?? [];
  return (
    <Card className="mt-4 gap-4">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{t('iv.req_recent')}</CardTitle>
        <Button variant="ghost" size="sm" className="gap-1" onClick={refresh} disabled={q.isFetching}>
          <RefreshCw className={`size-4 ${q.isFetching ? 'animate-spin' : ''}`} /> {t('iv.req_refresh')}
        </Button>
      </CardHeader>
      <CardContent>
        {/* Phone/narrow: one card per PR instead of a 5-column table — a real <table> squeezed into a
            phone width forces every column (esp. the multi-line item list) to wrap into a tall, cramped
            sliver, and the header row just scrolls away with the rows since nothing pins it. Stacking
            each PR as its own card reads top-to-bottom instead, with a status-coloured left edge so the
            list still scans at a glance without a dedicated status column. */}
        <div className="space-y-3 sm:hidden">
          {q.isLoading ? (
            <p className="text-sm text-muted-foreground">{t('dash.loading')}</p>
          ) : prs.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('iv.req_empty_before')} <code className="rounded bg-muted px-1">pr &lt;{t('iv.req_ph_item')}&gt; &lt;{t('iv.req_ph_qty')}&gt;</code> {t('iv.req_empty_after')}</p>
          ) : (
            prs.map((pr) => {
              const badge = STATUS_BADGE[pr.status];
              const hasActions = q.data?.can_approve
                ? pr.status === 'Pending' || pr.status === 'Approved' || pr.status === 'PartiallyConverted'
                : pr.status === 'Pending';
              return (
                <div key={pr.pr_no} className={cn('rounded-lg border border-l-4 p-3 text-sm', STATUS_ACCENT[pr.status] ?? 'border-l-muted-foreground/30')}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{pr.pr_no}</p>
                      <p className="text-xs text-muted-foreground">{pr.pr_date ?? ''} · {pr.requested_by ?? '-'}</p>
                    </div>
                    <div className="text-right">
                      <Badge variant={badge?.variant ?? 'muted'} className="text-[10px]">{badge ? t(badge.key) : pr.status}</Badge>
                      {pr.approved_by ? <p className="mt-0.5 text-xs text-muted-foreground">{t('iv.req_by')} {pr.approved_by}</p> : null}
                    </div>
                  </div>
                  <ul className="mt-2 space-y-1 border-t pt-2">
                    {pr.lines.map((l, i) => <PrLineItem key={i} l={l} />)}
                  </ul>
                  {hasActions && (
                    <div className="mt-2 border-t pt-2">
                      <PrActions pr={pr} canApprove={!!q.data?.can_approve} decide={decide} cancel={cancel} onConvert={setConverting} />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Desktop/tablet: the shared DataTable — sortable columns, skeleton rows while loading, and a
            rich empty state (icon + title + description) instead of a bare line of text. */}
        <div className="hidden sm:block">
          <DataTable<Pr>
            rows={prs}
            loading={q.isLoading}
            rowKey={(pr) => pr.pr_no}
            emptyState={{
              icon: ClipboardList,
              title: t('iv.req_empty_title'),
              description: `${t('iv.req_empty_before')} pr <${t('iv.req_ph_item')}> <${t('iv.req_ph_qty')}> ${t('iv.req_empty_after')}`,
            }}
            columns={[
              {
                key: 'pr_no', label: t('iv.req_col_no_date'), sortable: true,
                render: (pr) => <span className="whitespace-nowrap font-medium">{pr.pr_no}<div className="text-xs font-normal text-muted-foreground">{pr.pr_date ?? ''}</div></span>,
              },
              {
                key: 'lines', label: t('iv.req_col_items'), sortable: false,
                render: (pr) => <ul className="space-y-0.5">{pr.lines.map((l, i) => <PrLineItem key={i} l={l} />)}</ul>,
              },
              {
                key: 'requested_by', label: t('iv.req_col_requester'),
                render: (pr) => <span className="whitespace-nowrap">{pr.requested_by ?? '-'}</span>,
              },
              {
                key: 'status', label: t('fin.col_status'),
                render: (pr) => {
                  const badge = STATUS_BADGE[pr.status];
                  return (
                    <>
                      <Badge variant={badge?.variant ?? 'muted'} className="text-[10px]">{badge ? t(badge.key) : pr.status}</Badge>
                      {pr.approved_by ? <div className="text-xs text-muted-foreground">{t('iv.req_by')} {pr.approved_by}</div> : null}
                    </>
                  );
                },
              },
              {
                key: 'actions', label: t('iv.req_col_actions'), align: 'right', sortable: false,
                render: (pr) => <PrActions pr={pr} canApprove={!!q.data?.can_approve} decide={decide} cancel={cancel} onConvert={setConverting} />,
              },
            ] satisfies Column<Pr>[]}
          />
        </div>
        {converting && <PrToPoForm pr={converting} onDone={() => { setConverting(null); refresh(); }} onCancel={() => setConverting(null)} />}
      </CardContent>
    </Card>
  );
}

// PR → PO conversion (auto-group by supplier). Each still-unordered PR line is reconciled to a real item
// (search the master / open a new code) and routed to a suggested supplier (preferred → cheapest price →
// last PO). Because 1 PO = 1 supplier, lines fan out into one PO per vendor: the dialog groups them, lets
// procurement change a group's or a line's vendor, and submits `pos[]` — the API raises one PO per group,
// links each line back, and marks the PR Converted (or PartiallyConverted if some lines are left unassigned).
type EditLine = {
  pr_line_id: number; item_id: string; item_description: string; create_item: boolean; new_desc: string;
  order_qty: number; unit_price: number; uom: string;
  vendor_id: number | null; vendor_name: string; source: SupplierSuggestion['source'] | 'preferred' | 'manual' | null;
  set_preferred: boolean; candidates: SupplierSuggestion[]; matches: ItemMatch[]; searching: boolean; searched: boolean;
};

// Inline vendor picker used both on a group header (reassign the whole group) and per line (split one out).
function VendorAssign({ onPick }: { onPick: (v: { id: number | null; name: string }) => void }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [matches, setMatches] = useState<VendorMatch[]>([]);
  const [busy, setBusy] = useState(false);
  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try { const r = await api<{ vendors: VendorMatch[] }>(`/api/procurement/vendors/search?q=${encodeURIComponent(q)}`); setMatches(r.vendors); }
    catch (e: any) { notifyError(e.message); } finally { setBusy(false); }
  };
  if (!open) return <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setOpen(true)}>{t('iv.req_change_vendor')}</Button>;
  return (
    <div className="mt-1 w-full space-y-1">
      <div className="flex gap-1">
        <Input className="h-7 text-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('iv.req_vendor_ph')} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } }} />
        <Button type="button" variant="outline" size="sm" className="h-7" disabled={busy || !q.trim()} onClick={search}>{busy ? '…' : t('iv.req_search_vendor')}</Button>
      </div>
      <div className="flex flex-wrap gap-1">
        {matches.map((v) => (
          <button key={v.id} type="button" className="rounded border bg-muted px-2 py-0.5 text-xs hover:bg-accent"
            onClick={() => { onPick({ id: v.id, name: v.name }); setOpen(false); setMatches([]); setQ(''); }}>
            {v.name}{v.vendor_code ? ` (${v.vendor_code})` : ''}
          </button>
        ))}
        {q.trim() && (
          <button type="button" className="rounded border border-dashed px-2 py-0.5 text-xs hover:bg-accent"
            onClick={() => { onPick({ id: null, name: q.trim() }); setOpen(false); setMatches([]); setQ(''); }}>
            {t('iv.req_use_typed_vendor', { name: q.trim() })}
          </button>
        )}
      </div>
    </div>
  );
}

function PrToPoForm({ pr, onDone, onCancel }: { pr: Pr; onDone: () => void; onCancel: () => void }) {
  const { t } = useLang();
  // Only lines not yet on a PO are convertible (a PartiallyConverted PR carries some already-ordered lines).
  const [lines, setLines] = useState<EditLine[]>(() => pr.lines.filter((l) => !l.po_no).map((l) => ({
    pr_line_id: l.id, item_id: l.item_id, item_description: l.item_description ?? '', create_item: false, new_desc: '',
    order_qty: l.request_qty, unit_price: 0, uom: l.uom ?? '', vendor_id: null, vendor_name: '', source: null,
    set_preferred: false, candidates: [], matches: [], searching: false, searched: false,
  })));
  const [loadingSug, setLoadingSug] = useState(true);
  const setLine = (id: number, patch: Partial<EditLine>) => setLines((ls) => ls.map((x) => (x.pr_line_id === id ? { ...x, ...patch } : x)));

  // On open, ask the API which supplier fits each line and auto-assign it (buyers can still change any).
  useEffect(() => {
    const ids = [...new Set(lines.map((l) => l.item_id).filter(Boolean))];
    if (!ids.length) { setLoadingSug(false); return; }
    let alive = true;
    api<{ suggestions: Record<string, ItemSuggestion> }>(`/api/procurement/items/suppliers?item_ids=${encodeURIComponent(ids.join(','))}`)
      .then((r) => {
        if (!alive) return;
        setLines((ls) => ls.map((l) => {
          const s = r.suggestions[l.item_id];
          if (!s?.suggested) return { ...l, candidates: s?.candidates ?? [] };
          const sg = s.suggested;
          return {
            ...l, candidates: s.candidates ?? [], vendor_id: sg.vendor_id, vendor_name: sg.vendor_name ?? '',
            source: sg.preferred ? 'preferred' : sg.source,
            unit_price: l.unit_price > 0 ? l.unit_price : (sg.unit_price > 0 ? sg.unit_price : 0),
            uom: l.uom || (sg.uom ?? ''),
          };
        }));
      })
      .catch(() => { /* suggestions are a convenience; the buyer can assign manually */ })
      .finally(() => { if (alive) setLoadingSug(false); });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const searchItem = async (id: number) => {
    const line = lines.find((l) => l.pr_line_id === id); if (!line) return;
    setLine(id, { searching: true });
    try {
      const r = await api<{ items: ItemMatch[] }>(`/api/procurement/items/search?q=${encodeURIComponent(line.item_id || line.item_description)}`);
      setLine(id, { matches: r.items, searched: true });
    } catch (e: any) { notifyError(e.message); } finally { setLine(id, { searching: false }); }
  };

  const assignVendor = (ids: number[], v: { id: number | null; name: string }) =>
    setLines((ls) => ls.map((l) => (ids.includes(l.pr_line_id) ? { ...l, vendor_id: v.id, vendor_name: v.name, source: 'manual' } : l)));

  // Group lines by their assigned vendor (assigned groups first, the "no vendor yet" bucket last).
  const groups = useMemo(() => {
    const map = new Map<string, { key: string; vendor_id: number | null; vendor_name: string; lines: EditLine[] }>();
    for (const l of lines) {
      const key = l.vendor_id ? `v${l.vendor_id}` : l.vendor_name ? `n:${l.vendor_name}` : 'none';
      const g = map.get(key) ?? { key, vendor_id: l.vendor_id, vendor_name: l.vendor_name, lines: [] };
      g.lines.push(l); map.set(key, g);
    }
    const arr = [...map.values()];
    return arr.sort((a, b) => (a.key === 'none' ? 1 : 0) - (b.key === 'none' ? 1 : 0));
  }, [lines]);
  const assignedGroups = groups.filter((g) => g.key !== 'none');
  const unassigned = groups.find((g) => g.key === 'none');

  const submit = useMutation({
    mutationFn: () => {
      const pos = assignedGroups.map((g) => ({
        vendor_id: g.vendor_id ?? undefined, vendor_name: g.vendor_name || undefined,
        lines: g.lines.map((l) => ({
          pr_line_id: l.pr_line_id, item_id: l.item_id.trim(),
          item_description: (l.create_item ? l.new_desc.trim() : l.item_description.trim()) || undefined,
          create_item: l.create_item, order_qty: Number(l.order_qty), unit_price: Number(l.unit_price) || 0,
          uom: l.uom.trim() || undefined, set_preferred: l.set_preferred || undefined,
        })),
      }));
      return api<{ pos: { po_no: string }[]; created_items: string[]; pr_status: string }>(`/api/procurement/prs/${pr.pr_no}/to-po`, {
        method: 'POST', body: JSON.stringify({ pos }),
      });
    },
    onSuccess: (r) => {
      const list = (r.pos ?? []).map((p) => p.po_no).join(', ');
      notifySuccess(`${t('iv.req_toast_pos_created', { count: r.pos?.length ?? 0, list })}${r.created_items?.length ? t('iv.req_toast_new_codes', { count: r.created_items.length }) : ''}`);
      onDone();
    },
    onError: (e: any) => notifyError(e.message),
  });

  const linesValid = lines.every((l) => l.item_id.trim() && Number(l.order_qty) > 0);
  const canSubmit = linesValid && assignedGroups.length > 0;

  const sourceLabel = (s: EditLine['source']) => s === 'preferred' ? t('iv.req_src_preferred') : s === 'pricelist' ? t('iv.req_src_pricelist') : s === 'last_po' ? t('iv.req_src_last_po') : '';

  const renderLine = (l: EditLine) => (
    <div key={l.pr_line_id} className="rounded-md border bg-background p-2.5">
      <div className="mb-1 text-xs text-muted-foreground">{t('iv.req_from_request')} <span className="font-medium text-foreground">{l.item_description || l.item_id}</span>{l.item_description ? <span className="ml-1">({l.item_id})</span> : null}</div>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <div className="space-y-1">
          <Label className="text-xs">{t('iv.req_item_code')} {l.create_item ? t('iv.req_item_new') : t('iv.req_item_match')}</Label>
          <div className="flex gap-2">
            <Input value={l.item_id} onChange={(e) => setLine(l.pr_line_id, { item_id: e.target.value, searched: false, matches: [] })} placeholder={t('iv.req_item_code')} />
            <Button type="button" variant="outline" size="sm" disabled={l.searching} onClick={() => searchItem(l.pr_line_id)}>{l.searching ? '…' : t('iv.req_search_match')}</Button>
          </div>
          {l.matches.length > 0 && !l.create_item && (
            <div className="flex flex-wrap gap-1 pt-1">
              <span className="text-xs text-muted-foreground">{t('iv.req_choose_code')}</span>
              {l.matches.map((m) => (
                <button key={m.item_id} type="button" onClick={() => setLine(l.pr_line_id, { item_id: m.item_id, item_description: m.item_description ?? l.item_description, uom: m.uom ?? l.uom, unit_price: (m.last_price ?? m.unit_price) || l.unit_price, matches: [], searched: false })}
                  className="rounded border bg-muted px-2 py-0.5 text-xs hover:bg-accent">
                  {m.item_id}{m.item_description ? ` — ${m.item_description}` : ''}{m.last_price ? ` · ${t('iv.req_latest')} ฿${m.last_price}` : ''}
                </button>
              ))}
            </div>
          )}
          {l.searched && l.matches.length === 0 && !l.create_item && (
            <p className="pt-1 text-xs text-warning">{t('iv.req_not_found', { id: l.item_id })}</p>
          )}
          <label className="flex items-center gap-1 pt-1 text-xs text-muted-foreground">
            <input type="checkbox" checked={l.create_item} onChange={(e) => setLine(l.pr_line_id, { create_item: e.target.checked })} />
            {t('iv.req_open_new_item')}
          </label>
          {l.create_item && (
            <Input className="mt-1" value={l.new_desc} onChange={(e) => setLine(l.pr_line_id, { new_desc: e.target.value })} placeholder={t('iv.req_new_item_ph')} />
          )}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-20 space-y-1"><Label className="text-xs">{t('inv.col_qty')}</Label><Input type="number" value={l.order_qty} onChange={(e) => setLine(l.pr_line_id, { order_qty: Number(e.target.value) })} /></div>
          <div className="w-20 space-y-1"><Label className="text-xs">{t('inv.col_uom')}</Label><Input value={l.uom} onChange={(e) => setLine(l.pr_line_id, { uom: e.target.value })} /></div>
          <div className="w-24 space-y-1"><Label className="text-xs">{t('iv.req_unit_price')}</Label><Input type="number" value={l.unit_price} onChange={(e) => setLine(l.pr_line_id, { unit_price: Number(e.target.value) })} /></div>
        </div>
      </div>
      {/* per-line: move just this item to a different supplier (splits it into its own group) */}
      <div className="mt-1"><VendorAssign onPick={(v) => assignVendor([l.pr_line_id], v)} /></div>
    </div>
  );

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="max-h-[90vh] gap-3 overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{t('iv.req_create_po_from', { pr: pr.pr_no })}</DialogTitle>
      </DialogHeader>
      {lines.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">{t('iv.req_all_ordered')}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{loadingSug ? t('iv.req_suggesting') : t('iv.req_split_note')}</p>
          <div className="space-y-4">
            {assignedGroups.map((g, gi) => {
              const total = g.lines.reduce((a, l) => a + Number(l.order_qty) * (Number(l.unit_price) || 0), 0);
              const ids = g.lines.map((l) => l.pr_line_id);
              const src = g.lines[0]?.source;
              return (
                <div key={g.key} className="rounded-lg border border-primary/30 bg-card p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="info" className="text-[10px]">{t('iv.req_group_po', { n: gi + 1 })}</Badge>
                      <span className="font-medium">{g.vendor_name || t('iv.req_unassigned_group')}</span>
                      {src && src !== 'manual' ? <Badge variant="muted" className="text-[10px]">{sourceLabel(src)}</Badge> : null}
                    </div>
                    <div className="text-xs text-muted-foreground">{t('iv.req_group_total')} ฿{total.toLocaleString()}</div>
                  </div>
                  <VendorAssign onPick={(v) => assignVendor(ids, v)} />
                  <label className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                    <input type="checkbox" checked={g.lines.every((l) => l.set_preferred)} onChange={(e) => setLines((ls) => ls.map((l) => (ids.includes(l.pr_line_id) ? { ...l, set_preferred: e.target.checked } : l)))} />
                    ★ {t('iv.req_set_preferred')}
                  </label>
                  <div className="mt-2 space-y-2">{g.lines.map(renderLine)}</div>
                </div>
              );
            })}
            {unassigned && (
              <div className="rounded-lg border border-dashed border-warning/50 bg-warning/5 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="font-medium text-warning">{t('iv.req_unassigned_group')}</span>
                  <span className="text-xs text-muted-foreground">{t('iv.req_unassigned_warn')}</span>
                </div>
                <div className="space-y-2">{unassigned.lines.map(renderLine)}</div>
              </div>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!canSubmit || submit.isPending} onClick={() => submit.mutate()}>
              {submit.isPending ? t('iv.req_creating') : t('iv.req_create_pos_btn', { count: assignedGroups.length })}
            </Button>
            {!canSubmit && assignedGroups.length === 0 ? <span className="text-xs text-warning">{t('iv.req_no_group_ready')}</span> : <span className="text-xs text-muted-foreground">{t('iv.req_submit_note')}</span>}
          </div>
        </>
      )}
      </DialogContent>
    </Dialog>
  );
}

// LINE chat → PR: link the caller's LINE account to their ERP identity with a short-lived one-time code
// (typed into the shop's LINE OA chat as `link <code>`). Once linked, `pr <item> <qty>` in the OA chat
// raises a PR under the linked identity — it enters the same approval workflow as a PR raised here.
function LineLinkCard() {
  const { t } = useLang();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['line-link'], queryFn: () => api<{ linked: boolean }>('/api/line/link') });
  const issue = useMutation({
    mutationFn: () => api<{ code: string; expires_at: string; linked: boolean }>('/api/line/link-code', { method: 'POST' }),
  });
  const unlink = useMutation({
    mutationFn: () => api<{ linked: boolean }>('/api/line/link', { method: 'DELETE' }),
    onSuccess: () => { issue.reset(); qc.invalidateQueries({ queryKey: ['line-link'] }); },
  });

  return (
    <Card className="mt-4 gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageCircle className="size-4" /> {t('iv.req_line_title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {status.data?.linked ? (
          <>
            <p className="text-sm">
              {t('iv.req_line_linked_1')} <code className="rounded bg-muted px-1">pr &lt;{t('iv.req_ph_item_code')}&gt; &lt;{t('iv.req_ph_qty')}&gt;</code>{' '}
              {t('iv.req_line_linked_2')} <code className="rounded bg-muted px-1">status &lt;{t('iv.req_ph_pr_no')}&gt;</code> {t('iv.req_line_linked_3')}
            </p>
            <Button variant="outline" size="sm" onClick={() => unlink.mutate()} disabled={unlink.isPending}>
              {t('iv.req_line_unlink')}
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {t('iv.req_line_link_1')}{' '}
              <code className="rounded bg-muted px-1">link &lt;{t('iv.req_ph_code')}&gt;</code> {t('iv.req_line_link_2')}
            </p>
            {issue.data && (
              <p className="text-sm">
                {t('iv.req_your_code')} <code className="rounded bg-muted px-2 py-1 text-base font-semibold tracking-widest">{issue.data.code}</code>{' '}
                <span className="text-xs text-muted-foreground">
                  {t('iv.req_type_within_1')} <code>link {issue.data.code}</code> {t('iv.req_type_within_2')}
                </span>
              </p>
            )}
            <Button size="sm" onClick={() => issue.mutate()} disabled={issue.isPending}>
              {issue.data ? t('iv.req_gen_new_code') : t('iv.req_gen_link_code')}
            </Button>
            {issue.isError && <p className="text-sm text-destructive">{(issue.error as Error)?.message ?? t('iv.req_code_failed')}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
