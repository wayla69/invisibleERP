'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Megaphone, Plus, Send, Ban, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const selectCls = 'h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';
const tone: Record<string, any> = { draft: 'muted', scheduled: 'info', sent: 'success', cancelled: 'destructive' };

interface Campaign { id: number; campaign_code: string; name: string; channel: string; audience: string; segment: string | null; tier: string | null; saved_segment_id: number | null; status: string; targeted: number; sent_count: number; skipped_count: number; failed_count: number; schedule_at: string | null }
interface SavedSegment { id: number; name: string }

export default function CampaignsPage() {
  const qc = useQueryClient();
  const list = useQuery<{ campaigns: Campaign[] }>({ queryKey: ['loy-campaigns'], queryFn: () => api('/api/loyalty/campaigns') });
  const segs = useQuery<{ segments: SavedSegment[] }>({ queryKey: ['saved-segments'], queryFn: () => api('/api/loyalty/saved-segments') });

  const [f, setF] = useState({ name: '', channel: 'sms', audience: 'all', segment: '', tier: '', saved_segment_id: '', body: '', schedule_at: '' });
  const set = (p: Partial<typeof f>) => setF((s) => ({ ...s, ...p }));

  const create = useMutation({
    mutationFn: () => api('/api/loyalty/campaigns', { method: 'POST', body: JSON.stringify({
      name: f.name, channel: f.channel, audience: f.audience, body: f.body,
      ...(f.audience === 'segment' ? { segment: f.segment } : {}), ...(f.audience === 'tier' ? { tier: f.tier } : {}), ...(f.audience === 'saved_segment' ? { saved_segment_id: Number(f.saved_segment_id) } : {}),
      ...(f.schedule_at ? { schedule_at: new Date(f.schedule_at).toISOString() } : {}),
    }) }),
    onSuccess: () => { notifySuccess('สร้างแคมเปญแล้ว'); setF({ name: '', channel: 'sms', audience: 'all', segment: '', tier: '', saved_segment_id: '', body: '', schedule_at: '' }); qc.invalidateQueries({ queryKey: ['loy-campaigns'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const sendNow = useMutation({ mutationFn: (c: Campaign) => api(`/api/loyalty/campaigns/${c.id}/send`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['loy-campaigns'] }), onError: (e: Error) => notifyError(e.message) });
  const cancel = useMutation({ mutationFn: (c: Campaign) => api(`/api/loyalty/campaigns/${c.id}/cancel`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['loy-campaigns'] }), onError: (e: Error) => notifyError(e.message) });

  return (
    <div>
      <PageHeader title="แคมเปญ (Campaigns)" description="ส่งข้อความหากลุ่มสมาชิก (ทั้งหมด / กลุ่ม RFM / ระดับ / วันเกิด) ทันทีหรือตั้งเวลา — เคารพการขอไม่รับข่าวสาร (PDPA)" actions={<Link href="/loyalty/members"><Button variant="outline"><Users className="size-4" /> สมาชิก</Button></Link>} />

      <div className="space-y-6">
        <Card className="gap-4">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Plus className="size-4" /> สร้างแคมเปญ</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="grid gap-1.5"><Label>ชื่อแคมเปญ</Label><Input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="โปรเดือนนี้" /></div>
              <div className="grid gap-1.5"><Label>ช่องทาง</Label><select className={selectCls} value={f.channel} onChange={(e) => set({ channel: e.target.value })}><option value="sms">SMS</option><option value="email">Email</option><option value="line">LINE</option></select></div>
              <div className="grid gap-1.5"><Label>กลุ่มเป้าหมาย</Label><select className={selectCls} value={f.audience} onChange={(e) => set({ audience: e.target.value })}><option value="all">สมาชิกทั้งหมด</option><option value="segment">กลุ่ม RFM</option><option value="saved_segment">เซกเมนต์ที่บันทึกไว้</option><option value="tier">ระดับสมาชิก</option><option value="birthdays_today">วันเกิดวันนี้</option></select></div>
              {f.audience === 'segment' && <div className="grid gap-1.5"><Label>กลุ่ม RFM</Label><Input value={f.segment} onChange={(e) => set({ segment: e.target.value })} placeholder="เช่น Champions" /></div>}
              {f.audience === 'tier' && <div className="grid gap-1.5"><Label>ระดับ</Label><Input value={f.tier} onChange={(e) => set({ tier: e.target.value })} placeholder="เช่น Gold" /></div>}
              {f.audience === 'saved_segment' && <div className="grid gap-1.5"><Label>เซกเมนต์</Label><select className={selectCls} value={f.saved_segment_id} onChange={(e) => set({ saved_segment_id: e.target.value })}><option value="">— เลือกเซกเมนต์ —</option>{(segs.data?.segments ?? []).map((sg) => <option key={sg.id} value={sg.id}>{sg.name}</option>)}</select></div>}
              <div className="grid gap-1.5"><Label>ตั้งเวลาส่ง (ว่าง=ส่งเอง)</Label><Input type="datetime-local" value={f.schedule_at} onChange={(e) => set({ schedule_at: e.target.value })} /></div>
            </div>
            <div className="grid gap-1.5"><Label>ข้อความ</Label><textarea className="min-h-20 rounded-md border border-input bg-transparent p-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" value={f.body} onChange={(e) => set({ body: e.target.value })} placeholder="สวัสดีค่ะ รับสิทธิพิเศษ…" /></div>
            <div className="flex items-center gap-3"><Button onClick={() => create.mutate()} disabled={!f.name.trim() || !f.body.trim() || (f.audience === 'saved_segment' && !f.saved_segment_id) || create.isPending}>{create.isPending ? 'กำลังบันทึก…' : 'สร้างแคมเปญ'}</Button></div>
          </CardContent>
        </Card>

        <StateView q={list}>
          {list.data && (
            <DataTable
              rows={list.data.campaigns}
              rowKey={(c) => c.id}
              emptyState={{ icon: Megaphone, title: 'ยังไม่มีแคมเปญ', description: 'สร้างแคมเปญแรกจากแบบฟอร์มด้านบนเพื่อส่งข้อความถึงสมาชิก' }}
              columns={[
                { key: 'campaign_code', label: 'รหัส', render: (c) => <span className="font-mono text-xs">{c.campaign_code}</span> },
                { key: 'name', label: 'ชื่อ', render: (c) => <span className="inline-flex items-center gap-1.5"><Megaphone className="size-3.5 text-muted-foreground" />{c.name}</span> },
                { key: 'audience', label: 'กลุ่ม', render: (c) => <Badge variant="info">{c.audience}{c.segment ? `:${c.segment}` : c.tier ? `:${c.tier}` : c.saved_segment_id ? `:${segs.data?.segments.find((sg) => sg.id === c.saved_segment_id)?.name ?? c.saved_segment_id}` : ''}</Badge> },
                { key: 'channel', label: 'ช่องทาง' },
                { key: 'status', label: 'สถานะ', render: (c) => <Badge variant={tone[c.status] ?? 'muted'}>{c.status}</Badge> },
                { key: 'sent_count', label: 'ส่ง/ข้าม/พลาด', align: 'right', render: (c) => c.status === 'sent' ? <span className="tabular text-xs">{num(c.sent_count)}/{num(c.skipped_count)}/{num(c.failed_count)}</span> : '—' },
                { key: 'act', label: '', align: 'right', render: (c) => (c.status === 'draft' || c.status === 'scheduled') ? (
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="outline" disabled={sendNow.isPending} onClick={() => sendNow.mutate(c)}><Send className="size-3.5" /> ส่งเลย</Button>
                    <Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate(c)}><Ban className="size-3.5" /></Button>
                  </div>
                ) : null },
              ]}
            />
          )}
        </StateView>
      </div>
    </div>
  );
}
