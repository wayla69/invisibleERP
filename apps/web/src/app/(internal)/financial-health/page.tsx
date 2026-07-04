'use client';

// Read-only working-capital dashboard: fetches the health snapshot and renders it, with no mutations.
// (Client component so it can localize via useLang(); the data comes from GET /api/finance/health.)
import { useQuery } from '@tanstack/react-query';
import { HeartPulse, Wallet, TrendingUp, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { baht } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const GRADE_TONE: Record<string, 'success' | 'info' | 'warning' | 'danger'> = { A: 'success', B: 'success', C: 'info', D: 'warning', E: 'danger' };

export default function FinancialHealthPage() {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['finance-health'], queryFn: () => api('/api/finance/health') });
  const data = q.data;

  return (
    <div>
      <PageHeader
        title={t('fnx.finhealth.title')}
        description={t('fnx.finhealth.subtitle')}
      />
      {!data ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          {t('fnx.finhealth.load_error')}
        </Card>
      ) : (
        <>
          <div className="mb-4 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
            <StatCard
              label={t('fnx.finhealth.score')}
              value={`${data.score}/100 · ${data.grade}`}
              icon={HeartPulse}
              tone={GRADE_TONE[data.grade] ?? 'info'}
              hint={t('fnx.finhealth.score_hint', { days: data.days_cash_on_hand ?? '∞', ratio: data.current_ratio ?? '—' })}
            />
            <StatCard label={t('fnx.finhealth.cash_on_hand')} value={baht(data.cash_on_hand)} icon={Wallet} />
            <StatCard label={t('fnx.finhealth.ar_outstanding')} value={baht(data.ar_outstanding)} hint={t('fnx.finhealth.ar_hint', { pct: data.overdue_ar_pct, amount: baht(data.overdue_ar) })} tone={data.overdue_ar_pct > 20 ? 'warning' : 'default'} />
            <StatCard label={t('fnx.finhealth.ap_outstanding')} value={baht(data.ap_outstanding)} icon={AlertTriangle} />
            <StatCard label={t('fnx.finhealth.run_rate')} value={baht(data.pos_daily_run_rate)} icon={TrendingUp} tone="info" />
          </div>

          <Card className="gap-3 p-4">
            <h3 className="text-sm font-semibold text-muted-foreground">{t('fnx.finhealth.drivers_title')}</h3>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
              <Driver label={t('fnx.finhealth.driver_liquidity')} score={data.drivers.liquidity} hint={t('fnx.finhealth.driver_liquidity_hint', { days: data.days_cash_on_hand ?? '∞' })} />
              <Driver label={t('fnx.finhealth.driver_receivables')} score={data.drivers.receivables} hint={t('fnx.finhealth.driver_receivables_hint', { pct: data.overdue_ar_pct })} />
            </div>
            <p className="text-xs text-muted-foreground">{t('fnx.finhealth.formula_note')}</p>
          </Card>
        </>
      )}
    </div>
  );
}

function Driver({ label, score, hint }: { label: string; score: number; hint: string }) {
  const tone = score >= 70 ? 'bg-success' : score >= 45 ? 'bg-warning' : 'bg-destructive';
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <Badge variant="muted">{score}/100</Badge>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${tone}`} style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
