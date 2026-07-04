'use client';

import { useQuery } from '@tanstack/react-query';
import { ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { useLang } from '@/lib/i18n';

interface Rule {
  id: number;
  name: string;
  kind: string;
  doc_type: string | null;
  perm_a: string | null;
  perm_b: string | null;
  active: boolean;
}
interface Violation {
  rule: string;
  role: string;
  perm_a: string;
  perm_b: string;
}
interface UserConflict {
  username: string;
  role: string;
  inherent: boolean;
  conflict_count: number;
  conflicts: { ruleId: string; dutyA: string; dutyB: string; severity: string }[];
}

const kindVariant = (kind: string) => (kind === 'MAKER_CHECKER' ? 'info' : 'warning');

export default function SodPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('st.sod.title')}
        description={t('st.sod.desc')}
      />
      <Tabs
        tabs={[
          { key: 'rules', label: t('st.sod.tab_rules'), content: <Rules /> },
          { key: 'violations', label: t('st.sod.tab_violations'), content: <Violations /> },
          { key: 'users', label: t('st.sod.tab_users'), content: <UserConflicts /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── กฎ SoD ─────────────────────────
function Rules() {
  const { t } = useLang();
  const q = useQuery<{ rules: Rule[] }>({ queryKey: ['sod-rules'], queryFn: () => api('/api/sod/rules') });
  const rules = q.data?.rules ?? [];
  const active = rules.filter((r) => r.active).length;
  const permPair = rules.filter((r) => r.kind === 'PERM_PAIR').length;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label={t('st.sod.total_rules')} value={num(rules.length)} icon={ShieldCheck} tone="primary" />
        <StatCard label={t('st.sod.active_rules')} value={num(active)} icon={ShieldCheck} tone="success" />
        <StatCard label={t('st.sod.perm_pair_rules')} value={num(permPair)} icon={ShieldAlert} tone={permPair > 0 ? 'warning' : 'default'} />
      </div>

      <StateView q={q}>
        <DataTable
          rows={rules}
          rowKey={(r) => r.id}
          columns={[
            { key: 'name', label: t('st.sod.col_name') },
            { key: 'kind', label: t('st.sod.col_kind'), render: (r) => <Badge variant={kindVariant(r.kind)}>{r.kind}</Badge> },
            { key: 'doc_type', label: t('st.sod.col_doctype'), render: (r) => r.doc_type ?? t('st.sod.all_types') },
            { key: 'perm_a', label: t('st.sod.col_perm_a'), render: (r) => (r.perm_a ? <Badge variant="outline">{r.perm_a}</Badge> : '—') },
            { key: 'perm_b', label: t('st.sod.col_perm_b'), render: (r) => (r.perm_b ? <Badge variant="outline">{r.perm_b}</Badge> : '—') },
            { key: 'active', label: t('fin.col_status'), render: (r) => <Badge variant={r.active ? 'success' : 'muted'}>{r.active ? t('st.sod.active') : t('st.sod.inactive')}</Badge> },
          ]}
          emptyState={{
            icon: ShieldCheck,
            title: t('st.sod.empty_rules_title'),
            description: t('st.sod.empty_rules_desc'),
          }}
        />
      </StateView>
    </div>
  );
}

// ─────────────── ผู้ใช้ขัดแย้ง (live, per-user effective permissions) ───────────────
function UserConflicts() {
  const { t } = useLang();
  const q = useQuery<{ summary: { users_with_conflicts: number; admins_inherent: number; by_rule: Record<string, number> }; users: UserConflict[] }>(
    { queryKey: ['sod-user-conflicts'], queryFn: () => api('/api/sod/user-conflicts') },
  );
  const users = (q.data?.users ?? []).filter((u) => u.conflict_count > 0 && !u.inherent);
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label={t('st.sod.users_conflict')} value={num(q.data?.summary.users_with_conflicts ?? 0)} icon={TriangleAlert} tone={(q.data?.summary.users_with_conflicts ?? 0) > 0 ? 'danger' : 'success'} hint={t('st.sod.users_conflict_hint')} />
        <StatCard label={t('st.sod.admins')} value={num(q.data?.summary.admins_inherent ?? 0)} icon={ShieldAlert} tone="warning" hint={t('st.sod.admins_hint')} />
      </div>
      <StateView q={q}>
        <DataTable
          rows={users}
          rowKey={(r) => r.username}
          columns={[
            { key: 'username', label: t('st.sod.col_user') },
            { key: 'role', label: t('st.sod.col_role'), render: (r) => <Badge variant="outline">{r.role}</Badge> },
            { key: 'conflict_count', label: t('st.sod.col_count'), align: 'right' },
            { key: 'conflicts', label: t('st.sod.col_conflicts'), render: (r) => (
              <div className="flex flex-wrap gap-1">
                {r.conflicts.map((c) => (
                  <Badge key={c.ruleId} variant={c.severity === 'High' ? 'destructive' : 'warning'} title={`${c.dutyA} ✗ ${c.dutyB}`}>{c.ruleId}</Badge>
                ))}
              </div>
            ) },
          ]}
          emptyState={{
            icon: ShieldCheck,
            title: t('st.sod.empty_users_title'),
            description: t('st.sod.empty_users_desc'),
          }}
        />
      </StateView>
    </div>
  );
}

// ───────────────────────── บทบาทขัดแย้ง ─────────────────────────
function Violations() {
  const { t } = useLang();
  const q = useQuery<{ violations: Violation[]; count: number }>({ queryKey: ['sod-violations'], queryFn: () => api('/api/sod/violations') });
  const violations = q.data?.violations ?? [];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label={t('st.sod.roles_conflict')}
          value={num(q.data?.count ?? 0)}
          icon={TriangleAlert}
          tone={(q.data?.count ?? 0) > 0 ? 'danger' : 'success'}
          hint={t('st.sod.roles_conflict_hint')}
        />
      </div>

      <StateView q={q}>
        <DataTable
          rows={violations}
          rowKey={(r, i) => `${r.rule}-${r.role}-${i}`}
          columns={[
            { key: 'rule', label: t('st.sod.col_rule') },
            { key: 'role', label: t('st.sod.col_role'), render: (r) => <Badge variant="destructive">{r.role}</Badge> },
            { key: 'perm_a', label: t('st.sod.col_perm_a'), render: (r) => <Badge variant="outline">{r.perm_a}</Badge> },
            { key: 'perm_b', label: t('st.sod.col_perm_b'), render: (r) => <Badge variant="outline">{r.perm_b}</Badge> },
          ]}
          emptyState={{
            icon: ShieldCheck,
            title: t('st.sod.empty_viol_title'),
            description: t('st.sod.empty_viol_desc'),
          }}
        />
      </StateView>
    </div>
  );
}
