'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, MapPin, PackageCheck, Plus, Truck, Layers, Search, Boxes as Cube } from 'lucide-react';
import type { LayoutBin } from '@/components/warehouse-3d';

// react-three-fiber renders to <canvas> using browser-only APIs → load client-side only (no SSR).
const Warehouse3D = dynamic(() => import('@/components/warehouse-3d'), { ssr: false, loading: () => <Warehouse3DLoading /> });
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function Warehouse3DLoading() {
  const { t } = useLang();
  return <div className="flex h-[480px] items-center justify-center rounded-xl bg-muted/40 text-sm text-muted-foreground">{t('iv.wms_loading_3d')}</div>;
}

export default function WmsPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('iv.wms_page_title')}
        description={t('iv.wms_page_desc')}
      />
      <Tabs
        tabs={[
          { key: 'bins', label: t('iv.wms_tab_bins'), content: <BinsTab /> },
          { key: 'layout', label: t('iv.wms_tab_layout'), content: <Layout3DTab /> },
          { key: 'inbound', label: t('iv.wms_tab_inbound'), content: <PutawayTab /> },
          { key: 'wave', label: t('iv.wms_tab_wave'), content: <WaveTab /> },
          { key: 'pack', label: t('iv.wms_tab_pack'), content: <PackTab /> },
          { key: 'ship', label: t('iv.wms_tab_ship'), content: <ShipTab /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── Bins ─────────────────────────
function BinsTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['wms-bins'], queryFn: () => api('/api/wms/bins') });

  const [binCode, setBinCode] = useState('');
  const [binType, setBinType] = useState('');
  const [locationId, setLocationId] = useState('');
  const [capacity, setCapacity] = useState('');
  const [posX, setPosX] = useState(''); const [posY, setPosY] = useState(''); const [posZ, setPosZ] = useState('');

  const numOpt = (v: string) => (v.trim() === '' ? undefined : Number(v));
  const create = useMutation({
    mutationFn: () =>
      api<{ bin_code: string }>('/api/wms/bins', {
        method: 'POST',
        body: JSON.stringify({ bin_code: binCode, bin_type: binType || undefined, location_id: locationId || undefined, capacity: numOpt(capacity), pos_x: numOpt(posX), pos_y: numOpt(posY), pos_z: numOpt(posZ) }),
      }),
    onSuccess: (r) => {
      notifySuccess(t('iv.wms_bin_added', { code: r.bin_code }));
      setBinCode(''); setBinType(''); setLocationId(''); setCapacity(''); setPosX(''); setPosY(''); setPosZ('');
      qc.invalidateQueries({ queryKey: ['wms-bins'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const bins: any[] = q.data?.bins ?? [];
  const activeCount = bins.filter((b) => b.active !== false).length;

  return (
    <div className="space-y-5">
      <Card className="max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">{t('iv.wms_add_bin_title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="bin-code">{t('iv.wms_bin_code_label')}</Label>
              <Input id="bin-code" value={binCode} onChange={(e) => setBinCode(e.target.value)} placeholder="A-01-1" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bin-type">{t('iv.wms_type')}</Label>
              <Input id="bin-type" value={binType} onChange={(e) => setBinType(e.target.value)} placeholder="storage" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bin-loc">{t('iv.wms_location_label')}</Label>
              <Input id="bin-loc" value={locationId} onChange={(e) => setLocationId(e.target.value)} placeholder="WH-1" />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-4">
            <div className="grid gap-2">
              <Label htmlFor="bin-cap">{t('iv.wms_capacity_label')}</Label>
              <Input id="bin-cap" type="number" min="0" value={capacity} onChange={(e) => setCapacity(e.target.value)} placeholder={t('iv.wms_eg_100')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bin-x">{t('iv.wms_pos_x')}</Label>
              <Input id="bin-x" type="number" value={posX} onChange={(e) => setPosX(e.target.value)} placeholder="0" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bin-y">{t('iv.wms_pos_y')}</Label>
              <Input id="bin-y" type="number" value={posY} onChange={(e) => setPosY(e.target.value)} placeholder="0" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bin-z">{t('iv.wms_pos_z')}</Label>
              <Input id="bin-z" type="number" value={posZ} onChange={(e) => setPosZ(e.target.value)} placeholder="0" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={create.isPending || !binCode} onClick={() => create.mutate()}>
              <Plus className="size-4" /> {create.isPending ? t('iv.wms_saving') : t('iv.wms_add_bin')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <StatCard label={t('iv.wms_stat_bins')} value={num(bins.length)} icon={Boxes} tone="primary" />
              <StatCard label={t('iv.wms_stat_active')} value={num(activeCount)} icon={MapPin} tone="success" />
              <StatCard label={t('iv.wms_stat_inactive')} value={num(bins.length - activeCount)} icon={Layers} tone="default" />
            </div>
            <DataTable
              rows={bins}
              columns={[
                { key: 'bin_code', label: t('iv.wms_col_bin_code') },
                { key: 'bin_type', label: t('iv.wms_type'), render: (r: any) => r.bin_type ?? '—' },
                { key: 'location_id', label: t('iv.wms_col_location'), render: (r: any) => r.location_id ?? '—' },
                { key: 'capacity', label: t('iv.wms_col_capacity'), align: 'right', render: (r: any) => (r.capacity != null ? <span className="tabular">{num(r.capacity)}</span> : '—') },
                { key: 'active', label: t('fin.col_status'), render: (r: any) => <Badge variant={r.active !== false ? 'success' : 'muted'}>{r.active !== false ? t('iv.wms_stat_active') : t('iv.wms_stat_inactive')}</Badge> },
              ]}
              emptyState={{ icon: Boxes, title: t('iv.wms_empty_bins_title'), description: t('iv.wms_empty_bins_desc') }}
            />
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── 3D storage layout + locate ─────────────────────────
function Layout3DTab() {
  const { t } = useLang();
  const layout = useQuery<any>({ queryKey: ['wms-layout'], queryFn: () => api('/api/wms/layout') });
  const [selected, setSelected] = useState<string | null>(null);
  const [term, setTerm] = useState('');
  const [lookup, setLookup] = useState('');
  const locate = useQuery<any>({ queryKey: ['wms-locate', lookup], queryFn: () => api(`/api/wms/locate?item_id=${encodeURIComponent(lookup)}`), enabled: !!lookup });

  const bins: LayoutBin[] = layout.data?.bins ?? [];
  const highlight = useMemo(() => new Set<string>((locate.data?.locations ?? []).map((l: any) => l.bin_code)), [locate.data]);
  const selectedStock = useQuery<any>({ queryKey: ['wms-bin-stock', selected], queryFn: () => api(`/api/wms/bins/${encodeURIComponent(selected!)}/stock`), enabled: !!selected });

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t('iv.wms_stat_bins_in_layout')} value={num(layout.data?.count ?? 0)} icon={Boxes} tone="primary" />
        <StatCard label={t('iv.wms_stat_avg_util')} value={`${Math.round((layout.data?.avg_utilization ?? 0) * 100)}%`} icon={Layers} tone="default" />
        <StatCard label={t('iv.wms_stat_over_capacity')} value={num(layout.data?.over_capacity ?? 0)} icon={MapPin} tone={layout.data?.over_capacity ? 'danger' : 'success'} />
        <StatCard label={t('iv.wms_stat_found')} value={num(locate.data?.count ?? 0)} icon={Search} tone="default" />
      </div>

      <Card className="gap-3 p-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="locate">{t('iv.wms_locate_label')}</Label>
            <Input id="locate" value={term} onChange={(e) => setTerm(e.target.value)} placeholder={t('iv.wms_eg_sugar')} className="w-56" onKeyDown={(e) => { if (e.key === 'Enter') setLookup(term.trim()); }} />
          </div>
          <Button variant="outline" onClick={() => setLookup(term.trim())} disabled={!term}><Search className="size-4" /> {t('iv.wms_search')}</Button>
          {lookup && <Button variant="ghost" onClick={() => { setTerm(''); setLookup(''); }}>{t('iv.wms_clear')}</Button>}
          {lookup && locate.data && <span className="text-sm text-muted-foreground">{t('iv.wms_locate_result', { term: lookup, count: locate.data.count, qty: num(locate.data.total_qty) })}</span>}
        </div>
      </Card>

      <StateView q={layout}>
        {layout.data && (bins.length ? (
          <Warehouse3D bins={bins} highlight={highlight} selected={selected} onSelect={(c) => setSelected(c)} />
        ) : (
          <div className="flex h-[240px] flex-col items-center justify-center gap-2 rounded-xl bg-muted/40 text-sm text-muted-foreground">
            <Cube className="size-8 opacity-40" />
            {t('iv.wms_empty_layout')}
          </div>
        ))}
      </StateView>

      {selected && (
        <Card className="gap-3 p-4">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{t('iv.wms_bin_heading', { code: selected })}</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>{t('iv.wms_close')}</Button>
          </div>
          <StateView q={selectedStock}>
            {selectedStock.data && (
              <DataTable
                rows={selectedStock.data.stock}
                dense
                columns={[
                  { key: 'item_id', label: t('iv.wms_col_item') },
                  { key: 'lot_no', label: t('iv.wms_col_lot'), render: (r: any) => r.lot_no || '—' },
                  { key: 'qty', label: t('inv.col_qty'), align: 'right', render: (r: any) => <span className="tabular">{num(r.qty)}</span> },
                ]}
                emptyState={{ icon: Boxes, title: t('iv.wms_empty_bin') }}
              />
            )}
          </StateView>
        </Card>
      )}
    </div>
  );
}

// ───────────────────────── Putaway ─────────────────────────
function PutawayTab() {
  const { t } = useLang();
  const [binCode, setBinCode] = useState('');
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState(1);
  const [lotNo, setLotNo] = useState('');
  const [grNo, setGrNo] = useState('');

  const mut = useMutation({
    mutationFn: () =>
      api<{ bin_code: string; item_id: string; qty: number; duplicate?: boolean }>('/api/wms/putaway', {
        method: 'POST',
        body: JSON.stringify({ bin_code: binCode, item_id: itemId, qty: Number(qty), lot_no: lotNo || undefined, gr_no: grNo || undefined }),
      }),
    onSuccess: (r) => notifySuccess(`${r.bin_code} · ${r.item_id} · ${t('iv.wms_putaway_balance', { qty: num(r.qty) })}${r.duplicate ? t('iv.wms_putaway_dup') : ''}`),
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Card className="max-w-2xl gap-4">
      <CardHeader>
        <CardTitle className="text-base">{t('iv.wms_putaway_title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="pa-bin">{t('iv.wms_bin')}</Label>
            <Input id="pa-bin" value={binCode} onChange={(e) => setBinCode(e.target.value)} placeholder="A-01-1" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pa-item">{t('iv.wms_item_code')}</Label>
            <Input id="pa-item" value={itemId} onChange={(e) => setItemId(e.target.value)} placeholder="ITEM-001" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pa-qty">{t('inv.col_qty')}</Label>
            <Input id="pa-qty" type="number" min="0" value={qty} onChange={(e) => setQty(+e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pa-lot">{t('iv.wms_lot_label')}</Label>
            <Input id="pa-lot" value={lotNo} onChange={(e) => setLotNo(e.target.value)} placeholder={t('iv.wms_optional')} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pa-gr">{t('iv.wms_gr_label')}</Label>
            <Input id="pa-gr" value={grNo} onChange={(e) => setGrNo(e.target.value)} placeholder={t('iv.wms_optional')} />
          </div>
        </div>
        <Button disabled={mut.isPending || !binCode || !itemId || qty <= 0} onClick={() => mut.mutate()}>
          <PackageCheck className="size-4" /> {mut.isPending ? t('iv.wms_saving') : t('iv.wms_putaway_btn')}
        </Button>
      </CardContent>
    </Card>
  );
}

// ───────────────────────── Wave ─────────────────────────
function WaveTab() {
  const { t } = useLang();
  const [sourceType, setSourceType] = useState<'POS' | 'SO' | 'DINEIN'>('SO');
  const [sourceRef, setSourceRef] = useState('');

  const mut = useMutation({
    mutationFn: () =>
      api<{ wave_no: string; pick_count: number; lines: number }>('/api/wms/waves', {
        method: 'POST',
        body: JSON.stringify({ orders: [{ source_type: sourceType, source_ref: sourceRef }] }),
      }),
    onSuccess: (r) => notifySuccess(`${r.wave_no} · ${t('iv.wms_wave_result', { picks: num(r.pick_count), lines: num(r.lines) })}`),
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Card className="max-w-2xl gap-4">
      <CardHeader>
        <CardTitle className="text-base">{t('iv.wms_wave_title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('iv.wms_wave_desc')}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="wv-type">{t('iv.wms_order_type')}</Label>
            <select
              id="wv-type"
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value as any)}
            >
              <option value="SO">SO (Sales Order)</option>
              <option value="POS">POS</option>
              <option value="DINEIN">DINEIN</option>
            </select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="wv-ref">{t('iv.wms_order_ref')}</Label>
            <Input id="wv-ref" value={sourceRef} onChange={(e) => setSourceRef(e.target.value)} placeholder="SALE-0001" />
          </div>
        </div>
        <Button disabled={mut.isPending || !sourceRef} onClick={() => mut.mutate()}>
          <Layers className="size-4" /> {mut.isPending ? t('iv.wms_creating') : t('iv.wms_create_wave')}
        </Button>
      </CardContent>
    </Card>
  );
}

// ───────────────────────── Pack ─────────────────────────
function PackTab() {
  const { t } = useLang();
  const [pickNo, setPickNo] = useState('');

  const mut = useMutation({
    mutationFn: () => api<{ shipment_no: string; status: string }>(`/api/wms/picks/${encodeURIComponent(pickNo)}/pack`, { method: 'POST' }),
    onSuccess: (r) => notifySuccess(`${r.shipment_no} · ${r.status}`),
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Card className="max-w-2xl gap-4">
      <CardHeader>
        <CardTitle className="text-base">{t('iv.wms_pack_title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('iv.wms_pack_desc')}</p>
        <div className="grid max-w-xs gap-2">
          <Label htmlFor="pk-no">{t('iv.wms_pick_no_label')}</Label>
          <Input id="pk-no" value={pickNo} onChange={(e) => setPickNo(e.target.value)} placeholder="PICK-0001" />
        </div>
        <Button disabled={mut.isPending || !pickNo} onClick={() => mut.mutate()}>
          <PackageCheck className="size-4" /> {mut.isPending ? t('iv.wms_packing') : t('iv.wms_pack_btn')}
        </Button>
      </CardContent>
    </Card>
  );
}

// ───────────────────────── Ship ─────────────────────────
function ShipTab() {
  const { t } = useLang();
  const [shipmentNo, setShipmentNo] = useState('');
  const [carrier, setCarrier] = useState('');
  const [trackingNo, setTrackingNo] = useState('');

  const mut = useMutation({
    mutationFn: () =>
      api<{ shipment_no: string; tracking_no: string; status: string }>(`/api/wms/shipments/${encodeURIComponent(shipmentNo)}/ship`, {
        method: 'POST',
        body: JSON.stringify({ carrier, tracking_no: trackingNo }),
      }),
    onSuccess: (r) => notifySuccess(`${r.shipment_no} · ${r.tracking_no} · ${r.status}`),
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Card className="max-w-2xl gap-4">
      <CardHeader>
        <CardTitle className="text-base">{t('iv.wms_ship_title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-2">
            <Label htmlFor="sh-no">{t('iv.wms_shipment_no_label')}</Label>
            <Input id="sh-no" value={shipmentNo} onChange={(e) => setShipmentNo(e.target.value)} placeholder="SHP-0001" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="sh-carrier">{t('iv.wms_carrier_label')}</Label>
            <Input id="sh-carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="Kerry" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="sh-track">{t('iv.wms_tracking_label')}</Label>
            <Input id="sh-track" value={trackingNo} onChange={(e) => setTrackingNo(e.target.value)} placeholder="TH123..." />
          </div>
        </div>
        <Button disabled={mut.isPending || !shipmentNo || !carrier || !trackingNo} onClick={() => mut.mutate()}>
          <Truck className="size-4" /> {mut.isPending ? t('iv.wms_shipping') : t('iv.wms_ship_btn')}
        </Button>
      </CardContent>
    </Card>
  );
}
