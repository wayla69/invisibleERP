'use client';

// ผังบัญชี (Chart of Accounts) — the tenant's chart reference view PLUS the GL-11 manage surface (docs/40
// step 2). Reads stay read-optimised (industry overlay enriched with the canonical attributes); writes map
// 1:1 onto the CoaController duties: canonical create/edit/deactivate = platform Admin/HQ only
// (COA_ADMIN_ONLY — the `accounts` universe is shared by every tenant), while the per-tenant overlay
// show/hide toggle is any gl_coa holder, and only when the tenant ALREADY runs a curated overlay — the
// first overlay row would otherwise flip listAccounts into overlay mode and collapse the chart to one row.
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Download, Eye, EyeOff, Layers, ListTree, Pencil, Plus, Power, ShieldCheck } from 'lucide-react';

import { api } from '@/lib/api';
import { thaiDateTime } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { useMe } from '@/lib/auth';
import { notifySuccess, notifyFromError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { SearchInput } from '@/components/search-input';
import { FormField } from '@/components/form-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

// Canonical rows arrive camelCase (raw Drizzle); the industry-overlay rows arrive as a snake_case subset.
type RawAccount = {
  code: string;
  name: string;
  nameTh?: string | null;
  name_th?: string | null;
  type?: string | null;
  parentCode?: string | null;
  group_label?: string | null;
  normalBalance?: string | null;
  isControl?: boolean | null;
  controlSubledger?: string | null;
  isPostable?: boolean | null;
  cfBucket?: string | null;
  isCurrent?: boolean | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  requireDimension?: Record<string, boolean> | null;
  active?: string | boolean | null;
};

type Row = {
  code: string;
  name: string;
  nameTh: string | null;
  type: string;
  parentCode: string | null;
  groupLabel: string | null;
  normalBalance: string | null;
  isControl: boolean;
  controlSubledger: string | null;
  isPostable: boolean;
  requireDimension: Record<string, boolean> | null;
  active: boolean;
  cfBucket: string | null;
  isCurrent: boolean | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
};

type CoaResponse = { accounts: RawAccount[]; count?: number; source?: string; industry_scoped?: boolean };

const TYPE_ORDER = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'] as const;
const TYPE_KEY: Record<string, string> = {
  Asset: 'fnx.coa.type_asset',
  Liability: 'fnx.coa.type_liability',
  Equity: 'fnx.coa.type_equity',
  Revenue: 'fnx.coa.type_revenue',
  Expense: 'fnx.coa.type_expense',
  Other: 'fnx.coa.type_other',
};

const DIM_KEY: Record<string, string> = { branch: 'fnx.coa.dim_branch', project: 'fnx.coa.dim_project', department: 'fnx.coa.dim_department', cost_center: 'fnx.coa.dim_cost_center' };

export function ChartOfAccountsClient({ initialCanon, initialOverlay }: { initialCanon?: CoaResponse; initialOverlay?: CoaResponse }) {
  const { t } = useLang();
  const me = useMe();
  const qc = useQueryClient();
  // Canonical writes are HQ-only (the API re-asserts COA_ADMIN_ONLY server-side — this only shapes the UI).
  const isAdmin = me.data?.role === 'Admin';
  // Localised type / dimension labels (guard known keys, raw fallback for unknown).
  const typeLabel = (tp: string) => (TYPE_KEY[tp] ? t(TYPE_KEY[tp]) : tp);
  const dimLabel = (d: string) => (DIM_KEY[d] ? t(DIM_KEY[d]) : d);
  const [showAll, setShowAll] = useState(false);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [subOf, setSubOf] = useState<Row | null>(null);
  const [editing, setEditing] = useState<Row | null>(null);
  const [deactivating, setDeactivating] = useState<Row | null>(null);

  // Canonical universe = the rich attribute source (normal balance, control flags, postability, dimensions).
  const canonQ = useQuery<CoaResponse>({ queryKey: ['coa', 'canonical'], queryFn: () => api('/api/ledger/accounts?all=true'), initialData: initialCanon ?? undefined });
  // The tenant's curated industry chart (active overlay rows, industry names/order). Falls back to canonical
  // when a tenant has no overlay (source: 'canonical').
  const overlayQ = useQuery<CoaResponse>({ queryKey: ['coa', 'overlay'], queryFn: () => api('/api/ledger/accounts'), initialData: initialOverlay ?? undefined });

  const gate = { isLoading: canonQ.isLoading || overlayQ.isLoading, error: canonQ.error ?? overlayQ.error };
  const hasOverlay = overlayQ.data?.industry_scoped === true;
  const refresh = () => qc.invalidateQueries({ queryKey: ['coa'] });

  // Codes currently ACTIVE on the tenant's curated chart (only meaningful when hasOverlay) — drives the
  // per-row show/hide toggle in the full-chart view.
  const overlayActive = useMemo(() => new Set((hasOverlay ? overlayQ.data?.accounts ?? [] : []).map((a) => a.code)), [hasOverlay, overlayQ.data]);

  // GL-27 (COA follow-up C): canonical writes stage as change requests — the pending queue lives here so a
  // second Admin clears it on the same screen. Creator self-approval is rejected server-side (SOD_VIOLATION).
  const changes = useQuery<{ requests: any[]; count: number }>({
    queryKey: ['coa-change-requests'],
    queryFn: () => api('/api/ledger/accounts/change-requests'),
    enabled: isAdmin,
    retry: false,
  });
  const pendingChanges = useMemo(() => (changes.data?.requests ?? []).filter((r: any) => r.status === 'PendingApproval'), [changes.data]);
  // COA-D1: the request HISTORY (Approved / Rejected / AutoApplied — incl. the single-Admin exception rows)
  // was API-only; a compact register makes the GL-27 trail reviewable where the changes happen.
  const historyChanges = useMemo(() => (changes.data?.requests ?? []).filter((r: any) => r.status !== 'PendingApproval').slice(0, 20), [changes.data]);
  const [showHistory, setShowHistory] = useState(false);
  const approveChange = useMutation({
    mutationFn: (id: number) => api(`/api/ledger/accounts/change-requests/${id}/approve`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('fnx.coa.mc_approved')); qc.invalidateQueries({ queryKey: ['coa-change-requests'] }); refresh(); },
    onError: (e) => notifyFromError(e),
  });
  const rejectChange = useMutation({
    mutationFn: (id: number) => api(`/api/ledger/accounts/change-requests/${id}/reject`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => { notifySuccess(t('fnx.coa.mc_rejected')); qc.invalidateQueries({ queryKey: ['coa-change-requests'] }); },
    onError: (e) => notifyFromError(e),
  });

  // GL-11 per-tenant curation: toggle an account on/off MY chart (never touches the canonical universe).
  const curate = useMutation({
    mutationFn: ({ code, active }: { code: string; active: boolean }) =>
      api(`/api/ledger/accounts/${code}/overlay`, { method: 'PATCH', body: JSON.stringify({ active }) }),
    onSuccess: (_d, v) => { notifySuccess(t('fnx.coa.overlay_saved', { code: v.code })); refresh(); },
    onError: (e) => notifyFromError(e),
  });

  // Enrich whichever base list is shown with the canonical attributes (keyed by code).
  const rows = useMemo<Row[]>(() => {
    const canon = new Map<string, RawAccount>((canonQ.data?.accounts ?? []).map((a) => [a.code, a]));
    const base = showAll ? canonQ.data?.accounts ?? [] : overlayQ.data?.accounts ?? [];
    return base.map((r): Row => {
      const c = canon.get(r.code);
      const activeRaw = r.active ?? c?.active;
      return {
        code: r.code,
        name: r.name || c?.name || r.code,
        nameTh: r.nameTh ?? r.name_th ?? c?.nameTh ?? null,
        type: (r.type ?? c?.type ?? 'Other') as string,
        parentCode: r.parentCode ?? c?.parentCode ?? null,
        groupLabel: r.group_label ?? null,
        normalBalance: c?.normalBalance ?? r.normalBalance ?? null,
        isControl: Boolean(c?.isControl),
        controlSubledger: c?.controlSubledger ?? null,
        isPostable: c?.isPostable ?? true,
        requireDimension: (c?.requireDimension ?? r.requireDimension ?? null) as Record<string, boolean> | null,
        active: activeRaw === false || activeRaw === 'false' ? false : true,
        cfBucket: c?.cfBucket ?? null,
        isCurrent: c?.isCurrent ?? null,
        effectiveFrom: c?.effectiveFrom ?? null,
        effectiveTo: c?.effectiveTo ?? null,
      };
    });
  }, [showAll, canonQ.data, overlayQ.data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (typeFilter && r.type !== typeFilter) return false;
      if (!q) return true;
      return r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || (r.nameTh ?? '').toLowerCase().includes(q);
    });
  }, [rows, search, typeFilter]);

  const controlCount = rows.filter((r) => r.isControl).length;

  const exportCsv = () => {
    const header = ['code', 'name', 'name_th', 'type', 'normal_balance', 'is_control', 'control_subledger', 'postable', 'parent'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = filtered.map((r) =>
      [r.code, r.name, r.nameTh, r.type, r.normalBalance, r.isControl, r.controlSubledger, r.isPostable, r.parentCode].map(esc).join(','),
    );
    const blob = new Blob(['﻿' + [header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chart-of-accounts-${showAll ? 'full' : 'industry'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const nb = (v: string | null) =>
    v === 'C' ? <Badge variant="info">{t('fnx.coa.credit_cr')}</Badge> : v === 'D' ? <Badge variant="secondary">{t('fnx.coa.debit_dr')}</Badge> : <span className="text-muted-foreground">—</span>;

  const columns = [
    { key: 'code', label: t('fnx.coa.col_code'), className: 'font-medium tabular' },
    {
      key: 'name',
      label: t('fnx.coa.col_name'),
      render: (r: Row) => (
        <div className="min-w-0" style={r.parentCode ? { paddingLeft: 12 } : undefined}>
          <div className="truncate">{r.name}</div>
          {r.nameTh && <div className="truncate text-xs text-muted-foreground">{r.nameTh}</div>}
        </div>
      ),
    },
    { key: 'normalBalance', label: t('fnx.coa.col_normal_balance'), align: 'center' as const, render: (r: Row) => nb(r.normalBalance) },
    {
      key: 'flags',
      label: t('fnx.coa.col_attributes'),
      sortable: false,
      render: (r: Row) => (
        <div className="flex flex-wrap items-center gap-1">
          {r.isControl && (
            <Badge variant="warning" className="gap-1">
              <ShieldCheck className="size-3" /> {t('fnx.coa.control')}{r.controlSubledger ? ` · ${r.controlSubledger}` : ''}
            </Badge>
          )}
          {!r.isPostable && (
            <Badge variant="muted" className="gap-1">
              <Ban className="size-3" /> {t('fnx.coa.header_no_posting')}
            </Badge>
          )}
          {r.requireDimension &&
            Object.entries(r.requireDimension)
              .filter(([, on]) => on)
              .map(([d]) => (
                <Badge key={d} variant="outline">
                  {t('fnx.coa.require_dim', { dim: dimLabel(d) })}
                </Badge>
              ))}
          {!r.active && <Badge variant="destructive">{t('fnx.coa.inactive')}</Badge>}
        </div>
      ),
    },
    { key: 'parentCode', label: t('fnx.coa.col_parent'), align: 'right' as const, render: (r: Row) => r.parentCode ?? <span className="text-muted-foreground">—</span> },
    ...(isAdmin || hasOverlay
      ? [{
          key: 'actions',
          label: t('fnx.coa.col_actions'),
          sortable: false,
          align: 'right' as const,
          render: (r: Row) => (
            <div className="flex items-center justify-end gap-1">
              {hasOverlay && (overlayActive.has(r.code) ? (
                <Button size="sm" variant="ghost" title={t('fnx.coa.hide_from_chart')} disabled={curate.isPending} onClick={() => curate.mutate({ code: r.code, active: false })}>
                  <EyeOff className="size-4" />
                </Button>
              ) : (
                <Button size="sm" variant="ghost" title={t('fnx.coa.add_to_chart')} disabled={curate.isPending} onClick={() => curate.mutate({ code: r.code, active: true })}>
                  <Eye className="size-4" />
                </Button>
              ))}
              {isAdmin && (
                <Button size="sm" variant="ghost" title={t('fnx.coa.add_sub')} onClick={() => setSubOf(r)}>
                  <Layers className="size-4" />
                </Button>
              )}
              {isAdmin && (
                <Button size="sm" variant="ghost" title={t('fnx.coa.edit')} onClick={() => setEditing(r)}>
                  <Pencil className="size-4" />
                </Button>
              )}
              {isAdmin && r.active && (
                <Button size="sm" variant="ghost" title={t('fnx.coa.deactivate')} onClick={() => setDeactivating(r)}>
                  <Power className="size-4 text-destructive" />
                </Button>
              )}
            </div>
          ),
        }]
      : []),
  ];

  // Group the filtered rows by account type, in financial-statement order.
  const groups = useMemo(() => {
    const seen = new Set(filtered.map((r) => r.type));
    const order = [...TYPE_ORDER.filter((tp) => seen.has(tp)), ...[...seen].filter((tp) => !TYPE_ORDER.includes(tp as any))];
    return order.map((type) => ({ type, rows: filtered.filter((r) => r.type === type) }));
  }, [filtered]);

  return (
    <div>
      <PageHeader
        title={t('fnx.coa.title')}
        description={t('fnx.coa.description')}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!filtered.length}>
              <Download className="size-4" /> {t('fnx.coa.export_csv')}
            </Button>
            {isAdmin && (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="size-4" /> {t('fnx.coa.new_account')}
              </Button>
            )}
          </div>
        }
      />

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput value={search} onChange={setSearch} placeholder={t('fnx.coa.search_placeholder')} count={t('fnx.coa.count_accounts', { count: filtered.length })} />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={typeFilter === null ? 'default' : 'outline'} onClick={() => setTypeFilter(null)}>
            {t('fnx.coa.all')}
          </Button>
          {TYPE_ORDER.map((tp) => (
            <Button key={tp} size="sm" variant={typeFilter === tp ? 'default' : 'outline'} onClick={() => setTypeFilter((v) => (v === tp ? null : tp))}>
              {typeLabel(tp)}
            </Button>
          ))}
          {hasOverlay && (
            <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
              {showAll ? t('fnx.coa.view_industry_only') : t('fnx.coa.view_all')}
            </Button>
          )}
        </div>
      </div>

      <StateView q={gate}>
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('fnx.coa.stat_accounts')} value={rows.length} icon={ListTree} tone="primary" />
            <StatCard label={t('fnx.coa.stat_control')} value={controlCount} icon={ShieldCheck} tone="warning" />
            <StatCard
              label={t('fnx.coa.stat_view')}
              value={showAll || !hasOverlay ? t('fnx.coa.view_full') : t('fnx.coa.view_by_industry')}
              icon={Layers}
              hint={showAll || !hasOverlay ? t('fnx.coa.view_full_hint') : t('fnx.coa.view_by_industry_hint')}
            />
            <StatCard label={t('fnx.coa.stat_types')} value={groups.length} hint={t('fnx.coa.stat_types_hint')} />
          </div>

          {isAdmin && pendingChanges.length > 0 && (
            <Card className="gap-3 p-5">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold">{t('fnx.coa.mc_queue_title')}</h3>
                <Badge variant="warning">{pendingChanges.length}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">{t('fnx.coa.mc_queue_desc')}</p>
              <DataTable
                rows={pendingChanges}
                rowKey={(r: any) => r.id}
                dense
                columns={[
                  { key: 'action', label: t('fnx.coa.mc_col_action'), render: (r: any) => <Badge variant={r.action === 'deactivate' ? 'destructive' : r.action === 'create' ? 'success' : 'info'}>{t(`fnx.coa.mc_action_${r.action}`)}</Badge> },
                  { key: 'accountCode', label: t('fnx.coa.col_code'), render: (r: any) => <span className="font-mono">{r.accountCode}</span> },
                  { key: 'payload', label: t('fnx.coa.mc_col_change'), sortable: false, render: (r: any) => <span className="font-mono text-xs">{r.payload ? Object.entries(r.payload).filter(([k]) => k !== 'code').map(([k, v]) => `${k}=${v}`).join(' · ') : '—'}</span> },
                  { key: 'createdBy', label: t('fnx.coa.mc_col_by') },
                  {
                    key: 'actions', label: t('fnx.coa.col_actions'), sortable: false, render: (r: any) => (
                      <div className="flex gap-1">
                        <Button size="sm" variant="outline" disabled={approveChange.isPending} onClick={() => approveChange.mutate(Number(r.id))}>{t('fnx.coa.mc_approve')}</Button>
                        <Button size="sm" variant="ghost" disabled={rejectChange.isPending} onClick={() => rejectChange.mutate(Number(r.id))}>{t('fnx.coa.mc_reject')}</Button>
                      </div>
                    ),
                  },
                ]}
              />
            </Card>
          )}

          {isAdmin && historyChanges.length > 0 && (
            <Card className="gap-3 p-5">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold">{t('fnx.coa.mc_history_title')}</h3>
                <Badge variant="secondary">{historyChanges.length}</Badge>
                <Button size="sm" variant="ghost" onClick={() => setShowHistory((v) => !v)}>{showHistory ? t('fnx.coa.mc_history_hide') : t('fnx.coa.mc_history_show')}</Button>
              </div>
              {showHistory && (
                <DataTable
                  rows={historyChanges}
                  rowKey={(r: any) => r.id}
                  dense
                  columns={[
                    { key: 'approvedAt', label: t('fnx.coa.mc_col_at'), render: (r: any) => <span className="text-xs text-muted-foreground">{thaiDateTime(r.approvedAt ?? r.createdAt)}</span> },
                    { key: 'action', label: t('fnx.coa.mc_col_action'), render: (r: any) => <Badge variant={r.action === 'deactivate' ? 'destructive' : r.action === 'create' ? 'success' : 'info'}>{t(`fnx.coa.mc_action_${r.action}`)}</Badge> },
                    { key: 'accountCode', label: t('fnx.coa.col_code'), render: (r: any) => <span className="font-mono">{r.accountCode}</span> },
                    { key: 'status', label: t('fnx.coa.mc_col_status'), render: (r: any) => r.status === 'Approved' ? <Badge variant="success">{t('fnx.coa.mc_st_approved')}</Badge> : r.status === 'Rejected' ? <Badge variant="warning">{t('fnx.coa.mc_st_rejected')}</Badge> : <Badge variant="info">{t('fnx.coa.mc_st_autoapplied')}</Badge> },
                    { key: 'createdBy', label: t('fnx.coa.mc_col_by') },
                    { key: 'approvedBy', label: t('fnx.coa.mc_col_approver'), render: (r: any) => r.approvedBy ?? '—' },
                    { key: 'reason', label: t('fnx.coa.mc_col_reason'), sortable: false, render: (r: any) => <span className="text-xs text-muted-foreground">{r.reason ?? '—'}</span> },
                  ]}
                />
              )}
            </Card>
          )}

          {groups.length === 0 ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">{t('fnx.coa.no_match')}</Card>
          ) : (
            groups.map((g) => (
              <div key={g.type} className="space-y-2">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-foreground">{typeLabel(g.type)}</h2>
                  <Badge variant="secondary">{g.rows.length}</Badge>
                </div>
                <DataTable rows={g.rows} columns={columns} rowKey={(r) => r.code} pageSize={0} dense />
              </div>
            ))
          )}
        </div>
      </StateView>

      {creating && <CreateAccountDialog onClose={() => setCreating(false)} onSaved={() => { setCreating(false); refresh(); }} />}
      {subOf && <CreateAccountDialog preset={{ parentCode: subOf.code, type: subOf.type, suggestCode: nextChildCode(subOf.code, rows) }} onClose={() => setSubOf(null)} onSaved={() => { setSubOf(null); refresh(); }} />}
      {editing && <EditAccountDialog account={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      {deactivating && <DeactivateAccountDialog account={deactivating} onClose={() => setDeactivating(null)} onSaved={() => { setDeactivating(null); refresh(); }} />}
    </div>
  );
}

const SELECT_CLS = 'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

// Suggest the next free sub-account code under a parent: the parent code + a running 2-digit ordinal
// (e.g. 5150 → 515001, 515002…). Falls back to a longer suffix if the 6-digit space fills; the server
// re-checks uniqueness + the 4–6-digit format, so a clash just needs a manual edit.
function nextChildCode(parentCode: string, rows: Row[]): string {
  const children = rows.filter((r) => r.parentCode === parentCode).length;
  for (let n = children + 1; n < 100; n++) {
    const candidate = `${parentCode}${String(n).padStart(2, '0')}`;
    if (candidate.length <= 6 && !rows.some((r) => r.code === candidate)) return candidate;
  }
  return '';
}

// Canonical create (COA_ADMIN_ONLY server-side): a new 4–6-digit code joins the SHARED universe. A code is
// 4 digits for a control/summary account and one or two extra digits for a SUB-ACCOUNT under a parent
// (e.g. 5150 ค่าเดินทาง → 515001 ค่าเครื่องบิน). The service derives normal balance from the type unless
// overridden; new accounts default postable. `preset` pre-fills the parent + type for the "add sub-account"
// action, and locks the type to the parent's (a sub-account shares its parent's account type).
function CreateAccountDialog({ preset, onClose, onSaved }: { preset?: { parentCode: string; type: string; suggestCode: string }; onClose: () => void; onSaved: () => void }) {
  const { t } = useLang();
  const isSub = !!preset;
  const [code, setCode] = useState(preset?.suggestCode ?? '');
  const [name, setName] = useState('');
  const [nameTh, setNameTh] = useState('');
  const [type, setType] = useState<string>(preset?.type ?? 'Expense');
  const [parentCode, setParentCode] = useState(preset?.parentCode ?? '');
  // A sub-account posts (a leaf), while the parent it rolls up into is typically a non-postable header.
  const [postable, setPostable] = useState(true);
  // docs/43 PR-8: a balance-sheet account self-declares its SCF bucket + current/non-current so the
  // indirect cash flow and the BS metrics classify it without a code change.
  const [cfBucket, setCfBucket] = useState('');
  const [isCurrent, setIsCurrent] = useState('');
  // COA-D2: effective window + required dimensions — now ENFORCED by the posting guard when set.
  const [effFrom, setEffFrom] = useState('');
  const [effTo, setEffTo] = useState('');
  const [reqDims, setReqDims] = useState<Record<string, boolean>>({});
  const codeOk = /^\d{4,6}$/.test(code);
  const save = useMutation({
    mutationFn: () =>
      api('/api/ledger/accounts', {
        method: 'POST',
        body: JSON.stringify({
          code, name, type,
          ...(nameTh.trim() ? { nameTh: nameTh.trim() } : {}),
          ...(parentCode.trim() ? { parentCode: parentCode.trim() } : {}),
          isPostable: postable,
          ...(cfBucket ? { cfBucket } : {}),
          ...(isCurrent !== '' ? { isCurrent: isCurrent === 'true' } : {}),
          ...(effFrom ? { effectiveFrom: effFrom } : {}),
          ...(effTo ? { effectiveTo: effTo } : {}),
          ...(Object.values(reqDims).some(Boolean) ? { requireDimension: reqDims } : {}),
        }),
      }),
    onSuccess: (res: any) => { notifySuccess(res?.status === 'PendingApproval' ? t('fnx.coa.staged', { code }) : t('fnx.coa.created', { code })); onSaved(); },
    onError: (e) => notifyFromError(e),
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isSub ? t('fnx.coa.create_sub_title', { parent: preset!.parentCode }) : t('fnx.coa.create_title')}</DialogTitle>
          <DialogDescription>{isSub ? t('fnx.coa.create_sub_desc') : t('fnx.coa.create_desc')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <FormField label={t('fnx.coa.f_code')} htmlFor="coa-code" required error={code && !codeOk ? t('fnx.coa.f_code_error') : undefined}>
            <Input id="coa-code" value={code} onChange={(e) => setCode(e.target.value.trim())} maxLength={6} inputMode="numeric" />
          </FormField>
          <FormField label={t('fnx.coa.f_name_en')} htmlFor="coa-name" required>
            <Input id="coa-name" value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <FormField label={t('fnx.coa.f_name_th')} htmlFor="coa-name-th">
            <Input id="coa-name-th" value={nameTh} onChange={(e) => setNameTh(e.target.value)} />
          </FormField>
          <FormField label={t('fnx.coa.f_type')} htmlFor="coa-type" required hint={isSub ? t('fnx.coa.f_type_sub_hint', { parent: preset!.parentCode }) : undefined}>
            <select id="coa-type" className={SELECT_CLS} value={type} onChange={(e) => setType(e.target.value)} disabled={isSub}>
              {TYPE_ORDER.map((tp) => <option key={tp} value={tp}>{TYPE_KEY[tp] ? t(TYPE_KEY[tp]) : tp}</option>)}
            </select>
          </FormField>
          <FormField label={t('fnx.coa.f_parent')} htmlFor="coa-parent" hint={isSub ? undefined : t('fnx.coa.f_parent_hint')}>
            <Input id="coa-parent" value={parentCode} onChange={(e) => setParentCode(e.target.value.trim())} maxLength={6} inputMode="numeric" readOnly={isSub} />
          </FormField>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={postable} onChange={(e) => setPostable(e.target.checked)} />
            {t('fnx.coa.f_postable')}
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('fnx.coa.f_eff_from')} htmlFor="coa-eff-from">
              <Input id="coa-eff-from" type="date" value={effFrom} onChange={(e) => setEffFrom(e.target.value)} />
            </FormField>
            <FormField label={t('fnx.coa.f_eff_to')} htmlFor="coa-eff-to">
              <Input id="coa-eff-to" type="date" value={effTo} onChange={(e) => setEffTo(e.target.value)} />
            </FormField>
          </div>
          <div className="grid gap-1">
            <span className="text-sm font-medium">{t('fnx.coa.f_req_dims')}</span>
            <div className="flex flex-wrap gap-3 text-sm">
              {Object.keys(DIM_KEY).map((d) => (
                <label key={d} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={!!reqDims[d]} onChange={(e) => setReqDims((v) => ({ ...v, [d]: e.target.checked }))} />
                  {t(DIM_KEY[d]!)}
                </label>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">{t('fnx.coa.f_req_dims_hint')}</span>
          </div>
          {(type === 'Asset' || type === 'Liability' || type === 'Equity') && (
            <>
              <FormField label={t('fnx.coa.f_cf_bucket')} htmlFor="coa-cf">
                <select id="coa-cf" className={SELECT_CLS} value={cfBucket} onChange={(e) => setCfBucket(e.target.value)}>
                  <option value="">{t('fnx.coa.f_cf_auto')}</option>
                  <option value="operating">{t('fnx.coa.cf_operating')}</option>
                  <option value="investing">{t('fnx.coa.cf_investing')}</option>
                  <option value="financing">{t('fnx.coa.cf_financing')}</option>
                  <option value="addback">{t('fnx.coa.cf_addback')}</option>
                </select>
              </FormField>
              <FormField label={t('fnx.coa.f_is_current')} htmlFor="coa-cur">
                <select id="coa-cur" className={SELECT_CLS} value={isCurrent} onChange={(e) => setIsCurrent(e.target.value)}>
                  <option value="">{t('fnx.coa.f_cf_auto')}</option>
                  <option value="true">{t('fnx.coa.cur_current')}</option>
                  <option value="false">{t('fnx.coa.cur_noncurrent')}</option>
                </select>
              </FormField>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('fnx.coa.cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !codeOk || !name.trim()}>{t('fnx.coa.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Canonical edit (COA_ADMIN_ONLY): rename / toggle postability. Codes are immutable; the service blocks
// isPostable=false on an account that already carries postings (CODE_HAS_POSTINGS).
function EditAccountDialog({ account, onClose, onSaved }: { account: Row; onClose: () => void; onSaved: () => void }) {
  const { t } = useLang();
  const [name, setName] = useState(account.name);
  const [nameTh, setNameTh] = useState(account.nameTh ?? '');
  const [postable, setPostable] = useState(account.isPostable);
  // Backfill classification on an EXISTING account (docs/43 PR-8 added the columns; create-only until now).
  // '' = auto (fallback chain) — sending null clears an earlier declaration back to auto.
  const cf0 = account.cfBucket ?? '';
  const cur0 = account.isCurrent === true ? 'true' : account.isCurrent === false ? 'false' : '';
  const [cfBucket, setCfBucket] = useState(cf0);
  const [isCurrent, setIsCurrent] = useState(cur0);
  // COA-D2: effective window + required dimensions (enforced by the posting guard when set).
  const ef0 = account.effectiveFrom ?? '', et0 = account.effectiveTo ?? '';
  const rd0 = account.requireDimension ?? {};
  const [effFrom, setEffFrom] = useState(ef0);
  const [effTo, setEffTo] = useState(et0);
  const [reqDims, setReqDims] = useState<Record<string, boolean>>({ ...rd0 });
  const isBs = account.type === 'Asset' || account.type === 'Liability' || account.type === 'Equity';
  const save = useMutation({
    mutationFn: () =>
      api(`/api/ledger/accounts/${account.code}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...(name.trim() && name !== account.name ? { name: name.trim() } : {}),
          ...(nameTh !== (account.nameTh ?? '') ? { nameTh } : {}),
          ...(postable !== account.isPostable ? { isPostable: postable } : {}),
          ...(cfBucket !== cf0 ? { cfBucket: cfBucket || null } : {}),
          ...(isCurrent !== cur0 ? { isCurrent: isCurrent === '' ? null : isCurrent === 'true' } : {}),
          ...(effFrom !== ef0 ? { effectiveFrom: effFrom } : {}),
          ...(effTo !== et0 ? { effectiveTo: effTo } : {}),
          ...(JSON.stringify(reqDims) !== JSON.stringify(rd0) ? { requireDimension: reqDims } : {}),
        }),
      }),
    onSuccess: (res: any) => { notifySuccess(res?.status === 'PendingApproval' ? t('fnx.coa.staged', { code: account.code }) : t('fnx.coa.saved', { code: account.code })); onSaved(); },
    onError: (e) => notifyFromError(e),
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('fnx.coa.edit_title', { code: account.code })}</DialogTitle>
          <DialogDescription>{t('fnx.coa.edit_desc')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <FormField label={t('fnx.coa.f_name_en')} htmlFor="coa-e-name">
            <Input id="coa-e-name" value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <FormField label={t('fnx.coa.f_name_th')} htmlFor="coa-e-name-th">
            <Input id="coa-e-name-th" value={nameTh} onChange={(e) => setNameTh(e.target.value)} />
          </FormField>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={postable} onChange={(e) => setPostable(e.target.checked)} />
            {t('fnx.coa.f_postable')}
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('fnx.coa.f_eff_from')} htmlFor="coa-e-eff-from">
              <Input id="coa-e-eff-from" type="date" value={effFrom} onChange={(e) => setEffFrom(e.target.value)} />
            </FormField>
            <FormField label={t('fnx.coa.f_eff_to')} htmlFor="coa-e-eff-to">
              <Input id="coa-e-eff-to" type="date" value={effTo} onChange={(e) => setEffTo(e.target.value)} />
            </FormField>
          </div>
          <div className="grid gap-1">
            <span className="text-sm font-medium">{t('fnx.coa.f_req_dims')}</span>
            <div className="flex flex-wrap gap-3 text-sm">
              {Object.keys(DIM_KEY).map((d) => (
                <label key={d} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={!!reqDims[d]} onChange={(e) => setReqDims((v) => ({ ...v, [d]: e.target.checked }))} />
                  {t(DIM_KEY[d]!)}
                </label>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">{t('fnx.coa.f_req_dims_hint')}</span>
          </div>
          {isBs && (
            <>
              <FormField label={t('fnx.coa.f_cf_bucket')} htmlFor="coa-e-cf">
                <select id="coa-e-cf" className={SELECT_CLS} value={cfBucket} onChange={(e) => setCfBucket(e.target.value)}>
                  <option value="">{t('fnx.coa.f_cf_auto')}</option>
                  <option value="operating">{t('fnx.coa.cf_operating')}</option>
                  <option value="investing">{t('fnx.coa.cf_investing')}</option>
                  <option value="financing">{t('fnx.coa.cf_financing')}</option>
                  <option value="addback">{t('fnx.coa.cf_addback')}</option>
                </select>
              </FormField>
              <FormField label={t('fnx.coa.f_is_current')} htmlFor="coa-e-cur">
                <select id="coa-e-cur" className={SELECT_CLS} value={isCurrent} onChange={(e) => setIsCurrent(e.target.value)}>
                  <option value="">{t('fnx.coa.f_cf_auto')}</option>
                  <option value="true">{t('fnx.coa.cur_current')}</option>
                  <option value="false">{t('fnx.coa.cur_noncurrent')}</option>
                </select>
              </FormField>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('fnx.coa.cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}>{t('fnx.coa.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Retire — never delete (docs/40): the service refuses a non-zero balance (ACCOUNT_HAS_BALANCE); history
// stays intact and postEntry's account guard blocks new activity once isPostable flips off.
function DeactivateAccountDialog({ account, onClose, onSaved }: { account: Row; onClose: () => void; onSaved: () => void }) {
  const { t } = useLang();
  // COA follow-up B — where-used: config masters still pointing at this code. Warn-only: deactivation
  // remains balance-gated server-side, but a lingering reference would fail-closed at posting time
  // (INVALID_POSTING_ACCOUNT), so the impact is shown BEFORE the retire instead of at month-end.
  const used = useQuery<{ account_code: string; references: { source: string; count: number }[]; total: number }>({
    queryKey: ['coa-where-used', account.code],
    queryFn: () => api(`/api/ledger/accounts/${account.code}/where-used`),
  });
  const save = useMutation({
    mutationFn: () => api(`/api/ledger/accounts/${account.code}/deactivate`, { method: 'POST' }),
    onSuccess: (res: any) => { notifySuccess(res?.status === 'PendingApproval' ? t('fnx.coa.staged', { code: account.code }) : t('fnx.coa.deactivated', { code: account.code })); onSaved(); },
    onError: (e) => notifyFromError(e),
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('fnx.coa.deactivate_title', { code: account.code })}</DialogTitle>
          <DialogDescription>{t('fnx.coa.deactivate_desc')}</DialogDescription>
        </DialogHeader>
        {(used.data?.total ?? 0) > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
            <div className="font-medium">{t('fnx.coa.used_title', { n: String(used.data!.total) })}</div>
            <ul className="mt-1 list-disc pl-5">
              {used.data!.references.map((r) => (
                <li key={r.source}><span className="font-mono">{t(`fnx.coa.used_${r.source}`)}</span> × {r.count}</li>
              ))}
            </ul>
            <div className="mt-1 text-muted-foreground">{t('fnx.coa.used_hint')}</div>
          </div>
        )}
        {used.data && used.data.total === 0 && (
          <p className="text-sm text-muted-foreground">{t('fnx.coa.used_none')}</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('fnx.coa.cancel')}</Button>
          <Button variant="destructive" onClick={() => save.mutate()} disabled={save.isPending}>{t('fnx.coa.deactivate')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
