'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarRange, Plus, Play, Clock, AlertTriangle, Factory } from 'lucide-react';
import { api } from '@/lib/api';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type WorkCenter = { id: number; code: string; name: string | null; minutes_per_day: number; active: boolean };
type Schedule = {
  horizon_start: string; minutes_per_day: number; makespan_minutes: number; makespan_days: number;
  late: { wo_no: string; finish_date: string; due_by: string | null }[];
  work_centers: { work_center: string; load_minutes: number; capacity_minutes: number; utilization_pct: number | null; overloaded: boolean;
    dispatch: { wo_no: string; op_no: number; start_min: number; finish_min: number; start_date: string }[] }[];
  summary: { work_orders: number; operations: number; scheduled: number; unscheduled_no_routing: number; late: number; no_routing: string[] };
};

export default function ProductionSchedulePage() {
  const qc = useQueryClient();
  const wc = useQuery<{ work_centers: WorkCenter[]; count: number }>({ queryKey: ['work-centers'], queryFn: () => api('/api/work-centers') });
  const [f, setF] = useState({ code: '', name: '', minutes_per_day: '480' });
  const [horizon, setHorizon] = useState(new Date().toISOString().slice(0, 10));
  const [schedule, setSchedule] = useState<Schedule | null>(null);

  const addWc = useMutation({
    mutationFn: () => api('/api/work-centers', { method: 'POST', body: JSON.stringify({ code: f.code, name: f.name || undefined, minutes_per_day: Number(f.minutes_per_day) || 480 }) }),
    onSuccess: () => { notifySuccess(`บันทึกศูนย์งาน ${f.code}`); setF({ code: '', name: '', minutes_per_day: '480' }); qc.invalidateQueries({ queryKey: ['work-centers'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const run = useMutation({
    mutationFn: () => api<Schedule>('/api/aps/schedule', { method: 'POST', body: JSON.stringify({ horizon_start: horizon || undefined }) }),
    onSuccess: (r) => { setSchedule(r); notifySuccess(r.summary.scheduled ? `จัดตาราง ${r.summary.scheduled} งาน · ใช้เวลา ${r.makespan_days} วัน` : 'ไม่มีใบสั่งผลิตที่จะจัดตาราง'); },
    onError: (e: any) => notifyError(e.message),
  });

  const fmtMin = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}ชม ${Math.round(m % 60)}น` : `${Math.round(m)}น`);

  return (
    <div>
      <PageHeader
        title={<span className="flex items-center gap-2"><CalendarRange className="size-5 text-primary" /> จัดตารางการผลิต (APS)</span>}
        description="จัดลำดับขั้นตอนการผลิตลงศูนย์งานแบบจำกัดกำลังการผลิต — คิวงาน (dispatch), การใช้กำลังการผลิต, และงานที่เกินกำหนด"
      />

      <Card className="mb-5 gap-3 p-5">
        <h3 className="text-base font-semibold">ศูนย์งาน (Work centres)</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="grid gap-1.5"><Label>รหัส</Label><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="เช่น MIXER" /></div>
          <div className="grid gap-1.5"><Label>ชื่อ</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>เวลาทำงาน/วัน (นาที)</Label><Input type="number" min="1" value={f.minutes_per_day} onChange={(e) => setF({ ...f, minutes_per_day: e.target.value })} /></div>
          <div className="flex items-end"><Button onClick={() => addWc.mutate()} disabled={!f.code || addWc.isPending}><Plus className="size-4" /> บันทึก</Button></div>
        </div>
        <StateView q={wc}>
          {wc.data && (
            <div className="flex flex-wrap gap-2">
              {(wc.data.work_centers ?? []).map((w) => (
                <Badge key={w.id} variant={w.active ? 'secondary' : 'muted'} className="gap-1"><Factory className="size-3" /> {w.code} · {w.minutes_per_day}น/วัน</Badge>
              ))}
              {!wc.data.count && <span className="text-sm text-muted-foreground">ยังไม่มีศูนย์งาน — เพิ่มเพื่อจัดตาราง</span>}
            </div>
          )}
        </StateView>
      </Card>

      <Card className="mb-5 gap-3 p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="grid gap-1.5"><Label>เริ่มจัดตารางจากวันที่</Label><Input type="date" value={horizon} onChange={(e) => setHorizon(e.target.value)} className="w-48" /></div>
          <Button onClick={() => run.mutate()} disabled={run.isPending}><Play className="size-4" /> จัดตาราง (ใบสั่งผลิตที่เปิดอยู่)</Button>
        </div>
      </Card>

      {schedule && (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="ใบสั่งผลิต" value={String(schedule.summary.work_orders)} icon={Factory} />
            <StatCard label="ระยะเวลารวม (makespan)" value={`${schedule.makespan_days} วัน`} icon={Clock} />
            <StatCard label="งานที่จัดได้" value={`${schedule.summary.scheduled}${schedule.summary.unscheduled_no_routing ? ` (ข้าม ${schedule.summary.unscheduled_no_routing})` : ''}`} icon={CalendarRange} />
            <StatCard label="เกินกำหนด" value={String(schedule.summary.late)} icon={AlertTriangle} tone={schedule.summary.late > 0 ? 'danger' : 'success'} />
          </div>

          {schedule.late.length > 0 && (
            <Card className="mb-5 gap-2 border-destructive/40 p-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-destructive"><AlertTriangle className="size-4" /> งานที่เสร็จเกินกำหนด</h3>
              <div className="flex flex-wrap gap-2">
                {schedule.late.map((l) => <Badge key={l.wo_no} variant="destructive">{l.wo_no} — เสร็จ {l.finish_date} (กำหนด {l.due_by})</Badge>)}
              </div>
            </Card>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {schedule.work_centers.map((w) => (
              <Card key={w.work_center} className="gap-3 p-5">
                <div className="flex items-center justify-between">
                  <h3 className="flex items-center gap-2 text-base font-semibold"><Factory className="size-4 text-muted-foreground" /> {w.work_center}</h3>
                  <Badge variant={w.overloaded ? 'destructive' : 'secondary'}>ใช้กำลัง {w.utilization_pct ?? 0}%{w.overloaded ? ' ⚠' : ''}</Badge>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div className={`h-full rounded-full ${w.overloaded ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${Math.min(100, w.utilization_pct ?? 0)}%` }} />
                </div>
                <div className="flex flex-col divide-y">
                  {w.dispatch.map((d, i) => (
                    <div key={`${d.wo_no}-${d.op_no}`} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                      <span className="flex items-center gap-2"><span className="tabular w-5 text-right text-xs text-muted-foreground">{i + 1}.</span><span className="font-medium">{d.wo_no}</span><span className="text-xs text-muted-foreground">op {d.op_no}</span></span>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground"><span>{d.start_date}</span><span className="tabular">{fmtMin(d.start_min)}–{fmtMin(d.finish_min)}</span></span>
                    </div>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
