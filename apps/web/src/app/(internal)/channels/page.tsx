'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plug, PlugZap, PackageSearch, RefreshCw, SearchX, Send, ShoppingBag, QrCode, Link2, Copy, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { SearchInput } from '@/components/search-input';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { statusVariant } from '@/components/ui';

const sel = 'h-9 rounded-md border border-input bg-transparent px-3 text-sm';
const PLATFORMS = ['grab', 'lineman', 'foodpanda', 'robinhood'];

export default function ChannelsPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('hx.ch.title')} description={t('hx.ch.desc')} />
      <Tabs tabs={[{ key: 'orders', label: t('hx.ch.tab_orders'), content: <Orders /> }, { key: 'adapters', label: t('hx.ch.tab_adapters'), content: <Adapters /> }, { key: 'avail', label: t('hx.ch.tab_avail'), content: <Availability /> }, { key: 'refs', label: t('hx.ch.tab_refs'), content: <Refs /> }]} />
    </div>
  );
}

function Orders() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['channel-orders'], queryFn: () => api('/api/channels/orders') });
  const setStatus = useMutation({ mutationFn: (v: { no: string; status: string }) => api(`/api/channels/orders/${v.no}/status`, { method: 'POST', body: JSON.stringify({ status: v.status }) }), onSuccess: () => qc.invalidateQueries({ queryKey: ['channel-orders'] }) });
  // G1 (docs/45, control MKT-13): mint a member self-link QR for one channel order. The link page lives
  // under /m (member self-service auth), not this staff app — the URL is opened on the member's device.
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const mintQr = useMutation({
    mutationFn: (no: string) => api<{ url: string }>(`/api/channels/orders/${no}/link-qr`, { method: 'POST' }),
    onSuccess: (r) => setQrUrl(r.url),
    onError: (e: any) => notifyError(e.message),
  });
  const FS = ['accepted', 'preparing', 'ready', 'out_for_delivery', 'completed', 'rejected'];
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const orders: any[] = q.data?.orders ?? [];
  const statuses = useMemo(() => Array.from(new Set(orders.map((o) => o.fulfillment_status).filter(Boolean))), [orders]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return orders.filter((o) => {
      if (statusFilter && o.fulfillment_status !== statusFilter) return false;
      if (!term) return true;
      return [o.order_no, o.ext_order_id, o.platform].some((v) => String(v ?? '').toLowerCase().includes(term));
    });
  }, [orders, search, statusFilter]);
  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <SearchInput value={search} onChange={setSearch} placeholder={t('hx.ch.search_orders_ph')} ariaLabel={t('hx.ch.search_orders_aria')} count={t('hx.common.count_items', { n: filtered.length })} />
            {statuses.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('hx.common.filter_status')}>
                <Button variant={statusFilter === null ? 'secondary' : 'ghost'} size="sm" onClick={() => setStatusFilter(null)}>{t('hx.common.all')}</Button>
                {statuses.map((s) => (
                  <Button key={s} variant={statusFilter === s ? 'secondary' : 'ghost'} size="sm" aria-pressed={statusFilter === s} onClick={() => setStatusFilter((c) => (c === s ? null : s))}>{s}</Button>
                ))}
              </div>
            )}
          </div>
        <DataTable rows={filtered} rowKey={(r: any) => r.order_no} columns={[
          { key: 'order_no', label: t('dash.col_no') },
          { key: 'platform', label: t('hx.ch.col_platform'), render: (r: any) => <Badge>{r.platform}</Badge> },
          { key: 'ext_order_id', label: t('hx.ch.col_ext_ref') },
          { key: 'total', label: t('fin.col_amount'), align: 'right', render: (r: any) => baht(r.total) },
          { key: 'fulfillment_status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.fulfillment_status === 'completed' ? 'paid' : 'open')}>{r.fulfillment_status ?? '—'}</Badge> },
          { key: 'act', label: t('hx.common.update_status'), sortable: false, render: (r: any) => <select className={sel} value={r.fulfillment_status ?? ''} aria-label={t('hx.common.update_status')} onChange={(e) => setStatus.mutate({ no: r.order_no, status: e.target.value })}><option value="">—</option>{FS.map((f) => <option key={f} value={f}>{f}</option>)}</select> },
          { key: 'link', label: t('hx.ch.col_link_member'), sortable: false, render: (r: any) => <Button size="sm" variant="outline" disabled={mintQr.isPending} onClick={() => mintQr.mutate(r.order_no)}><QrCode className="size-4" /> {t('hx.ch.mint_qr')}</Button> },
        ]} emptyState={
          search || statusFilter
            ? {
                icon: SearchX,
                title: t('hx.ch.orders_no_match_title'),
                description: t('hx.ch.orders_no_match_desc'),
                action: (
                  <Button variant="outline" size="sm" onClick={() => { setSearch(''); setStatusFilter(null); }}>
                    {t('inv.clear_filter')}
                  </Button>
                ),
              }
            : { icon: ShoppingBag, title: t('hx.ch.orders_empty_title'), description: t('hx.ch.orders_empty_desc') }
        } />
        </div>
      )}
      <Dialog open={!!qrUrl} onOpenChange={(o) => !o && setQrUrl(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('hx.ch.qr_dlg_title')}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{t('hx.ch.qr_dlg_desc')}</p>
          <div className="flex items-center gap-2">
            <Input readOnly value={qrUrl ?? ''} className="font-mono text-xs" />
            <Button variant="outline" size="icon" onClick={() => { if (qrUrl) { navigator.clipboard.writeText(qrUrl); notifySuccess(t('hx.ch.link_copied')); } }}>
              <Copy className="size-4" />
            </Button>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setQrUrl(null)}>{t('crmx.btn_cancel')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </StateView>
  );
}

function Adapters() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['adapters'], queryFn: () => api('/api/channels/adapters') });
  const [f, setF] = useState({ platform: 'grab', store_ref: '' });
  const save = useMutation({ mutationFn: () => api('/api/channels/adapters', { method: 'POST', body: JSON.stringify({ platform: f.platform, store_ref: f.store_ref || undefined }) }), onSuccess: () => { notifySuccess(t('hx.ch.connected')); qc.invalidateQueries({ queryKey: ['adapters'] }); }, onError: (e: any) => notifyError(e.message) });
  const sync = useMutation({ mutationFn: (p: string) => api(`/api/channels/${p}/menu-sync`, { method: 'POST' }), onSuccess: (r: any) => notifySuccess(t('hx.ch.menu_synced', { count: r.count, platform: r.platform })), onError: (e: any) => notifyError(e.message) });
  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hx.ch.add_adapter_title')}</h3>
        <div className="flex flex-wrap gap-2">
          <select className={sel} value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value })}>{PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}</select>
          <Input className="max-w-[200px]" placeholder={t('hx.ch.store_ref_ph')} value={f.store_ref} onChange={(e) => setF({ ...f, store_ref: e.target.value })} />
          <Button disabled={save.isPending} onClick={() => save.mutate()}><Plug className="size-4" /> {t('hx.ch.connect')}</Button>
        </div>
      </Card>
      <StateView q={q}>
        {q.data && <DataTable rows={q.data.adapters} columns={[
          { key: 'platform', label: t('hx.ch.col_platform') }, { key: 'store_ref', label: 'Store ID' },
          { key: 'enabled', label: t('hx.ch.col_enabled'), render: (r: any) => r.enabled ? <Badge variant={statusVariant('paid')}>{t('hx.common.active')}</Badge> : '—' },
          { key: 'act', label: '', render: (r: any) => <Button size="sm" variant="outline" disabled={sync.isPending} onClick={() => sync.mutate(r.platform)}><Send className="size-4" /> {t('hx.ch.menu_sync')}</Button> },
        ]} emptyState={{ icon: PlugZap, title: t('hx.ch.adapters_empty_title'), description: t('hx.ch.adapters_empty_desc') }} />}
      </StateView>
    </div>
  );
}

function Availability() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['availability'], queryFn: () => api('/api/pos/scale/availability') });
  const recompute = useMutation({ mutationFn: () => api('/api/pos/scale/availability/recompute', { method: 'POST' }), onSuccess: (r: any) => { notifySuccess(t('hx.ch.recomputed', { count: r.count })); qc.invalidateQueries({ queryKey: ['availability'] }); }, onError: (e: any) => notifyError(e.message) });
  const [search, setSearch] = useState('');
  const items: any[] = q.data?.items ?? [];
  const filteredItems = useMemo(() => { const term = search.trim().toLowerCase(); if (!term) return items; return items.filter((i) => [i.sku, i.name].some((v) => String(v ?? '').toLowerCase().includes(term))); }, [items, search]);
  return (
    <div className="space-y-4">
      <Card className="flex-row items-center gap-3 p-5">
        <Button disabled={recompute.isPending} onClick={() => recompute.mutate()}><RefreshCw className={`size-4 ${recompute.isPending ? 'animate-spin' : ''}`} /> {t('hx.ch.recompute_86')}</Button>
      </Card>
      <StateView q={q}>
        {q.data && (
          <div className="space-y-3">
            <SearchInput value={search} onChange={setSearch} placeholder={t('hx.ch.search_items_ph')} ariaLabel={t('hx.ch.search_items_aria')} count={t('hx.common.count_items', { n: filteredItems.length })} />
            <DataTable rows={filteredItems} rowKey={(r: any) => r.sku} columns={[
              { key: 'sku', label: 'SKU' }, { key: 'name', label: t('hx.ch.col_name') },
              { key: 'is_available', label: t('hx.ch.col_available'), render: (r: any) => <Badge variant={statusVariant(r.is_available ? 'paid' : 'cancelled')}>{r.is_available ? t('hx.ch.avail_yes') : t('hx.ch.avail_no')}</Badge> },
            ]} emptyState={
              search
                ? {
                    icon: SearchX,
                    title: t('hx.ch.items_no_match_title'),
                    description: t('hx.ch.items_no_match_desc'),
                    action: (
                      <Button variant="outline" size="sm" onClick={() => setSearch('')}>
                        {t('inv.clear_filter')}
                      </Button>
                    ),
                  }
                : { icon: PackageSearch, title: t('hx.ch.items_empty_title'), description: t('hx.ch.items_empty_desc') }
            } />
          </div>
        )}
      </StateView>
    </div>
  );
}

// G1 (docs/45, control MKT-13) — channel-to-member identity links. Refs carry only a SHA-256 hash of the
// aggregator buyer id (channel-customer-refs.service.ts) and require a REQUIRED consent decision on link.
function Refs() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<'all' | 'unlinked' | 'linked'>('unlinked');
  const q = useQuery<any>({
    queryKey: ['channel-refs', filter],
    queryFn: () => api(`/api/loyalty/channel-refs${filter === 'all' ? '' : `?linked=${filter === 'linked'}`}`),
  });
  const [linkTarget, setLinkTarget] = useState<any | null>(null);
  const [memberId, setMemberId] = useState('');
  const [optIn, setOptIn] = useState(false);
  const link = useMutation({
    mutationFn: () => api(`/api/loyalty/channel-refs/${linkTarget.id}/link`, { method: 'POST', body: JSON.stringify({ member_id: Number(memberId), marketing_opt_in: optIn }) }),
    onSuccess: () => { notifySuccess(t('hx.ch.ref_linked')); qc.invalidateQueries({ queryKey: ['channel-refs'] }); setLinkTarget(null); setMemberId(''); setOptIn(false); },
    onError: (e: any) => notifyError(e.message),
  });
  const refs: any[] = q.data?.refs ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('hx.common.filter_status')}>
        <Button variant={filter === 'unlinked' ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter('unlinked')}>{t('hx.ch.filter_unlinked')}</Button>
        <Button variant={filter === 'linked' ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter('linked')}>{t('hx.ch.filter_linked')}</Button>
        <Button variant={filter === 'all' ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter('all')}>{t('hx.common.all')}</Button>
      </div>
      <StateView q={q}>
        <DataTable rows={refs} rowKey={(r: any) => r.id} columns={[
          { key: 'platform', label: t('hx.ch.col_platform'), render: (r: any) => <Badge>{r.platform}</Badge> },
          { key: 'ref_hash', label: t('hx.ch.col_ref_hash'), render: (r: any) => <span className="font-mono text-xs">{r.ref_hash}</span> },
          { key: 'order_count', label: t('ly.col_orders'), align: 'right' },
          { key: 'member', label: t('ly.col_member'), render: (r: any) => r.linked ? `${r.member_name ?? r.member_code} (${r.member_code})` : <span className="text-muted-foreground">—</span> },
          { key: 'link_source', label: t('hx.ch.col_link_source'), render: (r: any) => r.link_source ? <Badge variant="muted">{r.link_source}</Badge> : '—' },
          { key: 'act', label: '', sortable: false, render: (r: any) => !r.linked && <Button size="sm" variant="outline" onClick={() => setLinkTarget(r)}><Link2 className="size-4" /> {t('hx.ch.link_to_member')}</Button> },
        ]} emptyState={{ icon: Users, title: t('hx.ch.refs_empty_title'), description: t('hx.ch.refs_empty_desc') }} />
      </StateView>
      <Dialog open={!!linkTarget} onOpenChange={(o) => !o && setLinkTarget(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('hx.ch.link_dlg_title')}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{t('hx.ch.link_dlg_desc', { platform: linkTarget?.platform })}</p>
          <div className="grid gap-2">
            <Label htmlFor="ref-member-id">{t('crm.member_id_label')}</Label>
            <Input id="ref-member-id" type="number" min="1" value={memberId} onChange={(e) => setMemberId(e.target.value)} placeholder={t('crm.member_id_placeholder')} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} />
            {t('hx.ch.consent_opt_in')}
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLinkTarget(null)}>{t('crmx.btn_cancel')}</Button>
            <Button disabled={!memberId.trim() || link.isPending} onClick={() => link.mutate()}>{t('hx.ch.link_to_member')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
