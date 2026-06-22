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

const kindVariant = (kind: string) => (kind === 'MAKER_CHECKER' ? 'info' : 'warning');

export default function SodPage() {
  return (
    <div>
      <PageHeader
        title="แยกหน้าที่ (Segregation of Duties)"
        description="กฎการแบ่งแยกหน้าที่ — กันไม่ให้คนเดียวถือสองสิทธิ์ที่ขัดกัน (PERM_PAIR) หรืออนุมัติเอกสารตัวเอง (MAKER_CHECKER)"
      />
      <Tabs
        tabs={[
          { key: 'rules', label: 'กฎ SoD', content: <Rules /> },
          { key: 'violations', label: 'รายการขัดแย้ง', content: <Violations /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── กฎ SoD ─────────────────────────
function Rules() {
  const q = useQuery<{ rules: Rule[] }>({ queryKey: ['sod-rules'], queryFn: () => api('/api/sod/rules') });
  const rules = q.data?.rules ?? [];
  const active = rules.filter((r) => r.active).length;
  const permPair = rules.filter((r) => r.kind === 'PERM_PAIR').length;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label="กฎทั้งหมด" value={num(rules.length)} icon={ShieldCheck} tone="primary" />
        <StatCard label="ใช้งานอยู่" value={num(active)} icon={ShieldCheck} tone="success" />
        <StatCard label="กฎสิทธิ์ขัดกัน (PERM_PAIR)" value={num(permPair)} icon={ShieldAlert} tone={permPair > 0 ? 'warning' : 'default'} />
      </div>

      <StateView q={q}>
        <DataTable
          rows={rules}
          rowKey={(r) => r.id}
          columns={[
            { key: 'name', label: 'ชื่อกฎ' },
            { key: 'kind', label: 'ชนิด', render: (r) => <Badge variant={kindVariant(r.kind)}>{r.kind}</Badge> },
            { key: 'doc_type', label: 'ประเภทเอกสาร', render: (r) => r.doc_type ?? '— ทุกประเภท' },
            { key: 'perm_a', label: 'สิทธิ์ A', render: (r) => (r.perm_a ? <Badge variant="outline">{r.perm_a}</Badge> : '—') },
            { key: 'perm_b', label: 'สิทธิ์ B', render: (r) => (r.perm_b ? <Badge variant="outline">{r.perm_b}</Badge> : '—') },
            { key: 'active', label: 'สถานะ', render: (r) => <Badge variant={r.active ? 'success' : 'muted'}>{r.active ? 'ใช้งาน' : 'ปิด'}</Badge> },
          ]}
          emptyText="ยังไม่มีกฎ SoD"
        />
      </StateView>
    </div>
  );
}

// ───────────────────────── รายการขัดแย้ง ─────────────────────────
function Violations() {
  const q = useQuery<{ violations: Violation[]; count: number }>({ queryKey: ['sod-violations'], queryFn: () => api('/api/sod/violations') });
  const violations = q.data?.violations ?? [];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label="บทบาทที่ขัดกฎ"
          value={num(q.data?.count ?? 0)}
          icon={TriangleAlert}
          tone={(q.data?.count ?? 0) > 0 ? 'danger' : 'success'}
          hint="บทบาทที่ถือสองสิทธิ์ขัดกัน"
        />
      </div>

      <StateView q={q}>
        <DataTable
          rows={violations}
          rowKey={(r, i) => `${r.rule}-${r.role}-${i}`}
          columns={[
            { key: 'rule', label: 'กฎ' },
            { key: 'role', label: 'บทบาท', render: (r) => <Badge variant="destructive">{r.role}</Badge> },
            { key: 'perm_a', label: 'สิทธิ์ A', render: (r) => <Badge variant="outline">{r.perm_a}</Badge> },
            { key: 'perm_b', label: 'สิทธิ์ B', render: (r) => <Badge variant="outline">{r.perm_b}</Badge> },
          ]}
          emptyText="ไม่พบความขัดแย้ง — ทุกบทบาทถูกต้องตามกฎ"
        />
      </StateView>
    </div>
  );
}
