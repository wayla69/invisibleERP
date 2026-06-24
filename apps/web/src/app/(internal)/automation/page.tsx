'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Workflow, Plus, Trash2, Play, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Msg } from '@/components/tabs';

type EventDef = { key: string; label: string; label_en: string; fields: string[] };
type Catalog = { events: EventDef[]; action_types: string[]; operators: string[] };
type Rule = { id: number; name: string; event_type: string; condition: any; action: any; active: boolean };
type Exec = { id: number; rule_id: number | null; event_type: string; status: string; detail: string; fired_at: string };

const sel = 'h-9 rounded-md border bg-transparent px-3 text-sm';

export default function AutomationPage() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState('');
  const [f, setF] = useState({ name: '', event_type: 'alert.fired', condField: '', condOp: 'eq', condValue: '', actionType: 'notification', message: '', to: '', channel: 'email' });
  const [test, setTest] = useState({ event: 'alert.fired', payload: '{ "severity": "critical" }' });

  const cat = useQuery<Catalog>({ queryKey: ['automation-events'], queryFn: () => api('/api/automation/events') });
  const rules = useQuery<{ rules: Rule[] }>({ queryKey: ['automation-rules'], queryFn: () => api('/api/automation/rules') });
  const execs = useQuery<{ executions: Exec[] }>({ queryKey: ['automation-execs'], queryFn: () => api('/api/automation/executions') });

  const buildBody = () => ({
    name: f.name,
    event_type: f.event_type,
    condition: f.condField ? { field: f.condField, op: f.condOp, value: f.condValue } : null,
    action: f.actionType === 'message'
      ? { type: 'message', to: f.to, channel: f.channel, message: f.message }
      : f.actionType === 'notification'
        ? { type: 'notification', message: f.message }
        : { type: 'log' },
  });

  const create = useMutation({
    mutationFn: () => api('/api/automation/rules', { method: 'POST', body: JSON.stringify(buildBody()) }),
    onSuccess: () => { setMsg('✅ สร้างกฎอัตโนมัติแล้ว'); setF({ ...f, name: '', condField: '', condValue: '', message: '' }); qc.invalidateQueries({ queryKey: ['automation-rules'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const del = useMutation({
    mutationFn: (id: number) => api(`/api/automation/rules/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setMsg('🗑️ ลบกฎแล้ว'); qc.invalidateQueries({ queryKey: ['automation-rules'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const runTest = useMutation({
    mutationFn: () => api('/api/automation/run-event', { method: 'POST', body: JSON.stringify({ event: test.event, payload: JSON.parse(test.payload || '{}') }) }),
    onSuccess: (r: any) => { setMsg(`✅ ทดสอบแล้ว: เข้าเงื่อนไข ${r.matched} ทำงาน ${r.executed}`); qc.invalidateQueries({ queryKey: ['automation-execs'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  return (
    <div>
      <PageHeader title="ระบบอัตโนมัติ (Automation)" description="ตั้งกฎ “เมื่อเกิดเหตุการณ์ + เงื่อนไข ให้ทำการกระทำ” แบบไม่ต้องเขียนโค้ด — แจ้งเตือน/ส่งข้อความ (ไม่ลงบัญชีแยกประเภท)" />
      {msg && <div className="mb-3"><Msg ok={msg.startsWith('✅') || msg.startsWith('🗑️')}>{msg}</Msg></div>}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Plus className="size-4 text-primary" /> กฎใหม่</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-2"><Label>ชื่อกฎ</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="เช่น แจ้ง CFO เมื่อ PO ใหญ่" /></div>
            <div className="grid gap-2">
              <Label>เมื่อเกิดเหตุการณ์ (event)</Label>
              <select className={sel} value={f.event_type} onChange={(e) => setF({ ...f, event_type: e.target.value })}>
                {(cat.data?.events ?? []).map((e) => <option key={e.key} value={e.key}>{e.label} ({e.key})</option>)}
              </select>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="grid gap-1"><Label className="text-xs">เงื่อนไข: ฟิลด์</Label><Input value={f.condField} onChange={(e) => setF({ ...f, condField: e.target.value })} placeholder="severity (ว่าง=เสมอ)" /></div>
              <div className="grid gap-1"><Label className="text-xs">ตัวดำเนินการ</Label><select className={sel} value={f.condOp} onChange={(e) => setF({ ...f, condOp: e.target.value })}>{(cat.data?.operators ?? ['eq']).map((o) => <option key={o} value={o}>{o}</option>)}</select></div>
              <div className="grid gap-1"><Label className="text-xs">ค่า</Label><Input value={f.condValue} onChange={(e) => setF({ ...f, condValue: e.target.value })} placeholder="critical" /></div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-1"><Label>การกระทำ</Label><select className={sel} value={f.actionType} onChange={(e) => setF({ ...f, actionType: e.target.value })}>{(cat.data?.action_types ?? ['notification']).map((a) => <option key={a} value={a}>{a}</option>)}</select></div>
              <div className="grid gap-1"><Label>ข้อความ</Label><Input value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} placeholder="ข้อความแจ้งเตือน" /></div>
              {f.actionType === 'message' && <>
                <div className="grid gap-1"><Label>ส่งถึง (to)</Label><Input value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} placeholder="email/line/เบอร์" /></div>
                <div className="grid gap-1"><Label>ช่องทาง</Label><select className={sel} value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>{['email', 'line', 'sms'].map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
              </>}
            </div>
            <Button disabled={!f.name.trim() || create.isPending} onClick={() => { setMsg(''); create.mutate(); }}>{create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} สร้างกฎ</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Play className="size-4 text-primary" /> ทดสอบกฎ (จำลองเหตุการณ์)</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-2"><Label>เหตุการณ์</Label><select className={sel} value={test.event} onChange={(e) => setTest({ ...test, event: e.target.value })}>{(cat.data?.events ?? []).map((e) => <option key={e.key} value={e.key}>{e.key}</option>)}</select></div>
            <div className="grid gap-2"><Label>payload (JSON)</Label><textarea rows={3} className="rounded-md border bg-transparent px-3 py-2 text-sm font-mono" value={test.payload} onChange={(e) => setTest({ ...test, payload: e.target.value })} /></div>
            <Button variant="outline" disabled={runTest.isPending} onClick={() => { setMsg(''); runTest.mutate(); }}><Play className="size-4" /> รันทดสอบ</Button>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Workflow className="size-4 text-primary" /> กฎที่ตั้งไว้</CardTitle></CardHeader>
        <CardContent>
          <StateView q={rules}>
            {(rules.data?.rules ?? []).length === 0 ? <p className="text-sm text-muted-foreground">ยังไม่มีกฎ</p> : (
              <div className="grid gap-2">
                {(rules.data?.rules ?? []).map((r) => (
                  <div key={r.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                    <div><b>{r.name}</b> <Badge variant="secondary" className="ml-1">{r.event_type}</Badge> {r.condition?.field && <span className="text-xs text-muted-foreground">· if {r.condition.field} {r.condition.op} {String(r.condition.value)}</span>} <span className="text-xs text-muted-foreground">→ {r.action?.type}</span></div>
                    <Button size="sm" variant="ghost" onClick={() => del.mutate(r.id)}><Trash2 className="size-4 text-destructive" /></Button>
                  </div>
                ))}
              </div>
            )}
          </StateView>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">ประวัติการทำงาน (Executions)</CardTitle></CardHeader>
        <CardContent>
          <StateView q={execs}>
            <div className="grid gap-1 text-sm">
              {(execs.data?.executions ?? []).slice(0, 30).map((e) => (
                <div key={e.id} className="flex items-center gap-2"><Badge variant={e.status === 'executed' ? 'success' : e.status === 'failed' ? 'destructive' : 'secondary'}>{e.status}</Badge><span className="text-muted-foreground">{e.event_type}</span><span>{e.detail}</span></div>
              ))}
              {(execs.data?.executions ?? []).length === 0 && <p className="text-muted-foreground">ยังไม่มีการทำงาน</p>}
            </div>
          </StateView>
        </CardContent>
      </Card>
    </div>
  );
}
