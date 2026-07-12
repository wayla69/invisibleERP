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
      {editing && <EditAccountDialog account={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      {deactivating && <DeactivateAccountDialog account={deactivating} onClose={() => setDeactivating(null)} onSaved={() => { setDeactivating(null); refresh(); }} />}
    </div>
  );
}

const SELECT_CLS = 'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

// Canonical create (COA_ADMIN_ONLY server-side): a new 4-digit code joins the SHARED universe. The service
// derives normal balance from the type unless overridden; new accounts default postable.
function CreateAccountDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useLang();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [nameTh, setNameTh] = useState('');
  const [type, setType] = useState<string>('Expense');
  const [parentCode, setParentCode] = useState('');
  const [postable, setPostable] = useState(true);
  // docs/43 PR-8: a balance-sheet account self-declares its SCF bucket + current/non-current so the
  // indirect cash flow and the BS metrics classify it without a code change.
  const [cfBucket, setCfBucket] = useState('');
  const [isCurrent, setIsCurrent] = useState('');
  const codeOk = /^\d{4}$/.test(code);
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
        }),
      }),
    onSuccess: () => { notifySuccess(t('fnx.coa.created', { code })); onSaved(); },
    onError: (e) => notifyFromError(e),
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('fnx.coa.create_title')}</DialogTitle>
          <DialogDescription>{t('fnx.coa.create_desc')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <FormField label={t('fnx.coa.f_code')} htmlFor="coa-code" required error={code && !codeOk ? t('fnx.coa.f_code_error') : undefined}>
            <Input id="coa-code" value={code} onChange={(e) => setCode(e.target.value.trim())} maxLength={4} inputMode="numeric" />
          </FormField>
          <FormField label={t('fnx.coa.f_name_en')} htmlFor="coa-name" required>
            <Input id="coa-name" value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <FormField label={t('fnx.coa.f_name_th')} htmlFor="coa-name-th">
            <Input id="coa-name-th" value={nameTh} onChange={(e) => setNameTh(e.target.value)} />
          </FormField>
          <FormField label={t('fnx.coa.f_type')} htmlFor="coa-type" required>
            <select id="coa-type" className={SELECT_CLS} value={type} onChange={(e) => setType(e.target.value)}>
              {TYPE_ORDER.map((tp) => <option key={tp} value={tp}>{TYPE_KEY[tp] ? t(TYPE_KEY[tp]) : tp}</option>)}
            </select>
          </FormField>
          <FormField label={t('fnx.coa.f_parent')} htmlFor="coa-parent">
            <Input id="coa-parent" value={parentCode} onChange={(e) => setParentCode(e.target.value.trim())} maxLength={4} inputMode="numeric" />
          </FormField>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={postable} onChange={(e) => setPostable(e.target.checked)} />
            {t('fnx.coa.f_postable')}
          </label>
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
  const save = useMutation({
    mutationFn: () =>
      api(`/api/ledger/accounts/${account.code}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...(name.trim() && name !== account.name ? { name: name.trim() } : {}),
          ...(nameTh !== (account.nameTh ?? '') ? { nameTh } : {}),
          ...(postable !== account.isPostable ? { isPostable: postable } : {}),
        }),
      }),
    onSuccess: () => { notifySuccess(t('fnx.coa.saved', { code: account.code })); onSaved(); },
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
  const save = useMutation({
    mutationFn: () => api(`/api/ledger/accounts/${account.code}/deactivate`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('fnx.coa.deactivated', { code: account.code })); onSaved(); },
    onError: (e) => notifyFromError(e),
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('fnx.coa.deactivate_title', { code: account.code })}</DialogTitle>
          <DialogDescription>{t('fnx.coa.deactivate_desc')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('fnx.coa.cancel')}</Button>
          <Button variant="destructive" onClick={() => save.mutate()} disabled={save.isPending}>{t('fnx.coa.deactivate')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
