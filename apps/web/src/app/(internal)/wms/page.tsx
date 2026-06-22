'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, MapPin, PackageCheck, Plus, Truck, Layers } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs, Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

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

  const create = useMutation({
    mutationFn: () =>
      api<{ bin_code: string }>('/api/wms/bins', {
        method: 'POST',
        body: JSON.stringify({ bin_code: binCode, bin_type: binType || undefined, location_id: locationId || undefined }),
      }),
    onSuccess: () => {
      setBinCode(''); setBinType(''); setLocationId('');
      qc.invalidateQueries({ queryKey: ['wms-bins'] });
    },
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
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={create.isPending || !binCode} onClick={() => create.mutate()}>
              <Plus className="size-4" /> {create.isPending ? 'กำลังบันทึก…' : 'เพิ่มช่อง'}
            </Button>
          </div>
          {create.error && <Msg>{(create.error as Error).message}</Msg>}
          {create.data && <Msg ok>✅ เพิ่มช่อง {create.data.bin_code} แล้ว</Msg>}
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
                { key: 'active', label: 'สถานะ', render: (r: any) => <Badge variant={r.active !== false ? 'success' : 'muted'}>{r.active !== false ? 'Active' : 'Inactive'}</Badge> },
              ]}
              emptyText="ยังไม่มีช่องเก็บ"
            />
          </div>
        )}
      </StateView>
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
        {mut.error && <Msg>{(mut.error as Error).message}</Msg>}
        {mut.data && <Msg ok>✅ {mut.data.bin_code} · {mut.data.item_id} · คงเหลือ {num(mut.data.qty)}{mut.data.duplicate ? ' (ซ้ำ — ไม่นับเพิ่ม)' : ''}</Msg>}
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
        {mut.error && <Msg>{(mut.error as Error).message}</Msg>}
        {mut.data && <Msg ok>✅ {mut.data.wave_no} · {num(mut.data.pick_count)} ใบหยิบ · {num(mut.data.lines)} บรรทัด</Msg>}
      </CardContent>
    </Card>
  );
}

// ───────────────────────── Pack ─────────────────────────
function PackTab() {
  const [pickNo, setPickNo] = useState('');

  const mut = useMutation({
    mutationFn: () => api<{ shipment_no: string; status: string }>(`/api/wms/picks/${encodeURIComponent(pickNo)}/pack`, { method: 'POST' }),
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
        {mut.error && <Msg>{(mut.error as Error).message}</Msg>}
        {mut.data && (
          <Msg ok>
            ✅ {mut.data.shipment_no} · <Badge variant={statusVariant(mut.data.status)}>{mut.data.status}</Badge>
          </Msg>
        )}
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
        {mut.error && <Msg>{(mut.error as Error).message}</Msg>}
        {mut.data && (
          <Msg ok>
            ✅ {mut.data.shipment_no} · {mut.data.tracking_no} · <Badge variant={statusVariant(mut.data.status)}>{mut.data.status}</Badge>
          </Msg>
        )}
      </CardContent>
    </Card>
  );
}
