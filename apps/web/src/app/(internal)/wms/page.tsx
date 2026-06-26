'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, MapPin, PackageCheck, Plus, Truck, Layers, Search, Boxes as Cube } from 'lucide-react';
import type { LayoutBin } from '@/components/warehouse-3d';

// react-three-fiber renders to <canvas> using browser-only APIs → load client-side only (no SSR).
const Warehouse3D = dynamic(() => import('@/components/warehouse-3d'), { ssr: false, loading: () => <div className="flex h-[480px] items-center justify-center rounded-xl bg-muted/40 text-sm text-muted-foreground">กำลังโหลดมุมมอง 3 มิติ…</div> });
import { api } from '@/lib/api';
import { num } from '@/lib/format';
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

export default function WmsPage() {
  return (
    <div>
      <PageHeader
        title="คลังสินค้า (WMS)"
        description="จัดการช่องเก็บ (bins) และกระบวนการ putaway → wave → pick → pack → ship"
      />
      <Tabs
        tabs={[
          { key: 'bins', label: 'ช่องเก็บ (Bins)', content: <BinsTab /> },
          { key: 'layout', label: 'ผังคลัง 3D', content: <Layout3DTab /> },
          { key: 'inbound', label: 'รับเข้า (Putaway)', content: <PutawayTab /> },
          { key: 'wave', label: 'จัดคลื่นหยิบ (Wave)', content: <WaveTab /> },
          { key: 'pack', label: 'แพ็ค (Pack)', content: <PackTab /> },
          { key: 'ship', label: 'จัดส่ง (Ship)', content: <ShipTab /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── Bins ─────────────────────────
function BinsTab() {
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
      notifySuccess(`เพิ่มช่อง ${r.bin_code} แล้ว`);
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
          <CardTitle className="text-base">เพิ่มช่องเก็บ</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="bin-code">รหัสช่อง (Bin code)</Label>
              <Input id="bin-code" value={binCode} onChange={(e) => setBinCode(e.target.value)} placeholder="A-01-1" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bin-type">ประเภท</Label>
              <Input id="bin-type" value={binType} onChange={(e) => setBinType(e.target.value)} placeholder="storage" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bin-loc">คลัง (Location)</Label>
              <Input id="bin-loc" value={locationId} onChange={(e) => setLocationId(e.target.value)} placeholder="WH-1" />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-4">
            <div className="grid gap-2">
              <Label htmlFor="bin-cap">ความจุ (Capacity)</Label>
              <Input id="bin-cap" type="number" min="0" value={capacity} onChange={(e) => setCapacity(e.target.value)} placeholder="เช่น 100" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bin-x">ตำแหน่ง X (ทางเดิน)</Label>
              <Input id="bin-x" type="number" value={posX} onChange={(e) => setPosX(e.target.value)} placeholder="0" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bin-y">ตำแหน่ง Y (ลึก)</Label>
              <Input id="bin-y" type="number" value={posY} onChange={(e) => setPosY(e.target.value)} placeholder="0" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bin-z">ตำแหน่ง Z (ชั้น)</Label>
              <Input id="bin-z" type="number" value={posZ} onChange={(e) => setPosZ(e.target.value)} placeholder="0" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={create.isPending || !binCode} onClick={() => create.mutate()}>
              <Plus className="size-4" /> {create.isPending ? 'กำลังบันทึก…' : 'เพิ่มช่อง'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <StatCard label="จำนวนช่องเก็บ" value={num(bins.length)} icon={Boxes} tone="primary" />
              <StatCard label="ใช้งานอยู่" value={num(activeCount)} icon={MapPin} tone="success" />
              <StatCard label="ปิดใช้งาน" value={num(bins.length - activeCount)} icon={Layers} tone="default" />
            </div>
            <DataTable
              rows={bins}
              columns={[
                { key: 'bin_code', label: 'รหัสช่อง' },
                { key: 'bin_type', label: 'ประเภท', render: (r: any) => r.bin_type ?? '—' },
                { key: 'location_id', label: 'คลัง', render: (r: any) => r.location_id ?? '—' },
                { key: 'capacity', label: 'ความจุ', align: 'right', render: (r: any) => (r.capacity != null ? <span className="tabular">{num(r.capacity)}</span> : '—') },
                { key: 'active', label: 'สถานะ', render: (r: any) => <Badge variant={r.active !== false ? 'success' : 'muted'}>{r.active !== false ? 'Active' : 'Inactive'}</Badge> },
              ]}
              emptyState={{ icon: Boxes, title: 'ยังไม่มีช่องเก็บ', description: 'เพิ่มช่องเก็บ (bin) ด้านบนเพื่อเริ่มจัดผังคลังสินค้า' }}
            />
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── 3D storage layout + locate ─────────────────────────
function Layout3DTab() {
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
        <StatCard label="ช่องเก็บในผัง" value={num(layout.data?.count ?? 0)} icon={Boxes} tone="primary" />
        <StatCard label="ใช้พื้นที่เฉลี่ย" value={`${Math.round((layout.data?.avg_utilization ?? 0) * 100)}%`} icon={Layers} tone="default" />
        <StatCard label="เกินความจุ" value={num(layout.data?.over_capacity ?? 0)} icon={MapPin} tone={layout.data?.over_capacity ? 'danger' : 'success'} />
        <StatCard label="พบสินค้าที่ค้นหา" value={num(locate.data?.count ?? 0)} icon={Search} tone="default" />
      </div>

      <Card className="gap-3 p-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="locate">ค้นหาตำแหน่งสินค้า (Item ID)</Label>
            <Input id="locate" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="เช่น SUGAR" className="w-56" onKeyDown={(e) => { if (e.key === 'Enter') setLookup(term.trim()); }} />
          </div>
          <Button variant="outline" onClick={() => setLookup(term.trim())} disabled={!term}><Search className="size-4" /> ค้นหา</Button>
          {lookup && <Button variant="ghost" onClick={() => { setTerm(''); setLookup(''); }}>ล้าง</Button>}
          {lookup && locate.data && <span className="text-sm text-muted-foreground">“{lookup}” พบใน {locate.data.count} ช่อง · รวม {num(locate.data.total_qty)} หน่วย (ไฮไลต์สีม่วง)</span>}
        </div>
      </Card>

      <StateView q={layout}>
        {layout.data && (bins.length ? (
          <Warehouse3D bins={bins} highlight={highlight} selected={selected} onSelect={(c) => setSelected(c)} />
        ) : (
          <div className="flex h-[240px] flex-col items-center justify-center gap-2 rounded-xl bg-muted/40 text-sm text-muted-foreground">
            <Cube className="size-8 opacity-40" />
            ยังไม่มีช่องเก็บในผัง — เพิ่มช่องเก็บพร้อมระบุตำแหน่ง X/Y/Z ในแท็บ “ช่องเก็บ (Bins)”
          </div>
        ))}
      </StateView>

      {selected && (
        <Card className="gap-3 p-4">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">ช่องเก็บ {selected}</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>ปิด</Button>
          </div>
          <StateView q={selectedStock}>
            {selectedStock.data && (
              <DataTable
                rows={selectedStock.data.stock}
                dense
                columns={[
                  { key: 'item_id', label: 'สินค้า' },
                  { key: 'lot_no', label: 'ล็อต', render: (r: any) => r.lot_no || '—' },
                  { key: 'qty', label: 'จำนวน', align: 'right', render: (r: any) => <span className="tabular">{num(r.qty)}</span> },
                ]}
                emptyState={{ icon: Boxes, title: 'ช่องนี้ว่าง' }}
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
    onSuccess: (r) => notifySuccess(`${r.bin_code} · ${r.item_id} · คงเหลือ ${num(r.qty)}${r.duplicate ? ' (ซ้ำ — ไม่นับเพิ่ม)' : ''}`),
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Card className="max-w-2xl gap-4">
      <CardHeader>
        <CardTitle className="text-base">รับสินค้าเข้าช่องเก็บ (Putaway)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="pa-bin">ช่องเก็บ</Label>
            <Input id="pa-bin" value={binCode} onChange={(e) => setBinCode(e.target.value)} placeholder="A-01-1" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pa-item">รหัสสินค้า</Label>
            <Input id="pa-item" value={itemId} onChange={(e) => setItemId(e.target.value)} placeholder="ITEM-001" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pa-qty">จำนวน</Label>
            <Input id="pa-qty" type="number" min="0" value={qty} onChange={(e) => setQty(+e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pa-lot">ล็อต (Lot)</Label>
            <Input id="pa-lot" value={lotNo} onChange={(e) => setLotNo(e.target.value)} placeholder="ไม่บังคับ" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pa-gr">เลขใบรับ (GR)</Label>
            <Input id="pa-gr" value={grNo} onChange={(e) => setGrNo(e.target.value)} placeholder="ไม่บังคับ" />
          </div>
        </div>
        <Button disabled={mut.isPending || !binCode || !itemId || qty <= 0} onClick={() => mut.mutate()}>
          <PackageCheck className="size-4" /> {mut.isPending ? 'กำลังบันทึก…' : 'รับเข้าช่อง'}
        </Button>
      </CardContent>
    </Card>
  );
}

// ───────────────────────── Wave ─────────────────────────
function WaveTab() {
  const [sourceType, setSourceType] = useState<'POS' | 'SO' | 'DINEIN'>('SO');
  const [sourceRef, setSourceRef] = useState('');

  const mut = useMutation({
    mutationFn: () =>
      api<{ wave_no: string; pick_count: number; lines: number }>('/api/wms/waves', {
        method: 'POST',
        body: JSON.stringify({ orders: [{ source_type: sourceType, source_ref: sourceRef }] }),
      }),
    onSuccess: (r) => notifySuccess(`${r.wave_no} · ${num(r.pick_count)} ใบหยิบ · ${num(r.lines)} บรรทัด`),
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Card className="max-w-2xl gap-4">
      <CardHeader>
        <CardTitle className="text-base">สร้างคลื่นหยิบสินค้า (Wave)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">รวมออเดอร์เป็นใบหยิบ (pick list) ระบบจะแนะนำช่องหยิบแบบ FEFO ให้อัตโนมัติ</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="wv-type">ประเภทออเดอร์</Label>
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
            <Label htmlFor="wv-ref">เลขอ้างอิงออเดอร์</Label>
            <Input id="wv-ref" value={sourceRef} onChange={(e) => setSourceRef(e.target.value)} placeholder="SALE-0001" />
          </div>
        </div>
        <Button disabled={mut.isPending || !sourceRef} onClick={() => mut.mutate()}>
          <Layers className="size-4" /> {mut.isPending ? 'กำลังสร้าง…' : 'สร้าง Wave'}
        </Button>
      </CardContent>
    </Card>
  );
}

// ───────────────────────── Pack ─────────────────────────
function PackTab() {
  const [pickNo, setPickNo] = useState('');

  const mut = useMutation({
    mutationFn: () => api<{ shipment_no: string; status: string }>(`/api/wms/picks/${encodeURIComponent(pickNo)}/pack`, { method: 'POST' }),
    onSuccess: (r) => notifySuccess(`${r.shipment_no} · ${r.status}`),
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Card className="max-w-2xl gap-4">
      <CardHeader>
        <CardTitle className="text-base">แพ็คสินค้า (Pack)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">สร้างใบจัดส่งจากใบหยิบที่หยิบครบแล้ว (ต้องอยู่สถานะ Picked)</p>
        <div className="grid max-w-xs gap-2">
          <Label htmlFor="pk-no">เลขใบหยิบ (Pick no)</Label>
          <Input id="pk-no" value={pickNo} onChange={(e) => setPickNo(e.target.value)} placeholder="PICK-0001" />
        </div>
        <Button disabled={mut.isPending || !pickNo} onClick={() => mut.mutate()}>
          <PackageCheck className="size-4" /> {mut.isPending ? 'กำลังแพ็ค…' : 'แพ็ค'}
        </Button>
      </CardContent>
    </Card>
  );
}

// ───────────────────────── Ship ─────────────────────────
function ShipTab() {
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
        <CardTitle className="text-base">จัดส่ง (Ship)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-2">
            <Label htmlFor="sh-no">เลขใบจัดส่ง</Label>
            <Input id="sh-no" value={shipmentNo} onChange={(e) => setShipmentNo(e.target.value)} placeholder="SHP-0001" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="sh-carrier">ขนส่ง (Carrier)</Label>
            <Input id="sh-carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="Kerry" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="sh-track">เลขพัสดุ (Tracking)</Label>
            <Input id="sh-track" value={trackingNo} onChange={(e) => setTrackingNo(e.target.value)} placeholder="TH123..." />
          </div>
        </div>
        <Button disabled={mut.isPending || !shipmentNo || !carrier || !trackingNo} onClick={() => mut.mutate()}>
          <Truck className="size-4" /> {mut.isPending ? 'กำลังจัดส่ง…' : 'จัดส่ง'}
        </Button>
      </CardContent>
    </Card>
  );
}
