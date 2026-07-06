'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderKanban, Plus, Clock, Receipt, Target, Wallet, TrendingUp, LayoutDashboard } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';

type Project = {
  project_code: string; name: string; customer_name: string | null; billing_type: string; status: string;
  contract_amount: number; cost_to_date: number; billed_to_date: number; wip: number; margin: number;
  non_billable_cost: number; total_cost: number; billed_pct: number | null; remaining_to_bill: number | null;
  budget_amount: number; budget_variance: number | null; budget_used_pct: number | null; over_budget: boolean;
};
const selectCls = 'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

export default function ProjectsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const router = useRouter();
  const q = useQuery<{ projects: Project[]; count: number }>({ queryKey: ['projects'], queryFn: () => api('/api/projects') });
  const tplQ = useQuery<{ templates: { code: string; name: string; item_count: number }[] }>({ queryKey: ['project-templates'], queryFn: () => api('/api/projects/templates') });
  const mineQ = useQuery<{ tasks: { id: number; name: string; project_code: string; project_name: string; my_role: string; planned_end: string | null; pct_complete: number; status: string }[]; count: number }>({ queryKey: ['my-tasks'], queryFn: () => api('/api/projects/my-tasks') });
  const [f, setF] = useState({ project_code: '', name: '', customer_name: '', billing_type: 'TM', contract_amount: '', template: '', rev_method: 'billing', estimated_cost: '' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['projects'] });

  const create = useMutation({
    mutationFn: async () => {
      const r = await api<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ name: f.name, project_code: f.project_code || undefined, customer_name: f.customer_name || undefined, billing_type: f.billing_type, contract_amount: Number(f.contract_amount) || 0, rev_method: f.rev_method, estimated_cost: f.rev_method === 'poc' ? Number(f.estimated_cost) || 0 : undefined }) });
      // Optional: scaffold a standard WBS + milestones from a template (B2).
      let scaffold: { tasks_created?: number; milestones_created?: number } | null = null;
      if (f.template) scaffold = await api(`/api/projects/${encodeURIComponent(r.project_code)}/apply-template/${encodeURIComponent(f.template)}`, { method: 'POST', body: JSON.stringify({}) });
      return { ...r, scaffold };
    },
    onSuccess: (r: any) => { notifySuccess(r.scaffold ? t('pj.toast_created_scaffold', { code: r.project_code, tasks: r.scaffold.tasks_created, milestones: r.scaffold.milestones_created }) : t('pj.toast_created', { code: r.project_code })); setF({ project_code: '', name: '', customer_name: '', billing_type: 'TM', contract_amount: '', template: '', rev_method: 'billing', estimated_cost: '' }); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  // cost / bill dialog
  const [dlg, setDlg] = useState<{ mode: 'cost' | 'bill'; code: string } | null>(null);
  const [amount, setAmount] = useState('');
  const [ctype, setCtype] = useState<'time' | 'expense'>('time');
  const [billable, setBillable] = useState(true);
  const [byPercent, setByPercent] = useState(false);
  const openDlg = (mode: 'cost' | 'bill', code: string) => { setDlg({ mode, code }); setAmount(''); setCtype('time'); setBillable(true); setByPercent(false); };
  const submit = useMutation({
    mutationFn: () => api<any>(`/api/projects/${dlg!.code}/${dlg!.mode}`, { method: 'POST', body: JSON.stringify(
      dlg!.mode === 'cost' ? { entry_type: ctype, amount: Number(amount) || 0, billable }
        : byPercent ? { percent: Number(amount) || 0 } : { amount: Number(amount) || 0 }) }),
    onSuccess: (r) => { notifySuccess(dlg!.mode === 'cost' ? t('pj.toast_cost_saved', { total: baht(r.cost_to_date) }) : t('pj.toast_billed', { margin: baht(r.margin), entry: r.entry_no })); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const projects = q.data?.projects ?? [];
  const wip = projects.reduce((a, p) => a + p.wip, 0);
  const margin = projects.reduce((a, p) => a + p.margin, 0);
  const billed = projects.reduce((a, p) => a + p.billed_to_date, 0);

  return (
    <div>
      <PageHeader
        title={t('pj.projects_title')}
        description={t('pj.projects_desc')}
        actions={<div className="flex gap-2">
          <Button variant="outline" onClick={() => router.push('/projects/portfolio')}><LayoutDashboard className="size-4" /> {t('pj.btn_portfolio')}</Button>
          <Button variant="outline" onClick={() => router.push('/projects/pipeline')}><Target className="size-4" /> {t('pj.btn_win_loss')}</Button>
        </div>}
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t('pj.stat_projects')} value={q.data?.count ?? 0} icon={FolderKanban} tone="primary" />
        <StatCard label={t('pj.stat_wip')} value={baht(wip)} icon={Clock} tone="info" />
        <StatCard label={t('pj.stat_billed')} value={baht(billed)} icon={Wallet} tone="default" />
        <StatCard label={t('pj.stat_margin')} value={baht(margin)} icon={TrendingUp} tone={margin < 0 ? 'danger' : 'success'} />
      </div>

      <Card className="mb-5 gap-3 p-5">
        <h3 className="text-base font-semibold">{t('pj.create_project')}</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="grid gap-1.5"><Label>{t('pj.f_name')}</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('pj.f_code')}</Label><Input value={f.project_code} onChange={(e) => setF({ ...f, project_code: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('fin.col_customer')}</Label><Input value={f.customer_name} onChange={(e) => setF({ ...f, customer_name: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('pj.billing_type')}</Label>
            <select className={selectCls} value={f.billing_type} onChange={(e) => setF({ ...f, billing_type: e.target.value })}>
              <option value="TM">{t('pj.bt_tm')}</option>
              <option value="Fixed">{t('pj.bt_fixed')}</option>
            </select>
          </div>
          <div className="grid gap-1.5"><Label>{t('pj.f_contract_amount')}</Label><Input type="number" min="0" value={f.contract_amount} onChange={(e) => setF({ ...f, contract_amount: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('pj.f_template')}</Label>
            <select className={selectCls} value={f.template} onChange={(e) => setF({ ...f, template: e.target.value })}>
              <option value="">{t('pj.opt_no_template')}</option>
              {(tplQ.data?.templates ?? []).map((tpl) => <option key={tpl.code} value={tpl.code}>{tpl.name} ({tpl.item_count})</option>)}
            </select>
          </div>
          <div className="grid gap-1.5"><Label>{t('pj.f_rev_method')}</Label>
            <select className={selectCls} value={f.rev_method} onChange={(e) => setF({ ...f, rev_method: e.target.value })}>
              <option value="billing">{t('pj.rev_billing')}</option>
              <option value="poc">{t('pj.rev_poc')}</option>
            </select>
          </div>
          {f.rev_method === 'poc' && <div className="grid gap-1.5"><Label>{t('pj.f_estimated_cost')}</Label><Input type="number" min="0" value={f.estimated_cost} onChange={(e) => setF({ ...f, estimated_cost: e.target.value })} /></div>}
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={() => create.mutate()} disabled={!f.name || create.isPending}><Plus className="size-4" /> {t('pj.btn_create')}</Button>
        </div>
      </Card>

      {!!mineQ.data?.count && (
        <Card className="mb-5 gap-3 p-5">
          <h3 className="flex items-center gap-2 text-base font-semibold"><Target className="size-4 text-primary" /> {t('pj.my_tasks')} <span className="text-sm font-normal text-muted-foreground">({mineQ.data.count})</span></h3>
          <div className="flex flex-col divide-y">
            {mineQ.data.tasks.slice(0, 8).map((task) => (
              <button key={task.id} onClick={() => router.push(`/projects/${encodeURIComponent(task.project_code)}?tab=schedule`)} className="flex items-center justify-between gap-3 py-2 text-left text-sm hover:bg-muted/40">
                <span className="flex items-center gap-2">
                  <Badge variant={task.my_role === 'accountable' ? 'default' : 'secondary'}>{task.my_role === 'accountable' ? 'A' : 'R'}</Badge>
                  <span className="font-medium">{task.name}</span>
                  <span className="text-xs text-muted-foreground">{task.project_code} · {task.project_name}</span>
                </span>
                <span className="flex items-center gap-3 text-xs text-muted-foreground">
                  {task.planned_end ? <span className="tabular">{task.planned_end}</span> : null}
                  <span className="tabular">{task.pct_complete}%</span>
                </span>
              </button>
            ))}
          </div>
        </Card>
      )}

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={projects}
            rowKey={(r: Project) => r.project_code}
            onRowClick={(r: Project) => router.push(`/projects/${encodeURIComponent(r.project_code)}`)}
            columns={[
              { key: 'project_code', label: t('pj.col_code') },
              { key: 'name', label: t('pj.col_project'), render: (r: Project) => `${r.name}${r.customer_name ? ` · ${r.customer_name}` : ''}` },
              { key: 'billing_type', label: t('pj.billing_type') },
              { key: 'cost_to_date', label: t('pj.col_cost_to_date'), align: 'right', render: (r: Project) => <span className="tabular">{baht(r.cost_to_date)}</span> },
              { key: 'budget_used_pct', label: t('pj.col_budget_used'), align: 'right', render: (r: Project) => r.budget_used_pct == null ? '—' : <span className={`tabular ${r.over_budget ? 'font-medium text-destructive' : r.budget_used_pct >= 85 ? 'text-warning-foreground dark:text-warning' : 'text-muted-foreground'}`} title={t('pj.budget_hint', { budget: baht(r.budget_amount), remaining: baht(r.budget_variance ?? 0) })}>{r.budget_used_pct}%{r.over_budget ? ' ⚠' : ''}</span> },
              { key: 'billed_to_date', label: t('pj.col_billed'), align: 'right', render: (r: Project) => <span className="tabular">{baht(r.billed_to_date)}{r.billed_pct != null ? <span className="ml-1 text-xs text-muted-foreground">({r.billed_pct}%)</span> : null}</span> },
              { key: 'wip', label: t('pj.col_wip'), align: 'right', render: (r: Project) => <span className="tabular">{baht(r.wip)}</span> },
              { key: 'non_billable_cost', label: t('pj.col_non_billable'), align: 'right', render: (r: Project) => <span className={`tabular ${r.non_billable_cost > 0 ? 'text-destructive' : 'text-muted-foreground'}`} title={t('pj.non_billable_hint')}>{baht(r.non_billable_cost)}</span> },
              { key: 'margin', label: t('pj.col_margin'), align: 'right', render: (r: Project) => <span className={`tabular ${r.margin < 0 ? 'text-destructive' : ''}`}>{baht(r.margin)}</span> },
              { key: 'status', label: t('fin.col_status'), render: (r: Project) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              {
                key: 'action', label: t('pj.col_action'), sortable: false,
                render: (r: Project) => (
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" title={t('pj.btn_log_cost')} onClick={(ev) => { ev.stopPropagation(); openDlg('cost', r.project_code); }}><Clock className="size-4" /></Button>
                    <Button variant="ghost" size="sm" title={t('pj.btn_bill')} onClick={(ev) => { ev.stopPropagation(); openDlg('bill', r.project_code); }}><Receipt className="size-4" /></Button>
                  </div>
                ),
              },
            ]}
            emptyState={{ icon: FolderKanban, title: t('pj.empty_projects_title'), description: t('pj.empty_projects_desc') }}
          />
        )}
      </StateView>

      <Dialog open={!!dlg} onOpenChange={(o) => !o && setDlg(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dlg?.mode === 'cost' ? t('pj.dlg_log_cost') : t('pj.dlg_bill_customer')} — {dlg?.code}</DialogTitle>
            <DialogDescription>{dlg?.mode === 'cost' ? t('pj.dlg_cost_desc') : t('pj.dlg_bill_desc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            {dlg?.mode === 'cost' && (
              <div className="grid gap-1.5"><Label>{t('pj.f_type')}</Label>
                <select className={selectCls} value={ctype} onChange={(e) => setCtype(e.target.value as 'time' | 'expense')}>
                  <option value="time">{t('pj.type_time')}</option>
                  <option value="expense">{t('pj.type_expense')}</option>
                </select>
              </div>
            )}
            <div className="grid gap-1.5"><Label>{dlg?.mode === 'bill' && byPercent ? t('pj.f_percent_of_contract') : t('pj.f_amount')}</Label><Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={dlg?.mode === 'bill' && byPercent ? t('pj.ph_eg_30') : ''} /></div>
            {dlg?.mode === 'cost' && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5" checked={billable} onChange={(e) => setBillable(e.target.checked)} />
                <span>{t('pj.billable_label')}<span className="block text-xs text-muted-foreground">{t('pj.billable_hint')}</span></span>
              </label>
            )}
            {dlg?.mode === 'bill' && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5" checked={byPercent} onChange={(e) => setByPercent(e.target.checked)} />
                <span>{t('pj.bill_by_pct_label')}<span className="block text-xs text-muted-foreground">{t('pj.bill_by_pct_hint')}</span></span>
              </label>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDlg(null)}>{t('pj.btn_close')}</Button>
            <Button onClick={() => submit.mutate()} disabled={!(Number(amount) > 0) || submit.isPending}>{dlg?.mode === 'cost' ? t('pj.save_cost') : t('pj.btn_bill')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
