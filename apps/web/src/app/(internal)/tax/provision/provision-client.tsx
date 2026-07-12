'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Calculator, Landmark, Scale, Wallet, Percent, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, pct } from '@/lib/format';
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
const ratePct = (v: unknown) => pct(Number(v ?? 0) * 100, 2);

function statusBadge(status: string, t: (key: string) => string) {
  return status === 'Posted'
    ? <Badge variant="success">{t('fnx.citprov.status_posted')}</Badge>
    : <Badge variant="warning">{t('fnx.citprov.status_open')}</Badge>;
}

// TAX-11 — current income-tax provision → review → post + ETR reconciliation. runProvision stages an 'Open'
// row (pretax → taxable → current CIT, reusing the deferred-tax temporary adjustment); posting is
// maker-checker (poster ≠ runner, enforced server-side) and books Dr 5960 / Cr 2110.
export default function IncomeTaxProvisionWorkspace({ initialList }: { initialList?: any }) {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('fnx.citprov.title')} description={t('fnx.citprov.subtitle')} />
      <Tabs
        urlParam="tab"
        tabs={[
          { key: 'review', label: t('fnx.citprov.tab_review'), content: <ProvisionList initialList={initialList} /> },
          { key: 'run', label: t('fnx.citprov.tab_run'), content: <RunForm /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── staged provisions table + maker-checker post ─────────────────────────
function ProvisionList({ initialList }: { initialList?: any }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['tax-provision'], queryFn: () => api('/api/tax/provision'), initialData: initialList });

  const post = useMutation({
    mutationFn: (id: number) => api<any>(`/api/tax/provision/${id}/post`, { method: 'POST' }),
    onSuccess: (r) => {
      notifySuccess(r.posted_entry_id
        ? t('fnx.citprov.post_success', { period: r.period, entry_no: r.posted_entry_id, tax: baht(r.current_tax) })
        : t('fnx.citprov.post_success_nozero', { period: r.period }));
      qc.invalidateQueries({ queryKey: ['tax-provision'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const latest = q.data?.provisions?.[0];

  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          {latest && (
            <div className="grid gap-4 sm:grid-cols-4">
              <StatCard label={t('fnx.citprov.stat_pretax')} value={baht(latest.pretax_book_income)} icon={Wallet} tone="primary" hint={t('fnx.citprov.period_hint', { period: latest.period })} />
              <StatCard label={t('fnx.citprov.stat_taxable')} value={baht(latest.taxable_income)} icon={Scale} tone="warning" />
              <StatCard label={t('fnx.citprov.stat_current')} value={baht(latest.current_tax)} icon={Landmark} tone="danger" hint={statusBadge(latest.status, t)} />
              <StatCard label={t('fnx.citprov.stat_etr')} value={ratePct(latest.effective_rate)} icon={Percent} tone="success" />
            </div>
          )}

          <DataTable
            rows={q.data.provisions ?? []}
            rowKey={(r: any) => r.id}
            columns={[
              { key: 'period', label: t('fnx.citprov.col_period') },
              { key: 'pretax_book_income', label: t('fnx.citprov.col_pretax'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.pretax_book_income)}</span> },
              { key: 'taxable_income', label: t('fnx.citprov.col_taxable'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.taxable_income)}</span> },
              { key: 'statutory_rate', label: t('fnx.citprov.col_rate'), align: 'right', render: (r: any) => <span className="tabular">{ratePct(r.statutory_rate)}</span> },
              { key: 'current_tax', label: t('fnx.citprov.col_current'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.current_tax)}</span> },
              { key: 'total_provision', label: t('fnx.citprov.col_total'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.total_provision)}</span> },
              { key: 'effective_rate', label: t('fnx.citprov.col_etr'), align: 'right', render: (r: any) => <span className="tabular">{ratePct(r.effective_rate)}</span> },
              { key: 'status', label: t('fin.col_status'), render: (r: any) => statusBadge(r.status, t) },
              { key: 'run_by', label: t('fnx.citprov.col_run_by'), render: (r: any) => r.run_by ?? '—' },
              { key: 'posted_by', label: t('fnx.citprov.col_posted_by'), render: (r: any) => r.posted_by ?? '—' },
              { key: 'act', label: '', align: 'right', sortable: false, render: (r: any) => r.status === 'Open' ? (
                <Button size="sm" disabled={post.isPending} onClick={() => post.mutate(r.id)}>{t('fnx.citprov.post_btn')}</Button>
              ) : null },
            ]}
            emptyState={{ icon: Calculator, title: t('fnx.citprov.empty_title'), description: t('fnx.citprov.empty_desc') }}
          />
          <p className="text-xs text-muted-foreground">{t('fnx.citprov.maker_checker_note')}</p>
        </div>
      )}
    </StateView>
  );
}

// ───────────────────────── compute (run) form + book→taxable bridge + ETR schedule ─────────────────────────
type PermRow = { name: string; amount: string };

function RunForm() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [period, setPeriod] = useState(thisMonth());
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rate, setRate] = useState('');
  const [perms, setPerms] = useState<PermRow[]>([{ name: '', amount: '' }]);
  const [result, setResult] = useState<any>(null);

  const run = useMutation({
    mutationFn: () => {
      const permanent_diffs = perms
        .filter((p) => p.name.trim() && p.amount.trim() && !Number.isNaN(Number(p.amount)))
        .map((p) => ({ name: p.name.trim(), amount: Number(p.amount) }));
      return api<any>('/api/tax/provision/run', {
        method: 'POST',
        body: JSON.stringify({
          period,
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          ...(rate ? { statutory_rate: Number(rate) } : {}),
          ...(permanent_diffs.length ? { permanent_diffs } : {}),
        }),
      });
    },
    onSuccess: (r) => {
      setResult(r);
      notifySuccess(t('fnx.citprov.run_success', { period: r.period, taxable: baht(r.taxable_income), tax: baht(r.current_tax) }));
      qc.invalidateQueries({ queryKey: ['tax-provision'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const validPeriod = /^\d{4}-\d{2}$/.test(period);
  const setPerm = (i: number, patch: Partial<PermRow>) => setPerms((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-5">
      <Card className="max-w-3xl gap-4 p-5">
        <h3 className="text-base font-semibold">{t('fnx.citprov.run_card_title')}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="cp-period">{t('fnx.citprov.field_period')}</Label>
            <Input id="cp-period" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-12" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cp-rate">{t('fnx.citprov.field_rate')}</Label>
            <Input id="cp-rate" type="number" step="0.01" min="0" max="1" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="0.20" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cp-from">{t('fnx.citprov.field_from')}</Label>
            <Input id="cp-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cp-to">{t('fnx.citprov.field_to')}</Label>
            <Input id="cp-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>

        <div className="space-y-2">
          <Label>{t('fnx.citprov.field_perm_name')}</Label>
          {perms.map((p, i) => (
            <div key={i} className="flex gap-2">
              <Input value={p.name} onChange={(e) => setPerm(i, { name: e.target.value })} placeholder={t('fnx.citprov.field_perm_name')} />
              <Input className="max-w-40" type="number" step="0.01" value={p.amount} onChange={(e) => setPerm(i, { amount: e.target.value })} placeholder={t('fnx.citprov.field_perm_amount')} />
              <Button variant="ghost" size="icon" type="button" onClick={() => setPerms((rows) => rows.filter((_, j) => j !== i))} aria-label="remove"><Trash2 className="size-4" /></Button>
            </div>
          ))}
          <Button variant="outline" size="sm" type="button" onClick={() => setPerms((rows) => [...rows, { name: '', amount: '' }])}><Plus className="size-4" /> {t('fnx.citprov.add_perm')}</Button>
        </div>

        <div>
          <Button disabled={run.isPending || !validPeriod} onClick={() => run.mutate()}>
            <Calculator className="size-4" /> {run.isPending ? t('fnx.citprov.calculating') : t('fnx.citprov.calc_btn')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('fnx.citprov.run_note')}</p>
      </Card>

      {result && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-4">
            <StatCard label={t('fnx.citprov.stat_taxable')} value={baht(result.taxable_income)} tone="warning" />
            <StatCard label={t('fnx.citprov.stat_current')} value={baht(result.current_tax)} tone="danger" />
            <StatCard label={t('fnx.citprov.stat_total')} value={baht(result.total_provision)} tone="primary" />
            <StatCard label={t('fnx.citprov.stat_etr')} value={ratePct(result.effective_rate)} tone="success" />
          </div>

          <Card className="max-w-2xl gap-2 p-5">
            <h4 className="mb-2 text-sm font-semibold text-muted-foreground">{t('fnx.citprov.bridge_title')}</h4>
            <BridgeRow label={t('fnx.citprov.bridge_pretax')} value={result.pretax_book_income} />
            <BridgeRow label={t('fnx.citprov.bridge_perm')} value={result.permanent_adj_total} signed />
            <BridgeRow label={t('fnx.citprov.bridge_temp')} value={result.temporary_adj_total} signed />
            <div className="my-1 border-t" />
            <BridgeRow label={t('fnx.citprov.bridge_taxable')} value={result.taxable_income} bold />
            <BridgeRow label={t('fnx.citprov.bridge_current')} value={result.current_tax} bold />
          </Card>

          <div>
            <h4 className="mb-3 text-sm font-semibold text-muted-foreground">{t('fnx.citprov.etr_title')}</h4>
            <DataTable
              rows={result.etr_lines ?? []}
              columns={[
                { key: 'label', label: t('fnx.citprov.etr_col_item') },
                { key: 'tax_effect', label: t('fnx.citprov.etr_col_effect'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.tax_effect)}</span> },
                { key: 'pct', label: t('fnx.citprov.etr_col_pct'), align: 'right', render: (r: any) => <span className="tabular">{ratePct(r.pct)}</span> },
              ]}
              emptyState={{ title: t('fnx.citprov.empty_title') }}
              dense
            />
          </div>
        </div>
      )}
    </div>
  );
}

function BridgeRow({ label, value, signed, bold }: { label: string; value: unknown; signed?: boolean; bold?: boolean }) {
  const num = Number(value ?? 0);
  const display = signed && num > 0 ? `+${baht(num)}` : baht(num);
  return (
    <div className={`flex items-center justify-between text-sm ${bold ? 'font-semibold' : ''}`}>
      <span className={bold ? '' : 'text-muted-foreground'}>{label}</span>
      <span className="tabular">{display}</span>
    </div>
  );
}
