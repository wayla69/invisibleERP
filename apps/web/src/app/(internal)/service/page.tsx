'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, AlertTriangle, ShieldCheck, ClipboardList, Repeat } from 'lucide-react';
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

// GET /api/service/contracts → { contracts: [...], count }
interface Contract { id: number; contract_no: string; customer_name: string; sla_tier: string; response_hours: number; resolution_hours: number; start_date: string | null; end_date: string | null; status: string; monthly_value: number }
// GET /api/service/subscriptions → { subscriptions: [...], count }
interface Sub { id: number; sub_no: string; customer_name: string; product_code: string; billing_cycle: string; unit_price: number; qty: number; next_billing_date: string | null; status: string }
// GET /api/service/contracts/:id/events → { events: [...], count }
interface SlaEvent { id: number; event_no: string; title: string; priority: string; opened_at: string | null; response_due_at: string | null; responded_at: string | null; resolved_at: string | null; resolution_due_at: string | null; response_breached: boolean; resolution_breached: boolean; status: string }

const selectCls =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

export default function ServicePage() {
  return (
    <div>
      <PageHeader title="บริการ & SLA" description="สัญญาบริการ ระดับ SLA และการสมัครสมาชิกแบบเรียกเก็บเงินซ้ำ" />
      <Tabs
        tabs={[
          { key: 'contracts', label: 'สัญญาบริการ', content: <Contracts /> },
          { key: 'subs', label: 'การสมัครสมาชิก', content: <Subscriptions /> },
        ]}
      />
    </div>
  );
}

function Contracts() {
  const qc = useQueryClient();
  const q = useQuery<{ contracts: Contract[]; count: number }>({ queryKey: ['svc-contracts'], queryFn: () => api('/api/service/contracts') });

  const [selected, setSelected] = useState<number | null>(null);

  // Create-contract form state
  const [customerName, setCustomerName] = useState('');
  const [slaTier, setSlaTier] = useState('Silver');
  const [startDate, setStartDate] = useState('2026-01-01');
  const [endDate, setEndDate] = useState('2026-12-31');
  const [monthlyValue, setMonthlyValue] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api('/api/service/contracts', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: customerName,
          sla_tier: slaTier,
          start_date: startDate,
          end_date: endDate,
          monthly_value: Number(monthlyValue) || 0,
        }),
      }),
    onSuccess: (r: any) => {
      notifySuccess(`สร้างสัญญาสำเร็จ: ${r.contract_no}`);
      setCustomerName(''); setMonthlyValue('');
      qc.invalidateQueries({ queryKey: ['svc-contracts'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const contracts = q.data?.contracts ?? [];
  const activeCount = contracts.filter((c) => c.status === 'Active').length;
  const monthlyTotal = contracts.reduce((s, c) => s + (c.status === 'Active' ? c.monthly_value : 0), 0);

  return (
    <div className="space-y-5">
      <StateView q={q}>
        {q.data && (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="สัญญาทั้งหมด" value={num(contracts.length)} icon={ShieldCheck} tone="primary" />
            <StatCard label="สัญญาที่ใช้งานอยู่" value={num(activeCount)} tone="success" />
            <StatCard label="มูลค่ารายเดือน (Active)" value={baht(monthlyTotal)} tone="info" />
          </div>
        )}
      </StateView>

      {/* Create contract */}
      <Card className="max-w-3xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">สร้างสัญญาบริการ</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="svc-cust">ลูกค้า</Label>
              <Input id="svc-cust" value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="ชื่อลูกค้า" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="svc-tier">ระดับ SLA</Label>
              <select id="svc-tier" className={selectCls} value={slaTier} onChange={(e) => setSlaTier(e.target.value)}>
                {['Bronze', 'Silver', 'Gold', 'Platinum'].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="svc-start">วันเริ่ม</Label>
              <Input id="svc-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="svc-end">วันสิ้นสุด</Label>
              <Input id="svc-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="svc-monthly">มูลค่ารายเดือน (฿)</Label>
              <Input id="svc-monthly" type="number" min="0" value={monthlyValue} onChange={(e) => setMonthlyValue(e.target.value)} placeholder="0" />
            </div>
          </div>
          <Button disabled={create.isPending || !customerName.trim()} onClick={() => create.mutate()}>
            <Plus className="size-4" /> {create.isPending ? 'กำลังบันทึก…' : 'สร้างสัญญา'}
          </Button>
        </CardContent>
      </Card>

      {/* Contracts table */}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">สัญญาบริการ — คลิกแถวเพื่อดู/บันทึกเหตุการณ์ SLA</h3>
        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={contracts}
              onRowClick={(r: Contract) => setSelected((id) => (id === r.id ? null : r.id))}
              emptyState={{ icon: ShieldCheck, title: 'ยังไม่มีสัญญาบริการ', description: 'กรอกแบบฟอร์มด้านบนเพื่อสร้างสัญญาบริการรายการแรก' }}
              columns={[
                { key: 'contract_no', label: 'เลขที่' },
                { key: 'customer_name', label: 'ลูกค้า' },
                { key: 'sla_tier', label: 'ระดับ SLA', render: (r: Contract) => <Badge variant="info">{r.sla_tier}</Badge> },
                { key: 'response_hours', label: 'ตอบสนอง (ชม.)', align: 'right', render: (r: Contract) => <span className="tabular">{num(r.response_hours)}</span> },
                { key: 'resolution_hours', label: 'แก้ไข (ชม.)', align: 'right', render: (r: Contract) => <span className="tabular">{num(r.resolution_hours)}</span> },
                { key: 'monthly_value', label: 'มูลค่า/เดือน', align: 'right', render: (r: Contract) => <span className="tabular">{baht(r.monthly_value)}</span> },
                { key: 'status', label: 'สถานะ', render: (r: Contract) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              ]}
            />
          )}
        </StateView>
      </div>

      {selected != null && <ContractEvents contractId={selected} />}
    </div>
  );
}

function ContractEvents({ contractId }: { contractId: number }) {
  const qc = useQueryClient();
  const q = useQuery<{ events: SlaEvent[]; count: number }>({
    queryKey: ['svc-events', contractId],
    queryFn: () => api(`/api/service/contracts/${contractId}/events`),
  });

  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('P3');

  const log = useMutation({
    mutationFn: () =>
      api(`/api/service/contracts/${contractId}/events`, {
        method: 'POST',
        body: JSON.stringify({ title, priority }),
      }),
    onSuccess: (r: any) => {
      notifySuccess(`บันทึกเหตุการณ์สำเร็จ: ${r.event_no}`);
      setTitle('');
      qc.invalidateQueries({ queryKey: ['svc-events', contractId] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const events = q.data?.events ?? [];
  const breaches = events.filter((e) => e.response_breached || e.resolution_breached).length;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          เหตุการณ์ SLA — สัญญา #{contractId}
          {breaches > 0 && (
            <Badge variant="destructive" className="gap-1">
              <AlertTriangle className="size-3.5" /> เกิน SLA {num(breaches)} รายการ
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Log event */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid grow gap-2">
            <Label htmlFor="ev-title">หัวข้อเหตุการณ์</Label>
            <Input id="ev-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="เช่น ระบบล่ม / ขอความช่วยเหลือ" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ev-pri">ความสำคัญ</Label>
            <select id="ev-pri" className={selectCls} value={priority} onChange={(e) => setPriority(e.target.value)}>
              {['P1', 'P2', 'P3', 'P4'].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <Button disabled={log.isPending || !title.trim()} onClick={() => log.mutate()}>
            <Plus className="size-4" /> บันทึกเหตุการณ์
          </Button>
        </div>

        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={events}
              emptyState={{ icon: ClipboardList, title: 'ยังไม่มีเหตุการณ์ SLA', description: 'บันทึกเหตุการณ์แรกจากแบบฟอร์มด้านบน' }}
              columns={[
                { key: 'event_no', label: 'เลขที่' },
                { key: 'title', label: 'หัวข้อ' },
                { key: 'priority', label: 'ความสำคัญ', render: (r: SlaEvent) => <Badge variant={statusVariant(r.priority)}>{r.priority}</Badge> },
                { key: 'opened_at', label: 'เปิดเมื่อ', render: (r: SlaEvent) => thaiDate(r.opened_at) },
                { key: 'status', label: 'สถานะ', render: (r: SlaEvent) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                {
                  key: 'response_breached',
                  label: 'ตอบสนอง SLA',
                  render: (r: SlaEvent) => (
                    <Badge variant={r.response_breached ? 'destructive' : 'success'}>{r.response_breached ? 'เกิน SLA' : 'ภายในเวลา'}</Badge>
                  ),
                },
                {
                  key: 'resolution_breached',
                  label: 'แก้ไข SLA',
                  render: (r: SlaEvent) => (
                    <Badge variant={r.resolution_breached ? 'destructive' : 'success'}>{r.resolution_breached ? 'เกิน SLA' : 'ภายในเวลา'}</Badge>
                  ),
                },
              ]}
            />
          )}
        </StateView>
      </CardContent>
    </Card>
  );
}

function Subscriptions() {
  // list endpoint returns rows under `subscriptions`
  const q = useQuery<{ subscriptions: Sub[]; count: number }>({ queryKey: ['svc-subs'], queryFn: () => api('/api/service/subscriptions') });
  const subs = q.data?.subscriptions ?? [];
  const mrr = subs.reduce((s, x) => s + (x.status === 'Active' ? x.unit_price * x.qty : 0), 0);

  return (
    <div className="space-y-5">
      <StateView q={q}>
        {q.data && (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="การสมัครทั้งหมด" value={num(subs.length)} tone="primary" />
            <StatCard label="ใช้งานอยู่" value={num(subs.filter((s) => s.status === 'Active').length)} tone="success" />
            <StatCard label="รายได้ต่อรอบ (Active)" value={baht(mrr)} tone="info" hint="unit_price × qty" />
          </div>
        )}
      </StateView>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={subs}
            emptyState={{ icon: Repeat, title: 'ยังไม่มีการสมัครสมาชิก', description: 'การสมัครสมาชิกแบบเรียกเก็บเงินซ้ำจะแสดงที่นี่' }}
            columns={[
              { key: 'sub_no', label: 'เลขที่' },
              { key: 'customer_name', label: 'ลูกค้า' },
              { key: 'product_code', label: 'สินค้า' },
              { key: 'billing_cycle', label: 'รอบบิล' },
              { key: 'unit_price', label: 'ราคา/หน่วย', align: 'right', render: (r: Sub) => <span className="tabular">{baht(r.unit_price)}</span> },
              { key: 'qty', label: 'จำนวน', align: 'right', render: (r: Sub) => <span className="tabular">{num(r.qty)}</span> },
              { key: 'next_billing_date', label: 'บิลครั้งถัดไป', render: (r: Sub) => thaiDate(r.next_billing_date) },
              { key: 'status', label: 'สถานะ', render: (r: Sub) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}
