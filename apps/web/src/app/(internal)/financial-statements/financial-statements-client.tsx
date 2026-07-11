'use client';

// งบการเงิน (Financial Statements) — the three primary statements rendered in full, statement-formatted
// detail (account-level line items + subtotals), not just the summary KPIs shown on the /accounting tabs.
// All figures come straight from the posted GL via the existing endpoints:
//   • งบดุล            → GET /api/ledger/balance-sheet?as_of=&ledger=        (now returns per-account `lines`)
//   • งบกำไรขาดทุน     → GET /api/ledger/income-statement?from=&to=&ledger=  (+ /by-branch)
//   • งบกระแสเงินสด    → GET /api/ledger/cash-flow{,-direct,-forecast}
// Read-only; multi-GAAP ledger selectable (TFRS / TAX / IFRS). CSV export per statement.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, ShieldCheck, PlayCircle, Landmark, FileText, Scale } from 'lucide-react';

import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { baht } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/form-controls';
import { GlDimensionFilter, glDimQuery, emptyGlDims, type GlDims } from '@/components/gl-dimension-filter';

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 8) + '01';
const yearStart = () => today().slice(0, 4) + '-01-01';

function downloadCsv(name: string, rows: (string | number)[][]) {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const blob = new Blob(['﻿' + rows.map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function FinancialStatementsClient() {
  const { t } = useLang();
  const [ledger, setLedger] = useState('');
  const ledgersQ = useQuery<any>({ queryKey: ['ledgers'], queryFn: () => api('/api/ledger/ledgers') });
  const ledgers: any[] = ledgersQ.data?.ledgers ?? [];
  const lp = ledger ? `&ledger=${encodeURIComponent(ledger)}` : '';

  const tabs = [
    { key: 'bs', label: t('fnx.fs.tab_bs'), content: <BalanceSheet lp={lp} /> },
    { key: 'pl', label: t('fnx.fs.tab_pl'), content: <IncomeStatement lp={lp} ledger={ledger} /> },
    { key: 'cf', label: t('fnx.fs.tab_cf'), content: <CashFlow lp={lp} /> },
    { key: 'stat', label: t('fnx.fs.tab_stat'), content: <StatutoryPack lp={lp} /> },
  ];

  return (
    <div>
      <PageHeader
        title={t('fnx.fs.title')}
        description={t('fnx.fs.subtitle')}
        actions={
          ledgers.length > 1 ? (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t('fnx.fs.ledger_std')}</span>
              <Select value={ledger} onChange={(e) => setLedger(e.target.value)}>
                {ledgers.map((l) => (
                  <option key={l.code} value={l.is_leading ? '' : l.code}>
                    {l.code}
                    {l.gaap ? ` · ${l.gaap}` : ''}
                  </option>
                ))}
              </Select>
            </label>
          ) : undefined
        }
      />
      <Tabs tabs={tabs} urlParam="tab" />
    </div>
  );
}

// ───────────────────────── งบดุล (Balance Sheet) ─────────────────────────
function BalanceSheet({ lp }: { lp: string }) {
  const { t } = useLang();
  const [asOf, setAsOf] = useState(today());
  const q = useQuery<any>({ queryKey: ['bs', asOf, lp], queryFn: () => api(`/api/ledger/balance-sheet?as_of=${asOf}${lp}`) });
  const d = q.data;

  const sections = useMemo(() => {
    const lines: any[] = d?.lines ?? [];
    const pick = (type: string) => lines.filter((l) => l.account_type === type).sort((a, b) => String(a.account_code).localeCompare(String(b.account_code)));
    return { assets: pick('Asset'), liabilities: pick('Liability'), equity: pick('Equity') };
  }, [d]);

  const Section = ({ title, rows, subtotal, extra }: { title: string; rows: any[]; subtotal: number; extra?: { label: string; amount: number } }) => (
    <Card className="gap-2 p-5">
      <h3 className="text-sm font-semibold text-muted-foreground">{title}</h3>
      {/* Phone-width fallback: a real <table> squeezed to phone width crushes the account-code /
          account-name / amount columns into an unreadable sliver, and the subtotal row loses its
          visual weight. Below `sm` we stack each line as code+name atop its amount instead. */}
      <div className="space-y-1 sm:hidden">
        {rows.map((l) => (
          <div key={l.account_code} className="flex items-baseline justify-between gap-3 py-0.5 text-sm">
            <span className="min-w-0">
              <span className="text-muted-foreground tabular">{l.account_code}</span>{' '}
              {l.account_name ?? l.account_code}
            </span>
            <span className="shrink-0 tabular">{baht(l.balance)}</span>
          </div>
        ))}
        {extra && (
          <div className="flex items-baseline justify-between gap-3 py-0.5 text-sm">
            <span className="italic text-muted-foreground">{extra.label}</span>
            <span className="shrink-0 tabular">{baht(extra.amount)}</span>
          </div>
        )}
        {rows.length === 0 && !extra && (
          <div className="py-2 text-center text-sm text-muted-foreground">{t('fnx.fs.no_rows')}</div>
        )}
        <div className="flex items-baseline justify-between gap-3 border-t pt-1 text-sm font-semibold">
          <span>{t('fnx.fs.total', { name: title })}</span>
          <span className="shrink-0 tabular">{baht(subtotal)}</span>
        </div>
      </div>
      <table className="hidden w-full text-sm sm:table">
        <tbody>
          {rows.map((l) => (
            <tr key={l.account_code}>
              <td className="py-0.5 pr-3 text-muted-foreground tabular">{l.account_code}</td>
              <td className="py-0.5 pr-3">{l.account_name ?? l.account_code}</td>
              <td className="py-0.5 text-right tabular">{baht(l.balance)}</td>
            </tr>
          ))}
          {extra && (
            <tr>
              <td className="py-0.5 pr-3" />
              <td className="py-0.5 pr-3 italic text-muted-foreground">{extra.label}</td>
              <td className="py-0.5 text-right tabular">{baht(extra.amount)}</td>
            </tr>
          )}
          {rows.length === 0 && !extra && (
            <tr>
              <td colSpan={3} className="py-2 text-center text-muted-foreground">{t('fnx.fs.no_rows')}</td>
            </tr>
          )}
          <tr className="border-t font-semibold">
            <td className="py-1" />
            <td className="py-1">{t('fnx.fs.total', { name: title })}</td>
            <td className="py-1 text-right tabular">{baht(subtotal)}</td>
          </tr>
        </tbody>
      </table>
    </Card>
  );

  const exportCsv = () => {
    if (!d) return;
    const rows: (string | number)[][] = [['section', 'code', 'account', 'amount']];
    sections.assets.forEach((l) => rows.push(['Asset', l.account_code, l.account_name, l.balance]));
    sections.liabilities.forEach((l) => rows.push(['Liability', l.account_code, l.account_name, l.balance]));
    sections.equity.forEach((l) => rows.push(['Equity', l.account_code, l.account_name, l.balance]));
    rows.push(['Equity', '', t('fnx.fs.current_pl'), d.net_income]);
    downloadCsv(`balance-sheet-${asOf}.csv`, rows);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid max-w-[200px] gap-1.5">
          <Label htmlFor="bs-asof">{t('fnx.fs.as_of')}</Label>
          <Input id="bs-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </div>
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={!d}>
          <Download className="size-4" /> {t('fnx.fs.export_csv')}
        </Button>
      </div>
      <StateView q={q}>
        {d && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label={t('fnx.fs.bs_assets_total')} value={baht(d.assets)} tone="primary" />
              <StatCard label={t('fnx.fs.bs_liab_total')} value={baht(d.liabilities)} tone="danger" />
              <StatCard label={t('fnx.fs.bs_equity_total')} value={baht(d.equity + d.net_income)} />
              <StatCard
                label={t('fin.col_status')}
                value={<Badge variant={d.balanced ? 'success' : 'destructive'}>{d.balanced ? t('fnx.fs.balanced') : t('fnx.fs.unbalanced')}</Badge>}
              />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <Section title={t('fnx.fs.sec_assets')} rows={sections.assets} subtotal={d.assets} />
              <div className="space-y-4">
                <Section title={t('fnx.fs.sec_liab')} rows={sections.liabilities} subtotal={d.liabilities} />
                <Section
                  title={t('fnx.fs.sec_equity')}
                  rows={sections.equity}
                  extra={{ label: t('fnx.fs.current_pl'), amount: d.net_income }}
                  subtotal={d.equity + d.net_income}
                />
              </div>
            </div>
            <Card className="flex-row flex-wrap items-center gap-2 p-5 text-sm">
              <ShieldCheck className="size-4 text-muted-foreground" />
              {t('fnx.fs.sec_assets')} <span className="tabular">{baht(d.assets)}</span> = {t('fnx.fs.liab_plus_equity')}{' '}
              <span className="tabular">{baht(d.liabilities_plus_equity)}</span>{' '}
              <Badge variant={d.balanced ? 'success' : 'destructive'}>{d.balanced ? t('fnx.fs.balanced') : t('fnx.fs.unbalanced')}</Badge>
            </Card>
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── งบกำไรขาดทุน (Income Statement) ─────────────────────────
function IncomeStatement({ lp, ledger }: { lp: string; ledger: string }) {
  const { t } = useLang();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [byBranch, setByBranch] = useState(false);
  // FIN-7a: optional dimension slice (project / dept / branch / cost centre) on the P&L (not the
  // by-branch grouping view, which already breaks down by branch).
  const [dims, setDims] = useState<GlDims>(emptyGlDims());
  const dq = glDimQuery(dims);

  const q = useQuery<any>({ queryKey: ['pl', from, to, lp, dq], queryFn: () => api(`/api/ledger/income-statement?from=${from}&to=${to}${lp}${dq}`), enabled: !byBranch });
  const branchQ = useQuery<any>({ queryKey: ['pl-branch', from, to], queryFn: () => api(`/api/ledger/income-statement/by-branch?from=${from}&to=${to}`), enabled: byBranch });
  const d = q.data;

  const rev = useMemo(() => (d?.lines ?? []).filter((l: any) => l.account_type === 'Revenue').map((l: any) => ({ ...l, amount: (l.credit ?? 0) - (l.debit ?? 0) })), [d]);
  const exp = useMemo(() => (d?.lines ?? []).filter((l: any) => l.account_type === 'Expense').map((l: any) => ({ ...l, amount: (l.debit ?? 0) - (l.credit ?? 0) })), [d]);

  const exportCsv = () => {
    if (!d) return;
    const rows: (string | number)[][] = [['section', 'code', 'account', 'amount']];
    rev.forEach((l: any) => rows.push(['Revenue', l.account_code, l.account_name, l.amount]));
    exp.forEach((l: any) => rows.push(['Expense', l.account_code, l.account_name, l.amount]));
    rows.push(['', '', t('fnx.fs.net_profit'), d.net_income]);
    downloadCsv(`income-statement-${from}_${to}.csv`, rows);
  };

  const LineTable = ({ title, rows, subtotal, tone }: { title: string; rows: any[]; subtotal: number; tone?: string }) => (
    <Card className="gap-2 p-5">
      <h3 className="text-sm font-semibold text-muted-foreground">{title}</h3>
      <div className="space-y-1 sm:hidden">
        {rows.map((l) => (
          <div key={l.account_code} className="flex items-baseline justify-between gap-3 py-0.5 text-sm">
            <span className="min-w-0">
              <span className="text-muted-foreground tabular">{l.account_code}</span>{' '}
              {l.account_name ?? l.account_code}
            </span>
            <span className="shrink-0 tabular">{baht(l.amount)}</span>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="py-2 text-center text-sm text-muted-foreground">{t('fnx.fs.no_rows')}</div>
        )}
        <div className={`flex items-baseline justify-between gap-3 border-t pt-1 text-sm font-semibold ${tone ?? ''}`}>
          <span>{t('fnx.fs.total', { name: title })}</span>
          <span className="shrink-0 tabular">{baht(subtotal)}</span>
        </div>
      </div>
      <table className="hidden w-full text-sm sm:table">
        <tbody>
          {rows.map((l) => (
            <tr key={l.account_code}>
              <td className="py-0.5 pr-3 text-muted-foreground tabular">{l.account_code}</td>
              <td className="py-0.5 pr-3">{l.account_name ?? l.account_code}</td>
              <td className="py-0.5 text-right tabular">{baht(l.amount)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={3} className="py-2 text-center text-muted-foreground">{t('fnx.fs.no_rows')}</td>
            </tr>
          )}
          <tr className={`border-t font-semibold ${tone ?? ''}`}>
            <td className="py-1" />
            <td className="py-1">{t('fnx.fs.total', { name: title })}</td>
            <td className="py-1 text-right tabular">{baht(subtotal)}</td>
          </tr>
        </tbody>
      </table>
    </Card>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="pl-from">{t('fnx.fs.from')}</Label>
            <Input id="pl-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pl-to">{t('fnx.fs.to')}</Label>
            <Input id="pl-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button variant="ghost" size="sm" onClick={() => setFrom(yearStart())}>{t('fnx.fs.ytd')}</Button>
          {!byBranch && <GlDimensionFilter dims={dims} onChange={setDims} idPrefix="fs-pl" />}
        </div>
        <div className="flex items-center gap-2">
          <Button variant={byBranch ? 'default' : 'outline'} size="sm" onClick={() => setByBranch((v) => !v)} disabled={!!ledger && byBranch}>
            {t('fnx.fs.by_branch')}
          </Button>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={byBranch || !d}>
            <Download className="size-4" /> {t('fnx.fs.export_csv')}
          </Button>
        </div>
      </div>

      {byBranch ? (
        <StateView q={branchQ}>
          {branchQ.data && (
            <div className="grid gap-3">
              {Object.entries(branchQ.data.branches ?? {}).length === 0 && (
                <Card className="p-6 text-center text-sm text-muted-foreground">{t('fnx.fs.branch_empty')}</Card>
              )}
              {Object.entries(branchQ.data.branches ?? {}).map(([key, b]: [string, any]) => (
                <Card key={key} className="gap-2 p-5">
                  <div className="flex items-center justify-between">
                    <strong>{key === 'unassigned' ? t('fnx.fs.unassigned_branch') : t('fnx.fs.branch_hash', { key })}</strong>
                    <Badge variant={b.net >= 0 ? 'success' : 'destructive'}>{t('fnx.fs.net_profit')} {baht(b.net)}</Badge>
                  </div>
                  <div className="flex gap-6 text-sm text-muted-foreground">
                    <span>{t('fnx.fs.revenue')} <span className="tabular text-foreground">{baht(b.revenue)}</span></span>
                    <span>{t('fnx.fs.expense')} <span className="tabular text-foreground">{baht(b.expense)}</span></span>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </StateView>
      ) : (
        <StateView q={q}>
          {d && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <StatCard label={t('fnx.fs.rev_total')} value={baht(d.revenue)} tone="primary" />
                <StatCard label={t('fnx.fs.exp_total')} value={baht(d.expense)} tone="danger" />
                <StatCard label={t('fnx.fs.net_profit')} value={baht(d.net_income)} tone={d.net_income >= 0 ? 'success' : 'danger'} />
              </div>
              <LineTable title={t('fnx.fs.revenue')} rows={rev} subtotal={d.revenue} />
              <LineTable title={t('fnx.fs.expense')} rows={exp} subtotal={d.expense} />
              <Card className="flex-row items-center justify-between p-5">
                <span className="font-semibold">{t('fnx.fs.net_pl')}</span>
                <span className={`text-lg font-semibold tabular ${d.net_income >= 0 ? 'text-success' : 'text-destructive'}`}>{baht(d.net_income)}</span>
              </Card>
            </div>
          )}
        </StateView>
      )}
    </div>
  );
}

// ───────────────────────── งบกระแสเงินสด (Statement of Cash Flows) ─────────────────────────
function CashFlow({ lp }: { lp: string }) {
  const { t } = useLang();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [method, setMethod] = useState<'indirect' | 'direct' | 'forecast'>('indirect');

  const q = useQuery<any>({
    queryKey: ['cf', method, from, to, lp],
    queryFn: () =>
      method === 'forecast'
        ? api(`/api/ledger/cash-flow-forecast?weeks=8${lp}`)
        : api(`/api/ledger/cash-flow${method === 'direct' ? '-direct' : ''}?from=${from}&to=${to}${lp}`),
  });
  const d = q.data;

  // Each cash-flow line renders twice: a <table> row for sm+ and a stacked label/amount div for phones
  // (a bare 2-col <table> still wraps long activity labels awkwardly against a squeezed amount column).
  const flowRow = (label: string, amount: number, key: string | number) => (
    <tr key={key}>
      <td className="py-0.5 pr-3">{label}</td>
      <td className={`py-0.5 text-right tabular ${amount < 0 ? 'text-destructive' : ''}`}>{baht(amount)}</td>
    </tr>
  );
  const flowRowCard = (label: string, amount: number, key: string | number, cls = '') => (
    <div key={key} className={`flex items-baseline justify-between gap-3 py-0.5 ${cls}`}>
      <span className="min-w-0">{label}</span>
      <span className={`shrink-0 tabular ${amount < 0 ? 'text-destructive' : ''}`}>{baht(amount)}</span>
    </div>
  );
  const flowHeaderCard = (label: string, key: string | number) => (
    <div key={key} className="pt-3 pb-1 text-xs font-medium text-muted-foreground first:pt-0">{label}</div>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1">
          {(['indirect', 'direct', 'forecast'] as const).map((m) => (
            <Button key={m} size="sm" variant={method === m ? 'default' : 'outline'} onClick={() => setMethod(m)}>
              {m === 'indirect' ? t('fnx.fs.cf_indirect') : m === 'direct' ? t('fnx.fs.cf_direct') : t('fnx.fs.cf_forecast')}
            </Button>
          ))}
        </div>
        {method !== 'forecast' && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="cf-from">{t('fnx.fs.from')}</Label>
              <Input id="cf-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="cf-to">{t('fnx.fs.to')}</Label>
              <Input id="cf-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
        )}
      </div>

      <StateView q={q}>
        {d && method === 'indirect' && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label={t('fnx.fs.cf_operating')} value={baht(d.operating?.net)} tone={d.operating?.net >= 0 ? 'success' : 'danger'} />
              <StatCard label={t('fnx.fs.cf_investing')} value={baht(d.investing?.net)} />
              <StatCard label={t('fnx.fs.cf_financing')} value={baht(d.financing?.net)} />
            </div>
            <Card className="gap-2 p-5">
              <div className="text-sm sm:hidden">
                {flowHeaderCard(t('fnx.fs.op_activities'), 'h-op')}
                {flowRowCard(t('fnx.fs.net_income_row'), d.operating?.net_income ?? 0, 'ni')}
                {(d.operating?.adjustments ?? []).map((a: any, i: number) => flowRowCard(`+ ${a.label ?? a.account_name}`, a.amount, `adj${i}`))}
                {(d.operating?.working_capital ?? []).map((a: any, i: number) => flowRowCard(`Δ ${a.label ?? a.account_name}`, a.amount, `wc${i}`))}
                {flowRowCard(t('fnx.fs.net_op_cash'), d.operating?.net, 'net-op', 'border-t pt-1.5 mt-0.5 font-medium')}
                {(d.investing?.lines ?? []).length > 0 && flowHeaderCard(t('fnx.fs.inv_activities'), 'h-inv')}
                {(d.investing?.lines ?? []).map((a: any, i: number) => flowRowCard(a.label ?? a.account_name, a.amount, `inv${i}`))}
                {(d.financing?.lines ?? []).length > 0 && flowHeaderCard(t('fnx.fs.fin_activities'), 'h-fin')}
                {(d.financing?.lines ?? []).map((a: any, i: number) => flowRowCard(a.label ?? a.account_name, a.amount, `fin${i}`))}
                {flowRowCard(t('fnx.fs.net_change_cash'), d.net_change_in_cash, 'net-change', 'border-t pt-1.5 mt-0.5 font-semibold')}
                {flowRowCard(t('fnx.fs.cash_begin'), d.cash_beginning, 'cb', 'text-muted-foreground')}
                {flowRowCard(t('fnx.fs.cash_end'), d.cash_ending, 'ce', 'text-muted-foreground')}
              </div>
              <table className="hidden w-full text-sm sm:table">
                <tbody>
                  <tr className="text-muted-foreground"><td className="pb-1 font-medium">{t('fnx.fs.op_activities')}</td><td /></tr>
                  {flowRow(t('fnx.fs.net_income_row'), d.operating?.net_income ?? 0, 'ni')}
                  {(d.operating?.adjustments ?? []).map((a: any, i: number) => flowRow(`+ ${a.label ?? a.account_name}`, a.amount, `adj${i}`))}
                  {(d.operating?.working_capital ?? []).map((a: any, i: number) => flowRow(`Δ ${a.label ?? a.account_name}`, a.amount, `wc${i}`))}
                  <tr className="border-t font-medium"><td className="py-1">{t('fnx.fs.net_op_cash')}</td><td className="py-1 text-right tabular">{baht(d.operating?.net)}</td></tr>
                  {(d.investing?.lines ?? []).length > 0 && <tr className="text-muted-foreground"><td className="pt-3 pb-1 font-medium">{t('fnx.fs.inv_activities')}</td><td /></tr>}
                  {(d.investing?.lines ?? []).map((a: any, i: number) => flowRow(a.label ?? a.account_name, a.amount, `inv${i}`))}
                  {(d.financing?.lines ?? []).length > 0 && <tr className="text-muted-foreground"><td className="pt-3 pb-1 font-medium">{t('fnx.fs.fin_activities')}</td><td /></tr>}
                  {(d.financing?.lines ?? []).map((a: any, i: number) => flowRow(a.label ?? a.account_name, a.amount, `fin${i}`))}
                  <tr className="border-t font-semibold"><td className="py-1.5">{t('fnx.fs.net_change_cash')}</td><td className="py-1.5 text-right tabular">{baht(d.net_change_in_cash)}</td></tr>
                  <tr><td className="py-0.5 pr-3 text-muted-foreground">{t('fnx.fs.cash_begin')}</td><td className="py-0.5 text-right tabular">{baht(d.cash_beginning)}</td></tr>
                  <tr><td className="py-0.5 pr-3 text-muted-foreground">{t('fnx.fs.cash_end')}</td><td className="py-0.5 text-right tabular">{baht(d.cash_ending)}</td></tr>
                </tbody>
              </table>
            </Card>
            <Card className="flex-row flex-wrap items-center gap-2 p-5 text-sm">
              <ShieldCheck className="size-4 text-muted-foreground" />
              {t('fnx.fs.cf_indirect_note')}{' '}
              <Badge variant={d.reconciled ? 'success' : 'destructive'}>{d.reconciled ? t('fnx.fs.reconciled') : t('fnx.fs.not_reconciled')}</Badge>
            </Card>
          </div>
        )}

        {d && method === 'direct' && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label={t('fnx.fs.cf_operating')} value={baht(d.operating?.net)} tone={d.operating?.net >= 0 ? 'success' : 'danger'} />
              <StatCard label={t('fnx.fs.cf_investing')} value={baht(d.investing?.net)} />
              <StatCard label={t('fnx.fs.cf_financing')} value={baht(d.financing?.net)} />
            </div>
            <Card className="gap-2 p-5">
              <div className="text-sm sm:hidden">
                {flowHeaderCard(t('fnx.fs.op_activities'), 'h-op')}
                {flowRowCard(t('fnx.fs.receipts_customers'), d.operating?.receipts_from_customers ?? 0, 'r')}
                {flowRowCard(t('fnx.fs.payments_suppliers'), d.operating?.payments_to_suppliers ?? 0, 'p')}
                {flowRowCard(t('fnx.fs.tax_payroll'), d.operating?.tax_and_payroll ?? 0, 't')}
                {flowRowCard(t('fnx.fs.other_operating'), d.operating?.other_operating ?? 0, 'o')}
                {flowRowCard(t('fnx.fs.net_op_cash'), d.operating?.net, 'net-op', 'border-t pt-1.5 mt-0.5 font-medium')}
                {flowRowCard(t('fnx.fs.inv_activities'), d.investing?.net ?? 0, 'i')}
                {flowRowCard(t('fnx.fs.fin_activities'), d.financing?.net ?? 0, 'f')}
                {flowRowCard(t('fnx.fs.net_change_cash'), d.net_change_in_cash, 'net-change', 'border-t pt-1.5 mt-0.5 font-semibold')}
                {flowRowCard(t('fnx.fs.cash_begin'), d.cash_beginning, 'cb', 'text-muted-foreground')}
                {flowRowCard(t('fnx.fs.cash_end'), d.cash_ending, 'ce', 'text-muted-foreground')}
              </div>
              <table className="hidden w-full text-sm sm:table">
                <tbody>
                  <tr className="text-muted-foreground"><td className="pb-1 font-medium">{t('fnx.fs.op_activities')}</td><td /></tr>
                  {flowRow(t('fnx.fs.receipts_customers'), d.operating?.receipts_from_customers ?? 0, 'r')}
                  {flowRow(t('fnx.fs.payments_suppliers'), d.operating?.payments_to_suppliers ?? 0, 'p')}
                  {flowRow(t('fnx.fs.tax_payroll'), d.operating?.tax_and_payroll ?? 0, 't')}
                  {flowRow(t('fnx.fs.other_operating'), d.operating?.other_operating ?? 0, 'o')}
                  <tr className="border-t font-medium"><td className="py-1">{t('fnx.fs.net_op_cash')}</td><td className="py-1 text-right tabular">{baht(d.operating?.net)}</td></tr>
                  {flowRow(t('fnx.fs.inv_activities'), d.investing?.net ?? 0, 'i')}
                  {flowRow(t('fnx.fs.fin_activities'), d.financing?.net ?? 0, 'f')}
                  <tr className="border-t font-semibold"><td className="py-1.5">{t('fnx.fs.net_change_cash')}</td><td className="py-1.5 text-right tabular">{baht(d.net_change_in_cash)}</td></tr>
                  <tr><td className="py-0.5 pr-3 text-muted-foreground">{t('fnx.fs.cash_begin')}</td><td className="py-0.5 text-right tabular">{baht(d.cash_beginning)}</td></tr>
                  <tr><td className="py-0.5 pr-3 text-muted-foreground">{t('fnx.fs.cash_end')}</td><td className="py-0.5 text-right tabular">{baht(d.cash_ending)}</td></tr>
                </tbody>
              </table>
            </Card>
            <Card className="flex-row flex-wrap items-center gap-2 p-5 text-sm">
              <ShieldCheck className="size-4 text-muted-foreground" />
              {t('fnx.fs.cf_direct_note')}{' '}
              <Badge variant={d.reconciled ? 'success' : 'destructive'}>{d.reconciled ? t('fnx.fs.reconciled') : t('fnx.fs.not_reconciled')}</Badge>
            </Card>
          </div>
        )}

        {d && method === 'forecast' && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label={t('fnx.fs.current_cash')} value={baht(d.opening_cash)} tone="primary" />
              <StatCard label={t('fnx.fs.expected_in')} value={baht(d.total_expected_inflow)} tone="success" />
              <StatCard label={t('fnx.fs.expected_out')} value={baht(d.total_expected_outflow)} tone="danger" />
              <StatCard label={t('fnx.fs.projected_closing')} value={baht(d.projected_closing_cash)} tone={d.projected_closing_cash >= 0 ? 'success' : 'danger'} />
            </div>
            <Card className="gap-2 p-5">
              <h3 className="text-sm font-semibold text-muted-foreground">{t('fnx.fs.forecast_title')}</h3>
              {/* Phone-width fallback: 5 columns squeezed to phone width leaves each figure a near-illegible
                  sliver, so below `sm` each week becomes its own card with the amounts as label/value rows. */}
              <div className="space-y-2 sm:hidden">
                {(d.periods ?? []).map((p: any) => (
                  <div key={p.week} className="rounded-lg border p-3 text-sm">
                    <div className="font-medium">{p.week === 0 ? t('fnx.fs.week_due') : t('fnx.fs.week_plus', { week: p.week })}</div>
                    <dl className="mt-1.5 space-y-1 border-t pt-1.5">
                      <div className="flex items-baseline justify-between gap-3">
                        <dt className="text-xs text-muted-foreground">{t('fnx.fs.col_in')}</dt>
                        <dd className="tabular">{p.inflow ? baht(p.inflow) : '—'}</dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-3">
                        <dt className="text-xs text-muted-foreground">{t('fnx.fs.col_out')}</dt>
                        <dd className="tabular">{p.outflow ? baht(p.outflow) : '—'}</dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-3">
                        <dt className="text-xs text-muted-foreground">{t('fnx.fs.col_net')}</dt>
                        <dd className={`tabular ${p.net < 0 ? 'text-destructive' : ''}`}>{baht(p.net)}</dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-3">
                        <dt className="text-xs text-muted-foreground">{t('fnx.fs.col_proj_balance')}</dt>
                        <dd className={`tabular font-medium ${p.projected_balance < 0 ? 'text-destructive' : ''}`}>{baht(p.projected_balance)}</dd>
                      </div>
                    </dl>
                  </div>
                ))}
              </div>
              <table className="hidden w-full text-sm sm:table">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="pb-2 font-medium">{t('fnx.fs.col_week')}</th>
                    <th className="pb-2 text-right font-medium">{t('fnx.fs.col_in')}</th>
                    <th className="pb-2 text-right font-medium">{t('fnx.fs.col_out')}</th>
                    <th className="pb-2 text-right font-medium">{t('fnx.fs.col_net')}</th>
                    <th className="pb-2 text-right font-medium">{t('fnx.fs.col_proj_balance')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(d.periods ?? []).map((p: any) => (
                    <tr key={p.week} className="border-t">
                      <td className="py-1">{p.week === 0 ? t('fnx.fs.week_due') : t('fnx.fs.week_plus', { week: p.week })}</td>
                      <td className="py-1 text-right tabular">{p.inflow ? baht(p.inflow) : '—'}</td>
                      <td className="py-1 text-right tabular">{p.outflow ? baht(p.outflow) : '—'}</td>
                      <td className={`py-1 text-right tabular ${p.net < 0 ? 'text-destructive' : ''}`}>{baht(p.net)}</td>
                      <td className={`py-1 text-right tabular font-medium ${p.projected_balance < 0 ? 'text-destructive' : ''}`}>{baht(p.projected_balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── งบตามกฎหมาย (Statutory pack — FIN-4) ─────────────────────────
// Surfaces the statutory-FS read outputs that have no other screen: statement of changes in equity,
// the DBD e-Filing (Thai งบการเงิน XBRL / S-form) export, and the definition-driven statement/notes viewer.
// All read-only over the audited GL; the layout definitions themselves are maintained by the close approver
// via api/reports/fs/definitions (a full config editor is out of scope for this surfacing).

interface SoceComponent { account_code: string; account_name: string; opening: number; movements: number; profit: number; closing: number }
interface SoceResp {
  from: string; to: string; ledger: string; profit_for_period: number;
  components: SoceComponent[]; totals: { opening: number; movements: number; profit: number; closing: number };
  ties_to_balance_sheet: boolean; balance_sheet_equity: number;
}
interface DbdFact { concept: string; label: string; context: string; current: number; prior: number }
interface DbdResp {
  format: string; form: string; fiscal_year: number; ledger: string; taxpayer_name: string; taxpayer_id: string;
  facts: DbdFact[]; balanced: boolean; xml: string;
}
interface FsDef { code: string; name: string; statement_type: string; active: boolean }
interface RenderRow { key: string; label?: string; label_th?: string | null; account_name?: string; level: number; is_subtotal?: boolean; current: number; prior?: number }
interface RenderResp { code: string; name: string; statement_type: string; as_of: string; from: string | null; comparative: boolean; rows: RenderRow[] }
interface NoteLine { account_code: string; account_name: string; current: number; prior: number | null }
interface NoteBlock { number: string; title: string; title_th: string | null; policy_text: string | null; lines: NoteLine[]; total: number; prior_total: number | null }
interface NotesResp { code: string; name: string; as_of?: string; basis: string; comparative: boolean; notes: NoteBlock[] }

function downloadText(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function StatutoryPack({ lp }: { lp: string }) {
  return (
    <div className="space-y-6">
      <ChangesInEquity lp={lp} />
      <DbdExport lp={lp} />
      <CustomStatements lp={lp} />
    </div>
  );
}

// ── Statement of changes in equity (roll-forward) ──
function ChangesInEquity({ lp }: { lp: string }) {
  const { t } = useLang();
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());
  const [params, setParams] = useState<{ from: string; to: string } | null>(null);
  const q = useQuery<SoceResp>({
    queryKey: ['fs-soce', params, lp],
    queryFn: () => api(`/api/reports/fs/changes-in-equity?from=${params!.from}&to=${params!.to}${lp}`),
    enabled: params != null,
  });
  const d = q.data;
  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center gap-2">
        <Scale className="size-4 text-primary" />
        <h3 className="text-base font-semibold">{t('fnx.fs.stat.soce_title')}</h3>
      </div>
      <p className="text-sm text-muted-foreground">{t('fnx.fs.stat.soce_hint')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-2"><Label htmlFor="soce-from">{t('fnx.fs.from')}</Label><Input id="soce-from" type="date" className="max-w-[170px]" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="grid gap-2"><Label htmlFor="soce-to">{t('fnx.fs.to')}</Label><Input id="soce-to" type="date" className="max-w-[170px]" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <Button disabled={!from || !to} onClick={() => setParams({ from, to })}><PlayCircle className="size-4" /> {t('fnx.fs.stat.run')}</Button>
        {d && (
          <Button variant="outline" onClick={() => downloadCsv(`changes-in-equity-${d.from}_${d.to}.csv`, [
            [t('fnx.fs.stat.col_component'), t('fnx.fs.stat.col_opening'), t('fnx.fs.stat.col_movements'), t('fnx.fs.stat.col_profit'), t('fnx.fs.stat.col_closing')],
            ...d.components.map((c) => [c.account_name, c.opening, c.movements, c.profit, c.closing]),
            [t('fnx.fs.stat.col_total'), d.totals.opening, d.totals.movements, d.totals.profit, d.totals.closing],
          ])}><Download className="size-4" /> CSV</Button>
        )}
      </div>
      {params != null && (
        <StateView q={q}>
          {d && (
            <div className="space-y-3">
              <Badge variant={d.ties_to_balance_sheet ? 'success' : 'destructive'}>
                {d.ties_to_balance_sheet ? t('fnx.fs.stat.soce_ties') : t('fnx.fs.stat.soce_no_ties')}
              </Badge>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-muted-foreground">
                    <th className="py-1">{t('fnx.fs.stat.col_component')}</th>
                    <th className="py-1 text-right">{t('fnx.fs.stat.col_opening')}</th>
                    <th className="py-1 text-right">{t('fnx.fs.stat.col_movements')}</th>
                    <th className="py-1 text-right">{t('fnx.fs.stat.col_profit')}</th>
                    <th className="py-1 text-right">{t('fnx.fs.stat.col_closing')}</th>
                  </tr></thead>
                  <tbody>
                    {d.components.map((c) => (
                      <tr key={c.account_code} className="border-t">
                        <td className="py-1">{c.account_name} <span className="text-xs text-muted-foreground">({c.account_code})</span></td>
                        <td className="py-1 text-right tabular">{baht(c.opening)}</td>
                        <td className="py-1 text-right tabular">{baht(c.movements)}</td>
                        <td className="py-1 text-right tabular">{c.profit ? baht(c.profit) : '—'}</td>
                        <td className="py-1 text-right tabular font-medium">{baht(c.closing)}</td>
                      </tr>
                    ))}
                    <tr className="border-t-2 font-semibold">
                      <td className="py-1">{t('fnx.fs.stat.col_total')}</td>
                      <td className="py-1 text-right tabular">{baht(d.totals.opening)}</td>
                      <td className="py-1 text-right tabular">{baht(d.totals.movements)}</td>
                      <td className="py-1 text-right tabular">{baht(d.totals.profit)}</td>
                      <td className="py-1 text-right tabular">{baht(d.totals.closing)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </StateView>
      )}
    </Card>
  );
}

// ── DBD e-Filing export (Thai งบการเงิน — XBRL / S-form) ──
function DbdExport({ lp }: { lp: string }) {
  const { t } = useLang();
  const [fy, setFy] = useState(String(new Date().getFullYear()));
  const [name, setName] = useState('');
  const [tid, setTid] = useState('');
  const [params, setParams] = useState<{ fy: string; name: string; tid: string } | null>(null);
  const q = useQuery<DbdResp>({
    queryKey: ['fs-dbd', params, lp],
    queryFn: () => api(`/api/reports/fs/dbd-export?fiscal_year=${params!.fy}${lp}${params!.name ? `&taxpayer_name=${encodeURIComponent(params!.name)}` : ''}${params!.tid ? `&taxpayer_id=${encodeURIComponent(params!.tid)}` : ''}`),
    enabled: params != null,
  });
  const d = q.data;
  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center gap-2">
        <Landmark className="size-4 text-primary" />
        <h3 className="text-base font-semibold">{t('fnx.fs.stat.dbd_title')}</h3>
      </div>
      <p className="text-sm text-muted-foreground">{t('fnx.fs.stat.dbd_hint')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-2"><Label htmlFor="dbd-fy">{t('fnx.fs.stat.fiscal_year')}</Label><Input id="dbd-fy" type="number" className="max-w-[120px]" value={fy} onChange={(e) => setFy(e.target.value)} /></div>
        <div className="grid gap-2"><Label htmlFor="dbd-name">{t('fnx.fs.stat.taxpayer_name')}</Label><Input id="dbd-name" className="max-w-[200px]" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('fnx.fs.stat.taxpayer_name_ph')} /></div>
        <div className="grid gap-2"><Label htmlFor="dbd-tid">{t('fnx.fs.stat.taxpayer_id')}</Label><Input id="dbd-tid" className="max-w-[180px]" value={tid} onChange={(e) => setTid(e.target.value)} placeholder="0105xxxxxxxxx" /></div>
        <Button disabled={!/^\d{4}$/.test(fy)} onClick={() => setParams({ fy, name, tid })}><PlayCircle className="size-4" /> {t('fnx.fs.stat.run')}</Button>
        {d && (
          <Button variant="outline" onClick={() => downloadText(`dbd-sform-${d.fiscal_year}.xbrl`, d.xml, 'application/xml;charset=utf-8')}>
            <Download className="size-4" /> {t('fnx.fs.stat.dbd_download')}
          </Button>
        )}
      </div>
      {params != null && (
        <StateView q={q}>
          {d && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant={d.balanced ? 'success' : 'destructive'}>{d.balanced ? t('fnx.fs.stat.dbd_balanced') : t('fnx.fs.stat.dbd_unbalanced')}</Badge>
                <span className="text-xs text-muted-foreground">{d.format} · {d.form} · {d.fiscal_year}</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-muted-foreground">
                    <th className="py-1">{t('fnx.fs.stat.col_concept')}</th>
                    <th className="py-1 text-right">{t('fnx.fs.stat.col_current')}</th>
                    <th className="py-1 text-right">{t('fnx.fs.stat.col_prior')}</th>
                  </tr></thead>
                  <tbody>
                    {d.facts.map((f) => (
                      <tr key={f.concept} className="border-t">
                        <td className="py-1">{f.label} <span className="text-xs text-muted-foreground">{f.concept}</span></td>
                        <td className="py-1 text-right tabular">{baht(f.current)}</td>
                        <td className="py-1 text-right tabular text-muted-foreground">{baht(f.prior)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </StateView>
      )}
    </Card>
  );
}

// ── Definition-driven statement + note-schedule viewer ──
function CustomStatements({ lp }: { lp: string }) {
  const { t } = useLang();
  const defsQ = useQuery<{ definitions: FsDef[]; count: number }>({ queryKey: ['fs-defs'], queryFn: () => api('/api/reports/fs/definitions') });
  const [code, setCode] = useState('');
  const [asOf, setAsOf] = useState(today());
  const [from, setFrom] = useState(yearStart());
  const [prior, setPrior] = useState(false);
  const [priorAsOf, setPriorAsOf] = useState('');
  const [priorFrom, setPriorFrom] = useState('');
  const [run, setRun] = useState<{ code: string; type: string } | null>(null);

  const defs = defsQ.data?.definitions ?? [];
  const selected = defs.find((d) => d.code === code);
  const isNotes = selected?.statement_type === 'notes';
  const isPl = selected?.statement_type === 'pl';

  const priorQs = prior && priorAsOf ? `&prior_as_of=${priorAsOf}${isPl && priorFrom ? `&prior_from=${priorFrom}` : ''}` : '';
  const renderQ = useQuery<RenderResp>({
    queryKey: ['fs-render', run, asOf, from, priorQs, lp],
    queryFn: () => api(`/api/reports/fs/render/${run!.code}?as_of=${asOf}${isPl ? `&from=${from}` : ''}${priorQs}${lp}`),
    enabled: run != null && run.type !== 'notes',
  });
  const notesQ = useQuery<NotesResp>({
    queryKey: ['fs-notes', run, asOf, priorQs, lp],
    queryFn: () => api(`/api/reports/fs/notes/${run!.code}?as_of=${asOf}${priorQs}&basis=bs${lp}`),
    enabled: run != null && run.type === 'notes',
  });

  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center gap-2">
        <FileText className="size-4 text-primary" />
        <h3 className="text-base font-semibold">{t('fnx.fs.stat.custom_title')}</h3>
      </div>
      <p className="text-sm text-muted-foreground">{t('fnx.fs.stat.custom_hint')}</p>
      <StateView q={defsQ}>
        {defsQ.data && (
          defs.length === 0 ? (
            <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">{t('fnx.fs.stat.custom_empty')}</p>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="cs-def">{t('fnx.fs.stat.definition')}</Label>
                  <Select id="cs-def" className="w-auto" value={code} onChange={(e) => { setCode(e.target.value); setRun(null); }}>
                    <option value="">{t('fnx.fs.stat.pick_definition')}</option>
                    {defs.map((d) => <option key={d.code} value={d.code}>{d.name} ({d.statement_type.toUpperCase()})</option>)}
                  </Select>
                </div>
                <div className="grid gap-2"><Label htmlFor="cs-asof">{t('fnx.fs.stat.as_of')}</Label><Input id="cs-asof" type="date" className="max-w-[170px]" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></div>
                {isPl && <div className="grid gap-2"><Label htmlFor="cs-from">{t('fnx.fs.from')}</Label><Input id="cs-from" type="date" className="max-w-[170px]" value={from} onChange={(e) => setFrom(e.target.value)} /></div>}
                <label className="flex items-center gap-2 pb-2 text-sm">
                  <input type="checkbox" className="size-4" checked={prior} onChange={(e) => setPrior(e.target.checked)} /> {t('fnx.fs.stat.comparative')}
                </label>
                {prior && <div className="grid gap-2"><Label htmlFor="cs-pasof">{t('fnx.fs.stat.prior_as_of')}</Label><Input id="cs-pasof" type="date" className="max-w-[170px]" value={priorAsOf} onChange={(e) => setPriorAsOf(e.target.value)} /></div>}
                {prior && isPl && <div className="grid gap-2"><Label htmlFor="cs-pfrom">{t('fnx.fs.stat.prior_from')}</Label><Input id="cs-pfrom" type="date" className="max-w-[170px]" value={priorFrom} onChange={(e) => setPriorFrom(e.target.value)} /></div>}
                <Button disabled={!selected} onClick={() => selected && setRun({ code: selected.code, type: selected.statement_type })}><PlayCircle className="size-4" /> {t('fnx.fs.stat.run')}</Button>
              </div>

              {run != null && !isNotes && (
                <StateView q={renderQ}>
                  {renderQ.data && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead><tr className="text-left text-muted-foreground">
                          <th className="py-1">{renderQ.data.name}</th>
                          <th className="py-1 text-right">{t('fnx.fs.stat.col_current')}</th>
                          {renderQ.data.comparative && <th className="py-1 text-right">{t('fnx.fs.stat.col_prior')}</th>}
                        </tr></thead>
                        <tbody>
                          {renderQ.data.rows.map((r) => (
                            <tr key={r.key} className={`border-t ${r.is_subtotal ? 'font-semibold' : ''}`}>
                              <td className="py-1" style={{ paddingLeft: `${(r.level ?? 0) * 16}px` }}>{r.label ?? r.account_name}</td>
                              <td className="py-1 text-right tabular">{baht(r.current)}</td>
                              {renderQ.data!.comparative && <td className="py-1 text-right tabular text-muted-foreground">{baht(r.prior ?? 0)}</td>}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </StateView>
              )}

              {run != null && isNotes && (
                <StateView q={notesQ}>
                  {notesQ.data && (
                    <div className="space-y-4">
                      {notesQ.data.notes.map((n) => (
                        <div key={n.number} className="rounded-md border p-3">
                          <div className="mb-2 text-sm font-semibold">{t('fnx.fs.stat.note_no', { no: n.number })} · {n.title}</div>
                          {n.policy_text && <p className="mb-2 text-xs text-muted-foreground">{n.policy_text}</p>}
                          <table className="w-full text-sm">
                            <tbody>
                              {n.lines.map((l) => (
                                <tr key={l.account_code} className="border-t">
                                  <td className="py-1">{l.account_name} <span className="text-xs text-muted-foreground">({l.account_code})</span></td>
                                  <td className="py-1 text-right tabular">{baht(l.current)}</td>
                                  {notesQ.data!.comparative && <td className="py-1 text-right tabular text-muted-foreground">{baht(l.prior ?? 0)}</td>}
                                </tr>
                              ))}
                              <tr className="border-t-2 font-semibold">
                                <td className="py-1">{t('fnx.fs.stat.col_total')}</td>
                                <td className="py-1 text-right tabular">{baht(n.total)}</td>
                                {notesQ.data!.comparative && <td className="py-1 text-right tabular">{baht(n.prior_total ?? 0)}</td>}
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      ))}
                    </div>
                  )}
                </StateView>
              )}
            </div>
          )
        )}
      </StateView>
    </Card>
  );
}
