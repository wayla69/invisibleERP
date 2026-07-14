'use client';

// CRM-2 — the modern CRM workspace island (docs/41 module-depth uplift). ONE surface over the CRM-1 unified
// spine: a drag-and-drop kanban board (+ list toggle) on `crm_opportunities`/`pipeline_stages`, leads with
// qualify/convert + the CSV import wizard, and duplicate-governed accounts & contacts. Stage moves go
// through the governed PATCH …/stage route so `crm_stage_history` records every transition (REV-17); a
// drop on Won/Lost asks for the reason (LOST_REASON_REQUIRED honoured). DnD is a tiny in-house HTML5
// implementation (no dnd dependency exists in the web package — none added), optimistic with rollback.
import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Target, TrendingUp, Layers, Search, LayoutGrid, List as ListIcon, Upload, Download, Handshake,
  UserCheck, ArrowRightLeft, XCircle, Building2, Users, BarChart3, Star, Bookmark, Trash2, GripVertical,
  SlidersHorizontal, AlertTriangle,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useMe, hasPerm } from '@/lib/auth';
import { baht, num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { statusVariant } from '@/components/ui';
import { Select } from '@/components/form-controls';

// ── API shapes ─────────────────────────────────────────────────────────────
export interface Stage { id: number | null; name: string; sequence: number; defaultProbability: number; isWon: boolean | null; isLost: boolean | null }
export interface Opp {
  opp_no: string; name: string; stage: string; status: string; stage_id: number | null;
  amount: number; probability: number; weighted: number; expected_close_date: string | null;
  owner: string | null; account_id: number | null; account_no: string | null; account_name: string | null;
  stage_entered_at: string | null; lost_reason: string | null; lead_no: string | null; created_at: string;
}
interface Lead { lead_no: string; name: string; company: string | null; email: string | null; phone: string | null; source: string | null; status: string; owner: string | null; created_at: string }
interface Account { account_no: string; name: string; tax_id: string | null; industry: string | null; email: string | null; phone: string | null; customer_no: string | null; status: string; created_at: string }
interface Contact { id: number; account_id: number | null; name: string; email: string | null; phone: string | null; role: string; status: string }
interface SavedView { id: number; name: string; config: Record<string, unknown>; mine?: boolean }
// CRM-7: governed account plan + product-whitespace shapes.
interface AccountPlan { plan_no: string; account_no: string | null; period: string | null; objective: string | null; target_revenue: number; target_categories: string[]; status: string; owner: string | null; created_at: string }
interface Whitespace { account_no: string; name: string; categories: { code: string; name: string; targeted: boolean; plan_no: string | null }[]; targeted_count: number; whitespace_count: number }
// CRM-15: account health / churn + renewal pipeline shapes.
interface HealthRow { account_no: string; name: string; score: number; band: string; open_weighted: number; open_cases: number; days_since_activity: number | null; renewal_gap: boolean }
interface HealthPortfolio { accounts: HealthRow[]; count: number; band_counts: Record<string, number> }
interface RenewalPipeline { renewals: { opp_no: string; name: string; deal_type: string; amount: number; weighted: number; expected_close_date: string | null }[]; count: number; weighted: number; renewal_gaps: { account_no: string; name: string }[]; gap_count: number }
interface ForecastRollupRow { owner: string; system: { commit: number; best_case: number; pipeline: number; weighted: number; open_count: number; forecast: number }; submitted: { commit: number; best_case: number; pipeline: number; forecast: number | null; status: string } | null; variance: number | null }
interface ForecastDepth { period: string; totals: { system_commit: number; system_forecast: number; weighted: number; open_total: number; submitted_total: number; submissions: number; reps: number }; coverage: { open_pipeline: number; target: number; ratio: number | null; basis: string }; waterfall: { stage: string; amount: number; running: number }[]; rollup: ForecastRollupRow[]; accuracy: { period: string; forecast: number; actual_won: number; accuracy_pct: number | null }[] }
interface TerritoryRow { code: string; name: string; manager: string | null; active: boolean; parent_code: string | null }
interface Attainment { period: string; owners: { owner: string; won_amount: number; quota: number; attainment_pct: number | null }[]; territories: { code: string; name: string; manager: string | null; member_count: number; subtree_won: number; quota: number; attainment_pct: number | null }[] }
interface SequenceRow { code: string; name: string; active: boolean; description: string | null }
// CRM-7 kanban depth: per-stage playbook view (WIP limit + required-field exit criteria + guidance + live counts).
interface PlaybookStage { stage_id: number | null; name: string; sequence: number; is_won: boolean; is_lost: boolean; wip_limit: number | null; required_fields: string[]; guidance: string | null; open_count: number; over_wip: boolean; at_wip: boolean }
interface PlaybookView { stages: PlaybookStage[]; field_catalog: { key: string; label: string }[] }
interface EnrollmentRow { id: number; entity_type: string; entity_no: string; current_step: number; status: string; next_due_at: string | null }

// The six seeded default stage names ↔ the legacy lowercase machine kept in sync on `opp.stage`.
const LEGACY_BY_NAME: Record<string, string> = {
  Prospect: 'prospecting', Qualified: 'qualification', Proposal: 'proposal',
  Negotiation: 'negotiation', Won: 'won', Lost: 'lost',
};
const legacyOf = (name: string) => LEGACY_BY_NAME[name] ?? name;
const inStage = (o: Opp, s: Stage) => (o.stage_id != null && s.id != null) ? o.stage_id === s.id : o.stage === legacyOf(s.name);
const ageDays = (iso: string | null) => iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)) : 0;

export default function CrmWorkspaceClient() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('crmx.title')}
        description={t('crmx.subtitle')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild><Link href="/projects/pipeline"><BarChart3 className="size-4" /> {t('crmx.btn_win_loss')}</Link></Button>
            <Button variant="outline" asChild><Link href="/crm/members"><Star className="size-4" /> {t('crmx.btn_members')}</Link></Button>
          </div>
        }
      />
      <Tabs
        urlParam="tab"
        tabs={[
          { key: 'board', label: t('crmx.tab_board'), content: <DealsBoard /> },
          { key: 'leads', label: t('crmx.tab_leads'), content: <LeadsTab /> },
          { key: 'accounts', label: t('crmx.tab_accounts'), content: <AccountsTab /> },
          { key: 'contacts', label: t('crmx.tab_contacts'), content: <ContactsTab /> },
          { key: 'plans', label: t('crmx.tab_plans'), content: <PlansTab /> },
          { key: 'health', label: t('crmx.tab_health'), content: <AccountHealthTab /> },
          { key: 'forecast', label: t('crmx.tab_forecast'), content: <ForecastTab /> },
          { key: 'territory', label: t('crmx.tab_territory'), content: <TerritoryTab /> },
          { key: 'sequences', label: t('crmx.tab_sequences'), content: <SequencesTab /> },
        ]}
      />
    </div>
  );
}

// ── Deals: kanban board + list toggle, filters, saved views ────────────────
interface Filters { q: string; owner: string; min: string; max: string }
const EMPTY_FILTERS: Filters = { q: '', owner: '', min: '', max: '' };

function DealsBoard() {
  const { t } = useLang();
  const router = useRouter();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const canEditPlaybooks = hasPerm(me, 'crm', 'exec');
  const stagesQ = useQuery<Stage[]>({ queryKey: ['crm-stages'], queryFn: () => api('/api/pipeline/stages') });
  const oppsQ = useQuery<{ opportunities: Opp[]; count: number }>({ queryKey: ['crm-opps'], queryFn: () => api('/api/crm/pipeline/opportunities') });
  const sumQ = useQuery<{ open_amount: number; weighted_forecast: number; won_amount: number; win_rate: number }>({ queryKey: ['crm-summary'], queryFn: () => api('/api/crm/pipeline/summary') });
  // CRM-7 kanban depth: per-stage playbooks (WIP limits + required-field exit criteria + guidance + live counts).
  const playbooksQ = useQuery<PlaybookView>({ queryKey: ['crm-playbooks'], queryFn: () => api('/api/crm/pipeline/playbooks') });
  const pbByStageId = useMemo(() => new Map((playbooksQ.data?.stages ?? []).filter((p) => p.stage_id != null).map((p) => [Number(p.stage_id), p])), [playbooksQ.data]);
  const pbFor = (st: Stage): PlaybookStage | undefined => (st.id != null ? pbByStageId.get(Number(st.id)) : undefined);

  const [view, setView] = useState<'kanban' | 'list'>(() => {
    if (typeof window === 'undefined') return 'kanban';
    return window.localStorage.getItem('crm.view') === 'list' ? 'list' : 'kanban';
  });
  const switchView = (v: 'kanban' | 'list') => { setView(v); try { window.localStorage.setItem('crm.view', v); } catch { /* ignore */ } };

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const setF = (k: keyof Filters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const [stageFilter, setStageFilter] = useState(''); // list view only — the board shows all columns

  const stages = useMemo(() => (stagesQ.data ?? []).slice().sort((a, b) => a.sequence - b.sequence), [stagesQ.data]);
  const all = oppsQ.data?.opportunities ?? [];
  const owners = useMemo(() => [...new Set(all.map((o) => o.owner).filter((x): x is string => !!x))].sort(), [all]);
  const filtered = useMemo(() => all.filter((o) => {
    if (filters.owner && o.owner !== filters.owner) return false;
    if (filters.min && o.amount < Number(filters.min)) return false;
    if (filters.max && o.amount > Number(filters.max)) return false;
    if (filters.q) {
      const q = filters.q.toLowerCase();
      if (!`${o.name} ${o.opp_no} ${o.account_name ?? ''}`.toLowerCase().includes(q)) return false;
    }
    return true;
  }), [all, filters]);

  // ── stage move (governed route → crm_stage_history), optimistic with rollback ──
  const move = useMutation({
    mutationFn: (v: { opp: Opp; stage: Stage; lost_reason?: string; win_reason?: string }) =>
      api(`/api/crm/pipeline/opportunities/${encodeURIComponent(v.opp.opp_no)}/stage`, {
        method: 'PATCH',
        body: JSON.stringify({ stage: v.stage.name, lost_reason: v.lost_reason, win_reason: v.win_reason }),
      }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['crm-opps'] });
      const prev = qc.getQueryData<{ opportunities: Opp[]; count: number }>(['crm-opps']);
      qc.setQueryData<{ opportunities: Opp[]; count: number }>(['crm-opps'], (d) => d ? {
        ...d,
        opportunities: d.opportunities.map((o) => o.opp_no === v.opp.opp_no ? {
          ...o, stage: legacyOf(v.stage.name), stage_id: v.stage.id,
          status: v.stage.isWon ? 'Won' : v.stage.isLost ? 'Lost' : 'Open',
          probability: v.stage.defaultProbability, stage_entered_at: new Date().toISOString(),
        } : o),
      } : d);
      return { prev };
    },
    onError: (e: Error, _v, ctx) => { if (ctx?.prev) qc.setQueryData(['crm-opps'], ctx.prev); notifyError(e.message); },
    onSuccess: () => notifySuccess(t('crmx.toast_stage_moved')),
    onSettled: () => { qc.invalidateQueries({ queryKey: ['crm-opps'] }); qc.invalidateQueries({ queryKey: ['crm-summary'] }); qc.invalidateQueries({ queryKey: ['crm-playbooks'] }); },
  });

  // ── tiny in-house HTML5 DnD ──
  const [dragNo, setDragNo] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [closeAsk, setCloseAsk] = useState<null | { opp: Opp; stage: Stage }>(null);
  const [closeReason, setCloseReason] = useState('');
  const requestMove = (opp: Opp, stage: Stage) => {
    if (opp.status !== 'Open') { notifyError(t('crmx.err_closed_deal')); return; }
    if (inStage(opp, stage)) return;
    if (stage.isWon || stage.isLost) { setCloseReason(''); setCloseAsk({ opp, stage }); return; }
    move.mutate({ opp, stage });
  };
  const handleDrop = (stage: Stage) => {
    setOverCol(null);
    const opp = all.find((o) => o.opp_no === dragNo);
    setDragNo(null);
    if (opp) requestMove(opp, stage);
  };

  // ── CRM-7 bulk stage move (list view multi-select) — same governed path, per-item result ──
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkStage, setBulkStage] = useState('');
  const [pbOpen, setPbOpen] = useState(false);
  const toggleSel = (no: string) => setSelected((s) => { const n = new Set(s); n.has(no) ? n.delete(no) : n.add(no); return n; });
  const bulkMove = useMutation({
    mutationFn: (v: { opp_nos: string[]; stage: string }) => api<{ moved: number; failed: number }>('/api/crm/pipeline/opportunities/bulk-stage', { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: (r) => {
      if (r.failed) notifyError(t('crmx.pb_bulk_partial', { moved: r.moved, failed: r.failed }));
      else notifySuccess(t('crmx.pb_bulk_done', { moved: r.moved }));
      setSelected(new Set()); setBulkStage('');
      qc.invalidateQueries({ queryKey: ['crm-opps'] }); qc.invalidateQueries({ queryKey: ['crm-summary'] }); qc.invalidateQueries({ queryKey: ['crm-playbooks'] });
    },
    onError: (e: Error) => notifyError(e.message),
  });

  // ── saved filter views (reuses the saved-views module, module key 'crm-board') ──
  const viewsQ = useQuery<{ views: SavedView[] }>({ queryKey: ['crm-views'], queryFn: () => api('/api/saved-views?module=crm-board') });
  const saveView = useMutation({
    mutationFn: (name: string) => api('/api/saved-views', { method: 'POST', body: JSON.stringify({ module: 'crm-board', name, config: filters }) }),
    onSuccess: () => { notifySuccess(t('crmx.toast_view_saved')); qc.invalidateQueries({ queryKey: ['crm-views'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const deleteView = useMutation({
    mutationFn: (id: number) => api(`/api/saved-views/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm-views'] }),
    onError: (e: Error) => notifyError(e.message),
  });
  const applyView = (v: SavedView) => setFilters({ ...EMPTY_FILTERS, ...(v.config as Partial<Filters>) });
  const [viewName, setViewName] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);

  // ── quick create ──
  const [createOpen, setCreateOpen] = useState(false);
  const [cf, setCf] = useState({ name: '', amount: '', expected_close_date: '', account_no: '' });
  const accountsQ = useQuery<{ accounts: Account[] }>({ queryKey: ['crm-accounts', ''], queryFn: () => api('/api/crm/accounts'), enabled: createOpen });
  const create = useMutation({
    mutationFn: () => api<{ opp_no: string }>('/api/crm/pipeline/opportunities', {
      method: 'POST',
      body: JSON.stringify({ name: cf.name, amount: Number(cf.amount) || undefined, expected_close_date: cf.expected_close_date || undefined, account_no: cf.account_no || undefined }),
    }),
    onSuccess: (r) => {
      notifySuccess(t('crmx.toast_deal_created', { no: r.opp_no }));
      setCreateOpen(false); setCf({ name: '', amount: '', expected_close_date: '', account_no: '' });
      qc.invalidateQueries({ queryKey: ['crm-opps'] }); qc.invalidateQueries({ queryKey: ['crm-summary'] });
    },
    onError: (e: Error) => notifyError(e.message),
  });

  const s = sumQ.data;
  return (
    <div className="grid gap-5">
      {s && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label={t('crmx.stat_open')} value={baht(s.open_amount)} icon={Layers} tone="primary" />
          <StatCard label={t('crmx.stat_weighted')} value={baht(s.weighted_forecast)} icon={TrendingUp} tone="info" hint={t('crmx.stat_weighted_hint')} />
          <StatCard label={t('crmx.stat_won')} value={baht(s.won_amount)} icon={Target} tone="success" />
          <StatCard label={t('crmx.stat_win_rate')} value={`${Math.round((s.win_rate ?? 0) * 100)}%`} icon={BarChart3} />
        </div>
      )}

      {/* toolbar: view toggle + filters + saved views + create */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-md border">
          <Button size="sm" variant={view === 'kanban' ? 'default' : 'ghost'} className="rounded-none" onClick={() => switchView('kanban')} title={t('crmx.view_kanban')}><LayoutGrid className="size-4" /><span className="hidden sm:inline"> {t('crmx.view_kanban')}</span></Button>
          <Button size="sm" variant={view === 'list' ? 'default' : 'ghost'} className="rounded-none" onClick={() => switchView('list')} title={t('crmx.view_list')}><ListIcon className="size-4" /><span className="hidden sm:inline"> {t('crmx.view_list')}</span></Button>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label={t('crmx.f_search')} className="w-44 pl-8" placeholder={t('crmx.f_search')} value={filters.q} onChange={(e) => setF('q', e.target.value)} />
        </div>
        <Select className="w-auto" aria-label={t('crmx.f_owner')} value={filters.owner} onChange={(e) => setF('owner', e.target.value)}>
          <option value="">{t('crmx.f_owner_all')}</option>
          {owners.map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
        <Input aria-label={t('crmx.f_min')} className="w-28" type="number" min="0" placeholder={t('crmx.f_min')} value={filters.min} onChange={(e) => setF('min', e.target.value)} />
        <Input aria-label={t('crmx.f_max')} className="w-28" type="number" min="0" placeholder={t('crmx.f_max')} value={filters.max} onChange={(e) => setF('max', e.target.value)} />
        {(viewsQ.data?.views ?? []).length > 0 && (
          <Select className="w-auto" aria-label={t('crmx.saved_views')} value="" onChange={(e) => { const v = viewsQ.data?.views.find((x) => String(x.id) === e.target.value); if (v) applyView(v); }}>
            <option value="">{t('crmx.saved_views')}</option>
            {(viewsQ.data?.views ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </Select>
        )}
        <Button size="sm" variant="outline" onClick={() => { setViewName(''); setSaveOpen(true); }} title={t('crmx.btn_save_view')}><Bookmark className="size-4" /><span className="hidden md:inline"> {t('crmx.btn_save_view')}</span></Button>
        {canEditPlaybooks && (
          <Button size="sm" variant="outline" onClick={() => setPbOpen(true)} title={t('crmx.pb_title')}><SlidersHorizontal className="size-4" /><span className="hidden md:inline"> {t('crmx.pb_btn')}</span></Button>
        )}
        <div className="ms-auto">
          <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="size-4" /> {t('crmx.btn_new_deal')}</Button>
        </div>
      </div>

      <StateView q={oppsQ}>
        {view === 'kanban' ? (
          <div className="flex gap-3 overflow-x-auto pb-2">
            {stages.map((st) => {
              const colKey = st.name;
              const cards = filtered.filter((o) => inStage(o, st));
              const total = cards.reduce((x, o) => x + o.amount, 0);
              const closed = !!(st.isWon || st.isLost);
              const pb = pbFor(st);
              const overWip = !!pb && pb.wip_limit != null && pb.open_count > pb.wip_limit;
              const atWip = !!pb && pb.wip_limit != null && pb.open_count >= pb.wip_limit;
              return (
                <div
                  key={colKey}
                  className={`flex w-64 shrink-0 flex-col rounded-lg border bg-muted/30 ${overCol === colKey ? 'ring-2 ring-primary/60' : ''} ${overWip ? 'border-destructive/60' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOverCol(colKey); }}
                  onDragLeave={() => setOverCol((c) => (c === colKey ? null : c))}
                  onDrop={(e) => { e.preventDefault(); handleDrop(st); }}
                >
                  <div className="flex items-center justify-between border-b px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Badge variant={st.isWon ? 'success' : st.isLost ? 'destructive' : 'secondary'}>{st.name}</Badge>
                      {/* CRM-7: WIP badge — open count vs the configured cap */}
                      {pb && pb.wip_limit != null
                        ? <Badge variant={overWip ? 'destructive' : atWip ? 'warning' : 'muted'} title={t('crmx.pb_wip_hint')}>{num(cards.length)}/{pb.wip_limit}</Badge>
                        : <span className="text-xs text-muted-foreground">{num(cards.length)}</span>}
                    </div>
                    <span className="text-xs tabular text-muted-foreground">{baht(total)}</span>
                  </div>
                  {/* CRM-7: exit-criteria — required fields + coach's guidance shown on the column */}
                  {pb && (pb.required_fields.length > 0 || pb.guidance) && (
                    <div className="border-b bg-muted/40 px-3 py-1.5 text-[11px] leading-tight text-muted-foreground">
                      {pb.required_fields.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="font-medium">{t('crmx.pb_requires')}:</span>
                          {pb.required_fields.map((f) => {
                            const lbl = playbooksQ.data?.field_catalog.find((c) => c.key === f)?.label ?? f;
                            return <Badge key={f} variant="outline" className="px-1 py-0 text-[10px]">{lbl}</Badge>;
                          })}
                        </div>
                      )}
                      {pb.guidance && <div className="mt-0.5 italic">{pb.guidance}</div>}
                    </div>
                  )}
                  <div className="flex min-h-24 flex-col gap-2 p-2">
                    {cards.slice(0, closed ? 15 : 100).map((o) => (
                      <div
                        key={o.opp_no}
                        draggable={o.status === 'Open'}
                        onDragStart={(e) => { e.dataTransfer.setData('text/plain', o.opp_no); e.dataTransfer.effectAllowed = 'move'; setDragNo(o.opp_no); }}
                        onDragEnd={() => setDragNo(null)}
                        onClick={() => router.push(`/crm/deals/${encodeURIComponent(o.opp_no)}`)}
                        className={`cursor-pointer rounded-md border bg-background p-2.5 text-sm shadow-sm transition hover:border-primary/50 ${dragNo === o.opp_no ? 'opacity-50' : ''} ${o.status === 'Open' ? 'active:cursor-grabbing' : 'opacity-80'}`}
                      >
                        <div className="flex items-start gap-1.5">
                          {o.status === 'Open' && <GripVertical className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60" />}
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium">{o.name}</div>
                            {o.account_name && <div className="truncate text-xs text-muted-foreground">{o.account_name}</div>}
                            <div className="mt-1.5 flex items-center justify-between gap-2">
                              <span className="tabular text-xs font-semibold">{baht(o.amount)}</span>
                              <span className="text-xs text-muted-foreground">{o.probability}%</span>
                            </div>
                            <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                              <span className="truncate">{o.owner ?? '—'}</span>
                              {o.status === 'Open' && <Badge variant={ageDays(o.stage_entered_at) > 30 ? 'destructive' : 'muted'}>{t('crmx.age_days', { n: ageDays(o.stage_entered_at) })}</Badge>}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                    {!cards.length && <div className="grid flex-1 place-items-center py-4 text-xs text-muted-foreground">{t('crmx.col_empty')}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select className="w-auto" aria-label={t('crmx.f_stage')} value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
                <option value="">{t('crmx.f_stage_all')}</option>
                {stages.map((st) => <option key={st.name} value={st.name}>{st.name}</option>)}
              </Select>
              {/* CRM-7 bulk stage move — appears when deals are selected; targets non-terminal stages only */}
              {selected.size > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-2 py-1">
                  <span className="text-sm font-medium">{t('crmx.pb_selected', { n: selected.size })}</span>
                  <Select className="w-40" aria-label={t('crmx.pb_bulk_to')} value={bulkStage} onChange={(e) => setBulkStage(e.target.value)}>
                    <option value="">{t('crmx.pb_bulk_to')}</option>
                    {stages.filter((st) => !st.isWon && !st.isLost).map((st) => <option key={st.name} value={st.name}>{st.name}</option>)}
                  </Select>
                  <Button size="sm" disabled={!bulkStage || bulkMove.isPending} onClick={() => bulkMove.mutate({ opp_nos: [...selected], stage: bulkStage })}><ArrowRightLeft className="size-4" /> {t('crmx.pb_bulk_move')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>{t('crmx.btn_cancel')}</Button>
                </div>
              )}
            </div>
            <DataTable
              rows={filtered.filter((o) => !stageFilter || inStage(o, stages.find((x) => x.name === stageFilter)!))}
              rowKey={(r) => r.opp_no}
              emptyState={{ icon: Target, title: t('crmx.empty_deals_title'), description: t('crmx.empty_deals_desc') }}
              columns={[
                {
                  key: 'sel', label: '', sortable: false,
                  render: (r: Opp) => r.status === 'Open'
                    ? <input type="checkbox" aria-label={t('crmx.pb_select_row')} className="size-4 align-middle" checked={selected.has(r.opp_no)} onClick={(e) => e.stopPropagation()} onChange={() => toggleSel(r.opp_no)} />
                    : null,
                },
                { key: 'opp_no', label: t('dash.col_no'), render: (r: Opp) => <Link className="text-primary underline-offset-2 hover:underline" href={`/crm/deals/${encodeURIComponent(r.opp_no)}`}>{r.opp_no}</Link> },
                { key: 'name', label: t('crmx.col_deal'), render: (r: Opp) => <Link className="hover:underline" href={`/crm/deals/${encodeURIComponent(r.opp_no)}`}>{r.name}</Link> },
                { key: 'account_name', label: t('crmx.col_account'), render: (r: Opp) => r.account_name ?? '—' },
                { key: 'stage', label: t('crmx.col_stage'), render: (r: Opp) => <Badge variant={statusVariant(r.status === 'Open' ? r.stage : r.status)}>{stages.find((st) => inStage(r, st))?.name ?? r.stage}</Badge> },
                { key: 'amount', label: t('crmx.col_amount'), align: 'right', render: (r: Opp) => <span className="tabular">{baht(r.amount)}</span> },
                { key: 'probability', label: t('crmx.col_prob'), align: 'right', render: (r: Opp) => `${r.probability}%` },
                { key: 'owner', label: t('crmx.col_owner'), render: (r: Opp) => r.owner ?? '—' },
                { key: 'stage_entered_at', label: t('crmx.col_age'), align: 'right', render: (r: Opp) => r.status === 'Open' ? t('crmx.age_days', { n: ageDays(r.stage_entered_at) }) : '—' },
                {
                  key: 'move', label: t('crmx.col_move'), sortable: false,
                  render: (r: Opp) => r.status !== 'Open' ? <span className="text-xs text-muted-foreground">—</span> : (
                    <Select className="w-32" value="" disabled={move.isPending} onChange={(e) => { const st = stages.find((x) => x.name === e.target.value); if (st) requestMove(r, st); }}>
                      <option value="">{t('crmx.move_to')}</option>
                      {stages.map((st) => <option key={st.name} value={st.name}>{st.name}</option>)}
                    </Select>
                  ),
                },
              ]}
            />
          </div>
        )}
      </StateView>

      {/* Won/Lost drop → reason dialog (governed route: lost requires a reason) */}
      <Dialog open={!!closeAsk} onOpenChange={(o) => !o && setCloseAsk(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{closeAsk?.stage.isLost ? t('crmx.dlg_lost_title') : t('crmx.dlg_won_title')} — {closeAsk?.opp.name}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="close-reason">{closeAsk?.stage.isLost ? t('crmx.f_lost_reason') : t('crmx.f_win_reason')}</Label>
            <Input id="close-reason" value={closeReason} onChange={(e) => setCloseReason(e.target.value)} placeholder={closeAsk?.stage.isLost ? t('crmx.ph_lost_reason') : t('crmx.ph_win_reason')} />
            {closeAsk?.stage.isLost && <p className="text-xs text-muted-foreground">{t('crmx.lost_reason_required')}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCloseAsk(null)}>{t('crmx.btn_cancel')}</Button>
            <Button
              variant={closeAsk?.stage.isLost ? 'destructive' : 'default'}
              disabled={move.isPending || (!!closeAsk?.stage.isLost && !closeReason.trim())}
              onClick={() => {
                if (!closeAsk) return;
                move.mutate({ opp: closeAsk.opp, stage: closeAsk.stage, lost_reason: closeAsk.stage.isLost ? closeReason.trim() : undefined, win_reason: closeAsk.stage.isWon && closeReason.trim() ? closeReason.trim() : undefined });
                setCloseAsk(null);
              }}
            >
              {closeAsk?.stage.isLost ? t('crmx.btn_confirm_lost') : t('crmx.btn_confirm_won')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* save-view dialog */}
      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('crmx.dlg_save_view')}</DialogTitle></DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="view-name">{t('crmx.f_view_name')}</Label>
            <Input id="view-name" value={viewName} onChange={(e) => setViewName(e.target.value)} />
            {(viewsQ.data?.views ?? []).filter((v) => v.mine).length > 0 && (
              <div className="mt-2 grid gap-1">
                {(viewsQ.data?.views ?? []).filter((v) => v.mine).map((v) => (
                  <div key={v.id} className="flex items-center justify-between rounded border px-2 py-1 text-sm">
                    <span>{v.name}</span>
                    <Button size="sm" variant="ghost" title={t('crmx.btn_delete_view')} onClick={() => deleteView.mutate(v.id)}><Trash2 className="size-4" /></Button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>{t('crmx.btn_cancel')}</Button>
            <Button disabled={!viewName.trim() || saveView.isPending} onClick={() => { saveView.mutate(viewName.trim()); setSaveOpen(false); }}>{t('crmx.btn_save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* CRM-7 stage playbook editor (supervisor) */}
      <PlaybookDialog open={pbOpen} onClose={() => setPbOpen(false)} data={playbooksQ.data} />

      {/* quick-create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('crmx.dlg_new_deal')}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5"><Label htmlFor="nd-name">{t('crmx.f_deal_name')}</Label><Input id="nd-name" value={cf.name} onChange={(e) => setCf({ ...cf, name: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label htmlFor="nd-amount">{t('crmx.f_amount')}</Label><Input id="nd-amount" type="number" min="0" value={cf.amount} onChange={(e) => setCf({ ...cf, amount: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label htmlFor="nd-close">{t('crmx.f_expected_close')}</Label><Input id="nd-close" type="date" value={cf.expected_close_date} onChange={(e) => setCf({ ...cf, expected_close_date: e.target.value })} /></div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="nd-account">{t('crmx.f_account')}</Label>
              <Select id="nd-account" value={cf.account_no} onChange={(e) => setCf({ ...cf, account_no: e.target.value })}>
                <option value="">{t('crmx.f_account_none')}</option>
                {(accountsQ.data?.accounts ?? []).map((a) => <option key={a.account_no} value={a.account_no}>{a.name}</option>)}
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t('crmx.btn_cancel')}</Button>
            <Button disabled={!cf.name.trim() || create.isPending} onClick={() => create.mutate()}><Plus className="size-4" /> {t('crmx.btn_create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── CRM-7 stage playbook editor — per-stage WIP limit + required-field exit criteria + guidance (supervisor
//    crm/exec). Saves one stage at a time via PUT …/playbooks/:stageId. Terminal Won/Lost stages are shown
//    read-only (a WIP cap / entry gate on a terminal stage is meaningless). ────────────────────────────────
function PlaybookDialog({ open, onClose, data }: { open: boolean; onClose: () => void; data: PlaybookView | undefined }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const editable = (data?.stages ?? []).filter((s) => s.stage_id != null && !s.is_won && !s.is_lost);
  const [draft, setDraft] = useState<Record<number, { wip: string; fields: string[]; guidance: string }>>({});
  // Seed the local draft from the server view whenever the dialog opens (keyed by stage id).
  const seed = useMemo(() => Object.fromEntries(editable.map((s) => [Number(s.stage_id), {
    wip: s.wip_limit != null ? String(s.wip_limit) : '', fields: [...s.required_fields], guidance: s.guidance ?? '',
  }])), [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const row = (id: number) => draft[id] ?? seed[id] ?? { wip: '', fields: [], guidance: '' };
  const setRow = (id: number, patch: Partial<{ wip: string; fields: string[]; guidance: string }>) => setDraft((d) => ({ ...d, [id]: { ...row(id), ...patch } }));
  const save = useMutation({
    mutationFn: (v: { stageId: number; body: { wip_limit: number | null; required_fields: string[]; guidance: string | null } }) =>
      api(`/api/crm/pipeline/playbooks/${v.stageId}`, { method: 'PUT', body: JSON.stringify(v.body) }),
    onSuccess: () => { notifySuccess(t('crmx.pb_saved')); qc.invalidateQueries({ queryKey: ['crm-playbooks'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const saveRow = (s: PlaybookStage) => {
    const r = row(Number(s.stage_id));
    const wip = r.wip.trim() === '' ? null : Math.max(0, Math.trunc(Number(r.wip)));
    save.mutate({ stageId: Number(s.stage_id), body: { wip_limit: Number.isFinite(wip as number) ? wip : null, required_fields: r.fields, guidance: r.guidance.trim() || null } });
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><SlidersHorizontal className="size-4" /> {t('crmx.pb_title')}</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">{t('crmx.pb_help')}</p>
        <div className="grid max-h-[60vh] gap-3 overflow-y-auto py-1">
          {editable.map((s) => {
            const r = row(Number(s.stage_id));
            return (
              <Card key={s.stage_id!} className="grid gap-2 p-3">
                <div className="flex items-center justify-between">
                  <Badge variant="secondary">{s.name}</Badge>
                  <span className="text-xs text-muted-foreground">{t('crmx.pb_open_now', { n: s.open_count })}</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-[8rem_1fr]">
                  <div className="grid gap-1">
                    <Label htmlFor={`wip-${s.stage_id}`} className="text-xs">{t('crmx.pb_wip_limit')}</Label>
                    <Input id={`wip-${s.stage_id}`} type="number" min="0" placeholder={t('crmx.pb_unlimited')} value={r.wip} onChange={(e) => setRow(Number(s.stage_id), { wip: e.target.value })} />
                  </div>
                  <div className="grid gap-1">
                    <Label className="text-xs">{t('crmx.pb_required_fields')}</Label>
                    <div className="flex flex-wrap gap-2">
                      {(data?.field_catalog ?? []).map((f) => (
                        <label key={f.key} className="flex items-center gap-1 rounded border px-2 py-0.5 text-xs">
                          <input type="checkbox" className="size-3.5" checked={r.fields.includes(f.key)}
                            onChange={(e) => setRow(Number(s.stage_id), { fields: e.target.checked ? [...r.fields, f.key] : r.fields.filter((x) => x !== f.key) })} />
                          {f.label}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`gd-${s.stage_id}`} className="text-xs">{t('crmx.pb_guidance')}</Label>
                  <Input id={`gd-${s.stage_id}`} value={r.guidance} maxLength={2000} placeholder={t('crmx.pb_guidance_ph')} onChange={(e) => setRow(Number(s.stage_id), { guidance: e.target.value })} />
                </div>
                <div className="flex justify-end">
                  <Button size="sm" variant="outline" disabled={save.isPending} onClick={() => saveRow(s)}>{t('crmx.btn_save')}</Button>
                </div>
              </Card>
            );
          })}
          {!editable.length && <div className="flex items-center gap-2 text-sm text-muted-foreground"><AlertTriangle className="size-4" /> {t('crmx.pb_none')}</div>}
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>{t('crmx.btn_close')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Leads: list + qualify/convert/lose (ported from /projects/crm) + CSV import wizard ─────────────
function LeadsTab() {
  const { t } = useLang();
  const router = useRouter();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const q = useQuery<{ leads: Lead[] }>({ queryKey: ['crm-leads', statusFilter], queryFn: () => api(`/api/crm/pipeline/leads${statusFilter ? `?status=${statusFilter}` : ''}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['crm-leads'] });
  const sources = useMemo(() => [...new Set((q.data?.leads ?? []).map((l) => l.source).filter((x): x is string => !!x))].sort(), [q.data]);
  const rows = (q.data?.leads ?? []).filter((l) => !sourceFilter || l.source === sourceFilter);

  const [f, setF] = useState({ name: '', company: '', email: '', phone: '', source: '' });
  const create = useMutation({
    mutationFn: () => api('/api/crm/pipeline/leads', { method: 'POST', body: JSON.stringify({ name: f.name, company: f.company || undefined, email: f.email || undefined, phone: f.phone || undefined, source: f.source || undefined }) }),
    onSuccess: () => { notifySuccess(t('crmx.toast_lead_added')); setF({ name: '', company: '', email: '', phone: '', source: '' }); refresh(); },
    onError: (e: Error) => notifyError(e.message),
  });
  const qualify = useMutation({ mutationFn: (no: string) => api(`/api/crm/pipeline/leads/${no}/qualify`, { method: 'POST', body: '{}' }), onSuccess: () => { notifySuccess(t('crmx.toast_qualified')); refresh(); }, onError: (e: Error) => notifyError(e.message) });
  const lose = useMutation({ mutationFn: (no: string) => api(`/api/crm/pipeline/leads/${no}/lose`, { method: 'POST', body: JSON.stringify({ reason: t('crmx.lead_lose_reason') }) }), onSuccess: () => { notifySuccess(t('crmx.toast_lead_lost')); refresh(); }, onError: (e: Error) => notifyError(e.message) });

  const [conv, setConv] = useState<null | { lead_no: string; name: string }>(null);
  const [cf, setCf] = useState({ opportunity_name: '', amount: '', expected_close_date: '' });
  const convert = useMutation({
    mutationFn: () => api<{ opp_no: string }>(`/api/crm/pipeline/leads/${conv!.lead_no}/convert`, { method: 'POST', body: JSON.stringify({ opportunity_name: cf.opportunity_name || undefined, amount: Number(cf.amount) || undefined, expected_close_date: cf.expected_close_date || undefined }) }),
    onSuccess: (r) => { notifySuccess(t('crmx.toast_converted', { opp: r.opp_no })); setConv(null); refresh(); qc.invalidateQueries({ queryKey: ['crm-opps'] }); router.push(`/crm/deals/${encodeURIComponent(r.opp_no)}`); },
    onError: (e: Error) => notifyError(e.message),
  });

  const leadBadge = (s: string) => <Badge variant={s === 'converted' ? 'success' : s === 'lost' ? 'destructive' : s === 'qualified' ? 'info' : 'muted'}>{s}</Badge>;

  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-base font-semibold">{t('crmx.add_lead')}</h3>
          <ImportWizard onDone={refresh} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="grid gap-1.5"><Label>{t('crmx.f_contact_name')}</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('crmx.f_company')}</Label><Input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('crmx.f_source')}</Label><Input value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} placeholder={t('crmx.ph_source')} /></div>
          <div className="grid gap-1.5"><Label>{t('crmx.f_email')}</Label><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('crmx.f_phone')}</Label><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
        </div>
        <div><Button onClick={() => create.mutate()} disabled={!f.name || create.isPending}><Plus className="size-4" /> {t('crmx.add_lead')}</Button></div>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-auto" aria-label={t('crmx.f_lead_status')} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">{t('crmx.f_lead_status_all')}</option>
          {['new', 'qualified', 'converted', 'lost'].map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        <Select className="w-auto" aria-label={t('crmx.f_source')} value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
          <option value="">{t('crmx.f_source_all')}</option>
          {sources.map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
      </div>

      <StateView q={q}>
        <DataTable
          rows={rows}
          rowKey={(r) => r.lead_no}
          columns={[
            { key: 'lead_no', label: t('dash.col_no') },
            { key: 'name', label: t('crmx.f_contact_name'), render: (r: Lead) => `${r.name}${r.company ? ` · ${r.company}` : ''}` },
            { key: 'source', label: t('crmx.f_source'), render: (r: Lead) => r.source ?? '—' },
            { key: 'owner', label: t('crmx.col_owner'), render: (r: Lead) => r.owner ?? '—' },
            { key: 'status', label: t('fin.col_status'), render: (r: Lead) => leadBadge(r.status) },
            {
              key: 'act', label: '', sortable: false,
              render: (r: Lead) => (
                <div className="flex justify-end gap-1">
                  {r.status === 'new' && <Button size="sm" variant="ghost" title={t('crmx.tip_qualify')} onClick={() => qualify.mutate(r.lead_no)}><UserCheck className="size-4" /></Button>}
                  {(r.status === 'new' || r.status === 'qualified') && <Button size="sm" variant="ghost" title={t('crmx.tip_convert')} onClick={() => { setConv({ lead_no: r.lead_no, name: r.company || r.name }); setCf({ opportunity_name: `${r.company || r.name} opportunity`, amount: '', expected_close_date: '' }); }}><ArrowRightLeft className="size-4" /></Button>}
                  {(r.status === 'new' || r.status === 'qualified') && <Button size="sm" variant="ghost" title={t('crmx.tip_lose')} onClick={() => lose.mutate(r.lead_no)}><XCircle className="size-4" /></Button>}
                </div>
              ),
            },
          ]}
          emptyState={{ icon: Handshake, title: t('crmx.empty_leads_title'), description: t('crmx.empty_leads_desc') }}
        />
      </StateView>

      <Dialog open={!!conv} onOpenChange={(o) => !o && setConv(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('crmx.dlg_convert')} — {conv?.name}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5"><Label>{t('crmx.f_opp_name')}</Label><Input value={cf.opportunity_name} onChange={(e) => setCf({ ...cf, opportunity_name: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>{t('crmx.f_amount')}</Label><Input type="number" min="0" value={cf.amount} onChange={(e) => setCf({ ...cf, amount: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('crmx.f_expected_close')}</Label><Input type="date" value={cf.expected_close_date} onChange={(e) => setCf({ ...cf, expected_close_date: e.target.value })} /></div>
            </div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setConv(null)}>{t('crmx.btn_cancel')}</Button><Button onClick={() => convert.mutate()} disabled={convert.isPending}>{t('crmx.btn_convert')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// CSV/XLSX lead-import wizard: pick file or paste CSV → dry-run validation report → import.
interface ImportReport { total: number; valid?: number; invalid?: number; imported?: number; skipped?: number; dry_run: boolean; errors: { row: number; column?: string; code: string; messageTh?: string; message: string }[] }
function ImportWizard({ onDone }: { onDone: () => void }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState('');
  const [xlsx, setXlsx] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const body = () => (xlsx ? { format: 'xlsx' as const, xlsx } : { format: 'csv' as const, csv });
  const validate = useMutation({
    mutationFn: () => api<ImportReport>('/api/crm/pipeline/leads/import', { method: 'POST', body: JSON.stringify({ ...body(), dry_run: true }) }),
    onSuccess: setReport,
    onError: (e: Error) => notifyError(e.message),
  });
  const commit = useMutation({
    mutationFn: () => api<ImportReport>('/api/crm/pipeline/leads/import', { method: 'POST', body: JSON.stringify(body()) }),
    onSuccess: (r) => { setReport(r); notifySuccess(t('crmx.toast_imported', { n: r.imported ?? 0 })); onDone(); },
    onError: (e: Error) => notifyError(e.message),
  });

  const onFile = (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name); setReport(null);
    const reader = new FileReader();
    if (/\.xlsx$/i.test(file.name)) {
      reader.onload = () => { const s = String(reader.result ?? ''); setXlsx(s.slice(s.indexOf(',') + 1)); setCsv(''); };
      reader.readAsDataURL(file);
    } else {
      reader.onload = () => { setCsv(String(reader.result ?? '')); setXlsx(null); };
      reader.readAsText(file);
    }
  };
  const downloadTemplate = async () => {
    const tpl = await api<{ csv: string }>('/api/crm/pipeline/leads/import/template');
    const blob = new Blob(['﻿' + tpl.csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'leads-template.csv'; a.click();
    URL.revokeObjectURL(a.href);
  };
  const reset = () => { setCsv(''); setXlsx(null); setFileName(''); setReport(null); if (fileRef.current) fileRef.current.value = ''; };
  const hasInput = !!xlsx || !!csv.trim();

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => { reset(); setOpen(true); }}><Upload className="size-4" /> {t('crmx.btn_import')}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{t('crmx.dlg_import')}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">{t('crmx.import_help')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <input ref={fileRef} type="file" accept=".csv,.xlsx" className="text-sm" aria-label={t('crmx.f_import_file')} onChange={(e) => onFile(e.target.files?.[0])} />
              <Button variant="ghost" size="sm" onClick={downloadTemplate}><Download className="size-4" /> {t('crmx.btn_template')}</Button>
            </div>
            {!xlsx && (
              <textarea
                className="min-h-28 w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs"
                placeholder={'Name,Company,Email,Phone,Source\nสมชาย ใจดี,บ.ตัวอย่าง จำกัด,somchai@ex.com,0812345678,expo'}
                aria-label={t('crmx.f_import_paste')}
                value={csv}
                onChange={(e) => { setCsv(e.target.value); setReport(null); }}
              />
            )}
            {fileName && <p className="text-xs text-muted-foreground">{fileName}</p>}
            {report && (
              <div className="rounded-md border p-2 text-sm">
                <p>
                  {report.dry_run
                    ? t('crmx.import_report_dry', { total: report.total, valid: report.valid ?? 0, invalid: report.invalid ?? 0 })
                    : t('crmx.import_report_done', { imported: report.imported ?? 0, skipped: report.skipped ?? 0 })}
                </p>
                {report.errors.length > 0 && (
                  <ul className="mt-1 max-h-32 list-inside list-disc overflow-y-auto text-xs text-destructive">
                    {report.errors.slice(0, 30).map((e, i) => <li key={i}>{t('crmx.import_row', { n: e.row })}: {e.messageTh ?? e.message}</li>)}
                  </ul>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t('crmx.btn_close')}</Button>
            <Button variant="secondary" disabled={!hasInput || validate.isPending} onClick={() => validate.mutate()}>{t('crmx.btn_validate')}</Button>
            <Button disabled={!hasInput || commit.isPending || (report?.dry_run === true && (report.valid ?? 0) === 0)} onClick={() => commit.mutate()}><Upload className="size-4" /> {t('crmx.btn_do_import')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Accounts: search + create with DUPLICATE_SUSPECT merge-suggestion dialog ──────────────────────
interface DupMatch { account_no?: string; id?: number; name: string; email: string | null; phone: string | null; tax_id?: string | null; reasons: string[] }
function AccountsTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const q = useQuery<{ accounts: Account[] }>({ queryKey: ['crm-accounts', search], queryFn: () => api(`/api/crm/accounts${search ? `?search=${encodeURIComponent(search)}` : ''}`) });

  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', tax_id: '', industry: '', email: '', phone: '' });
  const [dups, setDups] = useState<DupMatch[] | null>(null);
  const create = useMutation({
    mutationFn: (force: boolean) => api<Account>('/api/crm/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: f.name, tax_id: f.tax_id || undefined, industry: f.industry || undefined, email: f.email || undefined, phone: f.phone || undefined, force: force || undefined }),
    }),
    onSuccess: (r) => {
      notifySuccess(t('crmx.toast_account_created', { no: r.account_no }));
      setOpen(false); setDups(null); setF({ name: '', tax_id: '', industry: '', email: '', phone: '' });
      qc.invalidateQueries({ queryKey: ['crm-accounts'] });
    },
    onError: (e: Error & { code?: string; details?: { matches?: DupMatch[] } }) => {
      if (e.code === 'DUPLICATE_SUSPECT') setDups(e.details?.matches ?? []);
      else notifyError(e.message);
    },
  });

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="w-56 pl-8" aria-label={t('crmx.f_search')} placeholder={t('crmx.ph_account_search')} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="ms-auto"><Button size="sm" onClick={() => { setDups(null); setOpen(true); }}><Plus className="size-4" /> {t('crmx.btn_new_account')}</Button></div>
      </div>
      <StateView q={q}>
        <DataTable
          rows={q.data?.accounts ?? []}
          rowKey={(r) => r.account_no}
          columns={[
            { key: 'account_no', label: t('dash.col_no'), render: (r: Account) => <Link className="text-primary underline-offset-2 hover:underline" href={`/crm/accounts/${encodeURIComponent(r.account_no)}`}>{r.account_no}</Link> },
            { key: 'name', label: t('crmx.col_account'), render: (r: Account) => <Link className="hover:underline" href={`/crm/accounts/${encodeURIComponent(r.account_no)}`}>{r.name}</Link> },
            { key: 'industry', label: t('crmx.col_industry'), render: (r: Account) => r.industry ?? '—' },
            { key: 'email', label: t('crmx.f_email'), render: (r: Account) => r.email ?? '—' },
            { key: 'phone', label: t('crmx.f_phone'), render: (r: Account) => r.phone ?? '—' },
            { key: 'customer_no', label: t('crmx.col_customer_no'), render: (r: Account) => r.customer_no ?? '—' },
            { key: 'status', label: t('fin.col_status'), render: (r: Account) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
          ]}
          emptyState={{ icon: Building2, title: t('crmx.empty_accounts_title'), description: t('crmx.empty_accounts_desc') }}
        />
      </StateView>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('crmx.dlg_new_account')}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5"><Label>{t('crmx.f_account_name')}</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>{t('crmx.f_tax_id')}</Label><Input value={f.tax_id} onChange={(e) => setF({ ...f, tax_id: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('crmx.col_industry')}</Label><Input value={f.industry} onChange={(e) => setF({ ...f, industry: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('crmx.f_email')}</Label><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('crmx.f_phone')}</Label><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t('crmx.btn_cancel')}</Button>
            <Button disabled={!f.name.trim() || create.isPending} onClick={() => create.mutate(false)}><Plus className="size-4" /> {t('crmx.btn_create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DupDialog
        matches={dups}
        onClose={() => setDups(null)}
        onForce={() => create.mutate(true)}
        linkOf={(m) => m.account_no ? `/crm/accounts/${encodeURIComponent(m.account_no)}` : undefined}
      />
    </div>
  );
}

// Shared duplicate-suspect (409) dialog: show the matches, open the existing record, or steward-force.
function DupDialog({ matches, onClose, onForce, linkOf }: { matches: DupMatch[] | null; onClose: () => void; onForce: () => void; linkOf?: (m: DupMatch) => string | undefined }) {
  const { t } = useLang();
  return (
    <Dialog open={!!matches} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{t('crmx.dlg_dup_title')}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">{t('crmx.dup_help')}</p>
        <div className="grid max-h-64 gap-2 overflow-y-auto">
          {(matches ?? []).map((m, i) => {
            const href = linkOf?.(m);
            return (
              <div key={i} className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium">{m.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{[m.email, m.phone, m.tax_id].filter(Boolean).join(' · ') || '—'}</div>
                  <div className="mt-1 flex gap-1">{m.reasons.map((r) => <Badge key={r} variant="warning">{t(`crmx.dup_reason_${r}`)}</Badge>)}</div>
                </div>
                {href && <Button size="sm" variant="outline" asChild><Link href={href} onClick={onClose}>{t('crmx.btn_open_existing')}</Link></Button>}
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('crmx.btn_cancel')}</Button>
          <Button variant="destructive" onClick={() => { onForce(); }}>{t('crmx.btn_force_create')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Contacts: search + create with duplicate governance ────────────────────
const CONTACT_ROLES = ['decision_maker', 'billing', 'technical', 'other'] as const;
function ContactsTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const q = useQuery<{ contacts: Contact[] }>({ queryKey: ['crm-contacts', search], queryFn: () => api(`/api/crm/contacts${search ? `?search=${encodeURIComponent(search)}` : ''}`) });
  const accountsQ = useQuery<{ accounts: Account[] }>({ queryKey: ['crm-accounts', ''], queryFn: () => api('/api/crm/accounts') });

  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ account_no: '', name: '', email: '', phone: '', role: 'other' });
  const [dups, setDups] = useState<DupMatch[] | null>(null);
  const create = useMutation({
    mutationFn: (force: boolean) => api('/api/crm/contacts', {
      method: 'POST',
      body: JSON.stringify({ account_no: f.account_no, name: f.name, email: f.email || undefined, phone: f.phone || undefined, role: f.role, force: force || undefined }),
    }),
    onSuccess: () => {
      notifySuccess(t('crmx.toast_contact_created'));
      setOpen(false); setDups(null); setF({ account_no: '', name: '', email: '', phone: '', role: 'other' });
      qc.invalidateQueries({ queryKey: ['crm-contacts'] });
    },
    onError: (e: Error & { code?: string; details?: { matches?: DupMatch[] } }) => {
      if (e.code === 'DUPLICATE_SUSPECT') setDups(e.details?.matches ?? []);
      else notifyError(e.message);
    },
  });

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="w-56 pl-8" aria-label={t('crmx.f_search')} placeholder={t('crmx.ph_contact_search')} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="ms-auto"><Button size="sm" onClick={() => { setDups(null); setOpen(true); }}><Plus className="size-4" /> {t('crmx.btn_new_contact')}</Button></div>
      </div>
      <StateView q={q}>
        <DataTable
          rows={q.data?.contacts ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: 'name', label: t('crmx.f_contact_name') },
            { key: 'role', label: t('crmx.col_role'), render: (r: Contact) => <Badge variant="secondary">{t(`crmx.role_${r.role}`)}</Badge> },
            { key: 'email', label: t('crmx.f_email'), render: (r: Contact) => r.email ?? '—' },
            { key: 'phone', label: t('crmx.f_phone'), render: (r: Contact) => r.phone ?? '—' },
            { key: 'status', label: t('fin.col_status'), render: (r: Contact) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
          ]}
          emptyState={{ icon: Users, title: t('crmx.empty_contacts_title'), description: t('crmx.empty_contacts_desc') }}
        />
      </StateView>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('crmx.dlg_new_contact')}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>{t('crmx.f_account')}</Label>
              <Select value={f.account_no} onChange={(e) => setF({ ...f, account_no: e.target.value })}>
                <option value="">{t('crmx.f_account_pick')}</option>
                {(accountsQ.data?.accounts ?? []).map((a) => <option key={a.account_no} value={a.account_no}>{a.name}</option>)}
              </Select>
            </div>
            <div className="grid gap-1.5"><Label>{t('crmx.f_contact_name')}</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>{t('crmx.f_email')}</Label><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('crmx.f_phone')}</Label><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
            </div>
            <div className="grid gap-1.5">
              <Label>{t('crmx.col_role')}</Label>
              <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
                {CONTACT_ROLES.map((r) => <option key={r} value={r}>{t(`crmx.role_${r}`)}</option>)}
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t('crmx.btn_cancel')}</Button>
            <Button disabled={!f.account_no || !f.name.trim() || create.isPending} onClick={() => create.mutate(false)}><Plus className="size-4" /> {t('crmx.btn_create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DupDialog matches={dups} onClose={() => setDups(null)} onForce={() => create.mutate(true)} />
    </div>
  );
}

// ── Account plans + whitespace (CRM-7): governed plan lifecycle + product-coverage view ────────────
function PlansTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [accountNo, setAccountNo] = useState('');
  const plansQ = useQuery<{ plans: AccountPlan[] }>({ queryKey: ['crm-plans', accountNo], queryFn: () => api(`/api/crm/account-plans${accountNo ? `?account_no=${encodeURIComponent(accountNo)}` : ''}`) });
  const wsQ = useQuery<Whitespace>({ queryKey: ['crm-whitespace', accountNo], queryFn: () => api(`/api/crm/accounts/${encodeURIComponent(accountNo)}/whitespace`), enabled: !!accountNo });

  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ account_no: '', objective: '', period: '', target_revenue: '', target_categories: '' });
  const create = useMutation({
    mutationFn: () => api<AccountPlan>('/api/crm/account-plans', {
      method: 'POST',
      body: JSON.stringify({
        account_no: f.account_no, objective: f.objective || undefined, period: f.period || undefined,
        target_revenue: f.target_revenue ? Number(f.target_revenue) : undefined,
        target_categories: f.target_categories ? f.target_categories.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      }),
    }),
    onSuccess: (r) => { notifySuccess(t('crmx.toast_plan_created', { no: r.plan_no })); setOpen(false); setF({ account_no: '', objective: '', period: '', target_revenue: '', target_categories: '' }); qc.invalidateQueries({ queryKey: ['crm-plans'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const lifecycle = useMutation({
    mutationFn: (v: { plan_no: string; action: 'activate' | 'close' }) => api(`/api/crm/account-plans/${encodeURIComponent(v.plan_no)}/${v.action}`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('crmx.toast_plan_updated')); qc.invalidateQueries({ queryKey: ['crm-plans'] }); },
    onError: (e: Error) => notifyError(e.message),
  });

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Building2 className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="w-56 pl-8" aria-label={t('crmx.f_account_no')} placeholder={t('crmx.ph_plan_account')} value={accountNo} onChange={(e) => setAccountNo(e.target.value.trim())} />
        </div>
        <div className="ms-auto"><Button size="sm" onClick={() => { setF({ ...f, account_no: accountNo }); setOpen(true); }}><Plus className="size-4" /> {t('crmx.btn_new_plan')}</Button></div>
      </div>

      {accountNo && wsQ.data && (
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium"><Target className="size-4 text-primary" /> {t('crmx.whitespace_title', { targeted: wsQ.data.targeted_count, total: wsQ.data.categories.length })}</div>
          <div className="flex flex-wrap gap-1.5">
            {wsQ.data.categories.map((c) => <Badge key={c.code} variant={c.targeted ? 'success' : 'outline'} title={c.targeted ? (c.plan_no ?? '') : t('crmx.whitespace_uncovered')}>{c.name}</Badge>)}
            {!wsQ.data.categories.length && <span className="text-sm text-muted-foreground">{t('crmx.whitespace_no_cats')}</span>}
          </div>
        </Card>
      )}

      <StateView q={plansQ}>
        <DataTable
          rows={plansQ.data?.plans ?? []}
          rowKey={(r) => r.plan_no}
          columns={[
            { key: 'plan_no', label: t('dash.col_no'), render: (r: AccountPlan) => r.plan_no },
            { key: 'account_no', label: t('crmx.col_account'), render: (r: AccountPlan) => r.account_no ?? '—' },
            { key: 'period', label: t('crmx.col_period'), render: (r: AccountPlan) => r.period ?? '—' },
            { key: 'objective', label: t('crmx.col_objective'), render: (r: AccountPlan) => r.objective ?? '—' },
            { key: 'target_revenue', label: t('crmx.col_target_rev'), render: (r: AccountPlan) => baht(r.target_revenue) },
            { key: 'status', label: t('fin.col_status'), render: (r: AccountPlan) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
            { key: 'actions', label: '', render: (r: AccountPlan) => (
              <div className="flex justify-end gap-1">
                {r.status === 'draft' && <Button size="sm" variant="outline" disabled={lifecycle.isPending} onClick={() => lifecycle.mutate({ plan_no: r.plan_no, action: 'activate' })}>{t('crmx.btn_activate')}</Button>}
                {r.status === 'active' && <Button size="sm" variant="outline" disabled={lifecycle.isPending} onClick={() => lifecycle.mutate({ plan_no: r.plan_no, action: 'close' })}>{t('crmx.btn_close_plan')}</Button>}
              </div>
            ) },
          ]}
          emptyState={{ icon: Target, title: t('crmx.empty_plans_title'), description: t('crmx.empty_plans_desc') }}
        />
      </StateView>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('crmx.dlg_new_plan')}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5"><Label>{t('crmx.f_account_no')}</Label><Input value={f.account_no} onChange={(e) => setF({ ...f, account_no: e.target.value })} placeholder="ACC-…" /></div>
            <div className="grid gap-1.5"><Label>{t('crmx.col_objective')}</Label><Input value={f.objective} onChange={(e) => setF({ ...f, objective: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>{t('crmx.col_period')}</Label><Input value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })} placeholder="FY2026" /></div>
              <div className="grid gap-1.5"><Label>{t('crmx.col_target_rev')}</Label><Input type="number" min="0" value={f.target_revenue} onChange={(e) => setF({ ...f, target_revenue: e.target.value })} /></div>
            </div>
            <div className="grid gap-1.5"><Label>{t('crmx.f_target_cats')}</Label><Input value={f.target_categories} onChange={(e) => setF({ ...f, target_categories: e.target.value })} placeholder={t('crmx.ph_target_cats')} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t('crmx.btn_cancel')}</Button>
            <Button disabled={!f.account_no.trim() || create.isPending} onClick={() => create.mutate()}><Plus className="size-4" /> {t('crmx.btn_create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Account health / churn watchlist + renewal pipeline (CRM-15) ───────────────────────────────────
const HEALTH_BAND_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'outline'> = { healthy: 'success', watch: 'warning', at_risk: 'destructive', no_data: 'outline' };
function AccountHealthTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [band, setBand] = useState('');
  const portQ = useQuery<HealthPortfolio>({ queryKey: ['crm-health', band], queryFn: () => api(`/api/crm/account-health${band ? `?band=${band}` : ''}`) });
  const renQ = useQuery<RenewalPipeline>({ queryKey: ['crm-renewals'], queryFn: () => api('/api/crm/account-health/renewals') });
  const snapshot = useMutation({
    mutationFn: () => api<{ captured: number; scanned: number }>('/api/crm/account-health/snapshot', { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(t('crmx.toast_health_snapshot', { n: r.captured })); qc.invalidateQueries({ queryKey: ['crm-health'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const counts = portQ.data?.band_counts ?? {};

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <StatCard label={t('crmx.health_at_risk')} value={String(counts.at_risk ?? 0)} icon={TrendingUp} tone="danger" />
        <StatCard label={t('crmx.health_watch')} value={String(counts.watch ?? 0)} icon={BarChart3} tone="warning" />
        <StatCard label={t('crmx.health_healthy')} value={String(counts.healthy ?? 0)} icon={Target} tone="success" />
        <StatCard label={t('crmx.health_renewals')} value={baht(renQ.data?.weighted ?? 0)} icon={Handshake} tone="info" hint={t('crmx.health_renewals_hint', { n: renQ.data?.count ?? 0 })} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-auto" aria-label={t('crmx.health_band')} value={band} onChange={(e) => setBand(e.target.value)}>
          <option value="">{t('crmx.health_band_all')}</option>
          <option value="at_risk">{t('crmx.health_at_risk')}</option>
          <option value="watch">{t('crmx.health_watch')}</option>
          <option value="healthy">{t('crmx.health_healthy')}</option>
        </Select>
        <div className="ms-auto"><Button size="sm" variant="outline" disabled={snapshot.isPending} onClick={() => snapshot.mutate()}><BarChart3 className="size-4" /> {t('crmx.btn_health_snapshot')}</Button></div>
      </div>

      <StateView q={portQ}>
        <DataTable
          rows={portQ.data?.accounts ?? []}
          rowKey={(r) => r.account_no}
          columns={[
            { key: 'band', label: t('crmx.health_band'), render: (r: HealthRow) => <Badge variant={HEALTH_BAND_VARIANT[r.band] ?? 'outline'}>{t(`crmx.health_${r.band}`)}</Badge> },
            { key: 'score', label: t('crmx.health_score'), render: (r: HealthRow) => <span className="tabular-nums">{r.score}</span> },
            { key: 'account', label: t('crmx.col_account'), render: (r: HealthRow) => <Link className="text-primary underline-offset-2 hover:underline" href={`/crm/accounts/${encodeURIComponent(r.account_no)}`}>{r.name}</Link> },
            { key: 'open_weighted', label: t('crmx.stat_weighted'), render: (r: HealthRow) => baht(r.open_weighted) },
            { key: 'open_cases', label: t('crmx.health_open_cases'), render: (r: HealthRow) => r.open_cases || '—' },
            { key: 'idle', label: t('crmx.health_idle_days'), render: (r: HealthRow) => r.days_since_activity == null ? '—' : `${r.days_since_activity}d` },
            { key: 'gap', label: t('crmx.health_renewal_gap'), render: (r: HealthRow) => r.renewal_gap ? <Badge variant="warning">{t('crmx.health_gap')}</Badge> : '—' },
          ]}
          emptyState={{ icon: TrendingUp, title: t('crmx.empty_health_title'), description: t('crmx.empty_health_desc') }}
        />
      </StateView>

      {(renQ.data?.renewals?.length ?? 0) > 0 && (
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium"><Handshake className="size-4 text-primary" /> {t('crmx.health_renewal_pipeline')}</div>
          <div className="grid gap-1.5">
            {(renQ.data?.renewals ?? []).map((o) => (
              <div key={o.opp_no} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">{o.name} <Badge variant="outline">{t(`crmx.deal_${o.deal_type}`)}</Badge></span>
                <span className="tabular-nums text-muted-foreground">{baht(o.weighted)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

// ── CRM-12 — sales forecasting depth: rep→manager roll-up + coverage + waterfall + accuracy ────────
function ForecastTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [owner, setOwner] = useState('');
  const [commit, setCommit] = useState('');
  const [best, setBest] = useState('');
  const depthQ = useQuery<ForecastDepth>({ queryKey: ['crm-forecast-depth'], queryFn: () => api('/api/crm/forecast/depth') });
  const submit = useMutation({
    mutationFn: () => api('/api/crm/forecast/submission', { method: 'POST', body: JSON.stringify({ owner: owner || undefined, commit_amount: Number(commit) || 0, best_case_amount: Number(best) || 0, status: 'submitted' }) }),
    onSuccess: () => { notifySuccess(t('crmx.toast_forecast_submitted')); setCommit(''); setBest(''); qc.invalidateQueries({ queryKey: ['crm-forecast-depth'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const snapshot = useMutation({
    mutationFn: () => api<{ period: string }>('/api/crm/forecast/snapshot', { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(t('crmx.toast_forecast_snapshot', { p: r.period })); qc.invalidateQueries({ queryKey: ['crm-forecast-depth'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const d = depthQ.data;
  const cov = d?.coverage.ratio;
  const latestAcc = (d?.accuracy ?? []).slice(-1)[0];

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <StatCard label={t('crmx.fc_system_forecast')} value={baht(d?.totals.system_forecast ?? 0)} icon={TrendingUp} tone="primary" hint={d ? t('crmx.fc_period', { p: d.period }) : undefined} />
        <StatCard label={t('crmx.fc_coverage')} value={cov == null ? '—' : `${cov.toFixed(2)}×`} icon={BarChart3} tone={cov != null && cov >= 3 ? 'success' : 'warning'} hint={t('crmx.fc_coverage_hint')} />
        <StatCard label={t('crmx.fc_submitted_total')} value={baht(d?.totals.submitted_total ?? 0)} icon={Target} tone="info" hint={t('crmx.fc_reps', { n: d?.totals.submissions ?? 0 })} />
        <StatCard label={t('crmx.fc_accuracy')} value={latestAcc?.accuracy_pct == null ? '—' : `${Math.round(latestAcc.accuracy_pct)}%`} icon={Layers} tone="info" hint={latestAcc ? t('crmx.fc_accuracy_hint', { p: latestAcc.period }) : undefined} />
      </div>

      {/* Category waterfall: commit → best-case → pipeline builds the system forecast. */}
      {(d?.waterfall?.length ?? 0) > 0 && (
        <Card className="p-4">
          <div className="mb-2 text-sm font-medium">{t('crmx.fc_waterfall')}</div>
          <div className="grid gap-1.5">
            {(d?.waterfall ?? []).map((w) => (
              <div key={w.stage} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-muted-foreground">{t(`crmx.fc_cat_${w.stage}`)}</span>
                <span className="tabular-nums">+{baht(w.amount)} <span className="text-muted-foreground">→ {baht(w.running)}</span></span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Rep override submission (a rep governs their own commit; a manager may submit on behalf of a named owner). */}
      <Card className="p-4">
        <div className="mb-2 text-sm font-medium">{t('crmx.fc_submit_title')}</div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1"><Label htmlFor="fc-owner">{t('crmx.fc_owner')}</Label><Input id="fc-owner" className="w-40" placeholder={t('crmx.fc_owner_ph')} value={owner} onChange={(e) => setOwner(e.target.value)} /></div>
          <div className="grid gap-1"><Label htmlFor="fc-commit">{t('crmx.fc_commit')}</Label><Input id="fc-commit" className="w-32" inputMode="numeric" value={commit} onChange={(e) => setCommit(e.target.value)} /></div>
          <div className="grid gap-1"><Label htmlFor="fc-best">{t('crmx.fc_best_case')}</Label><Input id="fc-best" className="w-32" inputMode="numeric" value={best} onChange={(e) => setBest(e.target.value)} /></div>
          <Button size="sm" disabled={submit.isPending || !commit} onClick={() => submit.mutate()}>{t('crmx.fc_submit_btn')}</Button>
          <div className="ms-auto"><Button size="sm" variant="outline" disabled={snapshot.isPending} onClick={() => snapshot.mutate()}><BarChart3 className="size-4" /> {t('crmx.fc_snapshot_btn')}</Button></div>
        </div>
      </Card>

      <StateView q={depthQ}>
        <DataTable
          rows={d?.rollup ?? []}
          rowKey={(r) => r.owner}
          columns={[
            { key: 'owner', label: t('crmx.fc_owner'), render: (r: ForecastRollupRow) => <span className="font-medium">{r.owner}</span> },
            { key: 'system', label: t('crmx.fc_system_forecast'), render: (r: ForecastRollupRow) => baht(r.system.forecast) },
            { key: 'open', label: t('crmx.fc_open_deals'), render: (r: ForecastRollupRow) => r.system.open_count || '—' },
            { key: 'submitted', label: t('crmx.fc_submitted'), render: (r: ForecastRollupRow) => r.submitted?.forecast == null ? <Badge variant="outline">{t('crmx.fc_not_submitted')}</Badge> : baht(r.submitted.forecast) },
            { key: 'variance', label: t('crmx.fc_variance'), render: (r: ForecastRollupRow) => r.variance == null ? '—' : <span className={`tabular-nums ${r.variance < 0 ? 'text-destructive' : 'text-emerald-600'}`}>{r.variance > 0 ? '+' : ''}{baht(r.variance)}</span> },
          ]}
          emptyState={{ icon: TrendingUp, title: t('crmx.empty_forecast_title'), description: t('crmx.empty_forecast_desc') }}
        />
      </StateView>
    </div>
  );
}

// ── CRM-11 — persisted territory & quota management: hierarchy + quota + attainment roll-up ────────
function TerritoryTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const [manager, setManager] = useState('');
  const [qScope, setQScope] = useState<'owner' | 'territory'>('owner');
  const [qSubject, setQSubject] = useState('');
  const [qTarget, setQTarget] = useState('');
  const listQ = useQuery<{ territories: TerritoryRow[] }>({ queryKey: ['crm-territories'], queryFn: () => api('/api/crm/territory/territories') });
  const attQ = useQuery<Attainment>({ queryKey: ['crm-attainment'], queryFn: () => api('/api/crm/territory/attainment') });
  const createT = useMutation({
    mutationFn: () => api('/api/crm/territory/territories', { method: 'POST', body: JSON.stringify({ name, parent_code: parent || undefined, manager: manager || undefined }) }),
    onSuccess: () => { notifySuccess(t('crmx.toast_territory_created')); setName(''); setParent(''); setManager(''); qc.invalidateQueries({ queryKey: ['crm-territories'] }); qc.invalidateQueries({ queryKey: ['crm-attainment'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const setQuota = useMutation({
    mutationFn: () => api('/api/crm/territory/quotas', { method: 'POST', body: JSON.stringify({ scope: qScope, subject: qSubject, target_amount: Number(qTarget) || 0 }) }),
    onSuccess: () => { notifySuccess(t('crmx.toast_quota_set')); setQSubject(''); setQTarget(''); qc.invalidateQueries({ queryKey: ['crm-attainment'] }); },
    onError: (e: Error) => notifyError(e.message),
  });

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-2 text-sm font-medium">{t('crmx.terr_create_title')}</div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1"><Label htmlFor="tr-name">{t('crmx.terr_name')}</Label><Input id="tr-name" className="w-40" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="grid gap-1"><Label htmlFor="tr-parent">{t('crmx.terr_parent')}</Label>
              <Select id="tr-parent" className="w-36" value={parent} onChange={(e) => setParent(e.target.value)}>
                <option value="">{t('crmx.terr_no_parent')}</option>
                {(listQ.data?.territories ?? []).map((tr) => <option key={tr.code} value={tr.code}>{tr.name}</option>)}
              </Select>
            </div>
            <div className="grid gap-1"><Label htmlFor="tr-mgr">{t('crmx.terr_manager')}</Label><Input id="tr-mgr" className="w-32" value={manager} onChange={(e) => setManager(e.target.value)} /></div>
            <Button size="sm" disabled={createT.isPending || !name} onClick={() => createT.mutate()}>{t('crmx.terr_create_btn')}</Button>
          </div>
        </Card>
        <Card className="p-4">
          <div className="mb-2 text-sm font-medium">{t('crmx.terr_quota_title')}</div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1"><Label htmlFor="q-scope">{t('crmx.terr_scope')}</Label>
              <Select id="q-scope" className="w-28" value={qScope} onChange={(e) => setQScope(e.target.value as 'owner' | 'territory')}>
                <option value="owner">{t('crmx.terr_scope_owner')}</option>
                <option value="territory">{t('crmx.terr_scope_territory')}</option>
              </Select>
            </div>
            <div className="grid gap-1"><Label htmlFor="q-subj">{t('crmx.terr_subject')}</Label><Input id="q-subj" className="w-36" placeholder={qScope === 'owner' ? t('crmx.terr_subject_owner_ph') : t('crmx.terr_subject_terr_ph')} value={qSubject} onChange={(e) => setQSubject(e.target.value)} /></div>
            <div className="grid gap-1"><Label htmlFor="q-target">{t('crmx.terr_target')}</Label><Input id="q-target" className="w-32" inputMode="numeric" value={qTarget} onChange={(e) => setQTarget(e.target.value)} /></div>
            <Button size="sm" disabled={setQuota.isPending || !qSubject || !qTarget} onClick={() => setQuota.mutate()}>{t('crmx.terr_quota_btn')}</Button>
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-2 text-sm font-medium">{t('crmx.terr_owner_attainment')}</div>
          <StateView q={attQ}>
            <DataTable
              rows={attQ.data?.owners ?? []}
              rowKey={(r) => r.owner}
              columns={[
                { key: 'owner', label: t('crmx.fc_owner'), render: (r: Attainment['owners'][number]) => <span className="font-medium">{r.owner}</span> },
                { key: 'won', label: t('crmx.terr_won'), render: (r: Attainment['owners'][number]) => baht(r.won_amount) },
                { key: 'quota', label: t('crmx.terr_quota'), render: (r: Attainment['owners'][number]) => r.quota ? baht(r.quota) : '—' },
                { key: 'att', label: t('crmx.terr_attainment'), render: (r: Attainment['owners'][number]) => r.attainment_pct == null ? '—' : <Badge variant={r.attainment_pct >= 100 ? 'success' : r.attainment_pct >= 70 ? 'warning' : 'destructive'}>{Math.round(r.attainment_pct)}%</Badge> },
              ]}
              emptyState={{ icon: Target, title: t('crmx.terr_empty_att_title'), description: t('crmx.terr_empty_att_desc') }}
            />
          </StateView>
        </div>
        <div>
          <div className="mb-2 text-sm font-medium">{t('crmx.terr_rollup')}</div>
          <StateView q={attQ}>
            <DataTable
              rows={attQ.data?.territories ?? []}
              rowKey={(r) => r.code}
              columns={[
                { key: 'name', label: t('crmx.terr_name'), render: (r: Attainment['territories'][number]) => <span className="font-medium">{r.name}</span> },
                { key: 'members', label: t('crmx.terr_members'), render: (r: Attainment['territories'][number]) => r.member_count || '—' },
                { key: 'won', label: t('crmx.terr_subtree_won'), render: (r: Attainment['territories'][number]) => baht(r.subtree_won) },
                { key: 'quota', label: t('crmx.terr_quota'), render: (r: Attainment['territories'][number]) => r.quota ? baht(r.quota) : '—' },
                { key: 'att', label: t('crmx.terr_attainment'), render: (r: Attainment['territories'][number]) => r.attainment_pct == null ? '—' : <Badge variant={r.attainment_pct >= 100 ? 'success' : r.attainment_pct >= 70 ? 'warning' : 'destructive'}>{Math.round(r.attainment_pct)}%</Badge> },
              ]}
              emptyState={{ icon: Layers, title: t('crmx.terr_empty_terr_title'), description: t('crmx.terr_empty_terr_desc') }}
            />
          </StateView>
        </div>
      </div>
    </div>
  );
}

// ── CRM-8 — sales sequences / cadences: playbooks + enrolments + due-runner ──────────────────────
const SEQ_STATUS_VARIANT: Record<string, 'success' | 'warning' | 'muted' | 'outline'> = { active: 'success', completed: 'muted', stopped: 'warning' };
function SequencesTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [step1, setStep1] = useState('');
  const [enrollCode, setEnrollCode] = useState('');
  const [enrollNo, setEnrollNo] = useState('');
  const seqQ = useQuery<{ sequences: SequenceRow[] }>({ queryKey: ['crm-sequences'], queryFn: () => api('/api/crm/sequences') });
  const enrolQ = useQuery<{ enrollments: EnrollmentRow[] }>({ queryKey: ['crm-seq-enrollments'], queryFn: () => api('/api/crm/sequences/enrollments') });
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['crm-sequences'] }); qc.invalidateQueries({ queryKey: ['crm-seq-enrollments'] }); };
  const createSeq = useMutation({
    mutationFn: () => api('/api/crm/sequences', { method: 'POST', body: JSON.stringify({ name, steps: [{ channel: 'email', wait_days: 0, subject: name, body: step1 || 'Hi {{name}}' }, { channel: 'task', wait_days: 3, subject: 'Follow up' }] }) }),
    onSuccess: () => { notifySuccess(t('crmx.toast_seq_created')); setName(''); setStep1(''); invalidate(); },
    onError: (e: Error) => notifyError(e.message),
  });
  const enroll = useMutation({
    mutationFn: () => api(`/api/crm/sequences/${encodeURIComponent(enrollCode)}/enroll`, { method: 'POST', body: JSON.stringify({ entity_type: enrollNo.trim().toUpperCase().startsWith('OPP') ? 'opportunity' : 'lead', entity_no: enrollNo.trim() }) }),
    onSuccess: () => { notifySuccess(t('crmx.toast_seq_enrolled')); setEnrollNo(''); invalidate(); },
    onError: (e: Error) => notifyError(e.message),
  });
  const advance = useMutation({ mutationFn: (id: number) => api(`/api/crm/sequences/enrollments/${id}/advance`, { method: 'POST' }), onSuccess: invalidate, onError: (e: Error) => notifyError(e.message) });
  const stop = useMutation({ mutationFn: (id: number) => api(`/api/crm/sequences/enrollments/${id}/stop`, { method: 'POST' }), onSuccess: invalidate, onError: (e: Error) => notifyError(e.message) });
  const runDue = useMutation({
    mutationFn: () => api<{ advanced: number; scanned: number }>('/api/crm/sequences/run-due', { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(t('crmx.toast_seq_run', { n: r.advanced })); invalidate(); },
    onError: (e: Error) => notifyError(e.message),
  });

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-2 text-sm font-medium">{t('crmx.seq_create_title')}</div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1"><Label htmlFor="seq-name">{t('crmx.seq_name')}</Label><Input id="seq-name" className="w-44" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="grid gap-1"><Label htmlFor="seq-body">{t('crmx.seq_step1_body')}</Label><Input id="seq-body" className="w-56" placeholder="Hi {{name}}" value={step1} onChange={(e) => setStep1(e.target.value)} /></div>
            <Button size="sm" disabled={createSeq.isPending || !name} onClick={() => createSeq.mutate()}>{t('crmx.seq_create_btn')}</Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t('crmx.seq_create_hint')}</p>
        </Card>
        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between gap-2"><span className="text-sm font-medium">{t('crmx.seq_enroll_title')}</span><Button size="sm" variant="outline" disabled={runDue.isPending} onClick={() => runDue.mutate()}><TrendingUp className="size-4" /> {t('crmx.seq_run_btn')}</Button></div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1"><Label htmlFor="seq-code">{t('crmx.seq_code')}</Label>
              <Select id="seq-code" className="w-36" value={enrollCode} onChange={(e) => setEnrollCode(e.target.value)}>
                <option value="">{t('crmx.seq_pick')}</option>
                {(seqQ.data?.sequences ?? []).filter((s) => s.active).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
              </Select>
            </div>
            <div className="grid gap-1"><Label htmlFor="seq-entity">{t('crmx.seq_entity')}</Label><Input id="seq-entity" className="w-40" placeholder="LEAD-… / OPP-…" value={enrollNo} onChange={(e) => setEnrollNo(e.target.value)} /></div>
            <Button size="sm" disabled={enroll.isPending || !enrollCode || !enrollNo} onClick={() => enroll.mutate()}>{t('crmx.seq_enroll_btn')}</Button>
          </div>
        </Card>
      </div>

      <div>
        <div className="mb-2 text-sm font-medium">{t('crmx.seq_enrollments')}</div>
        <StateView q={enrolQ}>
          <DataTable
            rows={enrolQ.data?.enrollments ?? []}
            rowKey={(r) => String(r.id)}
            columns={[
              { key: 'entity', label: t('crmx.seq_entity'), render: (r: EnrollmentRow) => <span className="font-medium">{r.entity_no}</span> },
              { key: 'step', label: t('crmx.seq_step'), render: (r: EnrollmentRow) => r.current_step || '—' },
              { key: 'status', label: t('crmx.health_band'), render: (r: EnrollmentRow) => <Badge variant={SEQ_STATUS_VARIANT[r.status] ?? 'outline'}>{t(`crmx.seq_status_${r.status}`)}</Badge> },
              { key: 'due', label: t('crmx.seq_next_due'), render: (r: EnrollmentRow) => r.next_due_at ? new Date(r.next_due_at).toLocaleDateString() : '—' },
              { key: 'actions', label: '', render: (r: EnrollmentRow) => r.status === 'active' ? (
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" disabled={advance.isPending} onClick={() => advance.mutate(r.id)}>{t('crmx.seq_advance')}</Button>
                  <Button size="sm" variant="ghost" disabled={stop.isPending} onClick={() => stop.mutate(r.id)}>{t('crmx.seq_stop')}</Button>
                </div>
              ) : '—' },
            ]}
            emptyState={{ icon: Handshake, title: t('crmx.seq_empty_title'), description: t('crmx.seq_empty_desc') }}
          />
        </StateView>
      </div>
    </div>
  );
}
