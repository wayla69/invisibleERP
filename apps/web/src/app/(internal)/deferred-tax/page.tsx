'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Calculator, Landmark, Scale, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
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

const thisMonth = () => new Date().toISOString().slice(0, 7);
const pct = (v: unknown) => `${(Number(v ?? 0) * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

function statusBadge(status: string, t: (key: string) => string) {
  return status === 'Posted'
    ? <Badge variant="success">{t('fnx.dtax.status_posted')}</Badge>
    : <Badge variant="warning">{t('fnx.dtax.status_open')}</Badge>;
}

// TAS 12 / TAX-06 — deferred tax run → review → post. runDeferredTax stages an 'Open' run (DTA/DTL from
// book-vs-tax temporary differences); posting is maker-checker (poster ≠ runner, enforced server-side).
export default function DeferredTaxPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('fnx.dtax.title')}
        description={t('fnx.dtax.subtitle')}
      />
      <Tabs
        urlParam="tab"
        tabs={[
          { key: 'review', label: t('fnx.dtax.tab_review'), content: <RunsList /> },
          { key: 'run', label: t('fnx.dtax.tab_run'), content: <RunForm /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── staged runs table + maker-checker post ─────────────────────────
function RunsList() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['deferred-tax'], queryFn: () => api('/api/ledger/deferred-tax') });

  const post = useMutation({
    mutationFn: (id: number) => api<any>(`/api/ledger/deferred-tax/${id}/post`, { method: 'POST' }),
    onSuccess: (r) => {
      notifySuccess(r.entry_no
        ? t('fnx.dtax.post_success', { period: r.period, entry_no: r.entry_no, delta: baht(r.delta_posted) })
        : t('fnx.dtax.post_success_nodelta', { period: r.period }));
      qc.invalidateQueries({ queryKey: ['deferred-tax'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const latest = q.data?.runs?.[0];

  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          {latest && (
            <div className="grid gap-4 sm:grid-cols-4">
              <StatCard label={t('fnx.dtax.stat_dta')} value={baht(latest.dta)} icon={Wallet} tone="success" hint={t('fnx.dtax.period_hint', { period: latest.period })} />
              <StatCard label={t('fnx.dtax.stat_dtl')} value={baht(latest.dtl)} icon={Scale} tone="danger" />
              <StatCard label={t('fnx.dtax.stat_net')} value={baht(latest.net_deferred)} icon={Landmark} tone={Number(latest.net_deferred) >= 0 ? 'primary' : 'warning'} />
              <StatCard label={t('fnx.dtax.stat_delta')} value={baht(latest.delta_posted)} icon={Calculator} tone={Number(latest.delta_posted) >= 0 ? 'success' : 'danger'} hint={statusBadge(latest.status, t)} />
            </div>
          )}

          <DataTable
            rows={q.data.runs ?? []}
            rowKey={(r: any) => r.id}
            columns={[
              { key: 'period', label: t('fnx.dtax.col_period') },
              { key: 'as_of_date', label: t('fnx.dtax.col_asof'), render: (r: any) => thaiDate(r.as_of_date) },
              { key: 'tax_rate', label: t('fnx.dtax.col_tax_rate'), align: 'right', render: (r: any) => <span className="tabular">{pct(r.tax_rate)}</span> },
              { key: 'dta', label: 'DTA', align: 'right', render: (r: any) => <span className="tabular">{baht(r.dta)}</span> },
              { key: 'dtl', label: 'DTL', align: 'right', render: (r: any) => <span className="tabular">{baht(r.dtl)}</span> },
              { key: 'net_deferred', label: t('fnx.dtax.col_net'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.net_deferred)}</span> },
              { key: 'delta_posted', label: t('fnx.dtax.col_delta'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.delta_posted)}</span> },
              { key: 'status', label: t('fin.col_status'), render: (r: any) => statusBadge(r.status, t) },
              { key: 'run_by', label: t('fnx.dtax.col_run_by'), render: (r: any) => r.run_by ?? '—' },
              { key: 'posted_by', label: t('fnx.dtax.col_posted_by'), render: (r: any) => r.posted_by ?? '—' },
              { key: 'act', label: '', align: 'right', sortable: false, render: (r: any) => r.status === 'Open' ? (
                <Button size="sm" disabled={post.isPending} onClick={() => post.mutate(r.id)}>{t('fnx.dtax.post_btn')}</Button>
              ) : null },
            ]}
            emptyState={{
              icon: Calculator,
              title: t('fnx.dtax.empty_title'),
              description: t('fnx.dtax.empty_desc'),
            }}
          />
          <p className="text-xs text-muted-foreground">
            {t('fnx.dtax.maker_checker_note')}
          </p>
        </div>
      )}
    </StateView>
  );
}

// ───────────────────────── compute (run) form ─────────────────────────
function RunForm() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [period, setPeriod] = useState(thisMonth());
  const [asOf, setAsOf] = useState('');
  const [taxRate, setTaxRate] = useState('');
  const [depFactor, setDepFactor] = useState('');
  const [result, setResult] = useState<any>(null);

  const run = useMutation({
    mutationFn: () =>
      api<any>('/api/ledger/deferred-tax/run', {
        method: 'POST',
        body: JSON.stringify({
          period,
          ...(asOf ? { as_of_date: asOf } : {}),
          ...(taxRate ? { tax_rate: Number(taxRate) } : {}),
          ...(depFactor ? { tax_dep_factor: Number(depFactor) } : {}),
        }),
      }),
    onSuccess: (r) => {
      setResult(r);
      notifySuccess(t('fnx.dtax.run_success', { period: r.period, net: baht(r.net_deferred), delta: baht(r.delta_posted) }));
      qc.invalidateQueries({ queryKey: ['deferred-tax'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const validPeriod = /^\d{4}-\d{2}$/.test(period);

  return (
    <div className="space-y-5">
      <Card className="max-w-3xl gap-4 p-5">
        <h3 className="text-base font-semibold">{t('fnx.dtax.run_card_title')}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="dt-period">{t('fnx.dtax.field_period')}</Label>
            <Input id="dt-period" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-07" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="dt-asof">{t('fnx.dtax.field_asof')}</Label>
            <Input id="dt-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="dt-rate">{t('fnx.dtax.field_rate')}</Label>
            <Input id="dt-rate" type="number" step="0.01" min="0" max="1" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} placeholder="0.20" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="dt-depf">{t('fnx.dtax.field_depf')}</Label>
            <Input id="dt-depf" type="number" step="0.1" min="0" value={depFactor} onChange={(e) => setDepFactor(e.target.value)} placeholder="1.5" />
          </div>
        </div>
        <div>
          <Button disabled={run.isPending || !validPeriod} onClick={() => run.mutate()}>
            <Calculator className="size-4" /> {run.isPending ? t('fnx.dtax.calculating') : t('fnx.dtax.calc_btn')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('fnx.dtax.run_note')}
        </p>
      </Card>

      {result && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-4">
            <StatCard label="DTA" value={baht(result.dta)} tone="success" />
            <StatCard label="DTL" value={baht(result.dtl)} tone="danger" />
            <StatCard label={t('fnx.dtax.stat_net')} value={baht(result.net_deferred)} tone="primary" hint={t('fnx.dtax.prior_hint', { prior: baht(result.prior_net) })} />
            <StatCard label={t('fnx.dtax.stat_delta')} value={baht(result.delta_posted)} tone={Number(result.delta_posted) >= 0 ? 'success' : 'danger'} />
          </div>
          <div>
            <h4 className="mb-3 text-sm font-semibold text-muted-foreground">{t('fnx.dtax.temp_diff_title')}</h4>
            <DataTable
              rows={result.temp_differences ?? []}
              columns={[
                { key: 'name', label: t('fnx.dtax.col_item') },
                { key: 'bookBasis', label: t('fnx.dtax.col_book'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.bookBasis)}</span> },
                { key: 'taxBasis', label: t('fnx.dtax.col_tax'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.taxBasis)}</span> },
                { key: 'difference', label: t('fnx.dtax.col_difference'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.difference)}</span> },
                { key: 'dtAssetOrLiab', label: t('fnx.dtax.col_type'), render: (r: any) => <Badge variant={r.dtAssetOrLiab === 'DTA' ? 'success' : 'warning'}>{r.dtAssetOrLiab}</Badge> },
              ]}
              emptyState={{ title: t('fnx.dtax.empty_temp_diff') }}
              dense
            />
          </div>
        </div>
      )}
    </div>
  );
}
