'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PrForm } from '@/components/procurement-forms';

type PrLine = { item_id: string; request_qty: number; uom: string | null; reason: string | null };
type Pr = { pr_no: string; pr_date: string | null; requested_by: string | null; status: string; priority: string | null; approved_by: string | null; lines: PrLine[] };
type ItemMatch = { item_id: string; item_description: string | null; uom: string | null; unit_price: number; last_price: number | null };
type VendorMatch = { id: number; name: string; vendor_code: string | null };

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
  Pending: { key: 'iv.req_status_pending', variant: 'info' },
  Rejected: { key: 'iv.req_status_rejected', variant: 'destructive' },
  Cancelled: { key: 'iv.req_status_cancelled', variant: 'muted' },
  Draft: { key: 'iv.req_status_draft', variant: 'muted' },
};

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
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">{t('dash.loading')}</p>
        ) : prs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('iv.req_empty_before')} <code className="rounded bg-muted px-1">pr &lt;{t('iv.req_ph_item')}&gt; &lt;{t('iv.req_ph_qty')}&gt;</code> {t('iv.req_empty_after')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3">{t('iv.req_col_no_date')}</th>
                  <th className="py-2 pr-3">{t('iv.req_col_items')}</th>
                  <th className="py-2 pr-3">{t('iv.req_col_requester')}</th>
                  <th className="py-2 pr-3">{t('fin.col_status')}</th>
                  <th className="py-2 pr-3 text-right">{t('iv.req_col_actions')}</th>
                </tr>
              </thead>
              <tbody>
                {prs.map((pr) => {
                  const badge = STATUS_BADGE[pr.status];
                  const isPending = pr.status === 'Pending';
                  return (
                    <tr key={pr.pr_no} className="border-b align-top">
                      <td className="py-2 pr-3 whitespace-nowrap font-medium">{pr.pr_no}<div className="text-xs font-normal text-muted-foreground">{pr.pr_date ?? ''}</div></td>
                      <td className="py-2 pr-3">
                        <ul className="space-y-0.5">
                          {pr.lines.map((l, i) => (
                            <li key={i}>{l.item_id} × {l.request_qty}{l.uom ? ` ${l.uom}` : ''}{l.reason ? <span className="text-xs text-muted-foreground"> — {l.reason}</span> : null}</li>
                          ))}
                        </ul>
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">{pr.requested_by ?? '-'}</td>
                      <td className="py-2 pr-3"><Badge variant={badge?.variant ?? 'muted'} className="text-[10px]">{badge ? t(badge.key) : pr.status}</Badge>{pr.approved_by ? <div className="text-xs text-muted-foreground">{t('iv.req_by')} {pr.approved_by}</div> : null}</td>
                      <td className="py-2 pr-3">
                        <div className="flex justify-end gap-2">
                          {q.data?.can_approve && isPending && (
                            <>
                              <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ prNo: pr.pr_no, approve: true })}>{t('fin.approve')}</Button>
                              <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ prNo: pr.pr_no, approve: false })}>{t('iv.req_reject')}</Button>
                            </>
                          )}
                          {q.data?.can_approve && pr.status === 'Approved' && (
                            <Button size="sm" onClick={() => setConverting(pr)}>{t('iv.req_create_po')}</Button>
                          )}
                          {!q.data?.can_approve && isPending && (
                            <Button size="sm" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate(pr.pr_no)}>{t('fin.cancel')}</Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {converting && <PrToPoForm pr={converting} onDone={() => { setConverting(null); refresh(); }} onCancel={() => setConverting(null)} />}
      </CardContent>
    </Card>
  );
}

// PR → PO conversion. Each PR line (a free-text name from chat) is reconciled to a real item: search the
// master and pick a match, OR tick "สินค้าใหม่" to open a new code. Procurement adds vendor + unit prices,
// then submits — the API raises the PO through the normal path and links/closes the PR.
type ConvLine = { name: string; item_id: string; item_description: string; create_item: boolean; order_qty: number; unit_price: number; uom: string; matches: ItemMatch[]; searching: boolean; searched: boolean };

function PrToPoForm({ pr, onDone, onCancel }: { pr: Pr; onDone: () => void; onCancel: () => void }) {
  const { t } = useLang();
  const [vendor, setVendor] = useState('');
  const [vendorId, setVendorId] = useState<number | null>(null);
  const [vendorMatches, setVendorMatches] = useState<VendorMatch[]>([]);
  const [vendorSearching, setVendorSearching] = useState(false);
  const searchVendor = async () => {
    if (!vendor.trim()) return;
    setVendorSearching(true);
    try { const r = await api<{ vendors: VendorMatch[] }>(`/api/procurement/vendors/search?q=${encodeURIComponent(vendor)}`); setVendorMatches(r.vendors); }
    catch (e: any) { notifyError(e.message); } finally { setVendorSearching(false); }
  };
  const [lines, setLines] = useState<ConvLine[]>(() => pr.lines.map((l) => ({
    name: l.item_id, item_id: l.item_id, item_description: '', create_item: false,
    order_qty: l.request_qty, unit_price: 0, uom: l.uom ?? '', matches: [], searching: false, searched: false,
  })));
  const setLine = (i: number, patch: Partial<ConvLine>) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const search = async (i: number) => {
    setLine(i, { searching: true });
    try {
      const r = await api<{ items: ItemMatch[] }>(`/api/procurement/items/search?q=${encodeURIComponent(lines[i]!.item_id || lines[i]!.name)}`);
      setLine(i, { matches: r.items, searched: true });
    } catch (e: any) { notifyError(e.message); } finally { setLine(i, { searching: false }); }
  };
  const submit = useMutation({
    mutationFn: () => api<{ po_no: string; created_items: string[] }>(`/api/procurement/prs/${pr.pr_no}/to-po`, {
      method: 'POST',
      body: JSON.stringify({
        vendor_id: vendorId ?? undefined,
        vendor_name: vendor.trim() || undefined,
        lines: lines.map((l) => ({ item_id: l.item_id.trim(), item_description: l.item_description.trim() || undefined, create_item: l.create_item, order_qty: Number(l.order_qty), unit_price: Number(l.unit_price) || 0, uom: l.uom.trim() || undefined })),
      }),
    }),
    onSuccess: (r) => { notifySuccess(`${t('iv.req_toast_po_created', { po: r.po_no })}${r.created_items?.length ? t('iv.req_toast_new_codes', { count: r.created_items.length }) : ''}`); onDone(); },
    onError: (e: any) => notifyError(e.message),
  });
  const canSubmit = lines.every((l) => l.item_id.trim() && Number(l.order_qty) > 0);

  // Modal dialog (portal + fixed overlay) so tapping "สร้าง PO" always surfaces the panel over the
  // current viewport. Rendered inline before (below the whole register table) it opened off-screen on a
  // phone, so the button read as unresponsive — the reported bug.
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="max-h-[90vh] gap-3 overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{t('iv.req_create_po_from', { pr: pr.pr_no })}</DialogTitle>
      </DialogHeader>
      <div className="max-w-lg space-y-1">
        <Label className="text-xs">{t('iv.req_vendor')}{vendorId ? t('iv.req_vendor_selected') : ''}</Label>
        <div className="flex gap-2">
          <Input value={vendor} onChange={(e) => { setVendor(e.target.value); setVendorId(null); setVendorMatches([]); }} placeholder={t('iv.req_vendor_ph')} />
          <Button type="button" variant="outline" size="sm" disabled={vendorSearching || !vendor.trim()} onClick={searchVendor}>{vendorSearching ? '…' : t('iv.req_search_vendor')}</Button>
        </div>
        {vendorMatches.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            <span className="text-xs text-muted-foreground">{t('iv.req_choose')}</span>
            {vendorMatches.map((v) => (
              <button key={v.id} type="button" onClick={() => { setVendor(v.name); setVendorId(v.id); setVendorMatches([]); }}
                className="rounded border bg-muted px-2 py-0.5 text-xs hover:bg-accent">{v.name}{v.vendor_code ? ` (${v.vendor_code})` : ''}</button>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t('iv.req_vendor_note')}</p>
      </div>
      <div className="space-y-3">
        {lines.map((l, i) => (
          <div key={i} className="rounded-md border bg-card p-3">
            <div className="mb-2 text-xs text-muted-foreground">{t('iv.req_from_request')} <span className="font-medium text-foreground">{l.name}</span></div>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <div className="space-y-1">
                <Label className="text-xs">{t('iv.req_item_code')} {l.create_item ? t('iv.req_item_new') : t('iv.req_item_match')}</Label>
                <div className="flex gap-2">
                  <Input value={l.item_id} onChange={(e) => setLine(i, { item_id: e.target.value, searched: false, matches: [] })} placeholder={t('iv.req_item_code')} />
                  <Button type="button" variant="outline" size="sm" disabled={l.searching} onClick={() => search(i)}>{l.searching ? '…' : t('iv.req_search_match')}</Button>
                </div>
                {l.matches.length > 0 && !l.create_item && (
                  <div className="flex flex-wrap gap-1 pt-1">
                    <span className="text-xs text-muted-foreground">{t('iv.req_choose_code')}</span>
                    {l.matches.map((m) => (
                      <button key={m.item_id} type="button" onClick={() => setLine(i, { item_id: m.item_id, uom: m.uom ?? l.uom, unit_price: (m.last_price ?? m.unit_price) || l.unit_price, matches: [], searched: false })}
                        className="rounded border bg-muted px-2 py-0.5 text-xs hover:bg-accent">
                        {m.item_id}{m.item_description ? ` — ${m.item_description}` : ''}{m.last_price ? ` · ${t('iv.req_latest')} ฿${m.last_price}` : ''}
                      </button>
                    ))}
                  </div>
                )}
                {l.searched && l.matches.length === 0 && !l.create_item && (
                  <p className="pt-1 text-xs text-warning">
                    {t('iv.req_not_found', { id: l.item_id })}
                  </p>
                )}
                <label className="flex items-center gap-1 pt-1 text-xs text-muted-foreground">
                  <input type="checkbox" checked={l.create_item} onChange={(e) => setLine(i, { create_item: e.target.checked })} />
                  {t('iv.req_open_new_item')}
                </label>
                {l.create_item && (
                  <Input className="mt-1" value={l.item_description} onChange={(e) => setLine(i, { item_description: e.target.value })} placeholder={t('iv.req_new_item_ph')} />
                )}
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <div className="w-20 space-y-1"><Label className="text-xs">{t('inv.col_qty')}</Label><Input type="number" value={l.order_qty} onChange={(e) => setLine(i, { order_qty: Number(e.target.value) })} /></div>
                <div className="w-20 space-y-1"><Label className="text-xs">{t('inv.col_uom')}</Label><Input value={l.uom} onChange={(e) => setLine(i, { uom: e.target.value })} /></div>
                <div className="w-24 space-y-1"><Label className="text-xs">{t('iv.req_unit_price')}</Label><Input type="number" value={l.unit_price} onChange={(e) => setLine(i, { unit_price: Number(e.target.value) })} /></div>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <Button size="sm" disabled={!canSubmit || submit.isPending} onClick={() => submit.mutate()}>{submit.isPending ? t('iv.req_creating') : t('iv.req_create_po_btn')}</Button>
        <span className="text-xs text-muted-foreground">{t('iv.req_submit_note')}</span>
      </div>
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
