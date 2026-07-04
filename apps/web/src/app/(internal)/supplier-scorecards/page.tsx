'use client';

import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Award, Gauge, TrendingDown, Trophy } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useLang } from '@/lib/i18n';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';

// Supplier-performance register (EXP — vendor management): ranks suppliers by scorecard so procurement
// can see who is underperforming. Surfaces supplier_scorecards, which had compute + storage but no list/UI.

interface Scorecard {
  vendor_id: number; vendor_name: string | null; period: string | null;
  on_time_pct: number; quality_pct: number; price_var_pct: number; score: number; gr_count: number; claim_count: number;
}
interface Resp { scorecards: Scorecard[]; count: number; avg_score: number; underperformers: number }

const scoreTone = (s: number): 'success' | 'warning' | 'destructive' =>
  s >= 85 ? 'success' : s >= 70 ? 'warning' : 'destructive';

export default function SupplierScorecardsPage() {
  const { t } = useLang();
  const [period, setPeriod] = useState('');

  const q = useQuery<Resp>({
    queryKey: ['supplier-scorecards', period],
    queryFn: () => api(`/api/procurement/scorecards${period ? `?period=${encodeURIComponent(period)}` : ''}`),
    placeholderData: keepPreviousData,
  });
  const d = q.data;

  return (
    <ModulePage
      title={t('iv.ssc_title')}
      description={t('iv.ssc_desc')}
      query={q}
      toolbar={
        <>
          <label className="text-sm text-muted-foreground" htmlFor="sc-period">{t('iv.ssc_period')}</label>
          <Input id="sc-period" className="w-40" placeholder={t('iv.ssc_period_ph')} value={period} onChange={(e) => setPeriod(e.target.value)} aria-label={t('iv.ssc_period_aria')} />
          {period && <span className="text-xs text-muted-foreground">{t('iv.ssc_period_hint')}</span>}
          {q.isFetching && !q.isLoading && <span className="text-xs text-muted-foreground">{t('iv.ssc_updating')}</span>}
        </>
      }
      stats={
        d && (
          <>
            <StatCard label={t('iv.ssc_stat_count')} value={num(d.count)} icon={Award} tone="primary" />
            <StatCard label={t('iv.ssc_stat_avg')} value={num(d.avg_score)} icon={Gauge} tone={d.avg_score >= 85 ? 'success' : d.avg_score >= 70 ? 'warning' : 'danger'} hint={t('iv.ssc_stat_avg_hint')} />
            <StatCard label={t('iv.ssc_stat_under')} value={num(d.underperformers)} icon={TrendingDown} tone={d.underperformers > 0 ? 'danger' : 'success'} hint={t('iv.ssc_stat_under_hint')} />
          </>
        )
      }
      statsClassName="xl:grid-cols-3"
    >
      {d && (
        <DataTable
          rows={d.scorecards.map((s, i) => ({ ...s, rank: i + 1 }))}
          rowKey={(r) => `${r.vendor_id}-${r.period}`}
          emptyState={{ icon: Award, title: t('iv.ssc_empty_title'), description: t('iv.ssc_empty_desc') }}
          columns={[
            { key: 'rank', label: t('iv.ssc_col_rank'), render: (r) => <span className="tabular text-muted-foreground">{r.rank === 1 ? <Trophy className="inline size-4 text-warning-foreground dark:text-warning" /> : `#${r.rank}`}</span> },
            { key: 'vendor_name', label: t('iv.ssc_col_supplier'), render: (r) => <span className="font-medium">{r.vendor_name ?? `#${r.vendor_id}`}</span> },
            { key: 'score', label: t('iv.ssc_col_score'), align: 'right', render: (r) => <Badge variant={scoreTone(r.score)}>{num(r.score)}</Badge> },
            { key: 'on_time_pct', label: t('iv.ssc_col_on_time'), align: 'right', render: (r) => <span className="tabular">{num(r.on_time_pct)}%</span> },
            { key: 'quality_pct', label: t('iv.ssc_col_quality'), align: 'right', render: (r) => <span className="tabular">{num(r.quality_pct)}%</span> },
            { key: 'price_var_pct', label: t('iv.ssc_col_price_var'), align: 'right', render: (r) => <span className={cn('tabular', r.price_var_pct > 0 && 'text-destructive')}>{num(r.price_var_pct)}%</span> },
            { key: 'gr_count', label: t('iv.ssc_col_gr'), align: 'right', render: (r) => <span className="tabular">{num(r.gr_count)}</span> },
            { key: 'claim_count', label: t('iv.ssc_col_claim'), align: 'right', render: (r) => <span className={cn('tabular', r.claim_count > 0 && 'font-medium text-destructive')}>{num(r.claim_count)}</span> },
            { key: 'period', label: t('iv.ssc_col_period'), render: (r) => r.period ?? '—' },
          ]}
        />
      )}
    </ModulePage>
  );
}
