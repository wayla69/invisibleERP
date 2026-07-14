'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Activity, ShieldAlert, ShieldCheck, Users, Wallet, Receipt, Clock, TrendingUp, FolderKanban, BellRing, Scale, Plus, Lock, Trash2, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
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

          {/* Portfolio selection scenarios (PPM Wave P4, PROJ-25) */}
          <PortfolioScenarios projects={d?.projects ?? []} />

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

// Portfolio selection scenarios (PPM Wave P4, PROJ-25) — a what-if funding surface. Inlined in this already-
// 'use client' page so it inherits the client boundary (no new client-first file → use-client ratchet flat).
// Model candidate projects into a named scenario with a budget envelope + priorities, watch the selected
// total vs the envelope, then COMMIT the GO-set as a maker-checker decision (a different user must commit;
// an over-envelope commit needs an exec override reason). Read-only aggregation — no project row is mutated.
function PortfolioScenarios({ projects }: { projects: any[] }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const list = useQuery<any>({ queryKey: ['projects', 'portfolio-scenarios'], queryFn: () => api('/api/projects/portfolio/scenarios') });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [envelope, setEnvelope] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const detail = useQuery<any>({ queryKey: ['projects', 'portfolio-scenario', sel], queryFn: () => api(`/api/projects/portfolio/scenarios/${sel}`), enabled: !!sel });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['projects', 'portfolio-scenarios'] }); if (sel) qc.invalidateQueries({ queryKey: ['projects', 'portfolio-scenario', sel] }); };

  const create = useMutation({
    mutationFn: () => api('/api/projects/portfolio/scenarios', { method: 'POST', body: JSON.stringify({ name, budget_envelope: envelope ? Number(envelope) : undefined }) }),
    onSuccess: (r: any) => { notifySuccess(t('pj.pf_created', { no: r.scenario_no })); setCreating(false); setName(''); setEnvelope(''); setSel(r.scenario_no); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const [pcode, setPcode] = useState('');
  const [prio, setPrio] = useState('0');
  const addItem = useMutation({
    mutationFn: (decision: 'include' | 'exclude') => api(`/api/projects/portfolio/scenarios/${sel}/items`, { method: 'POST', body: JSON.stringify({ project_code: pcode, decision, priority_score: Number(prio) || 0 }) }),
    onSuccess: () => { setPcode(''); setPrio('0'); refresh(); }, onError: (e: any) => notifyError(e.message),
  });
  const removeItem = useMutation({ mutationFn: (code: string) => api(`/api/projects/portfolio/scenarios/${sel}/items/${encodeURIComponent(code)}`, { method: 'DELETE' }), onSuccess: refresh, onError: (e: any) => notifyError(e.message) });

  const [override, setOverride] = useState('');
  const commit = useMutation({
    mutationFn: () => api(`/api/projects/portfolio/scenarios/${sel}/commit`, { method: 'POST', body: JSON.stringify(override.trim() ? { override: true, override_reason: override.trim() } : {}) }),
    onSuccess: () => { notifySuccess(t('pj.pf_committed')); setOverride(''); refresh(); }, onError: (e: any) => notifyError(e.message),
  });

  const d = detail.data;
  const draft = d?.status === 'draft';
  const overEnv = d?.totals?.over_envelope;

  return (
    <Card className="gap-3 p-5">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><Scale className="size-4" /> {t('pj.pf_title')}</h3>
        <Button size="sm" variant="outline" onClick={() => setCreating(true)}><Plus className="size-4" /> {t('pj.pf_new')}</Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('pj.pf_desc')}</p>

      {(list.data?.scenarios?.length ?? 0) === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">{t('pj.pf_empty')}</div>
      ) : (
        <ul className="divide-y divide-border/50">
          {list.data.scenarios.map((s: any) => (
            <li key={s.scenario_no}>
              <button onClick={() => setSel(s.scenario_no)} className="flex w-full items-center justify-between gap-2 py-2 text-left text-sm hover:opacity-80">
                <span className="min-w-0 truncate"><span className="font-medium">{s.scenario_no}</span> <span className="text-muted-foreground">{s.name}</span></span>
                <span className="flex shrink-0 items-center gap-2 text-xs">
                  <span className="text-muted-foreground">{t('pj.pf_n_selected', { n: s.included_count })}</span>
                  {s.budget_envelope != null && <Badge variant="muted">{baht(s.budget_envelope)}</Badge>}
                  {s.status === 'committed' ? <Badge variant="success"><Lock className="mr-1 size-3" />{t('pj.pf_committed_badge')}</Badge> : <Badge variant="warning">{t('pj.pf_draft')}</Badge>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Create-scenario dialog */}
      <Dialog open={creating} onOpenChange={(o) => !o && setCreating(false)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('pj.pf_new')}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div><label className="text-xs text-muted-foreground">{t('pj.pf_name')}</label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('pj.pf_name')} /></div>
            <div><label className="text-xs text-muted-foreground">{t('pj.pf_envelope')}</label><Input type="number" value={envelope} onChange={(e) => setEnvelope(e.target.value)} placeholder={t('pj.pf_envelope_hint')} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>{t('pj.btn_close')}</Button>
            <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>{t('pj.pf_create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Scenario detail / manage dialog */}
      <Dialog open={!!sel} onOpenChange={(o) => !o && setSel(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>{d ? `${d.scenario_no} · ${d.name}` : ''}</DialogTitle></DialogHeader>
          {d && (
            <div className="grid gap-3">
              {/* totals band */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="rounded-lg border border-border/60 p-2 text-center"><div className="text-xs text-muted-foreground">{t('pj.pf_selected')}</div><div className="tabular font-medium">{d.totals.included_count}</div></div>
                <div className="rounded-lg border border-border/60 p-2 text-center"><div className="text-xs text-muted-foreground">{t('pj.pf_sel_budget')}</div><div className="tabular font-medium">{baht(d.totals.selected_budget)}</div></div>
                <div className="rounded-lg border border-border/60 p-2 text-center"><div className="text-xs text-muted-foreground">{t('pj.pf_sel_margin')}</div><div className="tabular font-medium">{baht(d.totals.selected_margin)}</div></div>
                <div className={`rounded-lg border p-2 text-center ${overEnv ? 'border-destructive/60' : 'border-border/60'}`}><div className="text-xs text-muted-foreground">{t('pj.pf_headroom')}</div><div className={`tabular font-medium ${overEnv ? 'text-destructive' : 'text-success'}`}>{d.totals.budget_headroom != null ? baht(d.totals.budget_headroom) : '—'}</div></div>
              </div>
              {overEnv && <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{t('pj.pf_over_envelope', { amount: baht(d.totals.over_by) })}</div>}
              {d.override_reason && <div className="rounded-lg bg-warning/10 px-3 py-2 text-xs">{t('pj.pf_override_note', { reason: d.override_reason })}</div>}

              {/* candidate rows */}
              <div className="max-h-56 overflow-y-auto rounded-lg border border-border/60">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground"><tr className="border-b border-border/60"><th className="px-2 py-1 text-left">{t('pj.col_project')}</th><th className="px-2 py-1 text-right">{t('pj.pf_priority')}</th><th className="px-2 py-1 text-right">{t('pj.col_margin')}</th><th className="px-2 py-1 text-center">{t('pj.pf_decision')}</th>{draft && <th className="w-8" />}</tr></thead>
                  <tbody>
                    {[...(d.included ?? []), ...(d.excluded ?? [])].map((it: any) => (
                      <tr key={it.project_code} className="border-b border-border/30">
                        <td className="px-2 py-1"><span className="font-medium">{it.project_code}</span> <span className="text-muted-foreground">{it.name}</span></td>
                        <td className="px-2 py-1 text-right tabular">{it.priority_score}</td>
                        <td className={`px-2 py-1 text-right tabular ${it.margin < 0 ? 'text-destructive' : ''}`}>{baht(it.margin)}</td>
                        <td className="px-2 py-1 text-center">{it.decision === 'include' ? <Badge variant="success">{t('pj.pf_include')}</Badge> : <Badge variant="muted">{t('pj.pf_exclude')}</Badge>}</td>
                        {draft && <td className="px-1 text-center"><button onClick={() => removeItem.mutate(it.project_code)} className="text-muted-foreground hover:text-destructive"><Trash2 className="size-3.5" /></button></td>}
                      </tr>
                    ))}
                    {[...(d.included ?? []), ...(d.excluded ?? [])].length === 0 && <tr><td colSpan={5} className="px-2 py-3 text-center text-xs text-muted-foreground">{t('pj.pf_no_candidates')}</td></tr>}
                  </tbody>
                </table>
              </div>

              {draft ? (
                <>
                  {/* add candidate */}
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="min-w-40 flex-1">
                      <label className="text-xs text-muted-foreground">{t('pj.pf_add_candidate')}</label>
                      <select value={pcode} onChange={(e) => setPcode(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                        <option value="">{t('pj.pf_pick_project')}</option>
                        {projects.map((p: any) => <option key={p.project_code} value={p.project_code}>{p.project_code} · {p.name}</option>)}
                      </select>
                    </div>
                    <div className="w-24"><label className="text-xs text-muted-foreground">{t('pj.pf_priority')}</label><Input type="number" value={prio} onChange={(e) => setPrio(e.target.value)} /></div>
                    <Button size="sm" variant="outline" disabled={!pcode || addItem.isPending} onClick={() => addItem.mutate('include')}>{t('pj.pf_include')}</Button>
                    <Button size="sm" variant="ghost" disabled={!pcode || addItem.isPending} onClick={() => addItem.mutate('exclude')}>{t('pj.pf_exclude')}</Button>
                  </div>
                  {/* commit (maker-checker; override reason if over envelope) */}
                  {overEnv && <div><label className="text-xs text-muted-foreground">{t('pj.pf_override_reason')}</label><Input value={override} onChange={(e) => setOverride(e.target.value)} placeholder={t('pj.pf_override_hint')} /></div>}
                  <p className="text-xs text-muted-foreground">{t('pj.pf_commit_hint')}</p>
                </>
              ) : (
                <div className="flex items-center gap-2 text-sm text-success"><CheckCircle2 className="size-4" /> {t('pj.pf_committed_by', { who: d.committed_by ?? '' })}</div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSel(null)}>{t('pj.btn_close')}</Button>
            {draft && <Button disabled={commit.isPending || (d?.totals?.included_count ?? 0) === 0 || (overEnv && !override.trim())} onClick={() => commit.mutate()}><Lock className="size-4" /> {t('pj.pf_commit')}</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
