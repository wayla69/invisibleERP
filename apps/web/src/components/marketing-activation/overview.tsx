// Marketing Activation — Overview tab (docs/61). Real reads only: journeys / generations / save-runs /
// pushed segments, plus soft tool cards that jump to each tool's tab and the trust card stating the
// guardrails. NO 'use client' (inherits the /marketing-activation page boundary — see viz.tsx).
import { useQuery } from '@tanstack/react-query';
import {
  ShoppingCart, TrendingUp, Compass, Bot, HeartHandshake, ShieldCheck, MessageCircle, Users2, TestTube2, Lock,
} from 'lucide-react';
import { api } from '@/lib/api';
import { num, compactThb } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { KpiCard, SoftNote, tintBg, softText, ENTER, stagger } from './viz';
import type { ToolTab } from './types';

const TOOLS: { tab: ToolTab; hue: string; icon: typeof ShoppingCart; name: string; desc: string; ctl: string }[] = [
  { tab: 'propensity', hue: 'var(--chart-1)', icon: ShoppingCart, name: 'ma.tool_prop', desc: 'ma.tool_prop_desc', ctl: 'MKT-23' },
  { tab: 'segment-channel', hue: 'var(--chart-5)', icon: TrendingUp, name: 'ma.tool_roi', desc: 'ma.tool_roi_desc', ctl: 'MKT-25' },
  { tab: 'nba', hue: 'var(--chart-2)', icon: Compass, name: 'ma.tool_nba', desc: 'ma.tool_nba_desc', ctl: 'MKT-22' },
  { tab: 'studio', hue: 'var(--chart-4)', icon: Bot, name: 'ma.tool_studio', desc: 'ma.tool_studio_desc', ctl: 'MKT-21' },
  { tab: 'churn-save', hue: 'var(--chart-3)', icon: HeartHandshake, name: 'ma.tool_save', desc: 'ma.tool_save_desc', ctl: 'MKT-24' },
];

export function Overview({ onOpen }: { onOpen: (tab: ToolTab) => void }) {
  const { t } = useLang();
  const journeysQ = useQuery<{ journeys: any[] }>({ queryKey: ['ma', 'journeys'], queryFn: () => api('/api/marketing-activation/nba/journeys') });
  const gensQ = useQuery<{ generations: any[] }>({ queryKey: ['ma', 'generations'], queryFn: () => api('/api/marketing-activation/studio/generations') });
  const runsQ = useQuery<{ runs: any[] }>({ queryKey: ['ma', 'save-runs'], queryFn: () => api('/api/marketing-activation/save/runs') });
  const miQ = useQuery<any>({ queryKey: ['marketing-intel', 'summary'], queryFn: () => api('/api/marketing-intel/summary') });

  const journeys = Array.isArray(journeysQ.data?.journeys) ? journeysQ.data!.journeys : [];
  const pendingJourneys = journeys.filter((j) => j?.status === 'Pending').length;
  const gens = Array.isArray(gensQ.data?.generations) ? gensQ.data!.generations : [];
  const runs = Array.isArray(runsQ.data?.runs) ? runsQ.data!.runs : [];
  const latestRun = runs[0] ?? null;
  const segments: any[] = Array.isArray(miQ.data?.rfm?.payload?.segments) ? miQ.data.rfm.payload.segments : [];

  return (
    <div className="space-y-6">
      {/* Real-read KPI strip — every figure comes from a live endpoint, zero-safe on a fresh tenant. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className={ENTER} style={stagger(0)}>
          <KpiCard hue="var(--chart-2)" icon={Compass} label={t('ma.kpi_journeys')}
            value={num(journeys.length)} sub={t('ma.kpi_journeys_sub', { n: num(pendingJourneys) })} />
        </div>
        <div className={ENTER} style={stagger(1)}>
          <KpiCard hue="var(--chart-4)" icon={Bot} label={t('ma.kpi_generations')}
            value={num(gens.length)} sub={t('ma.kpi_generations_sub')} />
        </div>
        <div className={ENTER} style={stagger(2)}>
          <KpiCard hue="var(--chart-3)" icon={HeartHandshake} label={t('ma.kpi_saved')}
            value={latestRun?.net_benefit != null ? compactThb(latestRun.net_benefit) : '—'}
            sub={latestRun ? t('ma.kpi_saved_sub', { run: String(latestRun.run_no ?? '') }) : t('ma.kpi_saved_none')} />
        </div>
        <div className={ENTER} style={stagger(3)}>
          <KpiCard hue="var(--chart-1)" icon={Users2} label={t('ma.kpi_segments')}
            value={num(segments.length)} sub={t('ma.kpi_segments_sub')} />
        </div>
      </div>

      {/* Tool launcher cards — the five docs/61 tools, soft + friendly, jump straight to their tab. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TOOLS.map((tool, i) => (
          <button
            key={tool.tab}
            type="button"
            onClick={() => onOpen(tool.tab)}
            className={`group rounded-2xl border p-5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${ENTER}`}
            style={{ ...tintBg(tool.hue), ...stagger(4 + i) }}
          >
            <div className="flex items-start gap-3">
              <span className="flex size-11 items-center justify-center rounded-2xl bg-background/70 shadow-sm">
                <tool.icon className="size-5" style={softText(tool.hue)} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{t(tool.name)}</span>
                  <span className="rounded-full bg-background/70 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground shadow-sm">{tool.ctl}</span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t(tool.desc)}</p>
              </div>
            </div>
            <div className="mt-3 text-xs font-semibold transition-transform duration-200 group-hover:translate-x-0.5" style={softText(tool.hue)}>
              {t('ma.open_tool')} →
            </div>
          </button>
        ))}

        {/* Trust card — how the whole toolkit stays safe. */}
        <div className={`rounded-2xl border p-5 ${ENTER}`} style={{ ...tintBg('var(--chart-5)', 11), ...stagger(9) }}>
          <div className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="size-4" style={softText('var(--chart-5)')} /> {t('ma.trust_title')}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t('ma.trust_sub')}</p>
          <div className="mt-3 space-y-2 text-xs font-medium">
            <div className="flex items-center gap-2"><MessageCircle className="size-3.5 shrink-0" style={softText('var(--chart-3)')} /> {t('ma.trust_consent')}</div>
            <div className="flex items-center gap-2"><Users2 className="size-3.5 shrink-0" style={softText('var(--chart-2)')} /> {t('ma.trust_mc')}</div>
            <div className="flex items-center gap-2"><TestTube2 className="size-3.5 shrink-0" style={softText('var(--chart-4)')} /> {t('ma.trust_holdout')}</div>
            <div className="flex items-center gap-2"><Lock className="size-3.5 shrink-0" style={softText('var(--chart-1)')} /> {t('ma.trust_rls')}</div>
          </div>
        </div>
      </div>

      <SoftNote>{t('ma.overview_note')}</SoftNote>
    </div>
  );
}
