'use client';

// docs/48 phase 3 — Marketing Intelligence workspace (/marketing-intel). Read-only view of the advanced
// MMM / Sentiment-Weighted RFM / TOWS results the external Python platform computes in its own warehouse
// and PUSHES back into the ERP over the public API (scope analytics:write → mi_analytics_snapshots). The
// page reads the ERP's OWN store (GET /api/marketing-intel/summary) — no cross-database join, and it keeps
// working when the platform is offline. Gated to the marketing/exec duty. Plain client page (pastel
// marketing dashboard), matching its marketing-analytics siblings (/mmm, /reputation, /marketing).
import type { CSSProperties } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  BarChart3, Wallet, TrendingUp, TrendingDown, Layers, Users, Sparkles, Megaphone, History,
  Crown, ArrowUpRight, Compass,
} from 'lucide-react';
import { api } from '@/lib/api';
import { num, baht } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { StateView } from '@/components/state-view';
import { Button } from '@/components/ui/button';

interface Summary {
  mmm: { payload: any; model_run_ref: string | null; pushed_at: string | null } | null;
  rfm: { payload: any; pushed_at: string | null } | null;
  tows: { payload: any; pushed_at: string | null } | null;
  updated_at: string | null;
  has_data: boolean;
}

// Pastel palette built from the app's own chart tokens (theme-aware in light + dark). `color-mix` blends the
// token with the card surface, so a "tint" stays soft in both themes while the full token drives accents.
const HUES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];
const tintBg = (h: string, pctMix = 12): CSSProperties => ({
  background: `color-mix(in oklch, ${h} ${pctMix}%, var(--card))`,
  borderColor: `color-mix(in oklch, ${h} 22%, var(--border))`,
});
const softText = (h: string): CSSProperties => ({ color: `color-mix(in oklch, ${h} 72%, var(--foreground))` });

// Named segments get a stable, meaningful hue; anything else cycles the palette.
const SEGMENT_HUE: Record<string, string> = {
  Champions: 'var(--chart-4)', // warm amber — the crown tier
  'Loyal Customers': 'var(--chart-3)', // mint
  Loyal: 'var(--chart-3)',
  'Potential Loyalist': 'var(--chart-2)', // sky
  'At Risk': 'var(--chart-1)', // rose — attention
  Hibernating: 'var(--chart-5)', // lilac
};
const segHue = (name: string, i: number) => SEGMENT_HUE[name] ?? HUES[i % HUES.length];

export default function MarketingIntelPage() {
  const { t } = useLang();
  const q = useQuery<Summary>({ queryKey: ['marketing-intel', 'summary'], queryFn: () => api('/api/marketing-intel/summary') });
  const histQ = useQuery<{ runs: any[] }>({ queryKey: ['marketing-intel', 'mmm-history'], queryFn: () => api('/api/marketing-intel/mmm-history') });
  const activate = useMutation({
    mutationFn: (segment: string) => api('/api/marketing-intel/segments/activate', { method: 'POST', body: JSON.stringify({ segment }) }),
    onSuccess: () => notifySuccess(t('mi.activate_done')),
    onError: (e: any) => notifyError(e?.body?.error?.code === 'EMPTY_SEGMENT' ? t('mi.activate_empty') : (e?.message ?? 'error')),
  });
  const histRuns: any[] = Array.isArray(histQ.data?.runs) ? histQ.data!.runs : [];

  const mmm = q.data?.mmm?.payload ?? null;
  const rfm = q.data?.rfm?.payload ?? null;
  const tows = q.data?.tows?.payload ?? null;
  const channels: any[] = Array.isArray(mmm?.channels) ? mmm.channels : [];
  const segments: any[] = Array.isArray(rfm?.segments) ? rfm.segments : [];
  const towsItems: any[] = Array.isArray(tows?.items) ? tows.items : [];
  const topChannel = channels.length ? [...channels].sort((a, b) => (Number(b?.roi) || 0) - (Number(a?.roi) || 0))[0] : null;
  const maxRoi = channels.reduce((m, c) => Math.max(m, Number(c?.roi) || 0), 0) || 1;
  const totalCustomers = segments.reduce((s, r) => s + (Number(r?.customers) || 0), 0);

  return (
    <div className="space-y-6">
      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <div
        className="relative overflow-hidden rounded-2xl border p-6 sm:p-7"
        style={{
          background:
            'linear-gradient(135deg, color-mix(in oklch, var(--chart-1) 15%, var(--card)), color-mix(in oklch, var(--chart-5) 15%, var(--card)) 48%, color-mix(in oklch, var(--chart-2) 15%, var(--card)))',
          borderColor: 'color-mix(in oklch, var(--chart-5) 22%, var(--border))',
        }}
      >
        <div className="pointer-events-none absolute -right-8 -top-10 size-40 rounded-full opacity-50 blur-2xl"
          style={{ background: 'color-mix(in oklch, var(--chart-4) 40%, transparent)' }} />
        <div className="relative flex flex-wrap items-start gap-4">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-background/70 shadow-sm backdrop-blur">
            <Sparkles className="size-6" style={softText('var(--chart-5)')} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">{t('mi.title')}</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('mi.subtitle')}</p>
          </div>
          {q.data?.updated_at && (
            <span className="rounded-full bg-background/70 px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur">
              {t('mi.updated')}: {new Date(q.data.updated_at).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      <StateView q={q}>
        {q.data && (!q.data.has_data ? (
          <div
            className="rounded-2xl border border-dashed p-12 text-center"
            style={tintBg('var(--chart-5)', 8)}
          >
            <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-background/70 shadow-sm">
              <Sparkles className="size-7" style={softText('var(--chart-5)')} />
            </div>
            <p className="text-base font-semibold">{t('mi.empty_title')}</p>
            <p className="mx-auto mt-1.5 max-w-xl text-sm text-muted-foreground">{t('mi.empty_desc')}</p>
          </div>
        ) : (
          <div className="space-y-8">
            {/* ── MMM ─────────────────────────────────────────────────── */}
            {mmm && (
              <section className="space-y-4">
                <SectionTitle icon={BarChart3} hue="var(--chart-2)">{t('mi.mmm_heading')}</SectionTitle>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <KpiCard hue="var(--chart-2)" icon={BarChart3} label={t('mi.kpi_r2')}
                    value={mmm.r2 != null ? Number(mmm.r2).toFixed(2) : '—'} />
                  <KpiCard hue="var(--chart-3)" icon={Wallet} label={t('mi.kpi_spend')}
                    value={baht(mmm.total_spend ?? 0)} />
                  <KpiCard hue="var(--chart-4)" icon={TrendingUp} label={t('mi.kpi_top')}
                    value={topChannel ? String(topChannel.channel) : '—'} />
                </div>

                {/* Channel ROI meter list */}
                <div className="grid grid-cols-1 gap-3">
                  {channels.map((c, i) => {
                    const hue = HUES[i % HUES.length];
                    const roi = Number(c?.roi) || 0;
                    const isTop = topChannel && String(c.channel) === String(topChannel.channel);
                    return (
                      <div key={String(c.channel)} className="rounded-xl border p-4" style={tintBg(hue)}>
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 font-medium">
                            <span className="inline-block size-2.5 rounded-full" style={{ background: hue }} />
                            {String(c.channel)}
                            {isTop && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-background/70 px-2 py-0.5 text-[11px] font-semibold shadow-sm" style={softText('var(--chart-4)')}>
                                <Crown className="size-3" /> {t('mi.kpi_top')}
                              </span>
                            )}
                          </div>
                          <span className="inline-flex items-center gap-1 rounded-lg bg-background/70 px-2.5 py-1 text-sm font-semibold tabular-nums shadow-sm" style={softText(hue)}>
                            <ArrowUpRight className="size-3.5" /> {num(roi)}× ROI
                          </span>
                        </div>
                        <div className="mt-3 flex items-center gap-3">
                          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-background/60">
                            <div className="h-full rounded-full" style={{ width: `${Math.max(4, (roi / maxRoi) * 100)}%`, background: hue }} />
                          </div>
                          <div className="w-40 shrink-0 text-right text-xs text-muted-foreground">
                            <span className="tabular-nums">{baht(c.spend ?? 0)}</span>
                            {c.contribution_pct != null && <span> · {num(c.contribution_pct)}%</span>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Run history — period comparison strip */}
                {histRuns.length > 1 && (
                  <div className="space-y-2 pt-1">
                    <h3 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground"><History className="size-4" /> {t('mi.history_heading')}</h3>
                    <div className="flex gap-3 overflow-x-auto pb-1">
                      {histRuns.map((r, i) => {
                        const prev = histRuns[i + 1];
                        const r2 = Number(r?.r2);
                        const delta = prev != null ? r2 - Number(prev?.r2) : 0;
                        return (
                          <div key={String(r.pushed_at ?? r.model_run_ref ?? i)} className="min-w-[150px] shrink-0 rounded-xl border p-3" style={tintBg('var(--chart-2)', 9)}>
                            <div className="text-xs text-muted-foreground">{r.pushed_at ? new Date(r.pushed_at).toLocaleDateString() : '—'}</div>
                            <div className="mt-1 flex items-baseline gap-1.5">
                              <span className="text-lg font-semibold tabular-nums">{r2 != null && !Number.isNaN(r2) ? r2.toFixed(2) : '—'}</span>
                              <span className="text-[11px] text-muted-foreground">R²</span>
                              {prev != null && delta !== 0 && (
                                <span className={`ml-auto inline-flex items-center gap-0.5 text-[11px] font-medium ${delta > 0 ? 'text-success' : 'text-destructive'}`}>
                                  {delta > 0 ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
                                  {delta > 0 ? '+' : ''}{delta.toFixed(2)}
                                </span>
                              )}
                            </div>
                            <div className="mt-1.5 truncate text-xs text-muted-foreground">{r.top_channel ?? '—'} · {r.top_channel_roi != null ? `${num(r.top_channel_roi)}×` : '—'}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* ── RFM (with the activate → campaign action loop) ────────── */}
            {rfm && (
              <section className="space-y-4">
                <SectionTitle icon={Users} hue="var(--chart-3)">{t('mi.rfm_heading')}</SectionTitle>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {segments.map((s, i) => {
                    const hue = segHue(String(s.segment), i);
                    const share = totalCustomers ? (Number(s.customers) || 0) / totalCustomers * 100 : 0;
                    return (
                      <div key={String(s.segment)} className="flex flex-col rounded-2xl border p-5" style={tintBg(hue)}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="flex size-9 items-center justify-center rounded-xl bg-background/70 shadow-sm">
                              <Users className="size-4" style={softText(hue)} />
                            </span>
                            <span className="font-semibold leading-tight">{String(s.segment)}</span>
                          </div>
                        </div>
                        <div className="mt-4 flex items-end justify-between">
                          <div>
                            <div className="text-2xl font-semibold tabular-nums" style={softText(hue)}>{num(s.customers ?? 0)}</div>
                            <div className="text-xs text-muted-foreground">{t('mi.col_customers')}</div>
                          </div>
                          <div className="text-right">
                            <div className="text-sm font-semibold tabular-nums">{baht(s.monetary ?? 0)}</div>
                            <div className="text-xs text-muted-foreground">{t('mi.col_monetary')}</div>
                          </div>
                        </div>
                        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-background/60">
                          <div className="h-full rounded-full" style={{ width: `${Math.max(3, share)}%`, background: hue }} />
                        </div>
                        <Button
                          size="sm" variant="outline"
                          className="mt-4 w-full bg-background/60"
                          disabled={activate.isPending}
                          onClick={() => activate.mutate(String(s.segment))}
                        >
                          <Megaphone className="size-4" /> {t('mi.activate')}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ── TOWS ──────────────────────────────────────────────────── */}
            {tows && (
              <section className="space-y-4">
                <SectionTitle icon={Compass} hue="var(--chart-5)">{t('mi.tows_heading')}</SectionTitle>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {towsItems.map((it, i) => {
                    const hue = HUES[i % HUES.length];
                    const code = String(it.quadrant ?? '').trim().split(/[\s(]/)[0] || '•';
                    return (
                      <div key={`${it.quadrant}-${it.factor ?? it.recommendation ?? i}`} className="rounded-2xl border p-5" style={tintBg(hue)}>
                        <div className="flex items-center gap-2.5">
                          <span className="flex size-9 items-center justify-center rounded-xl bg-background/70 text-sm font-bold shadow-sm" style={softText(hue)}>{code}</span>
                          <span className="text-sm font-semibold">{String(it.quadrant)}</span>
                        </div>
                        <p className="mt-3 text-sm leading-relaxed text-foreground/80">{String(it.recommendation ?? it.factor ?? '—')}</p>
                      </div>
                    );
                  })}
                  {!towsItems.length && (
                    <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground sm:col-span-2">
                      <Layers className="mx-auto mb-2 size-6 opacity-60" />{t('mi.empty_title')}
                    </div>
                  )}
                </div>
              </section>
            )}
          </div>
        ))}
      </StateView>
    </div>
  );
}

function SectionTitle({ icon: Icon, hue, children }: { icon: typeof BarChart3; hue: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex size-8 items-center justify-center rounded-lg" style={{ ...tintBg(hue, 16), color: `color-mix(in oklch, ${hue} 72%, var(--foreground))` }}>
        <Icon className="size-4" />
      </span>
      <h2 className="text-lg font-semibold">{children}</h2>
    </div>
  );
}

function KpiCard({ hue, icon: Icon, label, value }: { hue: string; icon: typeof BarChart3; label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-2xl border p-5" style={tintBg(hue)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <p className="mt-2 truncate text-2xl font-semibold tracking-tight tabular-nums" style={softText(hue)}>{value}</p>
        </div>
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-background/70 shadow-sm" style={softText(hue)}>
          <Icon className="size-5" />
        </span>
      </div>
    </div>
  );
}
