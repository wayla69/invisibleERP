'use client';

// Treasury / Cash Command client island (docs/35 Phase 4, TR-01). Renders the cash-position aggregate:
// headline cash + projected-closing + liquidity-trough stats, the 13-week cash-forecast curve (single-series
// area, trough marked), the GL cash / house-bank position, the liquidity KPI subset, and FX exposure.
// Read-only. Chart is theme-aware (uses design-system tokens; single series ⇒ no legend needed).
import { useCallback, useEffect, useState } from 'react';
import { Wallet, TrendingDown, Landmark } from 'lucide-react';
import { useLang } from '@/lib/i18n';
import { baht, num } from '@/lib/format';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { Card } from '@/components/ui/card';

interface Period { week: number; label: string; inflow: number; outflow: number; net: number; projected_balance: number }
interface CashPosition {
  as_of: string; weeks: number; total_cash: number;
  cash_accounts: { account_code: string; account_name: string; balance: number }[];
  bank_accounts: { id: number; bank_name: string; account_no: string; gl_account_code: string; currency: string; gl_balance: number }[];
  forecast: { opening_cash: number; projected_closing_cash: number; total_expected_inflow: number; total_expected_outflow: number; periods: Period[]; min_balance: number; min_week: number };
  liquidity: { id: string; label: string; label_en: string; unit: string; value: number | null; rag: 'green' | 'amber' | 'red' | null }[];
  fx_exposure: { currency: string; receivable: number; payable: number; net: number }[];
}

function fmtLiq(v: number | null, unit: string): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (unit === 'currency') return baht(v);
  if (unit === 'pct') return `${v}%`;
  if (unit === 'days') return `${v}d`;
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function TreasuryClient({ initialData }: { initialData: CashPosition | null }) {
  const { t, lang } = useLang();
  const [data, setData] = useState<CashPosition | null>(initialData);

  const refetch = useCallback(async () => {
    try { setData(await api<CashPosition>('/api/finance/metrics/cash/position')); } catch { /* keep last good */ }
  }, []);
  useEffect(() => { void refetch(); }, [refetch]);

  if (!data) {
    return (
      <div>
        <PageHeader title={t('fnx.treasury.title')} description={t('fnx.treasury.subtitle')} />
        <Card className="p-8 text-center text-sm text-muted-foreground">{t('fnx.treasury.load_error')}</Card>
      </div>
    );
  }

  const f = data.forecast;
  const troughTone = f.min_balance < 0 ? 'danger' : f.min_balance < data.total_cash * 0.25 ? 'warning' : 'info';

  return (
    <div>
      <PageHeader title={t('fnx.treasury.title')} description={t('fnx.treasury.subtitle')} />
      <div className="mb-3 text-sm text-muted-foreground">{t('fnx.treasury.as_of', { date: data.as_of })}</div>

      <div className="mb-4 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
        <StatCard label={t('fnx.treasury.total_cash')} value={baht(data.total_cash)} icon={Wallet} tone="info" />
        <StatCard label={t('fnx.treasury.projected_close')} value={baht(f.projected_closing_cash)} icon={Wallet} tone={f.projected_closing_cash >= data.total_cash ? 'success' : 'warning'} />
        <StatCard label={t('fnx.treasury.min_balance', { week: f.min_week })} value={baht(f.min_balance)} icon={TrendingDown} tone={troughTone as any} />
      </div>

      {/* 13-week cash forecast */}
      <Card className="mb-4 gap-2 p-4">
        <h3 className="text-sm font-semibold text-muted-foreground">{t('fnx.treasury.forecast', { weeks: data.weeks })}</h3>
        <ForecastChart periods={f.periods} />
        <div className="max-h-56 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card"><tr className="text-muted-foreground [&>th]:pb-1 [&>th]:text-right [&>th:first-child]:text-left">
              <th>{t('fnx.treasury.col_week')}</th><th>{t('fnx.treasury.col_in')}</th><th>{t('fnx.treasury.col_out')}</th><th>{t('fnx.treasury.col_proj')}</th>
            </tr></thead>
            <tbody>
              {f.periods.map((p) => (
                <tr key={p.week} className={`border-t border-border/50 [&>td]:py-1 [&>td]:text-right [&>td:first-child]:text-left ${p.week === f.min_week ? 'bg-warning/10' : ''}`}>
                  <td>{p.week === 0 ? t('fnx.treasury.week_now') : `+${p.week}`}</td>
                  <td className="tabular-nums text-success">{p.inflow ? baht(p.inflow) : '—'}</td>
                  <td className="tabular-nums text-destructive">{p.outflow ? baht(p.outflow) : '—'}</td>
                  <td className="tabular-nums font-medium">{baht(p.projected_balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(340px,1fr))]">
        {/* Cash & bank accounts */}
        <Card className="gap-2 p-4">
          <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold"><Landmark className="size-4 text-muted-foreground" />{t('fnx.treasury.cash_accounts')}</h3>
          <table className="w-full text-xs">
            <tbody>
              {data.cash_accounts.map((a) => (
                <tr key={a.account_code} className="border-t border-border/50 [&>td]:py-1">
                  <td>{a.account_code} · {a.account_name}</td>
                  <td className="text-right tabular-nums font-medium">{baht(a.balance)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-border [&>td]:py-1 font-semibold">
                <td>{t('fnx.treasury.total_cash')}</td><td className="text-right tabular-nums">{baht(data.total_cash)}</td>
              </tr>
            </tbody>
          </table>
          {data.bank_accounts.length > 0 && (
            <>
              <h4 className="mt-2 text-xs font-semibold text-muted-foreground">{t('fnx.treasury.house_banks')}</h4>
              <table className="w-full text-xs">
                <thead><tr className="text-muted-foreground [&>th]:pb-1 [&>th]:text-right [&>th:first-child]:text-left"><th>{t('fnx.treasury.col_bank')}</th><th>{t('fnx.treasury.col_glbal')}</th></tr></thead>
                <tbody>
                  {data.bank_accounts.map((b) => (
                    <tr key={b.id} className="border-t border-border/50 [&>td]:py-1 [&>td:last-child]:text-right">
                      <td>{b.bank_name} ·······{String(b.account_no).slice(-4)} <span className="text-muted-foreground">{b.currency}</span></td>
                      <td className="tabular-nums">{baht(b.gl_balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Card>

        {/* Liquidity */}
        <Card className="gap-2 p-4">
          <h3 className="text-sm font-semibold text-muted-foreground">{t('fnx.treasury.liquidity')}</h3>
          <div className="grid grid-cols-2 gap-2">
            {data.liquidity.map((k) => (
              <div key={k.id} className={`rounded border-l-2 p-2 ${k.rag === 'red' ? 'border-l-destructive' : k.rag === 'amber' ? 'border-l-warning' : k.rag === 'green' ? 'border-l-success' : 'border-l-transparent'}`}>
                <div className="text-[11px] text-muted-foreground">{lang === 'th' ? k.label : k.label_en}</div>
                <div className="text-lg font-semibold tabular-nums">{fmtLiq(k.value, k.unit)}</div>
              </div>
            ))}
          </div>
        </Card>

        {/* FX exposure */}
        <Card className="gap-2 p-4">
          <h3 className="text-sm font-semibold text-muted-foreground">{t('fnx.treasury.fx_exposure')}</h3>
          {data.fx_exposure.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('fnx.treasury.no_fx')}</p>
          ) : (
            <table className="w-full text-xs">
              <thead><tr className="text-muted-foreground [&>th]:pb-1 [&>th]:text-right [&>th:first-child]:text-left">
                <th>{t('fnx.treasury.col_currency')}</th><th>{t('fnx.treasury.col_receivable')}</th><th>{t('fnx.treasury.col_payable')}</th><th>{t('fnx.treasury.col_net')}</th>
              </tr></thead>
              <tbody>
                {data.fx_exposure.map((e) => (
                  <tr key={e.currency} className="border-t border-border/50 [&>td]:py-1 [&>td]:text-right [&>td:first-child]:text-left">
                    <td className="font-medium">{e.currency}</td>
                    <td className="tabular-nums">{num(e.receivable)}</td>
                    <td className="tabular-nums">{num(e.payable)}</td>
                    <td className={`tabular-nums font-medium ${e.net < 0 ? 'text-destructive' : 'text-success'}`}>{num(e.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}

// Single-series cash trajectory: an area under the projected-balance line, zero baseline drawn, trough dotted.
function ForecastChart({ periods }: { periods: Period[] }) {
  const { t } = useLang();
  if (periods.length < 2) return null;
  const W = 720, H = 140, PL = 4, PR = 4, PT = 8, PB = 16;
  const vals = periods.map((p) => p.projected_balance);
  const maxV = Math.max(...vals, 0);
  const minV = Math.min(...vals, 0);
  const span = maxV - minV || 1;
  const x = (i: number) => PL + (i * (W - PL - PR)) / (periods.length - 1);
  const y = (v: number) => PT + (1 - (v - minV) / span) * (H - PT - PB);
  const zeroY = y(0);
  const line = periods.map((p, i) => `${x(i).toFixed(1)},${y(p.projected_balance).toFixed(1)}`).join(' ');
  const area = `${x(0).toFixed(1)},${zeroY.toFixed(1)} ${line} ${x(periods.length - 1).toFixed(1)},${zeroY.toFixed(1)}`;
  const troughIdx = vals.indexOf(Math.min(...vals));

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[560px] text-info" role="img" aria-label={t('fnx.treasury.chart_aria')}>
        <polygon points={area} className="fill-info/10" />
        <line x1={PL} x2={W - PR} y1={zeroY} y2={zeroY} className="stroke-border" strokeWidth={1} strokeDasharray="3 3" />
        <polyline points={line} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {periods.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.projected_balance)} r={i === troughIdx ? 3.5 : 2} className={i === troughIdx ? 'fill-warning' : 'fill-info'} />
        ))}
        {periods.map((p, i) => (i % 2 === 0 ? <text key={`t${i}`} x={x(i)} y={H - 4} textAnchor="middle" className="fill-muted-foreground text-[9px]">{p.week === 0 ? '0' : `+${p.week}`}</text> : null))}
      </svg>
    </div>
  );
}
