'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Banknote, PackageCheck, Plus, Receipt, RotateCcw, SearchX, Undo2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { useMe, hasPerm } from '@/lib/auth';
import { num, thaiDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ModulePage } from '@/components/module-page';
import { SearchInput } from '@/components/search-input';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/form-controls';

// Returns register (REV-07): tenant-wide view of POS returns/refunds for ops · finance · audit —
// refund method, amount, restocked status, GL journal + credit-note links, with a per-return drill-down.


interface Ret {
  return_no: string; sale_no: string; refund_no: string | null; refund_method: string | null;
  subtotal_returned: number; vat_returned: number; total_returned: number; restocked: boolean;
  journal_no: string | null; credit_note_no: string | null; status: string; return_date: string | null;
}
interface RegResp { returns: Ret[]; count: number; total_count: number; total_refunded: number; restocked_count: number }
interface RetDetail extends Ret { items: { item_id: string; name: string; qty: number; amount: number; restocked: boolean }[] }

interface SaleItem { id: number; itemId: string; itemDescription: string | null; qty: string; unitPrice: string; amount: string; uom: string | null }
interface SaleDetail { order: { saleNo: string; total: string; saleDate: string | null }; items: SaleItem[] }

export default function ReturnsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const me = useMe();
  const canRefund = hasPerm(me.data, 'pos_refund', 'pos', 'ar'); // SoD R12: authorize refunds = pos_refund duty
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [method, setMethod] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => { const timer = setTimeout(() => setDebounced(search), 300); return () => clearTimeout(timer); }, [search]);

  const q = useQuery<RegResp>({
    queryKey: ['returns-register', debounced, method],
    queryFn: () => api(`/api/pos/returns?limit=200${debounced ? `&search=${encodeURIComponent(debounced)}` : ''}${method ? `&method=${encodeURIComponent(method)}` : ''}`),
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  const filtering = debounced.length > 0 || !!method;

  return (
    <ModulePage
      title={t('hx.ret.title')}
      description={t('hx.ret.desc')}
      query={q}
      actions={
        // SoD R12: creating/authorizing a return requires pos_refund (POS Supervisor) — a Cashier
        // (pos_sell only) can view the register but cannot issue refunds from this page.
        canRefund ? (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 size-4" />{t('hx.ret.record_btn')}
          </Button>
        ) : undefined
      }
      toolbar={
        <>
          <SearchInput value={search} onChange={setSearch} placeholder={t('hx.ret.search_ph')} ariaLabel={t('hx.ret.search_aria')} count={d ? t('hx.common.count_items', { n: num(d.count) }) : undefined} />
          <Select className="w-auto" value={method} onChange={(e) => setMethod(e.target.value)} aria-label={t('hx.ret.filter_method')}>
            <option value="">{t('hx.ret.all_methods')}</option>
            <option value="Cash">{t('hx.ret.m_cash')}</option>
            <option value="Transfer">{t('hx.ret.m_transfer')}</option>
            <option value="Card">{t('hx.ret.m_card')}</option>
            <option value="StoreCredit">{t('hx.ret.m_store_credit')}</option>
          </Select>
          {q.isFetching && !q.isLoading && <span className="text-xs text-muted-foreground">{t('hx.common.updating')}</span>}
        </>
      }
      stats={
        d && (
          <>
            <StatCard label={t('hx.ret.stat_count')} value={num(d.total_count)} icon={Undo2} tone="primary" />
            <StatCard label={t('hx.ret.stat_refunded')} value={`฿${num(d.total_refunded)}`} icon={Banknote} hint={t('hx.ret.incl_tax')} />
            <StatCard label={t('hx.ret.stat_restocked')} value={`${num(d.restocked_count)} / ${num(d.total_count)}`} icon={PackageCheck} tone={d.restocked_count > 0 ? 'success' : 'default'} hint={t('hx.ret.restocked_hint')} />
          </>
        )
      }
      statsClassName="xl:grid-cols-3"
    >
      {d && (
        <>
          <DataTable
            rows={d.returns}
            rowKey={(r) => r.return_no}
            emptyState={
              filtering
                ? { icon: SearchX, title: t('hx.ret.no_match_title'), description: t('hx.ret.no_match_desc'), action: <Button variant="outline" size="sm" onClick={() => { setSearch(''); setMethod(''); }}>{t('inv.clear_filter')}</Button> }
                : { icon: RotateCcw, title: t('hx.ret.empty_title'), description: t('hx.ret.empty_desc') }
            }
            columns={[
              { key: 'return_no', label: t('hx.ret.col_return_no'), render: (r) => <button onClick={() => setSelected(r.return_no)} className={cn('font-medium text-primary hover:underline', selected === r.return_no && 'underline')}>{r.return_no}</button> },
              { key: 'return_date', label: t('dash.col_date'), render: (r) => (r.return_date ? thaiDate(r.return_date) : '—') },
              { key: 'sale_no', label: t('hx.ret.col_sale_no') },
              { key: 'refund_method', label: t('hx.ret.col_method'), render: (r) => <Badge variant="outline">{r.refund_method ?? '—'}</Badge> },
              { key: 'total_returned', label: t('hx.ret.col_total'), align: 'right', render: (r) => <span className="tabular font-medium">฿{num(r.total_returned)}</span> },
              { key: 'restocked', label: t('hx.ret.col_restocked'), render: (r) => (r.restocked ? <Badge variant="secondary">{t('hx.ret.restocked_yes')}</Badge> : <span className="text-muted-foreground">—</span>) },
              { key: 'journal_no', label: t('hx.ret.col_je'), render: (r) => r.journal_no ?? '—' },
            ]}
          />
          {selected && <ReturnDetail returnNo={selected} onClose={() => setSelected(null)} />}
        </>
      )}

      {createOpen && (
        <CreateReturnDialog
          onClose={() => setCreateOpen(false)}
          onDone={() => { setCreateOpen(false); qc.invalidateQueries({ queryKey: ['returns-register'] }); }}
        />
      )}
    </ModulePage>
  );
}

// ── Return detail panel ──
function ReturnDetail({ returnNo, onClose }: { returnNo: string; onClose: () => void }) {
  const { t } = useLang();
  const q = useQuery<RetDetail>({ queryKey: ['return-detail', returnNo], queryFn: () => api(`/api/pos/returns/${encodeURIComponent(returnNo)}`) });
  const r = q.data;
  return (
    <Card className="mt-5 gap-3 p-5">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-semibold"><Receipt className="size-4" /> {t('hx.ret.detail_title', { no: returnNo })}</h3>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label={t('hx.common.close')}><X className="size-4" /></Button>
      </div>
      <StateView q={q}>
        {r && (
          <div className="space-y-4">
            <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <Info label={t('hx.ret.orig_sale')} value={r.sale_no} />
              <Info label={t('hx.ret.refund_doc')} value={r.refund_no ?? '—'} />
              <Info label={t('hx.ret.col_method')} value={r.refund_method ?? '—'} />
              <Info label={t('dash.col_date')} value={r.return_date ? thaiDate(r.return_date) : '—'} />
              <Info label={t('hx.ret.subtotal')} value={`฿${num(r.subtotal_returned)}`} />
              <Info label={t('hx.ret.vat')} value={`฿${num(r.vat_returned)}`} />
              <Info label={t('hx.ret.total_refund')} value={`฿${num(r.total_returned)}`} />
              <Info label={t('hx.ret.cn_je')} value={`${r.credit_note_no ?? '—'} · ${r.journal_no ?? '—'}`} />
            </div>
            <DataTable
              rows={r.items}
              rowKey={(it) => it.item_id}
              columns={[
                { key: 'item_id', label: t('hx.ret.col_code') },
                { key: 'name', label: t('hx.ret.col_item') },
                { key: 'qty', label: t('hx.ret.col_return_qty'), align: 'right', render: (it) => <span className="tabular">{num(it.qty)}</span> },
                { key: 'amount', label: t('hx.ret.col_value'), align: 'right', render: (it) => <span className="tabular">฿{num(it.amount)}</span> },
                { key: 'restocked', label: t('hx.ret.col_restocked'), render: (it) => (it.restocked ? <Badge variant="secondary">{t('hx.ret.restocked_yes')}</Badge> : <span className="text-muted-foreground">—</span>) },
              ]}
            />
          </div>
        )}
      </StateView>
    </Card>
  );
}

// ── Create return dialog ──
// value = submitted enum; label = i18n key, rendered via t().
const REFUND_METHODS = [
  { value: 'Cash', label: 'hx.ret.rm_cash' },
  { value: 'Card', label: 'hx.ret.rm_card' },
  { value: 'PromptPay', label: 'hx.ret.rm_promptpay' },
  { value: 'QR', label: 'hx.ret.rm_qr' },
  { value: 'StoreCredit', label: 'hx.ret.rm_store_credit' },
  { value: 'None', label: 'hx.ret.rm_none' },
] as const;

type ReturnItem = { sale_item_id: number; item_id: string; name: string; sold_qty: number; return_qty: number; unit_price: number };

function CreateReturnDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useLang();
  const [saleNo, setSaleNo] = useState('');
  const [searched, setSearched] = useState('');
  const [items, setItems] = useState<ReturnItem[]>([]);
  const [refundMethod, setRefundMethod] = useState<string>('Cash');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<{ return_no: string; total_returned: number; refund_method: string } | null>(null);
  const [err, setErr] = useState('');

  const saleQ = useQuery<SaleDetail>({
    queryKey: ['sale-detail-return', searched],
    queryFn: () => api(`/api/pos/orders/${encodeURIComponent(searched)}`),
    enabled: searched.length > 0,
  });

  // When sale loads, init return items with qty = 0
  useEffect(() => {
    if (saleQ.data) {
      setItems(saleQ.data.items.map((it) => ({
        sale_item_id: it.id,
        item_id: it.itemId,
        name: it.itemDescription ?? it.itemId,
        sold_qty: Number(it.qty),
        return_qty: 0,
        unit_price: Number(it.unitPrice),
      })));
      setErr('');
    }
  }, [saleQ.data]);

  const mut = useMutation({
    mutationFn: (body: object) => api('/api/pos/returns', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (res: any) => setResult({ return_no: res.return_no, total_returned: res.total_returned, refund_method: res.refund_method }),
    onError: (e: any) => setErr(e?.message ?? t('hx.common.error')),
  });

  const doSearch = () => {
    const v = saleNo.trim();
    if (!v) return;
    setItems([]);
    setResult(null);
    setErr('');
    setSearched(v);
  };

  const setReturnQty = (idx: number, val: number) => setItems((prev) => prev.map((it, i) => i === idx ? { ...it, return_qty: Math.max(0, Math.min(it.sold_qty, val)) } : it));

  const handleSubmit = () => {
    const lines = items.filter((it) => it.return_qty > 0);
    if (!lines.length) { setErr(t('hx.ret.need_qty')); return; }
    mut.mutate({
      sale_no: searched,
      items: lines.map((it) => ({ sale_item_id: it.sale_item_id, qty: it.return_qty })),
      reason: reason || undefined,
      refund_method: refundMethod,
    });
  };

  const totalReturn = items.reduce((a, it) => a + it.return_qty * it.unit_price, 0);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>{t('hx.ret.record_btn')}</DialogTitle></DialogHeader>

        {result ? (
          <div className="space-y-3 py-2">
            <p className="font-medium text-success">{t('hx.ret.success')}</p>
            <div className="rounded-lg border p-4 text-sm space-y-1">
              <div className="flex justify-between"><span className="text-muted-foreground">{t('hx.ret.col_return_no')}</span><span className="font-medium">{result.return_no}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t('hx.ret.col_total')}</span><span className="font-medium">฿{num(result.total_returned)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t('hx.ret.col_method')}</span><span>{result.refund_method}</span></div>
            </div>
            <DialogFooter>
              <Button onClick={onDone}>{t('hx.common.close')}</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {/* Step 1: search sale */}
            <div className="space-y-1.5">
              <Label>{t('hx.ret.sale_no_label')}</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="SALE-0001-xxxxxx"
                  value={saleNo}
                  onChange={(e) => setSaleNo(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }}
                />
                <Button variant="outline" onClick={doSearch} disabled={saleQ.isFetching}>
                  {saleQ.isFetching ? t('hx.ret.searching') : t('hx.ret.search_btn')}
                </Button>
              </div>
              {saleQ.isError && <p className="text-xs text-destructive">{t('hx.ret.sale_not_found')}</p>}
            </div>

            {/* Step 2: pick items */}
            {items.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">{t('hx.ret.pick_items')}</p>
                <div className="divide-y rounded-lg border">
                  {items.map((it, idx) => (
                    <div key={it.sale_item_id} className="flex items-center gap-3 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{it.name}</p>
                        <p className="text-xs text-muted-foreground">฿{num(it.unit_price)} × {num(it.sold_qty)} {t('hx.ret.pcs')}</p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button type="button" className="flex size-7 items-center justify-center rounded border hover:bg-accent" onClick={() => setReturnQty(idx, it.return_qty - 1)}>−</button>
                        <input
                          type="number"
                          min={0}
                          max={it.sold_qty}
                          value={it.return_qty}
                          onChange={(e) => setReturnQty(idx, Number(e.target.value))}
                          className="w-14 rounded border px-2 py-1 text-center text-sm"
                        />
                        <button type="button" className="flex size-7 items-center justify-center rounded border hover:bg-accent" onClick={() => setReturnQty(idx, it.return_qty + 1)}>+</button>
                      </div>
                    </div>
                  ))}
                </div>
                {totalReturn > 0 && <p className="text-right text-sm font-medium">{t('hx.ret.est_total')} ฿{num(totalReturn)}</p>}
              </div>
            )}

            {/* Step 3: refund method + reason */}
            {items.length > 0 && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>{t('hx.ret.col_method')}</Label>
                  <Select value={refundMethod} onChange={(e) => setRefundMethod(e.target.value)}>
                    {REFUND_METHODS.map((m) => <option key={m.value} value={m.value}>{t(m.label)}</option>)}
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>{t('hx.ret.reason_opt')}</Label>
                  <Input placeholder={t('hx.ret.reason_ph')} value={reason} onChange={(e) => setReason(e.target.value)} />
                </div>
              </div>
            )}

            {err && <p className="text-sm text-destructive">{err}</p>}

            <DialogFooter>
              <Button variant="outline" onClick={onClose}>{t('fin.cancel')}</Button>
              <Button onClick={handleSubmit} disabled={mut.isPending || items.length === 0}>
                {mut.isPending ? t('hx.common.saving') : t('hx.ret.record_btn')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><p className="text-xs text-muted-foreground">{label}</p><p className="font-medium tabular">{value}</p></div>;
}
