'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, PlayCircle, Scale, Coins, Landmark, Pencil } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

// ── API contract (apps/api/src/modules/leases) ────────────────────────────────
interface Lease {
  id: number; lease_no: string; name: string; lessor: string | null; term_months: number;
  monthly_payment: number; annual_rate_pct: number; initial_liability: number; liability_balance: number;
  accumulated_dep: number; rou_nbv: number; periods_posted: number; next_run_date: string | null;
  status: string;
}

export default function LeasesPage() {
  const qc = useQueryClient();
  const q = useQuery<{ leases: Lease[]; count: number }>({ queryKey: ['leases'], queryFn: () => api('/api/leases') });
  const recon = useQuery<{ gl_liability: number; schedule_liability: number; difference: number; reconciled: boolean }>({ queryKey: ['lease-recon'], queryFn: () => api('/api/leases/liability-reconciliation') });

  const [name, setName] = useState('');
  const [lessor, setLessor] = useState('');
  const [termMonths, setTermMonths] = useState('36');
  const [monthlyPayment, setMonthlyPayment] = useState('');
  const [annualRate, setAnnualRate] = useState('5');
  const [startDate, setStartDate] = useState('');
  const [selected, setSelected] = useState<Lease | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api('/api/leases', {
        method: 'POST',
        body: JSON.stringify({
          name,
          lessor: lessor || undefined,
          term_months: Number(termMonths) || 0,
          monthly_payment: Number(monthlyPayment) || 0,
          annual_rate_pct: annualRate ? Number(annualRate) : undefined,
          start_date: startDate || undefined,
        }),
      }),
    onSuccess: (r: any) => {
      notifySuccess(`สร้างสัญญาเช่าสำเร็จ: ${r.lease_no}`, `ROU ${baht(r.rou_asset)} · หนี้สิน ${baht(r.initial_liability)}`);
      setName(''); setLessor(''); setMonthlyPayment('');
      qc.invalidateQueries({ queryKey: ['leases'] }); qc.invalidateQueries({ queryKey: ['lease-recon'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const run = useMutation({
    mutationFn: () => api('/api/leases/run', { method: 'POST' }),
    onSuccess: (r: any) => {
      notifySuccess(`ลงรายการงวดสัญญาเช่าแล้ว — สแกน ${r.scanned} สัญญา ลงบัญชี ${r.posted} งวด`);
      qc.invalidateQueries({ queryKey: ['leases'] }); qc.invalidateQueries({ queryKey: ['lease-recon'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const leases = q.data?.leases ?? [];
  const totalLiab = leases.reduce((s, l) => s + (l.liability_balance || 0), 0);
  const totalRou = leases.reduce((s, l) => s + (l.rou_nbv || 0), 0);
  const active = leases.filter((l) => l.status === 'active').length;

  return (
    <div>
      <PageHeader
        title="สัญญาเช่า (IFRS 16)"
        description="รับรู้สิทธิการใช้สินทรัพย์ (ROU) และหนี้สินตามสัญญาเช่าด้วยมูลค่าปัจจุบัน แล้วทยอยลงดอกเบี้ย/ค่าเสื่อม/ชำระต้นทุกงวด (LSE-01)"
      />

      <div className="space-y-5">
        <StateView q={q}>
          {q.data && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="สัญญาทั้งหมด" value={num(leases.length)} icon={Scale} tone="primary" />
              <StatCard label="กำลังผ่อน (Active)" value={num(active)} tone="success" />
              <StatCard label="หนี้สินตามสัญญาเช่า (คงเหลือ)" value={baht(totalLiab)} icon={Landmark} tone="info" />
              <StatCard label="มูลค่าสุทธิ ROU" value={baht(totalRou)} icon={Coins} tone="warning" />
            </div>
          )}
        </StateView>

        {recon.data && (
          <Card className={`flex flex-row flex-wrap items-center justify-between gap-3 px-5 py-3 ${recon.data.reconciled ? 'border-success/40 bg-success/5' : 'border-destructive/40 bg-destructive/5'}`}>
            <div className="flex items-center gap-3">
              <Badge variant={recon.data.reconciled ? 'success' : 'destructive'}>{recon.data.reconciled ? 'กระทบยอดตรง ✓' : 'พบผลต่าง ⚠'}</Badge>
              <span className="text-sm text-muted-foreground">หนี้สินตามบัญชี (GL 2600) <span className="tabular font-medium text-foreground">{baht(recon.data.gl_liability)}</span> เทียบกับยอดตามตารางสัญญา <span className="tabular font-medium text-foreground">{baht(recon.data.schedule_liability)}</span></span>
            </div>
            <span className={`text-sm tabular ${recon.data.reconciled ? 'text-muted-foreground' : 'font-medium text-destructive'}`}>ผลต่าง {baht(recon.data.difference)}</span>
          </Card>
        )}

        <Card className="max-w-4xl gap-4">
          <CardHeader>
            <CardTitle className="text-base">สร้างสัญญาเช่าใหม่</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="grid gap-2">
                <Label htmlFor="ls-name">ชื่อสัญญา</Label>
                <Input id="ls-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น เช่าพื้นที่สาขา A" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ls-lessor">ผู้ให้เช่า</Label>
                <Input id="ls-lessor" value={lessor} onChange={(e) => setLessor(e.target.value)} placeholder="ชื่อผู้ให้เช่า" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ls-start">วันเริ่มสัญญา</Label>
                <Input id="ls-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ls-term">อายุสัญญา (เดือน)</Label>
                <Input id="ls-term" type="number" min="1" value={termMonths} onChange={(e) => setTermMonths(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ls-pay">ค่าเช่า/เดือน (฿)</Label>
                <Input id="ls-pay" type="number" min="0" value={monthlyPayment} onChange={(e) => setMonthlyPayment(e.target.value)} placeholder="0" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ls-rate">อัตราคิดลดต่อปี (%)</Label>
                <Input id="ls-rate" type="number" min="0" step="0.01" value={annualRate} onChange={(e) => setAnnualRate(e.target.value)} />
              </div>
            </div>
            <Button disabled={create.isPending || !name.trim() || !monthlyPayment || !termMonths} onClick={() => create.mutate()}>
              <Plus className="size-4" /> {create.isPending ? 'กำลังบันทึก…' : 'สร้างสัญญาเช่า'}
            </Button>
          </CardContent>
        </Card>

        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-muted-foreground">สัญญาเช่า — คลิกแถวเพื่อแก้ไข/ปรับปรุงสัญญา</h3>
          <Button variant="outline" size="sm" disabled={run.isPending} onClick={() => run.mutate()}>
            <PlayCircle className="size-4" /> {run.isPending ? 'กำลังลงรายการ…' : 'ลงรายการงวดที่ครบกำหนดเดี๋ยวนี้'}
          </Button>
        </div>

        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={leases}
              rowKey={(r) => r.lease_no}
              onRowClick={(r) => setSelected((s) => (s?.lease_no === r.lease_no ? null : r))}
              emptyState={{ icon: Scale, title: 'ยังไม่มีสัญญาเช่า', description: 'สร้างสัญญาเช่าแรกจากแบบฟอร์มด้านบน — ระบบจะคำนวณ ROU และหนี้สินตามมูลค่าปัจจุบันให้อัตโนมัติ' }}
              columns={[
                { key: 'lease_no', label: 'เลขที่', render: (r) => <span className="font-medium">{r.lease_no}</span> },
                { key: 'name', label: 'ชื่อสัญญา' },
                { key: 'term_months', label: 'อายุ (ด.)', align: 'right', render: (r) => <span className="tabular">{num(r.term_months)}</span> },
                { key: 'monthly_payment', label: 'ค่าเช่า/เดือน', align: 'right', render: (r) => <span className="tabular">{baht(r.monthly_payment)}</span> },
                { key: 'liability_balance', label: 'หนี้สินคงเหลือ', align: 'right', render: (r) => <span className="tabular">{baht(r.liability_balance)}</span> },
                { key: 'rou_nbv', label: 'ROU สุทธิ', align: 'right', render: (r) => <span className="tabular">{baht(r.rou_nbv)}</span> },
                { key: 'periods_posted', label: 'งวดที่ลงแล้ว', align: 'right', render: (r) => <span className="tabular">{num(r.periods_posted)}/{num(r.term_months)}</span> },
                { key: 'next_run_date', label: 'งวดถัดไป', render: (r) => thaiDate(r.next_run_date) },
                { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              ]}
            />
          )}
        </StateView>

        {selected && <ModifyLease lease={selected} onDone={() => { setSelected(null); qc.invalidateQueries({ queryKey: ['leases'] }); qc.invalidateQueries({ queryKey: ['lease-recon'] }); }} />}
      </div>
    </div>
  );
}

function ModifyLease({ lease, onDone }: { lease: Lease; onDone: () => void }) {
  const [payment, setPayment] = useState('');
  const [remaining, setRemaining] = useState('');
  const [rate, setRate] = useState('');
  const [effective, setEffective] = useState('');

  const modify = useMutation({
    mutationFn: () =>
      api(`/api/leases/${lease.lease_no}/modify`, {
        method: 'POST',
        body: JSON.stringify({
          new_monthly_payment: payment ? Number(payment) : undefined,
          new_remaining_months: remaining ? Number(remaining) : undefined,
          new_annual_rate_pct: rate ? Number(rate) : undefined,
          effective_date: effective || undefined,
        }),
      }),
    onSuccess: (r: any) => {
      notifySuccess(
        `ปรับปรุงสัญญา ${r.lease_no} แล้ว`,
        `หนี้สิน ${baht(r.liability_before)} → ${baht(r.liability_after)}${r.remeasurement_gain ? ` · กำไรจากการวัดมูลค่าใหม่ ${baht(r.remeasurement_gain)}` : ''}`,
      );
      onDone();
    },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Card className="max-w-3xl gap-4 border-primary/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Pencil className="size-4" /> ปรับปรุงสัญญา (Remeasurement) — {lease.lease_no}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          กรอกเฉพาะค่าที่ต้องการเปลี่ยน — ระบบจะคำนวณมูลค่าปัจจุบันใหม่และปรับ ROU/หนี้สิน (หากลดต่ำกว่ามูลค่า ROU จะรับรู้กำไรเข้า P&L)
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="grid gap-2">
            <Label htmlFor="mo-pay">ค่าเช่า/เดือนใหม่ (฿)</Label>
            <Input id="mo-pay" type="number" min="0" value={payment} onChange={(e) => setPayment(e.target.value)} placeholder={String(lease.monthly_payment)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mo-rem">งวดคงเหลือใหม่ (เดือน)</Label>
            <Input id="mo-rem" type="number" min="1" value={remaining} onChange={(e) => setRemaining(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mo-rate">อัตราคิดลดใหม่ (%)</Label>
            <Input id="mo-rate" type="number" min="0" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} placeholder={String(lease.annual_rate_pct)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mo-eff">วันที่มีผล</Label>
            <Input id="mo-eff" type="date" value={effective} onChange={(e) => setEffective(e.target.value)} />
          </div>
        </div>
        <div className="flex gap-2">
          <Button disabled={modify.isPending || (!payment && !remaining && !rate)} onClick={() => modify.mutate()}>
            {modify.isPending ? 'กำลังปรับปรุง…' : 'ปรับปรุงสัญญา'}
          </Button>
          <Button variant="ghost" onClick={onDone}>ยกเลิก</Button>
        </div>
      </CardContent>
    </Card>
  );
}
