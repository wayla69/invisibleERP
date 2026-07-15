'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, GitBranch, Network, Clock, Target, Plus, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StateView } from '@/components/state-view';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/form-controls';
import { statusVariant } from '@/components/ui';
import { Crumbs } from '@/components/crumbs';

// Program (cross-project) critical path (PMO-4): the member projects laid out as a higher-level CPM —
// each row is a whole project (duration = its own critical path); the program critical path is highlighted.
export default function ProgramPage() {
  const { t } = useLang();
  const router = useRouter();
  const code = decodeURIComponent(String(useParams().code ?? ''));
  const q = useQuery<any>({ queryKey: ['program', code], queryFn: () => api(`/api/projects/program-critical-path?program=${encodeURIComponent(code)}`) });
  const d = q.data;
  const span = Math.max(1, d?.program_duration_days ?? 1);

  return (
    <div>
      <Crumbs items={[{ label: t('pj.btn_portfolio'), href: '/projects/portfolio' }, { label: `${t('pj.program_word')} ${code}` }]} />
      <PageHeader
        title={<span className="flex items-center gap-2"><Network className="size-5" /> {t('pj.program_word')} {code}</span>}
        description={t('pj.program_page_desc')}
        actions={<Button variant="outline" onClick={() => router.push('/projects/portfolio')}><ArrowLeft className="size-4" /> {t('pj.btn_portfolio')}</Button>}
      />
      <StateView q={q}>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label={t('pj.stat_program_duration')} value={t('pj.days', { n: d?.program_duration_days ?? 0 })} icon={Clock} tone="primary" hint={t('pj.n_projects', { n: d?.project_count ?? 0 })} />
            <StatCard label={t('pj.stat_on_critical')} value={d?.critical_path?.length ?? 0} icon={GitBranch} tone="danger" hint={t('pj.critical_hint')} />
            <StatCard label={t('pj.stat_has_slack')} value={(d?.projects ?? []).filter((p: any) => !p.on_critical_path).length} icon={GitBranch} tone="success" />
          </div>

          {/* timeline bars: each project from ES to EF across the program span */}
          <div className="space-y-2 rounded-xl border border-border/60 p-4">
            {(d?.projects ?? []).map((p: any) => (
              <button key={p.project_code} onClick={() => router.push(`/projects/${encodeURIComponent(p.project_code)}`)} className="flex w-full items-center gap-3 text-left">
                <span className="w-40 shrink-0 truncate text-sm"><span className="font-medium">{p.project_code}</span> <span className="text-muted-foreground">{p.name}</span></span>
                <span className="relative h-5 flex-1 overflow-hidden rounded bg-muted/50">
                  <span
                    className={`absolute top-0 h-full rounded ${p.on_critical_path ? 'bg-destructive/80' : 'bg-primary/60'}`}
                    style={{ left: `${(p.es / span) * 100}%`, width: `${Math.max(2, ((p.ef - p.es) / span) * 100)}%` }}
                    title={t('pj.timeline_tip', { es: p.es, ef: p.ef, days: p.duration_days, slack: p.slack > 0 ? ` · slack ${p.slack}` : '' })}
                  />
                </span>
                <span className="w-10 shrink-0 text-right text-xs tabular text-muted-foreground">{p.duration_days}d</span>
              </button>
            ))}
          </div>

          <DataTable
            rows={d?.projects ?? []}
            rowKey={(r: any) => r.project_code}
            onRowClick={(r: any) => router.push(`/projects/${encodeURIComponent(r.project_code)}`)}
            columns={[
              { key: 'project_code', label: t('pj.col_code') },
              { key: 'name', label: t('pj.col_project') },
              { key: 'depends_on', label: t('pj.col_depends_on'), render: (r: any) => r.depends_on?.length ? r.depends_on.join(', ') : '—' },
              { key: 'duration_days', label: t('pj.col_duration'), align: 'right', render: (r: any) => t('pj.days', { n: r.duration_days }) },
              { key: 'window', label: t('pj.col_window'), align: 'right', render: (r: any) => `${r.es}–${r.ef}` },
              { key: 'slack', label: t('pj.col_slack'), align: 'right', render: (r: any) => <span className={`tabular ${r.slack <= 0 ? 'font-medium text-destructive' : ''}`}>{r.slack}</span> },
              { key: 'on_critical_path', label: t('pj.col_critical_path'), render: (r: any) => r.on_critical_path ? <Badge variant="destructive">{t('pj.critical')}</Badge> : <Badge variant="muted">{t('pj.has_slack_badge')}</Badge> },
              { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
            ]}
            emptyState={{ icon: Network, title: t('pj.empty_program_title'), description: t('pj.empty_program_desc') }}
          />

          {/* Program benefits realization (PPM Wave P4, PROJ-27) */}
          <ProgramBenefits code={code} />
        </div>
      </StateView>
    </div>
  );
}

// Program benefits-realization panel (PPM Wave P4, PROJ-27). Inlined in this already-'use client' page so it
// inherits the client boundary (no new client-first file → use-client ratchet flat). Declare a program's
// expected benefits (baseline → target), log actuals over time, watch realization %, and CLOSE each benefit
// realized/not-realized as a maker-checker sign-off (a different user than the author must confirm).
function ProgramBenefits({ code }: { code: string }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['program', code, 'benefits'], queryFn: () => api(`/api/projects/programs/${encodeURIComponent(code)}/benefits`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['program', code, 'benefits'] });
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: '', category: 'financial', unit: 'THB', target_value: '', target_date: '', owner: '' });
  const [measuring, setMeasuring] = useState<number | null>(null);
  const [mval, setMval] = useState('');

  const declare = useMutation({
    mutationFn: () => api(`/api/projects/programs/${encodeURIComponent(code)}/benefits`, { method: 'POST', body: JSON.stringify({ name: f.name, category: f.category, unit: f.unit || undefined, target_value: Number(f.target_value) || 0, target_date: f.target_date || undefined, owner: f.owner || undefined }) }),
    onSuccess: () => { notifySuccess(t('pj.ben_declared')); setAdding(false); setF({ name: '', category: 'financial', unit: 'THB', target_value: '', target_date: '', owner: '' }); refresh(); }, onError: (e: any) => notifyError(e.message),
  });
  const measure = useMutation({
    mutationFn: (v: { id: number; value: number }) => api(`/api/projects/benefits/${v.id}/measurements`, { method: 'POST', body: JSON.stringify({ measured_value: v.value }) }),
    onSuccess: () => { notifySuccess(t('pj.ben_measured')); setMeasuring(null); setMval(''); refresh(); }, onError: (e: any) => notifyError(e.message),
  });
  const confirm = useMutation({
    mutationFn: (v: { id: number; result: 'realized' | 'not_realized' }) => api(`/api/projects/benefits/${v.id}/confirm`, { method: 'POST', body: JSON.stringify({ result: v.result }) }),
    onSuccess: (_r, v) => { notifySuccess(t(v.result === 'realized' ? 'pj.ben_realized_done' : 'pj.ben_not_realized_done')); refresh(); }, onError: (e: any) => notifyError(e.message),
  });

  const d = q.data;
  const healthBadge = (b: any) => {
    if (b.status === 'realized') return <Badge variant="success">{t('pj.ben_realized')}</Badge>;
    if (b.status === 'not_realized') return <Badge variant="destructive">{t('pj.ben_not_realized')}</Badge>;
    if (b.overdue) return <Badge variant="destructive">{t('pj.ben_overdue')}</Badge>;
    return <Badge variant={b.health === 'met' ? 'success' : b.health === 'on_track' ? 'info' : 'warning'}>{t(`pj.ben_health_${b.health}`)}</Badge>;
  };

  return (
    <div className="rounded-xl border border-border/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-base font-semibold"><Target className="size-4" /> {t('pj.ben_title')}</h3>
        <Button size="sm" variant="outline" onClick={() => setAdding((v) => !v)}><Plus className="size-4" /> {t('pj.ben_declare')}</Button>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t('pj.ben_desc')}</p>

      {d?.rollup?.benefit_count > 0 && (
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-lg border border-border/60 p-2 text-center"><div className="text-xs text-muted-foreground">{t('pj.ben_count')}</div><div className="tabular font-medium">{d.rollup.benefit_count}</div></div>
          <div className="rounded-lg border border-border/60 p-2 text-center"><div className="text-xs text-muted-foreground">{t('pj.ben_avg_pct')}</div><div className="tabular font-medium">{d.rollup.avg_realization_pct}%</div></div>
          <div className="rounded-lg border border-border/60 p-2 text-center"><div className="text-xs text-muted-foreground">{t('pj.ben_realized_n')}</div><div className="tabular font-medium text-success">{d.rollup.realized_count}</div></div>
          <div className={`rounded-lg border p-2 text-center ${d.rollup.at_risk_count > 0 ? 'border-warning/60' : 'border-border/60'}`}><div className="text-xs text-muted-foreground">{t('pj.ben_at_risk_n')}</div><div className={`tabular font-medium ${d.rollup.at_risk_count > 0 ? 'text-warning' : ''}`}>{d.rollup.at_risk_count}</div></div>
        </div>
      )}

      {adding && (
        <div className="mb-3 grid gap-2 rounded-lg border border-border/60 p-3 sm:grid-cols-2 lg:grid-cols-3">
          <div><label className="text-xs text-muted-foreground">{t('pj.ben_name')}</label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div><label className="text-xs text-muted-foreground">{t('pj.ben_category')}</label><Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="financial">{t('pj.ben_financial')}</option><option value="non_financial">{t('pj.ben_non_financial')}</option></Select></div>
          <div><label className="text-xs text-muted-foreground">{t('pj.ben_unit')}</label><Input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} /></div>
          <div><label className="text-xs text-muted-foreground">{t('pj.ben_target')}</label><Input type="number" value={f.target_value} onChange={(e) => setF({ ...f, target_value: e.target.value })} /></div>
          <div><label className="text-xs text-muted-foreground">{t('pj.ben_target_date')}</label><Input type="date" value={f.target_date} onChange={(e) => setF({ ...f, target_date: e.target.value })} /></div>
          <div><label className="text-xs text-muted-foreground">{t('pj.ben_owner')}</label><Input value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })} /></div>
          <div className="flex items-end"><Button size="sm" disabled={!f.name.trim() || !f.target_value || declare.isPending} onClick={() => declare.mutate()}>{t('pj.ben_declare')}</Button></div>
        </div>
      )}

      {(d?.benefits?.length ?? 0) === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">{t('pj.ben_empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground"><tr className="border-b border-border/60"><th className="px-2 py-1 text-left">{t('pj.ben_col_benefit')}</th><th className="px-2 py-1 text-right">{t('pj.ben_col_target')}</th><th className="px-2 py-1 text-right">{t('pj.ben_col_actual')}</th><th className="px-2 py-1 text-right">{t('pj.ben_col_pct')}</th><th className="px-2 py-1 text-center">{t('pj.ben_col_status')}</th><th className="px-2 py-1 text-right">{t('pj.ben_col_actions')}</th></tr></thead>
            <tbody>
              {d.benefits.map((b: any) => (
                <tr key={b.id} className="border-b border-border/30">
                  <td className="px-2 py-1"><span className="font-medium">{b.benefit_no}</span> {b.name}{b.owner ? <span className="text-xs text-muted-foreground"> · {b.owner}</span> : ''}</td>
                  <td className="px-2 py-1 text-right tabular">{b.category === 'financial' ? baht(b.target_value) : `${b.target_value}${b.unit ? ` ${b.unit}` : ''}`}</td>
                  <td className="px-2 py-1 text-right tabular">{b.category === 'financial' ? baht(b.current_actual) : b.current_actual}</td>
                  <td className={`px-2 py-1 text-right tabular font-medium ${b.realization_pct >= 100 ? 'text-success' : b.realization_pct < 50 ? 'text-warning' : ''}`}>{b.realization_pct}%</td>
                  <td className="px-2 py-1 text-center">{healthBadge(b)}</td>
                  <td className="px-2 py-1 text-right">
                    {b.status === 'open' ? (
                      measuring === b.id ? (
                        <span className="flex items-center justify-end gap-1">
                          <Input type="number" value={mval} onChange={(e) => setMval(e.target.value)} className="h-7 w-24" placeholder={t('pj.ben_actual')} />
                          <Button size="sm" variant="outline" disabled={!mval || measure.isPending} onClick={() => measure.mutate({ id: b.id, value: Number(mval) })}>{t('pj.ben_log')}</Button>
                        </span>
                      ) : (
                        <span className="flex items-center justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={() => { setMeasuring(b.id); setMval(''); }}>{t('pj.ben_measure')}</Button>
                          <Button size="sm" variant="outline" title={t('pj.ben_confirm_realized')} onClick={() => confirm.mutate({ id: b.id, result: 'realized' })}><CheckCircle2 className="size-4" /></Button>
                          <Button size="sm" variant="ghost" onClick={() => confirm.mutate({ id: b.id, result: 'not_realized' })}>{t('pj.ben_confirm_not')}</Button>
                        </span>
                      )
                    ) : (
                      <span className="text-xs text-muted-foreground">{t('pj.ben_confirmed_by', { who: b.confirmed_by ?? '' })}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-muted-foreground">{t('pj.ben_hint')}</p>
    </div>
  );
}
