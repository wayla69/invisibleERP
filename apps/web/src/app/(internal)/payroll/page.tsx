'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, Play, Plus, Users, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const thisMonth = () => new Date().toISOString().slice(0, 7); // YYYY-MM

export default function PayrollPage() {
  return (
    <div>
      <PageHeader
        title="เงินเดือน (Payroll)"
        description="พนักงาน · ประกันสังคม 5% (สูงสุด 750) + ภาษีหัก ณ ที่จ่าย (ภ.ง.ด.1) · ลงบัญชีอัตโนมัติ"
      />
      <Tabs
        tabs={[
          { key: 'emp', label: 'พนักงาน', content: <Employees /> },
          { key: 'run', label: 'จ่ายเงินเดือน', content: <RunPayroll /> },
          { key: 'pnd1', label: 'ภ.ง.ด.1', content: <Pnd1 /> },
          { key: 'pnd1a', label: 'ภ.ง.ด.1ก (รายปี)', content: <Pnd1a /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── พนักงาน ─────────────────────────
function Employees() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['pay-emps'], queryFn: () => api('/api/payroll/employees') });
  const [f, setF] = useState({ name: '', national_id: '', position: '', monthly_salary: '', hourly_rate: '', pf_rate: '' });

  const add = useMutation({
    mutationFn: () =>
      api<{ emp_code: string }>('/api/payroll/employees', {
        method: 'POST',
        body: JSON.stringify({
          name: f.name,
          national_id: f.national_id || undefined,
          position: f.position || undefined,
          monthly_salary: Number(f.monthly_salary) || 0,
          hourly_rate: Number(f.hourly_rate) || 0,
          pf_rate: Number(f.pf_rate) || 0,
        }),
      }),
    onSuccess: (r) => {
      notifySuccess(`เพิ่มพนักงาน ${r.emp_code}`);
      setF({ name: '', national_id: '', position: '', monthly_salary: '', hourly_rate: '', pf_rate: '' });
      qc.invalidateQueries({ queryKey: ['pay-emps'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">เพิ่มพนักงาน</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5"><Label>ชื่อ-สกุล</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>เลขบัตรประชาชน</Label><Input value={f.national_id} onChange={(e) => setF({ ...f, national_id: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>ตำแหน่ง</Label><Input value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>เงินเดือน (บาท)</Label><Input type="number" min="0" value={f.monthly_salary} onChange={(e) => setF({ ...f, monthly_salary: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>ค่าแรง/ชม. (สำหรับ OT)</Label><Input type="number" min="0" value={f.hourly_rate} onChange={(e) => setF({ ...f, hourly_rate: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>กองทุนสำรองฯ (เช่น 0.05)</Label><Input type="number" min="0" step="0.01" value={f.pf_rate} onChange={(e) => setF({ ...f, pf_rate: e.target.value })} /></div>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={() => add.mutate()} disabled={!f.name || !f.monthly_salary || add.isPending}><Plus className="size-4" /> เพิ่ม</Button>
        </div>
      </Card>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.employees}
            emptyState={{ icon: Users, title: 'ยังไม่มีพนักงาน', description: 'กรอกแบบฟอร์มด้านบนเพื่อเพิ่มพนักงานคนแรก' }}
            columns={[
              { key: 'emp_code', label: 'รหัส' },
              { key: 'name', label: 'ชื่อ' },
              { key: 'position', label: 'ตำแหน่ง' },
              { key: 'monthly_salary', label: 'เงินเดือน', align: 'right', render: (r: any) => <span className="tabular">{baht(r.monthly_salary)}</span> },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── จ่ายเงินเดือน ─────────────────────────
const runStatusTh: Record<string, string> = { PendingApproval: 'รออนุมัติ', Posted: 'ผ่านแล้ว', Rejected: 'ปฏิเสธ' };
const runStatusTone = (s: string): 'warning' | 'success' | 'destructive' | 'secondary' =>
  s === 'PendingApproval' ? 'warning' : s === 'Posted' ? 'success' : s === 'Rejected' ? 'destructive' : 'secondary';

function RunPayroll() {
  const qc = useQueryClient();
  const [period, setPeriod] = useState(thisMonth());
  const runs = useQuery<any>({ queryKey: ['pay-runs'], queryFn: () => api('/api/payroll/runs') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['pay-runs'] });

  const run = useMutation({
    mutationFn: () => api<any>(`/api/payroll/runs?period=${period}`, { method: 'POST' }),
    onSuccess: (r) => {
      notifySuccess(r.already ? `งวด ${period} มีรอบแล้ว (${r.status === 'Posted' ? 'ผ่านแล้ว' : 'รออนุมัติ'})` : `เตรียมจ่ายเงินเดือน ${period}: สุทธิ ${baht(r.net_total)} — รอผู้อื่นอนุมัติ`);
      refresh();
    },
    onError: (e: any) => notifyError(e.message),
  });
  const approve = useMutation({
    mutationFn: (p: string) => api<any>(`/api/payroll/runs/${p}/approve`, { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(`อนุมัติงวด ${r.period} แล้ว — ลงบัญชีมีผล (${r.entry_no})`); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const reject = useMutation({
    mutationFn: (p: string) => api<any>(`/api/payroll/runs/${p}/reject`, { method: 'POST', body: JSON.stringify({ reason: window.prompt('เหตุผลที่ปฏิเสธ (ไม่บังคับ)') || undefined }) }),
    onSuccess: (r) => { notifySuccess(`ปฏิเสธงวด ${r.period} — ยกเลิกรายการบัญชีแล้ว`); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const busy = approve.isPending || reject.isPending;

  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">จ่ายเงินเดือนประจำงวด</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5"><Label>งวด (YYYY-MM)</Label><Input value={period} onChange={(e) => setPeriod(e.target.value)} className="w-40" /></div>
          <Button onClick={() => run.mutate()} disabled={run.isPending}><Play className="size-4" /> เตรียมจ่ายเงินเดือน</Button>
        </div>
        <p className="text-xs text-muted-foreground">ลงบัญชี: เดบิต เงินเดือน + ประกันสังคมนายจ้าง / เครดิต เงินสด + ประกันสังคมค้างจ่าย + ภาษีหัก ณ ที่จ่ายค้างจ่าย · <strong>ต้องให้ผู้อื่นอนุมัติก่อนจึงมีผล (แบ่งแยกหน้าที่ — ผู้ทำรายการอนุมัติเองไม่ได้)</strong></p>
      </Card>
      <StateView q={runs}>
        {runs.data && (
          <DataTable
            rows={runs.data.runs}
            rowKey={(r: any) => `${r.period}-${r.entry_no ?? r.status}`}
            emptyState={{ icon: Wallet, title: 'ยังไม่มีการจ่ายเงินเดือน', description: 'เลือกงวดแล้วกด เตรียมจ่ายเงินเดือน เพื่อสร้างรอบจ่ายงวดแรก' }}
            columns={[
              { key: 'period', label: 'งวด' },
              { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={runStatusTone(r.status)}>{runStatusTh[r.status] ?? r.status}</Badge> },
              { key: 'headcount', label: 'จำนวนคน', align: 'right' },
              { key: 'gross_total', label: 'เงินเดือนรวม', align: 'right', render: (r: any) => <span className="tabular">{baht(r.gross_total)}</span> },
              { key: 'wht_total', label: 'ภาษีหัก', align: 'right', render: (r: any) => <span className="tabular">{baht(r.wht_total)}</span> },
              { key: 'net_total', label: 'จ่ายสุทธิ', align: 'right', render: (r: any) => <span className="tabular">{baht(r.net_total)}</span> },
              { key: 'run_by', label: 'ผู้ทำ/ผู้อนุมัติ', render: (r: any) => <span className="text-xs text-muted-foreground">{r.run_by ?? '—'}{r.approved_by ? ` → ${r.approved_by}` : ''}</span> },
              { key: 'entry_no', label: 'เลขที่บัญชี' },
              { key: 'act', label: '', align: 'right', render: (r: any) => r.status === 'PendingApproval' ? (
                <div className="flex justify-end gap-1.5">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => approve.mutate(r.period)}>อนุมัติ</Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => reject.mutate(r.period)}>ปฏิเสธ</Button>
                </div>
              ) : null },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── ภ.ง.ด.1 ─────────────────────────
function Pnd1() {
  const [period, setPeriod] = useState(thisMonth());
  const q = useQuery<any>({ queryKey: ['pnd1', period], queryFn: () => api(`/api/payroll/pnd1?period=${period}`) });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5"><Label>งวด (YYYY-MM)</Label><Input value={period} onChange={(e) => setPeriod(e.target.value)} className="w-40" /></div>
          <Button variant="outline" onClick={() => q.refetch()}>แสดง</Button>
        </div>
      </Card>
      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label="จำนวนพนักงาน" value={q.data.headcount} tone="primary" />
              <StatCard label="เงินได้รวม" value={baht(q.data.total_income)} tone="primary" />
              <StatCard label="ภาษีหัก ณ ที่จ่ายรวม" value={baht(q.data.total_wht)} tone="primary" />
            </div>
            <DataTable
              rows={q.data.lines}
              emptyState={{ icon: FileText, title: 'ไม่มีข้อมูลในงวดนี้', description: 'ยังไม่มีการจ่ายเงินเดือนในงวดที่เลือก ลองเปลี่ยนงวดแล้วกด แสดง' }}
              columns={[
                { key: 'emp_name', label: 'ชื่อ' },
                { key: 'national_id', label: 'เลขบัตรประชาชน' },
                { key: 'income', label: 'เงินได้', align: 'right', render: (r: any) => <span className="tabular">{baht(r.income)}</span> },
                { key: 'wht', label: 'ภาษีหัก', align: 'right', render: (r: any) => <span className="tabular">{baht(r.wht)}</span> },
              ]}
            />
            <p className="text-xs text-muted-foreground">{q.data.deadline}</p>
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── ภ.ง.ด.1ก (annual) ─────────────────────────
function Pnd1a() {
  const [year, setYear] = useState(thisMonth().slice(0, 4));
  const q = useQuery<any>({ queryKey: ['pnd1a', year], queryFn: () => api(`/api/payroll/pnd1a?year=${year}`) });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5"><Label>ปี (YYYY)</Label><Input value={year} onChange={(e) => setYear(e.target.value)} className="w-32" /></div>
          <Button variant="outline" onClick={() => q.refetch()}>แสดง</Button>
        </div>
      </Card>
      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label="จำนวนพนักงาน" value={q.data.headcount} tone="primary" />
              <StatCard label="เงินได้ทั้งปี" value={baht(q.data.total_income)} tone="primary" />
              <StatCard label="ภาษีหัก ณ ที่จ่ายทั้งปี" value={baht(q.data.total_wht)} tone="primary" />
            </div>
            <DataTable
              rows={q.data.lines}
              emptyState={{ icon: FileText, title: 'ไม่มีข้อมูลในปีนี้', description: 'ยังไม่มีการจ่ายเงินเดือนในปีที่เลือก ลองเปลี่ยนปีแล้วกด แสดง' }}
              columns={[
                { key: 'emp_name', label: 'ชื่อ' },
                { key: 'national_id', label: 'เลขบัตรประชาชน' },
                { key: 'income', label: 'เงินได้ทั้งปี', align: 'right', render: (r: any) => <span className="tabular">{baht(r.income)}</span> },
                { key: 'wht', label: 'ภาษีหักทั้งปี', align: 'right', render: (r: any) => <span className="tabular">{baht(r.wht)}</span> },
              ]}
            />
            <p className="text-xs text-muted-foreground">{q.data.deadline}</p>
          </div>
        )}
      </StateView>
    </div>
  );
}
