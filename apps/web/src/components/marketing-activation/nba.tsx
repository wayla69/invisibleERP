// ② NBA Orchestrator tab (MKT-22) — the advisory mi_nba turned into a prioritised per-customer journey.
// Preview ranks by expected value + shows the server-side suppression (consent / recent purchase / no
// action); staging persists a Pending journey; activation is maker-checker and only creates a consent-gated
// draft for the treatment arm. NO 'use client' (inherits the page boundary — see viz.tsx).
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Compass, Sparkles, Send, CheckCheck, Ruler, TrendingUp } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thb } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { notifySuccess, notifyError } from '@/lib/notify';
import { StateView } from '@/components/state-view';
import { tintBg, softText, Chip, SoftNote, EmptyCard, ENTER, stagger } from './viz';

const SUPPRESS_HUE: Record<string, string> = { CONSENT: 'var(--chart-1)', RECENT_PURCHASE: 'var(--chart-4)', NO_ACTION: 'var(--chart-5)' };

export function Nba() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [segment, setSegment] = useState('');

  const miQ = useQuery<any>({ queryKey: ['marketing-intel', 'summary'], queryFn: () => api('/api/marketing-intel/summary') });
  const segments = useMemo(() => {
    const rows: any[] = Array.isArray(miQ.data?.rfm?.payload?.segments) ? miQ.data.rfm.payload.segments : [];
    return rows.map((s) => String(s.segment ?? '')).filter(Boolean);
  }, [miQ.data]);

  const previewQ = useQuery<any>({
    queryKey: ['ma', 'nba-preview', segment],
    queryFn: () => api(`/api/marketing-activation/nba/preview?segment=${encodeURIComponent(segment)}`),
    enabled: !!segment,
    retry: false,
  });
  const journeysQ = useQuery<{ journeys: any[] }>({ queryKey: ['ma', 'journeys'], queryFn: () => api('/api/marketing-activation/nba/journeys') });

  const stage = useMutation({
    mutationFn: () => api('/api/marketing-activation/nba/stage', { method: 'POST', body: JSON.stringify({ segment }) }),
    onSuccess: (r: any) => { notifySuccess(t('ma.nba_staged', { j: String(r?.journey_no ?? '') })); qc.invalidateQueries({ queryKey: ['ma', 'journeys'] }); },
    onError: (e: any) => notifyError(e?.message ?? 'error'),
  });
  const activate = useMutation({
    mutationFn: (journeyNo: string) => api('/api/marketing-activation/nba/activate', { method: 'POST', body: JSON.stringify({ journey_no: journeyNo }) }),
    onSuccess: () => { notifySuccess(t('ma.nba_activated')); qc.invalidateQueries({ queryKey: ['ma', 'journeys'] }); },
    onError: (e: any) => notifyError(e?.body?.error?.code === 'SOD_SELF_APPROVAL' ? t('ma.self_approve') : (e?.message ?? 'error')),
  });
  const measure = useMutation({
    mutationFn: (journeyNo: string) => api('/api/marketing-activation/nba/measure', { method: 'POST', body: JSON.stringify({ journey_no: journeyNo }) }),
    onSuccess: () => { notifySuccess(t('ma.measured_done')); qc.invalidateQueries({ queryKey: ['ma', 'journeys'] }); },
    onError: (e: any) => {
      const code = e?.body?.error?.code;
      notifyError(code === 'WINDOW_NOT_ELAPSED' ? t('ma.measure_window') : code === 'NO_CONTROL' ? t('ma.measure_no_control') : (e?.message ?? 'error'));
    },
  });

  const targets: any[] = Array.isArray(previewQ.data?.targets) ? previewQ.data.targets : [];
  const suppressed: any[] = Array.isArray(previewQ.data?.suppressed) ? previewQ.data.suppressed : [];
  const journeys: any[] = Array.isArray(journeysQ.data?.journeys) ? journeysQ.data.journeys : [];

  return (
    <div className="space-y-5">
      <section className={`space-y-4 rounded-2xl border p-5 ${ENTER}`} style={{ ...tintBg('var(--chart-2)', 7), ...stagger(0) }}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 font-semibold">
            <Compass className="size-4" style={softText('var(--chart-2)')} /> {t('ma.nba_heading')}
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
            <Select value={segment || undefined} onValueChange={setSegment}>
              <SelectTrigger className="w-full bg-background/70 sm:w-56"><SelectValue placeholder={t('ma.pick_segment')} /></SelectTrigger>
              <SelectContent>
                {segments.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="secondary" disabled={!segment || stage.isPending} onClick={() => stage.mutate()}>
              <Send className="mr-1 size-4" /> {t('ma.nba_stage')}
            </Button>
          </div>
        </div>

        {!segment ? (
          <EmptyCard hue="var(--chart-2)" icon={Compass} title={t('ma.nba_empty')} desc={t('ma.nba_empty_desc')} />
        ) : (
          <StateView q={previewQ}>
            {previewQ.data && (
              <div className="grid gap-4 lg:grid-cols-[1fr_minmax(0,300px)]">
                {/* EV-ranked targets */}
                <div className="space-y-2">
                  {targets.length === 0 ? (
                    <EmptyCard hue="var(--chart-2)" icon={Sparkles} title={t('ma.nba_no_targets')} />
                  ) : targets.slice(0, 8).map((tg, i) => (
                    <div key={String(tg.member_id)} className={`flex items-center gap-3 rounded-xl border bg-background/60 p-3 ${ENTER}`} style={stagger(i)}>
                      <span className="w-5 shrink-0 text-center text-xs font-bold text-muted-foreground">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-semibold">#{String(tg.member_id)}</span>
                          {tg.action && <Chip hue="var(--chart-2)">{String(tg.action)}</Chip>}
                          <Chip hue={tg.arm === 'treatment' ? 'var(--chart-3)' : 'var(--chart-5)'}>
                            {tg.arm === 'treatment' ? t('ma.arm_treatment') : t('ma.arm_control')}
                          </Chip>
                        </div>
                        {tg.preferred_channel && <div className="mt-0.5 text-xs text-muted-foreground">{t('ma.channel')}: {String(tg.preferred_channel)}</div>}
                      </div>
                      <div className="shrink-0 text-sm font-semibold tabular-nums" style={softText('var(--chart-2)')}>EV {thb(tg.expected_value)}</div>
                    </div>
                  ))}
                </div>

                {/* Counts + suppression evidence */}
                <div className="space-y-3 self-start rounded-xl border bg-background/60 p-4">
                  <div className="text-sm font-semibold">{t('ma.nba_summary')}</div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div><div className="text-lg font-semibold tabular-nums">{num(previewQ.data.treatment_count)}</div><div className="text-[11px] text-muted-foreground">{t('ma.arm_treatment')}</div></div>
                    <div><div className="text-lg font-semibold tabular-nums">{num(previewQ.data.control_count)}</div><div className="text-[11px] text-muted-foreground">{t('ma.arm_control')}</div></div>
                    <div><div className="text-lg font-semibold tabular-nums">{num(previewQ.data.suppressed_count)}</div><div className="text-[11px] text-muted-foreground">{t('ma.suppressed')}</div></div>
                  </div>
                  {suppressed.length > 0 && (
                    <div className="space-y-1.5 border-t pt-3">
                      {suppressed.slice(0, 6).map((s) => (
                        <div key={String(s.member_id)} className="flex items-center justify-between gap-2 text-xs">
                          <span className="text-muted-foreground">#{String(s.member_id)}</span>
                          <Chip hue={SUPPRESS_HUE[String(s.reason)] ?? 'var(--chart-5)'}>{String(s.reason)}</Chip>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </StateView>
        )}
        <SoftNote hue="var(--chart-2)">{t('ma.nba_note')}</SoftNote>
      </section>

      {/* Staged journeys → maker-checker activation */}
      <section className={`space-y-3 rounded-2xl border p-5 ${ENTER}`} style={{ ...tintBg('var(--chart-3)', 7), ...stagger(1) }}>
        <div className="flex items-center gap-2 font-semibold">
          <CheckCheck className="size-4" style={softText('var(--chart-3)')} /> {t('ma.nba_journeys_heading')}
        </div>
        <StateView q={journeysQ}>
          {journeysQ.data && (journeys.length === 0 ? (
            <EmptyCard hue="var(--chart-3)" icon={CheckCheck} title={t('ma.nba_no_journeys')} />
          ) : (
            <div className="space-y-2">
              {journeys.map((j, i) => (
                <div key={String(j.journey_no)} className={`flex flex-wrap items-center gap-3 rounded-xl border bg-background/60 p-3 ${ENTER}`} style={stagger(i)}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-semibold">{String(j.journey_no)}</span>
                      {j.segment && <span className="text-muted-foreground">· {String(j.segment)}</span>}
                      <Chip hue={j.status === 'Active' ? 'var(--chart-3)' : 'var(--chart-4)'}>{String(j.status)}</Chip>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {t('ma.arm_treatment')} {num(j.target_count)} · {t('ma.arm_control')} {num(j.control_count)} · {t('ma.suppressed')} {num(j.suppressed_count)}
                    </div>
                  </div>
                  {j.status === 'Pending' && (
                    <Button size="sm" variant="secondary" disabled={activate.isPending} onClick={() => activate.mutate(String(j.journey_no))}>
                      {t('ma.nba_activate')}
                    </Button>
                  )}
                  {/* Realized measurement (MKT-19 discipline): measure once the window elapses; show the proven lift. */}
                  {j.status === 'Active' && j.measured_at == null && (
                    <Button size="sm" variant="outline" className="bg-background/60" disabled={measure.isPending} onClick={() => measure.mutate(String(j.journey_no))}>
                      <Ruler className="mr-1 size-3.5" /> {t('ma.measure')}
                    </Button>
                  )}
                  {j.measured_at != null && (
                    <span className={`inline-flex items-center gap-1 rounded-full bg-background/70 px-2.5 py-1 text-xs font-semibold shadow-sm ${Number(j.realized_lift_pct ?? 0) >= 0 ? 'text-success' : 'text-destructive'}`}>
                      <TrendingUp className="size-3.5" />
                      {j.realized_lift_pct == null ? t('ma.measured_no_baseline') : `${t('ma.measured_lift')} ${Number(j.realized_lift_pct) >= 0 ? '+' : ''}${num(j.realized_lift_pct, 1)}%`}
                      {j.incremental_revenue != null && <span className="text-muted-foreground">· {thb(j.incremental_revenue)}</span>}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </StateView>
        <SoftNote hue="var(--chart-3)">{t('ma.nba_journeys_note')}</SoftNote>
      </section>
    </div>
  );
}
