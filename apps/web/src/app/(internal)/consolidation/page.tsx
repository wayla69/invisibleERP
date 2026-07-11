'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, Layers, ListTree, PlayCircle, Rows3, Plus, Trash2, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useLang } from '@/lib/i18n';
import { Select } from '@/components/form-controls';

const currentPeriod = () => new Date().toISOString().slice(0, 7);

interface Group {
  id: number;
  name: string;
  base_currency: string;
  fiscal_year: number;
  notes: string | null;
  created_by: string;
  created_at: string | null;
}
interface GroupsResp { groups: Group[]; count: number }
interface Entity { id: number; entity_tenant_id: number; ownership_pct: number; entity_currency: string }
interface EntitiesResp { entities: Entity[] }
interface Run { id: number; period: string; status: string; run_by: string; run_at: string | null }
interface RunsResp { runs: Run[] }
interface RunLine {
  id: number;
  line_type: string;
  entity_tenant_id: number | null;
  account_code: string;
  amount_thb: number;
  notes: string | null;
}
interface RunLinesResp { run_id: number; lines: RunLine[] }

export default function ConsolidationPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('fnx.consol.title')}
        description={t('fnx.consol.subtitle')}
      />
      <Tabs
        tabs={[
          { key: 'groups', label: t('fnx.consol.tab_groups'), content: <GroupsTab /> },
          { key: 'runs', label: t('fnx.consol.tab_runs'), content: <RunsTab /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── กลุ่มบริษัท + entities ─────────────────────────
function GroupsTab() {
  const { t } = useLang();
  const q = useQuery<GroupsResp>({ queryKey: ['consol-groups'], queryFn: () => api('/api/consolidation/groups') });
  const [selected, setSelected] = useState<number | null>(null);

  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard label={t('fnx.consol.stat_group_count')} value={q.data.count} icon={Layers} tone="primary" hint={t('fnx.consol.setup_hint')} />
          </div>
          <NewGroupForm />
          <DataTable
            rows={q.data.groups}
            rowKey={(r) => r.id}
            onRowClick={(r) => setSelected(r.id)}
            columns={[
              { key: 'name', label: t('fnx.consol.col_group_name'), render: (r) => <span className="font-medium">{r.name}</span> },
              { key: 'fiscal_year', label: t('fnx.consol.col_fiscal_year'), align: 'right', render: (r) => <span className="tabular">{r.fiscal_year}</span> },
              { key: 'base_currency', label: t('fnx.consol.col_base_currency') },
              { key: 'created_by', label: t('fnx.consol.col_created_by') },
              { key: 'created_at', label: t('fnx.consol.col_created_at'), render: (r) => (r.created_at ? thaiDate(r.created_at) : '—') },
            ]}
            emptyState={{
              icon: Layers,
              title: t('fnx.consol.empty_groups_title'),
              description: t('fnx.consol.empty_groups_desc'),
            }}
          />
          {selected != null && <GroupEntities groupId={selected} />}
        </div>
      )}
    </StateView>
  );
}

function NewGroupForm() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [fiscalYear, setFiscalYear] = useState(String(new Date().getFullYear()));
  const [baseCurrency, setBaseCurrency] = useState('THB');
  const [notes, setNotes] = useState('');
  const create = useMutation({
    mutationFn: () => api<Group>('/api/consolidation/groups', {
      method: 'POST',
      body: JSON.stringify({ name, fiscal_year: Number(fiscalYear), base_currency: baseCurrency || undefined, notes: notes || undefined }),
    }),
    onSuccess: (g) => { notifySuccess(t('fnx.consol.group_created', { name: g.name })); setName(''); setNotes(''); qc.invalidateQueries({ queryKey: ['consol-groups'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  return (
    <Card className="max-w-2xl gap-4">
      <CardHeader><CardTitle className="text-base">{t('fnx.consol.new_group_title')}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2"><Label htmlFor="ng-name">{t('fnx.consol.field_name')}</Label><Input id="ng-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="grid gap-2"><Label htmlFor="ng-fy">{t('fnx.consol.col_fiscal_year')}</Label><Input id="ng-fy" type="number" value={fiscalYear} onChange={(e) => setFiscalYear(e.target.value)} /></div>
          <div className="grid gap-2"><Label htmlFor="ng-cur">{t('fnx.consol.col_base_currency')}</Label><Input id="ng-cur" value={baseCurrency} onChange={(e) => setBaseCurrency(e.target.value)} /></div>
          <div className="grid gap-2"><Label htmlFor="ng-notes">{t('fnx.consol.field_notes')}</Label><Input id="ng-notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>
        <Button disabled={!name || !/^\d{4}$/.test(fiscalYear) || create.isPending} onClick={() => create.mutate()}>
          <Plus className="size-4" /> {t('fnx.consol.create_group_btn')}
        </Button>
      </CardContent>
    </Card>
  );
}

function GroupEntities({ groupId }: { groupId: number }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<EntitiesResp>({ queryKey: ['consol-entities', groupId], queryFn: () => api(`/api/consolidation/groups/${groupId}/entities`) });
  const [tid, setTid] = useState('');
  const [ownership, setOwnership] = useState('100');
  const [currency, setCurrency] = useState('THB');
  const [removing, setRemoving] = useState<number | null>(null);

  const add = useMutation({
    mutationFn: () => api(`/api/consolidation/groups/${groupId}/entities`, {
      method: 'POST',
      body: JSON.stringify({ entity_tenant_id: Number(tid), ownership_pct: ownership === '' ? undefined : Number(ownership), entity_currency: currency || undefined }),
    }),
    onSuccess: () => { notifySuccess(t('fnx.consol.entity_added', { tid })); setTid(''); qc.invalidateQueries({ queryKey: ['consol-entities', groupId] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const remove = useMutation({
    mutationFn: (entityTid: number) => api(`/api/consolidation/groups/${groupId}/entities/${entityTid}`, { method: 'DELETE' }),
    onSuccess: (_d, entityTid) => { notifySuccess(t('fnx.consol.entity_removed', { tid: entityTid })); setRemoving(null); qc.invalidateQueries({ queryKey: ['consol-entities', groupId] }); },
    onError: (e: Error) => { notifyError(e.message); setRemoving(null); },
  });

  return (
    <Card className="gap-4 p-5">
      <CardHeader className="p-0">
        <CardTitle className="text-base">{t('fnx.consol.entities_title', { id: groupId })}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 p-0">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-2"><Label htmlFor="ae-tid">{t('fnx.consol.field_entity_tid')}</Label><Input id="ae-tid" type="number" className="max-w-[140px]" value={tid} onChange={(e) => setTid(e.target.value)} /></div>
          <div className="grid gap-2"><Label htmlFor="ae-own">{t('fnx.consol.field_ownership')}</Label><Input id="ae-own" type="number" min="0" max="100" className="max-w-[120px]" value={ownership} onChange={(e) => setOwnership(e.target.value)} /></div>
          <div className="grid gap-2"><Label htmlFor="ae-cur">{t('fnx.consol.col_currency')}</Label><Input id="ae-cur" className="max-w-[100px]" value={currency} onChange={(e) => setCurrency(e.target.value)} /></div>
          <Button disabled={!tid || add.isPending} onClick={() => add.mutate()}><Plus className="size-4" /> {t('fnx.consol.add_entity_btn')}</Button>
        </div>
        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={q.data.entities}
              rowKey={(r) => r.id}
              columns={[
                { key: 'entity_tenant_id', label: t('fnx.consol.col_entity'), render: (r) => <span className="font-medium">#{r.entity_tenant_id}</span> },
                { key: 'ownership_pct', label: t('fnx.consol.col_ownership'), align: 'right', render: (r) => <span className="tabular">{r.ownership_pct}%</span> },
                { key: 'entity_currency', label: t('fnx.consol.col_currency') },
                { key: 'actions', label: t('fnx.consol.col_actions'), align: 'right', render: (r) => (
                  <Button size="sm" variant="outline" onClick={() => setRemoving(r.entity_tenant_id)}><Trash2 className="size-3.5" /> {t('fnx.consol.remove_entity')}</Button>
                ) },
              ]}
              emptyState={{ icon: Building2, title: t('fnx.consol.empty_entities_title') }}
            />
          )}
        </StateView>
        <ConfirmDialog
          open={removing != null}
          onOpenChange={(o) => !o && setRemoving(null)}
          title={t('fnx.consol.remove_entity_confirm', { tid: removing ?? '' })}
          busy={remove.isPending}
          onConfirm={() => removing != null && remove.mutate(removing)}
        />
      </CardContent>
    </Card>
  );
}

// ───────────────────────── การรวมงบ (runs) ─────────────────────────
function RunsTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const groups = useQuery<GroupsResp>({ queryKey: ['consol-groups'], queryFn: () => api('/api/consolidation/groups') });
  const [groupId, setGroupId] = useState<number | null>(null);
  const [period, setPeriod] = useState(currentPeriod());
  const [openRun, setOpenRun] = useState<number | null>(null);
  const [posting, setPosting] = useState<number | null>(null);

  const gid = groupId ?? groups.data?.groups[0]?.id ?? null;

  const runs = useQuery<RunsResp>({
    queryKey: ['consol-runs', gid],
    queryFn: () => api(`/api/consolidation/groups/${gid}/runs`),
    enabled: gid != null,
  });

  const run = useMutation({
    mutationFn: () =>
      api<{ run_id: number; entity_count: number; ic_eliminations: number; status: string }>(`/api/consolidation/groups/${gid}/run`, {
        method: 'POST',
        body: JSON.stringify({ period }),
      }),
    onSuccess: (r) => {
      notifySuccess(t('fnx.consol.run_success', { run_id: r.run_id, entity_count: r.entity_count, ic_eliminations: r.ic_eliminations, status: r.status }));
      qc.invalidateQueries({ queryKey: ['consol-runs', gid] });
    },
    onError: (e: Error) => notifyError(e.message),
  });

  const post = useMutation({
    mutationFn: (runId: number) => api<{ run_id: number }>(`/api/consolidation/runs/${runId}/post`, { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(t('fnx.consol.posted_ok', { id: r.run_id })); setPosting(null); qc.invalidateQueries({ queryKey: ['consol-runs', gid] }); },
    onError: (e: Error) => { notifyError(e.message); setPosting(null); },
  });

  return (
    <div className="space-y-5">
      <Card className="max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">{t('fnx.consol.run_card_title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-2">
              <Label htmlFor="consol-group">{t('fnx.consol.field_group')}</Label>
              <Select
                id="consol-group"
                className="w-auto"
                value={gid ?? ''}
                onChange={(e) => setGroupId(Number(e.target.value))}
              >
                {groups.data?.groups.length ? (
                  groups.data.groups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name} ({g.fiscal_year})</option>
                  ))
                ) : (
                  <option value="">{t('fnx.consol.opt_no_group')}</option>
                )}
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="consol-period">{t('fnx.consol.field_period')}</Label>
              <Input id="consol-period" className="max-w-[160px]" placeholder="2026-06" value={period} onChange={(e) => setPeriod(e.target.value)} />
            </div>
            <Button disabled={run.isPending || gid == null || !/^\d{4}-\d{2}$/.test(period)} onClick={() => run.mutate()}>
              <PlayCircle className="size-4" /> {run.isPending ? t('fnx.consol.running') : t('fnx.consol.run_btn')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {gid != null && (
        <StateView q={runs}>
          {runs.data && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <StatCard label={t('fnx.consol.stat_run_count')} value={runs.data.runs.length} icon={Building2} tone="primary" />
              </div>
              <DataTable
                rows={runs.data.runs}
                rowKey={(r) => r.id}
                onRowClick={(r) => setOpenRun((cur) => (cur === r.id ? null : r.id))}
                columns={[
                  { key: 'id', label: t('fnx.consol.col_run'), render: (r) => <span className="font-medium">#{r.id}</span> },
                  { key: 'period', label: t('fnx.consol.col_period') },
                  { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                  { key: 'run_by', label: t('fnx.consol.col_by') },
                  { key: 'run_at', label: t('fnx.consol.col_time'), render: (r) => (r.run_at ? thaiDate(r.run_at) : '—') },
                  { key: 'actions', label: t('fnx.consol.col_actions'), align: 'right', render: (r) => (
                    r.status === 'Final'
                      ? <Button size="sm" onClick={(e) => { e.stopPropagation(); setPosting(r.id); }}><Send className="size-3.5" /> {t('fnx.consol.post_btn')}</Button>
                      : <span className="text-xs text-muted-foreground">—</span>
                  ) },
                ]}
                emptyState={{
                  icon: Rows3,
                  title: t('fnx.consol.empty_runs_title'),
                  description: t('fnx.consol.empty_runs_desc'),
                }}
              />
              {openRun != null && <RunLines runId={openRun} />}
              <ConfirmDialog
                open={posting != null}
                onOpenChange={(o) => !o && setPosting(null)}
                destructive={false}
                title={t('fnx.consol.post_confirm_title', { id: posting ?? '' })}
                description={t('fnx.consol.post_confirm_desc')}
                confirmLabel={t('fnx.consol.post_btn')}
                busy={post.isPending}
                onConfirm={() => posting != null && post.mutate(posting)}
              />
            </div>
          )}
        </StateView>
      )}
    </div>
  );
}

function RunLines({ runId }: { runId: number }) {
  const { t } = useLang();
  const q = useQuery<RunLinesResp>({ queryKey: ['consol-run-lines', runId], queryFn: () => api(`/api/consolidation/runs/${runId}/lines`) });
  return (
    <Card className="gap-4 p-5">
      <CardHeader className="p-0">
        <CardTitle className="text-base">{t('fnx.consol.run_lines_title', { id: runId })}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={q.data.lines}
              rowKey={(r) => r.id}
              columns={[
                { key: 'line_type', label: t('fnx.consol.col_type'), render: (r) => <Badge variant={statusVariant(r.line_type)}>{r.line_type}</Badge> },
                { key: 'account_code', label: t('fnx.consol.col_account') },
                { key: 'entity_tenant_id', label: t('fnx.consol.col_entity'), render: (r) => (r.entity_tenant_id != null ? `#${r.entity_tenant_id}` : '—') },
                { key: 'amount_thb', label: t('fnx.consol.col_amount_thb'), align: 'right', render: (r) => <span className="tabular">{baht(r.amount_thb)}</span> },
                { key: 'notes', label: t('fnx.consol.col_notes'), render: (r) => r.notes ?? '—' },
              ]}
              emptyState={{ icon: ListTree, title: t('fnx.consol.empty_run_lines') }}
            />
          )}
        </StateView>
      </CardContent>
    </Card>
  );
}
