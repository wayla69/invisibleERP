'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarRange, Clock, Percent, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { FormField } from '@/components/form-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { notifySuccess, notifyError } from '@/lib/notify';

// W4 — shift scheduling / roster + labor %.
interface Shift { id: number; emp_code: string; shift_date: string; start_time: string; end_time: string; hours: number; hourly_rate: number; position: string | null; status: string }
interface Summary { from: string; to: string; scheduled_hours: number; scheduled_cost: number; actual_hours: number; hours_variance: number; sales: number; labor_pct: number; by_staff: { emp_code: string; hours: number; cost: number; shifts: number }[] }

function weekStart() { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); }
function addDays(d: string, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); }

export default function SchedulingPage() {
  const qc = useQueryClient();
  const [from, setFrom] = useState(weekStart());
  const to = addDays(from, 6);
  const shifts = useQuery<{ shifts: Shift[]; count: number }>({ queryKey: ['shifts', from, to], queryFn: () => api(`/api/pos/labor/shifts?from=${from}&to=${to}`) });
  const summary = useQuery<Summary>({ queryKey: ['labor-summary', from, to], queryFn: () => api(`/api/pos/labor/labor-summary?from=${from}&to=${to}`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['shifts'] }); qc.invalidateQueries({ queryKey: ['labor-summary'] }); };

  const [form, setForm] = useState({ emp_code: '', shift_date: from, start_time: '09:00', end_time: '17:00', hourly_rate: '', position: '' });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const create = useMutation({
    mutationFn: () => api('/api/pos/labor/shifts', { method: 'POST', body: JSON.stringify({ emp_code: form.emp_code, shift_date: form.shift_date, start_time: form.start_time, end_time: form.end_time, hourly_rate: form.hourly_rate ? Number(form.hourly_rate) : undefined, position: form.position || undefined }) }),
    onSuccess: () => { notifySuccess('เพิ่มกะงานแล้ว'); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const cancel = useMutation({
    mutationFn: (id: number) => api(`/api/pos/labor/shifts/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => { notifySuccess('ยกเลิกกะแล้ว'); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const alerts = useQuery<{ alerts: any[]; count: number }>({ queryKey: ['labor-alerts'], queryFn: () => api('/api/pos/labor/alerts?resolved=false') });
  const checkAlert = useMutation({
    mutationFn: () => api('/api/pos/labor/labor-alert/check', { method: 'POST', body: JSON.stringify({ from, to, threshold: 35 }) }),
    onSuccess: (r: any) => { notifySuccess(r?.exceeded ? `แรงงาน ${num(r.labor_pct)}% เกินเป้า — แจ้งเตือนแล้ว` : `แรงงาน ${num(r.labor_pct)}% อยู่ในเป้า`); qc.invalidateQueries({ queryKey: ['labor-alerts'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const resolveAlert = useMutation({
    mutationFn: (id: number) => api(`/api/pos/labor/alerts/${id}/resolve`, { method: 'POST' }),
    onSuccess: () => { notifySuccess('ปิดการแจ้งเตือนแล้ว'); qc.invalidateQueries({ queryKey: ['labor-alerts'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const sm = summary.data;
  return (
    <ModulePage
      title="จัดตารางเวร & ต้นทุนแรงงาน (Scheduling & labor)"
      description="วางกะงานพนักงานรายสัปดาห์ ดูชั่วโมง/ต้นทุนแรงงานที่วางแผน เทียบกับยอดขาย (แรงงาน % ของยอดขาย) และชั่วโมงที่ลงเวลาจริง"
      query={shifts}
      stats={sm && (
        <>
          <StatCard label="แรงงาน % ของยอดขาย" value={`${num(sm.labor_pct)}%`} icon={Percent} tone={sm.labor_pct > 30 ? 'danger' : sm.labor_pct > 0 ? 'warning' : 'default'} hint="ต้นทุนแรงงานที่วางแผน ÷ ยอดขาย" />
          <StatCard label="ชั่วโมงที่วางแผน" value={num(sm.scheduled_hours)} icon={Clock} tone="primary" hint={`ลงเวลาจริง ${num(sm.actual_hours)} ชม.`} />
          <StatCard label="ต้นทุนแรงงาน (วางแผน)" value={baht(sm.scheduled_cost)} icon={Users} tone="default" />
          <StatCard label="ยอดขาย (งวด)" value={baht(sm.sales)} icon={CalendarRange} tone="default" />
        </>
      )}
      statsClassName="xl:grid-cols-4"
    >
      <div className="mb-4 flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setFrom(addDays(from, -7))}>← สัปดาห์ก่อน</Button>
        <span className="text-sm font-medium">{thaiDate(from)} – {thaiDate(to)}</span>
        <Button size="sm" variant="outline" onClick={() => setFrom(addDays(from, 7))}>สัปดาห์ถัดไป →</Button>
        <Button size="sm" variant="outline" disabled={checkAlert.isPending} onClick={() => checkAlert.mutate()}>ตรวจแรงงาน % (เป้า 35%)</Button>
      </div>

      {(alerts.data?.alerts?.length ?? 0) > 0 && (
        <div className="mb-4 space-y-2">
          {alerts.data!.alerts.map((a) => (
            <div key={a.id} className="flex items-center justify-between rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-2 text-sm">
              <span>⚠️ แรงงาน <b>{num(a.actual_pct)}%</b> เกินเป้า {num(a.threshold_pct)}% · งวด {a.period_from} – {a.period_to}</span>
              <Button size="sm" variant="ghost" onClick={() => resolveAlert.mutate(a.id)}>ปิด</Button>
            </div>
          ))}
        </div>
      )}

      <div className="mb-4 rounded-xl border bg-card p-4">
        <h3 className="mb-3 text-sm font-semibold">เพิ่มกะงาน</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <FormField label="รหัสพนักงาน"><Input value={form.emp_code} onChange={(e) => set('emp_code', e.target.value)} placeholder="เช่น A01" /></FormField>
          <FormField label="วันที่"><Input type="date" value={form.shift_date} onChange={(e) => set('shift_date', e.target.value)} /></FormField>
          <FormField label="เริ่ม"><Input type="time" value={form.start_time} onChange={(e) => set('start_time', e.target.value)} /></FormField>
          <FormField label="เลิก"><Input type="time" value={form.end_time} onChange={(e) => set('end_time', e.target.value)} /></FormField>
          <FormField label="ค่าจ้าง/ชม."><Input type="number" min={0} value={form.hourly_rate} onChange={(e) => set('hourly_rate', e.target.value)} /></FormField>
          <div className="flex items-end"><Button disabled={create.isPending || !form.emp_code} onClick={() => create.mutate()}>เพิ่มกะ</Button></div>
        </div>
      </div>

      {shifts.data && (
        <DataTable
          rows={shifts.data.shifts}
          rowKey={(r) => r.id}
          emptyState={{ icon: CalendarRange, title: 'ยังไม่มีกะงานในสัปดาห์นี้', description: 'เพิ่มกะงานจากฟอร์มด้านบนเพื่อวางตารางเวรและดูต้นทุนแรงงาน' }}
          columns={[
            { key: 'shift_date', label: 'วันที่', render: (r) => thaiDate(r.shift_date) },
            { key: 'emp_code', label: 'พนักงาน', render: (r) => <span className="font-medium">{r.emp_code}</span> },
            { key: 'position', label: 'ตำแหน่ง', render: (r) => r.position || '—' },
            { key: 'time', label: 'เวลา', render: (r) => `${r.start_time}–${r.end_time}` },
            { key: 'hours', label: 'ชม.', align: 'right', render: (r) => num(r.hours) },
            { key: 'cost', label: 'ต้นทุน', align: 'right', render: (r) => baht(r.hours * r.hourly_rate) },
            { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={r.status === 'cancelled' ? 'muted' : 'info'}>{r.status === 'cancelled' ? 'ยกเลิก' : 'จัดแล้ว'}</Badge> },
            { key: 'actions', label: '', align: 'right', render: (r) => r.status !== 'cancelled' ? <Button size="sm" variant="ghost" onClick={() => cancel.mutate(r.id)}>ยกเลิก</Button> : null },
          ]}
        />
      )}
    </ModulePage>
  );
}
