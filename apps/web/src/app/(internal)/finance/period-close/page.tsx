'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock, LockOpen, CheckCircle2, Circle, AlertTriangle, CalendarClock } from 'lucide-react';
import { api } from '@/lib/api';
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

const STATUS_LABEL: Record<string, string> = {
  InProgress: 'กำลังดำเนินการ',
  ReadyToLock: 'พร้อมล็อก',
  Locked: 'ล็อกแล้ว',
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
      notifySuccess(`เริ่มปิดงวด ${r.period} แล้ว`);
      setSelectedRun(r);
      refresh();
    },
    onError: (e: any) => notifyError(e?.message ?? 'ไม่สามารถเริ่มปิดงวดได้'),
  });

  const completeStep = useMutation<CloseRun, Error, string>({
    mutationFn: (stepKey) => api('/api/ledger/close/step', {
      method: 'POST',
      body: JSON.stringify({ close_run_id: run!.id, step_key: stepKey }),
    }) as Promise<CloseRun>,
    onSuccess: (r) => {
      notifySuccess('บันทึกขั้นตอนแล้ว');
      setSelectedRun(r);
      refresh();
    },
    onError: (e: any) => notifyError(e?.message ?? 'บันทึกไม่สำเร็จ'),
  });

  const lockPeriod = useMutation<CloseRun, Error, void>({
    mutationFn: () => api('/api/ledger/close/lock', {
      method: 'POST',
      body: JSON.stringify({ close_run_id: run!.id }),
    }) as Promise<CloseRun>,
    onSuccess: (r) => {
      notifySuccess(`ล็อกงวด ${r.period} สำเร็จ`);
      setSelectedRun(r);
      refresh();
    },
    onError: (e: any) => notifyError(e?.message ?? 'ล็อกไม่สำเร็จ — ตรวจสอบ SoD (ผู้ล็อกต้องต่างจากผู้เริ่ม)'),
  });

  const reopenPeriod = useMutation<CloseRun, Error, void>({
    mutationFn: () => api('/api/ledger/close/reopen', {
      method: 'POST',
      body: JSON.stringify({ close_run_id: run!.id, reason: reopenReason }),
    }) as Promise<CloseRun>,
    onSuccess: (r) => {
      notifySuccess(`เปิดงวด ${r.period} อีกครั้งแล้ว`);
      setReopenReason('');
      setSelectedRun(r);
      refresh();
    },
    onError: (e: any) => notifyError(e?.message ?? 'เปิดอีกครั้งไม่สำเร็จ — ตรวจสอบ SoD และเหตุผล'),
  });

  const requiredDone = run?.steps?.filter((s) => s.required).every((s) => s.status === 'Done') ?? false;

  return (
    <div className="space-y-6">
      <PageHeader
        title="ปิดงวดบัญชี (Period-close)"
        description="GL-15/GL-16 — ปิดงวดพร้อม checklist แบบ maker-checker; ล็อกแล้วห้ามลงรายการย้อนหลัง"
      />

      {/* Start a new close run */}
      <Card>
        <CardHeader><CardTitle className="text-sm">เริ่มปิดงวด</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label>งวดบัญชี (YYYY-MM)</Label>
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
              เริ่มปิดงวด
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Run list */}
        <Card className="lg:col-span-1">
          <CardHeader><CardTitle className="text-sm">รายการปิดงวด</CardTitle></CardHeader>
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
                      <Badge variant={STATUS_VARIANT[r.status] ?? 'default'}>{STATUS_LABEL[r.status] ?? r.status}</Badge>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">เริ่มโดย {r.started_by}</div>
                  </button>
                ))}
                {(runs.data?.count ?? 0) === 0 && (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground">ยังไม่มีรายการปิดงวด</p>
                )}
              </div>
            </StateView>
          </CardContent>
        </Card>

        {/* Checklist + actions */}
        <div className="lg:col-span-2 space-y-4">
          {!run ? (
            <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">เลือกงวดจากรายการทางซ้าย หรือเริ่มงวดใหม่</CardContent></Card>
          ) : (
            <>
              {/* Run header */}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm">งวด {run.period}</CardTitle>
                    <Badge variant={STATUS_VARIANT[run.status] ?? 'default'}>{STATUS_LABEL[run.status] ?? run.status}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-1 text-sm">
                  <p className="text-muted-foreground">เริ่มโดย <span className="text-foreground font-medium">{run.started_by}</span></p>
                  {run.locked_by && (
                    <p className="text-muted-foreground">ล็อกโดย <span className="text-foreground font-medium">{run.locked_by}</span>
                      {run.locked_at && <> · {thaiDate(run.locked_at)}</>}
                    </p>
                  )}
                  {run.note && <p className="text-xs text-orange-600 dark:text-orange-400 mt-1">{run.note}</p>}
                </CardContent>
              </Card>

              {/* Checklist */}
              <Card>
                <CardHeader><CardTitle className="text-sm">Checklist การปิดงวด</CardTitle></CardHeader>
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
                        {!step.required && <Badge variant="muted" className="text-[10px]">ไม่บังคับ</Badge>}
                        {step.status === 'Pending' && run.status !== 'Locked' && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={completeStep.isPending}
                            onClick={() => completeStep.mutate(step.step_key)}
                          >
                            เสร็จแล้ว
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>

              {/* Lock / Reopen actions */}
              {run.status !== 'Locked' && (
                <Card>
                  <CardHeader><CardTitle className="text-sm">ล็อกงวด (GL-16)</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    {!requiredDone && (
                      <div className="flex items-center gap-2 text-sm text-orange-600 dark:text-orange-400">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        <span>ขั้นตอนบังคับยังไม่ครบ — ทำครบก่อนล็อกงวด</span>
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">SoD: ผู้ล็อกต้องต่างจากผู้เริ่ม ({run.started_by})</p>
                    <Button
                      disabled={lockPeriod.isPending || !requiredDone}
                      onClick={() => lockPeriod.mutate()}
                    >
                      <Lock className="mr-2 h-4 w-4" />
                      ล็อกงวด {run.period}
                    </Button>
                  </CardContent>
                </Card>
              )}

              {run.status === 'Locked' && (
                <Card className="border-orange-300 dark:border-orange-700">
                  <CardHeader><CardTitle className="text-sm text-orange-700 dark:text-orange-300">เปิดงวดฉุกเฉิน (GL-16b)</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-xs text-muted-foreground">SoD: ผู้เปิดต้องต่างจากผู้ล็อก ({run.locked_by}) · ต้องระบุเหตุผล · บันทึก audit trail</p>
                    <div>
                      <Label>เหตุผลที่เปิดงวด *</Label>
                      <Input
                        placeholder="เช่น แก้ไขรายการ depreciation ที่ลืม"
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
                      เปิดงวดอีกครั้ง
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
