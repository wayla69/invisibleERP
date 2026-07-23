'use client';

// docs/61 — Marketing Activation workspace (/marketing-activation). The web surface over the five
// fact-driven activation tools (MKT-21…25) delivered in the marketing-activation API module: ③ Propensity &
// Cross-Sell, ⑤ Segment×Channel ROI, ② NBA Orchestrator, ① AI Campaign Studio, ④ Churn-Save Autopilot.
// Every tool is advisory — the only contact path is the consent-gated campaign draft, spend/contact passes
// maker-checker, and holdouts make every action measurable; the tabs surface those guardrails softly.
// Plain client page (pastel "Marketing Studio" tone from the app's own chart tokens via color-mix — theme-
// aware light AND dark), matching its marketing-analytics siblings (/mmm, /marketing-intel, /reputation).
// Gated to the marketing/exec duty. No ฿ anywhere — amounts render as "48,000 THB" (lib/format thb()).
import { useState } from 'react';
import { Rocket, ShieldCheck, TestTube2, MessageCircle } from 'lucide-react';
import { useLang } from '@/lib/i18n';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Overview } from '@/components/marketing-activation/overview';
import { Propensity } from '@/components/marketing-activation/propensity';
import { SegmentChannel } from '@/components/marketing-activation/segment-channel';
import { Nba } from '@/components/marketing-activation/nba';
import { Studio } from '@/components/marketing-activation/studio';
import { ChurnSave } from '@/components/marketing-activation/churn-save';
import { softText } from '@/components/marketing-activation/viz';
import type { ToolTab } from '@/components/marketing-activation/types';

export default function MarketingActivationPage() {
  const { t } = useLang();
  const [tab, setTab] = useState<ToolTab>('overview');

  return (
    <div className="space-y-8">
      {/* ── Hero — soft marketing gradient built from theme tokens (adapts to light/dark) ── */}
      <div
        className="relative overflow-hidden rounded-2xl border p-6 duration-500 animate-in fade-in-0 slide-in-from-top-2 sm:p-7"
        style={{
          background:
            'linear-gradient(120deg, color-mix(in oklch, var(--chart-1) 12%, var(--card)), color-mix(in oklch, var(--chart-4) 10%, var(--card)) 46%, color-mix(in oklch, var(--chart-3) 11%, var(--card)))',
          borderColor: 'color-mix(in oklch, var(--chart-1) 16%, var(--border))',
        }}
      >
        <div className="pointer-events-none absolute -right-10 -top-12 size-44 rounded-full opacity-40 blur-2xl"
          style={{ background: 'color-mix(in oklch, var(--chart-1) 28%, transparent)' }} />
        <div className="pointer-events-none absolute -bottom-14 right-40 size-32 rounded-full opacity-30 blur-2xl"
          style={{ background: 'color-mix(in oklch, var(--chart-3) 26%, transparent)' }} />
        <div className="relative flex flex-wrap items-start gap-4">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-background/70 shadow-sm backdrop-blur">
            <Rocket className="size-6" style={softText('var(--chart-1)')} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">{t('ma.title')}</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('ma.subtitle')}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-background/70 px-3 py-1 text-xs font-medium shadow-sm backdrop-blur">
                <MessageCircle className="size-3.5" style={softText('var(--chart-3)')} /> {t('ma.pill_consent')}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-background/70 px-3 py-1 text-xs font-medium shadow-sm backdrop-blur">
                <ShieldCheck className="size-3.5" style={softText('var(--chart-2)')} /> {t('ma.pill_mc')}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-background/70 px-3 py-1 text-xs font-medium shadow-sm backdrop-blur">
                <TestTube2 className="size-3.5" style={softText('var(--chart-4)')} /> {t('ma.pill_holdout')}
              </span>
            </div>
          </div>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as ToolTab)}>
        <TabsList className="mb-4 max-w-full flex-wrap">
          <TabsTrigger value="overview">{t('ma.tab_overview')}</TabsTrigger>
          <TabsTrigger value="propensity">{t('ma.tab_propensity')}</TabsTrigger>
          <TabsTrigger value="segment-channel">{t('ma.tab_roi')}</TabsTrigger>
          <TabsTrigger value="nba">{t('ma.tab_nba')}</TabsTrigger>
          <TabsTrigger value="studio">{t('ma.tab_studio')}</TabsTrigger>
          <TabsTrigger value="churn-save">{t('ma.tab_save')}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview"><Overview onOpen={setTab} /></TabsContent>
        <TabsContent value="propensity"><Propensity /></TabsContent>
        <TabsContent value="segment-channel"><SegmentChannel /></TabsContent>
        <TabsContent value="nba"><Nba /></TabsContent>
        <TabsContent value="studio"><Studio /></TabsContent>
        <TabsContent value="churn-save"><ChurnSave /></TabsContent>
      </Tabs>
    </div>
  );
}
