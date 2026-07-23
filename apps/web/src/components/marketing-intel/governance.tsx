// Model Governance (docs/60 Phase 4, MKT-20) — the ITGC tab of /marketing-intel. NO 'use client': imported
// only by the already-client page (ratchet stays flat). Toggle maker-checker on spend/contact-driving
// analytics, review each pushed run's model card + drift, approve pending runs (a different person than the
// pusher; a drifted run needs a reason), and read the recommendation → action → outcome audit chain.
import { useMemo, useState, type CSSProperties } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, AlertTriangle, Check, FileText, GitBranch, ToggleLeft, ToggleRight } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thb } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { StateView } from '@/components/state-view';
import { Button } from '@/components/ui/button';

const tintBg = (h: string, pct = 9): CSSProperties => ({ background: `color-mix(in oklch, ${h} ${pct}%, var(--card))`, borderColor: `color-mix(in oklch, ${h} 16%, var(--border))` });
const softText = (h: string): CSSProperties => ({ color: `color-mix(in oklch, ${h} 66%, var(--foreground))` });

interface Run {
  id: number; kind: string; status: string; model_run_ref: string | null;
  model_card: any | null; quality: any | null; pushed_by: string | null; pushed_at: string | null;
  approved_by: string | null; approved_at: string | null;
}
interface Audit {
  runs: { id: number; kind: string; status: string; model_run_ref: string | null; pushed_by: string | null; approved_by: string | null }[];
  plans: { plan_no: string; status: string; basis: string | null; requested_by: string | null; approved_by: string | null }[];
  experiments: { experiment_no: string; segment: string; status: string; lift_pct: number | null; incremental_revenue: number | null }[];
}

export function Governance() {
  const { t } = useLang();
  const qc = useQueryClient();
  const setQ = useQuery<{ require_approval: boolean; drift_r2_drop: number }>({ queryKey: ['marketing-intel', 'gov-settings'], queryFn: () => api('/api/marketing-intel/governance/settings') });
  const runsQ = useQuery<{ runs: Run[] }>({ queryKey: ['marketing-intel', 'gov-runs'], queryFn: () => api('/api/marketing-intel/governance/runs') });
  const auditQ = useQuery<Audit>({ queryKey: ['marketing-intel', 'gov-audit'], queryFn: () => api('/api/marketing-intel/governance/audit-trail') });

  const [reason, setReason] = useState<Record<number, string>>({});
  const runs = useMemo(() => (Array.isArray(runsQ.data?.runs) ? runsQ.data!.runs : []), [runsQ.data]);
  const governed = !!setQ.data?.require_approval;

  const toggle = useMutation({
    mutationFn: (v: boolean) => api('/api/marketing-intel/governance/settings', { method: 'PUT', body: JSON.stringify({ require_approval: v }) }),
    onSuccess: () => { notifySuccess(t('mi.gv_saved')); qc.invalidateQueries({ queryKey: ['marketing-intel', 'gov-settings'] }); },
    onError: (e: any) => notifyError(e?.message ?? 'error'),
  });
  const approve = useMutation({
    mutationFn: (v: { id: number; reason?: string }) => api('/api/marketing-intel/governance/runs/approve', { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: () => { notifySuccess(t('mi.gv_approved')); qc.invalidateQueries({ queryKey: ['marketing-intel', 'gov-runs'] }); qc.invalidateQueries({ queryKey: ['marketing-intel', 'gov-audit'] }); },
    onError: (e: any) => {
      const code = e?.body?.error?.code;
      notifyError(code === 'DRIFT_REASON_REQUIRED' ? t('mi.gv_reason_req') : code === 'SOD_SELF_APPROVAL' ? t('mi.gv_self') : (e?.message ?? 'error'));
    },
  });

  return (
    <StateView q={setQ}>
      {setQ.data && (
        <div className="space-y-5">
          <div>
            <h2 className="text-lg font-semibold">{t('mi.gv_title')}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{t('mi.gv_subtitle')}</p>
          </div>

          {/* Governance toggle */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4" style={tintBg(governed ? 'var(--chart-3)' : 'var(--chart-4)')}>
            <div className="flex items-center gap-2.5">
              <ShieldCheck className="size-5" style={softText(governed ? 'var(--chart-3)' : 'var(--chart-4)')} />
              <div>
                <div className="font-medium">{t('mi.gv_require')}</div>
                <div className="text-xs text-muted-foreground">{t('mi.gv_require_note')}</div>
              </div>
            </div>
            <Button size="sm" variant="outline" className="bg-background/60" disabled={toggle.isPending} onClick={() => toggle.mutate(!governed)}>
              {governed ? <ToggleRight className="size-4" style={softText('var(--chart-3)')} /> : <ToggleLeft className="size-4" />}
              {governed ? t('mi.gv_on') : t('mi.gv_off')}
            </Button>
          </div>

          {/* Runs + model cards + approve */}
          <StateView q={runsQ}>
            {runsQ.data && (runs.length === 0 ? (
              <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{t('mi.gv_no_runs')}</p>
            ) : (
              <div className="grid gap-2">
                <h3 className="text-sm font-medium text-muted-foreground">{t('mi.gv_runs')}</h3>
                {runs.map((r) => {
                  const drift = r.quality?.drift === true;
                  const pending = r.status === 'Pending';
                  const hue = pending ? (drift ? 'var(--chart-1)' : 'var(--chart-4)') : 'var(--chart-3)';
                  return (
                    <div key={r.id} className="rounded-xl border p-3" style={tintBg(hue, 8)}>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 font-medium">
                            <FileText className="size-4" style={softText(hue)} /> {r.kind.toUpperCase()} {r.model_run_ref ?? `#${r.id}`}
                            <span className="rounded-full bg-background/70 px-2 py-0.5 text-xs font-medium" style={softText(hue)}>{r.status}</span>
                            {drift && <span className="inline-flex items-center gap-1 rounded-full bg-background/70 px-2 py-0.5 text-xs font-semibold" style={softText('var(--chart-1)')}><AlertTriangle className="size-3" /> {t('mi.gv_drift')}</span>}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {r.model_card?.model_version && <span>v{r.model_card.model_version} · </span>}
                            {r.model_card?.training_window && <span>{r.model_card.training_window} · </span>}
                            {r.quality?.r2 != null && <span>R² {num(r.quality.r2, 2)}{r.quality?.r2_drop != null ? ` (↓${num(r.quality.r2_drop, 2)})` : ''} · </span>}
                            {t('mi.gv_pushed_by')} {r.pushed_by ?? '—'}{r.approved_by ? ` · ✓ ${r.approved_by}` : ''}
                          </div>
                        </div>
                        {pending && (
                          <div className="flex items-center gap-2">
                            {drift && <input value={reason[r.id] ?? ''} onChange={(e) => setReason((s) => ({ ...s, [r.id]: e.target.value }))} placeholder={t('mi.gv_reason_ph')} className="w-40 rounded-lg border bg-background/70 px-2.5 py-1 text-xs outline-none focus:ring-2 focus:ring-ring" />}
                            <Button size="sm" variant="outline" className="bg-background/60" disabled={approve.isPending} onClick={() => approve.mutate({ id: r.id, reason: reason[r.id] || undefined })}>
                              <Check className="size-4" /> {t('mi.gv_approve')}
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </StateView>

          {/* Audit trail: recommendation → action → outcome */}
          <StateView q={auditQ}>
            {auditQ.data && (
              <div className="rounded-2xl border p-4" style={tintBg('var(--chart-2)', 7)}>
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-muted-foreground"><GitBranch className="size-4" /> {t('mi.gv_audit')}</h3>
                <div className="grid gap-3 sm:grid-cols-3 text-xs">
                  <div>
                    <div className="mb-1 font-semibold" style={softText('var(--chart-2)')}>{t('mi.gv_recommend')} ({auditQ.data.runs.length})</div>
                    {auditQ.data.runs.slice(0, 6).map((r) => <div key={r.id} className="truncate text-muted-foreground">{r.kind.toUpperCase()} {r.model_run_ref ?? `#${r.id}`} · {r.status}</div>)}
                  </div>
                  <div>
                    <div className="mb-1 font-semibold" style={softText('var(--chart-4)')}>{t('mi.gv_action')} ({auditQ.data.plans.length})</div>
                    {auditQ.data.plans.slice(0, 6).map((p) => <div key={p.plan_no} className="truncate text-muted-foreground">{p.plan_no} · {p.status}</div>)}
                  </div>
                  <div>
                    <div className="mb-1 font-semibold" style={softText('var(--chart-3)')}>{t('mi.gv_outcome')} ({auditQ.data.experiments.length})</div>
                    {auditQ.data.experiments.slice(0, 6).map((e) => <div key={e.experiment_no} className="truncate text-muted-foreground">{e.experiment_no} · {e.lift_pct == null ? e.status : `+${num(e.lift_pct, 0)}% (${thb(e.incremental_revenue ?? 0)})`}</div>)}
                  </div>
                </div>
              </div>
            )}
          </StateView>
        </div>
      )}
    </StateView>
  );
}
