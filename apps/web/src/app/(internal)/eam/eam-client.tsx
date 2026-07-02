'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Wrench, CalendarClock, PlayCircle, Activity, ListTree, Gauge } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
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
import { statusVariant } from '@/components/ui';

// ── API contract (apps/api/src/modules/eam) ───────────────────────────────────
interface WorkOrder {
  wo_no: string; asset_no: string; type: string; priority: string; status: string;
  description: string | null; scheduled_date: string | null; completed_date: string | null;
  vendor_name: string | null; cost_estimate: number; actual_cost: number; downtime_hours: number;
  ap_txn_no: string | null; pm_schedule_id: number | null; created_by: string | null;
}
interface WoLine { kind: string; description: string | null; quantity: number; hours: number; unit_cost: number; amount: number }
interface PmSchedule {
  id: number; asset_no: string; name: string; interval_days: number | null; meter_interval: number | null;
  last_service_date: string | null; last_service_meter: number | null; next_due_date: string | null; active: boolean;
}
interface Reliability {
  asset_no: string; work_orders: number; corrective_failures: number; preventive: number; open: number;
  total_downtime_hours: number; mtbf_days: number | null; total_maintenance_cost: number;
}

const selectCls =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

export default function EamWorkspace({ initialWo }: { initialWo?: unknown }) {
  return (
    <div>
      <PageHeader
        title="ซ่อมบำรุงสินทรัพย์ (EAM)"
        description="ใบสั่งงานซ่อม แผนบำรุงรักษาเชิงป้องกัน (PM) และดัชนีความน่าเชื่อถือของสินทรัพย์ — ปิดงานพร้อมผู้รับเหมาจะตั้งเจ้าหนี้ค่าซ่อม (5710 → 2000) อัตโนมัติ (FA-06)"
      />
      <Tabs
        tabs={[
          { key: 'wo', label: 'ใบสั่งงานซ่อม', content: <WorkOrders initialData={initialWo} /> },
          { key: 'pm', label: 'แผนบำรุงรักษา (PM)', content: <PmSchedules /> },
          { key: 'rel', label: 'ความน่าเชื่อถือ', content: <ReliabilityTab /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── ใบสั่งงานซ่อม ─────────────────────────
function WorkOrders({ initialData }: { initialData?: unknown }) {
  const qc = useQueryClient();
  // Server-prefetched payload (see page.tsx) renders instantly; react-query still owns the cache and
  // refetches on invalidation exactly as before. A null/undefined prefetch = the old client-only path.
  const q = useQuery<{ work_orders: WorkOrder[]; count: number }>({
    queryKey: ['eam-wo'],
    queryFn: () => api('/api/eam/work-orders?limit=200'),
    initialData: (initialData as { work_orders: WorkOrder[]; count: number } | undefined) ?? undefined,
  });

  const [assetNo, setAssetNo] = useState('');
  const [type, setType] = useState('corrective');
  const [priority, setPriority] = useState('medium');
  const [description, setDescription] = useState('');
  const [scheduledDate, setScheduledDate] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [costEstimate, setCostEstimate] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api('/api/eam/work-orders', {
        method: 'POST',
        body: JSON.stringify({
          asset_no: assetNo,
          type,
          priority,
          description: description || undefined,
          scheduled_date: scheduledDate || undefined,
          vendor_name: vendorName || undefined,
          cost_estimate: costEstimate ? Number(costEstimate) : undefined,
        }),
      }),
    onSuccess: (r: any) => {
      notifySuccess(`สร้างใบสั่งงานสำเร็จ: ${r.wo_no}`);
      setAssetNo(''); setDescription(''); setVendorName(''); setCostEstimate(''); setScheduledDate('');
      qc.invalidateQueries({ queryKey: ['eam-wo'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const setStatus = useMutation({
    mutationFn: (v: { woNo: string; status: string }) =>
      api(`/api/eam/work-orders/${v.woNo}/status`, { method: 'PATCH', body: JSON.stringify({ status: v.status }) }),
    onSuccess: (r: any) => {
      notifySuccess(`อัปเดตสถานะ ${r.wo_no} → ${r.status}${r.ap_txn_no ? ` · ตั้งเจ้าหนี้ ${r.ap_txn_no}` : ''}`);
      qc.invalidateQueries({ queryKey: ['eam-wo'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const rows = q.data?.work_orders ?? [];
  const open = rows.filter((r) => r.status === 'open' || r.status === 'in_progress').length;
  const done = rows.filter((r) => r.status === 'completed').length;
  const cost = rows.reduce((s, r) => s + (r.actual_cost || 0), 0);

  return (
    <div className="space-y-5">
      <StateView q={q}>
        {q.data && (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="ใบสั่งงานทั้งหมด" value={num(rows.length)} icon={Wrench} tone="primary" />
            <StatCard label="ค้างดำเนินการ" value={num(open)} tone="warning" />
            <StatCard label="เสร็จสิ้น" value={num(done)} tone="success" />
            <StatCard label="ต้นทุนซ่อมจริง (รวม)" value={baht(cost)} icon={Activity} tone="info" />
          </div>
        )}
      </StateView>

      <Card className="max-w-4xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">สร้างใบสั่งงานซ่อม</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="wo-asset">รหัสสินทรัพย์</Label>
              <Input id="wo-asset" value={assetNo} onChange={(e) => setAssetNo(e.target.value)} placeholder="เช่น FA-0001" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="wo-type">ประเภทงาน</Label>
              <select id="wo-type" className={selectCls} value={type} onChange={(e) => setType(e.target.value)}>
                <option value="corrective">แก้ไข (Corrective)</option>
                <option value="preventive">เชิงป้องกัน (Preventive)</option>
                <option value="inspection">ตรวจสอบ (Inspection)</option>
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="wo-pri">ความสำคัญ</Label>
              <select id="wo-pri" className={selectCls} value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="low">ต่ำ</option>
                <option value="medium">ปานกลาง</option>
                <option value="high">สูง</option>
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="wo-sched">วันที่นัดซ่อม</Label>
              <Input id="wo-sched" type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="wo-vendor">ผู้รับเหมา (ถ้ามี)</Label>
              <Input id="wo-vendor" value={vendorName} onChange={(e) => setVendorName(e.target.value)} placeholder="ชื่อผู้รับเหมา" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="wo-cost">งบประมาณ (฿)</Label>
              <Input id="wo-cost" type="number" min="0" value={costEstimate} onChange={(e) => setCostEstimate(e.target.value)} placeholder="0" />
            </div>
            <div className="grid gap-2 sm:col-span-2 lg:col-span-3">
              <Label htmlFor="wo-desc">รายละเอียด</Label>
              <Input id="wo-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="อาการ / งานที่ต้องทำ" />
            </div>
          </div>
          <Button disabled={create.isPending || !assetNo.trim()} onClick={() => create.mutate()}>
            <Plus className="size-4" /> {create.isPending ? 'กำลังบันทึก…' : 'สร้างใบสั่งงาน'}
          </Button>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={rows}
            rowKey={(r) => r.wo_no}
            onRowClick={(r) => setSelected((id) => (id === r.wo_no ? null : r.wo_no))}
            emptyState={{ icon: Wrench, title: 'ยังไม่มีใบสั่งงานซ่อม', description: 'สร้างใบสั่งงานแรกจากแบบฟอร์มด้านบน หรือให้แผน PM สร้างให้อัตโนมัติ' }}
            columns={[
              { key: 'wo_no', label: 'เลขที่', render: (r) => <span className="font-medium">{r.wo_no}</span> },
              { key: 'asset_no', label: 'สินทรัพย์' },
              { key: 'type', label: 'ประเภท', render: (r) => <Badge variant="info">{r.type}</Badge> },
              { key: 'priority', label: 'ความสำคัญ', render: (r) => <Badge variant={statusVariant(r.priority)}>{r.priority}</Badge> },
              { key: 'scheduled_date', label: 'นัดซ่อม', render: (r) => thaiDate(r.scheduled_date) },
              { key: 'actual_cost', label: 'ต้นทุนจริง', align: 'right', render: (r) => <span className="tabular">{baht(r.actual_cost)}</span> },
              { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              {
                key: '_act',
                label: 'เปลี่ยนสถานะ',
                sortable: false,
                render: (r) =>
                  r.status === 'completed' || r.status === 'cancelled' ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <select
                      className={selectCls}
                      value=""
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        if (e.target.value) setStatus.mutate({ woNo: r.wo_no, status: e.target.value });
                      }}
                    >
                      <option value="">เลือก…</option>
                      <option value="in_progress">กำลังซ่อม</option>
                      <option value="completed">เสร็จสิ้น</option>
                      <option value="cancelled">ยกเลิก</option>
                    </select>
                  ),
              },
            ]}
          />
        )}
      </StateView>

      {selected && <WorkOrderLines woNo={selected} />}
    </div>
  );
}

function WorkOrderLines({ woNo }: { woNo: string }) {
  const qc = useQueryClient();
  const q = useQuery<{ wo_no: string; lines: WoLine[]; labor_total: number; parts_total: number; total: number }>({
    queryKey: ['eam-wo-lines', woNo],
    queryFn: () => api(`/api/eam/work-orders/${woNo}/lines`),
  });

  const [kind, setKind] = useState('labor');
  const [desc, setDesc] = useState('');
  const [qty, setQty] = useState('1');
  const [hours, setHours] = useState('');
  const [unitCost, setUnitCost] = useState('');

  const add = useMutation({
    mutationFn: () =>
      api(`/api/eam/work-orders/${woNo}/lines`, {
        method: 'POST',
        body: JSON.stringify({
          kind,
          description: desc || undefined,
          quantity: kind === 'part' ? Number(qty) || 1 : undefined,
          hours: kind === 'labor' ? Number(hours) || 0 : undefined,
          unit_cost: Number(unitCost) || 0,
        }),
      }),
    onSuccess: () => {
      notifySuccess('เพิ่มรายการต้นทุนแล้ว');
      setDesc(''); setHours(''); setUnitCost('');
      qc.invalidateQueries({ queryKey: ['eam-wo-lines', woNo] });
      qc.invalidateQueries({ queryKey: ['eam-wo'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <ListTree className="size-4" /> ต้นทุนงานซ่อม — {woNo}
          {q.data && (
            <span className="text-sm font-normal text-muted-foreground">
              ค่าแรง {baht(q.data.labor_total)} · อะไหล่ {baht(q.data.parts_total)} · รวม {baht(q.data.total)}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-2">
            <Label htmlFor="ln-kind">ประเภท</Label>
            <select id="ln-kind" className={selectCls} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="labor">ค่าแรง</option>
              <option value="part">อะไหล่</option>
            </select>
          </div>
          <div className="grid grow gap-2">
            <Label htmlFor="ln-desc">รายละเอียด</Label>
            <Input id="ln-desc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="ช่าง / อะไหล่" />
          </div>
          {kind === 'part' ? (
            <div className="grid gap-2">
              <Label htmlFor="ln-qty">จำนวน</Label>
              <Input id="ln-qty" type="number" min="0" value={qty} onChange={(e) => setQty(e.target.value)} className="max-w-[100px]" />
            </div>
          ) : (
            <div className="grid gap-2">
              <Label htmlFor="ln-hours">ชั่วโมง</Label>
              <Input id="ln-hours" type="number" min="0" value={hours} onChange={(e) => setHours(e.target.value)} className="max-w-[100px]" />
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="ln-uc">ต้นทุน/หน่วย (฿)</Label>
            <Input id="ln-uc" type="number" min="0" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} className="max-w-[140px]" />
          </div>
          <Button disabled={add.isPending} onClick={() => add.mutate()}>
            <Plus className="size-4" /> เพิ่ม
          </Button>
        </div>

        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={q.data.lines}
              rowKey={(_r, i) => i}
              emptyText="ยังไม่มีรายการต้นทุน"
              columns={[
                { key: 'kind', label: 'ประเภท', render: (r) => <Badge variant="info">{r.kind}</Badge> },
                { key: 'description', label: 'รายละเอียด', render: (r) => r.description ?? '—' },
                { key: 'quantity', label: 'จำนวน', align: 'right', render: (r) => <span className="tabular">{num(r.quantity)}</span> },
                { key: 'hours', label: 'ชั่วโมง', align: 'right', render: (r) => <span className="tabular">{num(r.hours)}</span> },
                { key: 'unit_cost', label: 'ต้นทุน/หน่วย', align: 'right', render: (r) => <span className="tabular">{baht(r.unit_cost)}</span> },
                { key: 'amount', label: 'รวม', align: 'right', render: (r) => <span className="tabular">{baht(r.amount)}</span> },
              ]}
            />
          )}
        </StateView>
      </CardContent>
    </Card>
  );
}

// ───────────────────────── แผนบำรุงรักษา (PM) ─────────────────────────
function PmSchedules() {
  const qc = useQueryClient();
  const q = useQuery<{ schedules: PmSchedule[]; count: number }>({
    queryKey: ['eam-pm'],
    queryFn: () => api('/api/eam/pm-schedules'),
  });

  const [assetNo, setAssetNo] = useState('');
  const [name, setName] = useState('');
  const [intervalDays, setIntervalDays] = useState('');
  const [meterInterval, setMeterInterval] = useState('');
  const [nextDue, setNextDue] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api('/api/eam/pm-schedules', {
        method: 'POST',
        body: JSON.stringify({
          asset_no: assetNo,
          name,
          interval_days: intervalDays ? Number(intervalDays) : undefined,
          meter_interval: meterInterval ? Number(meterInterval) : undefined,
          next_due_date: nextDue || undefined,
        }),
      }),
    onSuccess: () => {
      notifySuccess('สร้างแผน PM แล้ว');
      setAssetNo(''); setName(''); setIntervalDays(''); setMeterInterval(''); setNextDue('');
      qc.invalidateQueries({ queryKey: ['eam-pm'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const run = useMutation({
    mutationFn: () => api('/api/eam/pm/run', { method: 'POST' }),
    onSuccess: (r: any) => {
      notifySuccess(`เดินแผน PM แล้ว — สแกน ${r.scanned} แผน สร้างใบสั่งงาน ${r.generated} รายการ`);
      qc.invalidateQueries({ queryKey: ['eam-pm'] });
      qc.invalidateQueries({ queryKey: ['eam-wo'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const rows = q.data?.schedules ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StateView q={q}>
          {q.data && (
            <div className="grid w-full gap-4 sm:grid-cols-3">
              <StatCard label="แผน PM ทั้งหมด" value={num(rows.length)} icon={CalendarClock} tone="primary" />
              <StatCard label="ใช้งานอยู่" value={num(rows.filter((r) => r.active).length)} tone="success" />
              <StatCard
                label="ครบกำหนดแล้ว"
                value={num(rows.filter((r) => r.next_due_date && r.next_due_date <= new Date().toISOString().slice(0, 10)).length)}
                tone="warning"
              />
            </div>
          )}
        </StateView>
      </div>

      <Card className="max-w-4xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">สร้างแผนบำรุงรักษาเชิงป้องกัน</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="pm-asset">รหัสสินทรัพย์</Label>
              <Input id="pm-asset" value={assetNo} onChange={(e) => setAssetNo(e.target.value)} placeholder="เช่น FA-0001" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pm-name">ชื่อแผน</Label>
              <Input id="pm-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น เปลี่ยนน้ำมันเครื่อง" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pm-next">ครบกำหนดครั้งแรก</Label>
              <Input id="pm-next" type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pm-days">รอบตามเวลา (วัน)</Label>
              <Input id="pm-days" type="number" min="0" value={intervalDays} onChange={(e) => setIntervalDays(e.target.value)} placeholder="เช่น 90" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pm-meter">รอบตามมิเตอร์ (หน่วย)</Label>
              <Input id="pm-meter" type="number" min="0" value={meterInterval} onChange={(e) => setMeterInterval(e.target.value)} placeholder="เช่น 5000" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">ระบุรอบตามเวลา หรือ รอบตามมิเตอร์ อย่างน้อยหนึ่งอย่าง</p>
          <Button disabled={create.isPending || !assetNo.trim() || !name.trim() || (!intervalDays && !meterInterval)} onClick={() => create.mutate()}>
            <Plus className="size-4" /> {create.isPending ? 'กำลังบันทึก…' : 'สร้างแผน PM'}
          </Button>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-muted-foreground">แผนบำรุงรักษา</h3>
        <Button variant="outline" size="sm" disabled={run.isPending} onClick={() => run.mutate()}>
          <PlayCircle className="size-4" /> {run.isPending ? 'กำลังเดินแผน…' : 'เดินแผน PM ที่ครบกำหนดเดี๋ยวนี้'}
        </Button>
      </div>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={rows}
            rowKey={(r) => r.id}
            emptyState={{ icon: CalendarClock, title: 'ยังไม่มีแผน PM', description: 'สร้างแผนบำรุงรักษาเชิงป้องกันเพื่อให้ระบบออกใบสั่งงานอัตโนมัติเมื่อครบกำหนด' }}
            columns={[
              { key: 'asset_no', label: 'สินทรัพย์', render: (r) => <span className="font-medium">{r.asset_no}</span> },
              { key: 'name', label: 'ชื่อแผน' },
              { key: 'interval_days', label: 'รอบ (วัน)', align: 'right', render: (r) => (r.interval_days ? <span className="tabular">{num(r.interval_days)}</span> : '—') },
              { key: 'meter_interval', label: 'รอบ (มิเตอร์)', align: 'right', render: (r) => (r.meter_interval ? <span className="tabular">{num(r.meter_interval)}</span> : '—') },
              { key: 'next_due_date', label: 'ครบกำหนดถัดไป', render: (r) => thaiDate(r.next_due_date) },
              { key: 'active', label: 'สถานะ', render: (r) => <Badge variant={r.active ? 'success' : 'secondary'}>{r.active ? 'ใช้งาน' : 'ปิด'}</Badge> },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── ความน่าเชื่อถือ + มิเตอร์ ─────────────────────────
function ReliabilityTab() {
  const qc = useQueryClient();
  const [assetNo, setAssetNo] = useState('');
  const [query, setQuery] = useState('');
  const q = useQuery<Reliability>({
    queryKey: ['eam-rel', query],
    queryFn: () => api(`/api/eam/assets/${encodeURIComponent(query)}/reliability`),
    enabled: !!query,
  });
  const meters = useQuery<{ asset_no: string; readings: { reading_date: string; meter_value: number; note: string | null }[]; count: number }>({
    queryKey: ['eam-meters', query],
    queryFn: () => api(`/api/eam/assets/${encodeURIComponent(query)}/meters`),
    enabled: !!query,
  });

  const [meterValue, setMeterValue] = useState('');
  const [readingDate, setReadingDate] = useState('');
  const recordMeter = useMutation({
    mutationFn: () =>
      api(`/api/eam/assets/${encodeURIComponent(query)}/meter`, {
        method: 'POST',
        body: JSON.stringify({ meter_value: Number(meterValue) || 0, reading_date: readingDate || undefined }),
      }),
    onSuccess: () => {
      notifySuccess('บันทึกค่ามิเตอร์แล้ว');
      setMeterValue('');
      qc.invalidateQueries({ queryKey: ['eam-meters', query] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="space-y-5">
      <Card className="max-w-xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">ดูดัชนีความน่าเชื่อถือของสินทรัพย์</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid grow gap-2">
              <Label htmlFor="rel-asset">รหัสสินทรัพย์</Label>
              <Input id="rel-asset" value={assetNo} onChange={(e) => setAssetNo(e.target.value)} placeholder="เช่น FA-0001" onKeyDown={(e) => e.key === 'Enter' && setQuery(assetNo.trim())} />
            </div>
            <Button disabled={!assetNo.trim()} onClick={() => setQuery(assetNo.trim())}>
              <Gauge className="size-4" /> ดูข้อมูล
            </Button>
          </div>
        </CardContent>
      </Card>

      {query && (
        <StateView q={q}>
          {q.data && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="ใบสั่งงานทั้งหมด" value={num(q.data.work_orders)} icon={Wrench} tone="primary" />
              <StatCard label="งานซ่อมจากการเสีย (CM)" value={num(q.data.corrective_failures)} tone="danger" />
              <StatCard label="MTBF (วันเฉลี่ยระหว่างเสีย)" value={q.data.mtbf_days != null ? num(q.data.mtbf_days) : '—'} tone="info" />
              <StatCard label="ต้นทุนซ่อมสะสม" value={baht(q.data.total_maintenance_cost)} tone="warning" hint={`ดาวน์ไทม์รวม ${num(q.data.total_downtime_hours)} ชม.`} />
            </div>
          )}
        </StateView>
      )}

      {query && (
        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="text-base">บันทึกค่ามิเตอร์ — {query}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid gap-2">
                <Label htmlFor="mt-val">ค่ามิเตอร์</Label>
                <Input id="mt-val" type="number" min="0" value={meterValue} onChange={(e) => setMeterValue(e.target.value)} className="max-w-[180px]" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="mt-date">วันที่อ่าน</Label>
                <Input id="mt-date" type="date" value={readingDate} onChange={(e) => setReadingDate(e.target.value)} />
              </div>
              <Button disabled={recordMeter.isPending || !meterValue} onClick={() => recordMeter.mutate()}>
                <Plus className="size-4" /> บันทึก
              </Button>
            </div>
            <StateView q={meters}>
              {meters.data && (
                <DataTable
                  rows={meters.data.readings}
                  rowKey={(_r, i) => i}
                  emptyText="ยังไม่มีการอ่านค่ามิเตอร์"
                  columns={[
                    { key: 'reading_date', label: 'วันที่', render: (r) => thaiDate(r.reading_date) },
                    { key: 'meter_value', label: 'ค่ามิเตอร์', align: 'right', render: (r) => <span className="tabular">{num(r.meter_value)}</span> },
                    { key: 'note', label: 'หมายเหตุ', render: (r) => r.note ?? '—' },
                  ]}
                />
              )}
            </StateView>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
