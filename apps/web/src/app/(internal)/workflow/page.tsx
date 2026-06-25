'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ListChecks, Workflow, X, Plus, Trash2, AlarmClock } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs, Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Approval { instance_id: number; doc_type: string; doc_no: string; amount: number; current_step: number; created_by: string; on_behalf_of: string | null; due_at: string | null; overdue: boolean; escalated: boolean }
interface Step { step_no: number; approver_role: string | null; approver_user: string | null; min_amount: number; all_of_n: number; sla_hours: number | null; escalate_to_role: string | null; escalate_to_user: string | null; match_key: string | null; match_value: string | null }
interface Definition { id: number; doc_type: string; name: string; sla_hours: number | null; active: boolean; steps: Step[] }

export default function WorkflowPage() {
  return (
    <div>
      <PageHeader title="อนุมัติงาน (Workflow)" description="กล่องงานรออนุมัติ และผังขั้นตอนอนุมัติ — เกณฑ์ตามมูลค่า/มิติ, หลายชั้น, มอบหมายแทน, SLA + การเร่งรัด · ผู้สร้างอนุมัติเองไม่ได้" />
      <Tabs tabs={[
        { key: 'inbox', label: 'รออนุมัติของฉัน', content: <MyApprovals /> },
        { key: 'defs', label: 'ผังการอนุมัติ', content: <Definitions /> },
      ]} />
    </div>
  );
}

function MyApprovals() {
  const qc = useQueryClient();
  const q = useQuery<{ items: Approval[] }>({ queryKey: ['wf-my-approvals'], queryFn: () => api('/api/workflow/my-approvals') });
  const [msg, setMsg] = useState('');
  const act = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: 'approve' | 'reject' }) => api(`/api/workflow/instances/${id}/act`, { method: 'POST', body: JSON.stringify({ decision }) }),
    onSuccess: (r: any) => { setMsg(`✅ ดำเนินการสำเร็จ — สถานะ: ${r.status}`); qc.invalidateQueries({ queryKey: ['wf-my-approvals'] }); },
    onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });
  const sweep = useMutation({
    mutationFn: () => api('/api/workflow/run-escalations', { method: 'POST' }),
    onSuccess: (r: any) => { setMsg(`✅ ตรวจสอบงานเกินกำหนด: เร่งรัด ${r.escalated} · แจ้งเตือน ${r.reminded}`); qc.invalidateQueries({ queryKey: ['wf-my-approvals'] }); },
    onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });
  const items = q.data?.items ?? [];
  const totalValue = items.reduce((s, i) => s + i.amount, 0);
  const overdue = items.filter((i) => i.overdue).length;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label="รออนุมัติ" value={num(items.length)} icon={ListChecks} tone={items.length > 0 ? 'warning' : 'success'} hint="รายการที่คุณดำเนินการได้" />
        <StatCard label="มูลค่ารวม" value={baht(totalValue)} icon={Workflow} tone="primary" />
        <StatCard label="เกินกำหนด (SLA)" value={num(overdue)} icon={AlarmClock} tone={overdue > 0 ? 'danger' : 'default'} />
      </div>
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" disabled={sweep.isPending} onClick={() => sweep.mutate()}><AlarmClock className="mr-1 size-4" />ตรวจสอบงานเกินกำหนด</Button>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </div>
      <StateView q={q}>
        <DataTable
          rows={items}
          rowKey={(r) => r.instance_id}
          columns={[
            { key: 'doc_type', label: 'ประเภท', render: (r) => <Badge variant="info">{r.doc_type}</Badge> },
            { key: 'doc_no', label: 'เลขที่เอกสาร', render: (r) => <span>{r.doc_no}{r.overdue && <Badge variant="destructive" className="ml-2 text-[10px]">เกินกำหนด</Badge>}{r.escalated && <Badge variant="warning" className="ml-1 text-[10px]">เร่งรัด</Badge>}</span> },
            { key: 'amount', label: 'มูลค่า', align: 'right', render: (r) => <span className="tabular">{baht(r.amount)}</span> },
            { key: 'current_step', label: 'ขั้นที่', align: 'right', render: (r) => num(r.current_step) },
            { key: 'created_by', label: 'ผู้สร้าง' },
            { key: 'on_behalf_of', label: 'แทน', render: (r) => r.on_behalf_of ?? '—' },
            { key: 'actions', label: '', sortable: false, align: 'right', render: (r) => (
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" disabled={act.isPending} onClick={() => act.mutate({ id: r.instance_id, decision: 'approve' })}><Check className="size-3.5" /> อนุมัติ</Button>
                <Button variant="destructive" size="sm" disabled={act.isPending} onClick={() => act.mutate({ id: r.instance_id, decision: 'reject' })}><X className="size-3.5" /> ปฏิเสธ</Button>
              </div>
            ) },
          ]}
          emptyText="ไม่มีรายการรออนุมัติ"
        />
      </StateView>
    </div>
  );
}

type DraftStep = { approver_kind: 'role' | 'user'; approver: string; min_amount: string; all_of_n: string; sla_hours: string; escalate_to_role: string; match_key: string; match_value: string };
const emptyStep = (): DraftStep => ({ approver_kind: 'role', approver: '', min_amount: '0', all_of_n: '1', sla_hours: '', escalate_to_role: '', match_key: '', match_value: '' });

function Definitions() {
  const qc = useQueryClient();
  const q = useQuery<{ definitions: Definition[] }>({ queryKey: ['wf-definitions'], queryFn: () => api('/api/workflow/definitions') });
  const [docType, setDocType] = useState('PR'); const [name, setName] = useState(''); const [sla, setSla] = useState(''); const [steps, setSteps] = useState<DraftStep[]>([emptyStep()]); const [msg, setMsg] = useState('');
  const create = useMutation({
    mutationFn: () => api('/api/workflow/definitions', { method: 'POST', body: JSON.stringify({
      doc_type: docType, name, sla_hours: sla ? Number(sla) : undefined,
      steps: steps.map((s, i) => ({
        step_no: i + 1, min_amount: Number(s.min_amount) || 0, all_of_n: Number(s.all_of_n) || 1,
        ...(s.approver_kind === 'role' ? { approver_role: s.approver } : { approver_user: s.approver }),
        ...(s.sla_hours ? { sla_hours: Number(s.sla_hours) } : {}),
        ...(s.escalate_to_role ? { escalate_to_role: s.escalate_to_role } : {}),
        ...(s.match_key && s.match_value ? { match_key: s.match_key, match_value: s.match_value } : {}),
      })),
    }) }),
    onSuccess: () => { setMsg(`✅ สร้างผัง ${name}`); setName(''); setSla(''); setSteps([emptyStep()]); qc.invalidateQueries({ queryKey: ['wf-definitions'] }); },
    onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });
  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) => api(`/api/workflow/definitions/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wf-definitions'] }),
  });
  const setStep = (i: number, patch: Partial<DraftStep>) => setSteps((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const defs = q.data?.definitions ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Workflow className="h-4 w-4" />สร้างผังการอนุมัติ (no-code)</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div><Label>ประเภทเอกสาร</Label>
              <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={docType} onChange={(e) => setDocType(e.target.value)}>
                {['PR', 'PO', 'AP_PAY', 'JE', 'BUDGET', 'EXPENSE'].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div><Label>ชื่อผัง</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น อนุมัติ PR" /></div>
            <div><Label>SLA เริ่มต้น (ชม.)</Label><Input value={sla} onChange={(e) => setSla(e.target.value)} placeholder="24" /></div>
          </div>
          <div className="space-y-3">
            {steps.map((s, i) => (
              <div key={i} className="rounded-md border p-3">
                <div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold">ขั้นที่ {i + 1}</span>{steps.length > 1 && <Button size="sm" variant="ghost" onClick={() => setSteps((ss) => ss.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>}</div>
                <div className="grid gap-2 sm:grid-cols-4">
                  <div><Label className="text-xs">ผู้อนุมัติ</Label>
                    <div className="flex gap-1">
                      <select className="h-9 rounded-md border bg-background px-1 text-xs" value={s.approver_kind} onChange={(e) => setStep(i, { approver_kind: e.target.value as 'role' | 'user' })}><option value="role">บทบาท</option><option value="user">ผู้ใช้</option></select>
                      <Input className="h-9" value={s.approver} onChange={(e) => setStep(i, { approver: e.target.value })} placeholder={s.approver_kind === 'role' ? 'Procurement' : 'username'} />
                    </div>
                  </div>
                  <div><Label className="text-xs">มูลค่าขั้นต่ำ</Label><Input value={s.min_amount} onChange={(e) => setStep(i, { min_amount: e.target.value })} /></div>
                  <div><Label className="text-xs">ต้องอนุมัติ (คน)</Label><Input value={s.all_of_n} onChange={(e) => setStep(i, { all_of_n: e.target.value })} /></div>
                  <div><Label className="text-xs">SLA (ชม.)</Label><Input value={s.sla_hours} onChange={(e) => setStep(i, { sla_hours: e.target.value })} placeholder="ใช้ค่าผัง" /></div>
                  <div><Label className="text-xs">เร่งรัดไปยังบทบาท</Label><Input value={s.escalate_to_role} onChange={(e) => setStep(i, { escalate_to_role: e.target.value })} placeholder="เช่น Planner" /></div>
                  <div><Label className="text-xs">เงื่อนไขมิติ: key</Label><Input value={s.match_key} onChange={(e) => setStep(i, { match_key: e.target.value })} placeholder="cost_center" /></div>
                  <div><Label className="text-xs">เงื่อนไขมิติ: value</Label><Input value={s.match_value} onChange={(e) => setStep(i, { match_value: e.target.value })} placeholder="IT" /></div>
                </div>
              </div>
            ))}
            <Button size="sm" variant="outline" onClick={() => setSteps((ss) => [...ss, emptyStep()])}><Plus className="mr-1 h-4 w-4" />เพิ่มขั้น</Button>
          </div>
          <div className="flex items-center gap-3">
            <Button disabled={!name || steps.some((s) => !s.approver) || create.isPending} onClick={() => create.mutate()}>บันทึกผัง</Button>
            <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
          </div>
        </CardContent>
      </Card>

      <StateView q={q}>
        <div className="grid gap-4">
          {defs.length === 0 && <DataTable rows={[]} columns={[{ key: 'x', label: 'ผังการอนุมัติ' }]} emptyText="ยังไม่มีผังการอนุมัติ — เอกสารจะถูกอนุมัติอัตโนมัติ" />}
          {defs.map((d) => (
            <div key={d.id}>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">{d.name} <span className="text-muted-foreground">· {d.doc_type}{d.sla_hours ? ` · SLA ${d.sla_hours}ชม.` : ''}</span></h3>
                <Badge variant={d.active ? 'success' : 'muted'}>{d.active ? 'ใช้งาน' : 'ปิด'}</Badge>
                <Button size="sm" variant="ghost" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: d.id, active: !d.active })}>{d.active ? 'ปิด' : 'เปิด'}</Button>
              </div>
              <DataTable
                rows={d.steps}
                rowKey={(s) => `${d.id}-${s.step_no}`}
                columns={[
                  { key: 'step_no', label: 'ขั้น', align: 'right', render: (s) => num(s.step_no) },
                  { key: 'approver', label: 'ผู้อนุมัติ', render: (s) => s.approver_role ?? s.approver_user ?? '—' },
                  { key: 'min_amount', label: 'มูลค่าขั้นต่ำ', align: 'right', render: (s) => <span className="tabular">{baht(s.min_amount)}</span> },
                  { key: 'dimension', label: 'เงื่อนไขมิติ', render: (s) => s.match_key ? `${s.match_key}=${s.match_value}` : '—' },
                  { key: 'all_of_n', label: 'คน', align: 'right', render: (s) => num(s.all_of_n) },
                  { key: 'sla', label: 'SLA', align: 'right', render: (s) => s.sla_hours ? `${s.sla_hours}ชม.` : '—' },
                  { key: 'escalate', label: 'เร่งรัดไปยัง', render: (s) => s.escalate_to_role ?? s.escalate_to_user ?? '—' },
                ]}
                emptyText="ไม่มีขั้นตอน"
              />
            </div>
          ))}
        </div>
      </StateView>
    </div>
  );
}
