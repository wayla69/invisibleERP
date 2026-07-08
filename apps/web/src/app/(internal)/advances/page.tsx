'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { CircleDollarSign, HandCoins, Send, Wallet, X } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
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
import { Select } from '@/components/form-controls';

// Petty-cash / employee advances register (EXP-07): the float-control view ops + finance lacked — every
// advance with its status, plus the OUTSTANDING (uncleared) total, with issue + settle actions.


interface Advance {
  advance_no: string; payee: string; purpose: string | null; amount: number; status: string;
  settled_expense: number; returned_cash: number; issued_by: string | null; issued_date: string | null; settled_date: string | null;
}
interface AdvancesResp { advances: Advance[]; count: number; outstanding: number }

export default function AdvancesPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('fnx.adv.title')}
        description={t('fnx.adv.desc')}
      />
      <Tabs
        tabs={[
          { key: 'register', label: t('fnx.adv.tab_register'), content: <Register /> },
          { key: 'issue', label: t('fnx.adv.tab_issue'), content: <IssueForm /> },
        ]}
      />
    </div>
  );
}

function Register() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [settle, setSettle] = useState<Advance | null>(null);
  const q = useQuery<AdvancesResp>({
    queryKey: ['advances', status],
    queryFn: () => api(`/api/finance/advances${status ? `?status=${status}` : ''}`),
    placeholderData: keepPreviousData,
  });
  const d = q.data;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Select className="w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('fnx.adv.filter_status')}>
          <option value="">{t('fnx.adv.status_all')}</option>
          <option value="open">{t('fnx.adv.status_open')}</option>
          <option value="settled">{t('fnx.adv.status_settled')}</option>
        </Select>
        {q.isFetching && !q.isLoading && <span className="text-xs text-muted-foreground">{t('fnx.adv.updating')}</span>}
      </div>
      <StateView q={q}>
        {d && (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <StatCard label={t('fnx.adv.stat_total')} value={num(d.count)} icon={HandCoins} tone="primary" />
              <StatCard label={t('fnx.adv.stat_outstanding')} value={`฿${num(d.outstanding)}`} icon={Wallet} tone={d.outstanding > 0 ? 'warning' : 'success'} hint={t('fnx.adv.stat_outstanding_hint')} />
              <StatCard label={t('fnx.adv.stat_open')} value={num(d.advances.filter((a) => a.status === 'open').length)} icon={CircleDollarSign} />
            </div>
            <DataTable
              rows={d.advances}
              rowKey={(r) => r.advance_no}
              emptyState={{ icon: HandCoins, title: t('fnx.adv.empty_title'), description: t('fnx.adv.empty_desc') }}
              columns={[
                { key: 'advance_no', label: t('dash.col_no'), render: (r) => <span className="font-medium">{r.advance_no}</span> },
                { key: 'payee', label: t('fnx.adv.col_payee') },
                { key: 'purpose', label: t('fnx.adv.col_purpose'), render: (r) => r.purpose ?? '—' },
                { key: 'amount', label: t('fnx.adv.col_amount'), align: 'right', render: (r) => <span className="tabular font-medium">฿{num(r.amount)}</span> },
                { key: 'status', label: t('fin.col_status'), render: (r) => (r.status === 'open' ? <Badge variant="warning">{t('fnx.adv.badge_open')}</Badge> : <Badge variant="success">{t('fnx.adv.badge_settled')}</Badge>) },
                { key: 'issued_by', label: t('fnx.adv.col_issued_by'), render: (r) => r.issued_by ?? '—' },
                { key: 'issued_date', label: t('fnx.adv.col_issued_date'), render: (r) => (r.issued_date ? thaiDate(r.issued_date) : '—') },
                { key: 'act', label: '', render: (r) => (r.status === 'open' ? <Button size="sm" variant="outline" onClick={() => setSettle(r)}>{t('fnx.adv.action_settle')}</Button> : <span className="text-muted-foreground">—</span>) },
              ]}
            />
            {settle && <SettleCard advance={settle} onDone={() => { setSettle(null); qc.invalidateQueries({ queryKey: ['advances'] }); }} onClose={() => setSettle(null)} />}
          </>
        )}
      </StateView>
    </div>
  );
}

function SettleCard({ advance, onDone, onClose }: { advance: Advance; onDone: () => void; onClose: () => void }) {
  const { t } = useLang();
  const [expense, setExpense] = useState('');
  const [returned, setReturned] = useState('');
  const sum = (Number(expense) || 0) + (Number(returned) || 0);
  const reconciles = Math.abs(sum - advance.amount) < 0.01;

  const submit = useMutation({
    mutationFn: () => api<any>(`/api/finance/advances/${encodeURIComponent(advance.advance_no)}/settle`, {
      method: 'POST',
      body: JSON.stringify({ settled_expense: Number(expense), returned_cash: Number(returned) }),
    }),
    onSuccess: () => { notifySuccess(t('fnx.adv.toast_settled', { no: advance.advance_no, expense: num(expense), returned: num(returned) })); onDone(); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Card className="mt-2 gap-3 p-5">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{t('fnx.adv.settle_heading', { no: advance.advance_no })} <span className="text-muted-foreground">(฿{num(advance.amount)})</span></h3>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label={t('fnx.adv.close')}><X className="size-4" /></Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="ad-exp">{t('fnx.adv.f_expense')}</Label>
          <Input id="ad-exp" type="number" min="0" step="any" value={expense} onChange={(e) => setExpense(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ad-ret">{t('fnx.adv.f_returned')}</Label>
          <Input id="ad-ret" type="number" min="0" step="any" value={returned} onChange={(e) => setReturned(e.target.value)} />
        </div>
      </div>
      <p className={reconciles ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'}>
        {t('fnx.adv.settle_sum', { sum: num(sum) })} {reconciles ? t('fnx.adv.settle_match') : t('fnx.adv.settle_need', { amount: num(advance.amount) })}
      </p>
      <Button className="w-fit" disabled={!reconciles || submit.isPending} onClick={() => submit.mutate()}>
        <Send className="size-4" /> {submit.isPending ? t('fnx.adv.settling') : t('fnx.adv.settle_submit')}
      </Button>
    </Card>
  );
}

function IssueForm() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [form, setForm] = useState({ payee: '', amount: '', purpose: '' });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = useMutation({
    mutationFn: () => api<any>('/api/finance/advances', {
      method: 'POST',
      body: JSON.stringify({ payee: form.payee.trim(), amount: Number(form.amount), purpose: form.purpose.trim() || undefined }),
    }),
    onSuccess: (r) => { notifySuccess(t('fnx.adv.toast_issued', { no: r.advance_no, payee: r.payee, amount: num(r.amount) })); setForm({ payee: '', amount: '', purpose: '' }); qc.invalidateQueries({ queryKey: ['advances'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const canSubmit = !!form.payee.trim() && Number(form.amount) > 0;

  return (
    <Card className="max-w-xl gap-3 p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="ad-payee">{t('fnx.adv.f_payee')} <span className="text-destructive">*</span></Label>
          <Input id="ad-payee" value={form.payee} onChange={set('payee')} placeholder={t('fnx.adv.f_payee_ph')} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ad-amt">{t('fnx.adv.f_amount')} <span className="text-destructive">*</span></Label>
          <Input id="ad-amt" type="number" min="0" step="any" value={form.amount} onChange={set('amount')} />
        </div>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="ad-purpose">{t('fnx.adv.f_purpose')}</Label>
          <Input id="ad-purpose" value={form.purpose} onChange={set('purpose')} placeholder={t('fnx.adv.f_purpose_ph')} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('fnx.adv.posting_note')}</p>
      <Button className="w-fit" disabled={!canSubmit || submit.isPending} onClick={() => submit.mutate()}>
        <HandCoins className="size-4" /> {submit.isPending ? t('fnx.adv.issuing') : t('fnx.adv.issue_submit')}
      </Button>
    </Card>
  );
}
