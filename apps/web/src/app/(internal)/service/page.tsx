'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, AlertTriangle, ShieldCheck, ClipboardList, Repeat, LifeBuoy } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
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
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

// GET /api/service/contracts → { contracts: [...], count }
interface Contract { id: number; contract_no: string; customer_name: string; sla_tier: string; response_hours: number; resolution_hours: number; start_date: string | null; end_date: string | null; status: string; monthly_value: number }
// GET /api/service/subscriptions → { subscriptions: [...], count }
interface Sub { id: number; sub_no: string; customer_name: string; product_code: string; billing_cycle: string; unit_price: number; qty: number; next_billing_date: string | null; status: string }
// GET /api/service/contracts/:id/events → { events: [...], count }
interface SlaEvent { id: number; event_no: string; title: string; priority: string; opened_at: string | null; response_due_at: string | null; responded_at: string | null; resolved_at: string | null; resolution_due_at: string | null; response_breached: boolean; resolution_breached: boolean; status: string }


export default function ServicePage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('crm.service_title')} description={t('crm.service_subtitle')} />
      <Tabs
        tabs={[
          { key: 'cases', label: t('crm.tab_cases'), content: <Cases /> },
          { key: 'contracts', label: t('crm.tab_contracts'), content: <Contracts /> },
          { key: 'subs', label: t('crm.tab_subscriptions'), content: <Subscriptions /> },
        ]}
      />
    </div>
  );
}

// GET /api/service/cases → { cases: [...], count }
interface Case { id: number; case_no: string; subject: string; status: string; priority: string; source: string; contact_email: string | null; customer_name: string | null; assignee: string | null; created_at: string | null }

function Cases() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ cases: Case[]; count: number }>({ queryKey: ['svc-cases'], queryFn: () => api('/api/service/cases') });
  const cases = q.data?.cases ?? [];
  const openCount = cases.filter((c) => c.status === 'new' || c.status === 'open' || c.status === 'pending').length;
  const emailCount = cases.filter((c) => c.source === 'email').length;

  const [subject, setSubject] = useState('');
  const [priority, setPriority] = useState('P3');
  const [contactEmail, setContactEmail] = useState('');
  const [assignee, setAssignee] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api('/api/service/cases', {
        method: 'POST',
        body: JSON.stringify({ subject, priority, contact_email: contactEmail || undefined, assignee: assignee || undefined }),
      }),
    onSuccess: (r: any) => {
      notifySuccess(t('crm.case_created_ok', { no: r.case_no }));
      setSubject(''); setContactEmail(''); setAssignee('');
      qc.invalidateQueries({ queryKey: ['svc-cases'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const act = useMutation({
    mutationFn: ({ id, action, body }: { id: number; action: string; body?: unknown }) =>
      api(`/api/service/cases/${id}/${action}`, { method: 'POST', body: body != null ? JSON.stringify(body) : undefined }),
    onSuccess: (_r, v) => {
      notifySuccess(t(v.action === 'assign' ? 'crm.case_assigned_ok' : v.action === 'resolve' ? 'crm.case_resolved_ok' : v.action === 'close' ? 'crm.case_closed_ok' : 'crm.case_reopened_ok'));
      qc.invalidateQueries({ queryKey: ['svc-cases'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const assign = (c: Case) => {
    const who = window.prompt(t('crm.case_assign_prompt'), c.assignee ?? '');
    if (who && who.trim()) act.mutate({ id: c.id, action: 'assign', body: { assignee: who.trim() } });
  };

  return (
    <div className="space-y-5">
      <StateView q={q}>
        {q.data && (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label={t('crm.total_cases')} value={num(cases.length)} icon={LifeBuoy} tone="primary" />
            <StatCard label={t('crm.open_cases')} value={num(openCount)} tone="warning" />
            <StatCard label={t('crm.email_cases')} value={num(emailCount)} tone="info" />
          </div>
        )}
      </StateView>

      {/* Open a case */}
      <Card className="max-w-3xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">{t('crm.cases_new')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="case-subj">{t('crm.case_subject')}</Label>
              <Input id="case-subj" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t('crm.case_subject_ph')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="case-email">{t('crm.case_contact_email')}</Label>
              <Input id="case-email" type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="customer@example.com" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="case-pri">{t('crm.case_priority')}</Label>
              <Select id="case-pri" value={priority} onChange={(e) => setPriority(e.target.value)}>
                {['P1', 'P2', 'P3', 'P4'].map((p) => <option key={p} value={p}>{p}</option>)}
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="case-assignee">{t('crm.case_assignee')}</Label>
              <Input id="case-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder={t('crm.case_assignee_ph')} />
            </div>
          </div>
          <Button disabled={create.isPending || !subject.trim()} onClick={() => create.mutate()}>
            <Plus className="size-4" /> {create.isPending ? t('crm.saving') : t('crm.case_create_btn')}
          </Button>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={cases}
            emptyState={{ icon: LifeBuoy, title: t('crm.no_cases_title'), description: t('crm.no_cases_desc') }}
            columns={[
              { key: 'case_no', label: t('dash.col_no') },
              { key: 'subject', label: t('crm.case_subject') },
              { key: 'priority', label: t('crm.case_priority'), render: (r: Case) => <Badge variant={statusVariant(r.priority)}>{r.priority}</Badge> },
              { key: 'source', label: t('crm.case_source'), render: (r: Case) => <Badge variant="info">{r.source}</Badge> },
              { key: 'assignee', label: t('crm.case_assignee'), render: (r: Case) => r.assignee ?? '—' },
              { key: 'status', label: t('fin.col_status'), render: (r: Case) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              {
                key: 'actions',
                label: '',
                align: 'right',
                render: (r: Case) => (
                  <div className="flex justify-end gap-2">
                    {r.status !== 'closed' && (
                      <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => assign(r)}>{t('crm.case_assign')}</Button>
                    )}
                    {(r.status === 'new' || r.status === 'open' || r.status === 'pending') && (
                      <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, action: 'resolve', body: {} })}>{t('crm.case_resolve')}</Button>
                    )}
                    {r.status !== 'closed' && (
                      <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, action: 'close' })}>{t('crm.case_close')}</Button>
                    )}
                    {(r.status === 'resolved' || r.status === 'closed') && (
                      <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, action: 'reopen' })}>{t('crm.case_reopen')}</Button>
                    )}
                  </div>
                ),
              },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}

function Contracts() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ contracts: Contract[]; count: number }>({ queryKey: ['svc-contracts'], queryFn: () => api('/api/service/contracts') });

  const [selected, setSelected] = useState<number | null>(null);

  // Create-contract form state
  const [customerName, setCustomerName] = useState('');
  const [slaTier, setSlaTier] = useState('Silver');
  const [startDate, setStartDate] = useState('2026-01-01');
  const [endDate, setEndDate] = useState('2026-12-31');
  const [monthlyValue, setMonthlyValue] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api('/api/service/contracts', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: customerName,
          sla_tier: slaTier,
          start_date: startDate,
          end_date: endDate,
          monthly_value: Number(monthlyValue) || 0,
        }),
      }),
    onSuccess: (r: any) => {
      notifySuccess(t('crm.contract_created', { no: r.contract_no }));
      setCustomerName(''); setMonthlyValue('');
      qc.invalidateQueries({ queryKey: ['svc-contracts'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const contracts = q.data?.contracts ?? [];
  const activeCount = contracts.filter((c) => c.status === 'Active').length;
  const monthlyTotal = contracts.reduce((s, c) => s + (c.status === 'Active' ? c.monthly_value : 0), 0);

  return (
    <div className="space-y-5">
      <StateView q={q}>
        {q.data && (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label={t('crm.total_contracts')} value={num(contracts.length)} icon={ShieldCheck} tone="primary" />
            <StatCard label={t('crm.active_contracts')} value={num(activeCount)} tone="success" />
            <StatCard label={t('crm.monthly_value_active')} value={baht(monthlyTotal)} tone="info" />
          </div>
        )}
      </StateView>

      {/* Create contract */}
      <Card className="max-w-3xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">{t('crm.create_contract')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="svc-cust">{t('fin.col_customer')}</Label>
              <Input id="svc-cust" value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder={t('crm.customer_name_placeholder')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="svc-tier">{t('crm.sla_tier')}</Label>
              <Select id="svc-tier"  value={slaTier} onChange={(e) => setSlaTier(e.target.value)}>
                {['Bronze', 'Silver', 'Gold', 'Platinum'].map((tier) => <option key={tier} value={tier}>{tier}</option>)}
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="svc-start">{t('crm.start_date')}</Label>
              <Input id="svc-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="svc-end">{t('crm.end_date')}</Label>
              <Input id="svc-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="svc-monthly">{t('crm.monthly_value_field')}</Label>
              <Input id="svc-monthly" type="number" min="0" value={monthlyValue} onChange={(e) => setMonthlyValue(e.target.value)} placeholder="0" />
            </div>
          </div>
          <Button disabled={create.isPending || !customerName.trim()} onClick={() => create.mutate()}>
            <Plus className="size-4" /> {create.isPending ? t('crm.saving') : t('crm.create_contract_btn')}
          </Button>
        </CardContent>
      </Card>

      {/* Contracts table */}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('crm.contracts_table_hint')}</h3>
        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={contracts}
              onRowClick={(r: Contract) => setSelected((id) => (id === r.id ? null : r.id))}
              emptyState={{ icon: ShieldCheck, title: t('crm.no_contracts_title'), description: t('crm.no_contracts_desc') }}
              columns={[
                { key: 'contract_no', label: t('dash.col_no') },
                { key: 'customer_name', label: t('fin.col_customer') },
                { key: 'sla_tier', label: t('crm.sla_tier'), render: (r: Contract) => <Badge variant="info">{r.sla_tier}</Badge> },
                { key: 'response_hours', label: t('crm.response_hours'), align: 'right', render: (r: Contract) => <span className="tabular">{num(r.response_hours)}</span> },
                { key: 'resolution_hours', label: t('crm.resolution_hours'), align: 'right', render: (r: Contract) => <span className="tabular">{num(r.resolution_hours)}</span> },
                { key: 'monthly_value', label: t('crm.monthly_value_col'), align: 'right', render: (r: Contract) => <span className="tabular">{baht(r.monthly_value)}</span> },
                { key: 'status', label: t('fin.col_status'), render: (r: Contract) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              ]}
            />
          )}
        </StateView>
      </div>

      {selected != null && <ContractEvents contractId={selected} />}
    </div>
  );
}

function ContractEvents({ contractId }: { contractId: number }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ events: SlaEvent[]; count: number }>({
    queryKey: ['svc-events', contractId],
    queryFn: () => api(`/api/service/contracts/${contractId}/events`),
  });

  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('P3');

  const log = useMutation({
    mutationFn: () =>
      api(`/api/service/contracts/${contractId}/events`, {
        method: 'POST',
        body: JSON.stringify({ title, priority }),
      }),
    onSuccess: (r: any) => {
      notifySuccess(t('crm.event_logged', { no: r.event_no }));
      setTitle('');
      qc.invalidateQueries({ queryKey: ['svc-events', contractId] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const resolve = useMutation({
    mutationFn: (id: number) => api(`/api/service/events/${id}/resolve`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => {
      notifySuccess(t('crm.svc_resolved_ok'));
      qc.invalidateQueries({ queryKey: ['svc-events', contractId] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const events = q.data?.events ?? [];
  const breaches = events.filter((e) => e.response_breached || e.resolution_breached).length;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {t('crm.sla_events_title', { id: contractId })}
          {breaches > 0 && (
            <Badge variant="destructive" className="gap-1">
              <AlertTriangle className="size-3.5" /> {t('crm.sla_breach_count', { n: num(breaches) })}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Log event */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid grow gap-2">
            <Label htmlFor="ev-title">{t('crm.event_title_label')}</Label>
            <Input id="ev-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('crm.event_title_placeholder')} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ev-pri">{t('crm.priority')}</Label>
            <Select id="ev-pri"  value={priority} onChange={(e) => setPriority(e.target.value)}>
              {['P1', 'P2', 'P3', 'P4'].map((p) => <option key={p} value={p}>{p}</option>)}
            </Select>
          </div>
          <Button disabled={log.isPending || !title.trim()} onClick={() => log.mutate()}>
            <Plus className="size-4" /> {t('crm.log_event')}
          </Button>
        </div>

        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={events}
              emptyState={{ icon: ClipboardList, title: t('crm.no_events_title'), description: t('crm.no_events_desc') }}
              columns={[
                { key: 'event_no', label: t('dash.col_no') },
                { key: 'title', label: t('crm.subject') },
                { key: 'priority', label: t('crm.priority'), render: (r: SlaEvent) => <Badge variant={statusVariant(r.priority)}>{r.priority}</Badge> },
                { key: 'opened_at', label: t('crm.opened_at'), render: (r: SlaEvent) => thaiDate(r.opened_at) },
                { key: 'status', label: t('fin.col_status'), render: (r: SlaEvent) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                {
                  key: 'response_breached',
                  label: t('crm.response_sla'),
                  render: (r: SlaEvent) => (
                    <Badge variant={r.response_breached ? 'destructive' : 'success'}>{r.response_breached ? t('crm.sla_breached') : t('crm.sla_within')}</Badge>
                  ),
                },
                {
                  key: 'resolution_breached',
                  label: t('crm.resolution_sla'),
                  render: (r: SlaEvent) => (
                    <Badge variant={r.resolution_breached ? 'destructive' : 'success'}>{r.resolution_breached ? t('crm.sla_breached') : t('crm.sla_within')}</Badge>
                  ),
                },
                {
                  key: 'resolve',
                  label: '',
                  align: 'right',
                  render: (r: SlaEvent) =>
                    r.status === 'Resolved' ? null : (
                      <Button size="sm" variant="outline" disabled={resolve.isPending} onClick={() => resolve.mutate(r.id)}>
                        {t('crm.svc_resolve')}
                      </Button>
                    ),
                },
              ]}
            />
          )}
        </StateView>
      </CardContent>
    </Card>
  );
}

interface Invoice { id: number; invoice_no: string; billing_period: string; amount: number; status: string; due_date: string | null }

function Subscriptions() {
  const { t } = useLang();
  const qc = useQueryClient();
  // list endpoint returns rows under `subscriptions`
  const q = useQuery<{ subscriptions: Sub[]; count: number }>({ queryKey: ['svc-subs'], queryFn: () => api('/api/service/subscriptions') });
  const subs = q.data?.subscriptions ?? [];
  const mrr = subs.reduce((s, x) => s + (x.status === 'Active' ? x.unit_price * x.qty : 0), 0);

  // Create-subscription form state
  const [customerName, setCustomerName] = useState('');
  const [productCode, setProductCode] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [qty, setQty] = useState('1');
  const [cycle, setCycle] = useState('monthly');
  const [startDate, setStartDate] = useState('2026-01-01');

  const [cancelTarget, setCancelTarget] = useState<Sub | null>(null);
  const [invoicesOf, setInvoicesOf] = useState<Sub | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api('/api/service/subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: customerName,
          product_code: productCode,
          unit_price: Number(unitPrice) || 0,
          qty: Number(qty) || 1,
          billing_cycle: cycle,
          start_date: startDate,
        }),
      }),
    onSuccess: (r: any) => {
      notifySuccess(t('crm.svc_created_ok', { no: r.sub_no }));
      setCustomerName(''); setProductCode(''); setUnitPrice(''); setQty('1');
      qc.invalidateQueries({ queryKey: ['svc-subs'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'pause' | 'resume' | 'cancel' }) =>
      api(`/api/service/subscriptions/${id}/${action}`, { method: 'POST' }),
    onSuccess: (_r, v) => {
      notifySuccess(t(v.action === 'pause' ? 'crm.svc_paused_ok' : v.action === 'resume' ? 'crm.svc_resumed_ok' : 'crm.svc_cancelled_ok'));
      setCancelTarget(null);
      qc.invalidateQueries({ queryKey: ['svc-subs'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const billing = useMutation({
    mutationFn: () => api('/api/service/billing/run', { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (r: any) => {
      notifySuccess(t('crm.svc_billing_ok', { inv: num(r.invoices_created), subs: num(r.subscriptions_billed) }));
      qc.invalidateQueries({ queryKey: ['svc-subs'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="space-y-5">
      <StateView q={q}>
        {q.data && (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label={t('crm.total_subscriptions')} value={num(subs.length)} tone="primary" />
            <StatCard label={t('crm.active')} value={num(subs.filter((s) => s.status === 'Active').length)} tone="success" />
            <StatCard label={t('crm.revenue_per_cycle_active')} value={baht(mrr)} tone="info" hint="unit_price × qty" />
          </div>
        )}
      </StateView>

      {/* Create subscription */}
      <Card className="max-w-3xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">{t('crm.svc_new_sub')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="sub-cust">{t('crm.svc_f_customer')}</Label>
              <Input id="sub-cust" value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder={t('crm.customer_name_placeholder')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sub-prod">{t('crm.svc_f_product')}</Label>
              <Input id="sub-prod" value={productCode} onChange={(e) => setProductCode(e.target.value)} placeholder="ERP-BASIC" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sub-price">{t('crm.svc_f_price')}</Label>
              <Input id="sub-price" type="number" min="0" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} placeholder="0" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sub-qty">{t('crm.svc_f_qty')}</Label>
              <Input id="sub-qty" type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sub-cycle">{t('crm.svc_f_cycle')}</Label>
              <Select id="sub-cycle" value={cycle} onChange={(e) => setCycle(e.target.value)}>
                {['monthly', 'quarterly', 'annual'].map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sub-start">{t('crm.svc_f_start')}</Label>
              <Input id="sub-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button disabled={create.isPending || !customerName.trim() || !productCode.trim()} onClick={() => create.mutate()}>
              <Plus className="size-4" /> {create.isPending ? t('crm.saving') : t('crm.svc_create_btn')}
            </Button>
            <Button variant="outline" disabled={billing.isPending} onClick={() => billing.mutate()}>
              <Repeat className="size-4" /> {t('crm.svc_run_billing')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={subs}
            emptyState={{ icon: Repeat, title: t('crm.no_subscriptions_title'), description: t('crm.no_subscriptions_desc') }}
            columns={[
              { key: 'sub_no', label: t('dash.col_no') },
              { key: 'customer_name', label: t('fin.col_customer') },
              { key: 'product_code', label: t('crm.product') },
              { key: 'billing_cycle', label: t('crm.billing_cycle') },
              { key: 'unit_price', label: t('crm.unit_price'), align: 'right', render: (r: Sub) => <span className="tabular">{baht(r.unit_price)}</span> },
              { key: 'qty', label: t('crm.qty'), align: 'right', render: (r: Sub) => <span className="tabular">{num(r.qty)}</span> },
              { key: 'next_billing_date', label: t('crm.next_billing'), render: (r: Sub) => thaiDate(r.next_billing_date) },
              { key: 'status', label: t('fin.col_status'), render: (r: Sub) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              {
                key: 'actions',
                label: '',
                align: 'right',
                render: (r: Sub) => (
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setInvoicesOf(r)}>{t('crm.svc_invoices')}</Button>
                    {r.status === 'Active' && (
                      <Button size="sm" variant="outline" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ id: r.id, action: 'pause' })}>{t('crm.svc_pause')}</Button>
                    )}
                    {r.status === 'Paused' && (
                      <Button size="sm" variant="outline" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ id: r.id, action: 'resume' })}>{t('crm.svc_resume')}</Button>
                    )}
                    {r.status !== 'Cancelled' && (
                      <Button size="sm" variant="outline" disabled={setStatus.isPending} onClick={() => setCancelTarget(r)}>{t('crm.svc_cancel')}</Button>
                    )}
                  </div>
                ),
              },
            ]}
          />
        )}
      </StateView>

      <ConfirmDialog
        open={cancelTarget != null}
        onOpenChange={(o) => { if (!o) setCancelTarget(null); }}
        title={t('crm.svc_cancel')}
        description={cancelTarget ? t('crm.svc_cancel_confirm', { no: cancelTarget.sub_no }) : ''}
        confirmLabel={t('crm.svc_cancel')}
        busy={setStatus.isPending}
        onConfirm={() => { if (cancelTarget) setStatus.mutate({ id: cancelTarget.id, action: 'cancel' }); }}
      />

      {invoicesOf && <InvoicesDialog sub={invoicesOf} onClose={() => setInvoicesOf(null)} />}
    </div>
  );
}

function InvoicesDialog({ sub, onClose }: { sub: Sub; onClose: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ invoices: Invoice[] }>({ queryKey: ['svc-invoices', sub.id], queryFn: () => api(`/api/service/subscriptions/${sub.id}/invoices`) });
  const invoices = q.data?.invoices ?? [];

  const pay = useMutation({
    mutationFn: (id: number) => api(`/api/service/invoices/${id}/pay`, { method: 'POST' }),
    onSuccess: (r: any) => {
      notifySuccess(t('crm.svc_paid_ok', { no: r.invoice_no }));
      qc.invalidateQueries({ queryKey: ['svc-invoices', sub.id] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('crm.svc_invoices_title', { no: sub.sub_no })}</DialogTitle>
        </DialogHeader>
        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={invoices}
              emptyState={{ icon: ClipboardList, title: t('crm.svc_invoices'), description: t('crm.svc_no_invoices') }}
              columns={[
                { key: 'invoice_no', label: t('dash.col_no') },
                { key: 'billing_period', label: t('crm.svc_inv_period') },
                { key: 'amount', label: t('crm.unit_price'), align: 'right', render: (r: Invoice) => <span className="tabular">{baht(r.amount)}</span> },
                { key: 'due_date', label: t('crm.svc_inv_due'), render: (r: Invoice) => thaiDate(r.due_date) },
                { key: 'status', label: t('fin.col_status'), render: (r: Invoice) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                {
                  key: 'pay',
                  label: '',
                  align: 'right',
                  render: (r: Invoice) =>
                    r.status === 'Paid' ? null : (
                      <Button size="sm" variant="outline" disabled={pay.isPending} onClick={() => pay.mutate(r.id)}>{t('crm.svc_pay')}</Button>
                    ),
                },
              ]}
            />
          )}
        </StateView>
      </DialogContent>
    </Dialog>
  );
}
