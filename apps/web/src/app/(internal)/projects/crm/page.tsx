'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Handshake, Plus, UserCheck, ArrowRightLeft, XCircle, Target, TrendingUp, FolderPlus, BarChart3 } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

const selectCls = 'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';
const STAGES = ['prospecting', 'qualification', 'proposal', 'negotiation', 'won', 'lost'] as const;
const stageBadge = (s: string) => <Badge variant={s === 'won' ? 'success' : s === 'lost' ? 'destructive' : 'secondary'}>{s}</Badge>;
const leadBadge = (s: string) => <Badge variant={s === 'converted' ? 'success' : s === 'lost' ? 'destructive' : s === 'qualified' ? 'info' : 'muted'}>{s}</Badge>;

// CRM sales pipeline management (REV-17) — leads → opportunities → convert a won deal into a project (CRM-WL).
export default function ProjectCrmPage() {
  const router = useRouter();
  return (
    <div>
      <PageHeader
        title="ลีด & โอกาสการขาย (CRM Pipeline)"
        description="จัดการลีด → คัดกรอง → แปลงเป็นโอกาสการขาย → เลื่อนขั้น → ชนะแล้วแปลงเป็นโครงการ (CRM-WL)"
        actions={<Button variant="outline" onClick={() => router.push('/projects/pipeline')}><BarChart3 className="size-4" /> Win/Loss</Button>}
      />
      <Tabs tabs={[
        { key: 'opps', label: 'โอกาสการขาย', content: <Opportunities /> },
        { key: 'leads', label: 'ลีด (Leads)', content: <Leads /> },
      ]} />
    </div>
  );
}

function Leads() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['crm-leads'], queryFn: () => api('/api/crm/pipeline/leads') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['crm-leads'] });
  const [f, setF] = useState({ name: '', company: '', email: '', phone: '', source: '' });
  const create = useMutation({
    mutationFn: () => api('/api/crm/pipeline/leads', { method: 'POST', body: JSON.stringify({ name: f.name, company: f.company || undefined, email: f.email || undefined, phone: f.phone || undefined, source: f.source || undefined }) }),
    onSuccess: () => { notifySuccess('เพิ่มลีดแล้ว'); setF({ name: '', company: '', email: '', phone: '', source: '' }); refresh(); }, onError: (e: any) => notifyError(e.message),
  });
  const qualify = useMutation({ mutationFn: (no: string) => api(`/api/crm/pipeline/leads/${no}/qualify`, { method: 'POST', body: '{}' }), onSuccess: () => { notifySuccess('คัดกรองผ่าน'); refresh(); }, onError: (e: any) => notifyError(e.message) });
  const lose = useMutation({ mutationFn: (no: string) => api(`/api/crm/pipeline/leads/${no}/lose`, { method: 'POST', body: JSON.stringify({ reason: 'ไม่สนใจ' }) }), onSuccess: () => { notifySuccess('ปิดลีด (เสีย)'); refresh(); }, onError: (e: any) => notifyError(e.message) });

  const [conv, setConv] = useState<null | { lead_no: string; name: string }>(null);
  const [cf, setCf] = useState({ opportunity_name: '', amount: '', expected_close_date: '' });
  const convert = useMutation({
    mutationFn: () => api<any>(`/api/crm/pipeline/leads/${conv!.lead_no}/convert`, { method: 'POST', body: JSON.stringify({ opportunity_name: cf.opportunity_name || undefined, amount: Number(cf.amount) || undefined, expected_close_date: cf.expected_close_date || undefined }) }),
    onSuccess: (r: any) => { notifySuccess(`แปลงลีดเป็นโอกาสการขาย ${r.opp_no}`); setConv(null); setCf({ opportunity_name: '', amount: '', expected_close_date: '' }); refresh(); qc.invalidateQueries({ queryKey: ['crm-opps'] }); }, onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">เพิ่มลีด</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="grid gap-1.5"><Label>ชื่อผู้ติดต่อ</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>บริษัท</Label><Input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>ที่มา</Label><Input value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} placeholder="เว็บไซต์ / งานแสดง / แนะนำ" /></div>
          <div className="grid gap-1.5"><Label>อีเมล</Label><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>โทร</Label><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
        </div>
        <div><Button onClick={() => create.mutate()} disabled={!f.name || create.isPending}><Plus className="size-4" /> เพิ่มลีด</Button></div>
      </Card>
      <StateView q={q}>{q.data && (
        <DataTable
          rows={q.data.leads ?? []}
          rowKey={(r: any) => r.lead_no}
          columns={[
            { key: 'lead_no', label: 'เลขที่' },
            { key: 'name', label: 'ผู้ติดต่อ', render: (r: any) => `${r.name}${r.company ? ` · ${r.company}` : ''}` },
            { key: 'source', label: 'ที่มา', render: (r: any) => r.source ?? '—' },
            { key: 'owner', label: 'ผู้ดูแล', render: (r: any) => r.owner ?? '—' },
            { key: 'status', label: 'สถานะ', render: (r: any) => leadBadge(r.status) },
            { key: 'act', label: '', sortable: false, render: (r: any) => (
              <div className="flex justify-end gap-1">
                {r.status === 'new' && <Button size="sm" variant="ghost" title="คัดกรองผ่าน" onClick={() => qualify.mutate(r.lead_no)}><UserCheck className="size-4" /></Button>}
                {(r.status === 'new' || r.status === 'qualified') && <Button size="sm" variant="ghost" title="แปลงเป็นโอกาสการขาย" onClick={() => { setConv({ lead_no: r.lead_no, name: r.company || r.name }); setCf({ opportunity_name: `${r.company || r.name} opportunity`, amount: '', expected_close_date: '' }); }}><ArrowRightLeft className="size-4" /></Button>}
                {(r.status === 'new' || r.status === 'qualified') && <Button size="sm" variant="ghost" title="ปิด (เสีย)" onClick={() => lose.mutate(r.lead_no)}><XCircle className="size-4" /></Button>}
              </div>
            ) },
          ]}
          emptyState={{ icon: Handshake, title: 'ยังไม่มีลีด', description: 'เพิ่มลีดจากแบบฟอร์มด้านบนเพื่อเริ่มไปป์ไลน์การขาย' }}
        />
      )}</StateView>

      <Dialog open={!!conv} onOpenChange={(o) => !o && setConv(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>แปลงลีดเป็นโอกาสการขาย — {conv?.name}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5"><Label>ชื่อโอกาสการขาย</Label><Input value={cf.opportunity_name} onChange={(e) => setCf({ ...cf, opportunity_name: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>มูลค่าโดยประมาณ</Label><Input type="number" min="0" value={cf.amount} onChange={(e) => setCf({ ...cf, amount: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>คาดปิดการขาย</Label><Input type="date" value={cf.expected_close_date} onChange={(e) => setCf({ ...cf, expected_close_date: e.target.value })} /></div>
            </div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setConv(null)}>ปิด</Button><Button onClick={() => convert.mutate()} disabled={convert.isPending}>แปลง</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Opportunities() {
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['crm-opps'], queryFn: () => api('/api/crm/pipeline/opportunities') });
  const sumQ = useQuery<any>({ queryKey: ['crm-summary'], queryFn: () => api('/api/crm/pipeline/summary') });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['crm-opps'] }); qc.invalidateQueries({ queryKey: ['crm-summary'] }); };
  const [f, setF] = useState({ name: '', amount: '', probability: '10', expected_close_date: '' });
  const create = useMutation({
    mutationFn: () => api('/api/crm/pipeline/opportunities', { method: 'POST', body: JSON.stringify({ name: f.name, amount: Number(f.amount) || undefined, probability: Number(f.probability) || undefined, expected_close_date: f.expected_close_date || undefined }) }),
    onSuccess: () => { notifySuccess('เพิ่มโอกาสการขาย'); setF({ name: '', amount: '', probability: '10', expected_close_date: '' }); refresh(); }, onError: (e: any) => notifyError(e.message),
  });
  const setStage = useMutation({
    mutationFn: (v: { oppNo: string; stage: string }) => api(`/api/crm/pipeline/opportunities/${v.oppNo}/stage`, { method: 'PATCH', body: JSON.stringify({ stage: v.stage, lost_reason: v.stage === 'lost' ? 'แพ้คู่แข่ง' : undefined }) }),
    onSuccess: () => { notifySuccess('อัปเดตขั้นตอนแล้ว'); refresh(); }, onError: (e: any) => notifyError(e.message),
  });

  // Convert a WON opportunity into a project (CRM-WL) via /api/projects/from-opportunity/:oppNo.
  const [conv, setConv] = useState<null | { opp_no: string; name: string; amount: number }>(null);
  const [pf, setPf] = useState({ project_code: '', billing_type: 'Fixed', budget_amount: '', start_date: '', end_date: '' });
  const convert = useMutation({
    mutationFn: () => api<any>(`/api/projects/from-opportunity/${conv!.opp_no}`, { method: 'POST', body: JSON.stringify({ project_code: pf.project_code || undefined, billing_type: pf.billing_type, budget_amount: Number(pf.budget_amount) || undefined, start_date: pf.start_date || undefined, end_date: pf.end_date || undefined }) }),
    onSuccess: (r: any) => { notifySuccess(r?.already ? `โอกาสนี้แปลงเป็นโครงการแล้ว (${r.project_code})` : `สร้างโครงการ ${r.project_code}`); setConv(null); router.push(`/projects/${encodeURIComponent(r.project_code)}`); }, onError: (e: any) => notifyError(e.message),
  });

  const s = sumQ.data;
  return (
    <div className="grid gap-5">
      {s && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="มูลค่าเปิดอยู่ (Open)" value={baht(s.open_amount)} icon={Target} tone="primary" />
          <StatCard label="พยากรณ์ถ่วงน้ำหนัก" value={baht(s.weighted_forecast)} icon={TrendingUp} tone="info" hint="Σ มูลค่า × ความน่าจะเป็น" />
          <StatCard label="ชนะแล้ว" value={baht(s.won_amount)} icon={TrendingUp} tone="success" />
          <StatCard label="อัตราชนะ" value={`${Math.round((s.win_rate ?? 0) * 100)}%`} icon={BarChart3} tone="default" />
        </div>
      )}
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">เพิ่มโอกาสการขาย</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="grid gap-1.5"><Label>ชื่อดีล</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>มูลค่า</Label><Input type="number" min="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>ความน่าจะเป็น (%)</Label><Input type="number" min="0" max="100" value={f.probability} onChange={(e) => setF({ ...f, probability: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>คาดปิดการขาย</Label><Input type="date" value={f.expected_close_date} onChange={(e) => setF({ ...f, expected_close_date: e.target.value })} /></div>
        </div>
        <div><Button onClick={() => create.mutate()} disabled={!f.name || create.isPending}><Plus className="size-4" /> เพิ่ม</Button></div>
      </Card>
      <StateView q={q}>{q.data && (
        <DataTable
          rows={q.data.opportunities ?? []}
          rowKey={(r: any) => r.opp_no}
          columns={[
            { key: 'opp_no', label: 'เลขที่' },
            { key: 'name', label: 'ดีล' },
            { key: 'amount', label: 'มูลค่า', align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
            { key: 'probability', label: 'โอกาส', align: 'right', render: (r: any) => `${r.probability}%` },
            { key: 'weighted', label: 'ถ่วงน้ำหนัก', align: 'right', render: (r: any) => <span className="tabular">{baht(r.weighted)}</span> },
            { key: 'expected_close_date', label: 'คาดปิด', render: (r: any) => r.expected_close_date ?? '—' },
            { key: 'stage', label: 'ขั้นตอน', sortable: false, render: (r: any) => (r.stage === 'won' || r.stage === 'lost') ? stageBadge(r.stage) : (
              <select className={`${selectCls} w-36`} value={r.stage} onChange={(e) => setStage.mutate({ oppNo: r.opp_no, stage: e.target.value })}>
                {STAGES.map((st) => <option key={st} value={st}>{st}</option>)}
              </select>
            ) },
            { key: 'act', label: '', sortable: false, render: (r: any) => r.stage === 'won'
              ? <Button size="sm" variant="outline" title="แปลงเป็นโครงการ" onClick={() => { setConv({ opp_no: r.opp_no, name: r.name, amount: r.amount }); setPf({ project_code: '', billing_type: 'Fixed', budget_amount: '', start_date: '', end_date: '' }); }}><FolderPlus className="size-4" /> เป็นโครงการ</Button>
              : <span className="text-xs text-muted-foreground">—</span> },
          ]}
          emptyState={{ icon: Target, title: 'ยังไม่มีโอกาสการขาย', description: 'เพิ่มโอกาสการขายหรือแปลงจากลีด — ชนะแล้วแปลงเป็นโครงการได้ทันที' }}
        />
      )}</StateView>

      <Dialog open={!!conv} onOpenChange={(o) => !o && setConv(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>แปลงโอกาสเป็นโครงการ — {conv?.name}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">มูลค่าสัญญาจะตั้งจากมูลค่าดีล {baht(conv?.amount ?? 0)} โดยอัตโนมัติ</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>รหัสโครงการ (ถ้าเว้นว่างจะสร้างให้)</Label><Input value={pf.project_code} onChange={(e) => setPf({ ...pf, project_code: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>รูปแบบ</Label>
                <select className={selectCls} value={pf.billing_type} onChange={(e) => setPf({ ...pf, billing_type: e.target.value })}>
                  <option value="Fixed">เหมารวม (Fixed)</option><option value="TM">ตามเวลา/วัสดุ (T&M)</option>
                </select>
              </div>
              <div className="grid gap-1.5"><Label>งบประมาณ</Label><Input type="number" min="0" value={pf.budget_amount} onChange={(e) => setPf({ ...pf, budget_amount: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>เริ่ม</Label><Input type="date" value={pf.start_date} onChange={(e) => setPf({ ...pf, start_date: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>เสร็จ</Label><Input type="date" value={pf.end_date} onChange={(e) => setPf({ ...pf, end_date: e.target.value })} /></div>
            </div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setConv(null)}>ปิด</Button><Button onClick={() => convert.mutate()} disabled={convert.isPending}>สร้างโครงการ</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
