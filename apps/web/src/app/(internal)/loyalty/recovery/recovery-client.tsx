'use client';

// V2 (docs/29, LYL-20) — detractor recovery worklist: every low NPS answer is an owned, SLA-timed case.
// Client island (docs/28 §4): the server shell prefetches the default worklist; filter + mutations live here.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';

type RecoveryCase = {
  id: number; member_id: number; member_code: string | null; member_name: string | null;
  score: number | null; comment: string | null; status: string; overdue: boolean;
  response_due_at: string | null; contacted_by: string | null; resolved_by: string | null; resolution_note: string | null; created_at: string;
};
type Worklist = { cases: RecoveryCase[]; open: number; overdue: number };

export default function RecoveryWorklist({ initial }: { initial?: unknown }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [notes, setNotes] = useState<Record<number, string>>({});
  const q = useQuery<Worklist>({
    queryKey: ['recovery', status], queryFn: () => api(`/api/recovery/cases${status ? `?status=${status}` : ''}`),
    initialData: status === '' ? ((initial as Worklist | undefined) ?? undefined) : undefined,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['recovery'] });
  const contact = useMutation({ mutationFn: (id: number) => api(`/api/recovery/cases/${id}/contact`, { method: 'POST' }), onSuccess: refresh });
  const resolve = useMutation({ mutationFn: ({ id, note }: { id: number; note: string }) => api(`/api/recovery/cases/${id}/resolve`, { method: 'POST', body: JSON.stringify({ note }) }), onSuccess: refresh });

  return (
    <div>
      <PageHeader title={t('ly.rec_title')} description={t('ly.rec_desc')} />
      <div className="mb-3 flex items-center gap-2">
        {['', 'Open', 'Contacted', 'Resolved'].map((s) => (
          <Button key={s} size="sm" variant={status === s ? 'default' : 'outline'} onClick={() => setStatus(s)}>{s || t('ly.all')}</Button>
        ))}
        {q.data && <span className="ml-auto text-sm text-muted-foreground">{t('ly.rec_open', { n: q.data.open })} · {t('ly.rec_over_sla')} <span className={q.data.overdue > 0 ? 'font-semibold text-destructive' : ''}>{q.data.overdue}</span></span>}
      </div>
      <StateView q={q}>
        <div className="space-y-2">
          {(q.data?.cases ?? []).length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">{t('ly.rec_empty')}</p>}
          {(q.data?.cases ?? []).map((c) => (
            <Card key={c.id} className={`p-4 ${c.overdue ? 'border-destructive' : ''}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={c.status === 'Resolved' ? 'success' : c.overdue ? 'destructive' : c.status === 'Contacted' ? 'info' : 'warning'}>
                  {c.overdue ? t('ly.rec_over_sla') : c.status}
                </Badge>
                <span className="font-semibold">{t('ly.rec_score', { score: c.score ?? '' })}</span>
                <Link href={`/loyalty/members/${c.member_id}`} className="text-primary underline">{c.member_code ?? `#${c.member_id}`}</Link>
                <span className="text-sm text-muted-foreground">{c.member_name}</span>
                <span className="ml-auto text-xs text-muted-foreground">{t('ly.rec_due')} {c.response_due_at ? new Date(c.response_due_at).toLocaleString('th-TH') : '—'}</span>
              </div>
              {c.comment && <p className="mt-2 rounded bg-muted px-3 py-2 text-sm">“{c.comment}”</p>}
              {c.status === 'Open' && (
                <div className="mt-3"><Button size="sm" disabled={contact.isPending} onClick={() => contact.mutate(c.id)}>📞 {t('ly.rec_mark_contacted')}</Button></div>
              )}
              {(c.status === 'Open' || c.status === 'Contacted') && (
                <div className="mt-2 flex gap-2">
                  <Input placeholder={t('ly.rec_note_ph')} value={notes[c.id] ?? ''} onChange={(e) => setNotes({ ...notes, [c.id]: e.target.value })} />
                  <Button size="sm" variant="outline" disabled={resolve.isPending || !(notes[c.id] ?? '').trim()} onClick={() => resolve.mutate({ id: c.id, note: notes[c.id] ?? '' })}>{t('ly.rec_close_case')}</Button>
                </div>
              )}
              {c.status === 'Resolved' && <p className="mt-2 text-xs text-muted-foreground">{t('ly.rec_closed_by', { by: c.resolved_by ?? '' })} — {c.resolution_note}</p>}
              {c.contacted_by && c.status !== 'Resolved' && <p className="mt-1 text-xs text-muted-foreground">{t('ly.rec_contacted_by', { by: c.contacted_by ?? '' })}</p>}
            </Card>
          ))}
        </div>
      </StateView>
    </div>
  );
}
