'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ListChecks, Workflow, X } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs, Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface Approval {
  instance_id: number;
  doc_type: string;
  doc_no: string;
  amount: number;
  current_step: number;
  created_by: string;
  on_behalf_of: string | null;
}
interface Step {
  step_no: number;
  approver_role: string | null;
  approver_user: string | null;
  min_amount: number;
  all_of_n: number;
}
interface Definition {
  id: number;
  doc_type: string;
  name: string;
  active: boolean;
  steps: Step[];
}

export default function WorkflowPage() {
  return (
    <div>
      <PageHeader
        title="อนุมัติงาน (Workflow)"
        description="กล่องงานรออนุมัติ และผังขั้นตอนอนุมัติ — ผู้สร้างเอกสารอนุมัติเองไม่ได้ (maker-checker)"
      />
      <Tabs
        tabs={[
          { key: 'inbox', label: 'รออนุมัติของฉัน', content: <MyApprovals /> },
          { key: 'defs', label: 'ผังการอนุมัติ', content: <Definitions /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── รออนุมัติของฉัน ─────────────────────────
function MyApprovals() {
  const qc = useQueryClient();
  const q = useQuery<{ items: Approval[] }>({ queryKey: ['wf-my-approvals'], queryFn: () => api('/api/workflow/my-approvals') });
  const [msg, setMsg] = useState('');

  const act = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: 'approve' | 'reject' }) =>
      api(`/api/workflow/instances/${id}/act`, { method: 'POST', body: JSON.stringify({ decision }) }),
    onSuccess: (r: any) => {
      setMsg(`✅ ดำเนินการสำเร็จ — สถานะ: ${r.status}`);
      qc.invalidateQueries({ queryKey: ['wf-my-approvals'] });
    },
    onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });

  const items = q.data?.items ?? [];
  const totalValue = items.reduce((s, i) => s + i.amount, 0);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label="รออนุมัติ" value={num(items.length)} icon={ListChecks} tone={items.length > 0 ? 'warning' : 'success'} hint="รายการที่คุณดำเนินการได้" />
        <StatCard label="มูลค่ารวม" value={baht(totalValue)} icon={Workflow} tone="primary" />
      </div>

      <Msg ok={msg.startsWith('✅')}>{msg}</Msg>

      <StateView q={q}>
        <DataTable
          rows={items}
          rowKey={(r) => r.instance_id}
          columns={[
            { key: 'doc_type', label: 'ประเภท', render: (r) => <Badge variant="info">{r.doc_type}</Badge> },
            { key: 'doc_no', label: 'เลขที่เอกสาร' },
            { key: 'amount', label: 'มูลค่า', align: 'right', render: (r) => <span className="tabular">{baht(r.amount)}</span> },
            { key: 'current_step', label: 'ขั้นที่', align: 'right', render: (r) => num(r.current_step) },
            { key: 'created_by', label: 'ผู้สร้าง' },
            { key: 'on_behalf_of', label: 'แทน', render: (r) => r.on_behalf_of ?? '—' },
            {
              key: 'actions',
              label: '',
              sortable: false,
              align: 'right',
              render: (r) => (
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" disabled={act.isPending} onClick={() => act.mutate({ id: r.instance_id, decision: 'approve' })}>
                    <Check className="size-3.5" /> อนุมัติ
                  </Button>
                  <Button variant="destructive" size="sm" disabled={act.isPending} onClick={() => act.mutate({ id: r.instance_id, decision: 'reject' })}>
                    <X className="size-3.5" /> ปฏิเสธ
                  </Button>
                </div>
              ),
            },
          ]}
          emptyText="ไม่มีรายการรออนุมัติ"
        />
      </StateView>
    </div>
  );
}

// ───────────────────────── ผังการอนุมัติ ─────────────────────────
function Definitions() {
  const q = useQuery<{ definitions: Definition[] }>({ queryKey: ['wf-definitions'], queryFn: () => api('/api/workflow/definitions') });
  const defs = q.data?.definitions ?? [];

  return (
    <StateView q={q}>
      <div className="grid gap-4">
        {defs.length === 0 && (
          <DataTable rows={[]} columns={[{ key: 'x', label: 'ผังการอนุมัติ' }]} emptyText="ยังไม่มีผังการอนุมัติ — เอกสารจะถูกอนุมัติอัตโนมัติ" />
        )}
        {defs.map((d) => (
          <div key={d.id}>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">
                {d.name} <span className="text-muted-foreground">· {d.doc_type}</span>
              </h3>
              <Badge variant={d.active ? 'success' : 'muted'}>{d.active ? 'ใช้งาน' : 'ปิด'}</Badge>
            </div>
            <DataTable
              rows={d.steps}
              rowKey={(s) => `${d.id}-${s.step_no}`}
              columns={[
                { key: 'step_no', label: 'ขั้นที่', align: 'right', render: (s) => num(s.step_no) },
                { key: 'approver_role', label: 'บทบาทผู้อนุมัติ', render: (s) => s.approver_role ?? '—' },
                { key: 'approver_user', label: 'ผู้อนุมัติ', render: (s) => s.approver_user ?? '—' },
                { key: 'min_amount', label: 'มูลค่าขั้นต่ำ', align: 'right', render: (s) => <span className="tabular">{baht(s.min_amount)}</span> },
                { key: 'all_of_n', label: 'ต้องอนุมัติ (คน)', align: 'right', render: (s) => num(s.all_of_n) },
              ]}
              emptyText="ไม่มีขั้นตอน"
            />
          </div>
        ))}
      </div>
    </StateView>
  );
}
