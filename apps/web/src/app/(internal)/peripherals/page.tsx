'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Cable, DollarSign, Scale, MonitorSmartphone } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
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

interface Device { id: number; device_code: string; kind: string; terminal: string | null; printer_id: string | null; status: string; last_seen_at: string | null }
interface DrawerEvt { id: number; reason: string; terminal: string | null; sale_no: string | null; amount: number | null; opened_by: string | null; created_at: string | null }

export default function PeripheralsPage() {
  return (
    <div>
      <PageHeader title="อุปกรณ์ฮาร์ดแวร์ (POS peripherals)" description="ลิ้นชักเก็บเงิน · จอแสดงผลลูกค้า · เครื่องชั่งน้ำหนัก — ทะเบียนอุปกรณ์และการตรวจสอบการเปิดลิ้นชัก · ต่อเครื่องพิมพ์/ลิ้นชัก/จอลูกค้าใช้งานจริงได้ที่ปุ่ม ⚙ “ตั้งค่าเครื่อง” บนหน้าขายหน้าร้าน (Register)" />
      <Tabs tabs={[
        { key: 'devices', label: 'ทะเบียนอุปกรณ์', content: <Devices /> },
        { key: 'drawer', label: 'ลิ้นชักเก็บเงิน', content: <Drawer /> },
        { key: 'scale', label: 'เครื่องชั่ง', content: <ScaleTab /> },
        { key: 'display', label: 'จอลูกค้า', content: <Display /> },
      ]} />
    </div>
  );
}

function Devices() {
  const qc = useQueryClient();
  const [code, setCode] = useState(''); const [kind, setKind] = useState('cash_drawer'); const [terminal, setTerminal] = useState(''); const [printerId, setPrinterId] = useState('');
  const q = useQuery<{ devices: Device[] }>({ queryKey: ['pos-devices'], queryFn: () => api('/api/peripherals/devices') });
  const create = useMutation({
    mutationFn: () => api('/api/peripherals/devices', { method: 'POST', body: JSON.stringify({ device_code: code, kind, terminal: terminal || undefined, printer_id: printerId || undefined }) }),
    onSuccess: () => { notifySuccess(`ลงทะเบียนอุปกรณ์ ${code}`); setCode(''); qc.invalidateQueries({ queryKey: ['pos-devices'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-sm">ลงทะเบียนอุปกรณ์</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-4">
          <div><Label>รหัสอุปกรณ์</Label><Input value={code} onChange={(e) => setCode(e.target.value.trim())} placeholder="DRW1" /></div>
          <div><Label>ชนิด</Label>
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="cash_drawer">ลิ้นชักเก็บเงิน</option><option value="printer">เครื่องพิมพ์</option><option value="display">จอลูกค้า</option><option value="scale">เครื่องชั่ง</option>
            </select>
          </div>
          <div><Label>เครื่อง POS (terminal)</Label><Input value={terminal} onChange={(e) => setTerminal(e.target.value.trim())} placeholder="T01" /></div>
          <div><Label>พิมพ์ผ่าน (printer_id)</Label><Input value={printerId} onChange={(e) => setPrinterId(e.target.value.trim())} placeholder="PRN1" /></div>
          <div className="sm:col-span-4 flex items-center gap-3">
            <Button disabled={!code || create.isPending} onClick={() => create.mutate()}>ลงทะเบียน</Button>
          </div>
        </CardContent>
      </Card>
      <StateView q={q}>
        <DataTable
          rows={q.data?.devices ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: 'device_code', label: 'รหัส' },
            { key: 'kind', label: 'ชนิด', render: (r) => <Badge variant="muted">{r.kind}</Badge> },
            { key: 'terminal', label: 'เครื่อง', render: (r) => r.terminal ?? '—' },
            { key: 'printer_id', label: 'พิมพ์ผ่าน', render: (r) => r.printer_id ?? '—' },
            { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={r.status === 'active' ? 'success' : 'muted'}>{r.status}</Badge> },
            { key: 'last_seen_at', label: 'พบล่าสุด', render: (r) => r.last_seen_at ? new Date(r.last_seen_at).toLocaleString('th-TH') : '—' },
          ]}
          emptyState={{
            icon: MonitorSmartphone,
            title: 'ยังไม่มีอุปกรณ์',
            description: 'ลงทะเบียนลิ้นชักเก็บเงิน เครื่องพิมพ์ จอลูกค้า หรือเครื่องชั่งจากแบบฟอร์มด้านบน',
          }}
        />
      </StateView>
    </div>
  );
}

function Drawer() {
  const qc = useQueryClient();
  const [terminal, setTerminal] = useState('T01');
  const evts = useQuery<{ events: DrawerEvt[] }>({ queryKey: ['drawer-events'], queryFn: () => api('/api/peripherals/drawer/events'), refetchInterval: 15_000 });
  const recon = useQuery<{ total_opens: number; no_sale_opens: number; by_reason: Record<string, number> }>({ queryKey: ['drawer-recon'], queryFn: () => api('/api/peripherals/drawer/reconciliation') });
  const noSale = useMutation({
    mutationFn: () => api('/api/peripherals/drawer/kick', { method: 'POST', body: JSON.stringify({ terminal, reason: 'no_sale' }) }),
    onSuccess: () => { notifySuccess('เปิดลิ้นชัก (ไม่มีการขาย) — บันทึกแล้ว'); qc.invalidateQueries({ queryKey: ['drawer-events'] }); qc.invalidateQueries({ queryKey: ['drawer-recon'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="เปิดลิ้นชักรวม (24 ชม.)" value={num(recon.data?.total_opens ?? 0)} icon={DollarSign} tone="info" />
        <StatCard label="เปิดแบบไม่มีการขาย (No-sale)" value={num(recon.data?.no_sale_opens ?? 0)} icon={DollarSign} tone={(recon.data?.no_sale_opens ?? 0) > 0 ? 'warning' : 'success'} hint="กระทบยอดกับ Z-report" />
        <StatCard label="เปิดจากการขาย (Sale)" value={num(recon.data?.by_reason?.sale ?? 0)} icon={DollarSign} tone="default" />
      </div>
      <Card>
        <CardHeader><CardTitle className="text-sm">เปิดลิ้นชักแบบไม่มีการขาย (No-sale)</CardTitle></CardHeader>
        <CardContent className="flex items-end gap-3">
          <div><Label>เครื่อง POS</Label><Input value={terminal} onChange={(e) => setTerminal(e.target.value.trim())} className="w-32" /></div>
          <Button variant="outline" disabled={noSale.isPending} onClick={() => noSale.mutate()}>เปิดลิ้นชัก</Button>
        </CardContent>
      </Card>
      <StateView q={evts}>
        <DataTable
          rows={evts.data?.events ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: 'created_at', label: 'เวลา', render: (r) => r.created_at ? new Date(r.created_at).toLocaleString('th-TH') : '—' },
            { key: 'reason', label: 'เหตุผล', render: (r) => <Badge variant={r.reason === 'no_sale' ? 'warning' : 'muted'}>{r.reason}</Badge> },
            { key: 'terminal', label: 'เครื่อง', render: (r) => r.terminal ?? '—' },
            { key: 'sale_no', label: 'การขาย', render: (r) => r.sale_no ?? '—' },
            { key: 'amount', label: 'จำนวน', align: 'right', render: (r) => r.amount != null ? baht(r.amount) : '—' },
            { key: 'opened_by', label: 'โดย', render: (r) => r.opened_by ?? '—' },
          ]}
          emptyState={{
            icon: DollarSign,
            title: 'ยังไม่มีการเปิดลิ้นชัก',
            description: 'เมื่อมีการเปิดลิ้นชักจากการขายหรือแบบไม่มีการขาย รายการจะปรากฏที่นี่เพื่อกระทบยอดกับ Z-report',
          }}
        />
      </StateView>
    </div>
  );
}

function ScaleTab() {
  const [sku, setSku] = useState(''); const [gross, setGross] = useState(''); const [tare, setTare] = useState(''); const [res, setRes] = useState<any>(null);
  const read = useMutation({
    mutationFn: () => api<any>('/api/peripherals/scale/read', { method: 'POST', body: JSON.stringify({ sku, gross_weight: Number(gross), tare_weight: tare ? Number(tare) : undefined }) }),
    onSuccess: (r) => { setRes(r); },
    onError: (e: Error) => { setRes(null); notifyError(e.message); },
  });
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Scale className="h-4 w-4" />ชั่งน้ำหนักสินค้า</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div><Label>SKU (สินค้าชั่งน้ำหนัก)</Label><Input value={sku} onChange={(e) => setSku(e.target.value.trim())} placeholder="WGH1" /></div>
          <div><Label>น้ำหนักรวม (gross)</Label><Input value={gross} onChange={(e) => setGross(e.target.value)} placeholder="1.25" /></div>
          <div><Label>น้ำหนักภาชนะ (tare)</Label><Input value={tare} onChange={(e) => setTare(e.target.value)} placeholder="0.05" /></div>
        </div>
        <Button disabled={!sku || !gross || read.isPending} onClick={() => read.mutate()}>คำนวณราคา</Button>
        {res && (
          <div className="rounded-md border p-3 text-sm">
            <div className="font-medium">{res.name}</div>
            <div className="text-muted-foreground">น้ำหนักสุทธิ {res.net_weight} {res.weight_unit} × {baht(res.unit_price)}/{res.weight_unit}</div>
            <div className="mt-1 text-lg font-semibold tabular">{baht(res.amount)}</div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Display() {
  const [terminal, setTerminal] = useState('T01');
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm flex items-center gap-2"><MonitorSmartphone className="h-4 w-4" />จอแสดงผลลูกค้า</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>จอแสดงผลลูกค้า (pole display / จอที่สอง) จะดึงสถานะของเครื่อง POS แบบเรียลไทม์ — รายการสินค้า ยอดรวม ยอดที่ต้องชำระ และเงินทอน เปิดหน้าจอนี้บนจอที่หันไปทางลูกค้า</p>
        <div className="flex items-end gap-3">
          {/* terminal is a device code — restrict to a safe charset so it can never carry markup into the href */}
          <div><Label>เครื่อง POS</Label><Input value={terminal} onChange={(e) => setTerminal(e.target.value.replace(/[^A-Za-z0-9_-]/g, ''))} className="w-32" /></div>
          <a href={`/display/${encodeURIComponent(terminal)}`} target="_blank" rel="noreferrer"><Button variant="outline" disabled={!terminal}>เปิดจอลูกค้า ↗</Button></a>
        </div>
      </CardContent>
    </Card>
  );
}
