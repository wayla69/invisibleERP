'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ResponsiveContainer, ComposedChart, Area, ReferenceLine, CartesianGrid, XAxis, YAxis, Tooltip } from 'recharts';
import { ArrowLeft, Plus, Clock, Receipt, Flag, Users, GanttChartSquare, Activity, CheckCircle2, TrendingUp } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { ProjectGantt, type GanttTask } from '@/components/project-gantt';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

const selectCls = 'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

// CPI/SPI health: ≥1 on/under target (green), 0.9–1 watch (amber), <0.9 at risk (red).
function indexTone(v: number | null): 'success' | 'warning' | 'danger' | 'default' {
  if (v == null) return 'default';
  if (v >= 1) return 'success';
  if (v >= 0.9) return 'warning';
  return 'danger';
}
const pct = (v: unknown) => `${Math.round((Number(v) || 0) * 100) / 100}%`;

export default function ProjectDetailPage() {
  const code = decodeURIComponent(String(useParams().code ?? ''));
  const router = useRouter();
  const qc = useQueryClient();
  const refresh = () => { for (const k of ['detail', 'evm', 'series', 'schedule', 'tasks', 'milestones', 'resources', 'risks']) qc.invalidateQueries({ queryKey: ['proj', code, k] }); };

  const detail = useQuery<any>({ queryKey: ['proj', code, 'detail'], queryFn: () => api(`/api/projects/${code}`) });
  const evm = useQuery<any>({ queryKey: ['proj', code, 'evm'], queryFn: () => api(`/api/projects/${code}/evm`) });
  const series = useQuery<any>({ queryKey: ['proj', code, 'series'], queryFn: () => api(`/api/projects/${code}/evm/series`) });
  const schedule = useQuery<any>({ queryKey: ['proj', code, 'schedule'], queryFn: () => api(`/api/projects/${code}/schedule`) });
  const tasks = useQuery<any>({ queryKey: ['proj', code, 'tasks'], queryFn: () => api(`/api/projects/${code}/tasks`) });
  const milestones = useQuery<any>({ queryKey: ['proj', code, 'milestones'], queryFn: () => api(`/api/projects/${code}/milestones`) });
  const resources = useQuery<any>({ queryKey: ['proj', code, 'resources'], queryFn: () => api(`/api/projects/${code}/resources`) });
  const risks = useQuery<any>({ queryKey: ['proj', code, 'risks'], queryFn: () => api(`/api/projects/${code}/risks`) });

  const p = detail.data;
  const e = evm.data;

  // ── dialogs ──
  const [taskDlg, setTaskDlg] = useState(false);
  const [tf, setTf] = useState({ name: '', planned_hours: '', planned_cost: '', planned_start: '', planned_end: '', pct_complete: '', accountable: '', responsible: '' });
  const splitPeople = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const addTask = useMutation({
    mutationFn: () => api(`/api/projects/${code}/tasks`, { method: 'POST', body: JSON.stringify({ name: tf.name, planned_hours: Number(tf.planned_hours) || 0, planned_cost: Number(tf.planned_cost) || 0, planned_start: tf.planned_start || undefined, planned_end: tf.planned_end || undefined, pct_complete: Number(tf.pct_complete) || 0, accountable: tf.accountable || undefined, responsible: tf.responsible ? splitPeople(tf.responsible) : undefined }) }),
    onSuccess: () => { notifySuccess('เพิ่มงานแล้ว'); setTaskDlg(false); setTf({ name: '', planned_hours: '', planned_cost: '', planned_start: '', planned_end: '', pct_complete: '', accountable: '', responsible: '' }); refresh(); },
    onError: (err: any) => notifyError(err.message),
  });
  const markDone = useMutation({
    mutationFn: (id: number) => api(`/api/projects/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) }),
    onSuccess: () => { notifySuccess('ทำเครื่องหมายเสร็จสิ้น'); refresh(); }, onError: (err: any) => notifyError(err.message),
  });

  const [msDlg, setMsDlg] = useState(false);
  const [mf, setMf] = useState({ name: '', due_date: '', billing_percent: '' });
  const addMs = useMutation({
    mutationFn: () => api(`/api/projects/${code}/milestones`, { method: 'POST', body: JSON.stringify({ name: mf.name, due_date: mf.due_date || undefined, billing_percent: Number(mf.billing_percent) || undefined }) }),
    onSuccess: () => { notifySuccess('เพิ่มหมุดหมาย'); setMsDlg(false); setMf({ name: '', due_date: '', billing_percent: '' }); refresh(); }, onError: (err: any) => notifyError(err.message),
  });
  const reachMs = useMutation({
    mutationFn: (id: number) => api(`/api/projects/milestones/${id}/reach`, { method: 'POST', body: '{}' }),
    onSuccess: (r: any) => { notifySuccess(r?.billing?.revenue ? `บรรลุหมุดหมาย — วางบิล ${baht(r.billing.revenue)}` : 'บรรลุหมุดหมาย'); refresh(); }, onError: (err: any) => notifyError(err.message),
  });

  const [resDlg, setResDlg] = useState(false);
  const [rf, setRf] = useState({ resource_name: '', role: '', alloc_pct: '100' });
  const addRes = useMutation({
    mutationFn: () => api(`/api/projects/${code}/resources`, { method: 'POST', body: JSON.stringify({ resource_name: rf.resource_name, role: rf.role || undefined, alloc_pct: Number(rf.alloc_pct) || 100 }) }),
    onSuccess: () => { notifySuccess('จัดสรรทรัพยากรแล้ว'); setResDlg(false); setRf({ resource_name: '', role: '', alloc_pct: '100' }); refresh(); }, onError: (err: any) => notifyError(err.message),
  });

  const [riskDlg, setRiskDlg] = useState(false);
  const [kf, setKf] = useState({ kind: 'risk', title: '', probability: '3', impact: '3', owner: '', mitigation: '', due_date: '' });
  const addRisk = useMutation({
    mutationFn: () => api(`/api/projects/${code}/risks`, { method: 'POST', body: JSON.stringify({ kind: kf.kind, title: kf.title, probability: kf.kind === 'risk' ? Number(kf.probability) || 1 : undefined, impact: Number(kf.impact) || 1, owner: kf.owner || undefined, mitigation: kf.mitigation || undefined, due_date: kf.due_date || undefined }) }),
    onSuccess: () => { notifySuccess('บันทึกความเสี่ยง/ปัญหาแล้ว'); setRiskDlg(false); setKf({ kind: 'risk', title: '', probability: '3', impact: '3', owner: '', mitigation: '', due_date: '' }); refresh(); }, onError: (err: any) => notifyError(err.message),
  });
  const patchRisk = useMutation({
    mutationFn: (v: { id: number; body: any }) => api(`/api/projects/risks/${v.id}`, { method: 'PATCH', body: JSON.stringify(v.body) }),
    onSuccess: () => { notifySuccess('อัปเดตแล้ว'); refresh(); }, onError: (err: any) => notifyError(err.message),
  });

  const [costDlg, setCostDlg] = useState<null | 'cost' | 'bill'>(null);
  const [amount, setAmount] = useState(''); const [ctype, setCtype] = useState<'time' | 'expense'>('time'); const [billable, setBillable] = useState(true); const [byPct, setByPct] = useState(false);
  const submitCost = useMutation({
    mutationFn: () => api(`/api/projects/${code}/${costDlg}`, { method: 'POST', body: JSON.stringify(costDlg === 'cost' ? { entry_type: ctype, amount: Number(amount) || 0, billable } : byPct ? { percent: Number(amount) || 0 } : { amount: Number(amount) || 0 }) }),
    onSuccess: () => { notifySuccess(costDlg === 'cost' ? 'บันทึกต้นทุน' : 'วางบิลแล้ว'); setCostDlg(null); setAmount(''); refresh(); }, onError: (err: any) => notifyError(err.message),
  });
  // POC over-time revenue recognition (PROJ-09) — recognise earned revenue cost-to-cost.
  const recognize = useMutation({
    mutationFn: () => api<any>(`/api/projects/${code}/recognize`, { method: 'POST', body: '{}' }),
    onSuccess: (r: any) => { notifySuccess(r?.already ? 'ไม่มีรายได้ใหม่ให้รับรู้' : `รับรู้รายได้ ${baht(r.revenue_recognized)} (สำเร็จ ${r.poc_pct}%)`); refresh(); }, onError: (err: any) => notifyError(err.message),
  });

  const scurve = (series.data?.series ?? []).map((s: any) => ({ month: s.month, planned: s.cumulative_planned }));
  const ganttTasks: GanttTask[] = (schedule.data?.tasks ?? []);

  const overview = (
    <div className="space-y-4">
      {/* EVM headline */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="ความคืบหน้า (% complete)" value={pct(p?.pct_complete ?? 0)} icon={Activity} tone="primary" hint={`${p?.task_count ?? 0} งาน`} />
        <StatCard label="ดัชนีต้นทุน CPI" value={e?.cpi ?? '—'} icon={Activity} tone={indexTone(e?.cpi)} hint={e?.cpi != null ? (e.cpi >= 1 ? 'ภายในงบ' : 'เกินงบ') : 'EV / AC'} />
        <StatCard label="ดัชนีเวลา SPI" value={e?.spi ?? '—'} icon={Activity} tone={indexTone(e?.spi)} hint={e?.spi != null ? (e.spi >= 1 ? 'ตามแผน/เร็วกว่า' : 'ช้ากว่าแผน') : 'EV / PV'} />
        <StatCard label="กำไรสะสม" value={baht(p?.margin ?? 0)} icon={Receipt} tone={(p?.margin ?? 0) < 0 ? 'danger' : 'success'} hint={`WIP ${baht(p?.wip ?? 0)}`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="gap-3 p-5 lg:col-span-3">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold">เส้นโค้ง S — มูลค่าตามแผน เทียบ มูลค่าที่ได้/ต้นทุนจริง</h3>
            <span className="text-xs text-muted-foreground">BAC {baht(e?.bac ?? 0)}</span>
          </div>
          {scurve.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={scurve} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="grad-pv" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="month" stroke="var(--muted-foreground)" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis stroke="var(--muted-foreground)" fontSize={12} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => baht(v).replace('.00', '')} />
                <Tooltip formatter={(v: any) => baht(v)} contentStyle={{ borderRadius: 8, border: '1px solid var(--border)', background: 'var(--popover)', fontSize: 12 }} />
                <Area type="monotone" name="แผนสะสม (PV)" dataKey="planned" stroke="var(--chart-1)" strokeWidth={2} fill="url(#grad-pv)" />
                {e?.ev != null && <ReferenceLine y={e.ev} stroke="var(--chart-3)" strokeDasharray="4 4" label={{ value: `EV ${baht(e.ev)}`, position: 'insideTopLeft', fontSize: 11, fill: 'var(--chart-3)' }} />}
                {e?.ac != null && <ReferenceLine y={e.ac} stroke="var(--destructive)" strokeDasharray="4 4" label={{ value: `AC ${baht(e.ac)}`, position: 'insideBottomLeft', fontSize: 11, fill: 'var(--destructive)' }} />}
              </ComposedChart>
            </ResponsiveContainer>
          ) : <div className="py-12 text-center text-sm text-muted-foreground">เพิ่มงานที่มีต้นทุน/กำหนดเสร็จเพื่อสร้างเส้นโค้ง S</div>}
        </Card>

        <Card className="gap-0 p-5 lg:col-span-2">
          <h3 className="mb-3 text-base font-semibold">มูลค่าที่ได้รับ (Earned Value)</h3>
          <dl className="space-y-2.5 text-sm">
            {[
              ['งบประมาณ ณ สิ้นงาน (BAC)', baht(e?.bac ?? 0)],
              ['มูลค่าตามแผน (PV)', baht(e?.pv ?? 0)],
              ['มูลค่าที่ได้รับ (EV)', baht(e?.ev ?? 0)],
              ['ต้นทุนจริง (AC)', baht(e?.ac ?? 0)],
              ['ส่วนต่างต้นทุน (CV)', baht(e?.cost_variance ?? 0)],
              ['ส่วนต่างเวลา (SV)', baht(e?.schedule_variance ?? 0)],
              ['ประมาณการ ณ สิ้นงาน (EAC)', baht(e?.eac ?? 0)],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-3 border-b border-dashed border-border/60 pb-2 last:border-0">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="tabular font-medium">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </div>
  );

  const scheduleTab = (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          ระยะเวลาโครงการ <span className="font-medium text-foreground">{schedule.data?.project_duration_days ?? 0} วัน</span>
          {' · '}เส้นทางวิกฤต <span className="font-medium text-primary">{(schedule.data?.critical_path ?? []).length} งาน</span>
        </div>
        <Button size="sm" onClick={() => setTaskDlg(true)}><Plus className="size-4" /> เพิ่มงาน</Button>
      </div>
      <StateView q={schedule}>{schedule.data && <ProjectGantt tasks={ganttTasks} totalDays={schedule.data.project_duration_days ?? 1} />}</StateView>
      {tasks.data && (
        <DataTable
          rows={tasks.data.tasks ?? []}
          columns={[
            { key: 'name', label: 'งาน' },
            { key: 'pct_complete', label: 'คืบหน้า', align: 'right', render: (r: any) => (
              <div className="ml-auto flex w-28 items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, r.pct_complete)}%` }} /></div>
                <span className="tabular w-9 text-right text-xs">{r.pct_complete}%</span>
              </div>
            ) },
            { key: 'planned_hours', label: 'ชม.', align: 'right', render: (r: any) => <span className="tabular">{r.planned_hours}</span> },
            { key: 'planned_cost', label: 'งบ', align: 'right', render: (r: any) => <span className="tabular">{baht(r.planned_cost)}</span> },
            { key: 'depends_on', label: 'ขึ้นกับ', render: (r: any) => r.depends_on?.length ? `#${r.depends_on.join(', #')}` : '—' },
            { key: 'accountable', label: 'ผู้รับผิดชอบ (RACI)', sortable: false, render: (r: any) => (
              <div className="flex flex-wrap items-center gap-1">
                {r.accountable ? <Badge variant="default" title="Accountable — ผู้รับผิดชอบหลัก (1 คน)">A: {r.accountable}</Badge> : <span className="text-xs text-muted-foreground" title="ยังไม่มีผู้รับผิดชอบหลัก">— ไม่มี A</span>}
                {r.responsible?.length ? <span className="text-xs text-muted-foreground" title="Responsible — ผู้ลงมือทำ">R: {r.responsible.join(', ')}</span> : null}
              </div>
            ) },
            { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
            { key: 'act', label: '', sortable: false, render: (r: any) => r.status !== 'done' && r.status !== 'cancelled'
              ? <Button variant="ghost" size="sm" title="ทำเครื่องหมายเสร็จ" onClick={() => markDone.mutate(r.id)}><CheckCircle2 className="size-4" /></Button> : null },
          ]}
          emptyState={{ icon: GanttChartSquare, title: 'ยังไม่มีงาน', description: 'เพิ่มงานเพื่อสร้าง WBS และกำหนดการ' }}
        />
      )}
    </div>
  );

  const milestonesTab = (
    <div className="space-y-4">
      <div className="flex justify-end"><Button size="sm" onClick={() => setMsDlg(true)}><Plus className="size-4" /> เพิ่มหมุดหมาย</Button></div>
      {milestones.data && (
        <DataTable
          rows={milestones.data.milestones ?? []}
          columns={[
            { key: 'name', label: 'หมุดหมาย' },
            { key: 'due_date', label: 'กำหนด' },
            { key: 'billing_percent', label: 'วางบิล %', align: 'right', render: (r: any) => r.billing_percent != null ? `${r.billing_percent}%` : '—' },
            { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
            { key: 'act', label: '', sortable: false, render: (r: any) => r.status !== 'reached'
              ? <Button variant="ghost" size="sm" title="บรรลุหมุดหมาย" onClick={() => reachMs.mutate(r.id)}><Flag className="size-4" /></Button> : null },
          ]}
          emptyState={{ icon: Flag, title: 'ยังไม่มีหมุดหมาย', description: 'เพิ่มหมุดหมาย — ตั้ง % เพื่อวางบิลตามความคืบหน้าได้' }}
        />
      )}
    </div>
  );

  const resourcesTab = (
    <div className="space-y-4">
      <div className="flex justify-end"><Button size="sm" onClick={() => setResDlg(true)}><Plus className="size-4" /> จัดสรรทรัพยากร</Button></div>
      {resources.data && (
        <DataTable
          rows={resources.data.resources ?? []}
          columns={[
            { key: 'resource_name', label: 'ทรัพยากร' },
            { key: 'role', label: 'บทบาท', render: (r: any) => r.role ?? '—' },
            { key: 'alloc_pct', label: 'จัดสรร', align: 'right', render: (r: any) => `${r.alloc_pct}%` },
            { key: 'cost_rate', label: 'ต้นทุน/ชม.', align: 'right', render: (r: any) => <span className="tabular">{baht(r.cost_rate)}</span> },
            { key: 'bill_rate', label: 'เรียกเก็บ/ชม.', align: 'right', render: (r: any) => <span className="tabular">{baht(r.bill_rate)}</span> },
          ]}
          emptyState={{ icon: Users, title: 'ยังไม่มีการจัดสรร', description: 'จัดสรรคนเข้าโครงการ — อัตราจะดึงจาก rate card อัตโนมัติ' }}
        />
      )}
    </div>
  );

  const costsTab = (
    <div className="space-y-4">
      {p?.rev_method === 'poc' && (
        <Card className="gap-2 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <Badge variant="secondary">รับรู้รายได้ตามความคืบหน้า (POC)</Badge>
              <span className="text-muted-foreground">สำเร็จ <span className="tabular font-medium text-foreground">{p.poc_pct ?? 0}%</span></span>
              <span className="text-muted-foreground">รับรู้แล้ว <span className="tabular font-medium text-foreground">{baht(p.recognized_revenue ?? 0)}</span></span>
              {p.contract_asset > 0 && <span className="text-muted-foreground">สินทรัพย์ตามสัญญา <span className="tabular text-primary">{baht(p.contract_asset)}</span></span>}
              {p.billings_in_excess > 0 && <span className="text-muted-foreground">วางบิลล่วงหน้า <span className="tabular text-warning-foreground dark:text-warning">{baht(p.billings_in_excess)}</span></span>}
            </div>
            <Button size="sm" variant="outline" onClick={() => recognize.mutate()} disabled={recognize.isPending}><TrendingUp className="size-4" /> รับรู้รายได้</Button>
          </div>
        </Card>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={() => { setCostDlg('cost'); setAmount(''); setCtype('time'); setBillable(true); }}><Clock className="size-4" /> ลงต้นทุน</Button>
        <Button size="sm" onClick={() => { setCostDlg('bill'); setAmount(''); setByPct(false); }}><Receipt className="size-4" /> {p?.rev_method === 'poc' ? 'ออกใบแจ้งหนี้' : 'วางบิล'}</Button>
      </div>
      {detail.data && (
        <DataTable
          rows={p?.entries ?? []}
          columns={[
            { key: 'entry_date', label: 'วันที่' },
            { key: 'entry_type', label: 'ประเภท' },
            { key: 'description', label: 'รายละเอียด', render: (r: any) => r.description ?? '—' },
            { key: 'billable', label: 'เบิกได้', render: (r: any) => r.billable ? <Badge variant="success">billable</Badge> : <Badge variant="muted">non-billable</Badge> },
            { key: 'amount', label: 'จำนวน', align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
            { key: 'entry_no', label: 'JE', render: (r: any) => <span className="text-xs text-muted-foreground">{r.entry_no ?? '—'}</span> },
          ]}
          emptyState={{ icon: Clock, title: 'ยังไม่มีต้นทุน', description: 'ลงต้นทุนเวลา/ค่าใช้จ่าย — เข้างานระหว่างทำ (WIP)' }}
        />
      )}
    </div>
  );

  const ragBadge = (rag: string) => <Badge variant={rag === 'red' ? 'destructive' : rag === 'amber' ? 'warning' : 'success'}>{rag === 'red' ? 'สูง' : rag === 'amber' ? 'กลาง' : 'ต่ำ'}</Badge>;
  const rs = risks.data?.summary;
  const risksTab = (
    <div className="space-y-4">
      {rs && (
        <div className="grid gap-3 sm:grid-cols-4">
          <StatCard label="เปิดอยู่" value={String(rs.open)} icon={Activity} />
          <StatCard label="ความเสี่ยงสูง (เปิด)" value={String(rs.high_open)} icon={Activity} tone={rs.high_open > 0 ? 'warning' : 'default'} />
          <StatCard label="สูง·ยังไม่มีแผนรับมือ" value={String(rs.unmitigated_high)} icon={Activity} tone={rs.unmitigated_high > 0 ? 'danger' : 'success'} />
          <StatCard label="ปิดแล้ว" value={String(rs.closed)} icon={CheckCircle2} />
        </div>
      )}
      <div className="flex justify-end"><Button size="sm" onClick={() => setRiskDlg(true)}><Plus className="size-4" /> เพิ่มความเสี่ยง/ปัญหา</Button></div>
      {risks.data && (
        <DataTable
          rows={risks.data.risks ?? []}
          columns={[
            { key: 'rag', label: 'ระดับ', sortable: false, render: (r: any) => ragBadge(r.rag) },
            { key: 'kind', label: 'ประเภท', render: (r: any) => r.kind === 'issue' ? 'ปัญหา' : 'ความเสี่ยง' },
            { key: 'title', label: 'หัวข้อ' },
            { key: 'score', label: 'คะแนน', align: 'right', render: (r: any) => <span className="tabular" title={r.kind === 'issue' ? `ผลกระทบ ${r.impact}` : `โอกาส ${r.probability} × ผลกระทบ ${r.impact}`}>{r.score}</span> },
            { key: 'owner', label: 'ผู้รับผิดชอบ', render: (r: any) => r.owner ?? '—' },
            { key: 'mitigation', label: 'แผนรับมือ', render: (r: any) => r.mitigation ? <span className="text-xs">{r.mitigation}</span> : <span className="text-xs text-destructive">— ยังไม่มี</span> },
            { key: 'due_date', label: 'กำหนด', render: (r: any) => r.due_date ?? '—' },
            { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
            { key: 'act', label: '', sortable: false, render: (r: any) => r.status !== 'closed'
              ? <Button variant="ghost" size="sm" title="ปิด" onClick={() => patchRisk.mutate({ id: r.id, body: { status: 'closed' } })}><CheckCircle2 className="size-4" /></Button> : null },
          ]}
          emptyState={{ icon: Activity, title: 'ยังไม่มีความเสี่ยง/ปัญหา', description: 'บันทึกความเสี่ยงและปัญหาเพื่อกำกับดูแล (PROJ-08)' }}
        />
      )}
    </div>
  );

  return (
    <div>
      <button onClick={() => router.push('/projects')} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> โครงการทั้งหมด</button>
      <PageHeader
        title={<span className="flex items-center gap-2">{p?.name ?? code} {p && <Badge variant={statusVariant(p.status)}>{p.status}</Badge>}</span>}
        description={<span>{code}{p?.customer_name ? ` · ${p.customer_name}` : ''} · {p?.billing_type === 'Fixed' ? 'เหมารวม (Fixed)' : 'ตามเวลา/วัสดุ (T&M)'}{p?.contract_amount ? ` · สัญญา ${baht(p.contract_amount)}` : ''}</span>}
      />
      <StateView q={detail}>
        <Tabs
          urlParam="tab"
          tabs={[
            { key: 'overview', label: 'ภาพรวม', content: overview },
            { key: 'schedule', label: 'กำหนดการ & Gantt', content: scheduleTab },
            { key: 'milestones', label: 'หมุดหมาย', content: milestonesTab },
            { key: 'resources', label: 'ทรัพยากร', content: resourcesTab },
            { key: 'risks', label: 'ความเสี่ยง & ปัญหา', content: risksTab },
            { key: 'costs', label: 'ต้นทุน & บิล', content: costsTab },
          ]}
        />
      </StateView>

      {/* Add task */}
      <Dialog open={taskDlg} onOpenChange={setTaskDlg}>
        <DialogContent>
          <DialogHeader><DialogTitle>เพิ่มงาน (WBS)</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5"><Label>ชื่องาน</Label><Input value={tf.name} onChange={(ev) => setTf({ ...tf, name: ev.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>ชั่วโมงตามแผน</Label><Input type="number" min="0" value={tf.planned_hours} onChange={(ev) => setTf({ ...tf, planned_hours: ev.target.value })} /></div>
              <div className="grid gap-1.5"><Label>งบประมาณ</Label><Input type="number" min="0" value={tf.planned_cost} onChange={(ev) => setTf({ ...tf, planned_cost: ev.target.value })} /></div>
              <div className="grid gap-1.5"><Label>เริ่ม</Label><Input type="date" value={tf.planned_start} onChange={(ev) => setTf({ ...tf, planned_start: ev.target.value })} /></div>
              <div className="grid gap-1.5"><Label>เสร็จ</Label><Input type="date" value={tf.planned_end} onChange={(ev) => setTf({ ...tf, planned_end: ev.target.value })} /></div>
              <div className="grid gap-1.5"><Label>% เสร็จ</Label><Input type="number" min="0" max="100" value={tf.pct_complete} onChange={(ev) => setTf({ ...tf, pct_complete: ev.target.value })} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>ผู้รับผิดชอบหลัก (Accountable)</Label><Input value={tf.accountable} onChange={(ev) => setTf({ ...tf, accountable: ev.target.value })} placeholder="ชื่อผู้ใช้ 1 คน" /></div>
              <div className="grid gap-1.5"><Label>ผู้ลงมือทำ (Responsible)</Label><Input value={tf.responsible} onChange={(ev) => setTf({ ...tf, responsible: ev.target.value })} placeholder="คั่นด้วย ," /></div>
            </div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setTaskDlg(false)}>ปิด</Button><Button onClick={() => addTask.mutate()} disabled={!tf.name || addTask.isPending}>เพิ่ม</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add milestone */}
      <Dialog open={msDlg} onOpenChange={setMsDlg}>
        <DialogContent>
          <DialogHeader><DialogTitle>เพิ่มหมุดหมาย</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5"><Label>ชื่อหมุดหมาย</Label><Input value={mf.name} onChange={(ev) => setMf({ ...mf, name: ev.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>กำหนด</Label><Input type="date" value={mf.due_date} onChange={(ev) => setMf({ ...mf, due_date: ev.target.value })} /></div>
              <div className="grid gap-1.5"><Label>วางบิล % (ถ้ามี)</Label><Input type="number" min="0" max="100" value={mf.billing_percent} onChange={(ev) => setMf({ ...mf, billing_percent: ev.target.value })} /></div>
            </div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setMsDlg(false)}>ปิด</Button><Button onClick={() => addMs.mutate()} disabled={!mf.name || addMs.isPending}>เพิ่ม</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assign resource */}
      <Dialog open={resDlg} onOpenChange={setResDlg}>
        <DialogContent>
          <DialogHeader><DialogTitle>จัดสรรทรัพยากร</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5"><Label>ชื่อ</Label><Input value={rf.resource_name} onChange={(ev) => setRf({ ...rf, resource_name: ev.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>บทบาท (→ rate card)</Label><Input value={rf.role} onChange={(ev) => setRf({ ...rf, role: ev.target.value })} /></div>
              <div className="grid gap-1.5"><Label>จัดสรร %</Label><Input type="number" min="1" max="100" value={rf.alloc_pct} onChange={(ev) => setRf({ ...rf, alloc_pct: ev.target.value })} /></div>
            </div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setResDlg(false)}>ปิด</Button><Button onClick={() => addRes.mutate()} disabled={!rf.resource_name || addRes.isPending}>จัดสรร</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add risk / issue */}
      <Dialog open={riskDlg} onOpenChange={setRiskDlg}>
        <DialogContent>
          <DialogHeader><DialogTitle>เพิ่มความเสี่ยง / ปัญหา</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>ประเภท</Label>
                <select className={selectCls} value={kf.kind} onChange={(ev) => setKf({ ...kf, kind: ev.target.value })}>
                  <option value="risk">ความเสี่ยง (risk)</option><option value="issue">ปัญหา (issue)</option>
                </select>
              </div>
              <div className="grid gap-1.5"><Label>ผู้รับผิดชอบ</Label><Input value={kf.owner} onChange={(ev) => setKf({ ...kf, owner: ev.target.value })} /></div>
            </div>
            <div className="grid gap-1.5"><Label>หัวข้อ</Label><Input value={kf.title} onChange={(ev) => setKf({ ...kf, title: ev.target.value })} /></div>
            <div className="grid grid-cols-3 gap-3">
              {kf.kind === 'risk' && <div className="grid gap-1.5"><Label>โอกาส (1-5)</Label><Input type="number" min="1" max="5" value={kf.probability} onChange={(ev) => setKf({ ...kf, probability: ev.target.value })} /></div>}
              <div className="grid gap-1.5"><Label>ผลกระทบ (1-5)</Label><Input type="number" min="1" max="5" value={kf.impact} onChange={(ev) => setKf({ ...kf, impact: ev.target.value })} /></div>
              <div className="grid gap-1.5"><Label>กำหนด</Label><Input type="date" value={kf.due_date} onChange={(ev) => setKf({ ...kf, due_date: ev.target.value })} /></div>
            </div>
            <div className="grid gap-1.5"><Label>แผนรับมือ / แก้ไข</Label><Input value={kf.mitigation} onChange={(ev) => setKf({ ...kf, mitigation: ev.target.value })} /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setRiskDlg(false)}>ปิด</Button><Button onClick={() => addRisk.mutate()} disabled={!kf.title || addRisk.isPending}>เพิ่ม</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cost / bill */}
      <Dialog open={!!costDlg} onOpenChange={(o) => !o && setCostDlg(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{costDlg === 'cost' ? 'ลงต้นทุนโครงการ' : 'วางบิลลูกค้า'} — {code}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            {costDlg === 'cost' && (
              <div className="grid gap-1.5"><Label>ประเภท</Label>
                <select className={selectCls} value={ctype} onChange={(ev) => setCtype(ev.target.value as 'time' | 'expense')}>
                  <option value="time">ค่าแรง (time)</option><option value="expense">ค่าใช้จ่าย (expense)</option>
                </select>
              </div>
            )}
            <div className="grid gap-1.5"><Label>{costDlg === 'bill' && byPct ? 'เปอร์เซ็นต์ของสัญญา (%)' : 'จำนวนเงิน'}</Label><Input type="number" min="0" value={amount} onChange={(ev) => setAmount(ev.target.value)} /></div>
            {costDlg === 'cost' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={billable} onChange={(ev) => setBillable(ev.target.checked)} /> เบิกลูกค้าได้ (billable)</label>}
            {costDlg === 'bill' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={byPct} onChange={(ev) => setByPct(ev.target.checked)} /> วางบิลตาม % ของสัญญา</label>}
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setCostDlg(null)}>ปิด</Button><Button onClick={() => submitCost.mutate()} disabled={!(Number(amount) > 0) || submitCost.isPending}>ยืนยัน</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
