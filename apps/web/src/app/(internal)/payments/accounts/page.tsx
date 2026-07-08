'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Wallet, CreditCard, Receipt } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDateTime } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLang } from '@/lib/i18n';

interface Deposit { deposit_no: string; customer_name: string | null; purpose: string; amount: number; applied: number; refunded: number; remaining: number; status: string }
interface Account { account_no: string; name: string; credit_limit: number; balance: number; status: string }

export default function PaymentsDepthPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('px.payacct_page_title')} description={t('px.payacct_page_desc')} />
      <Tabs tabs={[
        { key: 'deposits', label: t('px.payacct_tab_deposits'), content: <Deposits /> },
        { key: 'accounts', label: t('px.payacct_tab_accounts'), content: <Accounts /> },
        { key: 'surcharge', label: t('px.payacct_tab_surcharge'), content: <Surcharge /> },
      ]} />
    </div>
  );
}

function Deposits() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [amount, setAmount] = useState(''); const [name, setName] = useState('');
  const q = useQuery<{ deposits: Deposit[] }>({ queryKey: ['deposits'], queryFn: () => api('/api/payments/deposits') });
  const take = useMutation({
    mutationFn: () => api('/api/payments/deposits', { method: 'POST', body: JSON.stringify({ amount: Number(amount), customer_name: name || undefined }) }),
    onSuccess: () => { notifySuccess(t('px.payacct_deposit_taken', { amount: baht(Number(amount)) })); setAmount(''); setName(''); qc.invalidateQueries({ queryKey: ['deposits'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const apply = useMutation({ mutationFn: (no: string) => api(`/api/payments/deposits/${no}/apply`, { method: 'POST', body: JSON.stringify({}) }), onSuccess: () => qc.invalidateQueries({ queryKey: ['deposits'] }), onError: (e: Error) => notifyError(e.message) });
  const refund = useMutation({ mutationFn: (no: string) => api(`/api/payments/deposits/${no}/refund`, { method: 'POST', body: JSON.stringify({}) }), onSuccess: () => qc.invalidateQueries({ queryKey: ['deposits'] }), onError: (e: Error) => notifyError(e.message) });
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-sm">{t('px.payacct_new_deposit')}</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div><Label>{t('px.payacct_amount')}</Label><Input value={amount} onChange={(e) => setAmount(e.target.value)} className="w-32" placeholder="500" /></div>
          <div><Label>{t('px.payacct_customer_name')}</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('px.payacct_ph_customer')} /></div>
          <Button disabled={!amount || take.isPending} onClick={() => take.mutate()}>{t('px.payacct_take_deposit')}</Button>
        </CardContent>
      </Card>
      <StateView q={q}>
        <DataTable
          rows={q.data?.deposits ?? []}
          rowKey={(r) => r.deposit_no}
          columns={[
            { key: 'deposit_no', label: t('dash.col_no') },
            { key: 'customer_name', label: t('fin.col_customer'), render: (r) => r.customer_name ?? '—' },
            { key: 'amount', label: t('px.payacct_col_deposit'), align: 'right', render: (r) => baht(r.amount) },
            { key: 'remaining', label: t('px.payacct_col_remaining'), align: 'right', render: (r) => <span className="tabular">{baht(r.remaining)}</span> },
            { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={r.status === 'open' ? 'info' : r.status === 'closed' || r.status === 'refunded' ? 'muted' : 'success'}>{r.status}</Badge> },
            { key: 'act', label: '', align: 'right', render: (r) => r.status === 'open' ? <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" onClick={() => apply.mutate(r.deposit_no)}>{t('px.payacct_apply')}</Button><Button size="sm" variant="ghost" disabled={refund.isPending} onClick={() => refund.mutate(r.deposit_no)}>{t('px.payacct_refund_short')}</Button></div> : null },
          ]}
          emptyState={{ icon: Wallet, title: t('px.payacct_empty_deposits_title'), description: t('px.payacct_empty_deposits_desc') }}
        />
      </StateView>
    </div>
  );
}

function Accounts() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [name, setName] = useState(''); const [limit, setLimit] = useState(''); const [sel, setSel] = useState<string | null>(null);
  const q = useQuery<{ accounts: Account[] }>({ queryKey: ['house-accounts'], queryFn: () => api('/api/payments/house-accounts') });
  const stmt = useQuery<any>({ queryKey: ['house-statement', sel], queryFn: () => api(`/api/payments/house-accounts/${sel}/statement`), enabled: !!sel });
  const open = useMutation({
    mutationFn: () => api('/api/payments/house-accounts', { method: 'POST', body: JSON.stringify({ name, credit_limit: limit ? Number(limit) : 0 }) }),
    onSuccess: () => { notifySuccess(t('px.payacct_account_opened', { name })); setName(''); setLimit(''); qc.invalidateQueries({ queryKey: ['house-accounts'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-sm">{t('px.payacct_open_account')}</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div><Label>{t('px.payacct_account_name')}</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('px.payacct_ph_company')} /></div>
          <div><Label>{t('px.payacct_credit_limit')}</Label><Input value={limit} onChange={(e) => setLimit(e.target.value)} className="w-32" placeholder="10000" /></div>
          <Button disabled={!name || open.isPending} onClick={() => open.mutate()}>{t('px.payacct_open_account_btn')}</Button>
        </CardContent>
      </Card>
      <StateView q={q}>
        <DataTable
          rows={q.data?.accounts ?? []}
          rowKey={(r) => r.account_no}
          columns={[
            { key: 'account_no', label: t('dash.col_no') },
            { key: 'name', label: t('px.payacct_col_name') },
            { key: 'credit_limit', label: t('px.payacct_col_limit'), align: 'right', render: (r) => baht(r.credit_limit) },
            { key: 'balance', label: t('px.payacct_col_balance'), align: 'right', render: (r) => <span className="tabular">{baht(r.balance)}</span> },
            { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={r.status === 'active' ? 'success' : 'muted'}>{r.status}</Badge> },
            { key: 'act', label: '', align: 'right', render: (r) => <Button size="sm" variant="ghost" onClick={() => setSel(r.account_no)}>{t('px.payacct_entries')}</Button> },
          ]}
          emptyState={{ icon: CreditCard, title: t('px.payacct_empty_accounts_title'), description: t('px.payacct_empty_accounts_desc') }}
        />
      </StateView>
      {sel && stmt.data && (
        <Card>
          <CardHeader><CardTitle className="text-sm">{t('px.payacct_statement_title', { account: sel, balance: baht(stmt.data.balance) })}{stmt.data.available_credit != null ? t('px.payacct_statement_avail', { avail: baht(stmt.data.available_credit) }) : ''}</CardTitle></CardHeader>
          <CardContent>
            <DataTable
              rows={stmt.data.entries ?? []}
              rowKey={(r: any) => r.entry_no}
              columns={[
                { key: 'created_at', label: t('px.payacct_col_time'), render: (r: any) => thaiDateTime(r.created_at) },
                { key: 'type', label: t('px.payacct_col_type'), render: (r: any) => <Badge variant={r.type === 'charge' ? 'warning' : 'success'}>{r.type}</Badge> },
                { key: 'amount', label: t('inv.col_qty'), align: 'right', render: (r: any) => baht(r.amount) },
                { key: 'currency', label: t('px.payacct_col_currency'), render: (r: any) => r.currency !== 'THB' ? `${r.currency}@${r.fx_rate}` : 'THB' },
                { key: 'balance_after', label: t('px.payacct_col_remaining'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.balance_after)}</span> },
              ]}
              emptyState={{ title: t('px.payacct_empty_statement_title') }}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Surcharge() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [method, setMethod] = useState('Card'); const [pct, setPct] = useState('');
  const q = useQuery<{ surcharges: { method: string; pct: number; active: boolean }[] }>({ queryKey: ['surcharges'], queryFn: () => api('/api/payments/surcharges') });
  const save = useMutation({
    mutationFn: () => api('/api/payments/surcharges', { method: 'POST', body: JSON.stringify({ method, pct: Number(pct) }) }),
    onSuccess: () => { notifySuccess(t('px.payacct_surcharge_set', { method, pct })); setPct(''); qc.invalidateQueries({ queryKey: ['surcharges'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-sm flex items-center gap-2"><CreditCard className="h-4 w-4" />{t('px.payacct_set_surcharge')}</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div><Label>{t('px.payacct_channel')}</Label><Input value={method} onChange={(e) => setMethod(e.target.value)} className="w-32" placeholder="Card" /></div>
          <div><Label>{t('px.payacct_percent')}</Label><Input value={pct} onChange={(e) => setPct(e.target.value)} className="w-24" placeholder="3" /></div>
          <Button disabled={!method || pct === '' || save.isPending} onClick={() => save.mutate()}>{t('fin.save')}</Button>
        </CardContent>
      </Card>
      <StateView q={q}>
        <DataTable
          rows={q.data?.surcharges ?? []}
          rowKey={(r) => r.method}
          columns={[
            { key: 'method', label: t('px.payacct_channel'), render: (r) => <span className="flex items-center gap-2"><Receipt className="h-4 w-4 text-muted-foreground" />{r.method}</span> },
            { key: 'pct', label: t('px.payacct_col_fee'), align: 'right', render: (r) => `${r.pct}%` },
            { key: 'active', label: t('fin.col_status'), render: (r) => <Badge variant={r.active ? 'success' : 'muted'}>{r.active ? t('px.payacct_active') : t('px.payacct_inactive')}</Badge> },
          ]}
          emptyState={{ icon: Receipt, title: t('px.payacct_empty_surcharge_title'), description: t('px.payacct_empty_surcharge_desc') }}
        />
      </StateView>
    </div>
  );
}
