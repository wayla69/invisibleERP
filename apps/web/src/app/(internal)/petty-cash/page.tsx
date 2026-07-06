'use client';

// Petty cash imprest float (วงเงิน) + direct-expense / advance maker-checker with document tracking (EXP-08).
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { HandCoins, Wallet, ReceiptText } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { baht, num } from '@/lib/format';
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

const selectCls = 'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';
const reqStatusVariant = (s: string) => (s === 'Approved' ? 'success' : s === 'Rejected' ? 'destructive' : s === 'Settled' ? 'secondary' : 'warning');
const REQ_STATUS_KEY: Record<string, string> = { PendingApproval: 'fin.pending', Approved: 'fin.approved', Rejected: 'fnx.petty.status_rejected', Settled: 'fnx.petty.status_settled' };

export default function PettyCashPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('fnx.petty.title')} description={t('fnx.petty.subtitle')} />
      <Tabs
        tabs={[
          { key: 'funds', label: t('fnx.petty.tab_funds'), content: <FundsTab /> },
          { key: 'requests', label: t('fnx.petty.tab_requests'), content: <RequestsTab /> },
          { key: 'approvals', label: t('fnx.petty.tab_approvals'), content: <ApprovalsTab /> },
        ]}
      />
    </div>
  );
}

function FundsTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['pc-funds'], queryFn: () => api('/api/finance/petty-cash/funds') });
  const [code, setCode] = useState(''); const [name, setName] = useState(''); const [floatLimit, setFloatLimit] = useState(''); const [initial, setInitial] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['pc-funds'] });

  const create = useMutation({
    mutationFn: () => api<any>('/api/finance/petty-cash/funds', { method: 'POST', body: JSON.stringify({ fund_code: code, name: name || undefined, float_limit: Number(floatLimit), initial_amount: initial ? Number(initial) : undefined }) }),
    // EXP-08 (audit G3): the initial cash injection is now a maker-checker funding request — reflect the
    // pending-approval outcome rather than implying the fund is already cashed.
    onSuccess: (r: any) => { notifySuccess(r.pending ? t('fnx.petty.toast_fund_pending', { code: r.fund_code, no: r.funding_req_no }) : t('fnx.petty.toast_fund_opened', { code: r.fund_code, limit: baht(r.float_limit) })); setCode(''); setName(''); setFloatLimit(''); setInitial(''); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const replenish = useMutation({
    mutationFn: (fundCode: string) => { const amt = window.prompt(t('fnx.petty.prompt_replenish')); if (!amt) throw new Error(t('fin.cancel')); return api<any>(`/api/finance/petty-cash/funds/${fundCode}/replenish`, { method: 'POST', body: JSON.stringify({ amount: Number(amt) }) }); },
    // EXP-08 (audit G3): replenishment now raises a funding request approved by a different user.
    onSuccess: (r: any) => { notifySuccess(t('fnx.petty.toast_replenish_pending', { code: r.fund_code, no: r.funding_req_no })); refresh(); },
    onError: (e: any) => { if (e.message !== t('fin.cancel')) notifyError(e.message); },
  });

  const funds: any[] = q.data?.funds ?? [];
  return (
    <div className="space-y-5">
      <Card className="max-w-3xl gap-4 p-5">
        <h3 className="text-base font-semibold">{t('fnx.petty.open_fund_title')}</h3>
        <div className="grid gap-4 sm:grid-cols-4">
          <div className="grid gap-1.5"><Label>{t('fnx.petty.f_fund_code')}</Label><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="PCF-1" /></div>
          <div className="grid gap-1.5"><Label>{t('fnx.petty.f_name_dept')}</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('fnx.petty.f_name_dept_ph')} /></div>
          <div className="grid gap-1.5"><Label>{t('fnx.petty.f_float')}</Label><Input type="number" min="0" value={floatLimit} onChange={(e) => setFloatLimit(e.target.value)} placeholder="5000" /></div>
          <div className="grid gap-1.5"><Label>{t('fnx.petty.f_initial')}</Label><Input type="number" min="0" value={initial} onChange={(e) => setInitial(e.target.value)} placeholder="5000" /></div>
        </div>
        <div><Button disabled={!code || !floatLimit || create.isPending} onClick={() => create.mutate()}><Wallet className="size-4" /> {t('fnx.petty.open_fund_btn')}</Button></div>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={funds}
            columns={[
              { key: 'fund_code', label: t('fnx.petty.col_code') },
              { key: 'name', label: t('fnx.petty.col_name'), render: (r: any) => r.name ?? '—' },
              { key: 'float_limit', label: t('fnx.petty.col_float'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.float_limit)}</span> },
              { key: 'balance', label: t('fnx.petty.col_balance'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.balance)}</span> },
              { key: 'available', label: t('fnx.petty.col_available'), align: 'right', render: (r: any) => <span className="tabular text-muted-foreground">{baht(r.available)}</span> },
              { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={r.status === 'active' ? 'success' : 'muted'}>{r.status}</Badge> },
              { key: 'act', label: '', align: 'right', render: (r: any) => <Button size="sm" variant="outline" disabled={replenish.isPending} onClick={() => replenish.mutate(r.fund_code)}>{t('fnx.petty.replenish_btn')}</Button> },
            ]}
            emptyState={{ icon: Wallet, title: t('fnx.petty.funds_empty_title'), description: t('fnx.petty.funds_empty_desc') }}
          />
        )}
      </StateView>
    </div>
  );
}

function RequestsTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const funds = useQuery<any>({ queryKey: ['pc-funds'], queryFn: () => api('/api/finance/petty-cash/funds') });
  const q = useQuery<any>({ queryKey: ['pc-requests'], queryFn: () => api('/api/finance/petty-cash/requests') });
  const [fundCode, setFundCode] = useState(''); const [kind, setKind] = useState('expense'); const [payee, setPayee] = useState(''); const [amount, setAmount] = useState(''); const [docRef, setDocRef] = useState(''); const [purpose, setPurpose] = useState('');
  const refresh = () => { qc.invalidateQueries({ queryKey: ['pc-requests'] }); qc.invalidateQueries({ queryKey: ['pc-funds'] }); qc.invalidateQueries({ queryKey: ['pc-pending'] }); };

  const create = useMutation({
    mutationFn: () => api<any>('/api/finance/petty-cash/requests', { method: 'POST', body: JSON.stringify({ fund_code: fundCode, kind, payee: payee || undefined, amount: Number(amount), doc_ref: docRef || undefined, purpose: purpose || undefined }) }),
    onSuccess: (r: any) => { notifySuccess(t('fnx.petty.toast_request_sent', { no: r.req_no, amount: baht(r.amount) })); setPayee(''); setAmount(''); setDocRef(''); setPurpose(''); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const settle = useMutation({
    mutationFn: (reqNo: string) => { const sp = window.prompt(t('fnx.petty.prompt_settled')); if (sp == null) throw new Error(t('fin.cancel')); const rc = window.prompt(t('fnx.petty.prompt_returned'), '0') ?? '0'; return api<any>(`/api/finance/petty-cash/requests/${reqNo}/settle`, { method: 'POST', body: JSON.stringify({ settled_expense: Number(sp), returned_cash: Number(rc) }) }); },
    onSuccess: () => { notifySuccess(t('fnx.petty.toast_settled')); refresh(); },
    onError: (e: any) => { if (e.message !== t('fin.cancel')) notifyError(e.message); },
  });

  const fundList: any[] = funds.data?.funds ?? [];
  return (
    <div className="space-y-5">
      <Card className="max-w-4xl gap-4 p-5">
        <h3 className="text-base font-semibold">{t('fnx.petty.request_title')}</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-1.5"><Label>{t('fnx.petty.f_fund')}</Label>
            <select className={selectCls} value={fundCode} onChange={(e) => setFundCode(e.target.value)}>
              <option value="">{t('fnx.petty.f_fund_select')}</option>
              {fundList.map((f: any) => <option key={f.fund_code} value={f.fund_code}>{t('fnx.petty.fund_option', { code: f.fund_code, balance: baht(f.balance) })}</option>)}
            </select>
          </div>
          <div className="grid gap-1.5"><Label>{t('fnx.petty.f_kind')}</Label>
            <select className={selectCls} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="expense">{t('fnx.petty.kind_expense_opt')}</option>
              <option value="advance">{t('fnx.petty.kind_advance_opt')}</option>
            </select>
          </div>
          <div className="grid gap-1.5"><Label>{t('fnx.petty.f_amount')}</Label><Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label>{t('fnx.petty.f_payee')}</Label><Input value={payee} onChange={(e) => setPayee(e.target.value)} placeholder={t('fnx.petty.f_payee_ph')} /></div>
          <div className="grid gap-1.5"><Label>{t('fnx.petty.f_docref')}</Label><Input value={docRef} onChange={(e) => setDocRef(e.target.value)} placeholder="RCPT-001" /></div>
          <div className="grid gap-1.5"><Label>{t('fnx.petty.f_purpose')}</Label><Input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder={t('fnx.petty.f_purpose_ph')} /></div>
        </div>
        <div><Button disabled={!fundCode || !amount || create.isPending} onClick={() => create.mutate()}><ReceiptText className="size-4" /> {t('fnx.petty.submit_btn')}</Button></div>
        <p className="text-xs text-muted-foreground">{t('fnx.petty.request_note')}</p>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.requests}
            columns={[
              { key: 'req_no', label: t('dash.col_no') },
              { key: 'kind', label: t('fnx.petty.col_kind'), render: (r: any) => <Badge variant={r.kind === 'advance' ? 'secondary' : 'default'}>{r.kind === 'advance' ? t('fnx.petty.kind_advance') : t('fnx.petty.kind_expense')}</Badge> },
              { key: 'payee', label: t('fnx.petty.col_payee'), render: (r: any) => r.payee ?? '—' },
              { key: 'amount', label: t('fnx.petty.col_amount'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
              { key: 'doc_ref', label: t('fnx.petty.col_doc'), render: (r: any) => r.doc_ref ?? '—' },
              { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={reqStatusVariant(r.status)}>{REQ_STATUS_KEY[r.status] ? t(REQ_STATUS_KEY[r.status]) : r.status}</Badge> },
              { key: 'act', label: '', align: 'right', render: (r: any) => (r.kind === 'advance' && r.status === 'Approved' ? <Button size="sm" variant="outline" disabled={settle.isPending} onClick={() => settle.mutate(r.req_no)}>{t('fnx.petty.settle_btn')}</Button> : null) },
            ]}
            emptyState={{ icon: ReceiptText, title: t('fnx.petty.requests_empty_title') }}
          />
        )}
      </StateView>
    </div>
  );
}

function ApprovalsTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['pc-pending'], queryFn: () => api('/api/finance/petty-cash/requests?status=PendingApproval') });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['pc-pending'] }); qc.invalidateQueries({ queryKey: ['pc-requests'] }); qc.invalidateQueries({ queryKey: ['pc-funds'] }); };
  const approve = useMutation({
    mutationFn: (reqNo: string) => api<any>(`/api/finance/petty-cash/requests/${reqNo}/approve`, { method: 'POST' }),
    onSuccess: (r: any) => { notifySuccess(t('fnx.petty.toast_approved', { no: r.req_no, balance: baht(r.fund_balance) })); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const reject = useMutation({
    mutationFn: (reqNo: string) => api<any>(`/api/finance/petty-cash/requests/${reqNo}/reject`, { method: 'POST', body: JSON.stringify({ reason: window.prompt(t('fnx.petty.prompt_reject')) || undefined }) }),
    onSuccess: () => { notifySuccess(t('fnx.petty.toast_rejected')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const pending: any[] = q.data?.requests ?? [];
  return (
    <div className="space-y-4">
      <StatCard label={t('fnx.petty.pending_stat')} value={num(pending.length)} icon={HandCoins} tone={pending.length ? 'warning' : 'success'} className="max-w-xs" />
      <Card className="gap-3 p-5">
        <p className="text-xs text-muted-foreground">{t('fnx.petty.approvals_note')}</p>
        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={pending}
              emptyState={{ icon: HandCoins, title: t('fnx.petty.pending_empty_title') }}
              columns={[
                { key: 'req_no', label: t('dash.col_no') },
                { key: 'kind', label: t('fnx.petty.col_kind'), render: (r: any) => (r.kind === 'advance' ? t('fnx.petty.kind_advance') : t('fnx.petty.kind_expense')) },
                { key: 'payee', label: t('fnx.petty.col_payee'), render: (r: any) => r.payee ?? '—' },
                { key: 'amount', label: t('fnx.petty.col_amount'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
                { key: 'doc_ref', label: t('fnx.petty.col_doc'), render: (r: any) => r.doc_ref ?? '—' },
                { key: 'requested_by', label: t('fnx.petty.col_requester'), render: (r: any) => <span className="text-xs text-muted-foreground">{r.requested_by ?? '—'}</span> },
                { key: 'act', label: '', align: 'right', render: (r: any) => (
                  <div className="flex justify-end gap-1.5">
                    <Button size="sm" variant="outline" disabled={approve.isPending} onClick={() => approve.mutate(r.req_no)}>{t('fin.approve')}</Button>
                    <Button size="sm" variant="ghost" disabled={reject.isPending} onClick={() => reject.mutate(r.req_no)}>{t('fnx.petty.reject_btn')}</Button>
                  </div>
                ) },
              ]}
            />
          )}
        </StateView>
      </Card>
    </div>
  );
}
