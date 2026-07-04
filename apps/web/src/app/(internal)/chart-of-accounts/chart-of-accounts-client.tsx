'use client';

// ผังบัญชี (Chart of Accounts) — a dedicated, read-optimised reference view of the tenant's chart.
// Richer than the quick-glance tab inside /accounting: the tenant's curated industry chart is *enriched*
// with the full accounting attributes from the canonical universe (normal balance, control-account flag +
// subledger, postability, required dimensions) and grouped by account type. Purely additive & read-only —
// the canonical `accounts` table is the GLOBAL immutable posting universe (GL-10), so account creation /
// editing is intentionally out of scope here (that touches the immutable chart + needs its own control).
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Ban, Download, Layers, ListTree, ShieldCheck } from 'lucide-react';

import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { SearchInput } from '@/components/search-input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

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
  // Localised type / dimension labels (guard known keys, raw fallback for unknown).
  const typeLabel = (tp: string) => (TYPE_KEY[tp] ? t(TYPE_KEY[tp]) : tp);
  const dimLabel = (d: string) => (DIM_KEY[d] ? t(DIM_KEY[d]) : d);
  const [showAll, setShowAll] = useState(false);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  // Canonical universe = the rich attribute source (normal balance, control flags, postability, dimensions).
  const canonQ = useQuery<CoaResponse>({ queryKey: ['coa', 'canonical'], queryFn: () => api('/api/ledger/accounts?all=true'), initialData: initialCanon ?? undefined });
  // The tenant's curated industry chart (active overlay rows, industry names/order). Falls back to canonical
  // when a tenant has no overlay (source: 'canonical').
  const overlayQ = useQuery<CoaResponse>({ queryKey: ['coa', 'overlay'], queryFn: () => api('/api/ledger/accounts'), initialData: initialOverlay ?? undefined });

  const gate = { isLoading: canonQ.isLoading || overlayQ.isLoading, error: canonQ.error ?? overlayQ.error };
  const hasOverlay = overlayQ.data?.industry_scoped === true;

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
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!filtered.length}>
            <Download className="size-4" /> {t('fnx.coa.export_csv')}
          </Button>
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
    </div>
  );
}
