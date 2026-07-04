'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ResponsiveContainer, ComposedChart, Area, Line, ReferenceLine, CartesianGrid, XAxis, YAxis, Tooltip, Legend } from 'recharts';
import { ArrowLeft, Plus, Clock, Receipt, Flag, Users, GanttChartSquare, Activity, CheckCircle2, TrendingUp, FileText, ListTree, ClipboardList, Boxes, Wallet, Lock, Check, X } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
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

export default function ProjectDetailWorkspace({ code, initialDetail, initialEvm }: { code: string; initialDetail?: unknown; initialEvm?: unknown }) {
  const router = useRouter();
  const qc = useQueryClient();
  const refresh = () => { for (const k of ['detail', 'evm', 'series', 'schedule', 'tasks', 'milestones', 'resources', 'risks', 'change-orders', 'health', 'boq', 'commitments', 'pmr', 'reservations', 'sitecash']) qc.invalidateQueries({ queryKey: ['proj', code, k] }); };

  // detail + evm are server-prefetched (see page.tsx) so the first paint carries data; react-query still
  // owns the cache and refetches on invalidation exactly as before (null prefetch = old client-only path).
  const detail = useQuery<any>({ queryKey: ['proj', code, 'detail'], queryFn: () => api(`/api/projects/${code}`), initialData: initialDetail ?? undefined });
  const evm = useQuery<any>({ queryKey: ['proj', code, 'evm'], queryFn: () => api(`/api/projects/${code}/evm`), initialData: initialEvm ?? undefined });
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
  // Change orders / contract variations (PROJ-10) — maker-checker amendment to contract/budget.
  const cos = useQuery<any>({ queryKey: ['proj', code, 'change-orders'], queryFn: () => api(`/api/projects/${code}/change-orders`) });
  const [cf, setCf] = useState({ contract_delta: '', budget_delta: '', reason: '' });
  const requestCo = useMutation({
    mutationFn: () => api(`/api/projects/${code}/change-orders`, { method: 'POST', body: JSON.stringify({ contract_delta: Number(cf.contract_delta) || 0, budget_delta: Number(cf.budget_delta) || 0, reason: cf.reason || undefined }) }),
    onSuccess: () => { notifySuccess('ส่งคำขอเปลี่ยนแปลงแล้ว — รออนุมัติ'); setCf({ contract_delta: '', budget_delta: '', reason: '' }); refresh(); }, onError: (err: any) => notifyError(err.message),
  });
  const decideCo = useMutation({
    mutationFn: (v: { id: number; action: 'approve' | 'reject' }) => api(`/api/projects/change-orders/${v.id}/${v.action}`, { method: 'POST', body: '{}' }),
    onSuccess: () => { notifySuccess('อัปเดตคำขอเปลี่ยนแปลงแล้ว'); refresh(); }, onError: (err: any) => notifyError(err.message),
  });
  // Project health history (PPM upgrade) — dated EVM/RAG trend.
  const health = useQuery<any>({ queryKey: ['proj', code, 'health'], queryFn: () => api(`/api/projects/${code}/health`) });
  const captureHealth = useMutation({
    mutationFn: () => api(`/api/projects/${code}/health`, { method: 'POST', body: '{}' }),
    onSuccess: (r: any) => { notifySuccess(`บันทึกสุขภาพโครงการ (${r.rag})`); refresh(); }, onError: (err: any) => notifyError(err.message),
  });

  // ── Governance: baselines (PROJ-07), RACI (B3), program membership (PMO-4) ──
  const baseline = useQuery<any>({ queryKey: ['proj', code, 'baseline'], queryFn: () => api(`/api/projects/${code}/baseline`) });
  const raci = useQuery<any>({ queryKey: ['proj', code, 'raci'], queryFn: () => api(`/api/projects/${code}/raci`) });
  const [baselineReason, setBaselineReason] = useState('');
  const captureBaseline = useMutation({
    mutationFn: () => api(`/api/projects/${code}/baseline`, { method: 'POST', body: JSON.stringify({ reason: baselineReason || undefined }) }),
    onSuccess: () => { notifySuccess('ตั้งเส้นฐานแล้ว'); setBaselineReason(''); qc.invalidateQueries({ queryKey: ['proj', code, 'baseline'] }); }, onError: (err: any) => notifyError(err.message),
  });
  const [prog, setProg] = useState<{ program_code: string; depends_on: string } | null>(null);
  const progValue = prog ?? { program_code: p?.program_code ?? '', depends_on: (p?.depends_on_projects ?? []).join(', ') };
  const setProgram = useMutation({
    mutationFn: () => api(`/api/projects/${code}/program`, { method: 'PATCH', body: JSON.stringify({ program_code: progValue.program_code || null, depends_on_projects: progValue.depends_on ? String(progValue.depends_on).split(',').map((x: string) => x.trim()).filter(Boolean) : [] }) }),
    onSuccess: () => { notifySuccess('อัปเดตโปรแกรม/การอ้างอิงแล้ว'); setProg(null); qc.invalidateQueries({ queryKey: ['proj', code, 'detail'] }); }, onError: (err: any) => notifyError(err.message),
  });

  // ── Material control (docs/32) — BoQ (M0), commitments (M1), requisitions (M2), reservations (M3), site cash (M4) ──
  const boq = useQuery<any>({ queryKey: ['proj', code, 'boq'], queryFn: () => api(`/api/projects/${code}/boq`) });
  const commitments = useQuery<any>({ queryKey: ['proj', code, 'commitments'], queryFn: () => api(`/api/projects/${code}/commitments`) });
  const pmrList = useQuery<any>({ queryKey: ['proj', code, 'pmr'], queryFn: () => api(`/api/pmr/project/${code}`) });
  const reservations = useQuery<any>({ queryKey: ['proj', code, 'reservations'], queryFn: () => api(`/api/reservations/project/${code}`) });
  const siteCash = useQuery<any>({ queryKey: ['proj', code, 'sitecash'], queryFn: () => api(`/api/projects/${code}/site-cash`) });
  const bq = boq.data;
  const boqId: number | undefined = bq?.boq?.id;
  const boqStatus: string | undefined = bq?.boq?.status;
  const boqLines: any[] = bq?.lines ?? [];

  // BoQ — create header, append a line, maker-checker approve/lock, re-measure a line.
  const [boqDlg, setBoqDlg] = useState(false);
  const [bf, setBf] = useState({ boq_no: '', title: '' });
  const createBoq = useMutation({
    mutationFn: () => api(`/api/projects/${code}/boq`, { method: 'POST', body: JSON.stringify({ boq_no: bf.boq_no || undefined, title: bf.title || undefined, lines: [] }) }),
    onSuccess: () => { notifySuccess('สร้าง BoQ แล้ว'); setBoqDlg(false); setBf({ boq_no: '', title: '' }); refresh(); }, onError: (err: any) => notifyError(err.message),
  });
  const [lineDlg, setLineDlg] = useState(false);
  const [lf, setLf] = useState({ category: 'material', item_no: '', description: '', uom: '', budget_qty: '', rate: '' });
  const addBoqLine = useMutation({
    mutationFn: () => api(`/api/projects/boq/${boqId}/lines`, { method: 'POST', body: JSON.stringify({ category: lf.category, item_no: lf.item_no || undefined, description: lf.description || undefined, uom: lf.uom || undefined, budget_qty: Number(lf.budget_qty) || 0, rate: Number(lf.rate) || 0 }) }),
    onSuccess: () => { notifySuccess('เพิ่มรายการ BoQ แล้ว'); setLineDlg(false); setLf({ category: 'material', item_no: '', description: '', uom: '', budget_qty: '', rate: '' }); refresh(); }, onError: (err: any) => notifyError(err.message),
  });
  const approveBoq = useMutation({
    mutationFn: () => api(`/api/projects/boq/${boqId}/approve`, { method: 'POST', body: '{}' }),
    onSuccess: (r: any) => { notifySuccess(r?.budget_synced != null ? `อนุมัติ BoQ — งบวัสดุ ${baht(r.budget_synced)}` : 'อนุมัติ BoQ แล้ว'); refresh(); }, onError: (err: any) => notifyError(err.message),
  });
  const lockBoq = useMutation({
    mutationFn: () => api(`/api/projects/boq/${boqId}/lock`, { method: 'POST', body: '{}' }),
    onSuccess: () => { notifySuccess('ล็อก BoQ แล้ว'); refresh(); }, onError: (err: any) => notifyError(err.message),
  });
  const [remDlg, setRemDlg] = useState<null | any>(null);
  const [remQty, setRemQty] = useState('');
  const remeasure = useMutation({
    mutationFn: () => api(`/api/projects/boq/lines/${remDlg.id}/remeasure`, { method: 'POST', body: JSON.stringify({ remeasured_qty: Number(remQty) || 0 }) }),
    onSuccess: () => { notifySuccess('บันทึกปริมาณวัดจริงแล้ว'); setRemDlg(null); setRemQty(''); refresh(); }, onError: (err: any) => notifyError(err.message),
  });

  // Requisition (PMR) — submit against a BoQ line, maker-checker decide over-budget ones.
  const [pmrDlg, setPmrDlg] = useState(false);
  const [pf, setPf] = useState({ boq_line_id: '', item_no: '', qty: '', unit_cost: '', vendor_name: '' });
  const submitPmr = useMutation({
    mutationFn: () => api(`/api/pmr`, { method: 'POST', body: JSON.stringify({ project_code: code, vendor_name: pf.vendor_name || undefined, items: [{ boq_line_id: Number(pf.boq_line_id), item_no: pf.item_no || undefined, qty: Number(pf.qty) || 0, unit_cost: Number(pf.unit_cost) || 0 }] }) }),
    onSuccess: (r: any) => { notifySuccess(r?.over_budget ? `เกินงบ — ส่งอนุมัติผ่าน LINE (${r?.pmr_no ?? ''})` : r?.route === 'stock_issue' ? `เบิกจากสต๊อกแล้ว (${r?.pmr_no ?? ''})` : `ออกใบขอซื้อแล้ว (${r?.pmr_no ?? ''})`); setPmrDlg(false); setPf({ boq_line_id: '', item_no: '', qty: '', unit_cost: '', vendor_name: '' }); refresh(); }, onError: (err: any) => notifyError(err.message),
  });
  const decidePmr = useMutation({
    mutationFn: (v: { pmrNo: string; action: 'approve' | 'reject' }) => api(`/api/pmr/${v.pmrNo}/${v.action}`, { method: 'POST', body: '{}' }),
    onSuccess: () => { notifySuccess('อัปเดตใบขอเบิกแล้ว'); refresh(); }, onError: (err: any) => notifyError(err.message),
  });

  // Reservations — reserve on-hand stock to the project, issue-to-project (→ WIP) / release.
  const [resvDlg, setResvDlg] = useState(false);
  const [zf, setZf] = useState({ item_id: '', location_id: 'WH-MAIN', qty: '', boq_line_id: '' });
  const availItem = zf.item_id.trim();
  const avail = useQuery<any>({ queryKey: ['proj', code, 'resv-avail', availItem, zf.location_id], queryFn: () => api(`/api/reservations/available?item_id=${encodeURIComponent(availItem)}&location_id=${encodeURIComponent(zf.location_id || 'WH-MAIN')}`), enabled: resvDlg && !!availItem });
  const reserve = useMutation({
    mutationFn: () => api(`/api/reservations`, { method: 'POST', body: JSON.stringify({ project_code: code, item_id: zf.item_id, location_id: zf.location_id || undefined, qty: Number(zf.qty) || 0, boq_line_id: zf.boq_line_id ? Number(zf.boq_line_id) : undefined }) }),
    onSuccess: () => { notifySuccess('จองสต๊อกแล้ว'); setResvDlg(false); setZf({ item_id: '', location_id: 'WH-MAIN', qty: '', boq_line_id: '' }); refresh(); }, onError: (err: any) => notifyError(err.message),
  });
  const issueResv = useMutation({
    mutationFn: (id: number) => api(`/api/reservations/${id}/issue`, { method: 'POST', body: '{}' }),
    onSuccess: () => { notifySuccess('จ่ายวัสดุเข้าโครงการ (WIP) แล้ว'); refresh(); }, onError: (err: any) => notifyError(err.message),
  });
  const releaseResv = useMutation({
    mutationFn: (id: number) => api(`/api/reservations/${id}/release`, { method: 'POST', body: '{}' }),
    onSuccess: () => { notifySuccess('ปล่อยการจองแล้ว'); refresh(); }, onError: (err: any) => notifyError(err.message),
  });

  // Site cash — raise an advance or a petty-cash request against this project straight from the site-cash tab.
  const [advDlg, setAdvDlg] = useState(false);
  const [af, setAf] = useState({ payee: '', amount: '', purpose: '', boq_line_id: '' });
  const raiseAdvance = useMutation({
    mutationFn: () => api(`/api/finance/advances`, { method: 'POST', body: JSON.stringify({ payee: af.payee, amount: Number(af.amount) || 0, purpose: af.purpose || undefined, project_code: code, boq_line_id: af.boq_line_id ? Number(af.boq_line_id) : undefined }) }),
    onSuccess: () => { notifySuccess('ออกเงินทดรองจ่ายแล้ว'); setAdvDlg(false); setAf({ payee: '', amount: '', purpose: '', boq_line_id: '' }); refresh(); }, onError: (err: any) => notifyError(err.message),
  });
  const [pcDlg, setPcDlg] = useState(false);
  const [pcf, setPcf] = useState({ fund_code: '', kind: 'expense', payee: '', purpose: '', amount: '', boq_line_id: '' });
  // Petty-cash funds — fetched lazily only when the request dialog is open (feeds the fund picker).
  const funds = useQuery<any>({ queryKey: ['petty-funds'], queryFn: () => api(`/api/finance/petty-cash/funds`), enabled: pcDlg });
  const raisePetty = useMutation({
    mutationFn: () => api(`/api/finance/petty-cash/requests`, { method: 'POST', body: JSON.stringify({ fund_code: pcf.fund_code, kind: pcf.kind, payee: pcf.payee || undefined, purpose: pcf.purpose || undefined, amount: Number(pcf.amount) || 0, project_code: code, boq_line_id: pcf.boq_line_id ? Number(pcf.boq_line_id) : undefined }) }),
    onSuccess: () => { notifySuccess('ส่งคำขอเงินสดย่อยแล้ว — รออนุมัติ'); setPcDlg(false); setPcf({ fund_code: '', kind: 'expense', payee: '', purpose: '', amount: '', boq_line_id: '' }); qc.invalidateQueries({ queryKey: ['petty-funds'] }); refresh(); }, onError: (err: any) => notifyError(err.message),
  });

  const boqStatusBadge = (s?: string) => <Badge variant={s === 'locked' ? 'secondary' : s === 'approved' ? 'success' : 'warning'}>{s === 'locked' ? 'ล็อก' : s === 'approved' ? 'อนุมัติแล้ว' : 'ร่าง'}</Badge>;
  const boqTab = (
    <div className="space-y-4">
      {!bq?.boq ? (
        <Card className="gap-3 p-8 text-center">
          <ListTree className="mx-auto size-8 text-muted-foreground" />
          <h3 className="text-base font-semibold">ยังไม่มีบัญชีปริมาณงาน (BoQ)</h3>
          <p className="text-sm text-muted-foreground">สร้าง BoQ เพื่อกำหนดงบวัสดุ/งานต่อรายการ — เมื่ออนุมัติแล้วจะเป็นเพดานงบที่ระบบบังคับใช้ (PROJ-12)</p>
          <div><Button onClick={() => setBoqDlg(true)}><Plus className="size-4" /> สร้าง BoQ</Button></div>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <StatCard label="งบ BoQ รวม" value={baht(bq.budget_total)} icon={FileText} hint={`${bq.count} รายการ`} />
            <StatCard label="ผูกพันแล้ว (committed)" value={baht(bq.committed_total ?? 0)} icon={ClipboardList} tone={(bq.committed_total ?? 0) > bq.budget_total ? 'danger' : 'default'} />
            <StatCard label="คงเหลือ" value={baht(bq.remaining_total ?? 0)} icon={TrendingUp} tone={(bq.remaining_total ?? 0) < 0 ? 'danger' : 'success'} />
            <StatCard label="สถานะ" value={boqStatus === 'locked' ? 'ล็อก' : boqStatus === 'approved' ? 'อนุมัติแล้ว' : 'ร่าง'} icon={boqStatus === 'locked' ? Lock : boqStatus === 'approved' ? CheckCircle2 : Clock} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">{bq.boq.boq_no}</span>{boqStatusBadge(boqStatus)}
              {bq.boq.title && <span className="text-muted-foreground">· {bq.boq.title}</span>}
              {bq.boq.approved_by && <span className="text-xs text-muted-foreground">อนุมัติโดย {bq.boq.approved_by}</span>}
            </div>
            <div className="flex flex-wrap gap-2">
              {boqStatus === 'draft' && <Button size="sm" variant="outline" onClick={() => setLineDlg(true)}><Plus className="size-4" /> เพิ่มรายการ</Button>}
              {boqStatus === 'draft' && <Button size="sm" onClick={() => approveBoq.mutate()} disabled={approveBoq.isPending || !bq.count} title="ผู้อนุมัติต้องไม่ใช่ผู้จัดทำ"><Check className="size-4" /> อนุมัติ</Button>}
              {boqStatus === 'approved' && <Button size="sm" variant="outline" onClick={() => lockBoq.mutate()} disabled={lockBoq.isPending}><Lock className="size-4" /> ล็อก</Button>}
            </div>
          </div>
          <DataTable
            rows={boqLines}
            rowKey={(r: any) => r.id}
            columns={[
              { key: 'line_no', label: '#', align: 'right', render: (r: any) => <span className="tabular text-xs text-muted-foreground">{r.line_no}</span> },
              { key: 'category', label: 'หมวด', render: (r: any) => <Badge variant="muted">{r.category}</Badge> },
              { key: 'description', label: 'รายละเอียด', render: (r: any) => r.description ?? r.item_no ?? '—' },
              { key: 'budget_qty', label: 'ปริมาณ', align: 'right', render: (r: any) => <span className="tabular">{num(r.budget_qty)}{r.uom ? ` ${r.uom}` : ''}</span> },
              { key: 'remeasured_qty', label: 'วัดจริง', align: 'right', render: (r: any) => r.remeasured_qty != null ? <span className="tabular">{num(r.remeasured_qty)}</span> : <span className="text-xs text-muted-foreground">—</span> },
              { key: 'rate', label: 'ราคา/หน่วย', align: 'right', render: (r: any) => <span className="tabular">{baht(r.rate)}</span> },
              { key: 'budget_amount', label: 'งบ', align: 'right', render: (r: any) => <span className="tabular">{baht(r.budget_amount)}</span> },
              { key: 'committed', label: 'ผูกพัน', align: 'right', render: (r: any) => <span className="tabular">{baht(r.committed ?? 0)}</span> },
              { key: 'remaining', label: 'คงเหลือ', align: 'right', render: (r: any) => <span className={`tabular ${(r.remaining ?? 0) < 0 ? 'text-destructive' : ''}`}>{baht(r.remaining ?? 0)}</span> },
              { key: 'act', label: '', sortable: false, render: (r: any) => boqStatus === 'approved'
                ? <Button variant="ghost" size="sm" title="บันทึกปริมาณวัดจริง" onClick={() => { setRemDlg(r); setRemQty(String(r.remeasured_qty ?? r.budget_qty ?? '')); }}><ListTree className="size-4" /></Button> : null },
            ]}
            emptyState={{ icon: ListTree, title: 'ยังไม่มีรายการ BoQ', description: 'เพิ่มรายการวัสดุ/งานพร้อมปริมาณและราคาต่อหน่วย' }}
          />
        </>
      )}
    </div>
  );

  const cs = commitments.data?.summary;
  const pmrRoute = (r: any) => r.over_budget ? <Badge variant="destructive">เกินงบ</Badge> : r.route === 'stock_issue' ? <Badge variant="success">เบิกสต๊อก</Badge> : <Badge variant="secondary">ใบขอซื้อ</Badge>;
  const pmrTab = (
    <div className="space-y-4">
      {cs && (
        <div className="grid gap-3 sm:grid-cols-4">
          <StatCard label="ผูกพันเปิดอยู่ (open)" value={baht(cs.open)} icon={ClipboardList} />
          <StatCard label="ใช้จริงแล้ว (consumed)" value={baht(cs.consumed)} icon={Receipt} />
          <StatCard label="ผูกพันรวม" value={baht(cs.committed)} icon={TrendingUp} />
          <StatCard label="รออนุมัติ" value={String(pmrList.data?.pending ?? 0)} icon={Clock} tone={(pmrList.data?.pending ?? 0) > 0 ? 'warning' : 'default'} />
        </div>
      )}
      <div className="flex justify-end"><Button size="sm" onClick={() => setPmrDlg(true)} disabled={!bq?.boq}><Plus className="size-4" /> ขอเบิกวัสดุ</Button></div>
      {pmrList.data && (
        <DataTable
          rows={pmrList.data.pmrs ?? []}
          rowKey={(r: any) => r.pmr_no}
          columns={[
            { key: 'pmr_no', label: 'เลขที่' },
            { key: 'route', label: 'เส้นทาง', sortable: false, render: (r: any) => pmrRoute(r) },
            { key: 'est_cost', label: 'มูลค่า', align: 'right', render: (r: any) => <span className="tabular">{baht(r.est_cost)}</span> },
            { key: 'over_amount', label: 'ส่วนเกินงบ', align: 'right', render: (r: any) => r.over_amount > 0 ? <span className="tabular text-destructive">{baht(r.over_amount)}</span> : '—' },
            { key: 'linked_doc_no', label: 'เอกสารเชื่อม', render: (r: any) => r.linked_doc_no ?? '—' },
            { key: 'requested_by', label: 'ผู้ขอ' },
            { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
            { key: 'act', label: '', sortable: false, render: (r: any) => r.status === 'pending' ? (
              <span className="flex gap-1">
                <Button variant="ghost" size="sm" title="อนุมัติ (ผู้อนุมัติ ≠ ผู้ขอ)" onClick={() => decidePmr.mutate({ pmrNo: r.pmr_no, action: 'approve' })}><Check className="size-4" /></Button>
                <Button variant="ghost" size="sm" title="ปฏิเสธ" onClick={() => decidePmr.mutate({ pmrNo: r.pmr_no, action: 'reject' })}><X className="size-4" /></Button>
              </span>
            ) : null },
          ]}
          emptyState={{ icon: ClipboardList, title: 'ยังไม่มีใบขอเบิกวัสดุ', description: 'เบิกวัสดุตาม BoQ — ภายในงบออกใบขอซื้อ/เบิกสต๊อก เกินงบส่งอนุมัติผ่าน LINE (PROJ-13)' }}
        />
      )}
    </div>
  );

  const zs = reservations.data?.summary;
  const reservationsTab = (
    <div className="space-y-4">
      {zs && (
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard label="จองอยู่ (held)" value={num(zs.held)} icon={Boxes} />
          <StatCard label="จ่ายเข้าโครงการ (issued)" value={num(zs.consumed)} icon={CheckCircle2} tone="success" />
          <StatCard label="ปล่อยแล้ว (released)" value={num(zs.released)} icon={ArrowLeft} />
        </div>
      )}
      <div className="flex justify-end"><Button size="sm" onClick={() => setResvDlg(true)}><Plus className="size-4" /> จองสต๊อก</Button></div>
      {reservations.data && (
        <DataTable
          rows={reservations.data.reservations ?? []}
          rowKey={(r: any) => r.id}
          columns={[
            { key: 'item_id', label: 'สินค้า' },
            { key: 'location_id', label: 'คลัง' },
            { key: 'qty', label: 'จำนวน', align: 'right', render: (r: any) => <span className="tabular">{num(r.qty)}</span> },
            { key: 'boq_line_id', label: 'BoQ line', render: (r: any) => r.boq_line_id ?? '—' },
            { key: 'issue_no', label: 'เลขที่จ่าย', render: (r: any) => r.issue_no ?? '—' },
            { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
            { key: 'act', label: '', sortable: false, render: (r: any) => r.status === 'held' ? (
              <span className="flex gap-1">
                <Button variant="ghost" size="sm" title="จ่ายเข้าโครงการ (WIP)" onClick={() => issueResv.mutate(r.id)}><CheckCircle2 className="size-4" /></Button>
                <Button variant="ghost" size="sm" title="ปล่อยการจอง" onClick={() => releaseResv.mutate(r.id)}><ArrowLeft className="size-4" /></Button>
              </span>
            ) : null },
          ]}
          emptyState={{ icon: Boxes, title: 'ยังไม่มีการจองสต๊อก', description: 'จองสต๊อกคงเหลือให้โครงการ แล้วจ่ายเข้างานระหว่างทำ (WIP) — INV-13' }}
        />
      )}
    </div>
  );

  const sc = siteCash.data;
  const siteCashTab = (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <StatCard label="เงินทดรองจ่าย" value={baht(sc?.totals?.advances ?? 0)} icon={Wallet} />
        <StatCard label="เบิกคืน (reimburse)" value={baht(sc?.totals?.reimbursements ?? 0)} icon={Receipt} />
        <StatCard label="เงินสดย่อย" value={baht(sc?.totals?.petty_cash ?? 0)} icon={Wallet} />
        <StatCard label="เงินสดหน้างานรวม" value={baht(sc?.totals?.total ?? 0)} icon={TrendingUp} tone="primary" />
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="outline" onClick={() => setAdvDlg(true)}><Wallet className="size-4" /> ออกเงินทดรอง</Button>
        <Button size="sm" onClick={() => setPcDlg(true)}><Plus className="size-4" /> ขอเงินสดย่อย</Button>
      </div>
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">เงินทดรองจ่าย (Advances)</h3>
        <DataTable
          rows={sc?.advances ?? []}
          rowKey={(r: any) => r.advance_no}
          columns={[
            { key: 'advance_no', label: 'เลขที่' },
            { key: 'payee', label: 'ผู้รับ' },
            { key: 'amount', label: 'จำนวน', align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
            { key: 'settled_expense', label: 'เคลียร์แล้ว', align: 'right', render: (r: any) => <span className="tabular">{baht(r.settled_expense)}</span> },
            { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
          ]}
          emptyState={{ icon: Wallet, title: 'ไม่มีเงินทดรอง', description: 'เงินทดรองจ่ายที่ผูกกับโครงการนี้' }}
        />
      </Card>
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">เบิกคืน & เงินสดย่อย (Reimbursements & petty cash)</h3>
        <DataTable
          rows={[...(sc?.reimbursements ?? []).map((r: any) => ({ ...r, _t: 'reimburse', _no: r.entry_no ?? r.ap_txn_no ?? `#${r.id}` })), ...(sc?.petty_cash ?? []).map((r: any) => ({ ...r, _t: 'petty', _no: r.req_no }))]}
          rowKey={(r: any) => `${r._t}-${r._no}`}
          columns={[
            { key: '_t', label: 'ประเภท', render: (r: any) => r._t === 'petty' ? <Badge variant="muted">เงินสดย่อย</Badge> : <Badge variant="secondary">เบิกคืน</Badge> },
            { key: '_no', label: 'เลขที่' },
            { key: 'category', label: 'หมวด/ผู้รับ', render: (r: any) => r.category ?? r.payee ?? '—' },
            { key: 'amount', label: 'จำนวน', align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
            { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
          ]}
          emptyState={{ icon: Receipt, title: 'ไม่มีรายการ', description: 'เบิกคืนค่าใช้จ่ายและเงินสดย่อยที่ผูกกับโครงการ (PROJ-14)' }}
        />
      </Card>
    </div>
  );

  const scurve = (series.data?.series ?? []).map((s: any) => ({ month: s.month, planned: s.cumulative_planned }));
  const ganttTasks: GanttTask[] = (schedule.data?.tasks ?? []);

  const bl = baseline.data;
  const raciData = raci.data;
  const governanceTab = (
    <div className="space-y-4">
      {/* Baseline (PROJ-07) — capture a change-controlled baseline + scope/cost creep variance */}
      <Card className="gap-3 p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">เส้นฐานโครงการ (Baseline) — ควบคุมการเปลี่ยนขอบเขต</h3>
          {bl?.baseline && <Badge variant="secondary">{bl.baseline.label} · {bl.baseline.captured_at?.slice?.(0, 10) ?? ''}</Badge>}
        </div>
        {bl?.baseline ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard label="งบเส้นฐาน (BAC)" value={baht(bl.baseline.baseline_bac)} icon={FileText} hint={`ปัจจุบัน ${baht(bl.current?.bac ?? 0)}`} />
            <StatCard label="ส่วนต่างงบ (creep)" value={`${(bl.variance?.bac_delta ?? 0) >= 0 ? '+' : ''}${baht(bl.variance?.bac_delta ?? 0)}`} icon={TrendingUp} tone={(bl.variance?.bac_delta ?? 0) > 0 ? 'danger' : 'success'} hint={bl.variance?.bac_pct != null ? `${bl.variance.bac_pct}%` : ''} />
            <StatCard label="ส่วนต่างระยะเวลา" value={`${(bl.variance?.duration_delta ?? 0) >= 0 ? '+' : ''}${bl.variance?.duration_delta ?? 0} วัน`} icon={Activity} tone={(bl.variance?.duration_delta ?? 0) > 0 ? 'warning' : 'default'} hint={`เส้นฐาน ${bl.baseline.baseline_duration_days} วัน`} />
          </div>
        ) : <p className="text-sm text-muted-foreground">ยังไม่มีเส้นฐาน — ตั้งเส้นฐานแรกเพื่อวัดการเปลี่ยนขอบเขต/งบ (scope & cost creep) เทียบกับแผนตั้งต้น</p>}
        <div className="flex flex-wrap items-end gap-3">
          {bl?.baseline && <div className="grid flex-1 gap-1.5"><Label>เหตุผล (จำเป็นเมื่อตั้งเส้นฐานใหม่)</Label><Input value={baselineReason} onChange={(e) => setBaselineReason(e.target.value)} placeholder="เช่น อนุมัติ CO ขยายขอบเขต" /></div>}
          <Button variant="outline" onClick={() => captureBaseline.mutate()} disabled={captureBaseline.isPending || (!!bl?.baseline && !baselineReason)}><Flag className="size-4" /> {bl?.baseline ? 'ตั้งเส้นฐานใหม่' : 'ตั้งเส้นฐาน'}</Button>
        </div>
        {(bl?.history?.length ?? 0) > 1 && (
          <div className="flex flex-col divide-y text-sm">
            {bl.history.map((h: any) => (
              <div key={h.id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="flex items-center gap-2"><Badge variant={h.status === 'active' ? 'success' : 'muted'}>{h.status}</Badge><span className="font-medium">{h.label}</span>{h.reason && <span className="text-xs text-muted-foreground">· {h.reason}</span>}</span>
                <span className="tabular text-xs text-muted-foreground">{baht(h.baseline_bac)} · {h.baseline_duration_days} วัน · {h.captured_at?.slice?.(0, 10)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* RACI accountability matrix (B3) */}
      <Card className="gap-3 p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">เมทริกซ์ความรับผิดชอบ (RACI)</h3>
          {raciData && (raciData.complete ? <Badge variant="success">มีผู้รับผิดชอบหลักครบ</Badge> : <Badge variant="destructive">ขาด A {raciData.missing_accountable.length} งาน</Badge>)}
        </div>
        {raciData?.people?.length ? (
          <DataTable
            rows={raciData.people}
            rowKey={(r: any) => r.name}
            columns={[
              { key: 'name', label: 'บุคคล' },
              { key: 'accountable', label: 'A (รับผิดชอบหลัก)', align: 'right' },
              { key: 'responsible', label: 'R (ลงมือทำ)', align: 'right' },
              { key: 'consulted', label: 'C (ปรึกษา)', align: 'right' },
              { key: 'informed', label: 'I (รับทราบ)', align: 'right' },
            ]}
            emptyState={{ icon: Users, title: 'ยังไม่มีการมอบหมาย', description: 'กำหนด A/R/C/I ในแต่ละงาน' }}
          />
        ) : <p className="text-sm text-muted-foreground">ยังไม่มีการมอบหมาย RACI — กำหนดผู้รับผิดชอบหลัก (A) และผู้ลงมือทำ (R) ในแต่ละงานที่แท็บกำหนดการ</p>}
        {raciData && !raciData.complete && (
          <p className="text-xs text-destructive">งานที่ยังไม่มีผู้รับผิดชอบหลัก (Accountable): #{raciData.missing_accountable.join(', #')}</p>
        )}
      </Card>

      {/* Program membership + cross-project dependencies (PMO-4) */}
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">โปรแกรม & การอ้างอิงข้ามโครงการ (Program)</h3>
        <p className="text-xs text-muted-foreground">จัดกลุ่มโครงการเข้าโปรแกรม และระบุโครงการที่ต้องเสร็จก่อน (finish-to-start) เพื่อคำนวณเส้นทางวิกฤตระดับโปรแกรม</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label>รหัสโปรแกรม</Label><Input value={progValue.program_code} onChange={(e) => setProg({ ...progValue, program_code: e.target.value })} placeholder="เช่น PROG-A" /></div>
          <div className="grid gap-1.5"><Label>ขึ้นกับโครงการ (คั่นด้วย ,)</Label><Input value={progValue.depends_on} onChange={(e) => setProg({ ...progValue, depends_on: e.target.value })} placeholder="เช่น PRJ000123, PRJ000124" /></div>
        </div>
        <div><Button variant="outline" onClick={() => setProgram.mutate()} disabled={setProgram.isPending}><CheckCircle2 className="size-4" /> บันทึก</Button></div>
      </Card>
    </div>
  );

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

      {/* Change orders (PROJ-10) — maker-checker contract/scope variations */}
      <Card className="gap-3 p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">ใบสั่งเปลี่ยนแปลง (Change orders)</h3>
          {cos.data?.summary?.approved > 0 && <Badge variant="secondary">สัญญาเปลี่ยนสุทธิ {baht(cos.data.summary.approved_contract_delta)}</Badge>}
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="grid gap-1.5"><Label>มูลค่าสัญญา (+/−)</Label><Input type="number" value={cf.contract_delta} onChange={(ev) => setCf({ ...cf, contract_delta: ev.target.value })} /></div>
          <div className="grid gap-1.5"><Label>งบประมาณ (+/−)</Label><Input type="number" value={cf.budget_delta} onChange={(ev) => setCf({ ...cf, budget_delta: ev.target.value })} /></div>
          <div className="grid gap-1.5"><Label>เหตุผล</Label><Input value={cf.reason} onChange={(ev) => setCf({ ...cf, reason: ev.target.value })} /></div>
          <div className="flex items-end"><Button size="sm" variant="outline" onClick={() => requestCo.mutate()} disabled={requestCo.isPending || (!cf.contract_delta && !cf.budget_delta)}><Plus className="size-4" /> ขอเปลี่ยนแปลง</Button></div>
        </div>
        <div className="flex flex-col divide-y">
          {(cos.data?.change_orders ?? []).map((c: any) => (
            <div key={c.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="flex flex-wrap items-center gap-2">
                <Badge variant={c.status === 'approved' ? 'success' : c.status === 'rejected' ? 'muted' : 'warning'}>{c.status === 'approved' ? 'อนุมัติ' : c.status === 'rejected' ? 'ปฏิเสธ' : 'รออนุมัติ'}</Badge>
                <span className="font-medium">{c.co_no}</span>
                <span className="tabular text-muted-foreground">สัญญา {c.contract_delta >= 0 ? '+' : ''}{baht(c.contract_delta)}</span>
                {c.reason && <span className="text-xs text-muted-foreground">· {c.reason}</span>}
                <span className="text-xs text-muted-foreground">ขอโดย {c.requested_by}</span>
              </span>
              {c.status === 'pending' && (
                <span className="flex gap-1">
                  <Button size="sm" variant="ghost" title="อนุมัติ (ต้องไม่ใช่ผู้ขอ)" onClick={() => decideCo.mutate({ id: c.id, action: 'approve' })}><CheckCircle2 className="size-4" /></Button>
                </span>
              )}
            </div>
          ))}
          {!cos.data?.count && <p className="py-2 text-sm text-muted-foreground">ยังไม่มีใบสั่งเปลี่ยนแปลง — การเปลี่ยนมูลค่าสัญญาต้องผ่านการอนุมัติ (ผู้อนุมัติ ≠ ผู้ขอ) และจะตั้งเส้นฐานใหม่</p>}
        </div>
      </Card>

      {/* Project health history (PPM upgrade) — CPI/SPI trend over snapshots */}
      <Card className="gap-3 p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">แนวโน้มสุขภาพโครงการ (Health trend)</h3>
          <Button size="sm" variant="outline" onClick={() => captureHealth.mutate()} disabled={captureHealth.isPending}><Activity className="size-4" /> บันทึกสุขภาพ</Button>
        </div>
        {(health.data?.count ?? 0) >= 2 ? (
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={(health.data.history ?? []).map((s: any) => ({ date: s.snapshot_date, CPI: s.cpi, SPI: s.spi }))} margin={{ left: -20, right: 8, top: 8 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} domain={[0, 'auto']} />
                <Tooltip />
                <Legend />
                <ReferenceLine y={1} stroke="var(--muted-foreground)" strokeDasharray="4 4" />
                <Line type="monotone" dataKey="CPI" stroke="var(--chart-1)" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="SPI" stroke="var(--chart-2)" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">บันทึกสุขภาพอย่างน้อย 2 ครั้งเพื่อดูแนวโน้ม CPI/SPI (หรือใช้รายงานตั้งเวลา <span className="font-medium">project_health_capture</span> บันทึกอัตโนมัติ)</p>
        )}
      </Card>
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
        actions={<Button variant="outline" onClick={() => router.push(`/projects/${encodeURIComponent(code)}/status`)}><FileText className="size-4" /> รายงานสถานะ</Button>}
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
            { key: 'boq', label: 'BoQ & งบวัสดุ', content: boqTab },
            { key: 'requisitions', label: 'ขอเบิกวัสดุ', content: pmrTab },
            { key: 'reservations', label: 'จองสต๊อก', content: reservationsTab },
            { key: 'sitecash', label: 'เงินสดหน้างาน', content: siteCashTab },
            { key: 'governance', label: 'กำกับดูแล', content: governanceTab },
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

      {/* Create BoQ */}
      <Dialog open={boqDlg} onOpenChange={setBoqDlg}>
        <DialogContent>
          <DialogHeader><DialogTitle>สร้างบัญชีปริมาณงาน (BoQ) — {code}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5"><Label>เลขที่ BoQ (เว้นว่างให้ระบบออกให้)</Label><Input value={bf.boq_no} onChange={(ev) => setBf({ ...bf, boq_no: ev.target.value })} placeholder="เช่น BOQ-001" /></div>
            <div className="grid gap-1.5"><Label>ชื่อ/คำอธิบาย</Label><Input value={bf.title} onChange={(ev) => setBf({ ...bf, title: ev.target.value })} /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setBoqDlg(false)}>ปิด</Button><Button onClick={() => createBoq.mutate()} disabled={createBoq.isPending}>สร้าง</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add BoQ line */}
      <Dialog open={lineDlg} onOpenChange={setLineDlg}>
        <DialogContent>
          <DialogHeader><DialogTitle>เพิ่มรายการ BoQ</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>หมวด</Label>
                <select className={selectCls} value={lf.category} onChange={(ev) => setLf({ ...lf, category: ev.target.value })}>
                  <option value="material">วัสดุ (material)</option><option value="labor">ค่าแรง (labor)</option><option value="equipment">เครื่องจักร (equipment)</option><option value="subcontract">ผู้รับเหมาช่วง (subcontract)</option><option value="other">อื่นๆ (other)</option>
                </select>
              </div>
              <div className="grid gap-1.5"><Label>รหัสสินค้า (ถ้ามี)</Label><Input value={lf.item_no} onChange={(ev) => setLf({ ...lf, item_no: ev.target.value })} /></div>
            </div>
            <div className="grid gap-1.5"><Label>รายละเอียด</Label><Input value={lf.description} onChange={(ev) => setLf({ ...lf, description: ev.target.value })} /></div>
            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-1.5"><Label>ปริมาณ</Label><Input type="number" min="0" value={lf.budget_qty} onChange={(ev) => setLf({ ...lf, budget_qty: ev.target.value })} /></div>
              <div className="grid gap-1.5"><Label>หน่วย</Label><Input value={lf.uom} onChange={(ev) => setLf({ ...lf, uom: ev.target.value })} placeholder="เช่น ม³, ตัน" /></div>
              <div className="grid gap-1.5"><Label>ราคา/หน่วย</Label><Input type="number" min="0" value={lf.rate} onChange={(ev) => setLf({ ...lf, rate: ev.target.value })} /></div>
            </div>
            <p className="text-xs text-muted-foreground">งบรายการ = ปริมาณ × ราคา/หน่วย = <span className="tabular font-medium text-foreground">{baht((Number(lf.budget_qty) || 0) * (Number(lf.rate) || 0))}</span></p>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setLineDlg(false)}>ปิด</Button><Button onClick={() => addBoqLine.mutate()} disabled={addBoqLine.isPending}>เพิ่ม</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Re-measure BoQ line */}
      <Dialog open={!!remDlg} onOpenChange={(o) => !o && setRemDlg(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>บันทึกปริมาณวัดจริง (Re-measure)</DialogTitle></DialogHeader>
          {remDlg && (
            <div className="grid gap-3">
              <p className="text-sm text-muted-foreground">{remDlg.description ?? remDlg.item_no ?? `รายการ #${remDlg.line_no}`} · งบตั้งไว้ <span className="tabular font-medium text-foreground">{num(remDlg.budget_qty)}{remDlg.uom ? ` ${remDlg.uom}` : ''}</span></p>
              <div className="grid gap-1.5"><Label>ปริมาณวัดจริง</Label><Input type="number" min="0" value={remQty} onChange={(ev) => setRemQty(ev.target.value)} /></div>
            </div>
          )}
          <DialogFooter><Button variant="outline" onClick={() => setRemDlg(null)}>ปิด</Button><Button onClick={() => remeasure.mutate()} disabled={remeasure.isPending}>บันทึก</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Submit requisition (PMR) */}
      <Dialog open={pmrDlg} onOpenChange={setPmrDlg}>
        <DialogContent>
          <DialogHeader><DialogTitle>ขอเบิกวัสดุตาม BoQ — {code}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5"><Label>รายการ BoQ (งบวัสดุ)</Label>
              <select className={selectCls} value={pf.boq_line_id} onChange={(ev) => setPf({ ...pf, boq_line_id: ev.target.value })}>
                <option value="">— เลือกรายการ —</option>
                {boqLines.map((l: any) => <option key={l.id} value={l.id}>#{l.line_no} {l.description ?? l.item_no ?? l.category} · คงเหลือ {baht(l.remaining ?? 0)}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>รหัสสินค้า (ถ้ามี)</Label><Input value={pf.item_no} onChange={(ev) => setPf({ ...pf, item_no: ev.target.value })} /></div>
              <div className="grid gap-1.5"><Label>ผู้ขาย (ถ้ามี)</Label><Input value={pf.vendor_name} onChange={(ev) => setPf({ ...pf, vendor_name: ev.target.value })} /></div>
              <div className="grid gap-1.5"><Label>จำนวน</Label><Input type="number" min="0" value={pf.qty} onChange={(ev) => setPf({ ...pf, qty: ev.target.value })} /></div>
              <div className="grid gap-1.5"><Label>ราคา/หน่วย</Label><Input type="number" min="0" value={pf.unit_cost} onChange={(ev) => setPf({ ...pf, unit_cost: ev.target.value })} /></div>
            </div>
            <p className="text-xs text-muted-foreground">มูลค่า = <span className="tabular font-medium text-foreground">{baht((Number(pf.qty) || 0) * (Number(pf.unit_cost) || 0))}</span> — ภายในงบออกใบขอซื้อ/เบิกสต๊อกอัตโนมัติ เกินงบส่งอนุมัติผ่าน LINE</p>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setPmrDlg(false)}>ปิด</Button><Button onClick={() => submitPmr.mutate()} disabled={!pf.boq_line_id || !(Number(pf.qty) > 0) || submitPmr.isPending}>ส่งคำขอ</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reserve stock */}
      <Dialog open={resvDlg} onOpenChange={setResvDlg}>
        <DialogContent>
          <DialogHeader><DialogTitle>จองสต๊อกให้โครงการ — {code}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>รหัสสินค้า</Label><Input value={zf.item_id} onChange={(ev) => setZf({ ...zf, item_id: ev.target.value })} /></div>
              <div className="grid gap-1.5"><Label>คลัง</Label><Input value={zf.location_id} onChange={(ev) => setZf({ ...zf, location_id: ev.target.value })} /></div>
              <div className="grid gap-1.5"><Label>จำนวน</Label><Input type="number" min="0" value={zf.qty} onChange={(ev) => setZf({ ...zf, qty: ev.target.value })} /></div>
              <div className="grid gap-1.5"><Label>BoQ line (ถ้ามี)</Label>
                <select className={selectCls} value={zf.boq_line_id} onChange={(ev) => setZf({ ...zf, boq_line_id: ev.target.value })}>
                  <option value="">— ไม่ระบุ —</option>
                  {boqLines.map((l: any) => <option key={l.id} value={l.id}>#{l.line_no} {l.description ?? l.item_no ?? l.category}</option>)}
                </select>
              </div>
            </div>
            {availItem && <p className="text-xs text-muted-foreground">พร้อมจ่าย (available-to-issue): <span className="tabular font-medium text-foreground">{avail.isLoading ? '…' : num(avail.data?.available ?? 0)}</span></p>}
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setResvDlg(false)}>ปิด</Button><Button onClick={() => reserve.mutate()} disabled={!zf.item_id || !(Number(zf.qty) > 0) || reserve.isPending}>จอง</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Raise advance (site cash) */}
      <Dialog open={advDlg} onOpenChange={setAdvDlg}>
        <DialogContent>
          <DialogHeader><DialogTitle>ออกเงินทดรองจ่ายให้โครงการ — {code}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>ผู้รับเงิน</Label><Input value={af.payee} onChange={(ev) => setAf({ ...af, payee: ev.target.value })} /></div>
              <div className="grid gap-1.5"><Label>จำนวนเงิน</Label><Input type="number" min="0" value={af.amount} onChange={(ev) => setAf({ ...af, amount: ev.target.value })} /></div>
            </div>
            <div className="grid gap-1.5"><Label>วัตถุประสงค์</Label><Input value={af.purpose} onChange={(ev) => setAf({ ...af, purpose: ev.target.value })} /></div>
            <div className="grid gap-1.5"><Label>ผูกกับรายการ BoQ (ถ้ามี — จะกันงบรายการนั้น)</Label>
              <select className={selectCls} value={af.boq_line_id} onChange={(ev) => setAf({ ...af, boq_line_id: ev.target.value })}>
                <option value="">— ไม่ผูกงบ —</option>
                {boqLines.map((l: any) => <option key={l.id} value={l.id}>#{l.line_no} {l.description ?? l.item_no ?? l.category} · คงเหลือ {baht(l.remaining ?? 0)}</option>)}
              </select>
            </div>
            <p className="text-xs text-muted-foreground">เงินทดรองจะผูกกับโครงการนี้ และแสดงในเงินสดหน้างาน เมื่อเคลียร์ค่าใช้จ่ายจะกันงบ BoQ ที่เลือก (PROJ-14)</p>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setAdvDlg(false)}>ปิด</Button><Button onClick={() => raiseAdvance.mutate()} disabled={!af.payee || !(Number(af.amount) > 0) || raiseAdvance.isPending}>ออกเงินทดรอง</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Raise petty-cash request (site cash) */}
      <Dialog open={pcDlg} onOpenChange={setPcDlg}>
        <DialogContent>
          <DialogHeader><DialogTitle>ขอเบิกเงินสดย่อยให้โครงการ — {code}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>กองทุนเงินสดย่อย</Label>
                <select className={selectCls} value={pcf.fund_code} onChange={(ev) => setPcf({ ...pcf, fund_code: ev.target.value })}>
                  <option value="">— เลือกกองทุน —</option>
                  {(funds.data?.funds ?? []).map((f: any) => <option key={f.fund_code} value={f.fund_code}>{f.fund_code} · {f.name} (คงเหลือ {baht(f.balance)})</option>)}
                </select>
              </div>
              <div className="grid gap-1.5"><Label>ประเภท</Label>
                <select className={selectCls} value={pcf.kind} onChange={(ev) => setPcf({ ...pcf, kind: ev.target.value })}>
                  <option value="expense">ค่าใช้จ่าย (expense)</option><option value="advance">ทดรอง (advance)</option>
                </select>
              </div>
              <div className="grid gap-1.5"><Label>ผู้รับ/ผู้เบิก</Label><Input value={pcf.payee} onChange={(ev) => setPcf({ ...pcf, payee: ev.target.value })} /></div>
              <div className="grid gap-1.5"><Label>จำนวนเงิน</Label><Input type="number" min="0" value={pcf.amount} onChange={(ev) => setPcf({ ...pcf, amount: ev.target.value })} /></div>
            </div>
            <div className="grid gap-1.5"><Label>วัตถุประสงค์</Label><Input value={pcf.purpose} onChange={(ev) => setPcf({ ...pcf, purpose: ev.target.value })} /></div>
            <div className="grid gap-1.5"><Label>ผูกกับรายการ BoQ (ถ้ามี — จะกันงบรายการนั้น)</Label>
              <select className={selectCls} value={pcf.boq_line_id} onChange={(ev) => setPcf({ ...pcf, boq_line_id: ev.target.value })}>
                <option value="">— ไม่ผูกงบ —</option>
                {boqLines.map((l: any) => <option key={l.id} value={l.id}>#{l.line_no} {l.description ?? l.item_no ?? l.category} · คงเหลือ {baht(l.remaining ?? 0)}</option>)}
              </select>
            </div>
            <p className="text-xs text-muted-foreground">คำขอจะรออนุมัติ (ผู้อนุมัติ ≠ ผู้ขอ) เมื่ออนุมัติจะกันงบ BoQ ที่เลือกและตัดกองทุนเงินสดย่อย (PROJ-14)</p>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setPcDlg(false)}>ปิด</Button><Button onClick={() => raisePetty.mutate()} disabled={!pcf.fund_code || !(Number(pcf.amount) > 0) || raisePetty.isPending}>ส่งคำขอ</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
