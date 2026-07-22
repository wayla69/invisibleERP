// Closed-loop Measurement (docs/60 Phase 3, MKT-19) — the incrementality tab of /marketing-intel. NO
// 'use client': imported only by the already-client page (ratchet stays flat). Start an experiment on a
// pushed segment (fixes a treatment arm + a randomised holdout control), then — after the window — measure
// the lift on real POS revenue. Control members are never contacted (treatment-only campaign).
import { useMemo, useState, type CSSProperties } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Play, Ruler, TrendingUp, Users, Shield } from 'lucide-react';
import { api } from '@/lib/api';
import { num, baht } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { StateView } from '@/components/state-view';
import { Button } from '@/components/ui/button';

const HUES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];
const tintBg = (h: string, pct = 9): CSSProperties => ({ background: `color-mix(in oklch, ${h} ${pct}%, var(--card))`, borderColor: `color-mix(in oklch, ${h} 16%, var(--border))` });
const softText = (h: string): CSSProperties => ({ color: `color-mix(in oklch, ${h} 66%, var(--foreground))` });

interface SegCount { segment: string; members: number }
interface Exp {
  experiment_no: string; segment: string; status: string;
  control_pct: number | null; window_days: number;
  treatment_count: number; control_count: number;
  started_at: string | null; measure_after: string | null;
  treatment_per_head: number | null; control_per_head: number | null;
  incremental_revenue: number | null; lift_pct: number | null;
}

export function Experiments() {
  const { t } = useLang();
  const qc = useQueryClient();
  const segQ = useQuery<{ segments: SegCount[] }>({ queryKey: ['marketing-intel', 'segments'], queryFn: () => api('/api/marketing-intel/segments') });
  const expQ = useQuery<{ experiments: Exp[] }>({ queryKey: ['marketing-intel', 'experiments'], queryFn: () => api('/api/marketing-intel/experiments') });
  const segments = useMemo(() => (Array.isArray(segQ.data?.segments) ? segQ.data!.segments : []), [segQ.data]);

  const [segment, setSegment] = useState<string>('');
  const [controlPct, setControlPct] = useState(20);
  const [windowDays, setWindowDays] = useState(14);
  const seg = segment || segments[0]?.segment || '';

  const start = useMutation({
    mutationFn: () => api('/api/marketing-intel/experiments', { method: 'POST', body: JSON.stringify({ segment: seg, control_pct: controlPct / 100, window_days: windowDays, activate: true }) }),
    onSuccess: () => { notifySuccess(t('mi.ex_started')); qc.invalidateQueries({ queryKey: ['marketing-intel', 'experiments'] }); },
    onError: (e: any) => notifyError(e?.body?.error?.code === 'EMPTY_SEGMENT' ? t('mi.activate_empty') : (e?.message ?? 'error')),
  });
  const measure = useMutation({
    mutationFn: (no: string) => api('/api/marketing-intel/experiments/measure', { method: 'POST', body: JSON.stringify({ experiment_no: no }) }),
    onSuccess: () => { notifySuccess(t('mi.ex_measured')); qc.invalidateQueries({ queryKey: ['marketing-intel', 'experiments'] }); },
    onError: (e: any) => {
      const code = e?.body?.error?.code;
      notifyError(code === 'WINDOW_NOT_ELAPSED' ? t('mi.ex_not_elapsed') : code === 'NO_CONTROL' ? t('mi.ex_no_control') : (e?.message ?? 'error'));
    },
  });

  const experiments = Array.isArray(expQ.data?.experiments) ? expQ.data!.experiments : [];

  return (
    <StateView q={segQ}>
      {segQ.data && (
        <div className="space-y-5">
          <div>
            <h2 className="text-lg font-semibold">{t('mi.ex_title')}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{t('mi.ex_subtitle')}</p>
          </div>

          {/* Start an experiment */}
          {segments.length > 0 ? (
            <div className="grid gap-4 rounded-2xl border p-5 sm:grid-cols-[1fr_auto_auto_auto]" style={tintBg('var(--chart-2)')}>
              <label className="text-sm">
                <span className="mb-1 block font-medium text-muted-foreground">{t('mi.ex_segment')}</span>
                <select value={seg} onChange={(e) => setSegment(e.target.value)} className="w-full rounded-lg border bg-background/70 px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring">
                  {segments.map((sgm) => <option key={sgm.segment} value={sgm.segment}>{sgm.segment} ({num(sgm.members)})</option>)}
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block font-medium text-muted-foreground">{t('mi.ex_holdout')}</span>
                <input type="number" min={0} max={90} value={controlPct} onChange={(e) => setControlPct(Math.max(0, Math.min(90, Number(e.target.value) || 0)))} className="w-24 rounded-lg border bg-background/70 px-3 py-1.5 text-sm tabular-nums outline-none focus:ring-2 focus:ring-ring" />
              </label>
              <label className="text-sm">
                <span className="mb-1 block font-medium text-muted-foreground">{t('mi.ex_window')}</span>
                <input type="number" min={0} max={365} value={windowDays} onChange={(e) => setWindowDays(Math.max(0, Math.min(365, Number(e.target.value) || 0)))} className="w-24 rounded-lg border bg-background/70 px-3 py-1.5 text-sm tabular-nums outline-none focus:ring-2 focus:ring-ring" />
              </label>
              <div className="flex items-end">
                <Button size="sm" disabled={start.isPending || !seg} onClick={() => start.mutate()}>
                  <Play className="size-4" /> {t('mi.ex_start')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground" style={tintBg('var(--chart-3)', 8)}>
              <FlaskConical className="mx-auto mb-2 size-6 opacity-60" /> {t('mi.ci_no_data')}
            </div>
          )}

          <p className="flex items-start gap-1.5 rounded-lg border border-dashed p-2.5 text-xs text-muted-foreground" style={tintBg('var(--chart-4)', 7)}>
            <Shield className="mt-0.5 size-3.5 shrink-0" /> {t('mi.ex_holdout_note')}
          </p>

          {/* Experiment list */}
          <StateView q={expQ}>
            {expQ.data && (experiments.length === 0 ? (
              <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{t('mi.ex_empty')}</p>
            ) : (
              <div className="grid gap-3">
                {experiments.map((e, i) => {
                  const hue = HUES[i % HUES.length];
                  const measured = e.status === 'Measured';
                  const positive = (e.lift_pct ?? 0) >= 0;
                  return (
                    <div key={e.experiment_no} className="rounded-2xl border p-4" style={tintBg(measured ? (positive ? 'var(--chart-3)' : 'var(--chart-1)') : hue, 8)}>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 font-semibold">
                            <FlaskConical className="size-4" style={softText(hue)} /> {e.experiment_no}
                            <span className="rounded-full bg-background/70 px-2 py-0.5 text-xs font-medium text-muted-foreground">{e.segment}</span>
                          </div>
                          <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                            <span className="inline-flex items-center gap-1"><Users className="size-3" /> {t('mi.ex_treatment')} {num(e.treatment_count)} · {t('mi.ex_control')} {num(e.control_count)}</span>
                            <span>· {num((e.control_pct ?? 0) * 100, 0)}% {t('mi.ex_holdout')} · {num(e.window_days)}{t('mi.ex_days')}</span>
                          </div>
                        </div>
                        {measured ? (
                          <div className="text-right">
                            <div className={`inline-flex items-center gap-1 text-lg font-semibold tabular-nums ${positive ? 'text-success' : 'text-destructive'}`}>
                              <TrendingUp className="size-4" /> {e.lift_pct == null ? '—' : `${positive ? '+' : ''}${num(e.lift_pct, 1)}%`}
                            </div>
                            <div className="text-xs text-muted-foreground tabular-nums">{t('mi.ex_incremental')}: {baht(e.incremental_revenue ?? 0)}</div>
                          </div>
                        ) : (
                          <Button size="sm" variant="outline" className="bg-background/60" disabled={measure.isPending} onClick={() => measure.mutate(e.experiment_no)}>
                            <Ruler className="size-4" /> {t('mi.ex_measure')}
                          </Button>
                        )}
                      </div>
                      {measured && (
                        <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                          <div className="rounded-lg bg-background/60 p-2.5">
                            <div className="text-muted-foreground">{t('mi.ex_treatment')} / {t('mi.ex_perhead')}</div>
                            <div className="font-semibold tabular-nums" style={softText('var(--chart-3)')}>{baht(e.treatment_per_head ?? 0)}</div>
                          </div>
                          <div className="rounded-lg bg-background/60 p-2.5">
                            <div className="text-muted-foreground">{t('mi.ex_control')} / {t('mi.ex_perhead')}</div>
                            <div className="font-semibold tabular-nums">{baht(e.control_per_head ?? 0)}</div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </StateView>
        </div>
      )}
    </StateView>
  );
}
