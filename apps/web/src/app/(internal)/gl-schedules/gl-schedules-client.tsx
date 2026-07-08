'use client';

// รายการบัญชีตั้งเวลา (GL scheduled entries) — the two GL-automation engines that previously had no UI:
//   • รายการตั้งเวลา (Recurring journals, GL-08)  → GET/POST /api/ledger/recurring, /recurring/:id/active, /recurring/run
//   • ค่าใช้จ่ายจ่ายล่วงหน้า (Prepaid amortization, GL-09) → GET/POST /api/ledger/prepaid, /prepaid/run
// A recurring run posts each due template as a DRAFT JE (maker-checker, GL-05); a prepaid run amortizes one
// straight-line slice (Dr expense / Cr 1280). Both runs are idempotent.
import { Fragment, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Play, Plus, Save, X } from 'lucide-react';

import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { baht, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { jeFormError, jeLineError } from '@/lib/journal-validation';
import { useMe, hasPerm } from '@/lib/auth';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StateView } from '@/components/state-view';
import { FormField } from '@/components/form-field';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';
import { Select } from '@/components/form-controls';

type Account = { code: string; name: string; type: string };

export function GlSchedulesClient() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('fnx.gls.title')}
        description={t('fnx.gls.description')}
      />
      <Tabs
        urlParam="tab"
        tabs={[
          { key: 'recurring', label: t('fnx.gls.tab_recurring'), content: <Recurring /> },
          { key: 'prepaid', label: t('fnx.gls.tab_prepaid'), content: <Prepaid /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── Recurring journals (GL-08) ─────────────────────────
type Line = { account_code: string; debit: string; credit: string };
const emptyLine = (): Line => ({ account_code: '', debit: '', credit: '' });

function Recurring() {
  const { t } = useLang();
  const me = useMe();
  const canManage = hasPerm(me.data, 'gl_post', 'exec');
  const qc = useQueryClient();
  const accountsQ = useQuery<{ accounts: Account[] }>({ queryKey: ['accounts'], queryFn: () => api('/api/ledger/accounts') });
  const q = useQuery<any>({ queryKey: ['recurring'], queryFn: () => api('/api/ledger/recurring') });

  const [name, setName] = useState('');
  const [frequency, setFrequency] = useState<'daily' | 'weekly' | 'monthly'>('monthly');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);
  const [showErrors, setShowErrors] = useState(false);
  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const sumD = lines.reduce((a, l) => a + (Number(l.debit) || 0), 0);
  const sumC = lines.reduce((a, l) => a + (Number(l.credit) || 0), 0);
  const balanced = Math.abs(sumD - sumC) < 0.005 && sumD > 0;
  const nameErr = !name.trim() ? t('fnx.gls.err_name') : null;
  const formErr = jeFormError(lines);

  const refresh = () => qc.invalidateQueries({ queryKey: ['recurring'] });
  const create = useMutation({
    mutationFn: () => api('/api/ledger/recurring', {
      method: 'POST',
      body: JSON.stringify({
        name, frequency, memo: memo || undefined,
        lines: lines.filter((l) => l.account_code && (Number(l.debit) || Number(l.credit))).map((l) => ({ account_code: l.account_code, debit: Number(l.debit) || undefined, credit: Number(l.credit) || undefined })),
      }),
    }),
    onSuccess: () => { notifySuccess(t('fnx.gls.recurring_created')); setName(''); setMemo(''); setLines([emptyLine(), emptyLine()]); setShowErrors(false); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const submit = () => { setShowErrors(true); if (nameErr || formErr || lines.some((l) => jeLineError(l))) { notifyError(t('fnx.gls.fix_before_save')); return; } create.mutate(); };
  const toggle = useMutation({ mutationFn: (v: { id: number; active: boolean }) => api(`/api/ledger/recurring/${v.id}/active`, { method: 'POST', body: JSON.stringify({ active: v.active }) }), onSuccess: refresh, onError: (e: any) => notifyError(e.message) });
  const runDue = useMutation({
    mutationFn: () => api<{ posted: number; scanned: number }>('/api/ledger/recurring/run', { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(t('fnx.gls.run_posted', { posted: r.posted, scanned: r.scanned })); refresh(); qc.invalidateQueries({ queryKey: ['je-pending'] }); qc.invalidateQueries({ queryKey: ['journal'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const rows: any[] = q.data?.recurring ?? [];
  const FREQ_KEY: Record<string, string> = { daily: 'fnx.gls.freq_daily', weekly: 'fnx.gls.freq_weekly', monthly: 'fnx.gls.freq_monthly' };
  const freqLabel = (f: string) => (FREQ_KEY[f] ? t(FREQ_KEY[f]) : f);

  return (
    <div className="grid gap-5">
      {canManage && (
        <Card className="gap-3 p-5">
          <h3 className="text-base font-semibold">{t('fnx.gls.create_recurring')}</h3>
          <div className="flex flex-wrap items-end gap-3">
            <FormField htmlFor="rc-name" label={t('fnx.gls.entry_name')} required error={showErrors ? nameErr : undefined}><Input id="rc-name" value={name} aria-invalid={showErrors && !!nameErr} onChange={(e) => setName(e.target.value)} placeholder={t('fnx.gls.entry_name_placeholder')} /></FormField>
            <div className="grid gap-1.5">
              <Label htmlFor="rc-freq">{t('fnx.gls.frequency')}</Label>
              <Select id="rc-freq"  value={frequency} onChange={(e) => setFrequency(e.target.value as 'daily' | 'weekly' | 'monthly')}>
                <option value="daily">{t('fnx.gls.freq_daily')}</option>
                <option value="weekly">{t('fnx.gls.freq_weekly')}</option>
                <option value="monthly">{t('fnx.gls.freq_monthly')}</option>
              </Select>
            </div>
            <div className="grid flex-1 gap-1.5"><Label htmlFor="rc-memo">{t('fnx.gls.memo')}</Label><Input id="rc-memo" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder={t('fnx.gls.memo_placeholder')} /></div>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="pb-2 font-medium">{t('fnx.gls.account')}</th>
                <th className="w-[130px] pb-2 font-medium">{t('fnx.gls.debit')}</th>
                <th className="w-[130px] pb-2 font-medium">{t('fnx.gls.credit')}</th>
                <th className="w-10 pb-2" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const err = showErrors ? jeLineError(l) : null;
                return (
                <Fragment key={i}>
                <tr>
                  <td className="py-1 pr-2">
                    <Select aria-invalid={!!err} value={l.account_code} onChange={(e) => setLine(i, { account_code: e.target.value })}>
                      <option value="">{t('fnx.gls.select_account')}</option>
                      {accountsQ.data?.accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                    </Select>
                  </td>
                  <td className="py-1 pr-2"><Input type="number" min="0" aria-invalid={!!err} value={l.debit} onChange={(e) => setLine(i, { debit: e.target.value, credit: '' })} /></td>
                  <td className="py-1 pr-2"><Input type="number" min="0" aria-invalid={!!err} value={l.credit} onChange={(e) => setLine(i, { credit: e.target.value, debit: '' })} /></td>
                  <td className="py-1">{lines.length > 2 && <Button variant="ghost" size="icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><X className="size-4" /></Button>}</td>
                </tr>
                {err && <tr><td colSpan={4} className="pb-1 text-xs text-destructive" role="alert">{err}</td></tr>}
                </Fragment>
                );
              })}
            </tbody>
          </table>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, emptyLine()])}><Plus className="size-4" /> {t('fnx.gls.add_line')}</Button>
            <span className="text-sm">
              {t('fnx.gls.debit')} <strong className="tabular">{baht(sumD)}</strong> · {t('fnx.gls.credit')} <strong className="tabular">{baht(sumC)}</strong>{' '}
              <Badge variant={balanced ? 'success' : 'warning'}>{balanced ? t('fnx.gls.balanced') : t('fnx.gls.unbalanced')}</Badge>
            </span>
            <Button disabled={create.isPending} onClick={submit}><Save className="size-4" /> {create.isPending ? t('fnx.gls.saving') : t('fnx.gls.create_entry')}</Button>
          </div>
          {showErrors && formErr && <p className="text-sm text-destructive" role="alert">{formErr}</p>}
        </Card>
      )}

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-muted-foreground">{t('fnx.gls.all_recurring')}</h3>
          {canManage && <Button variant="outline" size="sm" disabled={runDue.isPending} onClick={() => runDue.mutate()}><Play className="size-4" /> {t('fnx.gls.post_due')}</Button>}
        </div>
        <StateView q={q}>
          <div className="grid gap-3">
            {rows.length === 0 && <Card className="gap-0 p-5"><span className="text-sm text-muted-foreground">{t('fnx.gls.no_recurring')}</span></Card>}
            {rows.map((r) => (
              <Card key={r.id} className="gap-2 p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong>{r.name}</strong>
                  <span className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Badge variant="secondary">{freqLabel(r.frequency)}</Badge>
                    <span className="flex items-center gap-1"><CalendarClock className="size-3.5" /> {t('fnx.gls.next_run')} {thaiDate(r.next_run_date)}</span>
                    <Badge variant={r.active ? 'success' : 'muted'}>{r.active ? t('fnx.gls.active') : t('fnx.gls.paused')}</Badge>
                    {canManage && <Button size="sm" variant="ghost" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: r.id, active: !r.active })}>{r.active ? t('fnx.gls.pause') : t('fnx.gls.enable')}</Button>}
                  </span>
                </div>
                {r.memo && <div className="text-sm text-muted-foreground">{r.memo}</div>}
                <table className="w-full text-sm">
                  <tbody>
                    {(r.lines ?? []).map((l: any, j: number) => (
                      <tr key={j}><td className="py-0.5">{l.account_code}</td><td className="py-0.5 text-right tabular">{l.debit ? baht(l.debit) : ''}</td><td className="py-0.5 text-right tabular">{l.credit ? baht(l.credit) : ''}</td></tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            ))}
          </div>
        </StateView>
      </div>
    </div>
  );
}

// ───────────────────────── Prepaid amortization (GL-09) ─────────────────────────
function Prepaid() {
  const { t } = useLang();
  const me = useMe();
  const canManage = hasPerm(me.data, 'gl_post', 'exec');
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['prepaid'], queryFn: () => api('/api/ledger/prepaid') });

  const [name, setName] = useState('');
  const [total, setTotal] = useState('');
  const [months, setMonths] = useState('12');
  const [expenseAccount, setExpenseAccount] = useState('');
  const [capitalize, setCapitalize] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  const nameErr = !name.trim() ? t('fnx.gls.err_name') : null;
  const totalErr = !(Number(total) > 0) ? t('fnx.gls.err_total') : null;
  const monthsErr = !(Number.isInteger(Number(months)) && Number(months) >= 1) ? t('fnx.gls.err_months') : null;

  const refresh = () => qc.invalidateQueries({ queryKey: ['prepaid'] });
  const create = useMutation({
    mutationFn: () => api('/api/ledger/prepaid', {
      method: 'POST',
      body: JSON.stringify({ name, total_amount: Number(total), months: Number(months), expense_account: expenseAccount || undefined, capitalize }),
    }),
    onSuccess: () => { notifySuccess(t('fnx.gls.prepaid_created')); setName(''); setTotal(''); setMonths('12'); setExpenseAccount(''); setCapitalize(false); setShowErrors(false); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const submit = () => { setShowErrors(true); if (nameErr || totalErr || monthsErr) { notifyError(t('fnx.gls.fix_invalid_before_save')); return; } create.mutate(); };
  const runDue = useMutation({
    mutationFn: () => api<{ posted?: number; scanned?: number }>('/api/ledger/prepaid/run', { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(t('fnx.gls.prepaid_run_posted', { posted: r.posted ?? 0 })); refresh(); qc.invalidateQueries({ queryKey: ['journal'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const rows: any[] = q.data?.schedules ?? [];

  return (
    <div className="grid gap-5">
      {canManage && (
        <Card className="gap-3 p-5">
          <h3 className="text-base font-semibold">{t('fnx.gls.create_prepaid')}</h3>
          <p className="text-sm text-muted-foreground">{t('fnx.gls.straight_line', { amount: Number(total) > 0 && Number(months) >= 1 ? baht(Number(total) / Number(months)) : '—' })}</p>
          <div className="flex flex-wrap items-start gap-3">
            <FormField htmlFor="pp-name" label={t('fnx.gls.entry_name')} required error={showErrors ? nameErr : undefined}><Input id="pp-name" value={name} aria-invalid={showErrors && !!nameErr} onChange={(e) => setName(e.target.value)} placeholder={t('fnx.gls.prepaid_name_placeholder')} /></FormField>
            <FormField htmlFor="pp-total" label={t('fnx.gls.total')} required error={showErrors ? totalErr : undefined}><Input id="pp-total" type="number" min="0" value={total} aria-invalid={showErrors && !!totalErr} onChange={(e) => setTotal(e.target.value)} className="w-[140px]" /></FormField>
            <FormField htmlFor="pp-months" label={t('fnx.gls.months')} required error={showErrors ? monthsErr : undefined}><Input id="pp-months" type="number" min="1" value={months} aria-invalid={showErrors && !!monthsErr} onChange={(e) => setMonths(e.target.value)} className="w-[120px]" /></FormField>
            <FormField htmlFor="pp-acct" label={t('fnx.gls.expense_account')} hint={t('fnx.gls.expense_account_hint')}><Input id="pp-acct" value={expenseAccount} onChange={(e) => setExpenseAccount(e.target.value)} placeholder="5100" className="w-[120px]" /></FormField>
            <label className="flex items-center gap-2 pt-8 text-sm">
              <input type="checkbox" checked={capitalize} onChange={(e) => setCapitalize(e.target.checked)} className="size-4" />
              {t('fnx.gls.capitalize_now')}
            </label>
            <div className="pt-7"><Button disabled={create.isPending} onClick={submit}><Save className="size-4" /> {create.isPending ? t('fnx.gls.saving') : t('fnx.gls.create_schedule')}</Button></div>
          </div>
        </Card>
      )}

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-muted-foreground">{t('fnx.gls.all_prepaid')}</h3>
          {canManage && <Button variant="outline" size="sm" disabled={runDue.isPending} onClick={() => runDue.mutate()}><Play className="size-4" /> {t('fnx.gls.amortize_due')}</Button>}
        </div>
        <StateView q={q}>
          <div className="grid gap-3">
            {rows.length === 0 && <Card className="gap-0 p-5"><span className="text-sm text-muted-foreground">{t('fnx.gls.no_prepaid')}</span></Card>}
            {rows.map((r) => {
              const pct = r.total_amount > 0 ? Math.round((r.amortized_amount / r.total_amount) * 100) : 0;
              return (
                <Card key={r.id} className="gap-2 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong>{r.name} <span className="font-normal text-muted-foreground">· {r.schedule_no}</span></strong>
                    <span className="flex items-center gap-2 text-sm text-muted-foreground">
                      {t('fnx.gls.period')} {r.periods_posted}/{r.months} · {t('fnx.gls.next_run')} {thaiDate(r.next_run_date)}
                      <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                    </span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <StatCard label={t('fnx.gls.total')} value={baht(r.total_amount)} />
                    <StatCard label={t('fnx.gls.amortized')} value={baht(r.amortized_amount)} tone="primary" hint={`${pct}%`} />
                    <StatCard label={t('fnx.gls.remaining')} value={baht(r.remaining)} tone="success" />
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                  </div>
                </Card>
              );
            })}
          </div>
        </StateView>
      </div>
    </div>
  );
}
