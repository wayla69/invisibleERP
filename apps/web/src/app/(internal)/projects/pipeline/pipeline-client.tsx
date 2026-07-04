'use client';

// Client island for the Win/Loss dashboard. The parent RSC (page.tsx) does the server-side prefetch
// (cookie-forwarded) and passes the payload in as a prop; this component only renders + localizes it,
// so the RSC/prefetch architecture (docs/28 §4 / docs/27 R5-2) is preserved.
import { Trophy, TrendingDown, Target, Wallet } from 'lucide-react';
import { baht } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { SimpleBarChart, TrendAreaChart } from '@/components/charts';
import { Card } from '@/components/ui/card';
import { useLang } from '@/lib/i18n';

const STAGE_ORDER = ['prospecting', 'qualification', 'proposal', 'negotiation', 'won', 'lost'];

export function PipelineClient({ data: d }: { data: any }) {
  const { t } = useLang();
  const s = d?.summary;
  const winRatePct = s?.win_rate != null ? Math.round(s.win_rate * 1000) / 10 : 0;

  const byStage = STAGE_ORDER
    .filter((k) => s?.by_stage?.[k])
    .map((k) => ({ stage: t(`pj.pipe_stage_${k}`), amount: s.by_stage[k].amount, count: s.by_stage[k].count }));
  const lossReasons = (d?.loss_reasons ?? []).slice(0, 8).map((r: any) => ({ reason: r.reason, amount: r.amount }));
  const monthly = (d?.monthly ?? []).map((m: any) => ({ month: m.month, win_rate: m.win_rate_pct }));

  return (
    <div>
      <PageHeader title={t('pj.pipe_title')} description={t('pj.pipe_desc')} />

      {!d ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          {t('pj.pipe_load_error')}
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('pj.pipe_win_rate')} value={`${winRatePct}%`} icon={Target} tone="primary" hint={t('pj.pipe_win_rate_hint')} />
            <StatCard label={t('pj.pipe_weighted')} value={baht(s?.weighted_forecast ?? 0)} icon={Wallet} tone="info" hint={t('pj.pipe_open_hint', { amount: baht(s?.open_amount ?? 0) })} />
            <StatCard label={t('pj.pipe_won_value')} value={baht(s?.won_amount ?? 0)} icon={Trophy} tone="success" />
            <StatCard label={t('pj.pipe_lost_value')} value={baht(s?.lost_amount ?? 0)} icon={TrendingDown} tone="danger" />
          </div>

          <div className="grid gap-4 lg:grid-cols-5">
            <Card className="gap-3 p-5 lg:col-span-3">
              <h3 className="text-base font-semibold">{t('pj.pipe_by_stage')}</h3>
              {byStage.length ? <SimpleBarChart data={byStage} xKey="stage" yKey="amount" fmt={(v) => baht(v)} /> : <Empty t={t} />}
            </Card>
            <Card className="gap-3 p-5 lg:col-span-2">
              <h3 className="text-base font-semibold">{t('pj.pipe_loss_reasons')}</h3>
              {lossReasons.length ? <SimpleBarChart data={lossReasons} xKey="reason" yKey="amount" color="var(--destructive)" fmt={(v) => baht(v)} /> : <Empty t={t} text={t('pj.pipe_no_lost')} />}
            </Card>
          </div>

          <Card className="gap-3 p-5">
            <h3 className="text-base font-semibold">{t('pj.pipe_monthly_trend')}</h3>
            {monthly.length ? <TrendAreaChart data={monthly} xKey="month" yKey="win_rate" color="var(--chart-3)" fmt={(v) => `${v}%`} /> : <Empty t={t} />}
          </Card>

          <div>
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('pj.pipe_by_owner')}</h3>
            <DataTable
              rows={d?.by_owner ?? []}
              columns={[
                { key: 'owner', label: t('pj.pipe_col_owner') },
                { key: 'won', label: t('pj.pipe_col_won'), align: 'right' },
                { key: 'lost', label: t('pj.pipe_col_lost'), align: 'right' },
                { key: 'open', label: t('pj.pipe_col_open'), align: 'right' },
                { key: 'win_rate', label: t('pj.pipe_win_rate'), align: 'right', render: (r: any) => (
                  <div className="ml-auto flex w-28 items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-success" style={{ width: `${Math.min(100, r.win_rate)}%` }} /></div>
                    <span className="tabular w-10 text-right text-xs">{r.win_rate}%</span>
                  </div>
                ) },
                { key: 'won_amount', label: t('pj.pipe_won_value'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.won_amount)}</span> },
              ]}
              emptyState={{ icon: Trophy, title: t('pj.pipe_empty_title'), description: t('pj.pipe_empty_desc') }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Empty({ t, text }: { t: (k: string) => string; text?: string }) {
  return <div className="py-12 text-center text-sm text-muted-foreground">{text ?? t('pj.pipe_no_data')}</div>;
}
