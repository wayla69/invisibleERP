// ④ Churn-Save Autopilot tab (MKT-24) — protect the base + prove the saved revenue. A maker-checker
// save-offer policy (hard offer cap), a sweep preview (funnel → capped offers → retention P&L), a staged
// run (consent-gated draft for the treatment arm only), and the run history. The offer cap is the control —
// enforced server-side in the pure core; this screen only surfaces it, softly.
// NO 'use client' (inherits the /marketing-activation page boundary — see viz.tsx).
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { HeartHandshake, SlidersHorizontal, Sparkles, Play, Lock, CheckCheck, Ruler, TrendingUp } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thb, compactThb } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { notifySuccess, notifyError } from '@/lib/notify';
import { StateView } from '@/components/state-view';
import { KpiCard, tintBg, softText, Chip, SoftNote, EmptyCard, ENTER, stagger } from './viz';

export function ChurnSave() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [form, setForm] = useState({ churn: '0.5', minClv: '100', rate: '0.1', cap: '500' });

  const policiesQ = useQuery<{ policies: any[] }>({ queryKey: ['ma', 'save-policies'], queryFn: () => api('/api/marketing-activation/save/policies') });
  const previewQ = useQuery<any>({
    queryKey: ['ma', 'save-preview'],
    queryFn: () => api('/api/marketing-activation/save/preview'),
    retry: false,
  });
  const runsQ = useQuery<{ runs: any[] }>({ queryKey: ['ma', 'save-runs'], queryFn: () => api('/api/marketing-activation/save/runs') });

  const stagePolicy = useMutation({
    mutationFn: () => api('/api/marketing-activation/save/policy', {
      method: 'POST',
      body: JSON.stringify({ churn_threshold: Number(form.churn), min_clv: Number(form.minClv), offer_rate: Number(form.rate), offer_cap: Number(form.cap) }),
    }),
    onSuccess: (r: any) => { notifySuccess(t('ma.save_pol_staged', { p: String(r?.policy_no ?? '') })); qc.invalidateQueries({ queryKey: ['ma', 'save-policies'] }); },
    onError: (e: any) => notifyError(e?.body?.error?.code === 'INVALID_OFFER_CAP' ? t('ma.save_bad_cap') : (e?.message ?? 'error')),
  });
  const approvePolicy = useMutation({
    mutationFn: (policyNo: string) => api('/api/marketing-activation/save/policy/approve', { method: 'POST', body: JSON.stringify({ policy_no: policyNo }) }),
    onSuccess: () => {
      notifySuccess(t('ma.save_pol_approved'));
      qc.invalidateQueries({ queryKey: ['ma', 'save-policies'] });
      qc.invalidateQueries({ queryKey: ['ma', 'save-preview'] });
    },
    onError: (e: any) => notifyError(e?.body?.error?.code === 'SOD_SELF_APPROVAL' ? t('ma.self_approve') : (e?.message ?? 'error')),
  });
  const run = useMutation({
    mutationFn: () => api('/api/marketing-activation/save/run', { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (r: any) => { notifySuccess(t('ma.save_run_done', { r: String(r?.run_no ?? '') })); qc.invalidateQueries({ queryKey: ['ma', 'save-runs'] }); },
    onError: (e: any) => notifyError(e?.body?.error?.code === 'NO_ACTIVE_POLICY' ? t('ma.save_no_policy') : (e?.message ?? 'error')),
  });
  const measure = useMutation({
    mutationFn: (runNo: string) => api('/api/marketing-activation/save/measure', { method: 'POST', body: JSON.stringify({ run_no: runNo }) }),
    onSuccess: () => { notifySuccess(t('ma.measured_done')); qc.invalidateQueries({ queryKey: ['ma', 'save-runs'] }); },
    onError: (e: any) => {
      const code = e?.body?.error?.code;
      notifyError(code === 'WINDOW_NOT_ELAPSED' ? t('ma.measure_window') : code === 'NO_CONTROL' ? t('ma.measure_no_control') : (e?.message ?? 'error'));
    },
  });

  const policies: any[] = Array.isArray(policiesQ.data?.policies) ? policiesQ.data.policies : [];
  const runs: any[] = Array.isArray(runsQ.data?.runs) ? runsQ.data.runs : [];
  const pv = previewQ.data ?? null;
  const noPolicy = (previewQ.error as any)?.body?.error?.code === 'NO_ACTIVE_POLICY';
  const targets: any[] = Array.isArray(pv?.targets) ? pv.targets : [];
  const capValue = pv?.policy?.offer_cap != null ? Number(pv.policy.offer_cap) : null;

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,340px)_1fr]">
        {/* ── Policy: maker-checker rules with the hard offer cap ── */}
        <section className={`space-y-4 self-start rounded-2xl border p-5 ${ENTER}`} style={{ ...tintBg('var(--chart-1)', 7), ...stagger(0) }}>
          <div className="flex items-center gap-2 font-semibold">
            <SlidersHorizontal className="size-4" style={softText('var(--chart-1)')} /> {t('ma.save_policy_heading')}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              {t('ma.save_churn')}
              <Input value={form.churn} onChange={set('churn')} inputMode="decimal" className="bg-background/70 tabular-nums" />
            </label>
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              {t('ma.save_min_clv')}
              <Input value={form.minClv} onChange={set('minClv')} inputMode="numeric" className="bg-background/70 tabular-nums" />
            </label>
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              {t('ma.save_rate')}
              <Input value={form.rate} onChange={set('rate')} inputMode="decimal" className="bg-background/70 tabular-nums" />
            </label>
            <label className="space-y-1 text-xs font-medium" style={softText('var(--chart-1)')}>
              <span className="flex items-center gap-1"><Lock className="size-3" /> {t('ma.save_cap')}</span>
              <Input value={form.cap} onChange={set('cap')} inputMode="numeric" className="border-dashed bg-background/70 tabular-nums" style={{ borderColor: 'color-mix(in oklch, var(--chart-1) 40%, var(--border))' }} />
            </label>
          </div>
          <Button className="w-full" variant="secondary" disabled={stagePolicy.isPending} onClick={() => stagePolicy.mutate()}>
            {t('ma.save_stage_policy')}
          </Button>

          {/* Existing policies + maker-checker approval */}
          <div className="space-y-2 border-t pt-3">
            {policies.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('ma.save_no_policies')}</p>
            ) : policies.map((p) => (
              <div key={String(p.policy_no)} className="flex flex-wrap items-center gap-2 rounded-xl border bg-background/60 p-3 text-xs">
                <span className="font-semibold">{String(p.policy_no)}</span>
                <Chip hue={p.status === 'Active' ? 'var(--chart-3)' : p.status === 'Pending' ? 'var(--chart-4)' : 'var(--chart-5)'}>{String(p.status)}</Chip>
                <span className="text-muted-foreground">cap {thb(p.offer_cap)}</span>
                {p.status === 'Pending' && (
                  <Button size="sm" variant="secondary" className="ml-auto h-7 text-xs" disabled={approvePolicy.isPending} onClick={() => approvePolicy.mutate(String(p.policy_no))}>
                    {t('ma.save_approve')}
                  </Button>
                )}
              </div>
            ))}
          </div>
          <SoftNote hue="var(--chart-1)">{t('ma.save_policy_note')}</SoftNote>
        </section>

        {/* ── Preview: sweep funnel + capped offers + P&L ── */}
        <section className={`space-y-4 rounded-2xl border p-5 ${ENTER}`} style={{ ...tintBg('var(--chart-3)', 7), ...stagger(1) }}>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 font-semibold">
              <HeartHandshake className="size-4" style={softText('var(--chart-3)')} /> {t('ma.save_preview_heading')}
            </div>
            <Button className="ml-auto" disabled={!pv || run.isPending} onClick={() => run.mutate()}>
              <Play className="mr-1.5 size-4" /> {t('ma.save_run')}
            </Button>
          </div>

          {noPolicy ? (
            <EmptyCard hue="var(--chart-3)" icon={HeartHandshake} title={t('ma.save_no_policy')} desc={t('ma.save_no_policy_desc')} />
          ) : (
            <StateView q={previewQ}>
              {pv && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <KpiCard hue="var(--chart-2)" icon={Sparkles} label={t('ma.save_eligible')} value={num(pv.eligible)}
                      sub={t('ma.save_swept', { n: num(pv.swept) })} />
                    <KpiCard hue="var(--chart-4)" icon={Lock} label={t('ma.save_cost')} value={compactThb(pv.offer_cost)}
                      sub={t('ma.save_capped_at', { cap: capValue != null ? thb(capValue) : '—' })} />
                    <KpiCard hue="var(--chart-3)" icon={HeartHandshake} label={t('ma.save_saved')} value={compactThb(pv.expected_saved_revenue)}
                      sub={`${t('ma.arm_treatment')} ${num(pv.treatment_count)} · ${t('ma.arm_control')} ${num(pv.control_count)}`} />
                    <KpiCard hue="var(--chart-5)" icon={Play} label={t('ma.save_net')} value={compactThb(pv.net_benefit)}
                      sub={pv.roi != null ? `ROI ${num(pv.roi, 1)}×` : undefined} />
                  </div>

                  {targets.length > 0 && (
                    <div className="space-y-2">
                      {targets.slice(0, 6).map((tg, i) => (
                        <div key={String(tg.member_id)} className={`flex items-center gap-3 rounded-xl border bg-background/60 p-3 text-sm ${ENTER}`} style={stagger(i)}>
                          <span className="font-semibold">#{String(tg.member_id)}</span>
                          <Chip hue="var(--chart-1)">churn {num((Number(tg.churn_risk) || 0) * 100)}%</Chip>
                          <span className="text-xs text-muted-foreground">CLV {thb(tg.clv)}</span>
                          <span className="ml-auto flex items-center gap-2">
                            {tg.arm === 'control' ? (
                              <Chip hue="var(--chart-5)">{t('ma.arm_control')}</Chip>
                            ) : (
                              <>
                                <span className="text-sm font-semibold tabular-nums">{thb(tg.offer)}</span>
                                {capValue != null && Number(tg.offer) >= capValue && (
                                  <Chip hue="var(--chart-1)"><Lock className="size-3" /> {t('ma.save_capped')}</Chip>
                                )}
                              </>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </StateView>
          )}
          <SoftNote hue="var(--chart-3)">{t('ma.save_preview_note')}</SoftNote>
        </section>
      </div>

      {/* ── Run history: the retention P&L record ── */}
      <section className={`space-y-3 rounded-2xl border p-5 ${ENTER}`} style={{ ...tintBg('var(--chart-5)', 7), ...stagger(2) }}>
        <div className="flex items-center gap-2 font-semibold">
          <CheckCheck className="size-4" style={softText('var(--chart-5)')} /> {t('ma.save_runs_heading')}
        </div>
        <StateView q={runsQ}>
          {runsQ.data && (runs.length === 0 ? (
            <EmptyCard hue="var(--chart-5)" icon={CheckCheck} title={t('ma.save_no_runs')} />
          ) : (
            <div className="space-y-2">
              {runs.map((r, i) => (
                <div key={String(r.run_no)} className={`flex flex-wrap items-center gap-2 rounded-xl border bg-background/60 p-3 text-sm ${ENTER}`} style={stagger(i)}>
                  <span className="font-semibold">{String(r.run_no)}</span>
                  <span className="text-xs text-muted-foreground">{String(r.policy_no ?? '')}</span>
                  <span className="text-xs text-muted-foreground">
                    {t('ma.arm_treatment')} {num(r.treatment_count)} · {t('ma.arm_control')} {num(r.control_count)}
                  </span>
                  <span className="ml-auto flex items-center gap-3 text-xs tabular-nums">
                    <span className="text-muted-foreground">{t('ma.save_cost')} {compactThb(r.offer_cost)}</span>
                    <span className="font-semibold" style={softText('var(--chart-3)')}>{t('ma.save_net')} {compactThb(r.net_benefit)}</span>
                  </span>
                  {/* Realized measurement (MKT-19 discipline): expected becomes PROVEN once measured. */}
                  {r.measured_at == null ? (
                    <Button size="sm" variant="outline" className="bg-background/60" disabled={measure.isPending} onClick={() => measure.mutate(String(r.run_no))}>
                      <Ruler className="mr-1 size-3.5" /> {t('ma.measure')}
                    </Button>
                  ) : (
                    <span className={`inline-flex items-center gap-1 rounded-full bg-background/70 px-2.5 py-1 text-xs font-semibold shadow-sm ${Number(r.realized_net_benefit ?? 0) >= 0 ? 'text-success' : 'text-destructive'}`}>
                      <TrendingUp className="size-3.5" /> {t('ma.measured_proven')} {compactThb(r.realized_net_benefit)}
                      {r.realized_lift_pct != null && <span className="text-muted-foreground">· lift {Number(r.realized_lift_pct) >= 0 ? '+' : ''}{num(r.realized_lift_pct, 1)}%</span>}
                      {r.lift_ci_low_pct != null && r.lift_ci_high_pct != null && (
                        <span className="font-normal text-muted-foreground">[{num(r.lift_ci_low_pct, 0)}, {num(r.lift_ci_high_pct, 0)}]</span>
                      )}
                      {/* Statistical honesty (docs/62 Phase 3): small/inconclusive samples are flagged, never hidden. */}
                      {r.weak_evidence === true && <span title={t('ma.weak_evidence')}>⚠</span>}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </StateView>
        <SoftNote hue="var(--chart-5)">{t('ma.save_runs_note')}</SoftNote>
      </section>
    </div>
  );
}
