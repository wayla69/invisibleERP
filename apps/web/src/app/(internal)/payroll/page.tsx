'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, Play, Plus, Users, Wallet, Landmark } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
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
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('hr.payroll_title')}
        description={t('hr.payroll_subtitle')}
      />
      <Tabs
        tabs={[
          { key: 'emp', label: t('hr.tab_employees'), content: <Employees /> },
          { key: 'run', label: t('hr.tab_run'), content: <RunPayroll /> },
          { key: 'liab', label: t('hr.tab_liab'), content: <Liabilities /> },
          { key: 'pnd1', label: t('hr.tab_pnd1'), content: <Pnd1 /> },
          { key: 'pnd1a', label: t('hr.tab_pnd1a'), content: <Pnd1a /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── พนักงาน ─────────────────────────
function Employees() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['pay-emps'], queryFn: () => api('/api/payroll/employees') });
  const emptyForm = { name: '', national_id: '', sso_no: '', position: '', department: '', monthly_salary: '', hourly_rate: '', pf_rate: '', allowances: '', bank_account: '', start_date: '', sso_eligible: true };
  const [f, setF] = useState(emptyForm);

  const add = useMutation({
    mutationFn: () =>
      api<{ emp_code: string }>('/api/payroll/employees', {
        method: 'POST',
        body: JSON.stringify({
          name: f.name,
          national_id: f.national_id || undefined,
          sso_no: f.sso_no || undefined,
          position: f.position || undefined,
          department: f.department || undefined,
          monthly_salary: Number(f.monthly_salary) || 0,
          hourly_rate: Number(f.hourly_rate) || 0,
          pf_rate: Number(f.pf_rate) || 0,
          allowances: Number(f.allowances) || 0,
          bank_account: f.bank_account || undefined,
          start_date: f.start_date || undefined,
          sso_eligible: f.sso_eligible,
        }),
      }),
    onSuccess: (r) => {
      notifySuccess(t('hr.emp_added', { code: r.emp_code }));
      setF(emptyForm);
      qc.invalidateQueries({ queryKey: ['pay-emps'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hr.add_employee')}</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5"><Label>{t('hr.full_name')}</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('hr.national_id')}</Label><Input value={f.national_id} onChange={(e) => setF({ ...f, national_id: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('hr.sso_no')}</Label><Input value={f.sso_no} onChange={(e) => setF({ ...f, sso_no: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('hr.position')}</Label><Input value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('hr.department')}</Label><Input value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('hr.start_date')}</Label><Input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('hr.salary_baht')}</Label><Input type="number" min="0" value={f.monthly_salary} onChange={(e) => setF({ ...f, monthly_salary: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('hr.hourly_rate_ot')}</Label><Input type="number" min="0" value={f.hourly_rate} onChange={(e) => setF({ ...f, hourly_rate: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('hr.pf_rate')}</Label><Input type="number" min="0" step="0.01" value={f.pf_rate} onChange={(e) => setF({ ...f, pf_rate: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('hr.allowances')}</Label><Input type="number" min="0" value={f.allowances} onChange={(e) => setF({ ...f, allowances: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('hr.bank_account')}</Label><Input value={f.bank_account} onChange={(e) => setF({ ...f, bank_account: e.target.value })} /></div>
          <div className="grid gap-1.5">
            <Label>{t('hr.sso_eligible')}</Label>
            <select
              className="h-9 rounded-md border bg-transparent px-3 text-sm"
              value={f.sso_eligible ? '1' : '0'}
              onChange={(e) => setF({ ...f, sso_eligible: e.target.value === '1' })}
            >
              <option value="1">{t('hr.sso_eligible_yes')}</option>
              <option value="0">{t('hr.sso_eligible_no')}</option>
            </select>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={() => add.mutate()} disabled={!f.name || !f.monthly_salary || add.isPending}><Plus className="size-4" /> {t('hr.add_btn')}</Button>
        </div>
      </Card>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.employees}
            emptyState={{ icon: Users, title: t('hr.emp_empty_title'), description: t('hr.emp_empty_desc') }}
            columns={[
              { key: 'emp_code', label: t('hr.col_code') },
              { key: 'name', label: t('hr.col_name') },
              { key: 'position', label: t('hr.position') },
              { key: 'department', label: t('hr.department'), render: (r: any) => r.department || '—' },
              { key: 'start_date', label: t('hr.start_date'), render: (r: any) => r.start_date || '—' },
              { key: 'monthly_salary', label: t('hr.salary'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.monthly_salary)}</span> },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── จ่ายเงินเดือน ─────────────────────────
const runStatusTone = (s: string): 'warning' | 'success' | 'destructive' | 'secondary' =>
  s === 'PendingApproval' ? 'warning' : s === 'Posted' ? 'success' : s === 'Rejected' ? 'destructive' : 'secondary';

function RunPayroll() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [period, setPeriod] = useState(thisMonth());
  const runs = useQuery<any>({ queryKey: ['pay-runs'], queryFn: () => api('/api/payroll/runs') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['pay-runs'] });
  const runStatusLabel = (s: string) => s === 'PendingApproval' ? t('fin.pending') : s === 'Posted' ? t('hr.run_posted') : s === 'Rejected' ? t('fin.rejected') : s;

  const run = useMutation({
    mutationFn: () => api<any>(`/api/payroll/runs?period=${period}`, { method: 'POST' }),
    onSuccess: (r) => {
      notifySuccess(r.already ? t('hr.run_exists', { period, status: r.status === 'Posted' ? t('hr.run_posted') : t('fin.pending') }) : t('hr.run_prepared', { period, net: baht(r.net_total) }));
      refresh();
    },
    onError: (e: any) => notifyError(e.message),
  });
  const approve = useMutation({
    mutationFn: (p: string) => api<any>(`/api/payroll/runs/${p}/approve`, { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(t('hr.run_approved', { period: r.period, entry: r.entry_no })); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const reject = useMutation({
    mutationFn: (p: string) => api<any>(`/api/payroll/runs/${p}/reject`, { method: 'POST', body: JSON.stringify({ reason: window.prompt(t('hr.reject_reason_prompt')) || undefined }) }),
    onSuccess: (r) => { notifySuccess(t('hr.run_rejected', { period: r.period })); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const busy = approve.isPending || reject.isPending;

  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hr.run_title')}</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5"><Label>{t('hr.period_ym')}</Label><Input value={period} onChange={(e) => setPeriod(e.target.value)} className="w-40" /></div>
          <Button onClick={() => run.mutate()} disabled={run.isPending}><Play className="size-4" /> {t('hr.prepare_run')}</Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('hr.run_gl_note')}<strong>{t('hr.run_sod_note')}</strong></p>
      </Card>
      <StateView q={runs}>
        {runs.data && (
          <DataTable
            rows={runs.data.runs}
            rowKey={(r: any) => `${r.period}-${r.entry_no ?? r.status}`}
            emptyState={{ icon: Wallet, title: t('hr.run_empty_title'), description: t('hr.run_empty_desc') }}
            columns={[
              { key: 'period', label: t('hr.period') },
              { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={runStatusTone(r.status)}>{runStatusLabel(r.status)}</Badge> },
              { key: 'headcount', label: t('hr.headcount'), align: 'right' },
              { key: 'gross_total', label: t('hr.gross_total'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.gross_total)}</span> },
              { key: 'wht_total', label: t('hr.wht'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.wht_total)}</span> },
              { key: 'net_total', label: t('hr.net_pay'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.net_total)}</span> },
              { key: 'run_by', label: t('hr.run_by_approver'), render: (r: any) => <span className="text-xs text-muted-foreground">{r.run_by ?? '—'}{r.approved_by ? ` → ${r.approved_by}` : ''}</span> },
              { key: 'entry_no', label: t('hr.entry_no') },
              { key: 'act', label: '', align: 'right', render: (r: any) => r.status === 'PendingApproval' ? (
                <div className="flex justify-end gap-1.5">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => approve.mutate(r.period)}>{t('fin.approve')}</Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => reject.mutate(r.period)}>{t('hr.reject')}</Button>
                </div>
              ) : null },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── หนี้สินค้างนำส่ง (PAY-02) ─────────────────────────
function Liabilities() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['pay-liab'], queryFn: () => api('/api/payroll/liabilities') });
  const remit = useMutation({
    mutationFn: (p: { account_code: string; amount: number }) => api<any>('/api/payroll/liabilities/remit', { method: 'POST', body: JSON.stringify(p) }),
    onSuccess: (r) => { notifySuccess(t('hr.remit_success', { label: r.label, amount: baht(r.remitted), remaining: baht(r.outstanding_after), entry: r.entry_no })); qc.invalidateQueries({ queryKey: ['pay-liab'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-2 p-5">
        <h3 className="text-base font-semibold">{t('hr.liab_title')}</h3>
        <p className="text-xs text-muted-foreground">{t('hr.liab_note')}</p>
      </Card>
      <StateView q={q}>
        {q.data && (
          <>
            <div className="mb-1 grid gap-4 sm:grid-cols-2">
              <StatCard label={t('hr.total_outstanding')} value={baht(q.data.total_outstanding)} icon={Landmark} tone="primary" />
              <StatCard label={t('hr.recon')} value={q.data.all_reconciled ? t('hr.recon_matched') : t('hr.recon_diff')} tone={q.data.all_reconciled ? 'success' : 'danger'} />
            </div>
            <DataTable
              rows={q.data.lines}
              rowKey={(r: any) => r.account_code}
              emptyState={{ icon: Landmark, title: t('hr.liab_empty_title'), description: t('hr.liab_empty_desc') }}
              columns={[
                { key: 'label', label: t('hr.col_item'), render: (r: any) => <span>{r.label}<span className="block text-xs text-muted-foreground">{r.account_code} · {r.authority}</span></span> },
                { key: 'accrued', label: t('hr.accrued'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.accrued)}</span> },
                { key: 'remitted', label: t('hr.remitted'), align: 'right', render: (r: any) => <span className="tabular text-muted-foreground">{baht(r.remitted)}</span> },
                { key: 'outstanding', label: t('hr.outstanding'), align: 'right', render: (r: any) => <span className="tabular font-medium">{baht(r.outstanding)}</span> },
                { key: 'reconciled', label: t('hr.recon'), render: (r: any) => <Badge variant={r.reconciled ? 'success' : 'destructive'}>{r.reconciled ? t('hr.recon_yes') : t('hr.recon_no')}</Badge> },
                { key: 'deadline', label: t('hr.remit_deadline'), render: (r: any) => <span className="text-xs text-muted-foreground">{r.deadline}</span> },
                { key: 'act', label: '', align: 'right', render: (r: any) => r.outstanding > 0 ? (
                  <Button size="sm" variant="outline" disabled={remit.isPending} onClick={() => { const a = window.prompt(t('hr.remit_prompt', { label: r.label, outstanding: baht(r.outstanding) }), String(r.outstanding)); const amt = a && a.trim() ? Number(a) : 0; if (amt > 0) remit.mutate({ account_code: r.account_code, amount: amt }); }}>{t('hr.remit_btn')}</Button>
                ) : null },
              ]}
            />
          </>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── ภ.ง.ด.1 ─────────────────────────
function Pnd1() {
  const { t } = useLang();
  const [period, setPeriod] = useState(thisMonth());
  const q = useQuery<any>({ queryKey: ['pnd1', period], queryFn: () => api(`/api/payroll/pnd1?period=${period}`) });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5"><Label>{t('hr.period_ym')}</Label><Input value={period} onChange={(e) => setPeriod(e.target.value)} className="w-40" /></div>
          <Button variant="outline" onClick={() => q.refetch()}>{t('hr.show')}</Button>
        </div>
      </Card>
      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label={t('hr.emp_count')} value={q.data.headcount} tone="primary" />
              <StatCard label={t('hr.total_income')} value={baht(q.data.total_income)} tone="primary" />
              <StatCard label={t('hr.total_wht')} value={baht(q.data.total_wht)} tone="primary" />
            </div>
            <DataTable
              rows={q.data.lines}
              emptyState={{ icon: FileText, title: t('hr.no_data_period_title'), description: t('hr.no_data_period_desc') }}
              columns={[
                { key: 'emp_name', label: t('hr.col_name') },
                { key: 'national_id', label: t('hr.national_id') },
                { key: 'income', label: t('hr.income'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.income)}</span> },
                { key: 'wht', label: t('hr.wht'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.wht)}</span> },
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
  const { t } = useLang();
  const [year, setYear] = useState(thisMonth().slice(0, 4));
  const q = useQuery<any>({ queryKey: ['pnd1a', year], queryFn: () => api(`/api/payroll/pnd1a?year=${year}`) });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5"><Label>{t('hr.year_yyyy')}</Label><Input value={year} onChange={(e) => setYear(e.target.value)} className="w-32" /></div>
          <Button variant="outline" onClick={() => q.refetch()}>{t('hr.show')}</Button>
        </div>
      </Card>
      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label={t('hr.emp_count')} value={q.data.headcount} tone="primary" />
              <StatCard label={t('hr.total_income_year')} value={baht(q.data.total_income)} tone="primary" />
              <StatCard label={t('hr.total_wht_year')} value={baht(q.data.total_wht)} tone="primary" />
            </div>
            <DataTable
              rows={q.data.lines}
              emptyState={{ icon: FileText, title: t('hr.no_data_year_title'), description: t('hr.no_data_year_desc') }}
              columns={[
                { key: 'emp_name', label: t('hr.col_name') },
                { key: 'national_id', label: t('hr.national_id') },
                { key: 'income', label: t('hr.income_year'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.income)}</span> },
                { key: 'wht', label: t('hr.wht_year'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.wht)}</span> },
              ]}
            />
            <p className="text-xs text-muted-foreground">{q.data.deadline}</p>
          </div>
        )}
      </StateView>
    </div>
  );
}
