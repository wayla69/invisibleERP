'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ResponsiveContainer, ComposedChart, Area, Line, ReferenceLine, CartesianGrid, XAxis, YAxis, Tooltip, Legend } from 'recharts';
import { ArrowLeft, Plus, Clock, Receipt, Flag, Users, GanttChartSquare, Activity, CheckCircle2, TrendingUp, FileText } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { useLang } from '@/lib/i18n';
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
  const { t } = useLang();
  const router = useRouter();
  const qc = useQueryClient();
  const refresh = () => { for (const k of ['detail', 'evm', 'series', 'schedule', 'tasks', 'milestones', 'resources', 'risks', 'change-orders', 'health']) qc.invalidateQueries({ queryKey: ['proj', code, k] }); };

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
    onSuccess: () => { notifySuccess(t('pj.toast_task_added')); setTaskDlg(false); setTf({ name: '', planned_hours: '', planned_cost: '', planned_start: '', planned_end: '', pct_complete: '', accountable: '', responsible: '' }); refresh(); },
    onError: (err: any) => notifyError(err.message),
  });
  const markDone = useMutation({
    mutationFn: (id: number) => api(`/api/projects/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) }),
    onSuccess: () => { notifySuccess(t('pj.toast_marked_done')); refresh(); }, onError: (err: any) => notifyError(err.message),
  });

  const [msDlg, setMsDlg] = useState(false);
  const [mf, setMf] = useState({ name: '', due_date: '', billing_percent: '' });
  const addMs = useMutation({
    mutationFn: () => api(`/api/projects/${code}/milestones`, { method: 'POST', body: JSON.stringify({ name: mf.name, due_date: mf.due_date || undefined, billing_percent: Number(mf.billing_percent) || undefined }) }),
    onSuccess: () => { notifySuccess(t('pj.toast_ms_added')); setMsDlg(false); setMf({ name: '', due_date: '', billing_percent: '' }); refresh(); }, onError: (err: any) => notifyError(err.message),
  });
  const reachMs = useMutation({
    mutationFn: (id: number) => api(`/api/projects/milestones/${id}/reach`, { method: 'POST', body: '{}' }),
    onSuccess: (r: any) => { notifySuccess(r?.billing?.revenue ? t('pj.toast_ms_reached_billed', { amount: baht(r.billing.revenue) }) : t('pj.toast_ms_reached')); refresh(); }, onError: (err: any) => notifyError(err.message),
  });

  const [resDlg, setResDlg] = useState(false);
  const [rf, setRf] = useState({ resource_name: '', role: '', alloc_pct: '100' });
  const addRes = useMutation({
    mutationFn: () => api(`/api/projects/${code}/resources`, { method: 'POST', body: JSON.stringify({ resource_name: rf.resource_name, role: rf.role || undefined, alloc_pct: Number(rf.alloc_pct) || 100 }) }),
    onSuccess: () => { notifySuccess(t('pj.toast_resource_allocated')); setResDlg(false); setRf({ resource_name: '', role: '', alloc_pct: '100' }); refresh(); }, onError: (err: any) => notifyError(err.message),
  });

  const [riskDlg, setRiskDlg] = useState(false);
  const [kf, setKf] = useState({ kind: 'risk', title: '', probability: '3', impact: '3', owner: '', mitigation: '', due_date: '' });
  const addRisk = useMutation({
    mutationFn: () => api(`/api/projects/${code}/risks`, { method: 'POST', body: JSON.stringify({ kind: kf.kind, title: kf.title, probability: kf.kind === 'risk' ? Number(kf.probability) || 1 : undefined, impact: Number(kf.impact) || 1, owner: kf.owner || undefined, mitigation: kf.mitigation || undefined, due_date: kf.due_date || undefined }) }),
    onSuccess: () => { notifySuccess(t('pj.toast_risk_saved')); setRiskDlg(false); setKf({ kind: 'risk', title: '', probability: '3', impact: '3', owner: '', mitigation: '', due_date: '' }); refresh(); }, onError: (err: any) => notifyError(err.message),
  });
  const patchRisk = useMutation({
    mutationFn: (v: { id: number; body: any }) => api(`/api/projects/risks/${v.id}`, { method: 'PATCH', body: JSON.stringify(v.body) }),
    onSuccess: () => { notifySuccess(t('pj.toast_updated')); refresh(); }, onError: (err: any) => notifyError(err.message),
  });

  const [costDlg, setCostDlg] = useState<null | 'cost' | 'bill'>(null);
  const [amount, setAmount] = useState(''); const [ctype, setCtype] = useState<'time' | 'expense'>('time'); const [billable, setBillable] = useState(true); const [byPct, setByPct] = useState(false);
  const submitCost = useMutation({
    mutationFn: () => api(`/api/projects/${code}/${costDlg}`, { method: 'POST', body: JSON.stringify(costDlg === 'cost' ? { entry_type: ctype, amount: Number(amount) || 0, billable } : byPct ? { percent: Number(amount) || 0 } : { amount: Number(amount) || 0 }) }),
    onSuccess: () => { notifySuccess(costDlg === 'cost' ? t('pj.save_cost') : t('pj.toast_billed_done')); setCostDlg(null); setAmount(''); refresh(); }, onError: (err: any) => notifyError(err.message),
  });
  // POC over-time revenue recognition (PROJ-09) — recognise earned revenue cost-to-cost.
  const recognize = useMutation({
    mutationFn: () => api<any>(`/api/projects/${code}/recognize`, { method: 'POST', body: '{}' }),
    onSuccess: (r: any) => { notifySuccess(r?.already ? t('pj.toast_no_new_revenue') : t('pj.toast_revenue_recognized', { amount: baht(r.revenue_recognized), pct: r.poc_pct })); refresh(); }, onError: (err: any) => notifyError(err.message),
  });
  // Change orders / contract variations (PROJ-10) — maker-checker amendment to contract/budget.
  const cos = useQuery<any>({ queryKey: ['proj', code, 'change-orders'], queryFn: () => api(`/api/projects/${code}/change-orders`) });
  const [cf, setCf] = useState({ contract_delta: '', budget_delta: '', reason: '' });
  const requestCo = useMutation({
    mutationFn: () => api(`/api/projects/${code}/change-orders`, { method: 'POST', body: JSON.stringify({ contract_delta: Number(cf.contract_delta) || 0, budget_delta: Number(cf.budget_delta) || 0, reason: cf.reason || undefined }) }),
    onSuccess: () => { notifySuccess(t('pj.toast_co_requested')); setCf({ contract_delta: '', budget_delta: '', reason: '' }); refresh(); }, onError: (err: any) => notifyError(err.message),
  });
  const decideCo = useMutation({
    mutationFn: (v: { id: number; action: 'approve' | 'reject' }) => api(`/api/projects/change-orders/${v.id}/${v.action}`, { method: 'POST', body: '{}' }),
    onSuccess: () => { notifySuccess(t('pj.toast_co_updated')); refresh(); }, onError: (err: any) => notifyError(err.message),
  });
  // Project health history (PPM upgrade) — dated EVM/RAG trend.
  const health = useQuery<any>({ queryKey: ['proj', code, 'health'], queryFn: () => api(`/api/projects/${code}/health`) });
  const captureHealth = useMutation({
    mutationFn: () => api(`/api/projects/${code}/health`, { method: 'POST', body: '{}' }),
    onSuccess: (r: any) => { notifySuccess(t('pj.toast_health_captured', { rag: r.rag })); refresh(); }, onError: (err: any) => notifyError(err.message),
  });

  // ── Governance: baselines (PROJ-07), RACI (B3), program membership (PMO-4) ──
  const baseline = useQuery<any>({ queryKey: ['proj', code, 'baseline'], queryFn: () => api(`/api/projects/${code}/baseline`) });
  const raci = useQuery<any>({ queryKey: ['proj', code, 'raci'], queryFn: () => api(`/api/projects/${code}/raci`) });
  const [baselineReason, setBaselineReason] = useState('');
  const captureBaseline = useMutation({
    mutationFn: () => api(`/api/projects/${code}/baseline`, { method: 'POST', body: JSON.stringify({ reason: baselineReason || undefined }) }),
    onSuccess: () => { notifySuccess(t('pj.toast_baseline_set')); setBaselineReason(''); qc.invalidateQueries({ queryKey: ['proj', code, 'baseline'] }); }, onError: (err: any) => notifyError(err.message),
  });
  const [prog, setProg] = useState<{ program_code: string; depends_on: string } | null>(null);
  const progValue = prog ?? { program_code: p?.program_code ?? '', depends_on: (p?.depends_on_projects ?? []).join(', ') };
  const setProgram = useMutation({
    mutationFn: () => api(`/api/projects/${code}/program`, { method: 'PATCH', body: JSON.stringify({ program_code: progValue.program_code || null, depends_on_projects: progValue.depends_on ? String(progValue.depends_on).split(',').map((x: string) => x.trim()).filter(Boolean) : [] }) }),
    onSuccess: () => { notifySuccess(t('pj.toast_program_updated')); setProg(null); qc.invalidateQueries({ queryKey: ['proj', code, 'detail'] }); }, onError: (err: any) => notifyError(err.message),
  });

  const scurve = (series.data?.series ?? []).map((s: any) => ({ month: s.month, planned: s.cumulative_planned }));
  const ganttTasks: GanttTask[] = (schedule.data?.tasks ?? []);

  const bl = baseline.data;
  const raciData = raci.data;
  const governanceTab = (
    <div className="space-y-4">
      {/* Baseline (PROJ-07) — capture a change-controlled baseline + scope/cost creep variance */}
      <Card className="gap-3 p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">{t('pj.gov_baseline_title')}</h3>
          {bl?.baseline && <Badge variant="secondary">{bl.baseline.label} · {bl.baseline.captured_at?.slice?.(0, 10) ?? ''}</Badge>}
        </div>
        {bl?.baseline ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard label={t('pj.baseline_bac')} value={baht(bl.baseline.baseline_bac)} icon={FileText} hint={t('pj.current_amount', { amount: baht(bl.current?.bac ?? 0) })} />
            <StatCard label={t('pj.baseline_bac_delta')} value={`${(bl.variance?.bac_delta ?? 0) >= 0 ? '+' : ''}${baht(bl.variance?.bac_delta ?? 0)}`} icon={TrendingUp} tone={(bl.variance?.bac_delta ?? 0) > 0 ? 'danger' : 'success'} hint={bl.variance?.bac_pct != null ? `${bl.variance.bac_pct}%` : ''} />
            <StatCard label={t('pj.baseline_duration_delta')} value={`${(bl.variance?.duration_delta ?? 0) >= 0 ? '+' : ''}${t('pj.days', { n: bl.variance?.duration_delta ?? 0 })}`} icon={Activity} tone={(bl.variance?.duration_delta ?? 0) > 0 ? 'warning' : 'default'} hint={t('pj.baseline_days', { n: bl.baseline.baseline_duration_days })} />
          </div>
        ) : <p className="text-sm text-muted-foreground">{t('pj.no_baseline_desc')}</p>}
        <div className="flex flex-wrap items-end gap-3">
          {bl?.baseline && <div className="grid flex-1 gap-1.5"><Label>{t('pj.f_baseline_reason')}</Label><Input value={baselineReason} onChange={(e) => setBaselineReason(e.target.value)} placeholder={t('pj.ph_baseline_reason')} /></div>}
          <Button variant="outline" onClick={() => captureBaseline.mutate()} disabled={captureBaseline.isPending || (!!bl?.baseline && !baselineReason)}><Flag className="size-4" /> {bl?.baseline ? t('pj.btn_rebaseline') : t('pj.btn_set_baseline')}</Button>
        </div>
        {(bl?.history?.length ?? 0) > 1 && (
          <div className="flex flex-col divide-y text-sm">
            {bl.history.map((h: any) => (
              <div key={h.id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="flex items-center gap-2"><Badge variant={h.status === 'active' ? 'success' : 'muted'}>{h.status}</Badge><span className="font-medium">{h.label}</span>{h.reason && <span className="text-xs text-muted-foreground">· {h.reason}</span>}</span>
                <span className="tabular text-xs text-muted-foreground">{baht(h.baseline_bac)} · {t('pj.days', { n: h.baseline_duration_days })} · {h.captured_at?.slice?.(0, 10)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* RACI accountability matrix (B3) */}
      <Card className="gap-3 p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">{t('pj.raci_title')}</h3>
          {raciData && (raciData.complete ? <Badge variant="success">{t('pj.raci_complete')}</Badge> : <Badge variant="destructive">{t('pj.raci_missing', { n: raciData.missing_accountable.length })}</Badge>)}
        </div>
        {raciData?.people?.length ? (
          <DataTable
            rows={raciData.people}
            rowKey={(r: any) => r.name}
            columns={[
              { key: 'name', label: t('pj.col_person') },
              { key: 'accountable', label: t('pj.col_accountable'), align: 'right' },
              { key: 'responsible', label: t('pj.col_responsible'), align: 'right' },
              { key: 'consulted', label: t('pj.col_consulted'), align: 'right' },
              { key: 'informed', label: t('pj.col_informed'), align: 'right' },
            ]}
            emptyState={{ icon: Users, title: t('pj.empty_raci_title'), description: t('pj.empty_raci_desc') }}
          />
        ) : <p className="text-sm text-muted-foreground">{t('pj.no_raci_desc')}</p>}
        {raciData && !raciData.complete && (
          <p className="text-xs text-destructive">{t('pj.raci_missing_list', { ids: raciData.missing_accountable.join(', #') })}</p>
        )}
      </Card>

      {/* Program membership + cross-project dependencies (PMO-4) */}
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('pj.program_title')}</h3>
        <p className="text-xs text-muted-foreground">{t('pj.program_desc')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label>{t('pj.f_program_code')}</Label><Input value={progValue.program_code} onChange={(e) => setProg({ ...progValue, program_code: e.target.value })} placeholder={t('pj.ph_prog_a')} /></div>
          <div className="grid gap-1.5"><Label>{t('pj.f_depends_on')}</Label><Input value={progValue.depends_on} onChange={(e) => setProg({ ...progValue, depends_on: e.target.value })} placeholder={t('pj.ph_depends')} /></div>
        </div>
        <div><Button variant="outline" onClick={() => setProgram.mutate()} disabled={setProgram.isPending}><CheckCircle2 className="size-4" /> {t('fin.save')}</Button></div>
      </Card>
    </div>
  );

  const overview = (
    <div className="space-y-4">
      {/* EVM headline */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t('pj.stat_pct_complete')} value={pct(p?.pct_complete ?? 0)} icon={Activity} tone="primary" hint={t('pj.n_tasks', { n: p?.task_count ?? 0 })} />
        <StatCard label={t('pj.stat_cpi')} value={e?.cpi ?? '—'} icon={Activity} tone={indexTone(e?.cpi)} hint={e?.cpi != null ? (e.cpi >= 1 ? t('pj.within_budget') : t('pj.over_budget')) : 'EV / AC'} />
        <StatCard label={t('pj.stat_spi')} value={e?.spi ?? '—'} icon={Activity} tone={indexTone(e?.spi)} hint={e?.spi != null ? (e.spi >= 1 ? t('pj.on_or_ahead') : t('pj.behind_schedule')) : 'EV / PV'} />
        <StatCard label={t('pj.stat_margin')} value={baht(p?.margin ?? 0)} icon={Receipt} tone={(p?.margin ?? 0) < 0 ? 'danger' : 'success'} hint={t('pj.wip_hint', { amount: baht(p?.wip ?? 0) })} />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="gap-3 p-5 lg:col-span-3">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold">{t('pj.scurve_title')}</h3>
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
                <Area type="monotone" name={t('pj.series_pv')} dataKey="planned" stroke="var(--chart-1)" strokeWidth={2} fill="url(#grad-pv)" />
                {e?.ev != null && <ReferenceLine y={e.ev} stroke="var(--chart-3)" strokeDasharray="4 4" label={{ value: `EV ${baht(e.ev)}`, position: 'insideTopLeft', fontSize: 11, fill: 'var(--chart-3)' }} />}
                {e?.ac != null && <ReferenceLine y={e.ac} stroke="var(--destructive)" strokeDasharray="4 4" label={{ value: `AC ${baht(e.ac)}`, position: 'insideBottomLeft', fontSize: 11, fill: 'var(--destructive)' }} />}
              </ComposedChart>
            </ResponsiveContainer>
          ) : <div className="py-12 text-center text-sm text-muted-foreground">{t('pj.scurve_empty')}</div>}
        </Card>

        <Card className="gap-0 p-5 lg:col-span-2">
          <h3 className="mb-3 text-base font-semibold">{t('pj.ev_title')}</h3>
          <dl className="space-y-2.5 text-sm">
            {[
              [t('pj.ev_bac'), baht(e?.bac ?? 0)],
              [t('pj.ev_pv'), baht(e?.pv ?? 0)],
              [t('pj.ev_ev'), baht(e?.ev ?? 0)],
              [t('pj.ev_ac'), baht(e?.ac ?? 0)],
              [t('pj.ev_cv'), baht(e?.cost_variance ?? 0)],
              [t('pj.ev_sv'), baht(e?.schedule_variance ?? 0)],
              [t('pj.ev_eac'), baht(e?.eac ?? 0)],
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
          <h3 className="text-base font-semibold">{t('pj.co_title')}</h3>
          {cos.data?.summary?.approved > 0 && <Badge variant="secondary">{t('pj.co_net', { amount: baht(cos.data.summary.approved_contract_delta) })}</Badge>}
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="grid gap-1.5"><Label>{t('pj.f_contract_delta')}</Label><Input type="number" value={cf.contract_delta} onChange={(ev) => setCf({ ...cf, contract_delta: ev.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('pj.f_budget_delta')}</Label><Input type="number" value={cf.budget_delta} onChange={(ev) => setCf({ ...cf, budget_delta: ev.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('pj.f_reason')}</Label><Input value={cf.reason} onChange={(ev) => setCf({ ...cf, reason: ev.target.value })} /></div>
          <div className="flex items-end"><Button size="sm" variant="outline" onClick={() => requestCo.mutate()} disabled={requestCo.isPending || (!cf.contract_delta && !cf.budget_delta)}><Plus className="size-4" /> {t('pj.btn_request_co')}</Button></div>
        </div>
        <div className="flex flex-col divide-y">
          {(cos.data?.change_orders ?? []).map((c: any) => (
            <div key={c.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="flex flex-wrap items-center gap-2">
                <Badge variant={c.status === 'approved' ? 'success' : c.status === 'rejected' ? 'muted' : 'warning'}>{c.status === 'approved' ? t('fin.approve') : c.status === 'rejected' ? t('pj.status_rejected') : t('pj.status_pending')}</Badge>
                <span className="font-medium">{c.co_no}</span>
                <span className="tabular text-muted-foreground">{t('pj.contract_amount_delta', { delta: `${c.contract_delta >= 0 ? '+' : ''}${baht(c.contract_delta)}` })}</span>
                {c.reason && <span className="text-xs text-muted-foreground">· {c.reason}</span>}
                <span className="text-xs text-muted-foreground">{t('pj.requested_by', { who: c.requested_by })}</span>
              </span>
              {c.status === 'pending' && (
                <span className="flex gap-1">
                  <Button size="sm" variant="ghost" title={t('pj.approve_not_requester')} onClick={() => decideCo.mutate({ id: c.id, action: 'approve' })}><CheckCircle2 className="size-4" /></Button>
                </span>
              )}
            </div>
          ))}
          {!cos.data?.count && <p className="py-2 text-sm text-muted-foreground">{t('pj.co_empty')}</p>}
        </div>
      </Card>

      {/* Project health history (PPM upgrade) — CPI/SPI trend over snapshots */}
      <Card className="gap-3 p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">{t('pj.health_trend_title')}</h3>
          <Button size="sm" variant="outline" onClick={() => captureHealth.mutate()} disabled={captureHealth.isPending}><Activity className="size-4" /> {t('pj.btn_capture_health')}</Button>
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
          <p className="py-6 text-center text-sm text-muted-foreground">{t('pj.health_trend_hint_pre')}<span className="font-medium">project_health_capture</span>{t('pj.health_trend_hint_post')}</p>
        )}
      </Card>
    </div>
  );

  const scheduleTab = (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {t('pj.project_duration_label')} <span className="font-medium text-foreground">{t('pj.days', { n: schedule.data?.project_duration_days ?? 0 })}</span>
          {' · '}{t('pj.critical_path_label')} <span className="font-medium text-primary">{t('pj.n_tasks', { n: (schedule.data?.critical_path ?? []).length })}</span>
        </div>
        <Button size="sm" onClick={() => setTaskDlg(true)}><Plus className="size-4" /> {t('pj.btn_add_task')}</Button>
      </div>
      <StateView q={schedule}>{schedule.data && <ProjectGantt tasks={ganttTasks} totalDays={schedule.data.project_duration_days ?? 1} />}</StateView>
      {tasks.data && (
        <DataTable
          rows={tasks.data.tasks ?? []}
          columns={[
            { key: 'name', label: t('pj.col_task') },
            { key: 'pct_complete', label: t('pj.col_progress'), align: 'right', render: (r: any) => (
              <div className="ml-auto flex w-28 items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, r.pct_complete)}%` }} /></div>
                <span className="tabular w-9 text-right text-xs">{r.pct_complete}%</span>
              </div>
            ) },
            { key: 'planned_hours', label: t('pj.col_hours'), align: 'right', render: (r: any) => <span className="tabular">{r.planned_hours}</span> },
            { key: 'planned_cost', label: t('pj.col_budget'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.planned_cost)}</span> },
            { key: 'depends_on', label: t('pj.col_depends_on'), render: (r: any) => r.depends_on?.length ? `#${r.depends_on.join(', #')}` : '—' },
            { key: 'accountable', label: t('pj.col_raci'), sortable: false, render: (r: any) => (
              <div className="flex flex-wrap items-center gap-1">
                {r.accountable ? <Badge variant="default" title={t('pj.tip_accountable')}>A: {r.accountable}</Badge> : <span className="text-xs text-muted-foreground" title={t('pj.tip_no_accountable')}>{t('pj.no_a')}</span>}
                {r.responsible?.length ? <span className="text-xs text-muted-foreground" title={t('pj.tip_responsible')}>R: {r.responsible.join(', ')}</span> : null}
              </div>
            ) },
            { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
            { key: 'act', label: '', sortable: false, render: (r: any) => r.status !== 'done' && r.status !== 'cancelled'
              ? <Button variant="ghost" size="sm" title={t('pj.tip_mark_done')} onClick={() => markDone.mutate(r.id)}><CheckCircle2 className="size-4" /></Button> : null },
          ]}
          emptyState={{ icon: GanttChartSquare, title: t('pj.empty_tasks_title'), description: t('pj.empty_tasks_desc') }}
        />
      )}
    </div>
  );

  const milestonesTab = (
    <div className="space-y-4">
      <div className="flex justify-end"><Button size="sm" onClick={() => setMsDlg(true)}><Plus className="size-4" /> {t('pj.btn_add_ms')}</Button></div>
      {milestones.data && (
        <DataTable
          rows={milestones.data.milestones ?? []}
          columns={[
            { key: 'name', label: t('pj.col_milestone') },
            { key: 'due_date', label: t('pj.col_due') },
            { key: 'billing_percent', label: t('pj.col_billing_pct'), align: 'right', render: (r: any) => r.billing_percent != null ? `${r.billing_percent}%` : '—' },
            { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
            { key: 'act', label: '', sortable: false, render: (r: any) => r.status !== 'reached'
              ? <Button variant="ghost" size="sm" title={t('pj.tip_reach_ms')} onClick={() => reachMs.mutate(r.id)}><Flag className="size-4" /></Button> : null },
          ]}
          emptyState={{ icon: Flag, title: t('pj.empty_ms_title'), description: t('pj.empty_ms_desc') }}
        />
      )}
    </div>
  );

  const resourcesTab = (
    <div className="space-y-4">
      <div className="flex justify-end"><Button size="sm" onClick={() => setResDlg(true)}><Plus className="size-4" /> {t('pj.btn_alloc_resource')}</Button></div>
      {resources.data && (
        <DataTable
          rows={resources.data.resources ?? []}
          columns={[
            { key: 'resource_name', label: t('pj.col_resource') },
            { key: 'role', label: t('pj.col_role'), render: (r: any) => r.role ?? '—' },
            { key: 'alloc_pct', label: t('pj.col_alloc'), align: 'right', render: (r: any) => `${r.alloc_pct}%` },
            { key: 'cost_rate', label: t('pj.col_cost_rate'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.cost_rate)}</span> },
            { key: 'bill_rate', label: t('pj.col_bill_rate'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.bill_rate)}</span> },
          ]}
          emptyState={{ icon: Users, title: t('pj.empty_alloc_title'), description: t('pj.empty_alloc_desc') }}
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
              <Badge variant="secondary">{t('pj.poc_badge')}</Badge>
              <span className="text-muted-foreground">{t('pj.completed_label')} <span className="tabular font-medium text-foreground">{p.poc_pct ?? 0}%</span></span>
              <span className="text-muted-foreground">{t('pj.recognized_label')} <span className="tabular font-medium text-foreground">{baht(p.recognized_revenue ?? 0)}</span></span>
              {p.contract_asset > 0 && <span className="text-muted-foreground">{t('pj.contract_asset_label')} <span className="tabular text-primary">{baht(p.contract_asset)}</span></span>}
              {p.billings_in_excess > 0 && <span className="text-muted-foreground">{t('pj.billings_excess_label')} <span className="tabular text-warning-foreground dark:text-warning">{baht(p.billings_in_excess)}</span></span>}
            </div>
            <Button size="sm" variant="outline" onClick={() => recognize.mutate()} disabled={recognize.isPending}><TrendingUp className="size-4" /> {t('pj.btn_recognize')}</Button>
          </div>
        </Card>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={() => { setCostDlg('cost'); setAmount(''); setCtype('time'); setBillable(true); }}><Clock className="size-4" /> {t('pj.btn_log_cost')}</Button>
        <Button size="sm" onClick={() => { setCostDlg('bill'); setAmount(''); setByPct(false); }}><Receipt className="size-4" /> {p?.rev_method === 'poc' ? t('pj.btn_invoice') : t('pj.btn_bill')}</Button>
      </div>
      {detail.data && (
        <DataTable
          rows={p?.entries ?? []}
          columns={[
            { key: 'entry_date', label: t('dash.col_date') },
            { key: 'entry_type', label: t('pj.col_type') },
            { key: 'description', label: t('pj.col_description'), render: (r: any) => r.description ?? '—' },
            { key: 'billable', label: t('pj.col_billable'), render: (r: any) => r.billable ? <Badge variant="success">billable</Badge> : <Badge variant="muted">non-billable</Badge> },
            { key: 'amount', label: t('pj.col_amount'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
            { key: 'entry_no', label: 'JE', render: (r: any) => <span className="text-xs text-muted-foreground">{r.entry_no ?? '—'}</span> },
          ]}
          emptyState={{ icon: Clock, title: t('pj.empty_cost_title'), description: t('pj.empty_cost_desc') }}
        />
      )}
    </div>
  );

  const ragBadge = (rag: string) => <Badge variant={rag === 'red' ? 'destructive' : rag === 'amber' ? 'warning' : 'success'}>{rag === 'red' ? t('pj.rag_high') : rag === 'amber' ? t('pj.rag_med') : t('pj.rag_low')}</Badge>;
  const rs = risks.data?.summary;
  const risksTab = (
    <div className="space-y-4">
      {rs && (
        <div className="grid gap-3 sm:grid-cols-4">
          <StatCard label={t('pj.stat_open')} value={String(rs.open)} icon={Activity} />
          <StatCard label={t('pj.stat_high_open')} value={String(rs.high_open)} icon={Activity} tone={rs.high_open > 0 ? 'warning' : 'default'} />
          <StatCard label={t('pj.stat_unmitigated_high')} value={String(rs.unmitigated_high)} icon={Activity} tone={rs.unmitigated_high > 0 ? 'danger' : 'success'} />
          <StatCard label={t('pj.stat_closed')} value={String(rs.closed)} icon={CheckCircle2} />
        </div>
      )}
      <div className="flex justify-end"><Button size="sm" onClick={() => setRiskDlg(true)}><Plus className="size-4" /> {t('pj.btn_add_risk')}</Button></div>
      {risks.data && (
        <DataTable
          rows={risks.data.risks ?? []}
          columns={[
            { key: 'rag', label: t('pj.col_level'), sortable: false, render: (r: any) => ragBadge(r.rag) },
            { key: 'kind', label: t('pj.col_type'), render: (r: any) => r.kind === 'issue' ? t('pj.kind_issue') : t('pj.kind_risk') },
            { key: 'title', label: t('pj.col_title') },
            { key: 'score', label: t('pj.col_score'), align: 'right', render: (r: any) => <span className="tabular" title={r.kind === 'issue' ? t('pj.tip_impact', { n: r.impact }) : t('pj.tip_prob_impact', { p: r.probability, i: r.impact })}>{r.score}</span> },
            { key: 'owner', label: t('pj.col_owner'), render: (r: any) => r.owner ?? '—' },
            { key: 'mitigation', label: t('pj.col_mitigation'), render: (r: any) => r.mitigation ? <span className="text-xs">{r.mitigation}</span> : <span className="text-xs text-destructive">{t('pj.none_yet')}</span> },
            { key: 'due_date', label: t('pj.col_due'), render: (r: any) => r.due_date ?? '—' },
            { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
            { key: 'act', label: '', sortable: false, render: (r: any) => r.status !== 'closed'
              ? <Button variant="ghost" size="sm" title={t('pj.btn_close')} onClick={() => patchRisk.mutate({ id: r.id, body: { status: 'closed' } })}><CheckCircle2 className="size-4" /></Button> : null },
          ]}
          emptyState={{ icon: Activity, title: t('pj.empty_risks_title'), description: t('pj.empty_risks_desc') }}
        />
      )}
    </div>
  );

  return (
    <div>
      <button onClick={() => router.push('/projects')} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> {t('pj.all_projects')}</button>
      <PageHeader
        title={<span className="flex items-center gap-2">{p?.name ?? code} {p && <Badge variant={statusVariant(p.status)}>{p.status}</Badge>}</span>}
        description={<span>{code}{p?.customer_name ? ` · ${p.customer_name}` : ''} · {p?.billing_type === 'Fixed' ? t('pj.bt_fixed') : t('pj.bt_tm')}{p?.contract_amount ? ` · ${t('pj.contract_amount_label', { amount: baht(p.contract_amount) })}` : ''}</span>}
        actions={<Button variant="outline" onClick={() => router.push(`/projects/${encodeURIComponent(code)}/status`)}><FileText className="size-4" /> {t('pj.btn_status_report')}</Button>}
      />
      <StateView q={detail}>
        <Tabs
          urlParam="tab"
          tabs={[
            { key: 'overview', label: t('pj.tab_overview'), content: overview },
            { key: 'schedule', label: t('pj.tab_schedule'), content: scheduleTab },
            { key: 'milestones', label: t('pj.tab_milestones'), content: milestonesTab },
            { key: 'resources', label: t('pj.tab_resources'), content: resourcesTab },
            { key: 'risks', label: t('pj.tab_risks'), content: risksTab },
            { key: 'governance', label: t('pj.tab_governance'), content: governanceTab },
            { key: 'costs', label: t('pj.tab_costs'), content: costsTab },
          ]}
        />
      </StateView>

      {/* Add task */}
      <Dialog open={taskDlg} onOpenChange={setTaskDlg}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('pj.dlg_add_task')}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5"><Label>{t('pj.f_task_name')}</Label><Input value={tf.name} onChange={(ev) => setTf({ ...tf, name: ev.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>{t('pj.f_planned_hours')}</Label><Input type="number" min="0" value={tf.planned_hours} onChange={(ev) => setTf({ ...tf, planned_hours: ev.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('pj.f_budget')}</Label><Input type="number" min="0" value={tf.planned_cost} onChange={(ev) => setTf({ ...tf, planned_cost: ev.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('pj.f_start')}</Label><Input type="date" value={tf.planned_start} onChange={(ev) => setTf({ ...tf, planned_start: ev.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('pj.f_end')}</Label><Input type="date" value={tf.planned_end} onChange={(ev) => setTf({ ...tf, planned_end: ev.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('pj.f_pct_complete')}</Label><Input type="number" min="0" max="100" value={tf.pct_complete} onChange={(ev) => setTf({ ...tf, pct_complete: ev.target.value })} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>{t('pj.f_accountable')}</Label><Input value={tf.accountable} onChange={(ev) => setTf({ ...tf, accountable: ev.target.value })} placeholder={t('pj.ph_one_user')} /></div>
              <div className="grid gap-1.5"><Label>{t('pj.f_responsible')}</Label><Input value={tf.responsible} onChange={(ev) => setTf({ ...tf, responsible: ev.target.value })} placeholder={t('pj.ph_comma')} /></div>
            </div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setTaskDlg(false)}>{t('pj.btn_close')}</Button><Button onClick={() => addTask.mutate()} disabled={!tf.name || addTask.isPending}>{t('pj.btn_add')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add milestone */}
      <Dialog open={msDlg} onOpenChange={setMsDlg}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('pj.btn_add_ms')}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5"><Label>{t('pj.f_ms_name')}</Label><Input value={mf.name} onChange={(ev) => setMf({ ...mf, name: ev.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>{t('pj.col_due')}</Label><Input type="date" value={mf.due_date} onChange={(ev) => setMf({ ...mf, due_date: ev.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('pj.f_billing_pct')}</Label><Input type="number" min="0" max="100" value={mf.billing_percent} onChange={(ev) => setMf({ ...mf, billing_percent: ev.target.value })} /></div>
            </div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setMsDlg(false)}>{t('pj.btn_close')}</Button><Button onClick={() => addMs.mutate()} disabled={!mf.name || addMs.isPending}>{t('pj.btn_add')}</Button></DialogFooter>
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
