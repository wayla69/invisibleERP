'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Webhook, Plus, Trash2, RefreshCw, Send, History } from 'lucide-react';
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

interface EventDef { key: string; label: string; label_en: string }
interface Hook { id: number; url: string; events: string[]; active: boolean; createdBy: string | null; createdAt: string | null }
interface Delivery { id: number; webhook_id: number; event: string; status: string; status_code: number | null; attempts: number; error: string | null; created_at: string | null; delivered_at: string | null }

export default function WebhooksPage() {
  return (
    <div>
      <PageHeader title="เว็บฮุค (Webhooks)" description="ส่งเหตุการณ์ทางธุรกิจ (PO อนุมัติ, การแจ้งเตือน) ไปยังระบบภายนอกแบบเรียลไทม์ ด้วย payload ที่ลงลายเซ็น (HMAC-SHA256)" />
      <Tabs tabs={[
        { key: 'endpoints', label: 'ปลายทาง (Endpoints)', content: <Endpoints /> },
        { key: 'deliveries', label: 'ประวัติการส่ง', content: <Deliveries /> },
      ]} />
    </div>
  );
}

function Endpoints() {
  const qc = useQueryClient();
  const cat = useQuery<{ events: EventDef[] }>({ queryKey: ['wh-events'], queryFn: () => api('/api/platform/webhooks/events') });
  const q = useQuery<Hook[]>({ queryKey: ['wh-list'], queryFn: () => api('/api/platform/webhooks') });
  const [url, setUrl] = useState(''); const [events, setEvents] = useState<string[]>([]);
  const [secret, setSecret] = useState('');
  const allEvents = cat.data?.events ?? [];

  const create = useMutation({
    mutationFn: () => api<{ secret: string }>('/api/platform/webhooks', { method: 'POST', body: JSON.stringify({ url, events }) }),
    onSuccess: (r) => { setSecret(r.secret); notifySuccess('สร้างปลายทางแล้ว — คัดลอก secret ด้านล่าง (แสดงครั้งเดียว)'); setUrl(''); setEvents([]); qc.invalidateQueries({ queryKey: ['wh-list'] }); },
    onError: (e: Error) => { notifyError(e.message); setSecret(''); },
  });
  const remove = useMutation({ mutationFn: (id: number) => api(`/api/platform/webhooks/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['wh-list'] }) });
  const toggle = (k: string) => setEvents((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Webhook className="h-4 w-4" />ลงทะเบียนปลายทางใหม่</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div><Label>URL ปลายทาง</Label><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/ierp-webhook" /></div>
          <div>
            <Label>เหตุการณ์ที่ต้องการรับ (ไม่เลือก = รับทุกเหตุการณ์)</Label>
            <div className="mt-1 flex flex-wrap gap-2">
              {allEvents.map((e) => (
                <button key={e.key} type="button" onClick={() => toggle(e.key)}
                  className={`rounded-full border px-3 py-1 text-xs ${events.includes(e.key) ? 'bg-primary text-primary-foreground' : 'bg-background'}`}>
                  {e.label} <code className="opacity-70">{e.key}</code>
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button disabled={!url || create.isPending} onClick={() => create.mutate()}><Plus className="mr-1 h-4 w-4" />ลงทะเบียน</Button>
          </div>
          {secret && (
            <div className="rounded-md border border-amber-400 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
              <div className="font-medium">Signing secret (เก็บไว้ให้ดี — แสดงครั้งเดียว):</div>
              <code className="break-all">{secret}</code>
              <div className="mt-1 text-xs text-muted-foreground">ผู้รับตรวจสอบลายเซ็น: <code>HMAC-SHA256(secret, `${'{timestamp}'}.${'{body}'}`)</code> เทียบกับ header <code>X-IERP-Signature</code></div>
            </div>
          )}
        </CardContent>
      </Card>
      <StateView q={q}>
        <DataTable
          rows={q.data ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: 'url', label: 'URL', render: (r) => <code className="text-xs">{r.url}</code> },
            { key: 'events', label: 'เหตุการณ์', render: (r) => (r.events?.length ? r.events.map((e) => <Badge key={e} variant="muted" className="mr-1">{e}</Badge>) : <Badge variant="info">ทั้งหมด</Badge>) },
            { key: 'active', label: 'สถานะ', render: (r) => <Badge variant={r.active ? 'success' : 'muted'}>{r.active ? 'ใช้งาน' : 'ปิด'}</Badge> },
            { key: 'createdAt', label: 'สร้างเมื่อ', render: (r) => r.createdAt ? new Date(r.createdAt).toLocaleString('th-TH') : '—' },
            { key: 'act', label: '', align: 'right', render: (r) => <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(r.id)}><Trash2 className="h-4 w-4" /></Button> },
          ]}
          emptyState={{ icon: Webhook, title: 'ยังไม่มีปลายทาง webhook', description: 'ลงทะเบียนปลายทางด้านบนเพื่อเริ่มส่งเหตุการณ์ไปยังระบบภายนอก' }}
        />
      </StateView>
    </div>
  );
}

function Deliveries() {
  const qc = useQueryClient();
  const q = useQuery<{ deliveries: Delivery[] }>({ queryKey: ['wh-deliveries'], queryFn: () => api('/api/platform/webhooks/deliveries'), refetchInterval: 15_000 });
  const redeliver = useMutation({ mutationFn: (id: number) => api(`/api/platform/webhooks/deliveries/${id}/redeliver`, { method: 'POST' }), onSuccess: (r: any) => { notifySuccess(`ส่งซ้ำ #${r.id}: ${r.status}`); qc.invalidateQueries({ queryKey: ['wh-deliveries'] }); } });
  const dispatch = useMutation({ mutationFn: () => api('/api/platform/webhooks/dispatch', { method: 'POST' }), onSuccess: (r: any) => { notifySuccess(`ส่งซ้ำที่ค้าง: สำเร็จ ${r.delivered} · ยังล้มเหลว ${r.still_failed}`); qc.invalidateQueries({ queryKey: ['wh-deliveries'] }); } });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Button variant="outline" disabled={dispatch.isPending} onClick={() => dispatch.mutate()}><RefreshCw className="mr-1 h-4 w-4" />ส่งซ้ำที่ค้าง (Dispatch)</Button>
      </div>
      <StateView q={q}>
        <DataTable
          rows={q.data?.deliveries ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: 'created_at', label: 'เวลา', render: (r) => r.created_at ? new Date(r.created_at).toLocaleString('th-TH') : '—' },
            { key: 'event', label: 'เหตุการณ์', render: (r) => <code className="text-xs">{r.event}</code> },
            { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={r.status === 'delivered' ? 'success' : r.status === 'failed' ? 'destructive' : 'muted'}>{r.status}</Badge> },
            { key: 'attempts', label: 'ครั้ง', align: 'right', render: (r) => r.attempts },
            { key: 'error', label: 'ข้อผิดพลาด', render: (r) => <span className="text-xs text-muted-foreground">{r.error ?? ''}</span> },
            { key: 'act', label: '', align: 'right', render: (r) => r.status !== 'delivered' ? <Button size="sm" variant="ghost" disabled={redeliver.isPending} onClick={() => redeliver.mutate(r.id)} title="ส่งซ้ำ"><Send className="h-4 w-4" /></Button> : null },
          ]}
          emptyState={{ icon: History, title: 'ยังไม่มีการส่ง', description: 'เมื่อมีเหตุการณ์ถูกส่งไปยังปลายทาง ประวัติการส่งจะแสดงที่นี่' }}
        />
      </StateView>
    </div>
  );
}
