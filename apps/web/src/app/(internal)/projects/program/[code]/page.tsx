'use client';

import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, GitBranch, Network, Clock } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StateView } from '@/components/state-view';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
        </div>
      </StateView>
    </div>
  );
}
