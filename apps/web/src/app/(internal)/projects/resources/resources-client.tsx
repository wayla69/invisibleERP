'use client';

// PPM-A1 (PROJ-20) — resource capacity heatmap + skills/role supply-vs-demand (client island).
// Irreducible client boundary: runs the client-only t() hook + interactive tabs, the tag-a-skill and
// set-availability forms, and their react-query mutations. Read side reuses the existing
// resourceCapacity/resourceUtilization engine (PROJ-05) with additive calendar-aware fields — no new
// financial control, a detective PMO surface only.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Users, ShieldAlert, Tag, CalendarClock, Scale } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifyError, notifySuccess } from '@/lib/notify';
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

// green ≤ 80% of the resource's TRUE availability ceiling, amber ≤ 100% of it, red = over_allocated.
const heatTone = (c: { allocated_pct: number; over_allocated: boolean }) =>
  c.over_allocated ? 'bg-destructive/80 text-destructive-foreground' : c.allocated_pct >= 80 ? 'bg-warning/70 text-warning-foreground dark:text-warning' : c.allocated_pct > 0 ? 'bg-success/40' : 'bg-muted/40 text-muted-foreground';
const gapTone = (understaffed: boolean) => understaffed ? 'bg-destructive/80 text-destructive-foreground' : 'bg-success/40';

interface Props {
  initialCapacity?: unknown;
  initialSkills?: unknown;
  initialCalendar?: unknown;
  initialRoleDemand?: unknown;
}

export default function ResourcesClient({ initialCapacity, initialSkills, initialCalendar, initialRoleDemand }: Props) {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('pj.resources_title')} description={t('pj.resources_desc')} />
      <Tabs
        tabs={[
          { key: 'heatmap', label: t('pj.tab_heatmap'), content: <Heatmap initialCapacity={initialCapacity} /> },
          { key: 'skills', label: t('pj.tab_skills'), content: <Skills initialSkills={initialSkills} /> },
          { key: 'calendar', label: t('pj.tab_calendar'), content: <Calendar initialCalendar={initialCalendar} /> },
          { key: 'role_demand', label: t('pj.tab_role_demand'), content: <RoleDemand initialRoleDemand={initialRoleDemand} /> },
        ]}
      />
    </div>
  );
}

function Heatmap({ initialCapacity }: { initialCapacity?: unknown }) {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['proj-resources', 'capacity'], queryFn: () => api('/api/projects/resources/capacity?months=6'), initialData: initialCapacity as any });
  const d = q.data;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label={t('pj.stat_total_resources')} value={d?.resources?.length ?? 0} icon={Users} tone="primary" />
        <StatCard label={t('pj.stat_over_capacity')} value={d?.over_allocated_count ?? 0} icon={ShieldAlert} tone={(d?.over_allocated_count ?? 0) > 0 ? 'danger' : 'success'} />
      </div>
      <StateView q={q}>{d && (
        <Card className="gap-3 p-5">
          <h3 className="text-sm font-semibold">{t('pj.capacity_calendar_title')}</h3>
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-1 text-xs">
              <thead><tr><th className="text-left font-medium text-muted-foreground">{t('pj.col_resource')}</th>{(d.horizon ?? []).map((m: string) => <th key={m} className="px-1 text-center font-medium text-muted-foreground">{m.slice(2)}</th>)}</tr></thead>
              <tbody>
                {d.resources.map((r: any) => (
                  <tr key={r.resource_name}>
                    <td className="whitespace-nowrap pr-2">
                      <span className="font-medium">{r.resource_name}</span>{' '}
                      <Badge variant={r.named ? 'success' : 'muted'} className="ml-1">{r.named ? t('pj.named_badge') : t('pj.generic_badge')}</Badge>
                    </td>
                    {r.months.map((c: any) => (
                      <td key={c.month} className={`rounded px-1.5 py-1 text-center tabular ${heatTone(c)}`} title={`${c.month}: ${c.allocated_pct}% / ${t('pj.col_available_pct')} ${c.available_pct}%`}>{c.allocated_pct || ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}</StateView>
    </div>
  );
}

function Skills({ initialSkills }: { initialSkills?: unknown }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['proj-resources', 'skills'], queryFn: () => api('/api/projects/resources/skills'), initialData: initialSkills as any });
  const [resourceName, setResourceName] = useState('');
  const [skill, setSkill] = useState('');
  const [proficiency, setProficiency] = useState('');
  const save = useMutation({
    mutationFn: () => api('/api/projects/resources/skills', { method: 'POST', body: JSON.stringify({ resource_name: resourceName, skill, proficiency: proficiency || undefined }) }),
    onSuccess: () => { notifySuccess(t('pj.toast_skill_saved')); qc.invalidateQueries({ queryKey: ['proj-resources'] }); setResourceName(''); setSkill(''); setProficiency(''); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <h3 className="text-sm font-semibold">{t('pj.skill_create_title')}</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5"><Label>{t('pj.f_resource_name')}</Label><Input value={resourceName} onChange={(e) => setResourceName(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>{t('pj.f_skill')}</Label><Input value={skill} onChange={(e) => setSkill(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>{t('pj.f_proficiency')}</Label><Input value={proficiency} onChange={(e) => setProficiency(e.target.value)} /></div>
        </div>
        <Button disabled={!resourceName.trim() || !skill.trim() || save.isPending} onClick={() => save.mutate()}>{t('pj.btn_save_skill')}</Button>
      </Card>
      <StateView q={q}>{q.data && (
        <DataTable
          rows={q.data.skills}
          rowKey={(r: any, i: number) => `${r.resource_name}-${r.skill}-${i}`}
          emptyState={{ icon: Tag, title: t('pj.empty_skills_title'), description: t('pj.empty_skills_desc') }}
          columns={[
            { key: 'resource_name', label: t('pj.col_resource') },
            { key: 'skill', label: t('pj.col_skill') },
            { key: 'proficiency', label: t('pj.col_proficiency'), render: (r: any) => r.proficiency ?? '—' },
          ]}
        />
      )}</StateView>
    </div>
  );
}

function Calendar({ initialCalendar }: { initialCalendar?: unknown }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['proj-resources', 'calendar'], queryFn: () => api('/api/projects/resources/calendar'), initialData: initialCalendar as any });
  const [resourceName, setResourceName] = useState('');
  const [month, setMonth] = useState('');
  const [availablePct, setAvailablePct] = useState(100);
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => api('/api/projects/resources/calendar', { method: 'POST', body: JSON.stringify({ resource_name: resourceName, month, available_pct: availablePct, reason: reason || undefined }) }),
    onSuccess: () => { notifySuccess(t('pj.toast_calendar_saved')); qc.invalidateQueries({ queryKey: ['proj-resources'] }); setResourceName(''); setMonth(''); setAvailablePct(100); setReason(''); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <h3 className="text-sm font-semibold">{t('pj.calendar_create_title')}</h3>
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="space-y-1.5"><Label>{t('pj.f_resource_name')}</Label><Input value={resourceName} onChange={(e) => setResourceName(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>{t('pj.f_month')}</Label><Input placeholder="2026-07" value={month} onChange={(e) => setMonth(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>{t('pj.col_available_pct')}</Label><Input type="number" min={0} max={100} value={availablePct} onChange={(e) => setAvailablePct(Number(e.target.value))} /></div>
          <div className="space-y-1.5"><Label>{t('pj.f_reason')}</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        </div>
        <Button disabled={!resourceName.trim() || !/^\d{4}-\d{2}$/.test(month) || save.isPending} onClick={() => save.mutate()}>{t('pj.btn_save_calendar')}</Button>
      </Card>
      <StateView q={q}>{q.data && (
        <DataTable
          rows={q.data.entries}
          rowKey={(r: any, i: number) => `${r.resource_name}-${r.month}-${i}`}
          emptyState={{ icon: CalendarClock, title: t('pj.empty_calendar_title'), description: t('pj.empty_calendar_desc') }}
          columns={[
            { key: 'resource_name', label: t('pj.col_resource') },
            { key: 'month', label: t('pj.col_month') },
            { key: 'available_pct', label: t('pj.col_available_pct'), align: 'right', render: (r: any) => <span className="tabular">{r.available_pct}%</span> },
            { key: 'reason', label: t('pj.col_reason'), render: (r: any) => r.reason ?? '—' },
          ]}
        />
      )}</StateView>
    </div>
  );
}

function RoleDemand({ initialRoleDemand }: { initialRoleDemand?: unknown }) {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['proj-resources', 'role-demand'], queryFn: () => api('/api/projects/resources/role-demand?months=6'), initialData: initialRoleDemand as any });
  const d = q.data;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label={t('pj.stat_understaffed_roles')} value={d?.understaffed_role_count ?? 0} icon={Scale} tone={(d?.understaffed_role_count ?? 0) > 0 ? 'danger' : 'success'} />
      </div>
      <StateView q={q}>{d && (
        <Card className="gap-3 p-5">
          <h3 className="text-sm font-semibold">{t('pj.role_demand_title')}</h3>
          {!d.roles?.length ? (
            <div className="py-6 text-center text-sm text-muted-foreground">{t('pj.empty_role_demand_desc')}</div>
          ) : (
            <div className="space-y-4">
              {d.roles.map((r: any) => (
                <div key={r.role} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{r.role}</span>
                    {r.understaffed_months > 0 ? <Badge variant="destructive">{t('pj.understaffed_badge')}</Badge> : <Badge variant="success">{t('pj.staffed_badge')}</Badge>}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full border-separate border-spacing-1 text-xs">
                      <thead>
                        <tr>
                          <th className="text-left font-medium text-muted-foreground"> </th>
                          {r.months.map((c: any) => <th key={c.month} className="px-1 text-center font-medium text-muted-foreground">{c.month.slice(2)}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td className="whitespace-nowrap pr-2 text-muted-foreground">{t('pj.col_demand_pct')}</td>
                          {r.months.map((c: any) => <td key={c.month} className="rounded px-1.5 py-1 text-center tabular bg-muted/40">{c.demand_pct}</td>)}
                        </tr>
                        <tr>
                          <td className="whitespace-nowrap pr-2 text-muted-foreground">{t('pj.col_supply_pct')}</td>
                          {r.months.map((c: any) => <td key={c.month} className="rounded px-1.5 py-1 text-center tabular bg-muted/40">{c.supply_pct}</td>)}
                        </tr>
                        <tr>
                          <td className="whitespace-nowrap pr-2 text-muted-foreground">{t('pj.col_gap_pct')}</td>
                          {r.months.map((c: any) => <td key={c.month} className={`rounded px-1.5 py-1 text-center tabular ${gapTone(c.understaffed)}`}>{c.gap_pct}</td>)}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}</StateView>
    </div>
  );
}
