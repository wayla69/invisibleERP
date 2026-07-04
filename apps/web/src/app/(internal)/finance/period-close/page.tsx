'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock, LockOpen, CheckCircle2, Circle, AlertTriangle, CalendarClock } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StateView } from '@/components/state-view';
import { notifySuccess, notifyError } from '@/lib/notify';

interface CloseStep {
  id: number; step_key: string; title: string; seq: number;
  required: boolean; status: 'Pending' | 'Done';
  completed_by: string | null; completed_at: string | null;
}
interface CloseRun {
  id: number; period: string; status: 'InProgress' | 'ReadyToLock' | 'Locked';
  started_by: string; locked_by: string | null; locked_at: string | null;
  note: string | null; created_at: string | null; steps: CloseStep[];
}

const STATUS_LABEL_KEY: Record<string, string> = {
  InProgress: 'fnx.close.status_inprogress',
  ReadyToLock: 'fnx.close.status_readytolock',
  Locked: 'fnx.close.status_locked',
};
const STATUS_VARIANT: Record<string, 'default' | 'warning' | 'success' | 'destructive'> = {
  InProgress: 'warning',
  ReadyToLock: 'default',
  Locked: 'success',
};

function todayPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function PeriodClosePage() {
  const { t } = useLang();
  const closeStatusLabel = (s: string) => (STATUS_LABEL_KEY[s] ? t(STATUS_LABEL_KEY[s]) : s);
  const qc = useQueryClient();
  const [period, setPeriod] = useState(todayPeriod);
  const [selectedRun, setSelectedRun] = useState<CloseRun | null>(null);
  const [reopenReason, setReopenReason] = useState('');

  const runs = useQuery<{ runs: CloseRun[]; count: number }>({
    queryKey: ['close-runs'],
    queryFn: () => api('/api/ledger/close'),
  });

  const runStatus = useQuery<CloseRun>({
    queryKey: ['close-status', selectedRun?.id],
    queryFn: () => api(`/api/ledger/close/status?period=${selectedRun!.period}`),
    enabled: !!selectedRun,
    refetchInterval: selectedRun?.status === 'Locked' ? false : 10000,
  });

  const run = runStatus.data ?? selectedRun;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['close-runs'] });
    qc.invalidateQueries({ queryKey: ['close-status'] });
  };

  const startClose = useMutation<CloseRun, Error, void>({
    mutationFn: () => api('/api/ledger/close/start', { method: 'POST', body: JSON.stringify({ period }) }) as Promise<CloseRun>,
    onSuccess: (r) => {
      notifySuccess(t('fnx.close.toast_started', { period: r.period }));
      setSelectedRun(r);
      refresh();
    },
    onError: (e: any) => notifyError(e?.message ?? t('fnx.close.err_start')),
  });

  const completeStep = useMutation<CloseRun, Error, string>({
    mutationFn: (stepKey) => api('/api/ledger/close/step', {
      method: 'POST',
      body: JSON.stringify({ close_run_id: run!.id, step_key: stepKey }),
    }) as Promise<CloseRun>,
    onSuccess: (r) => {
      notifySuccess(t('fnx.close.toast_step_done'));
      setSelectedRun(r);
      refresh();
    },
    onError: (e: any) => notifyError(e?.message ?? t('fnx.close.err_step')),
  });

  const lockPeriod = useMutation<CloseRun, Error, void>({
    mutationFn: () => api('/api/ledger/close/lock', {
      method: 'POST',
      body: JSON.stringify({ close_run_id: run!.id }),
    }) as Promise<CloseRun>,
    onSuccess: (r) => {
      notifySuccess(t('fnx.close.toast_locked', { period: r.period }));
      setSelectedRun(r);
      refresh();
    },
    onError: (e: any) => notifyError(e?.message ?? t('fnx.close.err_lock')),
  });

  const reopenPeriod = useMutation<CloseRun, Error, void>({
    mutationFn: () => api('/api/ledger/close/reopen', {
      method: 'POST',
      body: JSON.stringify({ close_run_id: run!.id, reason: reopenReason }),
    }) as Promise<CloseRun>,
    onSuccess: (r) => {
      notifySuccess(t('fnx.close.toast_reopened', { period: r.period }));
      setReopenReason('');
      setSelectedRun(r);
      refresh();
    },
    onError: (e: any) => notifyError(e?.message ?? t('fnx.close.err_reopen')),
  });

  // GL-19: programmatic pre-lock validation (read-only) — advisory readiness blockers before the lock.
  const [validation, setValidation] = useState<any>(null);
  const validate = useMutation<any, Error, void>({
    mutationFn: () => api(`/api/ledger/close/validate?period=${run!.period}`),
    onSuccess: (r) => { setValidation(r); r.ready ? notifySuccess(t('fnx.close.toast_validate_ready')) : notifyError(t('fnx.close.toast_validate_notready', { blockers: (r.blockers ?? []).join(', ') })); },
    onError: (e: any) => notifyError(e?.message ?? t('fnx.close.err_validate')),
  });

  const requiredDone = run?.steps?.filter((s) => s.required).every((s) => s.status === 'Done') ?? false;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('fnx.close.title')}
        description={t('fnx.close.subtitle')}
      />

      {/* Start a new close run */}
      <Card>
        <CardHeader><CardTitle className="text-sm">{t('fnx.close.start')}</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label>{t('fnx.close.period_label')}</Label>
              <Input
                className="w-36"
                placeholder="2025-12"
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                pattern="\d{4}-\d{2}"
              />
            </div>
            <Button
              disabled={startClose.isPending || !/^\d{4}-\d{2}$/.test(period)}
              onClick={() => startClose.mutate()}
            >
              <CalendarClock className="mr-2 h-4 w-4" />
              {t('fnx.close.start')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Run list */}
        <Card className="lg:col-span-1">
          <CardHeader><CardTitle className="text-sm">{t('fnx.close.runs_title')}</CardTitle></CardHeader>
          <CardContent className="p-0">
            <StateView q={runs}>
              <div className="divide-y">
                {(runs.data?.runs ?? []).map((r) => (
                  <button
                    key={r.id}
                    className={`w-full px-4 py-3 text-left text-sm hover:bg-muted/50 transition-colors ${selectedRun?.id === r.id ? 'bg-muted' : ''}`}
                    onClick={() => setSelectedRun(r)}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{r.period}</span>
                      <Badge variant={STATUS_VARIANT[r.status] ?? 'default'}>{closeStatusLabel(r.status)}</Badge>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{t('fnx.close.started_by_label')} {r.started_by}</div>
                  </button>
                ))}
                {(runs.data?.count ?? 0) === 0 && (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('fnx.close.runs_empty')}</p>
                )}
              </div>
            </StateView>
          </CardContent>
        </Card>

        {/* Checklist + actions */}
        <div className="lg:col-span-2 space-y-4">
          {!run ? (
            <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">{t('fnx.close.select_prompt')}</CardContent></Card>
          ) : (
            <>
              {/* Run header */}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm">{t('fnx.close.period_heading', { period: run.period })}</CardTitle>
                    <Badge variant={STATUS_VARIANT[run.status] ?? 'default'}>{closeStatusLabel(run.status)}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-1 text-sm">
                  <p className="text-muted-foreground">{t('fnx.close.started_by_label')} <span className="text-foreground font-medium">{run.started_by}</span></p>
                  {run.locked_by && (
                    <p className="text-muted-foreground">{t('fnx.close.locked_by_label')} <span className="text-foreground font-medium">{run.locked_by}</span>
                      {run.locked_at && <> · {thaiDate(run.locked_at)}</>}
                    </p>
                  )}
                  {run.note && <p className="text-xs text-orange-600 dark:text-orange-400 mt-1">{run.note}</p>}
                </CardContent>
              </Card>

              {/* Checklist */}
              <Card>
                <CardHeader><CardTitle className="text-sm">{t('fnx.close.checklist_title')}</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {(run.steps ?? []).map((step) => (
                    <div
                      key={step.step_key}
                      className="flex items-center justify-between rounded-lg border bg-background px-3 py-2"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {step.status === 'Done'
                          ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                          : <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />}
                        <div className="min-w-0">
                          <p className="text-sm truncate">{step.title}</p>
                          {step.status === 'Done' && step.completed_by && (
                            <p className="text-xs text-muted-foreground">{step.completed_by} · {step.completed_at ? thaiDate(step.completed_at) : ''}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 ml-2 shrink-0">
                        {!step.required && <Badge variant="muted" className="text-[10px]">{t('fnx.close.optional')}</Badge>}
                        {step.status === 'Pending' && run.status !== 'Locked' && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={completeStep.isPending}
                            onClick={() => completeStep.mutate(step.step_key)}
                          >
                            {t('fnx.close.mark_done')}
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>

              {/* Pre-lock validation (GL-19) — advisory readiness checks */}
              {run.status !== 'Locked' && (
                <Card>
                  <CardHeader><CardTitle className="text-sm">{t('fnx.close.prelock_title')}</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm text-muted-foreground">{t('fnx.close.prelock_desc')}</p>
                      <Button size="sm" variant="outline" disabled={validate.isPending} onClick={() => validate.mutate()}>{t('fnx.close.validate')}</Button>
                    </div>
                    {validation && validation.period === run.period && (
                      <div className="space-y-2 text-sm">
                        <div className="flex items-center gap-2">
                          {validation.ready
                            ? <Badge variant="success">{t('fnx.close.ready')}</Badge>
                            : <Badge variant="destructive">{t('fnx.close.notready_count', { count: (validation.blockers ?? []).length })}</Badge>}
                          {(validation.warnings ?? []).length > 0 && <Badge variant="muted">{t('fnx.close.warnings_count', { count: (validation.warnings).length })}</Badge>}
                        </div>
                        {(validation.checks ?? []).map((c: any) => (
                          <div key={c.key} className="flex items-center gap-2 text-xs">
                            {c.ok
                              ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
                              : <Circle className={`h-3.5 w-3.5 shrink-0 ${c.advisory ? 'text-orange-500' : 'text-destructive'}`} />}
                            <span className={c.ok ? 'text-muted-foreground' : ''}>{c.title}{!c.ok && c.count != null ? ` (${c.count})` : ''}{!c.ok && c.diff != null ? ` (Δ ${c.diff})` : ''}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* Lock / Reopen actions */}
              {run.status !== 'Locked' && (
                <Card>
                  <CardHeader><CardTitle className="text-sm">{t('fnx.close.lock_title')}</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    {!requiredDone && (
                      <div className="flex items-center gap-2 text-sm text-orange-600 dark:text-orange-400">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        <span>{t('fnx.close.required_incomplete')}</span>
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">{t('fnx.close.sod_lock', { by: run.started_by })}</p>
                    <Button
                      disabled={lockPeriod.isPending || !requiredDone}
                      onClick={() => lockPeriod.mutate()}
                    >
                      <Lock className="mr-2 h-4 w-4" />
                      {t('fnx.close.lock_period', { period: run.period })}
                    </Button>
                  </CardContent>
                </Card>
              )}

              {run.status === 'Locked' && (
                <Card className="border-orange-300 dark:border-orange-700">
                  <CardHeader><CardTitle className="text-sm text-orange-700 dark:text-orange-300">{t('fnx.close.reopen_title')}</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-xs text-muted-foreground">{t('fnx.close.sod_reopen', { by: run.locked_by ?? '' })}</p>
                    <div>
                      <Label>{t('fnx.close.reopen_reason_label')}</Label>
                      <Input
                        placeholder={t('fnx.close.reopen_reason_ph')}
                        value={reopenReason}
                        onChange={(e) => setReopenReason(e.target.value)}
                      />
                    </div>
                    <Button
                      variant="destructive"
                      disabled={reopenPeriod.isPending || !reopenReason.trim()}
                      onClick={() => reopenPeriod.mutate()}
                    >
                      <LockOpen className="mr-2 h-4 w-4" />
                      {t('fnx.close.reopen_btn')}
                    </Button>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
