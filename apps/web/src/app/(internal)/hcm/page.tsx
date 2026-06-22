'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, Plane, Check } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs, Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

const selectCls = 'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';
const today = () => new Date().toISOString().slice(0, 10);

export default function HcmPage() {
  return (
    <div>
      <PageHeader title="บุคลากร (HR)" description="ลงเวลา/ล่วงเวลา (OT) → เข้าระบบเงินเดือน · การลา (ลาไม่รับค่าจ้างหักเงินเดือนอัตโนมัติ)" />
      <Tabs tabs={[
        { key: 'time', label: 'ลงเวลา / OT', content: <Timesheets /> },
        { key: 'leave', label: 'การลา', content: <Leave /> },
      ]} />
    </div>
  );
}

function Timesheets() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['timesheets'], queryFn: () => api('/api/hcm/timesheets') });
  const [f, setF] = useState({ emp_code: '', work_date: today(), regular_hours: '', ot_hours: '' });
  const [msg, setMsg] = useState('');
  const add = useMutation({
    mutationFn: () => api('/api/hcm/timesheets', { method: 'POST', body: JSON.stringify({ emp_code: f.emp_code, work_date: f.work_date, regular_hours: Number(f.regular_hours) || 0, ot_hours: Number(f.ot_hours) || 0 }) }),
    onSuccess: () => { setMsg('✅ บันทึกเวลาทำงาน'); setF({ ...f, regular_hours: '', ot_hours: '' }); qc.invalidateQueries({ queryKey: ['timesheets'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">บันทึกเวลาทำงาน / ล่วงเวลา</h3>
        <div className="flex flex-wrap gap-3">
          <div className="grid gap-1.5"><Label>รหัสพนักงาน</Label><Input value={f.emp_code} onChange={(e) => setF({ ...f, emp_code: e.target.value })} className="w-36" placeholder="EMP..." /></div>
          <div className="grid gap-1.5"><Label>วันที่</Label><Input type="date" value={f.work_date} onChange={(e) => setF({ ...f, work_date: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>ชม.ปกติ</Label><Input type="number" value={f.regular_hours} onChange={(e) => setF({ ...f, regular_hours: e.target.value })} className="w-24" /></div>
          <div className="grid gap-1.5"><Label>ชม. OT</Label><Input type="number" value={f.ot_hours} onChange={(e) => setF({ ...f, ot_hours: e.target.value })} className="w-24" /></div>
        </div>
        <div className="flex items-center gap-3"><Button onClick={() => add.mutate()} disabled={!f.emp_code || add.isPending}><Clock className="size-4" /> บันทึก</Button><Msg ok={msg.startsWith('✅')}>{msg}</Msg></div>
      </Card>
      <StateView q={q}>{q.data && <DataTable rows={q.data.timesheets} columns={[
        { key: 'work_date', label: 'วันที่' }, { key: 'regular_hours', label: 'ชม.ปกติ', align: 'right' }, { key: 'ot_hours', label: 'ชม. OT', align: 'right' },
      ]} emptyText="ยังไม่มีบันทึกเวลา" />}</StateView>
    </div>
  );
}

function Leave() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['leave'], queryFn: () => api('/api/hcm/leave') });
  const [f, setF] = useState({ emp_code: '', leave_type: 'annual', from_date: today(), to_date: today(), days: '', paid: 'true' });
  const [msg, setMsg] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['leave'] });
  const req = useMutation({
    mutationFn: () => api('/api/hcm/leave', { method: 'POST', body: JSON.stringify({ emp_code: f.emp_code, leave_type: f.leave_type, from_date: f.from_date, to_date: f.to_date, days: Number(f.days) || 0, paid: f.paid === 'true' }) }),
    onSuccess: () => { setMsg('✅ ส่งใบลา'); setF({ ...f, days: '' }); refresh(); }, onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const approve = useMutation({ mutationFn: (id: number) => api(`/api/hcm/leave/${id}/approve`, { method: 'POST', body: JSON.stringify({}) }), onSuccess: refresh });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">ขอลา</h3>
        <div className="flex flex-wrap gap-3">
          <div className="grid gap-1.5"><Label>รหัสพนักงาน</Label><Input value={f.emp_code} onChange={(e) => setF({ ...f, emp_code: e.target.value })} className="w-36" /></div>
          <div className="grid gap-1.5"><Label>ประเภท</Label><select className={selectCls} value={f.leave_type} onChange={(e) => setF({ ...f, leave_type: e.target.value })}><option value="annual">ลาพักร้อน</option><option value="sick">ลาป่วย</option><option value="personal">ลากิจ</option><option value="unpaid">ลาไม่รับค่าจ้าง</option></select></div>
          <div className="grid gap-1.5"><Label>ตั้งแต่</Label><Input type="date" value={f.from_date} onChange={(e) => setF({ ...f, from_date: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>ถึง</Label><Input type="date" value={f.to_date} onChange={(e) => setF({ ...f, to_date: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>จำนวนวัน</Label><Input type="number" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} className="w-24" /></div>
          <div className="grid gap-1.5"><Label>รับค่าจ้าง?</Label><select className={selectCls} value={f.paid} onChange={(e) => setF({ ...f, paid: e.target.value })}><option value="true">รับค่าจ้าง</option><option value="false">ไม่รับค่าจ้าง</option></select></div>
        </div>
        <div className="flex items-center gap-3"><Button onClick={() => req.mutate()} disabled={!f.emp_code || !f.days || req.isPending}><Plane className="size-4" /> ส่งใบลา</Button><Msg ok={msg.startsWith('✅')}>{msg}</Msg></div>
      </Card>
      <StateView q={q}>{q.data && <DataTable rows={q.data.leave_requests} columns={[
        { key: 'leave_type', label: 'ประเภท' }, { key: 'from_date', label: 'ตั้งแต่' }, { key: 'to_date', label: 'ถึง' }, { key: 'days', label: 'วัน', align: 'right' },
        { key: 'paid', label: 'ค่าจ้าง', render: (r: any) => (r.paid ? 'รับ' : 'ไม่รับ') },
        { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
        { key: 'act', label: '', sortable: false, render: (r: any) => r.status === 'Pending' ? <Button size="sm" variant="outline" onClick={() => approve.mutate(r.id)}><Check className="size-4" /> อนุมัติ</Button> : <span className="text-xs text-muted-foreground">—</span> },
      ]} emptyText="ยังไม่มีใบลา" />}</StateView>
    </div>
  );
}
