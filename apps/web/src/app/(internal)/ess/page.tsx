'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, CalendarOff, Receipt, Clock, IdCard, Wallet } from 'lucide-react';
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

// ── API contract (apps/api/src/modules/ess) ───────────────────────────────────
interface MeResp {
  employee: { id: number; emp_code: string; name: string; position: string | null; department: string | null };
  leave_balances: { leave_type: string; year: number; entitled: number; used: number; remaining: number }[];
}
interface LeaveReq { id: number; leave_type: string; from_date: string; to_date: string; days: number; paid: boolean; status: string; reason: string | null }
interface Payslip { id: number; emp_code: string; gross: number; ot_pay: number; sso_employee: number; pf_employee: number; wht: number; net: number }
interface Timesheet { work_date: string; regular_hours: number; ot_hours: number; note: string | null }
interface ExpenseClaim { id: number; claim_date: string | null; category: string | null; amount: number; description: string | null; status: string; ap_txn_no?: string | null }

const selectCls =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

export default function EssPage() {
  return (
    <div>
      <PageHeader title="พื้นที่พนักงาน (ESS)" description="ข้อมูลส่วนตัว สิทธิวันลา สลิปเงินเดือน การขอลา และการเบิกค่าใช้จ่ายของฉัน" />
      <Tabs
        tabs={[
          { key: 'me', label: 'ข้อมูลของฉัน', content: <MeTab /> },
          { key: 'leave', label: 'ขอลางาน', content: <LeaveTab /> },
          { key: 'expense', label: 'เบิกค่าใช้จ่าย', content: <ExpenseTab /> },
          { key: 'time', label: 'ลงเวลา', content: <TimesheetTab /> },
        ]}
      />
    </div>
  );
}

function MeTab() {
  const me = useQuery<MeResp>({ queryKey: ['ess-me'], queryFn: () => api('/api/ess/me') });
  const slips = useQuery<{ payslips: Payslip[]; count: number }>({ queryKey: ['ess-slips'], queryFn: () => api('/api/ess/payslips') });

  return (
    <div className="space-y-5">
      <StateView q={me}>
        {me.data && (
          <>
            <Card className="max-w-2xl gap-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base"><IdCard className="size-4" /> {me.data.employee.name}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-1 text-sm text-muted-foreground sm:grid-cols-3">
                <div>รหัสพนักงาน: <span className="text-foreground">{me.data.employee.emp_code}</span></div>
                <div>ตำแหน่ง: <span className="text-foreground">{me.data.employee.position ?? '—'}</span></div>
                <div>แผนก: <span className="text-foreground">{me.data.employee.department ?? '—'}</span></div>
              </CardContent>
            </Card>

            <div>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">สิทธิวันลา (ปีปัจจุบัน)</h3>
              <DataTable
                rows={me.data.leave_balances}
                rowKey={(r) => `${r.leave_type}-${r.year}`}
                emptyText="ยังไม่มีข้อมูลสิทธิวันลา"
                columns={[
                  { key: 'leave_type', label: 'ประเภทการลา' },
                  { key: 'entitled', label: 'สิทธิทั้งหมด', align: 'right', render: (r) => <span className="tabular">{num(r.entitled)}</span> },
                  { key: 'used', label: 'ใช้ไป', align: 'right', render: (r) => <span className="tabular">{num(r.used)}</span> },
                  { key: 'remaining', label: 'คงเหลือ', align: 'right', render: (r) => <span className="tabular font-medium">{num(r.remaining)}</span> },
                ]}
              />
            </div>
          </>
        )}
      </StateView>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">สลิปเงินเดือน</h3>
        <StateView q={slips}>
          {slips.data && (
            <DataTable
              rows={slips.data.payslips}
              rowKey={(r) => r.id}
              emptyState={{ icon: Wallet, title: 'ยังไม่มีสลิปเงินเดือน', description: 'สลิปจะปรากฏที่นี่หลังจากมีการประมวลผลเงินเดือน' }}
              columns={[
                { key: 'id', label: 'รอบที่', render: (r) => <span className="font-medium">#{r.id}</span> },
                { key: 'gross', label: 'รายได้รวม', align: 'right', render: (r) => <span className="tabular">{baht(r.gross)}</span> },
                { key: 'ot_pay', label: 'ค่า OT', align: 'right', render: (r) => <span className="tabular">{baht(r.ot_pay)}</span> },
                { key: 'sso_employee', label: 'ประกันสังคม', align: 'right', render: (r) => <span className="tabular">{baht(r.sso_employee)}</span> },
                { key: 'pf_employee', label: 'กองทุนสำรองฯ', align: 'right', render: (r) => <span className="tabular">{baht(r.pf_employee)}</span> },
                { key: 'wht', label: 'หัก ณ ที่จ่าย', align: 'right', render: (r) => <span className="tabular">{baht(r.wht)}</span> },
                { key: 'net', label: 'รับสุทธิ', align: 'right', render: (r) => <span className="tabular font-semibold text-success">{baht(r.net)}</span> },
              ]}
            />
          )}
        </StateView>
      </div>
    </div>
  );
}

function LeaveTab() {
  const qc = useQueryClient();
  const q = useQuery<{ leave_requests: LeaveReq[]; count: number }>({ queryKey: ['ess-leave'], queryFn: () => api('/api/ess/leave') });

  const [leaveType, setLeaveType] = useState('annual');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [days, setDays] = useState('1');
  const [paid, setPaid] = useState('true');
  const [reason, setReason] = useState('');

  const submit = useMutation({
    mutationFn: () =>
      api('/api/ess/leave', {
        method: 'POST',
        body: JSON.stringify({
          leave_type: leaveType,
          from_date: fromDate,
          to_date: toDate,
          days: Number(days) || 0,
          paid: paid === 'true',
          reason: reason || undefined,
        }),
      }),
    onSuccess: (r: any) => {
      notifySuccess(`ส่งคำขอลาแล้ว (${num(r.days)} วัน) — รออนุมัติ`);
      setReason('');
      qc.invalidateQueries({ queryKey: ['ess-leave'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const rows = q.data?.leave_requests ?? [];

  return (
    <div className="space-y-5">
      <Card className="max-w-4xl gap-4">
        <CardHeader><CardTitle className="text-base">ขอลางาน</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="lv-type">ประเภทการลา</Label>
              <select id="lv-type" className={selectCls} value={leaveType} onChange={(e) => setLeaveType(e.target.value)}>
                <option value="annual">ลาพักร้อน</option>
                <option value="sick">ลาป่วย</option>
                <option value="personal">ลากิจ</option>
                <option value="unpaid">ลาไม่รับค่าจ้าง</option>
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="lv-from">ตั้งแต่วันที่</Label>
              <Input id="lv-from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="lv-to">ถึงวันที่</Label>
              <Input id="lv-to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="lv-days">จำนวนวัน</Label>
              <Input id="lv-days" type="number" min="0" step="0.5" value={days} onChange={(e) => setDays(e.target.value)} className="max-w-[120px]" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="lv-paid">รับค่าจ้าง</Label>
              <select id="lv-paid" className={selectCls} value={paid} onChange={(e) => setPaid(e.target.value)}>
                <option value="true">ได้รับค่าจ้าง</option>
                <option value="false">ไม่รับค่าจ้าง</option>
              </select>
            </div>
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="lv-reason">เหตุผล</Label>
              <Input id="lv-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="เหตุผลการลา" />
            </div>
          </div>
          <Button disabled={submit.isPending || !fromDate || !toDate || !days} onClick={() => submit.mutate()}>
            <Plus className="size-4" /> {submit.isPending ? 'กำลังส่ง…' : 'ส่งคำขอลา'}
          </Button>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={rows}
            rowKey={(r) => r.id}
            emptyState={{ icon: CalendarOff, title: 'ยังไม่มีคำขอลา', description: 'ส่งคำขอลาแรกจากแบบฟอร์มด้านบน' }}
            columns={[
              { key: 'leave_type', label: 'ประเภท' },
              { key: 'from_date', label: 'ตั้งแต่', render: (r) => thaiDate(r.from_date) },
              { key: 'to_date', label: 'ถึง', render: (r) => thaiDate(r.to_date) },
              { key: 'days', label: 'วัน', align: 'right', render: (r) => <span className="tabular">{num(r.days)}</span> },
              { key: 'paid', label: 'ค่าจ้าง', render: (r) => <Badge variant={r.paid ? 'success' : 'secondary'}>{r.paid ? 'รับ' : 'ไม่รับ'}</Badge> },
              { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              { key: 'reason', label: 'เหตุผล', render: (r) => r.reason ?? '—' },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}

function ExpenseTab() {
  const qc = useQueryClient();
  const q = useQuery<{ expense_claims: ExpenseClaim[]; count: number }>({ queryKey: ['ess-exp'], queryFn: () => api('/api/ess/expenses') });

  const [claimDate, setClaimDate] = useState('');
  const [category, setCategory] = useState('travel');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');

  const submit = useMutation({
    mutationFn: () =>
      api('/api/ess/expenses', {
        method: 'POST',
        body: JSON.stringify({
          claim_date: claimDate || undefined,
          category,
          amount: Number(amount) || 0,
          description: description || undefined,
        }),
      }),
    onSuccess: () => {
      notifySuccess('ส่งคำขอเบิกแล้ว — รออนุมัติ');
      setAmount(''); setDescription('');
      qc.invalidateQueries({ queryKey: ['ess-exp'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const rows = q.data?.expense_claims ?? [];
  const pending = rows.filter((r) => r.status === 'Pending').reduce((s, r) => s + (r.amount || 0), 0);

  return (
    <div className="space-y-5">
      <StateView q={q}>
        {q.data && (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="คำขอทั้งหมด" value={num(rows.length)} icon={Receipt} tone="primary" />
            <StatCard label="รออนุมัติ (มูลค่า)" value={baht(pending)} tone="warning" />
            <StatCard label="อนุมัติแล้ว" value={num(rows.filter((r) => r.status === 'Approved').length)} tone="success" />
          </div>
        )}
      </StateView>

      <Card className="max-w-4xl gap-4">
        <CardHeader><CardTitle className="text-base">เบิกค่าใช้จ่าย</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="grid gap-2">
              <Label htmlFor="ex-date">วันที่</Label>
              <Input id="ex-date" type="date" value={claimDate} onChange={(e) => setClaimDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ex-cat">หมวด</Label>
              <select id="ex-cat" className={selectCls} value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="travel">เดินทาง</option>
                <option value="meals">ค่าอาหาร</option>
                <option value="supplies">วัสดุอุปกรณ์</option>
                <option value="other">อื่น ๆ</option>
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ex-amt">จำนวนเงิน (฿)</Label>
              <Input id="ex-amt" type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ex-desc">รายละเอียด</Label>
              <Input id="ex-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="รายละเอียด" />
            </div>
          </div>
          <Button disabled={submit.isPending || !amount} onClick={() => submit.mutate()}>
            <Plus className="size-4" /> {submit.isPending ? 'กำลังส่ง…' : 'ส่งคำขอเบิก'}
          </Button>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={rows}
            rowKey={(r) => r.id}
            emptyState={{ icon: Receipt, title: 'ยังไม่มีคำขอเบิก', description: 'ส่งคำขอเบิกค่าใช้จ่ายแรกจากแบบฟอร์มด้านบน' }}
            columns={[
              { key: 'claim_date', label: 'วันที่', render: (r) => thaiDate(r.claim_date) },
              { key: 'category', label: 'หมวด', render: (r) => r.category ?? '—' },
              { key: 'description', label: 'รายละเอียด', render: (r) => r.description ?? '—' },
              { key: 'amount', label: 'จำนวนเงิน', align: 'right', render: (r) => <span className="tabular">{baht(r.amount)}</span> },
              { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}

function TimesheetTab() {
  const q = useQuery<{ timesheets: Timesheet[]; count: number }>({ queryKey: ['ess-time'], queryFn: () => api('/api/ess/timesheets') });
  const rows = q.data?.timesheets ?? [];
  const reg = rows.reduce((s, r) => s + (r.regular_hours || 0), 0);
  const ot = rows.reduce((s, r) => s + (r.ot_hours || 0), 0);

  return (
    <div className="space-y-5">
      <StateView q={q}>
        {q.data && (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="จำนวนวันที่ลงเวลา" value={num(rows.length)} icon={Clock} tone="primary" />
            <StatCard label="ชั่วโมงปกติรวม" value={num(reg)} tone="info" />
            <StatCard label="ชั่วโมง OT รวม" value={num(ot)} tone="warning" />
          </div>
        )}
      </StateView>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={rows}
            rowKey={(_r, i) => i}
            emptyState={{ icon: Clock, title: 'ยังไม่มีบันทึกการลงเวลา', description: 'ข้อมูลการลงเวลาทำงานของคุณจะปรากฏที่นี่' }}
            columns={[
              { key: 'work_date', label: 'วันที่', render: (r) => thaiDate(r.work_date) },
              { key: 'regular_hours', label: 'ชั่วโมงปกติ', align: 'right', render: (r) => <span className="tabular">{num(r.regular_hours)}</span> },
              { key: 'ot_hours', label: 'OT', align: 'right', render: (r) => <span className="tabular">{num(r.ot_hours)}</span> },
              { key: 'note', label: 'หมายเหตุ', render: (r) => r.note ?? '—' },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}
