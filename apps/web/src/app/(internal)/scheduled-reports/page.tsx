'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Plus, Trash2, Play, RefreshCw, History } from 'lucide-react';
import { api } from '@/lib/api';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface ReportType { key: string; label: string; label_en: string }
interface Catalog { report_types: ReportType[]; frequencies: string[] }
interface Subscription { id: number; name: string; report_type: string; frequency: string; recipients: { email?: string }[]; is_active: boolean; next_run_at: string | null }
interface Run { id: number; name: string; report_type: string; frequency: string; status: string; recipients_count: number; error: string | null; ran_at: string | null }

const FREQ_LABEL: Record<string, string> = { daily: 'รายวัน', weekly: 'รายสัปดาห์', monthly: 'รายเดือน' };

export default function ScheduledReportsPage() {
  return (
    <div>
      <PageHeader title="รายงานตามกำหนดเวลา (Scheduled reports)" description="ตั้งรายงาน (สรุป KPI, ยอดขาย, กำไร-ขาดทุน, ไปป์ไลน์) ให้สร้างและส่งอัตโนมัติตามรอบ → แจ้งเตือนในระบบ + อีเมลผู้รับ" />
      <Tabs tabs={[
        { key: 'subs', label: 'รายงานที่ตั้งไว้', content: <Subscriptions /> },
        { key: 'runs', label: 'ประวัติการส่ง', content: <Runs /> },
      ]} />
    </div>
  );
}

function Subscriptions() {
  const qc = useQueryClient();
  const cat = useQuery<Catalog>({ queryKey: ['report-types'], queryFn: () => api('/api/bi/report-types') });
  const q = useQuery<{ subscriptions: Subscription[] }>({ queryKey: ['bi-subscriptions'], queryFn: () => api('/api/bi/subscriptions') });
  const [name, setName] = useState(''); const [reportType, setReportType] = useState(''); const [frequency, setFrequency] = useState('daily'); const [email, setEmail] = useState('');
  const types = cat.data?.report_types ?? [];

  const create = useMutation({
    mutationFn: () => api('/api/bi/subscriptions', { method: 'POST', body: JSON.stringify({ name, report_type: reportType || types[0]?.key, frequency, recipients: email ? [{ email }] : [] }) }),
    onSuccess: () => { notifySuccess(`ตั้งรายงาน ${name}`); setName(''); setEmail(''); qc.invalidateQueries({ queryKey: ['bi-subscriptions'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const sweep = useMutation({
    mutationFn: () => api('/api/bi/subscriptions/run', { method: 'POST' }),
    onSuccess: (r: any) => { notifySuccess(`ส่งรายงานที่ถึงกำหนด: ${r.ran_count} ฉบับ`); qc.invalidateQueries({ queryKey: ['bi-subscriptions'] }); qc.invalidateQueries({ queryKey: ['bi-runs'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const runNow = useMutation({
    mutationFn: (id: number) => api(`/api/bi/subscriptions/${id}/run`, { method: 'POST' }),
    onSuccess: (r: any) => { if (r.status === 'success') notifySuccess(`ส่งรายงานแล้ว (ผู้รับ ${r.delivered})`); else notifyError(`ส่งไม่สำเร็จ: ${r.error ?? ''}`); qc.invalidateQueries({ queryKey: ['bi-runs'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const remove = useMutation({ mutationFn: (id: number) => api(`/api/bi/subscriptions/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['bi-subscriptions'] }) });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-sm flex items-center gap-2"><CalendarClock className="h-4 w-4" />ตั้งรายงานตามกำหนดเวลา</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="sm:col-span-2"><Label>ชื่อรายงาน</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น สรุป KPI รายวัน" /></div>
            <div><Label>ประเภทรายงาน</Label>
              <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={reportType} onChange={(e) => setReportType(e.target.value)}>
                {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </div>
            <div><Label>รอบการส่ง</Label>
              <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={frequency} onChange={(e) => setFrequency(e.target.value)}>
                {(cat.data?.frequencies ?? ['daily', 'weekly', 'monthly']).map((f) => <option key={f} value={f}>{FREQ_LABEL[f] ?? f}</option>)}
              </select>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><Label>อีเมลผู้รับ (ไม่บังคับ)</Label><Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="cfo@example.com" /></div>
          </div>
          <div className="flex items-center gap-3">
            <Button disabled={!name || (!reportType && !types.length) || create.isPending} onClick={() => create.mutate()}><Plus className="mr-1 h-4 w-4" />ตั้งรายงาน</Button>
            <Button variant="outline" disabled={sweep.isPending} onClick={() => sweep.mutate()}><RefreshCw className="mr-1 h-4 w-4" />ส่งที่ถึงกำหนดเดี๋ยวนี้</Button>
          </div>
        </CardContent>
      </Card>
      <StateView q={q}>
        <DataTable
          rows={q.data?.subscriptions ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: 'name', label: 'ชื่อรายงาน' },
            { key: 'report_type', label: 'ประเภท', render: (r) => <code className="text-xs">{r.report_type}</code> },
            { key: 'frequency', label: 'รอบ', render: (r) => <Badge variant="muted">{FREQ_LABEL[r.frequency] ?? r.frequency}</Badge> },
            { key: 'recipients', label: 'ผู้รับ', render: (r) => (r.recipients ?? []).map((x) => x.email).filter(Boolean).join(', ') || '—' },
            { key: 'next_run_at', label: 'รอบถัดไป', render: (r) => r.next_run_at ? new Date(r.next_run_at).toLocaleString('th-TH') : '—' },
            { key: 'run', label: '', align: 'right', render: (r) => <Button size="sm" variant="ghost" disabled={runNow.isPending} onClick={() => runNow.mutate(r.id)} title="ส่งเดี๋ยวนี้"><Play className="h-4 w-4" /></Button> },
            { key: 'act', label: '', align: 'right', render: (r) => <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(r.id)}><Trash2 className="h-4 w-4" /></Button> },
          ]}
          emptyState={{ icon: CalendarClock, title: 'ยังไม่มีรายงานที่ตั้งไว้', description: 'ตั้งรายงานในแบบฟอร์มด้านบนเพื่อให้ระบบสร้างและส่งอัตโนมัติตามรอบ' }}
        />
      </StateView>
    </div>
  );
}

function Runs() {
  const q = useQuery<{ runs: Run[] }>({ queryKey: ['bi-runs'], queryFn: () => api('/api/bi/runs'), refetchInterval: 15_000 });
  return (
    <StateView q={q}>
      <DataTable
        rows={q.data?.runs ?? []}
        rowKey={(r) => r.id}
        columns={[
          { key: 'ran_at', label: 'เวลา', render: (r) => r.ran_at ? new Date(r.ran_at).toLocaleString('th-TH') : '—' },
          { key: 'name', label: 'รายงาน' },
          { key: 'report_type', label: 'ประเภท', render: (r) => <code className="text-xs">{r.report_type}</code> },
          { key: 'recipients_count', label: 'ส่งถึง', align: 'right', render: (r) => r.recipients_count },
          { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={r.status === 'success' ? 'success' : 'destructive'}>{r.status === 'success' ? 'สำเร็จ' : 'ล้มเหลว'}</Badge> },
          { key: 'error', label: 'หมายเหตุ', render: (r) => r.error ?? '' },
        ]}
        emptyState={{ icon: History, title: 'ยังไม่มีประวัติการส่ง', description: 'เมื่อรายงานถูกส่งตามรอบหรือส่งด้วยตนเอง ประวัติจะแสดงที่นี่' }}
      />
    </StateView>
  );
}
