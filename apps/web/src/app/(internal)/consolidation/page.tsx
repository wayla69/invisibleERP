'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, Layers, ListTree, PlayCircle, Rows3, Plus, Trash2, Send, Scissors, PieChart, Coins, TrendingUp, Handshake, CheckCheck, XCircle } from 'lucide-react';
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
interface Rule { id: number; group_id: number; name: string; rule_type: string; match_account_pattern: string | null; debit_account: string | null; credit_account: string | null; active: boolean }
interface RulesResp { rules: Rule[]; count: number }
interface Segment { id: number; code: string; name: string; dimension: string; member_keys: unknown; active: boolean }
interface SegmentsResp { segments: Segment[]; count: number }
interface SegmentReportRow { segment: string; name: string; revenue: number; expense: number; net: number }
interface SegmentReportResp { period: string; dimension: string; segments: SegmentReportRow[] }
interface CfLine { account_code: string; label: string; amount: number }
interface CashFlowResp {
  run_id: number; group_id: number; period: string; method: string; post_elimination: boolean;
  operating: { net_income: number; adjustments: CfLine[]; working_capital: CfLine[]; net: number };
  investing: { lines: CfLine[]; net: number };
  financing: { lines: CfLine[]; net: number };
  fx_effect: { lines: CfLine[]; net: number };
  net_change_in_cash: number; consolidated_cash_movement: number; reconciled: boolean;
}

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
          { key: 'icrecon', label: t('fnx.consol.tab_icrecon'), content: <IcReconTab /> },
          { key: 'segments', label: t('fnx.consol.tab_segments'), content: <SegmentsTab /> },
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
              {openRun != null && <ConsolCashFlow runId={openRun} />}
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

// ───────────────────── FIN-5: consolidated cash flow (indirect, post-elimination) ─────────────────────
function ConsolCashFlow({ runId }: { runId: number }) {
  const { t } = useLang();
  const q = useQuery<CashFlowResp>({ queryKey: ['consol-cash-flow', runId], queryFn: () => api(`/api/consolidation/runs/${runId}/cash-flow`) });
  const cf = q.data;
  const section = (label: string, lines: CfLine[], net: number, netLabel: string) => (
    <div className="space-y-1.5">
      <div className="text-sm font-semibold">{label}</div>
      {lines.length ? lines.map((l) => (
        <div key={l.account_code} className="flex items-center justify-between gap-4 pl-3 text-sm">
          <span className="text-muted-foreground">{l.label} <span className="text-xs opacity-60">({l.account_code})</span></span>
          <span className="tabular">{baht(l.amount)}</span>
        </div>
      )) : <div className="pl-3 text-xs text-muted-foreground">—</div>}
      <div className="flex items-center justify-between gap-4 border-t pt-1.5 pl-3 text-sm font-medium">
        <span>{netLabel}</span>
        <span className="tabular">{baht(net)}</span>
      </div>
    </div>
  );
  return (
    <Card className="gap-4 p-5">
      <CardHeader className="p-0">
        <CardTitle className="flex items-center gap-2 text-base"><TrendingUp className="size-4" /> {t('fnx.consol.cf_title', { id: runId })}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <StateView q={q}>
          {cf && (
            <div className="space-y-4">
              <div className="text-xs text-muted-foreground">{t('fnx.consol.cf_method', { period: cf.period })}</div>
              <div className="space-y-1.5">
                <div className="text-sm font-semibold">{t('fnx.consol.cf_operating')}</div>
                <div className="flex items-center justify-between gap-4 pl-3 text-sm">
                  <span className="text-muted-foreground">{t('fnx.consol.cf_net_income')}</span>
                  <span className="tabular">{baht(cf.operating.net_income)}</span>
                </div>
                {cf.operating.adjustments.map((l) => (
                  <div key={l.account_code} className="flex items-center justify-between gap-4 pl-3 text-sm">
                    <span className="text-muted-foreground">{l.label} <span className="text-xs opacity-60">({l.account_code})</span></span>
                    <span className="tabular">{baht(l.amount)}</span>
                  </div>
                ))}
                {cf.operating.working_capital.map((l) => (
                  <div key={l.account_code} className="flex items-center justify-between gap-4 pl-3 text-sm">
                    <span className="text-muted-foreground">{l.label} <span className="text-xs opacity-60">({l.account_code})</span></span>
                    <span className="tabular">{baht(l.amount)}</span>
                  </div>
                ))}
                <div className="flex items-center justify-between gap-4 border-t pt-1.5 pl-3 text-sm font-medium">
                  <span>{t('fnx.consol.cf_net_operating')}</span>
                  <span className="tabular">{baht(cf.operating.net)}</span>
                </div>
              </div>
              {section(t('fnx.consol.cf_investing'), cf.investing.lines, cf.investing.net, t('fnx.consol.cf_net_investing'))}
              {section(t('fnx.consol.cf_financing'), cf.financing.lines, cf.financing.net, t('fnx.consol.cf_net_financing'))}
              {section(t('fnx.consol.cf_fx'), cf.fx_effect.lines, cf.fx_effect.net, t('fnx.consol.cf_net_fx'))}
              <div className="flex items-center justify-between gap-4 border-t-2 pt-2 text-sm font-semibold">
                <span>{t('fnx.consol.cf_net_change')}</span>
                <span className="tabular">{baht(cf.net_change_in_cash)}</span>
              </div>
              <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
                <span>{t('fnx.consol.cf_cash_movement')}</span>
                <span className="tabular">{baht(cf.consolidated_cash_movement)}</span>
              </div>
              <Badge variant={cf.reconciled ? 'default' : 'destructive'}>
                {cf.reconciled ? t('fnx.consol.cf_reconciled') : t('fnx.consol.cf_not_reconciled')}
              </Badge>
            </div>
          )}
        </StateView>
      </CardContent>
    </Card>
  );
}

// ───────────────────── CON-04: elimination rules + segments + segment report ─────────────────────
function SegmentsTab() {
  const { t } = useLang();
  return (
    <div className="space-y-5">
      <EliminationRules />
      <SegmentDefinitions />
      <SegmentReport />
    </div>
  );
}

function EliminationRules() {
  const { t } = useLang();
  const qc = useQueryClient();
  const groups = useQuery<GroupsResp>({ queryKey: ['consol-groups'], queryFn: () => api('/api/consolidation/groups') });
  const [groupId, setGroupId] = useState<number | null>(null);
  const gid = groupId ?? groups.data?.groups[0]?.id ?? null;
  const [name, setName] = useState('');
  const [ruleType, setRuleType] = useState('ic_balance');
  const [pattern, setPattern] = useState('');
  const [debit, setDebit] = useState('');
  const [credit, setCredit] = useState('');

  const rules = useQuery<RulesResp>({
    queryKey: ['consol-rules', gid],
    queryFn: () => api(`/api/consolidation/rules?group_id=${gid}`),
    enabled: gid != null,
  });
  const create = useMutation({
    mutationFn: () => api<Rule>('/api/consolidation/rules', {
      method: 'POST',
      body: JSON.stringify({ group_id: gid, name, rule_type: ruleType, match_account_pattern: pattern || undefined, debit_account: debit || undefined, credit_account: credit || undefined }),
    }),
    onSuccess: () => { notifySuccess(t('fnx.consol.rule_created', { name })); setName(''); setPattern(''); setDebit(''); setCredit(''); qc.invalidateQueries({ queryKey: ['consol-rules', gid] }); },
    onError: (e: Error) => notifyError(e.message),
  });

  return (
    <Card className="gap-4 p-5">
      <CardHeader className="p-0">
        <CardTitle className="flex items-center gap-2 text-base"><Scissors className="size-4" /> {t('fnx.consol.rules_title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 p-0">
        <p className="text-sm text-muted-foreground">{t('fnx.consol.rules_hint')}</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-2">
            <Label htmlFor="er-group">{t('fnx.consol.field_group')}</Label>
            <Select id="er-group" className="w-auto" value={gid ?? ''} onChange={(e) => setGroupId(Number(e.target.value))}>
              {groups.data?.groups.length
                ? groups.data.groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.fiscal_year})</option>)
                : <option value="">{t('fnx.consol.opt_no_group')}</option>}
            </Select>
          </div>
          <div className="grid gap-2"><Label htmlFor="er-name">{t('fnx.consol.field_rule_name')}</Label><Input id="er-name" className="max-w-[200px]" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="grid gap-2">
            <Label htmlFor="er-type">{t('fnx.consol.field_rule_type')}</Label>
            <Select id="er-type" className="w-auto" value={ruleType} onChange={(e) => setRuleType(e.target.value)}>
              <option value="ic_balance">{t('fnx.consol.rt_ic_balance')}</option>
              <option value="ic_revenue">{t('fnx.consol.rt_ic_revenue')}</option>
              <option value="investment">{t('fnx.consol.rt_investment')}</option>
              <option value="manual">{t('fnx.consol.rt_manual')}</option>
            </Select>
          </div>
          <div className="grid gap-2"><Label htmlFor="er-pat">{t('fnx.consol.field_pattern')}</Label><Input id="er-pat" className="max-w-[140px]" placeholder="1150%" value={pattern} onChange={(e) => setPattern(e.target.value)} /></div>
          <div className="grid gap-2"><Label htmlFor="er-dr">{t('fnx.consol.field_debit')}</Label><Input id="er-dr" className="max-w-[120px]" value={debit} onChange={(e) => setDebit(e.target.value)} /></div>
          <div className="grid gap-2"><Label htmlFor="er-cr">{t('fnx.consol.field_credit')}</Label><Input id="er-cr" className="max-w-[120px]" value={credit} onChange={(e) => setCredit(e.target.value)} /></div>
          <Button disabled={!name || gid == null || create.isPending} onClick={() => create.mutate()}><Plus className="size-4" /> {t('fnx.consol.add_rule_btn')}</Button>
        </div>
        <StateView q={rules}>
          {rules.data && (
            <DataTable
              rows={rules.data.rules}
              rowKey={(r) => r.id}
              columns={[
                { key: 'name', label: t('fnx.consol.col_rule_name'), render: (r) => <span className="font-medium">{r.name}</span> },
                { key: 'rule_type', label: t('fnx.consol.col_rule_type'), render: (r) => <Badge variant={statusVariant(r.rule_type)}>{r.rule_type}</Badge> },
                { key: 'match_account_pattern', label: t('fnx.consol.col_pattern'), render: (r) => r.match_account_pattern ?? '—' },
                { key: 'debit_account', label: t('fnx.consol.field_debit'), render: (r) => r.debit_account ?? '—' },
                { key: 'credit_account', label: t('fnx.consol.field_credit'), render: (r) => r.credit_account ?? '—' },
                { key: 'active', label: t('fnx.consol.col_active'), render: (r) => <Badge variant={r.active ? 'default' : 'secondary'}>{r.active ? t('fnx.consol.yes') : t('fnx.consol.no')}</Badge> },
              ]}
              emptyState={{ icon: Scissors, title: t('fnx.consol.empty_rules_title'), description: t('fnx.consol.empty_rules_desc') }}
            />
          )}
        </StateView>
      </CardContent>
    </Card>
  );
}

function SegmentDefinitions() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<SegmentsResp>({ queryKey: ['consol-segments'], queryFn: () => api('/api/consolidation/segments') });
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [dimension, setDimension] = useState('branch');
  const [members, setMembers] = useState('');

  const create = useMutation({
    mutationFn: () => {
      const member_keys = members.split(',').map((s) => s.trim()).filter(Boolean).map((s) => (/^\d+$/.test(s) ? Number(s) : s));
      return api<Segment>('/api/consolidation/segments', {
        method: 'POST',
        body: JSON.stringify({ code, name, dimension, member_keys: member_keys.length ? member_keys : undefined }),
      });
    },
    onSuccess: () => { notifySuccess(t('fnx.consol.segment_created', { code })); setCode(''); setName(''); setMembers(''); qc.invalidateQueries({ queryKey: ['consol-segments'] }); },
    onError: (e: Error) => notifyError(e.message),
  });

  return (
    <Card className="gap-4 p-5">
      <CardHeader className="p-0">
        <CardTitle className="flex items-center gap-2 text-base"><PieChart className="size-4" /> {t('fnx.consol.segments_title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 p-0">
        <p className="text-sm text-muted-foreground">{t('fnx.consol.segments_hint')}</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-2"><Label htmlFor="sd-code">{t('fnx.consol.field_seg_code')}</Label><Input id="sd-code" className="max-w-[140px]" value={code} onChange={(e) => setCode(e.target.value)} /></div>
          <div className="grid gap-2"><Label htmlFor="sd-name">{t('fnx.consol.field_seg_name')}</Label><Input id="sd-name" className="max-w-[200px]" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="grid gap-2">
            <Label htmlFor="sd-dim">{t('fnx.consol.field_dimension')}</Label>
            <Select id="sd-dim" className="w-auto" value={dimension} onChange={(e) => setDimension(e.target.value)}>
              <option value="branch">{t('fnx.consol.dim_branch')}</option>
              <option value="project">{t('fnx.consol.dim_project')}</option>
              <option value="department">{t('fnx.consol.dim_department')}</option>
              <option value="entity">{t('fnx.consol.dim_entity')}</option>
            </Select>
          </div>
          <div className="grid gap-2"><Label htmlFor="sd-mem">{t('fnx.consol.field_members')}</Label><Input id="sd-mem" className="max-w-[200px]" placeholder="1, 2, 3" value={members} onChange={(e) => setMembers(e.target.value)} /></div>
          <Button disabled={!code || !name || create.isPending} onClick={() => create.mutate()}><Plus className="size-4" /> {t('fnx.consol.add_segment_btn')}</Button>
        </div>
        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={q.data.segments}
              rowKey={(r) => r.id}
              columns={[
                { key: 'code', label: t('fnx.consol.col_seg_code'), render: (r) => <span className="font-medium">{r.code}</span> },
                { key: 'name', label: t('fnx.consol.col_seg_name') },
                { key: 'dimension', label: t('fnx.consol.col_dimension'), render: (r) => <Badge variant="secondary">{r.dimension}</Badge> },
                { key: 'member_keys', label: t('fnx.consol.col_members'), render: (r) => (Array.isArray(r.member_keys) ? (r.member_keys as unknown[]).join(', ') : '—') },
                { key: 'active', label: t('fnx.consol.col_active'), render: (r) => <Badge variant={r.active ? 'default' : 'secondary'}>{r.active ? t('fnx.consol.yes') : t('fnx.consol.no')}</Badge> },
              ]}
              emptyState={{ icon: PieChart, title: t('fnx.consol.empty_segments_title'), description: t('fnx.consol.empty_segments_desc') }}
            />
          )}
        </StateView>
      </CardContent>
    </Card>
  );
}

function SegmentReport() {
  const { t } = useLang();
  const [period, setPeriod] = useState(currentPeriod());
  const [dimension, setDimension] = useState('branch');
  const [params, setParams] = useState<{ period: string; dimension: string } | null>(null);
  const q = useQuery<SegmentReportResp>({
    queryKey: ['consol-segment-report', params],
    queryFn: () => api(`/api/consolidation/segment-report?period=${params!.period}&dimension=${params!.dimension}`),
    enabled: params != null,
  });

  return (
    <Card className="gap-4 p-5">
      <CardHeader className="p-0">
        <CardTitle className="flex items-center gap-2 text-base"><Coins className="size-4" /> {t('fnx.consol.seg_report_title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 p-0">
        <p className="text-sm text-muted-foreground">{t('fnx.consol.seg_report_hint')}</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-2"><Label htmlFor="sr-period">{t('fnx.consol.field_period')}</Label><Input id="sr-period" className="max-w-[160px]" placeholder="2026-06" value={period} onChange={(e) => setPeriod(e.target.value)} /></div>
          <div className="grid gap-2">
            <Label htmlFor="sr-dim">{t('fnx.consol.field_dimension')}</Label>
            <Select id="sr-dim" className="w-auto" value={dimension} onChange={(e) => setDimension(e.target.value)}>
              <option value="branch">{t('fnx.consol.dim_branch')}</option>
              <option value="project">{t('fnx.consol.dim_project')}</option>
              <option value="department">{t('fnx.consol.dim_department')}</option>
            </Select>
          </div>
          <Button disabled={!/^\d{4}-\d{2}$/.test(period)} onClick={() => setParams({ period, dimension })}>
            <PlayCircle className="size-4" /> {t('fnx.consol.run_report_btn')}
          </Button>
        </div>
        {params != null && (
          <StateView q={q}>
            {q.data && (
              <DataTable
                rows={q.data.segments}
                rowKey={(r) => r.segment}
                columns={[
                  { key: 'name', label: t('fnx.consol.col_segment'), render: (r) => <span className="font-medium">{r.name}</span> },
                  { key: 'revenue', label: t('fnx.consol.col_revenue'), align: 'right', render: (r) => <span className="tabular">{baht(r.revenue)}</span> },
                  { key: 'expense', label: t('fnx.consol.col_expense'), align: 'right', render: (r) => <span className="tabular">{baht(r.expense)}</span> },
                  { key: 'net', label: t('fnx.consol.col_seg_net'), align: 'right', render: (r) => <span className={`tabular font-medium ${r.net < 0 ? 'text-destructive' : ''}`}>{baht(r.net)}</span> },
                ]}
                emptyState={{ icon: Coins, title: t('fnx.consol.empty_seg_report_title'), description: t('fnx.consol.empty_seg_report_desc') }}
              />
            )}
          </StateView>
        )}
      </CardContent>
    </Card>
  );
}

// ───────────────────── REC-03: intercompany reconciliation sign-off (gates elimination) ─────────────────────
// Per-period IC reconciliation maker-checker: a preparer reconciles the group's IC balances (Due-From 1150 vs
// Due-To 2150) and signs (Prepared); an independent approver (SoD, approver ≠ preparer) approves only when the
// balances eliminate (Due-From = Due-To). consolidation.runConsolidation() is hard-gated on the period being
// Approved (IC_RECON_NOT_APPROVED). Read-only over the same spine — surfaces the existing endpoints.
interface IcReconPeriod {
  id?: number; group_id: number; period: string; status: string;
  total_due_from?: number; total_due_to?: number; eliminates?: boolean; unmatched_count?: number;
  prepared_by?: string | null; prepared_at?: string | null; approved_by?: string | null; approved_at?: string | null; rejection_reason?: string | null;
}
interface IcReconListResp { periods: IcReconPeriod[]; count: number }

function IcReconTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const groups = useQuery<GroupsResp>({ queryKey: ['consol-groups'], queryFn: () => api('/api/consolidation/groups') });
  const [groupId, setGroupId] = useState<number | null>(null);
  const [period, setPeriod] = useState(currentPeriod());
  const [approving, setApproving] = useState<IcReconPeriod | null>(null);
  const [rejecting, setRejecting] = useState<IcReconPeriod | null>(null);
  const [reason, setReason] = useState('');

  const gid = groupId ?? groups.data?.groups[0]?.id ?? null;
  const list = useQuery<IcReconListResp>({
    queryKey: ['ic-recon', gid],
    queryFn: () => api(`/api/ic-reconciliation/groups/${gid}`),
    enabled: gid != null,
  });

  const prepare = useMutation({
    mutationFn: () => api<IcReconPeriod>(`/api/ic-reconciliation/groups/${gid}/prepare`, { method: 'POST', body: JSON.stringify({ period }) }),
    onSuccess: (r) => {
      notifySuccess(t('fnx.consol.icr_prepared', { period: r.period }), r.eliminates ? t('fnx.consol.icr_eliminates_yes') : t('fnx.consol.icr_eliminates_no'));
      qc.invalidateQueries({ queryKey: ['ic-recon', gid] });
    },
    onError: (e: Error) => notifyError(e.message),
  });
  const approve = useMutation({
    mutationFn: (p: string) => api<IcReconPeriod>(`/api/ic-reconciliation/groups/${gid}/approve`, { method: 'POST', body: JSON.stringify({ period: p }) }),
    onSuccess: (r) => { notifySuccess(t('fnx.consol.icr_approved', { period: r.period })); setApproving(null); qc.invalidateQueries({ queryKey: ['ic-recon', gid] }); },
    onError: (e: Error) => { notifyError(e.message); setApproving(null); },
  });
  const reject = useMutation({
    mutationFn: ({ p, why }: { p: string; why: string }) => api<IcReconPeriod>(`/api/ic-reconciliation/groups/${gid}/reject`, { method: 'POST', body: JSON.stringify({ period: p, reason: why }) }),
    onSuccess: (r) => { notifySuccess(t('fnx.consol.icr_rejected', { period: r.period })); setRejecting(null); setReason(''); qc.invalidateQueries({ queryKey: ['ic-recon', gid] }); },
    onError: (e: Error) => notifyError(e.message),
  });

  return (
    <div className="space-y-5">
      <Card className="max-w-2xl gap-4">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Handshake className="size-4" /> {t('fnx.consol.icr_title')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('fnx.consol.icr_hint')}</p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-2">
              <Label htmlFor="icr-group">{t('fnx.consol.field_group')}</Label>
              <Select id="icr-group" className="w-auto" value={gid ?? ''} onChange={(e) => setGroupId(Number(e.target.value))}>
                {groups.data?.groups.length
                  ? groups.data.groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.fiscal_year})</option>)
                  : <option value="">{t('fnx.consol.opt_no_group')}</option>}
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="icr-period">{t('fnx.consol.field_period')}</Label>
              <Input id="icr-period" className="max-w-[160px]" placeholder="2026-06" value={period} onChange={(e) => setPeriod(e.target.value)} />
            </div>
            <Button disabled={prepare.isPending || gid == null || !/^\d{4}-\d{2}$/.test(period)} onClick={() => prepare.mutate()}>
              <PlayCircle className="size-4" /> {prepare.isPending ? t('fnx.consol.icr_preparing') : t('fnx.consol.icr_prepare_btn')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {gid != null && (
        <StateView q={list}>
          {list.data && (
            <DataTable
              rows={list.data.periods}
              rowKey={(r) => r.period}
              columns={[
                { key: 'period', label: t('fnx.consol.col_period'), render: (r) => <span className="font-medium">{r.period}</span> },
                { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                { key: 'total_due_from', label: t('fnx.consol.icr_col_due_from'), align: 'right', render: (r) => <span className="tabular">{baht(r.total_due_from ?? 0)}</span> },
                { key: 'total_due_to', label: t('fnx.consol.icr_col_due_to'), align: 'right', render: (r) => <span className="tabular">{baht(r.total_due_to ?? 0)}</span> },
                { key: 'eliminates', label: t('fnx.consol.icr_col_eliminates'), render: (r) => <Badge variant={r.eliminates ? 'default' : 'destructive'}>{r.eliminates ? t('fnx.consol.yes') : t('fnx.consol.no')}</Badge> },
                { key: 'prepared_by', label: t('fnx.consol.icr_col_prepared_by'), render: (r) => r.prepared_by ?? '—' },
                { key: 'approved_by', label: t('fnx.consol.icr_col_approved_by'), render: (r) => r.approved_by ?? '—' },
                { key: 'actions', label: t('fnx.consol.col_actions'), align: 'right', render: (r) => (
                  r.status === 'Prepared'
                    ? <div className="flex justify-end gap-1">
                        <Button size="sm" onClick={() => setApproving(r)}><CheckCheck className="size-3.5" /> {t('fnx.consol.icr_approve_btn')}</Button>
                        <Button size="sm" variant="outline" onClick={() => { setRejecting(r); setReason(''); }}><XCircle className="size-3.5" /> {t('fnx.consol.icr_reject_btn')}</Button>
                      </div>
                    : r.status === 'Rejected' && r.rejection_reason
                      ? <span className="text-xs text-muted-foreground" title={r.rejection_reason}>{t('fnx.consol.icr_rejected_tag')}</span>
                      : <span className="text-xs text-muted-foreground">—</span>
                ) },
              ]}
              emptyState={{ icon: Handshake, title: t('fnx.consol.icr_empty_title'), description: t('fnx.consol.icr_empty_desc') }}
            />
          )}
        </StateView>
      )}

      {rejecting && (
        <Card className="max-w-2xl gap-4 border-destructive/30 p-5">
          <CardHeader className="p-0"><CardTitle className="text-base">{t('fnx.consol.icr_reject_title', { period: rejecting.period })}</CardTitle></CardHeader>
          <CardContent className="space-y-3 p-0">
            <div className="grid gap-2">
              <Label htmlFor="icr-reason">{t('fnx.consol.icr_reason')}</Label>
              <Input id="icr-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('fnx.consol.icr_reason_ph')} />
            </div>
            <div className="flex gap-2">
              <Button variant="destructive" disabled={reject.isPending || !reason.trim()} onClick={() => reject.mutate({ p: rejecting.period, why: reason.trim() })}>
                {reject.isPending ? t('fnx.consol.icr_rejecting') : t('fnx.consol.icr_reject_confirm')}
              </Button>
              <Button variant="ghost" onClick={() => { setRejecting(null); setReason(''); }}>{t('fin.cancel')}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={approving != null}
        onOpenChange={(o) => !o && setApproving(null)}
        destructive={false}
        title={t('fnx.consol.icr_approve_confirm_title', { period: approving?.period ?? '' })}
        description={t('fnx.consol.icr_approve_confirm_desc')}
        confirmLabel={t('fnx.consol.icr_approve_btn')}
        busy={approve.isPending}
        onConfirm={() => approving && approve.mutate(approving.period)}
      />
    </div>
  );
}
