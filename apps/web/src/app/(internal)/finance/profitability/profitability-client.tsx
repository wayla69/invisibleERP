'use client';

// Segment profitability client island (docs/35 Phase 5). P&L by branch / cost centre / project from the
// multi-dimensional GL: a dimension switcher, totals + a reconcile-to-P&L badge, a net-contribution bar
// chart, and the per-segment P&L matrix (revenue → COGS → gross → opex → net + margin + contribution).
// Read-only. Bars use design-system tokens (single measure ⇒ no legend; green positive / red negative).
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { useLang } from '@/lib/i18n';
import { baht } from '@/lib/format';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { Card } from '@/components/ui/card';

type Dim = 'branch' | 'cost_center' | 'project';
interface Segment { key: string; label: string; revenue: number; cogs: number; gross_profit: number; opex: number; net: number; gross_margin_pct: number | null; net_margin_pct: number | null; contribution_pct: number | null }
interface Prof {
  by: Dim; from: string; to: string; segment_count: number; segments: Segment[];
  totals: { revenue: number; gross_profit: number; net: number };
  pl: { revenue: number; net_income: number } | null; reconciled: boolean | null;
}

const DIMS: Dim[] = ['branch', 'cost_center', 'project'];

export function ProfitabilityClient({ initialData }: { initialData: Prof | null }) {
  const { t } = useLang();
  const [by, setBy] = useState<Dim>('branch');
  const [data, setData] = useState<Prof | null>(initialData);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (dim: Dim) => {
    setLoading(true);
    try { setData(await api<Prof>(`/api/finance/metrics/profitability?by=${dim}`)); } catch { /* keep last good */ } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(by); }, [by, load]);

  return (
    <div>
      <PageHeader title={t('fnx.prof.title')} description={t('fnx.prof.subtitle')} />

      {/* Dimension switcher */}
      <div className="mb-4 inline-flex rounded-lg border border-border p-0.5 text-sm">
        {DIMS.map((d) => (
          <button key={d} type="button" onClick={() => setBy(d)}
            className={`rounded-md px-3 py-1 ${by === d ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
            {t(`fnx.prof.by_${d}`)}
          </button>
        ))}
      </div>

      {!data ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">{t('fnx.prof.load_error')}</Card>
      ) : (
        <div className={loading ? 'opacity-60 transition-opacity' : ''}>
          <div className="mb-4 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
            <StatCard label={t('fnx.prof.total_revenue')} value={baht(data.totals.revenue)} tone="info" />
            <StatCard label={t('fnx.prof.total_net')} value={baht(data.totals.net)} tone={data.totals.net >= 0 ? 'success' : 'danger'} />
            <Card className="justify-center p-3">
              <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${data.reconciled ? 'text-success' : 'text-warning-foreground dark:text-warning'}`}>
                {data.reconciled ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}
                {data.reconciled ? t('fnx.prof.reconciled') : t('fnx.prof.not_reconciled')}
              </span>
            </Card>
          </div>

          {data.segments.length === 0 ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">{t('fnx.prof.no_segments')}</Card>
          ) : (
            <>
              {/* Net contribution bars */}
              <Card className="mb-4 gap-2 p-4">
                <h3 className="text-sm font-semibold text-muted-foreground">{t('fnx.prof.contribution')}</h3>
                <ContributionBars segments={data.segments} unassignedLabel={t('fnx.prof.unassigned')} />
              </Card>

              {/* P&L matrix */}
              <Card className="gap-0 overflow-x-auto p-0">
                <table className="w-full min-w-[720px] text-sm">
                  <thead><tr className="border-b border-border text-xs text-muted-foreground [&>th]:px-3 [&>th]:py-2 [&>th]:text-right [&>th:first-child]:text-left">
                    <th>{t('fnx.prof.col_segment')}</th><th>{t('fnx.prof.col_revenue')}</th><th>{t('fnx.prof.col_cogs')}</th><th>{t('fnx.prof.col_gross')}</th><th>{t('fnx.prof.col_opex')}</th><th>{t('fnx.prof.col_net')}</th><th>{t('fnx.prof.col_margin')}</th><th>{t('fnx.prof.col_contrib')}</th>
                  </tr></thead>
                  <tbody>
                    {data.segments.map((s) => (
                      <tr key={s.key} className="border-b border-border/50 [&>td]:px-3 [&>td]:py-2 [&>td]:text-right [&>td:first-child]:text-left [&>td]:tabular-nums">
                        <td className="font-medium">{s.key === '__unassigned__' ? t('fnx.prof.unassigned') : s.label}</td>
                        <td>{baht(s.revenue)}</td>
                        <td className="text-muted-foreground">{baht(s.cogs)}</td>
                        <td>{baht(s.gross_profit)}</td>
                        <td className="text-muted-foreground">{baht(s.opex)}</td>
                        <td className={`font-medium ${s.net < 0 ? 'text-destructive' : ''}`}>{baht(s.net)}</td>
                        <td className={s.net_margin_pct != null && s.net_margin_pct < 0 ? 'text-destructive' : ''}>{s.net_margin_pct != null ? `${s.net_margin_pct}%` : '—'}</td>
                        <td className="text-muted-foreground">{s.contribution_pct != null ? `${s.contribution_pct}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr className="border-t-2 border-border font-semibold [&>td]:px-3 [&>td]:py-2 [&>td]:text-right [&>td:first-child]:text-left [&>td]:tabular-nums">
                    <td>{t('fnx.prof.total_revenue')}</td><td>{baht(data.totals.revenue)}</td><td /><td>{baht(data.totals.gross_profit)}</td><td /><td>{baht(data.totals.net)}</td><td /><td />
                  </tr></tfoot>
                </table>
              </Card>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Horizontal net-contribution bars — single measure (net), green positive / red negative, direct-labelled.
function ContributionBars({ segments, unassignedLabel }: { segments: Segment[]; unassignedLabel: string }) {
  const max = Math.max(1, ...segments.map((s) => Math.abs(s.net)));
  return (
    <div className="space-y-1.5">
      {segments.map((s) => {
        const pctW = (Math.abs(s.net) / max) * 100;
        const neg = s.net < 0;
        return (
          <div key={s.key} className="flex items-center gap-2 text-xs">
            <span className="w-40 shrink-0 truncate text-muted-foreground">{s.key === '__unassigned__' ? unassignedLabel : s.label}</span>
            <div className="relative h-4 flex-1 rounded bg-muted/40">
              <div className={`absolute inset-y-0 left-0 rounded ${neg ? 'bg-destructive/70' : 'bg-success/70'}`} style={{ width: `${pctW}%` }} />
            </div>
            <span className={`w-24 shrink-0 text-right tabular-nums ${neg ? 'text-destructive' : ''}`}>{baht(s.net)}</span>
          </div>
        );
      })}
    </div>
  );
}
