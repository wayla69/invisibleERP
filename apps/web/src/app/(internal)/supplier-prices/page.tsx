'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Tag, History, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { ModulePage } from '@/components/module-page';
import { DataTable } from '@/components/data-table';
import { StatCard } from '@/components/stat-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';

interface SupplierPrice {
  id: number; vendor_id: number; vendor_name: string | null;
  item_id: string; item_description: string | null;
  uom: string; currency: string; unit_price: number; min_qty: number;
  effective_from: string; effective_to: string | null; notes: string | null;
}
interface PriceHistory {
  id: number; uom: string; currency: string; unit_price: number; min_qty: number;
  effective_from: string; effective_to: string | null; status: string; notes: string | null;
  created_by: string | null; created_at: string | null;
}
interface ListResp { prices: SupplierPrice[]; count: number }
interface HistoryResp { vendor_id: number; item_id: string; history: PriceHistory[] }

const today = new Date().toISOString().slice(0, 10);
const EMPTY = { vendor_id: '', item_id: '', item_description: '', uom: 'EA', currency: 'THB', unit_price: '', min_qty: '1', effective_from: today, notes: '' };

export default function SupplierPricesPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [vendorFilter, setVendorFilter] = useState('');
  const [itemFilter, setItemFilter] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [historyRow, setHistoryRow] = useState<SupplierPrice | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [err, setErr] = useState('');

  const params = new URLSearchParams();
  if (vendorFilter) params.set('vendor_id', vendorFilter);
  if (itemFilter) params.set('item_id', itemFilter);
  const qs = params.toString();

  const q = useQuery<ListResp>({
    queryKey: ['supplier-prices', vendorFilter, itemFilter],
    queryFn: () => api(`/api/procurement/supplier-prices${qs ? `?${qs}` : ''}`),
  });

  const hq = useQuery<HistoryResp>({
    queryKey: ['supplier-price-history', historyRow?.vendor_id, historyRow?.item_id],
    queryFn: () => api(`/api/procurement/supplier-prices/history?vendor_id=${historyRow!.vendor_id}&item_id=${encodeURIComponent(historyRow!.item_id)}`),
    enabled: historyRow != null,
  });

  const mut = useMutation({
    mutationFn: (body: object) => api('/api/procurement/supplier-prices', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['supplier-prices'] }); setCreateOpen(false); setForm(EMPTY); setErr(''); },
    onError: (e: any) => setErr(e?.message ?? t('iv.spr_error')),
  });

  const handleSubmit = () => {
    if (!form.vendor_id || !form.item_id || !form.unit_price || !form.effective_from) { setErr(t('iv.spr_required')); return; }
    mut.mutate({ vendor_id: Number(form.vendor_id), item_id: form.item_id, item_description: form.item_description || undefined, uom: form.uom || 'EA', currency: form.currency || 'THB', unit_price: Number(form.unit_price), min_qty: Number(form.min_qty) || 1, effective_from: form.effective_from, notes: form.notes || undefined });
  };

  const d = q.data;

  return (
    <ModulePage
      title={t('iv.spr_title')}
      description={t('iv.spr_desc')}
      query={q}
      actions={
        <Button size="sm" onClick={() => { setForm(EMPTY); setErr(''); setCreateOpen(true); }}>
          <Plus className="mr-1.5 size-4" />{t('iv.spr_save_new')}
        </Button>
      }
      toolbar={
        <>
          <Input className="w-40" placeholder="Vendor ID" value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)} aria-label={t('iv.spr_filter_vendor')} />
          <Input className="w-48" placeholder={t('iv.spr_item_ph')} value={itemFilter} onChange={(e) => setItemFilter(e.target.value)} aria-label={t('iv.spr_filter_item')} />
        </>
      }
      stats={d && (
        <>
          <StatCard label={t('iv.spr_active_prices')} value={num(d.count)} icon={Tag} tone="primary" />
        </>
      )}
    >
      {d && (
        <DataTable
          rows={d.prices}
          rowKey={(r) => String(r.id)}
          emptyState={{ icon: Tag, title: t('iv.spr_empty_title'), description: t('iv.spr_empty_desc') }}
          columns={[
            { key: 'vendor_name', label: t('iv.spr_col_supplier'), render: (r) => <span className="font-medium">{r.vendor_name ?? `#${r.vendor_id}`}</span> },
            { key: 'item_id', label: t('iv.spr_col_item'), render: (r) => <span className="font-mono text-xs">{r.item_id}</span> },
            { key: 'item_description', label: t('inv.col_name'), render: (r) => r.item_description ?? '—' },
            { key: 'uom', label: t('inv.col_uom') },
            { key: 'unit_price', label: t('iv.spr_col_unit_price'), align: 'right', render: (r) => <span className="tabular font-medium">{num(r.unit_price)} {r.currency}</span> },
            { key: 'min_qty', label: t('iv.spr_col_min_qty'), align: 'right', render: (r) => <span className="tabular">{num(r.min_qty)}</span> },
            { key: 'effective_from', label: t('iv.spr_col_eff_from'), render: (r) => r.effective_from },
            { key: 'effective_to', label: t('iv.spr_col_eff_to'), render: (r) => r.effective_to ?? <Badge variant="outline" className="text-xs">{t('iv.spr_open_ended')}</Badge> },
            { key: 'history', label: '', render: (r) => (
              <Button size="icon" variant="ghost" title={t('iv.spr_version_history')} onClick={() => setHistoryRow(r)}>
                <History className="size-4" />
              </Button>
            )},
          ]}
        />
      )}

      {/* Create / version price dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{t('iv.spr_dialog_title')}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="sp-vid">Vendor ID *</Label>
              <Input id="sp-vid" type="number" placeholder="1" value={form.vendor_id} onChange={(e) => setForm((f) => ({ ...f, vendor_id: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sp-iid">{t('iv.spr_item_label')}</Label>
              <Input id="sp-iid" placeholder="ITEM-001" value={form.item_id} onChange={(e) => setForm((f) => ({ ...f, item_id: e.target.value }))} />
            </div>
            <div className="col-span-2 space-y-1">
              <Label htmlFor="sp-idesc">{t('inv.col_name')}</Label>
              <Input id="sp-idesc" placeholder={t('iv.spr_item_desc_ph')} value={form.item_description} onChange={(e) => setForm((f) => ({ ...f, item_description: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sp-uom">{t('inv.col_uom')}</Label>
              <Input id="sp-uom" placeholder="EA" value={form.uom} onChange={(e) => setForm((f) => ({ ...f, uom: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sp-cur">{t('iv.spr_currency')}</Label>
              <Input id="sp-cur" placeholder="THB" value={form.currency} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sp-price">{t('iv.spr_unit_price_req')}</Label>
              <Input id="sp-price" type="number" step="0.0001" placeholder="0.00" value={form.unit_price} onChange={(e) => setForm((f) => ({ ...f, unit_price: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sp-minqty">{t('iv.spr_col_min_qty')}</Label>
              <Input id="sp-minqty" type="number" step="0.0001" placeholder="1" value={form.min_qty} onChange={(e) => setForm((f) => ({ ...f, min_qty: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sp-from">{t('iv.spr_eff_from_req')}</Label>
              <Input id="sp-from" type="date" value={form.effective_from} onChange={(e) => setForm((f) => ({ ...f, effective_from: e.target.value }))} />
            </div>
            <div className="col-span-2 space-y-1">
              <Label htmlFor="sp-notes">{t('proc.remarks')}</Label>
              <Input id="sp-notes" placeholder={t('iv.spr_notes_ph')} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>
          {err && <p className="text-sm text-destructive">{err}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t('fin.cancel')}</Button>
            <Button onClick={handleSubmit} disabled={mut.isPending}>{mut.isPending ? t('iv.spr_saving') : t('fin.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Version history sheet */}
      <Sheet open={historyRow != null} onOpenChange={(o) => { if (!o) setHistoryRow(null); }}>
        <SheetContent className="w-[560px] sm:max-w-[560px]">
          <SheetHeader>
            <SheetTitle>{t('iv.spr_history_title', { item: historyRow?.item_description ?? historyRow?.item_id, vendor: historyRow?.vendor_name ?? `Vendor #${historyRow?.vendor_id}` })}</SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            {hq.isLoading && <p className="text-sm text-muted-foreground">{t('dash.loading')}</p>}
            {hq.data && (
              <DataTable
                rows={hq.data.history}
                rowKey={(r) => String(r.id)}
                emptyState={{ icon: History, title: t('iv.spr_no_history'), description: '' }}
                columns={[
                  { key: 'unit_price', label: t('iv.spr_col_price'), align: 'right', render: (r) => <span className="tabular">{num(r.unit_price)} {r.currency}</span> },
                  { key: 'effective_from', label: t('iv.spr_col_from'), render: (r) => r.effective_from },
                  { key: 'effective_to', label: t('iv.spr_col_to'), render: (r) => r.effective_to ?? '—' },
                  { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={r.status === 'active' ? 'success' : 'secondary'}>{r.status === 'active' ? t('iv.spr_status_active') : t('iv.spr_status_old')}</Badge> },
                  { key: 'created_by', label: t('iv.spr_col_by'), render: (r) => r.created_by ?? '—' },
                ]}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </ModulePage>
  );
}
