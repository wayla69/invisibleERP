// Budget Planner (docs/60 Phase 1) — the prescriptive tab of /marketing-intel. NO 'use client' directive:
// it is imported only by the already-'use client' /marketing-intel page, so it inherits that client
// boundary (keeps the use-client ratchet flat — same pattern as pos/exchange-dialog.tsx).
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Wand2, Wallet, TrendingUp, Megaphone, Check, Sparkles, Info } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thb } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { StateView } from '@/components/state-view';
import { Button } from '@/components/ui/button';

const HUES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];
const tintBg = (h: string, pct = 9): CSSProperties => ({ background: `color-mix(in oklch, ${h} ${pct}%, var(--card))`, borderColor: `color-mix(in oklch, ${h} 16%, var(--border))` });
const softText = (h: string): CSSProperties => ({ color: `color-mix(in oklch, ${h} 66%, var(--foreground))` });
const fill = (h: string): string => `color-mix(in oklch, ${h} 78%, var(--card))`;

interface Curve { channel: string; current_spend: number; roi: number | null; beta: number; kappa: number; slope: number; derived: boolean }
interface CurvesResp { has_data: boolean; basis: string; derived: boolean; current_spend: number; current_predicted_sales: number; channels: Curve[] }

// Client-side Hill saturation — mirrors the server optimiser so the what-if predicted-sales figure updates
// instantly as the sliders move (the server /simulate is authoritative and gives the identical number).
function hill(spend: number, c: Curve): number {
  const x = Math.max(0, spend);
  if (c.beta <= 0 || c.kappa <= 0 || c.slope <= 0) return 0;
  const xs = Math.pow(x, c.slope), ks = Math.pow(c.kappa, c.slope);
  return (c.beta * xs) / (ks + xs);
}
const capOf = (c: Curve) => Math.max(3 * c.current_spend, 10_000);

export function BudgetPlanner() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<CurvesResp>({ queryKey: ['marketing-intel', 'curves'], queryFn: () => api('/api/marketing-intel/response-curves') });
  const plansQ = useQuery<{ plans: any[] }>({ queryKey: ['marketing-intel', 'plans'], queryFn: () => api('/api/marketing-intel/budget-plans') });

  const curves = useMemo(() => (Array.isArray(q.data?.channels) ? q.data!.channels : []), [q.data]);
  const [alloc, setAlloc] = useState<Record<string, number>>({});
  const [budget, setBudget] = useState(0);
  const [note, setNote] = useState('');

  // Seed the sliders + budget from the current spend once the curves load.
  useEffect(() => {
    if (!curves.length) return;
    setAlloc((prev) => (Object.keys(prev).length ? prev : Object.fromEntries(curves.map((c) => [c.channel, c.current_spend]))));
    setBudget((prev) => (prev > 0 ? prev : curves.reduce((s, c) => s + c.current_spend, 0)));
  }, [curves]);

  const predicted = useMemo(() => curves.reduce((s, c) => s + hill(alloc[c.channel] ?? 0, c), 0), [alloc, curves]);
  const totalAlloc = useMemo(() => Object.values(alloc).reduce((s, v) => s + v, 0), [alloc]);
  const currentPredicted = q.data?.current_predicted_sales ?? 0;
  const uplift = currentPredicted > 0 ? ((predicted - currentPredicted) / currentPredicted) * 100 : 0;

  const optimize = useMutation({
    mutationFn: () => api('/api/marketing-intel/optimize', { method: 'POST', body: JSON.stringify({ budget: budget || totalAlloc }) }),
    onSuccess: (r: any) => { setAlloc(r.allocation ?? {}); if (r.budget) setBudget(Math.round(r.budget)); },
    onError: (e: any) => notifyError(e?.message ?? 'error'),
  });
  const stage = useMutation({
    mutationFn: () => api('/api/marketing-intel/budget-plan', { method: 'POST', body: JSON.stringify({ total_budget: totalAlloc, allocation: alloc, note: note || undefined }) }),
    onSuccess: () => { notifySuccess(t('mi.bp_staged')); setNote(''); qc.invalidateQueries({ queryKey: ['marketing-intel', 'plans'] }); },
    onError: (e: any) => notifyError(e?.message ?? 'error'),
  });
  const approve = useMutation({
    mutationFn: (planNo: string) => api('/api/marketing-intel/budget-plan/approve', { method: 'POST', body: JSON.stringify({ plan_no: planNo }) }),
    onSuccess: () => { notifySuccess(t('mi.bp_approved_done')); qc.invalidateQueries({ queryKey: ['marketing-intel', 'plans'] }); },
    onError: (e: any) => notifyError(e?.body?.error?.code === 'SOD_SELF_APPROVAL' ? t('mi.bp_self_approve') : (e?.message ?? 'error')),
  });

  const setChannel = (channel: string, v: number) => setAlloc((a) => ({ ...a, [channel]: v }));
  const plans: any[] = Array.isArray(plansQ.data?.plans) ? plansQ.data!.plans : [];

  return (
    <StateView q={q}>
      {q.data && (!q.data.has_data ? (
        <div className="rounded-2xl border border-dashed p-12 text-center" style={tintBg('var(--chart-3)', 8)}>
          <Sparkles className="mx-auto mb-3 size-8" style={softText('var(--chart-3)')} />
          <p className="text-base font-semibold">{t('mi.bp_no_data')}</p>
        </div>
      ) : (
        <div className="space-y-5">
          <div>
            <h2 className="text-lg font-semibold">{t('mi.bp_title')}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{t('mi.bp_subtitle')}</p>
          </div>

          {q.data.derived && (
            <p className="flex items-start gap-1.5 rounded-lg border border-dashed p-2.5 text-xs text-muted-foreground" style={tintBg('var(--chart-4)', 7)}>
              <Info className="mt-0.5 size-3.5 shrink-0" /> {t('mi.bp_derived')}
            </p>
          )}

          {/* Budget input + Optimise + predicted */}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-2xl border p-5" style={tintBg('var(--chart-2)')}>
              <label className="text-sm font-medium text-muted-foreground">{t('mi.bp_total_budget')}</label>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-xs font-semibold" style={softText('var(--chart-2)')}>THB</span>
                <input
                  type="number" min={0} value={budget || ''}
                  onChange={(e) => setBudget(Math.max(0, Number(e.target.value) || 0))}
                  className="w-full rounded-lg border bg-background/70 px-3 py-1.5 text-lg font-semibold tabular-nums outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <Button size="sm" className="mt-3 w-full" disabled={optimize.isPending} onClick={() => optimize.mutate()}>
                <Wand2 className="size-4" /> {t('mi.bp_optimise')}
              </Button>
            </div>
            <div className="rounded-2xl border p-5" style={tintBg('var(--chart-3)')}>
              <p className="text-sm font-medium text-muted-foreground">{t('mi.bp_predicted')}</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums" style={softText('var(--chart-3)')}>{thb(predicted)}</p>
              <p className={`mt-1 inline-flex items-center gap-1 text-xs font-medium ${uplift >= 0 ? 'text-success' : 'text-destructive'}`}>
                <TrendingUp className="size-3.5" /> {uplift >= 0 ? '+' : ''}{num(uplift, 1)}% {t('mi.bp_uplift')}
              </p>
            </div>
            <div className="rounded-2xl border p-5" style={tintBg('var(--chart-4)')}>
              <p className="text-sm font-medium text-muted-foreground">{t('mi.bp_current')}</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums">{thb(totalAlloc)}</p>
              <p className="mt-1 text-xs text-muted-foreground tabular-nums">{t('mi.bp_predicted')}: {thb(currentPredicted)}</p>
            </div>
          </div>

          {/* Per-channel sliders */}
          <div className="grid gap-3">
            {curves.map((c, i) => {
              const hue = HUES[i % HUES.length];
              const cap = capOf(c);
              const spend = alloc[c.channel] ?? 0;
              const pred = hill(spend, c);
              return (
                <div key={c.channel} className="rounded-xl border p-4" style={tintBg(hue)}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 font-medium">
                      <span className="inline-block size-2.5 rounded-full" style={{ background: fill(hue) }} /> {c.channel}
                      {c.roi != null && <span className="text-xs text-muted-foreground">· ROI {num(c.roi)}×</span>}
                    </div>
                    <div className="text-right text-sm tabular-nums">
                      <span className="font-semibold" style={softText(hue)}>{thb(spend)}</span>
                      <span className="ml-2 text-xs text-muted-foreground">→ {thb(pred)}</span>
                    </div>
                  </div>
                  <input
                    type="range" min={0} max={cap} step={Math.max(1, Math.round(cap / 200))} value={spend}
                    onChange={(e) => setChannel(c.channel, Number(e.target.value))}
                    className="mt-3 w-full accent-[var(--chart-2)]"
                    style={{ accentColor: fill(hue) }}
                    aria-label={c.channel}
                  />
                </div>
              );
            })}
          </div>

          {/* Stage a plan */}
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border p-4" style={tintBg('var(--chart-5)', 8)}>
            <input
              value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('mi.bp_note_ph')} maxLength={500}
              className="min-w-[180px] flex-1 rounded-lg border bg-background/70 px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <Button size="sm" variant="outline" className="bg-background/60" disabled={stage.isPending || totalAlloc <= 0} onClick={() => stage.mutate()}>
              <Megaphone className="size-4" /> {t('mi.bp_stage')}
            </Button>
          </div>

          {/* Staged plans + approve */}
          {plans.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">{t('mi.bp_plans')}</h3>
              <div className="grid gap-2">
                {plans.map((p) => {
                  const approved = p.status === 'Approved';
                  return (
                    <div key={p.plan_no} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3" style={tintBg(approved ? 'var(--chart-3)' : 'var(--chart-4)', 8)}>
                      <div className="min-w-0 text-sm">
                        <span className="font-semibold tabular-nums">{p.plan_no}</span>
                        <span className="ml-2 text-muted-foreground tabular-nums">{thb(p.total_budget)} → {thb(p.predicted_sales ?? 0)}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{t('mi.bp_by')} {p.requested_by}{approved && p.approved_by ? ` · ✓ ${p.approved_by}` : ''}</span>
                      </div>
                      {approved ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-background/70 px-2.5 py-1 text-xs font-semibold shadow-sm" style={softText('var(--chart-3)')}>
                          <Check className="size-3.5" /> {t('mi.bp_approve')}d
                        </span>
                      ) : (
                        <Button size="sm" variant="outline" className="bg-background/60" disabled={approve.isPending} onClick={() => approve.mutate(p.plan_no)}>
                          <Check className="size-4" /> {t('mi.bp_approve')}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ))}
    </StateView>
  );
}
