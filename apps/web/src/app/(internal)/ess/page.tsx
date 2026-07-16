'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, CalendarOff, Receipt, Clock, IdCard, Wallet, Printer } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
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
import { Select } from '@/components/form-controls';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

// ── API contract (apps/api/src/modules/ess) ───────────────────────────────────
interface MeResp {
  employee: { id: number; emp_code: string; name: string; position: string | null; department: string | null };
  leave_balances: { leave_type: string; year: number; entitled: number; used: number; remaining: number }[];
}
interface LeaveReq { id: number; leave_type: string; from_date: string; to_date: string; days: number; paid: boolean; status: string; reason: string | null }
interface Payslip { id: number; emp_code: string; gross: number; ot_pay: number; sso_employee: number; pf_employee: number; wht: number; net: number }
interface Timesheet { work_date: string; regular_hours: number; ot_hours: number; note: string | null }
interface AttendanceEntry { id: number; date: string | null; clock_in: string | null; clock_out: string | null; hours: number; status: string; clock_in_method: string | null }
interface AttendanceResp { emp_code: string; entries: AttendanceEntry[]; summary: { total_hours: number; days_worked: number; sessions: number; currently_clocked_in: boolean } }
interface ExpenseClaim { id: number; claim_date: string | null; category: string | null; amount: number; description: string | null; status: string; ap_txn_no?: string | null }


export default function EssPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('hr.ess_title')} description={t('hr.ess_subtitle')} />
      <Tabs
        tabs={[
          { key: 'me', label: t('hr.tab_me'), content: <MeTab /> },
          { key: 'leave', label: t('hr.tab_leave_req'), content: <LeaveTab /> },
          { key: 'expense', label: t('hr.tab_expense'), content: <ExpenseTab /> },
          { key: 'time', label: t('hr.tab_time'), content: <TimesheetTab /> },
          { key: 'attendance', label: t('hr.tab_attendance'), content: <AttendanceTab /> },
        ]}
      />
    </div>
  );
}

function MeTab() {
  const { t } = useLang();
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
                <div>{t('hr.emp_code_colon')} <span className="text-foreground">{me.data.employee.emp_code}</span></div>
                <div>{t('hr.position_colon')} <span className="text-foreground">{me.data.employee.position ?? '—'}</span></div>
                <div>{t('hr.department_colon')} <span className="text-foreground">{me.data.employee.department ?? '—'}</span></div>
              </CardContent>
            </Card>

            <div>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('hr.leave_balance_title')}</h3>
              <DataTable
                rows={me.data.leave_balances}
                rowKey={(r) => `${r.leave_type}-${r.year}`}
                emptyText={t('hr.leave_balance_empty')}
                columns={[
                  { key: 'leave_type', label: t('hr.leave_type_col') },
                  { key: 'entitled', label: t('hr.entitled'), align: 'right', render: (r) => <span className="tabular">{num(r.entitled)}</span> },
                  { key: 'used', label: t('hr.used'), align: 'right', render: (r) => <span className="tabular">{num(r.used)}</span> },
                  { key: 'remaining', label: t('hr.remaining'), align: 'right', render: (r) => <span className="tabular font-medium">{num(r.remaining)}</span> },
                ]}
              />
            </div>
          </>
        )}
      </StateView>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('hr.payslips_title')}</h3>
        <StateView q={slips}>
          {slips.data && (
            <DataTable
              rows={slips.data.payslips}
              rowKey={(r) => r.id}
              emptyState={{ icon: Wallet, title: t('hr.payslips_empty_title'), description: t('hr.payslips_empty_desc') }}
              columns={[
                { key: 'id', label: t('hr.slip_no'), render: (r) => <span className="font-medium">#{r.id}</span> },
                { key: 'gross', label: t('hr.gross_income'), align: 'right', render: (r) => <span className="tabular">{baht(r.gross)}</span> },
                { key: 'ot_pay', label: t('hr.ot_pay'), align: 'right', render: (r) => <span className="tabular">{baht(r.ot_pay)}</span> },
                { key: 'sso_employee', label: t('hr.sso'), align: 'right', render: (r) => <span className="tabular">{baht(r.sso_employee)}</span> },
                { key: 'pf_employee', label: t('hr.pf'), align: 'right', render: (r) => <span className="tabular">{baht(r.pf_employee)}</span> },
                { key: 'wht', label: t('hr.wht_short'), align: 'right', render: (r) => <span className="tabular">{baht(r.wht)}</span> },
                { key: 'net', label: t('hr.net_received'), align: 'right', render: (r) => <span className="tabular font-semibold text-success">{baht(r.net)}</span> },
                { key: 'act', label: '', sortable: false, render: (r) => (
                  <Button variant="ghost" size="sm" asChild title={t('hr.payslip_download')}>
                    <a href={`${BASE}/api/ess/payslips/${r.id}/pdf`} target="_blank" rel="noopener noreferrer"><Printer className="size-4" /></a>
                  </Button>
                ) },
              ]}
            />
          )}
        </StateView>
      </div>
    </div>
  );
}

function LeaveTab() {
  const { t } = useLang();
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
      notifySuccess(t('hr.leave_submitted_days', { days: num(r.days) }));
      setReason('');
      qc.invalidateQueries({ queryKey: ['ess-leave'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const rows = q.data?.leave_requests ?? [];

  return (
    <div className="space-y-5">
      <Card className="max-w-4xl gap-4">
        <CardHeader><CardTitle className="text-base">{t('hr.tab_leave_req')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="lv-type">{t('hr.leave_type_col')}</Label>
              <Select id="lv-type"  value={leaveType} onChange={(e) => setLeaveType(e.target.value)}>
                <option value="annual">{t('hr.leave_annual')}</option>
                <option value="sick">{t('hr.leave_sick')}</option>
                <option value="personal">{t('hr.leave_personal')}</option>
                <option value="unpaid">{t('hr.leave_unpaid')}</option>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="lv-from">{t('hr.from_date')}</Label>
              <Input id="lv-from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="lv-to">{t('hr.to_date')}</Label>
              <Input id="lv-to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="lv-days">{t('hr.days_count')}</Label>
              <Input id="lv-days" type="number" min="0" step="0.5" value={days} onChange={(e) => setDays(e.target.value)} className="max-w-[120px]" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="lv-paid">{t('hr.paid')}</Label>
              <Select id="lv-paid"  value={paid} onChange={(e) => setPaid(e.target.value)}>
                <option value="true">{t('hr.paid_yes_long')}</option>
                <option value="false">{t('hr.unpaid')}</option>
              </Select>
            </div>
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="lv-reason">{t('hr.reason')}</Label>
              <Input id="lv-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('hr.leave_reason_ph')} />
            </div>
          </div>
          <Button disabled={submit.isPending || !fromDate || !toDate || !days} onClick={() => submit.mutate()}>
            <Plus className="size-4" /> {submit.isPending ? t('hr.submitting') : t('hr.leave_submit_req')}
          </Button>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={rows}
            rowKey={(r) => r.id}
            emptyState={{ icon: CalendarOff, title: t('hr.leave_req_empty_title'), description: t('hr.leave_req_empty_desc') }}
            columns={[
              { key: 'leave_type', label: t('hr.type') },
              { key: 'from_date', label: t('hr.from'), render: (r) => thaiDate(r.from_date) },
              { key: 'to_date', label: t('hr.to'), render: (r) => thaiDate(r.to_date) },
              { key: 'days', label: t('hr.day_unit'), align: 'right', render: (r) => <span className="tabular">{num(r.days)}</span> },
              { key: 'paid', label: t('hr.col_paid'), render: (r) => <Badge variant={r.paid ? 'success' : 'secondary'}>{r.paid ? t('hr.paid_short_yes') : t('hr.paid_short_no')}</Badge> },
              { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              { key: 'reason', label: t('hr.reason'), render: (r) => r.reason ?? '—' },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}

function ExpenseTab() {
  const { t } = useLang();
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
      notifySuccess(t('hr.expense_submitted'));
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
            <StatCard label={t('hr.total_claims')} value={num(rows.length)} icon={Receipt} tone="primary" />
            <StatCard label={t('hr.pending_value')} value={baht(pending)} tone="warning" />
            <StatCard label={t('fin.approved')} value={num(rows.filter((r) => r.status === 'Approved').length)} tone="success" />
          </div>
        )}
      </StateView>

      <Card className="max-w-4xl gap-4">
        <CardHeader><CardTitle className="text-base">{t('hr.tab_expense')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="grid gap-2">
              <Label htmlFor="ex-date">{t('dash.col_date')}</Label>
              <Input id="ex-date" type="date" value={claimDate} onChange={(e) => setClaimDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ex-cat">{t('hr.category')}</Label>
              <Select id="ex-cat"  value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="travel">{t('hr.cat_travel')}</option>
                <option value="meals">{t('hr.cat_meals')}</option>
                <option value="supplies">{t('hr.cat_supplies')}</option>
                <option value="other">{t('hr.cat_other')}</option>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ex-amt">{t('hr.amount_baht')}</Label>
              <Input id="ex-amt" type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ex-desc">{t('hr.description')}</Label>
              <Input id="ex-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('hr.description')} />
            </div>
          </div>
          <Button disabled={submit.isPending || !amount} onClick={() => submit.mutate()}>
            <Plus className="size-4" /> {submit.isPending ? t('hr.submitting') : t('hr.expense_submit_btn')}
          </Button>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={rows}
            rowKey={(r) => r.id}
            emptyState={{ icon: Receipt, title: t('hr.expense_empty_title'), description: t('hr.expense_empty_desc') }}
            columns={[
              { key: 'claim_date', label: t('dash.col_date'), render: (r) => thaiDate(r.claim_date) },
              { key: 'category', label: t('hr.category'), render: (r) => r.category ?? '—' },
              { key: 'description', label: t('hr.description'), render: (r) => r.description ?? '—' },
              { key: 'amount', label: t('hr.amount'), align: 'right', render: (r) => <span className="tabular">{baht(r.amount)}</span> },
              { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}

function TimesheetTab() {
  const { t } = useLang();
  const q = useQuery<{ timesheets: Timesheet[]; count: number }>({ queryKey: ['ess-time'], queryFn: () => api('/api/ess/timesheets') });
  const rows = q.data?.timesheets ?? [];
  const reg = rows.reduce((s, r) => s + (r.regular_hours || 0), 0);
  const ot = rows.reduce((s, r) => s + (r.ot_hours || 0), 0);

  return (
    <div className="space-y-5">
      <StateView q={q}>
        {q.data && (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label={t('hr.days_logged')} value={num(rows.length)} icon={Clock} tone="primary" />
            <StatCard label={t('hr.total_regular_hours')} value={num(reg)} tone="info" />
            <StatCard label={t('hr.total_ot_hours')} value={num(ot)} tone="warning" />
          </div>
        )}
      </StateView>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={rows}
            rowKey={(_r, i) => i}
            emptyState={{ icon: Clock, title: t('hr.ts_log_empty_title'), description: t('hr.ts_log_empty_desc') }}
            columns={[
              { key: 'work_date', label: t('dash.col_date'), render: (r) => thaiDate(r.work_date) },
              { key: 'regular_hours', label: t('hr.regular_hours'), align: 'right', render: (r) => <span className="tabular">{num(r.regular_hours)}</span> },
              { key: 'ot_hours', label: 'OT', align: 'right', render: (r) => <span className="tabular">{num(r.ot_hours)}</span> },
              { key: 'note', label: t('hr.note'), render: (r) => r.note ?? '—' },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}

// Attendance — the employee's own clock-in/out pulled from the POS time-clock (GET /api/ess/attendance),
// so an hourly worker sees inside HR self-service exactly what the POS register recorded. Read-only.
function AttendanceTab() {
  const { t } = useLang();
  const q = useQuery<AttendanceResp>({ queryKey: ['ess-attendance'], queryFn: () => api('/api/ess/attendance') });
  const s = q.data?.summary;
  const rows = q.data?.entries ?? [];
  const fmtTime = (x: string | null) => (x ? new Date(x).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');

  return (
    <div className="space-y-5">
      <StateView q={q}>
        {q.data && (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label={t('hr.att_total_hours')} value={num(s?.total_hours ?? 0)} icon={Clock} tone="primary" />
            <StatCard label={t('hr.att_days_worked')} value={num(s?.days_worked ?? 0)} tone="info" />
            <StatCard label={t('hr.att_status')} value={s?.currently_clocked_in ? t('hr.att_clocked_in') : t('hr.att_clocked_out')} tone={s?.currently_clocked_in ? 'success' : 'info'} />
          </div>
        )}
      </StateView>
      <StateView q={q}>
        {q.data && (
          <>
            <DataTable
              rows={rows}
              rowKey={(r) => r.id}
              emptyState={{ icon: Clock, title: t('hr.att_empty_title'), description: t('hr.att_empty_desc') }}
              columns={[
                { key: 'date', label: t('dash.col_date'), render: (r) => thaiDate(r.date) },
                { key: 'clock_in', label: t('hr.att_clock_in'), render: (r) => fmtTime(r.clock_in) },
                { key: 'clock_out', label: t('hr.att_clock_out'), render: (r) => fmtTime(r.clock_out) },
                { key: 'hours', label: t('hr.att_hours'), align: 'right', render: (r) => <span className="tabular">{num(r.hours)}</span> },
                { key: 'status', label: t('hr.att_method'), render: (r) => (r.status === 'Open' ? <Badge variant="success">{t('hr.att_clocked_in')}</Badge> : (r.clock_in_method ?? '—')) },
              ]}
            />
            <p className="text-xs text-muted-foreground">{t('hr.att_source_note')}</p>
          </>
        )}
      </StateView>
    </div>
  );
}
