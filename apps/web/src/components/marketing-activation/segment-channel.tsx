// ⑤ Segment × Channel ROI tab (MKT-25) — extends the Budget Optimizer from channel to segment × channel.
// Budget in → ranked cells (incremental ROI × value) + a recommended channel split; staging reuses the
// MKT-17 maker-checker budget plan (approval happens on /marketing-intel → Budget Planner).
// NO 'use client' (inherits the /marketing-activation page boundary — see viz.tsx).
import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { TrendingUp, Wand2, Send, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { num, thb } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { notifySuccess, notifyError } from '@/lib/notify';
import { StateView } from '@/components/state-view';
import { HUES, tintBg, softText, Chip, SoftNote, EmptyCard, Meter, ENTER, stagger } from './viz';

export function SegmentChannel() {
  const { t } = useLang();
  const [budgetInput, setBudgetInput] = useState('100000');
  const [budget, setBudget] = useState(100000);

  const q = useQuery<any>({
    queryKey: ['ma', 'seg-channel', budget],
    queryFn: () => api(`/api/marketing-activation/segment-channel-roi?budget=${budget}`),
    retry: false,
  });

  const stage = useMutation({
    mutationFn: () => api('/api/marketing-activation/segment-channel-roi/stage', { method: 'POST', body: JSON.stringify({ total_budget: budget }) }),
    onSuccess: (r: any) => notifySuccess(t('ma.roi_staged', { plan: String(r?.plan_no ?? '') })),
    onError: (e: any) => notifyError(e?.message ?? 'error'),
  });

  const cells: any[] = Array.isArray(q.data?.cells) ? q.data.cells : [];
  const alloc: Record<string, number> = q.data?.channel_allocation ?? {};
  const allocEntries = Object.entries(alloc);
  const allocTotal = allocEntries.reduce((s, [, v]) => s + Number(v || 0), 0);
  const topCells = cells.slice(0, 8);
  const maxScore = topCells.reduce((m, c) => Math.max(m, Number(c?.score) || 0), 0) || 1;

  return (
    <div className="space-y-5">
      <section className={`space-y-4 rounded-2xl border p-5 ${ENTER}`} style={{ ...tintBg('var(--chart-5)', 7), ...stagger(0) }}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 font-semibold">
            <TrendingUp className="size-4" style={softText('var(--chart-5)')} /> {t('ma.roi_heading')}
          </div>
          <form
            className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto"
            onSubmit={(e) => { e.preventDefault(); const v = Number(budgetInput); if (Number.isFinite(v) && v > 0) setBudget(v); }}
          >
            <span className="text-xs text-muted-foreground">{t('ma.roi_budget')}</span>
            <Input value={budgetInput} onChange={(e) => setBudgetInput(e.target.value)} inputMode="numeric" className="w-32 bg-background/70 text-right tabular-nums" />
            <span className="text-xs font-semibold text-muted-foreground">THB</span>
            <Button type="submit" variant="secondary" className="shrink-0"><Wand2 className="mr-1 size-4" />{t('ma.roi_rank')}</Button>
          </form>
        </div>

        <StateView q={q}>
          {q.data && (!q.data.has_mmm || cells.length === 0 ? (
            <EmptyCard hue="var(--chart-5)" icon={TrendingUp} title={t('ma.roi_empty')} desc={t('ma.roi_empty_desc')} />
          ) : (
            <div className="grid gap-4 lg:grid-cols-[1fr_minmax(0,320px)]">
              {/* Ranked segment × channel cells */}
              <div className="space-y-2">
                {topCells.map((c, i) => (
                  <div key={`${c.segment}|${c.channel}`} className={`flex items-center gap-3 rounded-xl border bg-background/60 p-3 ${ENTER}`} style={stagger(i)}>
                    <span className="w-5 shrink-0 text-center text-xs font-bold text-muted-foreground">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                        <span className="truncate">{String(c.segment)}</span>
                        <span className="text-muted-foreground">×</span>
                        <span className="truncate">{String(c.channel)}</span>
                        {c.lift_pct != null && <Chip hue="var(--chart-4)">{t('ma.roi_measured')} {num(c.lift_pct)}%</Chip>}
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        <Meter hue={HUES[i % HUES.length]} pctWidth={(Number(c.score) / maxScore) * 100} />
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">ROI {num(c.incremental_roi, 1)}×</span>
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-xs text-muted-foreground">
                      <div>{t('ma.prop_reach', { n: num(c.reach) })}</div>
                      {c.avg_clv != null && <div>CLV {thb(c.avg_clv)}</div>}
                    </div>
                  </div>
                ))}
              </div>

              {/* Recommended channel split + staging */}
              <div className="space-y-3 rounded-xl border bg-background/60 p-4 self-start">
                <div className="text-sm font-semibold">{t('ma.roi_split')}</div>
                {allocEntries.map(([ch, v], i) => (
                  <div key={ch} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium">{ch}</span>
                      <span className="tabular-nums text-muted-foreground">{thb(v)} · {allocTotal ? num((Number(v) / allocTotal) * 100) : 0}%</span>
                    </div>
                    <Meter hue={HUES[i % HUES.length]} pctWidth={allocTotal ? (Number(v) / allocTotal) * 100 : 0} />
                  </div>
                ))}
                <Button className="w-full" onClick={() => stage.mutate()} disabled={stage.isPending}>
                  <Send className="mr-1.5 size-4" /> {t('ma.roi_stage')}
                </Button>
                <Link href="/marketing-intel" className="flex items-center justify-center gap-1 text-xs font-medium text-muted-foreground hover:underline">
                  {t('ma.roi_approve_link')} <ExternalLink className="size-3" />
                </Link>
              </div>
            </div>
          ))}
        </StateView>
        <SoftNote hue="var(--chart-5)">{t('ma.roi_note')}</SoftNote>
      </section>
    </div>
  );
}
