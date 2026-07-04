'use client';

import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Activity, ShieldAlert, ShieldCheck, Users, Wallet, Receipt, Clock, TrendingUp, FolderKanban, BellRing } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { statusVariant } from '@/components/ui';

const cpiTone = (v: number | null): 'success' | 'warning' | 'danger' | 'default' =>
  v == null ? 'default' : v >= 1 ? 'success' : v >= 0.9 ? 'warning' : 'danger';

export default function PortfolioPage() {
  const { t } = useLang();
  const router = useRouter();
  const q = useQuery<any>({ queryKey: ['projects', 'portfolio'], queryFn: () => api('/api/projects/portfolio') });
  const capQ = useQuery<any>({ queryKey: ['projects', 'capacity'], queryFn: () => api('/api/projects/resources/capacity?months=6') });
  const fcQ = useQuery<any>({ queryKey: ['projects', 'forecast'], queryFn: () => api('/api/projects/forecast?months=6') });
  const progQ = useQuery<any>({ queryKey: ['projects', 'programs'], queryFn: () => api('/api/projects/programs') });
  const riskQ = useQuery<any>({ queryKey: ['projects', 'top-risks'], queryFn: () => api('/api/projects/risks/top') });
  const d = q.data;
  const fc = fcQ.data;
  const fcMax = Math.max(1, ...((fc?.billing?.monthly ?? []).map((m: any) => m.total_expected)));
  // Time-phased capacity heatmap: green ≤ 80, amber ≤ 100, red > 100 (over-booked in that month).
  const heatTone = (pct: number) => pct > 100 ? 'bg-destructive/80 text-destructive-foreground' : pct >= 80 ? 'bg-warning/70 text-warning-foreground dark:text-warning' : pct > 0 ? 'bg-success/40' : 'bg-muted/40 text-muted-foreground';
  const f = d?.funnel;
  const funnelMax = Math.max(1, f?.open_count ?? 0, f?.won_count ?? 0, f?.converted_count ?? 0);
  const funnelRows = [
    { label: t('pj.funnel_open'), count: f?.open_count ?? 0, amount: f?.open_amount ?? 0, color: 'var(--chart-2)' },
    { label: t('pj.funnel_won'), count: f?.won_count ?? 0, amount: f?.won_amount ?? 0, color: 'var(--chart-3)' },
    { label: t('pj.funnel_converted'), count: f?.converted_count ?? 0, amount: null as number | null, color: 'var(--primary)' },
  ];

  return (
    <div>
      <PageHeader
        title={t('pj.portfolio_title')}
        description={t('pj.portfolio_desc')}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => router.push('/projects/action-center')}><BellRing className="size-4" /> {t('pj.btn_action_center')}</Button>
            <Button variant="outline" onClick={() => router.push('/projects')}><FolderKanban className="size-4" /> {t('pj.btn_project_register')}</Button>
          </div>
        }
      />

      <StateView q={q}>
        <div className="space-y-4">
          {/* health band */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('pj.stat_portfolio_cpi')} value={d?.totals?.cpi ?? '—'} icon={Activity} tone={cpiTone(d?.totals?.cpi)} hint={t('pj.n_projects', { n: d?.count ?? 0 })} />
            <StatCard label={t('pj.stat_on_track')} value={d?.health?.on_track ?? 0} icon={ShieldCheck} tone="success" />
            <StatCard label={t('pj.stat_at_risk')} value={d?.health?.at_risk ?? 0} icon={ShieldAlert} tone={(d?.health?.at_risk ?? 0) > 0 ? 'danger' : 'default'} hint={t('pj.at_risk_hint')} />
            <StatCard label={t('pj.stat_over_allocated')} value={d?.capacity?.over_allocated_count ?? 0} icon={Users} tone={(d?.capacity?.over_allocated_count ?? 0) > 0 ? 'warning' : 'default'} hint=">100% allocation" />
          </div>

          {/* financial band */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('pj.stat_total_contract')} value={baht(d?.financials?.contract)} icon={Wallet} tone="primary" />
            <StatCard label={t('pj.stat_billed')} value={baht(d?.financials?.billed)} icon={Receipt} tone="default" />
            <StatCard label={t('pj.stat_wip_full')} value={baht(d?.financials?.wip)} icon={Clock} tone="info" />
            <StatCard label={t('pj.stat_margin')} value={baht(d?.financials?.margin)} icon={TrendingUp} tone={(d?.financials?.margin ?? 0) < 0 ? 'danger' : 'success'} />
          </div>

          <div className="grid gap-4 lg:grid-cols-5">
            {/* pipeline → delivery funnel */}
            <Card className="gap-4 p-5 lg:col-span-3">
              <h3 className="text-base font-semibold">{t('pj.funnel_title')}</h3>
              <div className="space-y-3">
                {funnelRows.map((r) => (
                  <div key={r.label}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{r.label}</span>
                      <span className="tabular font-medium">{r.count}{r.amount != null ? <span className="ml-2 text-xs text-muted-foreground">{baht(r.amount)}</span> : null}</span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full" style={{ width: `${(r.count / funnelMax) * 100}%`, background: r.color }} />
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            {/* at-risk projects */}
            <Card className="gap-3 p-5 lg:col-span-2">
              <h3 className="text-base font-semibold">{t('pj.at_risk_title')}</h3>
              {(d?.at_risk?.length ?? 0) === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 py-6 text-center text-sm text-muted-foreground">
                  <ShieldCheck className="size-8 text-success" />
                  {t('pj.all_healthy')}
                </div>
              ) : (
                <ul className="space-y-2">
                  {d.at_risk.slice(0, 8).map((r: any) => (
                    <li key={r.project_code}>
                      <button onClick={() => router.push(`/projects/${encodeURIComponent(r.project_code)}`)} className="flex w-full items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2 text-left text-sm hover:bg-muted/50">
                        <span className="min-w-0 truncate"><span className="font-medium">{r.project_code}</span> <span className="text-muted-foreground">{r.name}</span></span>
                        <span className="flex shrink-0 gap-1">
                          {r.cpi != null && <Badge variant={r.cpi < 0.9 ? 'destructive' : 'muted'}>CPI {r.cpi}</Badge>}
                          {r.spi != null && <Badge variant={r.spi < 0.9 ? 'destructive' : 'muted'}>SPI {r.spi}</Badge>}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          {/* project health table */}
          <div>
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('pj.project_health_heading')}</h3>
            <DataTable
              rows={d?.projects ?? []}
              rowKey={(r: any) => r.project_code}
              onRowClick={(r: any) => router.push(`/projects/${encodeURIComponent(r.project_code)}`)}
              columns={[
                { key: 'project_code', label: t('pj.col_code') },
                { key: 'name', label: t('pj.col_project'), render: (r: any) => `${r.name}${r.customer_name ? ` · ${r.customer_name}` : ''}` },
                { key: 'cpi', label: 'CPI', align: 'right', render: (r: any) => <span className={`tabular ${r.cpi != null && r.cpi < 0.9 ? 'font-medium text-destructive' : r.cpi != null && r.cpi >= 1 ? 'text-success' : ''}`}>{r.cpi ?? '—'}</span> },
                { key: 'spi', label: 'SPI', align: 'right', render: (r: any) => <span className={`tabular ${r.spi != null && r.spi < 0.9 ? 'font-medium text-destructive' : r.spi != null && r.spi >= 1 ? 'text-success' : ''}`}>{r.spi ?? '—'}</span> },
                { key: 'wip', label: 'WIP', align: 'right', render: (r: any) => <span className="tabular">{baht(r.wip)}</span> },
                { key: 'margin', label: t('pj.col_margin'), align: 'right', render: (r: any) => <span className={`tabular ${r.margin < 0 ? 'text-destructive' : ''}`}>{baht(r.margin)}</span> },
                { key: 'on_track', label: t('pj.col_health'), render: (r: any) => r.on_track ? <Badge variant="success">on track</Badge> : (r.cpi == null && r.spi == null) ? <Badge variant="muted">no data</Badge> : <Badge variant="destructive">at risk</Badge> },
                { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              ]}
              emptyState={{ icon: FolderKanban, title: t('pj.empty_projects_title'), description: t('pj.empty_portfolio_desc') }}
            />
          </div>

          {/* top risks across the portfolio (B4, PROJ-08) */}
          {!!riskQ.data?.top?.length && (
            <Card className="gap-3 p-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">{t('pj.top_risks_title')}</h3>
                <div className="flex gap-2 text-xs">
                  <Badge variant="muted">{t('pj.open_count', { n: riskQ.data.open_count })}</Badge>
                  {riskQ.data.high_count > 0 && <Badge variant="destructive">{t('pj.high_count', { n: riskQ.data.high_count })}</Badge>}
                  {riskQ.data.unmitigated_high_count > 0 && <Badge variant="warning">{t('pj.high_unmit_count', { n: riskQ.data.unmitigated_high_count })}</Badge>}
                </div>
              </div>
              <DataTable
                rows={riskQ.data.top}
                rowKey={(r: any) => r.id}
                onRowClick={(r: any) => r.project_code && router.push(`/projects/${encodeURIComponent(r.project_code)}?tab=risks`)}
                columns={[
                  { key: 'rag', label: t('pj.col_level'), sortable: false, render: (r: any) => <Badge variant={r.rag === 'red' ? 'destructive' : r.rag === 'amber' ? 'warning' : 'success'}>{r.rag}</Badge> },
                  { key: 'project_code', label: t('pj.col_project'), render: (r: any) => `${r.project_code ?? '—'}${r.project_name ? ` · ${r.project_name}` : ''}` },
                  { key: 'kind', label: t('pj.col_type'), render: (r: any) => r.kind === 'issue' ? t('pj.kind_issue') : t('pj.kind_risk') },
                  { key: 'title', label: t('pj.col_title') },
                  { key: 'score', label: t('pj.col_score'), align: 'right', render: (r: any) => <span className="tabular">{r.score}</span> },
                  { key: 'owner', label: t('pj.col_owner'), render: (r: any) => r.owner ?? '—' },
                  { key: 'mitigation', label: t('pj.col_mitigation'), render: (r: any) => r.mitigation ? <span className="text-xs">{r.mitigation}</span> : <span className="text-xs text-destructive">{t('pj.none_yet')}</span> },
                ]}
                emptyState={{ icon: ShieldCheck, title: t('pj.no_open_risks_title'), description: t('pj.no_open_risks_desc') }}
              />
            </Card>
          )}

          {/* time-phased resource capacity heatmap (PPM upgrade) */}
          {!!capQ.data?.resources?.length && (
            <Card className="gap-3 p-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">{t('pj.capacity_calendar_title')}</h3>
                {capQ.data.over_allocated_count > 0 && <Badge variant="destructive">{t('pj.n_over_allocated', { n: capQ.data.over_allocated_count })}</Badge>}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-separate border-spacing-1 text-xs">
                  <thead><tr><th className="text-left font-medium text-muted-foreground">{t('pj.col_resource')}</th>{(capQ.data.horizon ?? []).map((m: string) => <th key={m} className="px-1 text-center font-medium text-muted-foreground">{m.slice(2)}</th>)}</tr></thead>
                  <tbody>
                    {capQ.data.resources.slice(0, 12).map((r: any) => (
                      <tr key={r.resource_name}>
                        <td className="whitespace-nowrap pr-2 font-medium">{r.resource_name}</td>
                        {r.months.map((c: any) => (
                          <td key={c.month} className={`rounded px-1.5 py-1 text-center tabular ${heatTone(c.allocated_pct)}`} title={`${c.month}: ${c.allocated_pct}%`}>{c.allocated_pct || ''}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* programs (cross-project critical path, PMO-4) */}
          {!!progQ.data?.programs?.length && (
            <Card className="gap-3 p-5">
              <h3 className="text-sm font-semibold">{t('pj.programs_title')}</h3>
              <ul className="divide-y divide-border/50">
                {progQ.data.programs.map((pr: any) => (
                  <li key={pr.program_code}>
                    <button onClick={() => router.push(`/projects/program/${encodeURIComponent(pr.program_code)}`)} className="flex w-full items-center justify-between gap-2 py-2 text-left text-sm hover:opacity-80">
                      <span className="font-medium">{pr.program_code}</span>
                      <span className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{t('pj.n_projects', { n: pr.member_count })}</span>
                        <span>{t('pj.days', { n: pr.program_duration_days })}</span>
                        <Badge variant="destructive">{t('pj.n_critical', { n: pr.critical_path?.length ?? 0 })}</Badge>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* forward billings/cash forecast (PMO-2): committed contractual billing + probability-weighted pipeline */}
          {!!fc?.billing?.monthly?.length && (
            <Card className="gap-3 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{t('pj.forecast_title')}</h3>
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge variant="info">{t('pj.committed_amt', { amount: baht(fc.billing.committed_total) })}</Badge>
                  <Badge variant="muted">{t('pj.weighted_pipeline_amt', { amount: baht(fc.billing.weighted_pipeline_total) })}</Badge>
                  <Badge variant="success">{t('pj.total_forecast_amt', { amount: baht(fc.billing.expected_total) })}</Badge>
                  {fc.resourcing?.peak_total_demand_fte != null && <Badge variant="warning">{t('pj.peak_fte', { n: fc.resourcing.peak_total_demand_fte })}</Badge>}
                </div>
              </div>
              <div className="space-y-2">
                {fc.billing.monthly.map((m: any) => (
                  <div key={m.month}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{m.month}{(() => { const r = (fc.resourcing?.monthly ?? []).find((x: any) => x.month === m.month); return r?.total_demand_fte ? <span className="ml-2 text-muted-foreground/70">{t('pj.demand_fte', { fte: r.total_demand_fte })}{r.pipeline_demand_fte > 0 ? t('pj.demand_breakdown', { committed: r.committed_demand_fte, pipeline: r.pipeline_demand_fte }) : ''}</span> : null; })()}</span>
                      <span className="tabular font-medium">{baht(m.total_expected)}</span>
                    </div>
                    {/* committed (solid) + weighted pipeline (lighter) stacked bar */}
                    <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full" style={{ width: `${(m.committed_billing / fcMax) * 100}%`, background: 'var(--info)' }} title={t('pj.committed_amt', { amount: baht(m.committed_billing) })} />
                      <div className="h-full opacity-50" style={{ width: `${(m.weighted_pipeline / fcMax) * 100}%`, background: 'var(--chart-3)' }} title={t('pj.weighted_pipeline_title', { amount: baht(m.weighted_pipeline) })} />
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{t('pj.forecast_footnote', { rev: baht(fc.rev_per_fte_month) })}</p>
            </Card>
          )}
        </div>
      </StateView>
    </div>
  );
}
