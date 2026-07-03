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
const TYPE_TH: Record<string, string> = {
  Asset: 'สินทรัพย์',
  Liability: 'หนี้สิน',
  Equity: 'ส่วนของเจ้าของ',
  Revenue: 'รายได้',
  Expense: 'ค่าใช้จ่าย',
  Other: 'อื่นๆ',
};

const DIM_TH: Record<string, string> = { branch: 'สาขา', project: 'โปรเจกต์', department: 'แผนก', cost_center: 'ศูนย์ต้นทุน' };

export function ChartOfAccountsClient({ initialCanon, initialOverlay }: { initialCanon?: CoaResponse; initialOverlay?: CoaResponse }) {
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
    v === 'C' ? <Badge variant="info">เครดิต (Cr)</Badge> : v === 'D' ? <Badge variant="secondary">เดบิต (Dr)</Badge> : <span className="text-muted-foreground">—</span>;

  const columns = [
    { key: 'code', label: 'รหัส', className: 'font-medium tabular' },
    {
      key: 'name',
      label: 'ชื่อบัญชี',
      render: (r: Row) => (
        <div className="min-w-0" style={r.parentCode ? { paddingLeft: 12 } : undefined}>
          <div className="truncate">{r.name}</div>
          {r.nameTh && <div className="truncate text-xs text-muted-foreground">{r.nameTh}</div>}
        </div>
      ),
    },
    { key: 'normalBalance', label: 'ดุลปกติ', align: 'center' as const, render: (r: Row) => nb(r.normalBalance) },
    {
      key: 'flags',
      label: 'คุณสมบัติ',
      sortable: false,
      render: (r: Row) => (
        <div className="flex flex-wrap items-center gap-1">
          {r.isControl && (
            <Badge variant="warning" className="gap-1">
              <ShieldCheck className="size-3" /> ควบคุม{r.controlSubledger ? ` · ${r.controlSubledger}` : ''}
            </Badge>
          )}
          {!r.isPostable && (
            <Badge variant="muted" className="gap-1">
              <Ban className="size-3" /> หัวข้อ (ห้ามลงรายการ)
            </Badge>
          )}
          {r.requireDimension &&
            Object.entries(r.requireDimension)
              .filter(([, on]) => on)
              .map(([d]) => (
                <Badge key={d} variant="outline">
                  ต้องระบุ{DIM_TH[d] ?? d}
                </Badge>
              ))}
          {!r.active && <Badge variant="destructive">ปิดใช้งาน</Badge>}
        </div>
      ),
    },
    { key: 'parentCode', label: 'บัญชีแม่', align: 'right' as const, render: (r: Row) => r.parentCode ?? <span className="text-muted-foreground">—</span> },
  ];

  // Group the filtered rows by account type, in financial-statement order.
  const groups = useMemo(() => {
    const seen = new Set(filtered.map((r) => r.type));
    const order = [...TYPE_ORDER.filter((t) => seen.has(t)), ...[...seen].filter((t) => !TYPE_ORDER.includes(t as any))];
    return order.map((type) => ({ type, rows: filtered.filter((r) => r.type === type) }));
  }, [filtered]);

  return (
    <div>
      <PageHeader
        title="ผังบัญชี"
        description="โครงสร้างบัญชีทั้งหมด จัดกลุ่มตามประเภท พร้อมดุลปกติ บัญชีคุมยอด (control) และมิติที่ต้องระบุ"
        actions={
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!filtered.length}>
            <Download className="size-4" /> ส่งออก CSV
          </Button>
        }
      />

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput value={search} onChange={setSearch} placeholder="ค้นหารหัส/ชื่อบัญชี…" count={`${filtered.length} บัญชี`} />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={typeFilter === null ? 'default' : 'outline'} onClick={() => setTypeFilter(null)}>
            ทั้งหมด
          </Button>
          {TYPE_ORDER.map((t) => (
            <Button key={t} size="sm" variant={typeFilter === t ? 'default' : 'outline'} onClick={() => setTypeFilter((v) => (v === t ? null : t))}>
              {TYPE_TH[t]}
            </Button>
          ))}
          {hasOverlay && (
            <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'เฉพาะบัญชีของธุรกิจ' : 'แสดงบัญชีทั้งหมด'}
            </Button>
          )}
        </div>
      </div>

      <StateView q={gate}>
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="จำนวนบัญชี" value={rows.length} icon={ListTree} tone="primary" />
            <StatCard label="บัญชีคุมยอด (control)" value={controlCount} icon={ShieldCheck} tone="warning" />
            <StatCard
              label="มุมมอง"
              value={showAll || !hasOverlay ? 'ผังบัญชีเต็ม' : 'ตามประเภทธุรกิจ'}
              icon={Layers}
              hint={showAll || !hasOverlay ? 'ทุกบัญชีในระบบ' : 'บัญชีที่ใช้ในธุรกิจของคุณ'}
            />
            <StatCard label="ประเภท" value={groups.length} hint="หมวดบัญชีที่แสดง" />
          </div>

          {groups.length === 0 ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">ไม่พบบัญชีที่ตรงกับเงื่อนไข</Card>
          ) : (
            groups.map((g) => (
              <div key={g.type} className="space-y-2">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-foreground">{TYPE_TH[g.type] ?? g.type}</h2>
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
