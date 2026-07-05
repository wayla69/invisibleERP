'use client';

// CFO Command Center client island (docs/35 Phase 2). Renders the canonical KPI pack the RSC prefetched:
// a RAG summary strip + the scorecard grouped by KPI family, each tile showing value + RAG (icon+label,
// never colour-alone) + prior-period/prior-year/budget deltas, expandable to a lazy 12-month sparkline
// with a drill link. Refreshes live off the fin_kpi_refresh SSE (same bus as the ops dashboard).
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, AlertTriangle, AlertCircle, TrendingUp, TrendingDown, Minus, RefreshCw } from 'lucide-react';
import { useLang } from '@/lib/i18n';
import { baht } from '@/lib/format';
import { api } from '@/lib/api';
import { useRealtime } from '@/hooks/use-realtime';
import { PageHeader } from '@/components/page-header';
import { Card } from '@/components/ui/card';

type Rag = 'green' | 'amber' | 'red' | null;
interface Kpi {
  id: string; group: string; label: string; label_en: string; unit: string;
  value: number | null; prior_period: number | null; prior_year: number | null; budget: number | null;
  delta_pp: number | null; delta_yoy: number | null; delta_pp_pct: number | null; delta_yoy_pct: number | null; vs_budget_pct: number | null;
  rag: Rag; drill: { accounts: string[]; href: string };
}
interface Pack { as_of: string; groups: { id: string; label: string; labelEn: string }[]; kpis: Kpi[] }

const RAG_TONE: Record<'green' | 'amber' | 'red', { text: string; bg: string; ring: string; Icon: typeof CheckCircle2 }> = {
  green: { text: 'text-success', bg: 'bg-success/15', ring: 'border-l-success', Icon: CheckCircle2 },
  amber: { text: 'text-warning-foreground dark:text-warning', bg: 'bg-warning/20', ring: 'border-l-warning', Icon: AlertTriangle },
  red: { text: 'text-destructive', bg: 'bg-destructive/10', ring: 'border-l-destructive', Icon: AlertCircle },
};

function fmtValue(v: number | null, unit: string, lang: string): string {
  if (v == null || !Number.isFinite(v)) return '—';
  switch (unit) {
    case 'currency': return baht(v);
    case 'pct': return `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
    case 'x': return `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}×`;
    case 'ratio': return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
    case 'days': return `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })} ${lang === 'th' ? 'วัน' : 'd'}`;
    case 'months': return `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })} ${lang === 'th' ? 'ด.' : 'mo'}`;
    default: return String(v);
  }
}

export function CommandCenterClient({ initialData }: { initialData: Pack | null }) {
  const { t, lang } = useLang();
  const [pack, setPack] = useState<Pack | null>(initialData);
  const [refreshing, setRefreshing] = useState(false);

  const refetch = useCallback(async () => {
    setRefreshing(true);
    try { setPack(await api<Pack>('/api/finance/metrics/pack')); } catch { /* keep the last good snapshot */ } finally { setRefreshing(false); }
  }, []);

  // Client-side fetch on mount — the intended fallback when the server prefetch is skipped (serverApi
  // returns null with no cookie / on prerender), and a fresh revalidation when it wasn't.
  useEffect(() => { void refetch(); }, [refetch]);

  // Live: the ops dashboard refreshes its snapshot → we get a fin_kpi_refresh (or kpi_refresh) → re-pull.
  const { connected } = useRealtime((e) => { if (e.type === 'fin_kpi_refresh' || e.type === 'kpi_refresh') void refetch(); }, { path: '/api/bi/live/stream' });

  if (!pack) {
    return (
      <div>
        <PageHeader title={t('fnx.cfo.title')} description={t('fnx.cfo.subtitle')} />
        <Card className="p-8 text-center text-sm text-muted-foreground">{t('fnx.cfo.load_error')}</Card>
      </div>
    );
  }

  const counts = { red: 0, amber: 0, green: 0 };
  for (const k of pack.kpis) if (k.rag) counts[k.rag]++;

  return (
    <div>
      <PageHeader title={t('fnx.cfo.title')} description={t('fnx.cfo.subtitle')} />

      {/* Summary strip: as-of, live badge, and the RAG rollup */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('fnx.cfo.as_of', { date: pack.as_of })}</span>
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${connected ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'}`}>
          <span className={`size-1.5 rounded-full ${connected ? 'bg-success' : 'bg-muted-foreground'}`} />
          {connected ? t('fnx.cfo.live') : t('fnx.cfo.offline')}
          {refreshing && <RefreshCw className="size-3 animate-spin" />}
        </span>
        <span className="ml-auto flex items-center gap-3">
          <RagCount tone="red" n={counts.red} label={t('fnx.cfo.needs_action')} />
          <RagCount tone="amber" n={counts.amber} label={t('fnx.cfo.watch')} />
          <RagCount tone="green" n={counts.green} label={t('fnx.cfo.healthy')} />
        </span>
      </div>

      {pack.groups.map((g) => {
        const kpis = pack.kpis.filter((k) => k.group === g.id);
        if (!kpis.length) return null;
        return (
          <section key={g.id} className="mb-6">
            <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{lang === 'th' ? g.label : g.labelEn}</h3>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
              {kpis.map((k) => <KpiTile key={k.id} kpi={k} lang={lang} t={t} />)}
            </div>
          </section>
        );
      })}

      <p className="text-xs text-muted-foreground">{t('fnx.cfo.ttm_note')}</p>
    </div>
  );
}

function RagCount({ tone, n, label }: { tone: 'green' | 'amber' | 'red'; n: number; label: string }) {
  const { text, Icon } = RAG_TONE[tone];
  return <span className={`inline-flex items-center gap-1 text-xs ${text}`}><Icon className="size-3.5" /><strong>{n}</strong> <span className="text-muted-foreground">{label}</span></span>;
}

function KpiTile({ kpi, lang, t }: { kpi: Kpi; lang: string; t: (k: string, v?: any) => string }) {
  const [open, setOpen] = useState(false);
  const tone = kpi.rag ? RAG_TONE[kpi.rag] : null;
  const ragLabel = kpi.rag ? t(`fnx.cfo.rag_${kpi.rag}`) : null;

  return (
    <Card className={`gap-2 border-l-4 p-3 ${tone ? tone.ring : 'border-l-transparent'}`}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium leading-tight">{lang === 'th' ? kpi.label : kpi.label_en}</span>
        {tone && ragLabel && (
          <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${tone.bg} ${tone.text}`}>
            <tone.Icon className="size-3" />{ragLabel}
          </span>
        )}
      </div>

      <div className="text-2xl font-semibold tabular-nums">{fmtValue(kpi.value, kpi.unit, lang)}</div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <Delta pct={kpi.delta_pp_pct} label={t('fnx.cfo.vs_pp')} />
        <Delta pct={kpi.delta_yoy_pct} label={t('fnx.cfo.vs_py')} />
        {kpi.vs_budget_pct != null && <Delta pct={kpi.vs_budget_pct} label={t('fnx.cfo.vs_budget')} />}
      </div>

      <div className="flex items-center justify-between">
        <button type="button" onClick={() => setOpen((o) => !o)} className="text-[11px] text-primary hover:underline">
          {t('fnx.cfo.trend_12m')}
        </button>
        <Link href={kpi.drill.href} className="text-[11px] text-muted-foreground hover:text-foreground hover:underline">
          {t('fnx.cfo.view_detail')}
        </Link>
      </div>

      {open && <Sparkline id={kpi.id} unit={kpi.unit} lang={lang} rag={kpi.rag} t={t} />}
    </Card>
  );
}

function Delta({ pct, label }: { pct: number | null; label: string }) {
  if (pct == null || !Number.isFinite(pct)) return null;
  const Icon = pct > 0 ? TrendingUp : pct < 0 ? TrendingDown : Minus;
  const sign = pct > 0 ? '+' : '';
  return <span className="inline-flex items-center gap-0.5"><Icon className="size-3" />{sign}{pct.toLocaleString('en-US', { maximumFractionDigits: 1 })}% <span className="opacity-70">{label}</span></span>;
}

interface TrendResp { series: { period: string; value: number | null; rag: Rag }[] }

function Sparkline({ id, unit, lang, rag, t }: { id: string; unit: string; lang: string; rag: Rag; t: (k: string, v?: any) => string }) {
  const [data, setData] = useState<TrendResp | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    api<TrendResp>(`/api/finance/metrics/${id}/trend?periods=12`)
      .then((r) => { if (alive) setData(r); })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [id]);

  const pts = (data?.series ?? []).map((s) => s.value).filter((v): v is number => v != null && Number.isFinite(v));
  if (err || (data && pts.length < 2)) return <p className="text-[11px] text-muted-foreground">{t('fnx.cfo.no_trend')}</p>;
  if (!data) return <div className="h-10 animate-pulse rounded bg-muted" />;

  const W = 220, H = 40, P = 3;
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = max - min || 1;
  const series = data.series.filter((s) => s.value != null) as { period: string; value: number }[];
  const x = (i: number) => P + (i * (W - 2 * P)) / Math.max(1, series.length - 1);
  const y = (v: number) => H - P - ((v - min) / span) * (H - 2 * P);
  const points = series.map((s, i) => `${x(i).toFixed(1)},${y(s.value).toFixed(1)}`).join(' ');
  const toneText = rag ? RAG_TONE[rag].text : 'text-primary';
  const last = series[series.length - 1];

  return (
    <div className="mt-1">
      <svg viewBox={`0 0 ${W} ${H}`} className={`w-full ${toneText}`} role="img" aria-label={t('fnx.cfo.trend_12m')}>
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
        <circle cx={x(series.length - 1)} cy={y(last.value)} r={2.5} fill="currentColor" />
      </svg>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{series[0]?.period}</span>
        <span>{fmtValue(last.value, unit, lang)}</span>
      </div>
    </div>
  );
}
