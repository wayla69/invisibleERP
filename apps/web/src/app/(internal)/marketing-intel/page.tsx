'use client';

// docs/48 phase 3 — Marketing Intelligence workspace (/marketing-intel). Read-only view of the advanced
// MMM / Sentiment-Weighted RFM / TOWS results the external Python platform computes in its own warehouse
// and PUSHES back into the ERP over the public API (scope analytics:write → mi_analytics_snapshots). The
// page reads the ERP's OWN store (GET /api/marketing-intel/summary) — no cross-database join, and it keeps
// working when the platform is offline. Gated to the marketing/exec duty. Plain client page, matching its
// marketing-analytics siblings (/mmm, /reputation, /marketing).
import { useQuery } from '@tanstack/react-query';
import { BarChart3, Wallet, TrendingUp, Layers, Users, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { num, baht } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';

interface Summary {
  mmm: { payload: any; model_run_ref: string | null; pushed_at: string | null } | null;
  rfm: { payload: any; pushed_at: string | null } | null;
  tows: { payload: any; pushed_at: string | null } | null;
  updated_at: string | null;
  has_data: boolean;
}

export default function MarketingIntelPage() {
  const { t } = useLang();
  const q = useQuery<Summary>({ queryKey: ['marketing-intel', 'summary'], queryFn: () => api('/api/marketing-intel/summary') });

  const mmm = q.data?.mmm?.payload ?? null;
  const rfm = q.data?.rfm?.payload ?? null;
  const tows = q.data?.tows?.payload ?? null;
  const channels: any[] = Array.isArray(mmm?.channels) ? mmm.channels : [];
  const segments: any[] = Array.isArray(rfm?.segments) ? rfm.segments : [];
  const towsItems: any[] = Array.isArray(tows?.items) ? tows.items : [];
  const topChannel = channels.length ? [...channels].sort((a, b) => (Number(b?.roi) || 0) - (Number(a?.roi) || 0))[0] : null;

  return (
    <div className="space-y-5">
      <PageHeader title={t('mi.title')} description={t('mi.subtitle')} />

      <StateView q={q}>
        {q.data && (!q.data.has_data ? (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <Sparkles className="mx-auto mb-3 size-8 text-muted-foreground" />
            <p className="text-base font-medium">{t('mi.empty_title')}</p>
            <p className="mx-auto mt-1 max-w-xl text-sm text-muted-foreground">{t('mi.empty_desc')}</p>
          </div>
        ) : (
          <div className="space-y-6">
            {q.data.updated_at && (
              <p className="text-xs text-muted-foreground">{t('mi.updated')}: {new Date(q.data.updated_at).toLocaleString()}</p>
            )}

            {/* ── MMM ─────────────────────────────────────────────── */}
            {mmm && (
              <section className="space-y-3">
                <h2 className="text-lg font-semibold">{t('mi.mmm_heading')}</h2>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <StatCard label={t('mi.kpi_r2')} value={mmm.r2 != null ? Number(mmm.r2).toFixed(2) : '—'} icon={BarChart3} tone="primary" />
                  <StatCard label={t('mi.kpi_spend')} value={baht(mmm.total_spend ?? 0)} icon={Wallet} tone="success" />
                  <StatCard label={t('mi.kpi_top')} value={topChannel ? String(topChannel.channel) : '—'} icon={TrendingUp} tone="warning" />
                </div>
                <DataTable
                  rows={channels}
                  rowKey={(r) => String(r.channel)}
                  emptyState={{ icon: Layers, title: t('mi.empty_title') }}
                  columns={[
                    { key: 'channel', label: t('mi.col_channel'), render: (r: any) => String(r.channel) },
                    { key: 'spend', label: t('mi.col_spend'), render: (r: any) => baht(r.spend ?? 0) },
                    { key: 'contribution_pct', label: t('mi.col_contribution'), render: (r: any) => r.contribution_pct != null ? `${num(r.contribution_pct)}%` : '—' },
                    { key: 'roi', label: t('mi.col_roi'), render: (r: any) => r.roi != null ? num(r.roi) : '—' },
                  ]}
                />
              </section>
            )}

            {/* ── RFM ─────────────────────────────────────────────── */}
            {rfm && (
              <section className="space-y-3">
                <h2 className="text-lg font-semibold">{t('mi.rfm_heading')}</h2>
                <DataTable
                  rows={segments}
                  rowKey={(r) => String(r.segment)}
                  emptyState={{ icon: Users, title: t('mi.empty_title') }}
                  columns={[
                    { key: 'segment', label: t('mi.col_segment'), render: (r: any) => String(r.segment) },
                    { key: 'customers', label: t('mi.col_customers'), render: (r: any) => num(r.customers ?? 0) },
                    { key: 'monetary', label: t('mi.col_monetary'), render: (r: any) => baht(r.monetary ?? 0) },
                  ]}
                />
              </section>
            )}

            {/* ── TOWS ────────────────────────────────────────────── */}
            {tows && (
              <section className="space-y-3">
                <h2 className="text-lg font-semibold">{t('mi.tows_heading')}</h2>
                <DataTable
                  rows={towsItems}
                  rowKey={(r) => `${r.quadrant}-${r.factor ?? r.recommendation}`}
                  emptyState={{ icon: Layers, title: t('mi.empty_title') }}
                  columns={[
                    { key: 'quadrant', label: t('mi.col_quadrant'), render: (r: any) => String(r.quadrant) },
                    { key: 'recommendation', label: t('mi.col_recommendation'), render: (r: any) => String(r.recommendation ?? r.factor ?? '—') },
                  ]}
                />
              </section>
            )}
          </div>
        ))}
      </StateView>
    </div>
  );
}
