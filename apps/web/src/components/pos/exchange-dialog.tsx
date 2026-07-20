// docs/52 Phase 4e — POS exchange dialog (even / partial). Returns the original line(s) and rings the
// replacement line(s) in ONE atomic call (POST /api/pos/exchange), settled by netting through store credit —
// the customer pays only the difference (even swap = no cash; down-swap = residual store credit).
// NOTE: no 'use client' directive — this island is imported only by the register page (already a client
// boundary), so it inherits that boundary and does NOT add to the use-client ratchet (see state-view.tsx).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { num } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DocSelect } from '@/components/doc-select';

interface SaleItem { id: number; itemId: string; itemDescription: string | null; qty: string; unitPrice: string }
interface SaleDetail { order: { saleNo: string }; items: SaleItem[] }
interface CatItem { item_id: string; item_description: string | null; uom: string | null; unit_price: number }
interface RetLine { sale_item_id: number; item_id: string; name: string; sold_qty: number; return_qty: number; unit_price: number }
interface NewLine { key: string; item_id: string; name: string; qty: number; unit_price: number }
interface ExchangeResult {
  exchange_no: string; return_no: string; new_sale_no: string; credit_note_no: string | null;
  net_difference: number; cash_collected: number; residual_store_credit: number; even: boolean;
}

// Catalog typeahead — searches the procurement catalog (debounced) and reports the chosen item + base price.
function NewItemSearch({ onPick }: { onPick: (item: CatItem) => void }) {
  const { t } = useLang();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const id = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(id); }, [q]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  const search = useQuery<{ items: CatItem[] }>({
    queryKey: ['exc-item-search', debounced],
    queryFn: () => api(`/api/procurement/catalog?limit=8&q=${encodeURIComponent(debounced)}`),
    enabled: open && debounced.length > 0,
  });
  const results = search.data?.items ?? [];
  return (
    <div ref={boxRef} className="relative">
      <Input placeholder={t('px.exc_item_ph')} value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} autoComplete="off" />
      {open && debounced.length > 0 && (
        <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-popover p-1 shadow-md">
          {search.isLoading && <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('hx.common.saving')}</p>}
          {!search.isLoading && results.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('px.exc_no_match')}</p>}
          {results.map((it) => (
            <button
              key={it.item_id}
              type="button"
              className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => { onPick(it); setQ(''); setDebounced(''); setOpen(false); }}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{it.item_description || it.item_id}</span>
                <span className="block truncate text-xs text-muted-foreground">{it.item_id}{it.uom ? ` · ${it.uom}` : ''}</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">฿{num(it.unit_price)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ExchangeDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useLang();
  const [saleNo, setSaleNo] = useState('');
  const [searched, setSearched] = useState('');
  const [retLines, setRetLines] = useState<RetLine[]>([]);
  const [newLines, setNewLines] = useState<NewLine[]>([]);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [result, setResult] = useState<ExchangeResult | null>(null);
  const keyRef = useRef(0);

  const saleQ = useQuery<SaleDetail>({
    queryKey: ['exc-sale-detail', searched],
    queryFn: () => api(`/api/pos/orders/${encodeURIComponent(searched)}`),
    enabled: searched.length > 0,
  });
  useEffect(() => {
    if (saleQ.data) {
      setRetLines(saleQ.data.items.map((it) => ({
        sale_item_id: it.id, item_id: it.itemId, name: it.itemDescription ?? it.itemId,
        sold_qty: Number(it.qty), return_qty: 0, unit_price: Number(it.unitPrice),
      })));
      setErr('');
    }
  }, [saleQ.data]);

  // Recent POS sales — the original bill is picked from a dropdown, not typed (manual escape kept).
  const salesQ = useQuery<{ orders?: { Sale_No: string; Status: string; Total: string }[] }>({ queryKey: ['exc-sales'], queryFn: () => api('/api/pos/orders?limit=50'), retry: false });
  const saleOptions = (salesQ.data?.orders ?? [])
    .filter((o) => o.Status !== 'Voided')
    .map((o) => ({ value: o.Sale_No, label: [o.Status, `฿${num(o.Total)}`].filter(Boolean).join(' · ') || undefined }));

  const pickSale = (v: string) => { setSaleNo(v); setRetLines([]); setResult(null); setErr(''); if (v.trim()) setSearched(v.trim()); };
  const setReturnQty = (idx: number, val: number) => setRetLines((prev) => prev.map((it, i) => i === idx ? { ...it, return_qty: Math.max(0, Math.min(it.sold_qty, val)) } : it));
  const addNewItem = (it: CatItem) => setNewLines((prev) => {
    const existing = prev.find((l) => l.item_id === it.item_id);
    if (existing) return prev.map((l) => l.item_id === it.item_id ? { ...l, qty: l.qty + 1 } : l);
    return [...prev, { key: `n${keyRef.current++}`, item_id: it.item_id, name: it.item_description ?? it.item_id, qty: 1, unit_price: Number(it.unit_price) }];
  });
  const setNewQty = (key: string, val: number) => setNewLines((prev) => prev.flatMap((l) => l.key !== key ? [l] : (val <= 0 ? [] : [{ ...l, qty: val }])));
  const setNewPrice = (key: string, val: number) => setNewLines((prev) => prev.map((l) => l.key === key ? { ...l, unit_price: Math.max(0, val) } : l));
  const removeNew = (key: string) => setNewLines((prev) => prev.filter((l) => l.key !== key));

  const returnedSub = useMemo(() => retLines.reduce((a, l) => a + l.return_qty * l.unit_price, 0), [retLines]);
  const newSub = useMemo(() => newLines.reduce((a, l) => a + l.qty * l.unit_price, 0), [newLines]);
  const approxDiff = Math.round((newSub - returnedSub) * 100) / 100;

  const mut = useMutation({
    mutationFn: (body: object) => api<ExchangeResult>('/api/pos/exchange', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (res) => setResult(res),
    onError: (e: Error) => setErr(e.message || t('hx.common.error')),
  });

  const submit = () => {
    const rets = retLines.filter((l) => l.return_qty > 0);
    if (!rets.length) { setErr(t('px.exc_need_return')); return; }
    if (!newLines.length) { setErr(t('px.exc_need_new')); return; }
    if (!reason.trim()) { setErr(t('px.exc_need_reason')); return; }
    setErr('');
    mut.mutate({
      sale_no: searched,
      return_items: rets.map((l) => ({ sale_item_id: l.sale_item_id, qty: l.return_qty })),
      new_items: newLines.map((l) => ({ item_id: l.item_id, item_description: l.name, qty: l.qty, unit_price: l.unit_price })),
      reason: reason.trim(),
    });
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>{t('px.exc_title')}</DialogTitle></DialogHeader>

        {result ? (
          <div className="space-y-3 py-2">
            <p className="font-medium text-success">{t('px.exc_success')}</p>
            <div className="space-y-1 rounded-lg border p-4 text-sm">
              <Row label={t('px.exc_no')} value={<span className="font-medium">{result.exchange_no}</span>} />
              <Row label={t('px.exc_new_sale')} value={result.new_sale_no} />
              {result.even ? (
                <p className="pt-1 font-medium text-success">{t('px.exc_even')}</p>
              ) : result.net_difference > 0 ? (
                <Row label={t('px.exc_cash')} value={<span className="font-medium">฿{num(result.cash_collected)}</span>} />
              ) : (
                <Row label={t('px.exc_residual')} value={<span className="font-medium">฿{num(result.residual_store_credit)}</span>} />
              )}
              {result.credit_note_no && <Row label={t('px.exc_credit_note')} value={result.credit_note_no} />}
            </div>
            <DialogFooter><Button onClick={onDone}>{t('hx.common.close')}</Button></DialogFooter>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <p className="text-xs text-muted-foreground">{t('px.exc_hint')}</p>

            {/* Step 1: original bill */}
            <div className="space-y-1.5">
              <Label>{t('px.exc_sale_label')}</Label>
              <DocSelect value={saleNo} onValueChange={pickSale} options={saleOptions} placeholder={t('common.doc_select_ph')} emptyText={t('common.doc_none')} allowManual manualPlaceholder="SALE-0001-xxxxxx" />
              {saleQ.isError && <p className="text-xs text-destructive">{t('px.exc_sale_not_found')}</p>}
            </div>

            {/* Step 2: items to return */}
            {retLines.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">{t('px.exc_return_items')}</p>
                <div className="divide-y rounded-lg border">
                  {retLines.map((it, idx) => (
                    <div key={it.sale_item_id} className="flex items-center gap-3 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{it.name}</p>
                        <p className="text-xs text-muted-foreground">฿{num(it.unit_price)} × {num(it.sold_qty)} {t('px.exc_pcs')}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button type="button" className="flex size-7 items-center justify-center rounded border hover:bg-accent" onClick={() => setReturnQty(idx, it.return_qty - 1)}>−</button>
                        <input type="number" min={0} max={it.sold_qty} value={it.return_qty} onChange={(e) => setReturnQty(idx, Number(e.target.value))} className="w-14 rounded border px-2 py-1 text-center text-sm" />
                        <button type="button" className="flex size-7 items-center justify-center rounded border hover:bg-accent" onClick={() => setReturnQty(idx, it.return_qty + 1)}>+</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Step 3: replacement items */}
            {retLines.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">{t('px.exc_new_items')}</p>
                <NewItemSearch onPick={addNewItem} />
                {newLines.length > 0 && (
                  <div className="divide-y rounded-lg border">
                    {newLines.map((l) => (
                      <div key={l.key} className="flex items-center gap-2 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{l.name}</p>
                          <p className="text-xs text-muted-foreground">{l.item_id}</p>
                        </div>
                        <input type="number" min={0} step="0.01" value={l.unit_price} onChange={(e) => setNewPrice(l.key, Number(e.target.value))} className="w-20 rounded border px-2 py-1 text-right text-sm" aria-label={t('px.exc_price')} />
                        <div className="flex shrink-0 items-center gap-1.5">
                          <button type="button" className="flex size-7 items-center justify-center rounded border hover:bg-accent" onClick={() => setNewQty(l.key, l.qty - 1)}>−</button>
                          <input type="number" min={1} value={l.qty} onChange={(e) => setNewQty(l.key, Number(e.target.value))} className="w-12 rounded border px-2 py-1 text-center text-sm" />
                          <button type="button" className="flex size-7 items-center justify-center rounded border hover:bg-accent" onClick={() => setNewQty(l.key, l.qty + 1)}>+</button>
                        </div>
                        <button type="button" aria-label={t('hx.common.close')} className="text-muted-foreground hover:text-destructive" onClick={() => removeNew(l.key)}><X className="size-4" /></button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Step 4: net preview + reason */}
            {retLines.length > 0 && (returnedSub > 0 || newSub > 0) && (
              <div className="space-y-1 rounded-lg border bg-muted/30 p-3 text-sm">
                <Row label={t('px.exc_returned_val')} value={`฿${num(returnedSub)}`} />
                <Row label={t('px.exc_new_val')} value={`฿${num(newSub)}`} />
                <div className="flex justify-between border-t pt-1 font-medium">
                  <span>{approxDiff === 0 ? t('px.exc_even') : approxDiff > 0 ? t('px.exc_pay_approx') : t('px.exc_residual_approx')}</span>
                  <span>{approxDiff === 0 ? '฿0' : `฿${num(Math.abs(approxDiff))}`}</span>
                </div>
                <p className="pt-0.5 text-[11px] text-muted-foreground">{t('px.exc_vat_note')}</p>
              </div>
            )}

            {retLines.length > 0 && (
              <div className="space-y-1">
                <Label>{t('px.exc_reason')}</Label>
                <Input placeholder={t('px.exc_reason_ph')} value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
            )}

            {err && <p className="text-sm text-destructive">{err}</p>}

            <DialogFooter>
              <Button variant="outline" onClick={onClose}>{t('fin.cancel')}</Button>
              <Button onClick={submit} disabled={mut.isPending || retLines.length === 0}>
                {mut.isPending ? t('hx.common.saving') : t('px.exc_submit')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="flex justify-between gap-2"><span className="text-muted-foreground">{label}</span><span>{value}</span></div>;
}
