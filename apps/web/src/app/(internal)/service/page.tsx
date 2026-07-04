'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, AlertTriangle, ShieldCheck, ClipboardList, Repeat } from 'lucide-react';
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

// GET /api/service/contracts → { contracts: [...], count }
interface Contract { id: number; contract_no: string; customer_name: string; sla_tier: string; response_hours: number; resolution_hours: number; start_date: string | null; end_date: string | null; status: string; monthly_value: number }
// GET /api/service/subscriptions → { subscriptions: [...], count }
interface Sub { id: number; sub_no: string; customer_name: string; product_code: string; billing_cycle: string; unit_price: number; qty: number; next_billing_date: string | null; status: string }
// GET /api/service/contracts/:id/events → { events: [...], count }
interface SlaEvent { id: number; event_no: string; title: string; priority: string; opened_at: string | null; response_due_at: string | null; responded_at: string | null; resolved_at: string | null; resolution_due_at: string | null; response_breached: boolean; resolution_breached: boolean; status: string }

const selectCls =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

export default function ServicePage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('crm.service_title')} description={t('crm.service_subtitle')} />
      <Tabs
        tabs={[
          { key: 'contracts', label: t('crm.tab_contracts'), content: <Contracts /> },
          { key: 'subs', label: t('crm.tab_subscriptions'), content: <Subscriptions /> },
        ]}
      />
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
              <select id="svc-tier" className={selectCls} value={slaTier} onChange={(e) => setSlaTier(e.target.value)}>
                {['Bronze', 'Silver', 'Gold', 'Platinum'].map((tier) => <option key={tier} value={tier}>{tier}</option>)}
              </select>
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
            <select id="ev-pri" className={selectCls} value={priority} onChange={(e) => setPriority(e.target.value)}>
              {['P1', 'P2', 'P3', 'P4'].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
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
              ]}
            />
          )}
        </StateView>
      </CardContent>
    </Card>
  );
}

function Subscriptions() {
  const { t } = useLang();
  // list endpoint returns rows under `subscriptions`
  const q = useQuery<{ subscriptions: Sub[]; count: number }>({ queryKey: ['svc-subs'], queryFn: () => api('/api/service/subscriptions') });
  const subs = q.data?.subscriptions ?? [];
  const mrr = subs.reduce((s, x) => s + (x.status === 'Active' ? x.unit_price * x.qty : 0), 0);

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
            ]}
          />
        )}
      </StateView>
    </div>
  );
}
