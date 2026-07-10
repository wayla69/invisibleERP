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
} from 'lucide-react';
import { api } from '@/lib/api';
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
  const stagesQ = useQuery<Stage[]>({ queryKey: ['crm-stages'], queryFn: () => api('/api/pipeline/stages') });
  const oppsQ = useQuery<{ opportunities: Opp[]; count: number }>({ queryKey: ['crm-opps'], queryFn: () => api('/api/crm/pipeline/opportunities') });
  const sumQ = useQuery<{ open_amount: number; weighted_forecast: number; won_amount: number; win_rate: number }>({ queryKey: ['crm-summary'], queryFn: () => api('/api/crm/pipeline/summary') });

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
    onSettled: () => { qc.invalidateQueries({ queryKey: ['crm-opps'] }); qc.invalidateQueries({ queryKey: ['crm-summary'] }); },
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
              return (
                <div
                  key={colKey}
                  className={`flex w-64 shrink-0 flex-col rounded-lg border bg-muted/30 ${overCol === colKey ? 'ring-2 ring-primary/60' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOverCol(colKey); }}
                  onDragLeave={() => setOverCol((c) => (c === colKey ? null : c))}
                  onDrop={(e) => { e.preventDefault(); handleDrop(st); }}
                >
                  <div className="flex items-center justify-between border-b px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Badge variant={st.isWon ? 'success' : st.isLost ? 'destructive' : 'secondary'}>{st.name}</Badge>
                      <span className="text-xs text-muted-foreground">{num(cards.length)}</span>
                    </div>
                    <span className="text-xs tabular text-muted-foreground">{baht(total)}</span>
                  </div>
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
            <Select className="w-auto" aria-label={t('crmx.f_stage')} value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
              <option value="">{t('crmx.f_stage_all')}</option>
              {stages.map((st) => <option key={st.name} value={st.name}>{st.name}</option>)}
            </Select>
            <DataTable
              rows={filtered.filter((o) => !stageFilter || inStage(o, stages.find((x) => x.name === stageFilter)!))}
              rowKey={(r) => r.opp_no}
              emptyState={{ icon: Target, title: t('crmx.empty_deals_title'), description: t('crmx.empty_deals_desc') }}
              columns={[
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
