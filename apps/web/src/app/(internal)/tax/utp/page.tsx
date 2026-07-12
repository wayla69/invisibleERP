'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Scale, ShieldAlert, Wallet, Landmark, Gavel } from 'lucide-react';
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

// TAX-12 — ASC 740 income-tax disclosures on top of the deferred-tax engine (TAX-06):
//   • DTA valuation allowance — MLTN recoverability assessment on the gross DTA; maker-checker run → post.
//   • Uncertain Tax Positions (FIN 48) — a memo register with maker-checker create → settle.
export default function TaxUtpPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('fnx.utp.title')} description={t('fnx.utp.subtitle')} />
      <Tabs
        urlParam="tab"
        tabs={[
          { key: 'va', label: t('fnx.utp.tab_va'), content: <ValuationAllowance /> },
          { key: 'utp', label: t('fnx.utp.tab_utp'), content: <UtpRegister /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── DTA valuation allowance ─────────────────────────
function ValuationAllowance() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['tax-va'], queryFn: () => api('/api/tax/valuation-allowance') });
  const [period, setPeriod] = useState(thisMonth());
  const [dtaGross, setDtaGross] = useState('');
  const [mltn, setMltn] = useState('');
  const [basis, setBasis] = useState('');

  const run = useMutation({
    mutationFn: () =>
      api<any>('/api/tax/valuation-allowance/run', {
        method: 'POST',
        body: JSON.stringify({
          period,
          ...(dtaGross ? { dta_gross: Number(dtaGross) } : {}),
          mltn_recoverable: Number(mltn || 0),
          ...(basis ? { basis } : {}),
        }),
      }),
    onSuccess: (r) => {
      notifySuccess(t('fnx.utp.va_run_ok', { period: r.period, allowance: baht(r.allowance) }));
      qc.invalidateQueries({ queryKey: ['tax-va'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const post = useMutation({
    mutationFn: (id: number) => api<any>(`/api/tax/valuation-allowance/${id}/post`, { method: 'POST' }),
    onSuccess: (r) => {
      notifySuccess(r.entry_no
        ? t('fnx.utp.va_post_ok', { period: r.period, entry_no: r.entry_no, delta: baht(r.delta_posted) })
        : t('fnx.utp.va_post_ok_nodelta', { period: r.period }));
      qc.invalidateQueries({ queryKey: ['tax-va'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const validPeriod = /^\d{4}-\d{2}$/.test(period);
  const latest = q.data?.allowances?.[0];

  return (
    <div className="space-y-5">
      <Card className="max-w-3xl gap-4 p-5">
        <h3 className="text-base font-semibold">{t('fnx.utp.va_run_title')}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="va-period">{t('fnx.utp.f_period')}</Label>
            <Input id="va-period" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-07" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="va-mltn">{t('fnx.utp.f_mltn')}</Label>
            <Input id="va-mltn" type="number" step="0.01" min="0" value={mltn} onChange={(e) => setMltn(e.target.value)} placeholder="0.00" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="va-gross">{t('fnx.utp.f_gross')}</Label>
            <Input id="va-gross" type="number" step="0.01" min="0" value={dtaGross} onChange={(e) => setDtaGross(e.target.value)} placeholder={t('fnx.utp.f_gross_ph')} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="va-basis">{t('fnx.utp.f_basis')}</Label>
            <Input id="va-basis" value={basis} onChange={(e) => setBasis(e.target.value)} placeholder={t('fnx.utp.f_basis_ph')} />
          </div>
        </div>
        <div>
          <Button disabled={run.isPending || !validPeriod || !mltn} onClick={() => run.mutate()}>
            <Scale className="size-4" /> {run.isPending ? t('fnx.utp.calculating') : t('fnx.utp.va_calc_btn')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('fnx.utp.va_note')}</p>
      </Card>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            {latest && (
              <div className="grid gap-4 sm:grid-cols-3">
                <StatCard label={t('fnx.utp.stat_gross')} value={baht(latest.dta_gross)} icon={Wallet} tone="primary" hint={t('fnx.utp.period_hint', { period: latest.period })} />
                <StatCard label={t('fnx.utp.stat_mltn')} value={baht(latest.mltn_recoverable)} icon={Landmark} tone="success" />
                <StatCard label={t('fnx.utp.stat_allowance')} value={baht(latest.allowance)} icon={ShieldAlert} tone="danger" />
              </div>
            )}
            <DataTable
              rows={q.data.allowances ?? []}
              rowKey={(r: any) => r.id}
              columns={[
                { key: 'period', label: t('fnx.utp.col_period') },
                { key: 'as_of_date', label: t('fnx.utp.col_asof'), render: (r: any) => thaiDate(r.as_of_date) },
                { key: 'dta_gross', label: t('fnx.utp.col_gross'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.dta_gross)}</span> },
                { key: 'mltn_recoverable', label: t('fnx.utp.col_mltn'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.mltn_recoverable)}</span> },
                { key: 'allowance', label: t('fnx.utp.col_allowance'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.allowance)}</span> },
                { key: 'delta_posted', label: t('fnx.utp.col_delta'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.delta_posted)}</span> },
                { key: 'status', label: t('fin.col_status'), render: (r: any) => r.status === 'Posted' ? <Badge variant="success">{t('fnx.utp.status_posted')}</Badge> : <Badge variant="warning">{t('fnx.utp.status_open')}</Badge> },
                { key: 'run_by', label: t('fnx.utp.col_run_by'), render: (r: any) => r.run_by ?? '—' },
                { key: 'posted_by', label: t('fnx.utp.col_posted_by'), render: (r: any) => r.posted_by ?? '—' },
                { key: 'act', label: '', align: 'right', sortable: false, render: (r: any) => r.status === 'Open' ? (
                  <Button size="sm" disabled={post.isPending} onClick={() => post.mutate(r.id)}>{t('fnx.utp.post_btn')}</Button>
                ) : null },
              ]}
              emptyState={{ icon: Scale, title: t('fnx.utp.va_empty_title'), description: t('fnx.utp.va_empty_desc') }}
            />
            <p className="text-xs text-muted-foreground">{t('fnx.utp.maker_checker_note')}</p>
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── Uncertain Tax Positions (FIN 48) ─────────────────────────
function UtpRegister() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['tax-utp'], queryFn: () => api('/api/tax/utp') });
  const [taxYear, setTaxYear] = useState(String(new Date().getFullYear()));
  const [desc, setDesc] = useState('');
  const [gross, setGross] = useState('');
  const [recognized, setRecognized] = useState('');
  const [intPen, setIntPen] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api<any>('/api/tax/utp', {
        method: 'POST',
        body: JSON.stringify({
          tax_year: Number(taxYear),
          description: desc,
          gross_exposure: Number(gross || 0),
          ...(recognized ? { recognized_benefit: Number(recognized) } : {}),
          ...(intPen ? { interest_penalty: Number(intPen) } : {}),
        }),
      }),
    onSuccess: (r) => {
      notifySuccess(t('fnx.utp.create_ok', { no: r.position_no, reserve: baht(r.reserve) }));
      setDesc(''); setGross(''); setRecognized(''); setIntPen('');
      qc.invalidateQueries({ queryKey: ['tax-utp'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const settle = useMutation({
    mutationFn: (v: { id: number; status: 'Settled' | 'Lapsed' }) =>
      api<any>(`/api/tax/utp/${v.id}/settle`, { method: 'POST', body: JSON.stringify({ status: v.status }) }),
    onSuccess: (r) => {
      notifySuccess(t('fnx.utp.settle_ok', { no: r.position_no, status: r.status }));
      qc.invalidateQueries({ queryKey: ['tax-utp'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const totals = q.data?.totals;
  const canCreate = desc.trim() && gross && Number(taxYear) >= 2000;

  return (
    <div className="space-y-5">
      <Card className="max-w-3xl gap-4 p-5">
        <h3 className="text-base font-semibold">{t('fnx.utp.create_title')}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="utp-year">{t('fnx.utp.f_tax_year')}</Label>
            <Input id="utp-year" type="number" value={taxYear} onChange={(e) => setTaxYear(e.target.value)} placeholder="2026" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="utp-gross">{t('fnx.utp.f_gross_exposure')}</Label>
            <Input id="utp-gross" type="number" step="0.01" min="0" value={gross} onChange={(e) => setGross(e.target.value)} placeholder="0.00" />
          </div>
          <div className="grid gap-2 sm:col-span-2">
            <Label htmlFor="utp-desc">{t('fnx.utp.f_description')}</Label>
            <Input id="utp-desc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={t('fnx.utp.f_description_ph')} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="utp-recognized">{t('fnx.utp.f_recognized')}</Label>
            <Input id="utp-recognized" type="number" step="0.01" min="0" value={recognized} onChange={(e) => setRecognized(e.target.value)} placeholder="0.00" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="utp-int">{t('fnx.utp.f_interest_penalty')}</Label>
            <Input id="utp-int" type="number" step="0.01" min="0" value={intPen} onChange={(e) => setIntPen(e.target.value)} placeholder="0.00" />
          </div>
        </div>
        <div>
          <Button disabled={create.isPending || !canCreate} onClick={() => create.mutate()}>
            <ShieldAlert className="size-4" /> {t('fnx.utp.create_btn')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('fnx.utp.reserve_note')}</p>
      </Card>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            {totals && (
              <div className="grid gap-4 sm:grid-cols-3">
                <StatCard label={t('fnx.utp.stat_exposure')} value={baht(totals.gross_exposure)} icon={Gavel} tone="primary" />
                <StatCard label={t('fnx.utp.stat_recognized')} value={baht(totals.recognized_benefit)} icon={Wallet} tone="success" />
                <StatCard label={t('fnx.utp.stat_reserve')} value={baht(totals.reserve)} icon={ShieldAlert} tone="danger" hint={t('fnx.utp.reserve_hint')} />
              </div>
            )}
            <DataTable
              rows={q.data.positions ?? []}
              rowKey={(r: any) => r.id}
              columns={[
                { key: 'position_no', label: t('fnx.utp.col_no') },
                { key: 'tax_year', label: t('fnx.utp.col_tax_year') },
                { key: 'description', label: t('fnx.utp.col_desc') },
                { key: 'gross_exposure', label: t('fnx.utp.col_exposure'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.gross_exposure)}</span> },
                { key: 'recognized_benefit', label: t('fnx.utp.col_recognized'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.recognized_benefit)}</span> },
                { key: 'reserve', label: t('fnx.utp.col_reserve'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.reserve)}</span> },
                { key: 'interest_penalty', label: t('fnx.utp.col_int'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.interest_penalty)}</span> },
                { key: 'status', label: t('fin.col_status'), render: (r: any) => (
                  <Badge variant={r.status === 'Open' ? 'warning' : r.status === 'Settled' ? 'success' : 'secondary'}>
                    {r.status === 'Open' ? t('fnx.utp.utp_open') : r.status === 'Settled' ? t('fnx.utp.utp_settled') : t('fnx.utp.utp_lapsed')}
                  </Badge>
                ) },
                { key: 'created_by', label: t('fnx.utp.col_created_by'), render: (r: any) => r.created_by ?? '—' },
                { key: 'settled_by', label: t('fnx.utp.col_settled_by'), render: (r: any) => r.settled_by ?? '—' },
                { key: 'act', label: '', align: 'right', sortable: false, render: (r: any) => r.status === 'Open' ? (
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" disabled={settle.isPending} onClick={() => settle.mutate({ id: r.id, status: 'Settled' })}>{t('fnx.utp.settle_btn')}</Button>
                    <Button size="sm" variant="ghost" disabled={settle.isPending} onClick={() => settle.mutate({ id: r.id, status: 'Lapsed' })}>{t('fnx.utp.lapse_btn')}</Button>
                  </div>
                ) : null },
              ]}
              emptyState={{ icon: ShieldAlert, title: t('fnx.utp.utp_empty_title'), description: t('fnx.utp.utp_empty_desc') }}
            />
            <p className="text-xs text-muted-foreground">{t('fnx.utp.settle_maker_checker')}</p>
          </div>
        )}
      </StateView>
    </div>
  );
}
