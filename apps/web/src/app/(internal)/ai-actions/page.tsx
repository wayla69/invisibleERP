'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, Inbox, X } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface AiAction { id: number; kind: string; status: string; amount: number | null; rationale: string | null; proposed_by: string; result_ref: string | null }

// Phase D1 — human-in-the-loop approval queue for AI-proposed write-ops. The AI files a PENDING
// action; a DIFFERENT authorized person (with the action's permission) approves it here to execute.
export default function AiActionsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ actions: AiAction[]; count: number }>({ queryKey: ['ai-actions'], queryFn: () => api('/api/ai/actions?status=pending') });

  const act = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: 'approve' | 'reject' }) =>
      api(`/api/ai/actions/${id}/${decision}`, { method: 'POST', body: JSON.stringify(decision === 'reject' ? { reason: 'rejected from queue' } : {}) }),
    onSuccess: (_data, { decision }) => { notifySuccess(decision === 'approve' ? t('st.aia.approved') : t('st.aia.rejected')); qc.invalidateQueries({ queryKey: ['ai-actions'] }); },
    onError: (e) => notifyError((e as Error).message),
  });

  return (
    <div>
      <PageHeader
        title={t('st.aia.title')}
        description={t('st.aia.desc')}
      />
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.actions}
            emptyState={{
              icon: Inbox,
              title: t('st.aia.empty_title'),
              description: t('st.aia.empty_desc'),
            }}
            columns={[
              { key: 'id', label: '#' },
              { key: 'kind', label: t('st.aia.col_kind'), render: (r: AiAction) => <Badge variant="secondary"><Bot className="mr-1 size-3" />{r.kind}</Badge> },
              { key: 'amount', label: t('st.aia.col_amount'), align: 'right', render: (r: AiAction) => (r.amount != null ? baht(r.amount) : '—') },
              { key: 'rationale', label: t('st.aia.col_rationale'), render: (r: AiAction) => r.rationale ?? '—' },
              { key: 'proposed_by', label: t('st.aia.col_proposed_by') },
              {
                key: 'actions', label: '', align: 'right', render: (r: AiAction) => (
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, decision: 'approve' })}>
                      <Check className="size-4" /> {t('fin.approve')}
                    </Button>
                    <Button size="sm" variant="ghost" className="text-destructive" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, decision: 'reject' })}>
                      <X className="size-4" /> {t('fin.rejected')}
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
