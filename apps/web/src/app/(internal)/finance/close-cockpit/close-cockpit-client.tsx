'use client';

// Controller Close Cockpit client island (docs/35 Phase 3, GL-22). Renders the close-status aggregate:
// an overall RAG banner + days-to-close, then three pillar cards — sub-ledger↔GL tie-out (REC-04), pre-lock
// readiness (GL-19/GL-20), and the pending maker-checker queue (GOV-01) — plus the close checklist when a
// close run is under way. Read-only; each pillar carries its own RAG (icon+label, never colour-alone).
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, AlertCircle, CircleDashed, Scale, ClipboardList, Clock } from 'lucide-react';
import { useLang } from '@/lib/i18n';
import { baht } from '@/lib/format';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { Card } from '@/components/ui/card';

type Rag = 'green' | 'amber' | 'red' | null;
interface CloseStatus {
  period: string; as_of: string; period_end: string; days_to_close: number;
  close_run: { status: string; locked_at: string | null; locked_by: string | null; checklist: { done: number; required: number; steps: any[] } } | null;
  tie_out: { all_reconciled: boolean; exceptions: number; lines: any[] } | null;
  readiness: { ready: boolean; blockers: string[]; warnings: string[]; checks: any[] } | null;
  approvals: { count: number; overdue: number; oldest_age_days: number; by_type: Record<string, number>; total_amount: number; items: any[] } | null;
  rag: { tie_out: Rag; readiness: Rag; approvals: Rag; overall: 'green' | 'amber' | 'red' };
}

const TONE: Record<'green' | 'amber' | 'red', { text: string; bg: string; ring: string; Icon: typeof CheckCircle2 }> = {
  green: { text: 'text-success', bg: 'bg-success/15', ring: 'border-l-success', Icon: CheckCircle2 },
  amber: { text: 'text-warning-foreground dark:text-warning', bg: 'bg-warning/20', ring: 'border-l-warning', Icon: AlertTriangle },
  red: { text: 'text-destructive', bg: 'bg-destructive/10', ring: 'border-l-destructive', Icon: AlertCircle },
};

export function CloseCockpitClient({ initialData }: { initialData: CloseStatus | null }) {
  const { t } = useLang();
  const [data, setData] = useState<CloseStatus | null>(initialData);

  const refetch = useCallback(async () => {
    try { setData(await api<CloseStatus>('/api/finance/metrics/close/status')); } catch { /* keep last good */ }
  }, []);
  useEffect(() => { void refetch(); }, [refetch]);

  if (!data) {
    return (
      <div>
        <PageHeader title={t('fnx.cockpit.title')} description={t('fnx.cockpit.subtitle')} />
        <Card className="p-8 text-center text-sm text-muted-foreground">{t('fnx.cockpit.load_error')}</Card>
      </div>
    );
  }

  const overallTone = TONE[data.rag.overall];

  return (
    <div>
      <PageHeader title={t('fnx.cockpit.title')} description={t('fnx.cockpit.subtitle')} />

      {/* Overall banner */}
      <Card className={`mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 border-l-4 p-4 ${overallTone.ring}`}>
        <span className={`inline-flex items-center gap-2 text-base font-semibold ${overallTone.text}`}>
          <overallTone.Icon className="size-5" />{t(`fnx.cockpit.overall_${data.rag.overall}`)}
        </span>
        <span className="text-sm text-muted-foreground">{t('fnx.cockpit.period')}: <strong className="text-foreground">{data.period}</strong></span>
        <span className="inline-flex items-center gap-1 text-sm text-muted-foreground"><Clock className="size-4" />{t('fnx.cockpit.days_to_close')}: <strong className="text-foreground">{data.days_to_close}</strong></span>
        <span className="text-sm text-muted-foreground">
          {data.close_run ? t('fnx.cockpit.run_status', { status: data.close_run.status }) : t('fnx.cockpit.run_not_started')}
        </span>
      </Card>

      <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(340px,1fr))]">
        {/* Tie-out */}
        <PillarCard title={t('fnx.cockpit.tie_out')} icon={Scale} rag={data.rag.tie_out}>
          {!data.tie_out ? <Empty t={t} /> : (
            <>
              <div className="mb-2 text-xs text-muted-foreground">
                {data.tie_out.all_reconciled ? t('fnx.cockpit.all_reconciled') : t('fnx.cockpit.exceptions_n', { n: data.tie_out.exceptions })}
              </div>
              <table className="w-full text-xs">
                <thead><tr className="text-muted-foreground [&>th]:pb-1 [&>th]:text-right [&>th:first-child]:text-left">
                  <th /><th>{t('fnx.cockpit.col_sub')}</th><th>{t('fnx.cockpit.col_gl')}</th><th>{t('fnx.cockpit.col_var')}</th>
                </tr></thead>
                <tbody>
                  {data.tie_out.lines.map((l: any) => (
                    <tr key={l.account} className="border-t border-border/50 [&>td]:py-1 [&>td]:text-right [&>td:first-child]:text-left">
                      <td className="pr-2">{l.label}</td>
                      <td className="tabular-nums">{baht(l.sub_ledger)}</td>
                      <td className="tabular-nums">{baht(l.gl_control)}</td>
                      <td className={l.reconciled ? 'text-success' : 'text-destructive'}>
                        {l.reconciled ? <CheckCircle2 className="ml-auto size-3.5" /> : <span className="tabular-nums">{baht(l.variance)}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </PillarCard>

        {/* Readiness */}
        <PillarCard title={t('fnx.cockpit.readiness')} icon={ClipboardList} rag={data.rag.readiness}>
          {!data.readiness ? <Empty t={t} /> : (
            <>
              <div className={`mb-2 text-xs ${data.readiness.ready ? 'text-success' : 'text-destructive'}`}>
                {data.readiness.ready ? t('fnx.cockpit.ready') : t('fnx.cockpit.not_ready', { n: data.readiness.blockers.length })}
              </div>
              <ul className="space-y-1 text-xs">
                {data.readiness.checks.map((c: any) => (
                  <li key={c.key} className="flex items-start gap-1.5">
                    {c.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
                      : c.advisory ? <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning-foreground dark:text-warning" />
                      : <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />}
                    <span className={c.ok ? 'text-muted-foreground' : ''}>{c.title}{typeof c.count === 'number' && c.count > 0 ? ` (${c.count})` : ''}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </PillarCard>

        {/* Approvals */}
        <PillarCard title={t('fnx.cockpit.approvals')} icon={Clock} rag={data.rag.approvals}>
          {!data.approvals ? <Empty t={t} /> : data.approvals.count === 0 ? (
            <p className="text-xs text-muted-foreground">{t('fnx.cockpit.no_pending')}</p>
          ) : (
            <>
              <div className="mb-2 text-xs text-muted-foreground">
                {t('fnx.cockpit.approvals_summary', { count: data.approvals.count, overdue: data.approvals.overdue })} · {t('fnx.cockpit.oldest', { days: data.approvals.oldest_age_days })}
              </div>
              <ul className="space-y-1 text-xs">
                {data.approvals.items.slice(0, 8).map((it: any, i: number) => (
                  <li key={i} className="flex items-center justify-between gap-2 border-t border-border/50 py-1">
                    <span className="truncate">{it.label ?? it.ref}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      {it.amount != null && <span className="tabular-nums text-muted-foreground">{baht(it.amount)}</span>}
                      <span className={`rounded px-1 tabular-nums ${(it.age_days ?? 0) >= 3 ? 'bg-destructive/10 text-destructive' : 'text-muted-foreground'}`}>{t('fnx.cockpit.age_days', { days: it.age_days ?? 0 })}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </PillarCard>

        {/* Checklist (only when a close run is under way) */}
        {data.close_run && (
          <PillarCard title={t('fnx.cockpit.checklist')} icon={CheckCircle2} rag={null}>
            <div className="mb-2 text-xs text-muted-foreground">{t('fnx.cockpit.checklist_done', { done: data.close_run.checklist.done, total: data.close_run.checklist.required })}</div>
            <ul className="space-y-1 text-xs">
              {data.close_run.checklist.steps.map((s: any) => {
                const done = s.status === 'done' || s.status === 'completed';
                return (
                  <li key={s.step_key} className="flex items-center gap-1.5">
                    {done ? <CheckCircle2 className="size-3.5 text-success" /> : <CircleDashed className="size-3.5 text-muted-foreground" />}
                    <span className={done ? 'text-muted-foreground' : ''}>{s.title}</span>
                    {!s.required && <span className="text-[10px] text-muted-foreground">(optional)</span>}
                  </li>
                );
              })}
            </ul>
          </PillarCard>
        )}
      </div>
    </div>
  );
}

function PillarCard({ title, icon: Icon, rag, children }: { title: string; icon: typeof Scale; rag: Rag; children: React.ReactNode }) {
  const { t } = useLang();
  const tone = rag ? TONE[rag] : null;
  return (
    <Card className={`gap-2 border-l-4 p-4 ${tone ? tone.ring : 'border-l-transparent'}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold"><Icon className="size-4 text-muted-foreground" />{title}</span>
        {tone && (
          <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${tone.bg} ${tone.text}`}>
            <tone.Icon className="size-3" />{t(`fnx.cfo.rag_${rag}`)}
          </span>
        )}
      </div>
      {children}
    </Card>
  );
}

function Empty({ t }: { t: (k: string) => string }) {
  return <p className="text-xs text-muted-foreground">{t('fnx.cockpit.leg_unavailable')}</p>;
}
