'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Goal, Scale, TrendingUp, Search, ClipboardCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
import { useLang } from '@/lib/i18n';
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
import { Select } from '@/components/form-controls';

// ── API contract (apps/api/src/modules/budget — mounted at /api/ledger) ────────
interface BudgetRow { fiscal_year: number; account_code: string; cost_center_code: string | null; period: string; amount: number; status?: string; requested_by?: string | null }
interface BvaRow { account_code: string; account_name: string | null; account_type: string | null; budget: number; actual: number; variance: number; variance_pct: number | null; favorable: boolean; material: boolean; requires_review: boolean; status: string }
interface Signoff { id: number; fiscal_year: number; period: string | null; material_count: number; unfavorable_total: number; notes: string; reviewed_by: string; reviewed_at: string }
interface BvaResp {
  fiscal_year: number; period: string | null; cost_center: string | null; rows: BvaRow[];
  review: { material_count: number; requires_review_count: number; unfavorable_total: number; material_threshold_pct: number; material_threshold_abs: number; last_signoff: Signoff | null };
  rollup: { revenue: Roll; expense: Roll; net: Roll };
}
interface Roll { budget: number; actual: number; variance: number; favorable: boolean }

const thisYear = new Date().getFullYear();

export default function BudgetPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('pb.bud_title')}
        description={t('pb.bud_subtitle')}
      />
      <Tabs
        tabs={[
          { key: 'bva', label: t('pb.bud_tab_bva'), content: <BvaTab /> },
          { key: 'set', label: t('pb.bud_tab_set'), content: <SetBudgetTab /> },
        ]}
      />
    </div>
  );
}

function BvaTab() {
  const { t } = useLang();
  const [fy, setFy] = useState(String(thisYear));
  const [period, setPeriod] = useState('');
  const [query, setQuery] = useState<{ fy: string; period: string } | null>({ fy: String(thisYear), period: '' });

  const qc = useQueryClient();
  const q = useQuery<BvaResp>({
    queryKey: ['bva', query?.fy, query?.period],
    queryFn: () => api(`/api/ledger/budget-vs-actual?fiscal_year=${query!.fy}${query!.period ? `&period=${query!.period}` : ''}`),
    enabled: !!query,
  });

  // ELC-06 management review sign-off (records evidence + follow-up note for the selected period).
  const signOff = useMutation({
    mutationFn: (notes: string) => api('/api/ledger/budget-review/sign-off', { method: 'POST', body: JSON.stringify({ fiscal_year: Number(query!.fy), period: query!.period || undefined, notes }) }),
    onSuccess: (r: any) => { notifySuccess(t('pb.bud_review_saved', { n: r.material_count })); qc.invalidateQueries({ queryKey: ['bva'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const tone = (favorable: boolean, variance: number) => (variance === 0 ? 'secondary' : favorable ? 'success' : 'destructive');

  return (
    <div className="space-y-5">
      <Card className="max-w-2xl gap-4">
        <CardHeader><CardTitle className="text-base">{t('pb.bud_select_period')}</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-2">
              <Label htmlFor="bva-fy">{t('pb.fiscal_year')}</Label>
              <Input id="bva-fy" type="number" value={fy} onChange={(e) => setFy(e.target.value)} className="max-w-[120px]" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bva-period">{t('pb.bud_period_label')}</Label>
              <Input id="bva-period" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-06" className="max-w-[160px]" />
            </div>
            <Button onClick={() => setQuery({ fy, period: /^\d{4}-\d{2}$/.test(period) ? period : '' })}>
              <Search className="size-4" /> {t('pb.bud_view_report')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard
                label={t('pb.bud_revenue_actual_budget')}
                value={baht(q.data.rollup.revenue.actual)}
                icon={TrendingUp}
                tone={q.data.rollup.revenue.favorable ? 'success' : 'warning'}
                hint={t('pb.bud_budget_variance', { b: baht(q.data.rollup.revenue.budget), v: baht(q.data.rollup.revenue.variance) })}
              />
              <StatCard
                label={t('pb.bud_expense_actual_budget')}
                value={baht(q.data.rollup.expense.actual)}
                tone={q.data.rollup.expense.favorable ? 'success' : 'danger'}
                hint={t('pb.bud_budget_variance', { b: baht(q.data.rollup.expense.budget), v: baht(q.data.rollup.expense.variance) })}
              />
              <StatCard
                label={t('pb.bud_net_actual_budget')}
                value={baht(q.data.rollup.net.actual)}
                icon={Scale}
                tone={q.data.rollup.net.favorable ? 'success' : 'danger'}
                hint={t('pb.bud_budget_variance', { b: baht(q.data.rollup.net.budget), v: baht(q.data.rollup.net.variance) })}
              />
            </div>

            {/* ELC-06 management variance-review banner: material-variance flag + sign-off evidence */}
            <Card className={`flex flex-col gap-2 px-5 py-3 ${q.data.review.material_count > 0 ? (q.data.review.last_signoff ? 'border-success/40 bg-success/5' : 'border-warning/40 bg-warning/5') : ''}`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant={q.data.review.material_count === 0 ? 'secondary' : q.data.review.last_signoff ? 'success' : 'warning'}>
                    {q.data.review.material_count === 0 ? t('pb.bud_no_material') : t('pb.bud_n_material', { n: q.data.review.material_count })}
                  </Badge>
                  {q.data.review.requires_review_count > 0 && <span className="text-muted-foreground">{t('pb.bud_needs_review_1')} <span className="font-medium text-foreground">{q.data.review.requires_review_count}</span> {t('pb.bud_needs_review_2')} <span className="tabular font-medium text-foreground">{baht(q.data.review.unfavorable_total)}</span></span>}
                  <span className="text-xs text-muted-foreground">{t('pb.bud_material_threshold', { pct: q.data.review.material_threshold_pct, abs: baht(q.data.review.material_threshold_abs) })}</span>
                </div>
                <Button variant="outline" size="sm" disabled={signOff.isPending} onClick={() => { const note = window.prompt(t('pb.bud_review_prompt')); if (note && note.trim()) signOff.mutate(note.trim()); }}>
                  <ClipboardCheck className="size-4" /> {t('pb.bud_record_review')}
                </Button>
              </div>
              {q.data.review.last_signoff
                ? <p className="text-xs text-muted-foreground">{t('pb.bud_last_reviewed_by')} <span className="font-medium text-foreground">{q.data.review.last_signoff.reviewed_by}</span> — {q.data.review.last_signoff.notes}</p>
                : q.data.review.material_count > 0 && <p className="text-xs text-warning-foreground dark:text-warning">{t('pb.bud_no_review_yet')}</p>}
            </Card>

            <DataTable
              rows={q.data.rows}
              rowKey={(r) => r.account_code}
              emptyState={{ icon: Goal, title: t('pb.bud_empty_title'), description: t('pb.bud_empty_desc') }}
              columns={[
                { key: 'account_code', label: t('pb.col_account_code'), render: (r) => <span className="font-medium">{r.account_code}{r.material ? <span title={t('pb.bud_material_title')} className="ml-1 text-warning-foreground dark:text-warning">⚠</span> : null}</span> },
                { key: 'account_name', label: t('pb.col_account_name'), render: (r) => r.account_name ?? '—' },
                { key: 'account_type', label: t('pb.col_type'), render: (r) => (r.account_type ? <Badge variant="info">{r.account_type}</Badge> : '—') },
                { key: 'budget', label: t('pb.col_budget'), align: 'right', render: (r) => <span className="tabular">{baht(r.budget)}</span> },
                { key: 'actual', label: t('pb.col_actual'), align: 'right', render: (r) => <span className="tabular">{baht(r.actual)}</span> },
                { key: 'variance', label: t('pb.col_variance'), align: 'right', render: (r) => <span className={`tabular ${r.material && !r.favorable ? 'font-medium text-destructive' : ''}`}>{baht(r.variance)}</span> },
                { key: 'variance_pct', label: '%', align: 'right', render: (r) => <span className="tabular">{r.variance_pct == null ? '—' : `${r.variance_pct}%`}</span> },
                { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={tone(r.favorable, r.variance)}>{r.status}</Badge> },
              ]}
            />
          </>
        )}
      </StateView>
    </div>
  );
}

function SetBudgetTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [fy, setFy] = useState(String(thisYear));
  const listQ = useQuery<{ budgets: BudgetRow[]; count: number; total: number }>({
    queryKey: ['budgets', fy],
    queryFn: () => api(`/api/ledger/budgets?fiscal_year=${fy}`),
  });

  const [accountCode, setAccountCode] = useState('');
  const [costCenter, setCostCenter] = useState('');
  const [mode, setMode] = useState('annual');
  const [period, setPeriod] = useState('');
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');

  const upsert = useMutation({
    mutationFn: () =>
      api('/api/ledger/budgets', {
        method: 'POST',
        body: JSON.stringify({
          fiscal_year: Number(fy),
          account_code: accountCode,
          cost_center_code: costCenter || undefined,
          mode,
          period: mode === 'monthly' ? period : undefined,
          amount: Number(amount) || 0,
          notes: notes || undefined,
        }),
      }),
    onSuccess: (r: any) => {
      notifySuccess(t('pb.bud_request_sent', { acc: r.account_code }), t('pb.bud_request_detail', { n: num(r.lines), total: baht(r.total) }));
      setAccountCode(''); setAmount(''); setNotes('');
      qc.invalidateQueries({ queryKey: ['budgets', fy] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  // BUD-01 maker-checker: approve/reject a pending budget (whole account/cost-centre group) — different user.
  const decide = useMutation({
    mutationFn: ({ r, action }: { r: BudgetRow; action: 'approve' | 'reject' }) =>
      api(`/api/ledger/budgets/${action}`, { method: 'POST', body: JSON.stringify({ fiscal_year: r.fiscal_year, account_code: r.account_code, cost_center_code: r.cost_center_code ?? undefined }) }),
    onSuccess: (_r, v) => { notifySuccess(v.action === 'approve' ? t('pb.bud_approved') : t('pb.bud_rejected')); qc.invalidateQueries({ queryKey: ['budgets', fy] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const rows = listQ.data?.budgets ?? [];

  return (
    <div className="space-y-5">
      <Card className="max-w-4xl gap-4">
        <CardHeader><CardTitle className="text-base">{t('pb.bud_set_edit')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="bg-fy">{t('pb.fiscal_year')}</Label>
              <Input id="bg-fy" type="number" value={fy} onChange={(e) => setFy(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bg-acc">{t('pb.col_account_code')}</Label>
              <Input id="bg-acc" value={accountCode} onChange={(e) => setAccountCode(e.target.value)} placeholder={t('pb.bud_ph_account')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bg-cc">{t('pb.bud_cost_center_opt')}</Label>
              <Input id="bg-cc" value={costCenter} onChange={(e) => setCostCenter(e.target.value)} placeholder={t('pb.bud_ph_cc')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bg-mode">{t('pb.bud_mode')}</Label>
              <Select id="bg-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="annual">{t('pb.bud_mode_annual')}</option>
                <option value="monthly">{t('pb.bud_mode_monthly')}</option>
              </Select>
            </div>
            {mode === 'monthly' && (
              <div className="grid gap-2">
                <Label htmlFor="bg-period">{t('pb.period_ym')}</Label>
                <Input id="bg-period" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-06" />
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor="bg-amt">{t('pb.bud_amount_baht')}</Label>
              <Input id="bg-amt" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
            </div>
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="bg-notes">{t('pb.col_note')}</Label>
              <Input id="bg-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('pb.bud_ph_desc')} />
            </div>
          </div>
          <Button
            disabled={upsert.isPending || !accountCode.trim() || !amount || (mode === 'monthly' && !/^\d{4}-\d{2}$/.test(period))}
            onClick={() => upsert.mutate()}
          >
            <Plus className="size-4" /> {upsert.isPending ? t('pb.saving') : t('pb.bud_save_budget')}
          </Button>
        </CardContent>
      </Card>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('pb.bud_year_budget', { fy })} {listQ.data && t('pb.bud_total_suffix', { total: baht(listQ.data.total) })}</h3>
        <StateView q={listQ}>
          {listQ.data && (
            <DataTable
              rows={rows}
              rowKey={(r, i) => `${r.account_code}-${r.period}-${i}`}
              emptyState={{ icon: Goal, title: t('pb.bud_empty_year_title'), description: t('pb.bud_empty_year_desc') }}
              columns={[
                { key: 'account_code', label: t('pb.col_account_code'), render: (r) => <span className="font-medium">{r.account_code}</span> },
                { key: 'cost_center_code', label: t('pb.col_cost_center'), render: (r) => r.cost_center_code ?? '—' },
                { key: 'period', label: t('pb.col_period') },
                { key: 'amount', label: t('pb.col_amount_money'), align: 'right', render: (r) => <span className="tabular">{baht(r.amount)}</span> },
                { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={r.status === 'Approved' ? 'success' : r.status === 'PendingApproval' ? 'warning' : r.status === 'Rejected' ? 'destructive' : 'secondary'}>{r.status === 'Approved' ? t('pb.status_approved') : r.status === 'PendingApproval' ? t('pb.status_pending') : r.status === 'Rejected' ? t('pb.reject') : (r.status ?? '—')}</Badge> },
                { key: 'act', label: '', align: 'right', render: (r) => r.status === 'PendingApproval' ? (
                  <div className="flex justify-end gap-1">
                    <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ r, action: 'approve' })}>{t('pb.approve')}</Button>
                    <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ r, action: 'reject' })}>{t('pb.reject')}</Button>
                  </div>
                ) : null },
              ]}
            />
          )}
        </StateView>
      </div>
    </div>
  );
}
