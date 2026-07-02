'use client';

// Phase G1 (docs/25) — lifecycle journeys: a linear multi-step drip (wait N days → send, unless a skip-rule
// matches). Steps are built with the same catalog-driven grammar as the segment builder; sends are
// consent-gated + frequency-capped and each step fires at most once (MKT-12) — enforced server-side.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Route, Plus, Play, Pause, Pencil, X, Users, Filter } from 'lucide-react';
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
const tone: Record<string, any> = { draft: 'muted', active: 'success', paused: 'info' };

interface Step { wait_days: number; channel: string; body: string; skip_rule?: { field: string; op: string; value: any } | null }
interface Journey { id: number; code: string; name: string; status: string; trigger: string; segment_id: number | null; cap_messages: number; cap_window_days: number; steps: Step[]; funnel: { active: number; completed: number; exited: number } }
interface SavedSegment { id: number; name: string }

export default function JourneysPage() {
  const qc = useQueryClient();
  const list = useQuery<{ journeys: Journey[] }>({ queryKey: ['journeys'], queryFn: () => api('/api/loyalty/journeys') });
  const segs = useQuery<{ segments: SavedSegment[] }>({ queryKey: ['saved-segments'], queryFn: () => api('/api/loyalty/saved-segments') });

  const [editId, setEditId] = useState<number | null>(null);
  const [f, setF] = useState({ name: '', trigger: 'manual', segment_id: '', cap_messages: '0', cap_window_days: '7' });
  const [steps, setSteps] = useState<Step[]>([{ wait_days: 0, channel: 'sms', body: '' }]);
  const set = (p: Partial<typeof f>) => setF((s) => ({ ...s, ...p }));
  const setStep = (i: number, p: Partial<Step>) => setSteps((ss) => ss.map((s, ix) => (ix === i ? { ...s, ...p } : s)));
  const reset = () => { setEditId(null); setF({ name: '', trigger: 'manual', segment_id: '', cap_messages: '0', cap_window_days: '7' }); setSteps([{ wait_days: 0, channel: 'sms', body: '' }]); };
  const loadForEdit = (j: Journey) => {
    setEditId(j.id);
    setF({ name: j.name, trigger: j.trigger, segment_id: j.segment_id ? String(j.segment_id) : '', cap_messages: String(j.cap_messages), cap_window_days: String(j.cap_window_days) });
    setSteps(j.steps.map((s) => ({ ...s })));
  };

  const save = useMutation({
    mutationFn: () => api('/api/loyalty/journeys', { method: 'POST', body: JSON.stringify({
      ...(editId ? { id: editId } : {}), name: f.name, trigger: f.trigger,
      ...(f.trigger === 'segment' ? { segment_id: Number(f.segment_id) } : {}),
      cap_messages: Number(f.cap_messages) || 0, cap_window_days: Number(f.cap_window_days) || 7,
      steps: steps.map((s) => ({ wait_days: Number(s.wait_days) || 0, channel: s.channel, body: s.body })),
    }) }),
    onSuccess: () => { notifySuccess(editId ? 'แก้ไขเจอร์นีย์แล้ว' : 'สร้างเจอร์นีย์แล้ว'); reset(); qc.invalidateQueries({ queryKey: ['journeys'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const setStatus = useMutation({
    mutationFn: (p: { j: Journey; action: 'activate' | 'pause' }) => api(`/api/loyalty/journeys/${p.j.id}/${p.action}`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['journeys'] }),
    onError: (e: Error) => notifyError(e.message),
  });

  return (
    <div>
      <PageHeader title="เจอร์นีย์ลูกค้า (Journeys)" description="ลำดับข้อความอัตโนมัติหลายขั้น (รอ N วัน → ส่ง) — เคารพ consent, จำกัดความถี่ต่อสมาชิก, แต่ละขั้นส่งครั้งเดียวเท่านั้น" actions={<Link href="/loyalty/segments"><Button variant="outline"><Filter className="size-4" /> เซกเมนต์</Button></Link>} />

      <div className="space-y-6">
        <Card className="gap-4">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Plus className="size-4" /> {editId ? `แก้ไขเจอร์นีย์ #${editId}` : 'สร้างเจอร์นีย์'}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="grid gap-1.5 sm:col-span-2"><Label>ชื่อเจอร์นีย์</Label><Input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="เช่น ต้อนรับสมาชิกใหม่" /></div>
              <div className="grid gap-1.5"><Label>จุดเริ่มต้น</Label><select className={selectCls} value={f.trigger} onChange={(e) => set({ trigger: e.target.value })}><option value="manual">สมัครเอง / Automation</option><option value="segment">เข้าเซกเมนต์</option></select></div>
              {f.trigger === 'segment' && <div className="grid gap-1.5"><Label>เซกเมนต์</Label><select className={selectCls} value={f.segment_id} onChange={(e) => set({ segment_id: e.target.value })}><option value="">— เลือก —</option>{(segs.data?.segments ?? []).map((sg) => <option key={sg.id} value={sg.id}>{sg.name}</option>)}</select></div>}
            </div>
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="grid gap-1.5"><Label>จำกัดความถี่ (ข้อความ, 0=ไม่จำกัด)</Label><Input type="number" min="0" value={f.cap_messages} onChange={(e) => set({ cap_messages: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>ต่อช่วง (วัน)</Label><Input type="number" min="1" value={f.cap_window_days} onChange={(e) => set({ cap_window_days: e.target.value })} /></div>
            </div>
            <div className="space-y-2">
              <Label>ขั้นตอน (ทำงานตามลำดับ)</Label>
              {steps.map((s, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <Badge variant="muted">ขั้น {i + 1}</Badge>
                  <span className="text-sm text-muted-foreground">รอ</span>
                  <Input className="w-20" type="number" min="0" value={s.wait_days} onChange={(e) => setStep(i, { wait_days: Number(e.target.value) })} aria-label={`รอ (วัน) ขั้นที่ ${i + 1}`} />
                  <span className="text-sm text-muted-foreground">วัน แล้วส่ง</span>
                  <select className={selectCls} value={s.channel} onChange={(e) => setStep(i, { channel: e.target.value })} aria-label={`ช่องทาง ขั้นที่ ${i + 1}`}><option value="sms">SMS</option><option value="email">Email</option><option value="line">LINE</option></select>
                  <Input className="min-w-64 flex-1" value={s.body} onChange={(e) => setStep(i, { body: e.target.value })} placeholder="ข้อความ…" aria-label={`ข้อความ ขั้นที่ ${i + 1}`} />
                  {steps.length > 1 && <Button size="sm" variant="ghost" onClick={() => setSteps((ss) => ss.filter((_, ix) => ix !== i))} aria-label={`ลบขั้นที่ ${i + 1}`}><X className="size-3.5" /></Button>}
                </div>
              ))}
              <Button size="sm" variant="outline" onClick={() => setSteps((ss) => [...ss, { wait_days: 7, channel: 'sms', body: '' }])}><Plus className="size-3.5" /> เพิ่มขั้นตอน</Button>
            </div>
            <div className="flex items-center gap-3">
              <Button onClick={() => save.mutate()} disabled={!f.name.trim() || steps.some((s) => !s.body.trim()) || (f.trigger === 'segment' && !f.segment_id) || save.isPending}>{save.isPending ? 'กำลังบันทึก…' : editId ? 'บันทึกการแก้ไข' : 'สร้างเจอร์นีย์'}</Button>
              {editId != null && <Button variant="ghost" onClick={reset}>ยกเลิก</Button>}
              <span className="text-xs text-muted-foreground">แก้ไขได้เฉพาะเจอร์นีย์ที่ยังไม่เปิดใช้งาน/พักอยู่</span>
            </div>
          </CardContent>
        </Card>

        <StateView q={list}>
          {list.data && (
            <DataTable
              rows={list.data.journeys}
              rowKey={(j) => j.id}
              emptyState={{ icon: Route, title: 'ยังไม่มีเจอร์นีย์', description: 'สร้างลำดับข้อความอัตโนมัติแรก เช่น ซีรีส์ต้อนรับสมาชิกใหม่ หรือ win-back ลูกค้าห่างหาย' }}
              columns={[
                { key: 'code', label: 'รหัส', render: (j) => <span className="font-mono text-xs">{j.code}</span> },
                { key: 'name', label: 'ชื่อ', render: (j) => <span className="inline-flex items-center gap-1.5"><Route className="size-3.5 text-muted-foreground" />{j.name}</span> },
                { key: 'trigger', label: 'จุดเริ่ม', render: (j) => <Badge variant="info">{j.trigger === 'segment' ? `เซกเมนต์:${segs.data?.segments.find((sg) => sg.id === j.segment_id)?.name ?? j.segment_id}` : 'manual'}</Badge> },
                { key: 'steps', label: 'ขั้นตอน', render: (j) => <span className="text-xs text-muted-foreground">{j.steps.map((s) => `รอ${s.wait_days}ว.→${s.channel}`).join(' · ')}</span> },
                { key: 'funnel', label: 'สมาชิก (กำลังเดิน/จบ)', render: (j) => <span className="tabular inline-flex items-center gap-1 text-xs"><Users className="size-3.5 text-muted-foreground" />{num(j.funnel.active)}/{num(j.funnel.completed)}</span> },
                { key: 'status', label: 'สถานะ', render: (j) => <Badge variant={tone[j.status] ?? 'muted'}>{j.status}</Badge> },
                { key: 'act', label: '', align: 'right', render: (j) => (
                  <div className="flex justify-end gap-1">
                    {j.status !== 'active'
                      ? <Button size="sm" variant="outline" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ j, action: 'activate' })}><Play className="size-3.5" /> เปิดใช้</Button>
                      : <Button size="sm" variant="outline" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ j, action: 'pause' })}><Pause className="size-3.5" /> พัก</Button>}
                    <Button size="sm" variant="ghost" disabled={j.status === 'active'} onClick={() => loadForEdit(j)} aria-label={`แก้ไข ${j.name}`}><Pencil className="size-3.5" /></Button>
                  </div>
                ) },
              ]}
            />
          )}
        </StateView>
      </div>
    </div>
  );
}
