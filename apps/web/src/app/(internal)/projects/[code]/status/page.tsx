'use client';

import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ResponsiveContainer, ComposedChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, Legend } from 'recharts';
import { ArrowLeft, Printer } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StateView } from '@/components/state-view';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Activity } from 'lucide-react';

const ragBadge: Record<string, 'success' | 'warning' | 'destructive' | 'muted'> = { green: 'success', amber: 'warning', red: 'destructive', no_data: 'muted' };
const RAG_LABEL_KEY: Record<string, string> = { green: 'pj.rag_green', amber: 'pj.rag_amber', red: 'pj.rag_red', no_data: 'pj.rag_no_data' };

// Period governance / status pack (PMO-3) — the auto-assembled, print-friendly project status report.
export default function ProjectStatusPage() {
  const { t } = useLang();
  const router = useRouter();
  const code = decodeURIComponent(String(useParams().code ?? ''));
  const q = useQuery<any>({ queryKey: ['proj', code, 'governance-pack'], queryFn: () => api(`/api/projects/${code}/governance-pack`) });
  const pk = q.data?.project;
  const trend = (pk?.health_trend ?? []).map((h: any) => ({ date: h.snapshot_date, CPI: h.cpi, SPI: h.spi }));

  return (
    <div>
      <PageHeader
        title={<span className="flex items-center gap-2">{t('pj.status_report_title')} {pk && <Badge variant={ragBadge[pk.rag]}>{t(RAG_LABEL_KEY[pk.rag] ?? pk.rag)}</Badge>}</span>}
        description={<span>{code}{pk?.name ? ` · ${pk.name}` : ''}{pk?.customer_name ? ` · ${pk.customer_name}` : ''}{q.data?.period ? ` · ${t('pj.period_label', { period: q.data.period })}` : ''}</span>}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => router.push(`/projects/${encodeURIComponent(code)}`)}><ArrowLeft className="size-4" /> {t('pj.btn_back')}</Button>
            <Button variant="outline" onClick={() => window.print()}><Printer className="size-4" /> {t('pj.btn_print')}</Button>
          </div>
        }
      />

      <StateView q={q}>
        <div className="space-y-4">
          {/* headline */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('pj.stat_progress')} value={`${pk?.pct_complete ?? 0}%`} icon={Activity} tone="primary" />
            <StatCard label="CPI / SPI" value={`${pk?.evm?.cpi ?? '—'} / ${pk?.evm?.spi ?? '—'}`} icon={Activity} tone={pk?.rag === 'red' ? 'danger' : pk?.rag === 'amber' ? 'warning' : 'success'} />
            <StatCard label={t('pj.stat_margin')} value={baht(pk?.margin ?? 0)} icon={Activity} tone={(pk?.margin ?? 0) < 0 ? 'danger' : 'success'} hint={t('pj.wip_hint', { amount: baht(pk?.wip ?? 0) })} />
            <StatCard label={t('pj.stat_billed_contract')} value={baht(pk?.billed_to_date ?? 0)} icon={Activity} hint={t('pj.contract_amount_label', { amount: baht(pk?.contract_amount ?? 0) })} />
          </div>

          {/* EVM + baseline variance */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="gap-3 p-5">
              <h3 className="text-sm font-semibold">{t('pj.evm_title')}</h3>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                {[['BAC', pk?.evm?.bac], ['PV', pk?.evm?.ev], ['EV', pk?.evm?.ev], ['AC', pk?.evm?.ac], ['EAC', pk?.evm?.eac], [t('pj.ev_cv'), pk?.evm?.cost_variance], [t('pj.ev_sv'), pk?.evm?.schedule_variance]].map(([k, v]) => (
                  <div key={String(k)} className="flex justify-between border-b border-border/40 py-0.5"><dt className="text-muted-foreground">{k}</dt><dd className="tabular font-medium">{baht(Number(v ?? 0))}</dd></div>
                ))}
              </dl>
            </Card>
            <Card className="gap-3 p-5">
              <h3 className="text-sm font-semibold">{t('pj.baseline_variance_title')}</h3>
              {pk?.baseline?.active ? (
                <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                  <div className="flex justify-between border-b border-border/40 py-0.5"><dt className="text-muted-foreground">{t('pj.baseline_bac_label')}</dt><dd className="tabular font-medium">{baht(pk.baseline.active.baseline_bac)}</dd></div>
                  <div className="flex justify-between border-b border-border/40 py-0.5"><dt className="text-muted-foreground">{t('pj.bac_variance')}</dt><dd className={`tabular font-medium ${(pk.baseline.variance?.bac_delta ?? 0) > 0 ? 'text-destructive' : ''}`}>{baht(pk.baseline.variance?.bac_delta ?? 0)}{pk.baseline.variance?.bac_pct != null ? ` (${pk.baseline.variance.bac_pct}%)` : ''}</dd></div>
                  <div className="flex justify-between border-b border-border/40 py-0.5"><dt className="text-muted-foreground">{t('pj.baseline_duration_delta')}</dt><dd className="tabular font-medium">{t('pj.days', { n: pk.baseline.variance?.duration_delta ?? 0 })}</dd></div>
                </dl>
              ) : <p className="text-sm text-muted-foreground">{t('pj.no_baseline_short')}</p>}
            </Card>
          </div>

          {/* health trend */}
          {trend.length > 0 && (
            <Card className="gap-3 p-5">
              <h3 className="text-sm font-semibold">{t('pj.health_trend_cpispi')}</h3>
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} width={40} domain={[0, 'auto']} />
                  <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid var(--border)', background: 'var(--popover)', fontSize: 12 }} />
                  <Legend />
                  <Line type="monotone" dataKey="CPI" stroke="var(--chart-2)" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="SPI" stroke="var(--chart-3)" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </Card>
          )}

          {/* open high risks + milestones */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="gap-3 p-5">
              <h3 className="text-sm font-semibold">{t('pj.open_high_risks', { open: pk?.risks?.summary?.high_open ?? 0, unmit: pk?.risks?.summary?.unmitigated_high ?? 0 })}</h3>
              {(pk?.risks?.open_high?.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground">{t('pj.no_open_high_risks')}</p> : (
                <ul className="space-y-1.5 text-sm">
                  {pk.risks.open_high.map((r: any) => (
                    <li key={r.id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate">{r.title}{r.owner ? <span className="text-muted-foreground"> · {r.owner}</span> : ''}</span>
                      <span className="flex shrink-0 gap-1"><Badge variant="destructive">{r.score}</Badge>{!r.mitigation && <Badge variant="warning">{t('pj.no_plan')}</Badge>}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card className="gap-3 p-5">
              <h3 className="text-sm font-semibold">{t('pj.ms_summary', { reached: pk?.milestones?.reached ?? 0, overdue: pk?.milestones?.overdue?.length ?? 0 })}</h3>
              {(pk?.milestones?.list?.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground">{t('pj.empty_ms_title')}</p> : (
                <ul className="space-y-1.5 text-sm">
                  {pk.milestones.list.slice(0, 8).map((m: any) => {
                    const overdue = m.status === 'pending' && m.due_date && String(m.due_date) < (q.data?.as_of ?? '');
                    return (
                      <li key={m.id} className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate">{m.name}{m.due_date ? <span className="text-muted-foreground"> · {m.due_date}</span> : ''}</span>
                        <Badge variant={m.status === 'reached' ? 'success' : overdue ? 'destructive' : 'muted'}>{m.status === 'reached' ? t('pj.status_reached') : overdue ? t('pj.status_overdue') : m.status}</Badge>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>

          {/* change-order log */}
          <Card className="gap-3 p-5">
            <h3 className="text-sm font-semibold">{t('pj.co_log_summary', { pending: pk?.change_orders?.summary?.pending ?? 0, approved: pk?.change_orders?.summary?.approved ?? 0 })}</h3>
            {(pk?.change_orders?.list?.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground">{t('pj.no_change_orders')}</p> : (
              <ul className="space-y-1.5 text-sm">
                {pk.change_orders.list.map((c: any) => (
                  <li key={c.id} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-mono text-xs">{c.co_no}<span className="ml-2 font-sans text-muted-foreground">{c.description ?? ''}</span></span>
                    <span className="flex shrink-0 items-center gap-2"><span className="tabular text-xs text-muted-foreground">{baht(c.contract_delta)}</span><Badge variant={c.status === 'approved' ? 'success' : c.status === 'pending' ? 'warning' : 'muted'}>{c.status}</Badge></span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </StateView>
    </div>
  );
}
