'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, X } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';

interface AiAction { id: number; kind: string; status: string; amount: number | null; rationale: string | null; proposed_by: string; result_ref: string | null }

// Phase D1 — human-in-the-loop approval queue for AI-proposed write-ops. The AI files a PENDING
// action; a DIFFERENT authorized person (with the action's permission) approves it here to execute.
export default function AiActionsPage() {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const q = useQuery<{ actions: AiAction[]; count: number }>({ queryKey: ['ai-actions'], queryFn: () => api('/api/ai/actions?status=pending') });

  const act = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: 'approve' | 'reject' }) =>
      api(`/api/ai/actions/${id}/${decision}`, { method: 'POST', body: JSON.stringify(decision === 'reject' ? { reason: 'rejected from queue' } : {}) }),
    onSuccess: () => { setErr(null); qc.invalidateQueries({ queryKey: ['ai-actions'] }); },
    onError: (e) => setErr((e as Error).message),
  });

  return (
    <div>
      <PageHeader
        title="AI Actions — รออนุมัติ"
        description="คำสั่งที่ AI เสนอ (ลงบัญชี/สั่งซื้อ) — ผู้มีสิทธิ์อนุมัติเพื่อดำเนินการ (ผู้อนุมัติต้องไม่ใช่ผู้เสนอ)"
      />
      {err && <Alert variant="destructive" className="mb-4"><AlertDescription>{err}</AlertDescription></Alert>}
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.actions}
            columns={[
              { key: 'id', label: '#' },
              { key: 'kind', label: 'ชนิด', render: (r: AiAction) => <Badge variant="secondary"><Bot className="mr-1 size-3" />{r.kind}</Badge> },
              { key: 'amount', label: 'ยอด', align: 'right', render: (r: AiAction) => (r.amount != null ? baht(r.amount) : '—') },
              { key: 'rationale', label: 'เหตุผล', render: (r: AiAction) => r.rationale ?? '—' },
              { key: 'proposed_by', label: 'เสนอโดย' },
              {
                key: 'actions', label: '', align: 'right', render: (r: AiAction) => (
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, decision: 'approve' })}>
                      <Check className="size-4" /> อนุมัติ
                    </Button>
                    <Button size="sm" variant="ghost" className="text-destructive" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, decision: 'reject' })}>
                      <X className="size-4" /> ปฏิเสธ
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}
