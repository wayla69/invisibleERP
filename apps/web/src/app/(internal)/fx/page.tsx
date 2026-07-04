'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Coins, Plus, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useLang } from '@/lib/i18n';

const today = () => new Date().toISOString().slice(0, 10);

export default function FxPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('fnx.fx.title')}
        description={t('fnx.fx.subtitle')}
      />
      <Tabs
        tabs={[
          { key: 'rates', label: t('fnx.fx.tab_rates'), content: <Rates /> },
          { key: 'revalue', label: t('fnx.fx.tab_revalue'), content: <Revalue /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── rate table + add/update form ─────────────────────────
function Rates() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['fx-rates'], queryFn: () => api('/api/fx/rates') });

  const [currency, setCurrency] = useState('USD');
  const [rateDate, setRateDate] = useState(today());
  const [rate, setRate] = useState('');
  const [shared, setShared] = useState(false);

  const setRateMut = useMutation({
    mutationFn: () =>
      api<any>('/api/fx/rates', {
        method: 'POST',
        body: JSON.stringify({ currency: currency.toUpperCase(), rate_date: rateDate, rate: Number(rate), shared }),
      }),
    onSuccess: (r) => {
      notifySuccess(r.status === 'PendingApproval'
        ? t('fnx.fx.rate_pending', { currency: r.currency, rate: num(r.rate) })
        : t('fnx.fx.rate_saved', { currency: r.currency, rate: num(r.rate), date: r.rate_date }));
      setRate('');
      qc.invalidateQueries({ queryKey: ['fx-rates'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  // FX-04 maker-checker: approve/reject a pending manual rate (must be a different user from the requester).
  const decide = useMutation({
    mutationFn: ({ r, action }: { r: any; action: 'approve' | 'reject' }) =>
      api<any>(`/api/fx/rates/${action}`, { method: 'POST', body: JSON.stringify({ currency: r.currency, rate_date: r.rate_date, shared: r.tenant_id == null }) }),
    onSuccess: (_r, v) => { notifySuccess(v.action === 'approve' ? t('fnx.fx.rate_approved') : t('fnx.fx.rate_rejected')); qc.invalidateQueries({ queryKey: ['fx-rates'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="space-y-5">
      <Card className="max-w-3xl gap-4 p-5">
        <h3 className="text-base font-semibold">{t('fnx.fx.add_card_title')}</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-2">
            <Label htmlFor="fx-ccy">{t('fnx.fx.field_currency')}</Label>
            <Input id="fx-ccy" maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder="USD" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="fx-date">{t('dash.col_date')}</Label>
            <Input id="fx-date" type="date" value={rateDate} onChange={(e) => setRateDate(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="fx-rate">{t('fnx.fx.field_rate')}</Label>
            <Input id="fx-rate" type="number" step="0.0001" min="0" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="35.5" />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} className="size-4 rounded border-input" />
          {t('fnx.fx.shared_all')}
        </label>
        <div>
          <Button disabled={setRateMut.isPending || currency.length !== 3 || !rate} onClick={() => setRateMut.mutate()}>
            <Plus className="size-4" /> {setRateMut.isPending ? t('fnx.fx.saving') : t('fnx.fx.save_rate')}
          </Button>
        </div>
      </Card>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <StatCard label={t('fnx.fx.stat_rate_count')} value={num(q.data.count)} icon={Coins} tone="primary" className="max-w-xs" />
            <DataTable
              rows={q.data.rates}
              columns={[
                { key: 'currency', label: t('fnx.fx.field_currency') },
                { key: 'rate_date', label: t('dash.col_date'), render: (r: any) => thaiDate(r.rate_date) },
                { key: 'rate', label: t('fnx.fx.field_rate'), align: 'right', render: (r: any) => <span className="tabular">{num(r.rate)}</span> },
                { key: 'tenant_id', label: t('fnx.fx.col_scope'), render: (r: any) => (r.tenant_id == null ? t('fnx.fx.scope_shared') : t('fnx.fx.scope_store', { id: r.tenant_id })) },
                { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={r.status === 'Approved' ? 'success' : r.status === 'PendingApproval' ? 'warning' : 'destructive'}>{r.status === 'Approved' ? t('fin.approved') : r.status === 'PendingApproval' ? t('fin.pending') : t('fnx.fx.status_rejected')}</Badge> },
                { key: 'act', label: '', align: 'right', render: (r: any) => r.status === 'PendingApproval' ? (
                  <div className="flex justify-end gap-1">
                    <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ r, action: 'approve' })}>{t('fin.approve')}</Button>
                    <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ r, action: 'reject' })}>{t('fnx.fx.reject')}</Button>
                  </div>
                ) : null },
              ]}
              emptyState={{
                icon: Coins,
                title: t('fnx.fx.empty_title'),
                description: t('fnx.fx.empty_desc'),
              }}
            />
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── unrealized report + revaluation action ─────────────────────────
function Revalue() {
  const { t } = useLang();
  const [asOf, setAsOf] = useState(today());
  const [currency, setCurrency] = useState('USD');
  const [autoReverse, setAutoReverse] = useState(true);

  const report = useQuery<any>({
    queryKey: ['fx-unrealized', asOf, currency],
    queryFn: () => api(`/api/fx/unrealized?as_of=${asOf}${currency ? `&currency=${currency.toUpperCase()}` : ''}`),
  });

  const revalue = useMutation({
    mutationFn: () =>
      api<any>('/api/fx/revalue', {
        method: 'POST',
        body: JSON.stringify({ as_of: asOf, currency: currency.toUpperCase(), auto_reverse: autoReverse }),
      }),
    onSuccess: (r) => {
      if (r.already) notifySuccess(t('fnx.fx.reval_already', { currency: r.currency, as_of: r.as_of }));
      else if (!r.entry_no) notifySuccess(r.note ?? t('fnx.fx.no_fx_balance'));
      else notifySuccess(t('fnx.fx.reval_success', { currency: r.currency, rate: num(r.current_rate), entry_no: r.entry_no }) + (r.reverse_entry_no ? t('fnx.fx.reval_reverse_suffix', { reverse_entry_no: r.reverse_entry_no }) : ''));
      report.refetch();
    },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="space-y-5">
      <Card className="gap-4 p-5">
        <h3 className="text-base font-semibold">{t('fnx.fx.reval_card_title')}</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-2">
            <Label htmlFor="rev-asof">{t('fnx.fx.field_asof')}</Label>
            <Input id="rev-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="rev-ccy">{t('fnx.fx.field_currency')}</Label>
            <Input id="rev-ccy" maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder="USD" />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={autoReverse} onChange={(e) => setAutoReverse(e.target.checked)} className="size-4 rounded border-input" />
          {t('fnx.fx.auto_reverse')}
        </label>
        <div>
          <Button disabled={revalue.isPending || currency.length !== 3} onClick={() => revalue.mutate()}>
            <RefreshCw className="size-4" /> {revalue.isPending ? t('fnx.fx.revaluing') : t('fnx.fx.reval_btn')}
          </Button>
        </div>
      </Card>

      <StateView q={report}>
        {report.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label={t('fnx.fx.stat_ar_delta')} value={baht(report.data.totals?.ar_delta)} tone={Number(report.data.totals?.ar_delta) >= 0 ? 'success' : 'danger'} />
              <StatCard label={t('fnx.fx.stat_ap_delta')} value={baht(report.data.totals?.ap_delta)} tone={Number(report.data.totals?.ap_delta) >= 0 ? 'success' : 'danger'} />
              <StatCard label={t('fnx.fx.stat_net_delta')} value={baht(report.data.totals?.net_delta)} tone={Number(report.data.totals?.net_delta) >= 0 ? 'success' : 'danger'} />
            </div>

            <div>
              <h4 className="mb-3 text-sm font-semibold text-muted-foreground">{t('fnx.fx.ar_title')}</h4>
              <DataTable
                rows={report.data.ar ?? []}
                columns={fxRowColumns(t)}
                emptyState={{ title: t('fnx.fx.empty_ar') }}
                dense
              />
            </div>
            <div>
              <h4 className="mb-3 text-sm font-semibold text-muted-foreground">{t('fnx.fx.ap_title')}</h4>
              <DataTable
                rows={report.data.ap ?? []}
                columns={fxRowColumns(t)}
                emptyState={{ title: t('fnx.fx.empty_ap') }}
                dense
              />
            </div>
          </div>
        )}
      </StateView>
    </div>
  );
}

const fxRowColumns = (t: (key: string) => string) => [
  { key: 'doc_no', label: t('fnx.fx.col_doc_no') },
  { key: 'currency', label: t('fnx.fx.col_ccy') },
  { key: 'open_foreign', label: t('fnx.fx.col_open_foreign'), align: 'right' as const, render: (r: any) => <span className="tabular">{num(r.open_foreign)}</span> },
  { key: 'booked_rate', label: t('fnx.fx.col_booked_rate'), align: 'right' as const, render: (r: any) => <span className="tabular">{num(r.booked_rate)}</span> },
  { key: 'current_rate', label: t('fnx.fx.col_current_rate'), align: 'right' as const, render: (r: any) => <span className="tabular">{num(r.current_rate)}</span> },
  { key: 'booked_thb', label: t('fnx.fx.col_booked_thb'), align: 'right' as const, render: (r: any) => <span className="tabular">{baht(r.booked_thb)}</span> },
  { key: 'current_thb', label: t('fnx.fx.col_current_thb'), align: 'right' as const, render: (r: any) => <span className="tabular">{baht(r.current_thb)}</span> },
  { key: 'delta', label: t('fnx.fx.col_delta'), align: 'right' as const, render: (r: any) => <span className="tabular">{baht(r.delta)}</span> },
];
