'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, CheckCircle2, Circle, MinusCircle, FileCheck2, Send, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StateView } from '@/components/state-view';
import { notifySuccess, notifyError } from '@/lib/notify';

interface DiscItem {
  id: number; seq: number; item: string; standard_ref: string | null; owner: string | null;
  status: 'Open' | 'Complete' | 'NA'; support_doc_ref: string | null; completed_by: string | null; completed_at: string | null;
}
interface Checklist {
  id: number; checklist_no: string; period: string; title: string | null;
  status: 'Draft' | 'Reviewed' | 'Issued';
  prepared_by: string | null; reviewed_by: string | null; reviewed_at: string | null; issued_by: string | null; issued_at: string | null;
  created_at: string | null; items: DiscItem[];
}

const STATUS_VARIANT: Record<string, 'default' | 'warning' | 'success'> = { Draft: 'warning', Reviewed: 'default', Issued: 'success' };
const STATUS_KEY: Record<string, string> = { Draft: 'disc.status_draft', Reviewed: 'disc.status_reviewed', Issued: 'disc.status_issued' };

function todayPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function DisclosureClient({ initialData }: { initialData: { checklists: Checklist[]; count: number } }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const [period, setPeriod] = useState(todayPeriod);
  const [selectedId, setSelectedId] = useState<number | null>(initialData?.checklists?.[0]?.id ?? null);
  const [docRef, setDocRef] = useState<Record<number, string>>({});

  const statusLabel = (sVal: string) => (STATUS_KEY[sVal] ? t(STATUS_KEY[sVal]) : sVal);

  const list = useQuery<{ checklists: Checklist[]; count: number }>({
    queryKey: ['disclosure-list'],
    queryFn: () => api('/api/close/disclosure'),
    initialData,
  });

  const detail = useQuery<Checklist>({
    queryKey: ['disclosure', selectedId],
    queryFn: () => api(`/api/close/disclosure/${selectedId}`),
    enabled: !!selectedId,
  });
  const chk = detail.data ?? (selectedId ? list.data?.checklists?.find((c) => c.id === selectedId) : undefined);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['disclosure-list'] });
    qc.invalidateQueries({ queryKey: ['disclosure'] });
  };

  const open = useMutation<Checklist, Error, void>({
    mutationFn: () => api('/api/close/disclosure', { method: 'POST', body: JSON.stringify({ period }) }) as Promise<Checklist>,
    onSuccess: (c) => { notifySuccess(t('disc.toast_opened', { period: c.period })); setSelectedId(c.id); refresh(); },
    onError: (e: any) => notifyError(e?.message ?? t('disc.err_open')),
  });

  const updateItem = useMutation<Checklist, Error, { itemId: number; status?: string; support_doc_ref?: string }>({
    mutationFn: (v) => api(`/api/close/disclosure/${chk!.id}/items/${v.itemId}`, { method: 'PUT', body: JSON.stringify({ status: v.status, support_doc_ref: v.support_doc_ref }) }) as Promise<Checklist>,
    onSuccess: () => { refresh(); },
    onError: (e: any) => notifyError(e?.message ?? t('disc.err_item')),
  });

  const review = useMutation<Checklist, Error, void>({
    mutationFn: () => api(`/api/close/disclosure/${chk!.id}/review`, { method: 'POST' }) as Promise<Checklist>,
    onSuccess: () => { notifySuccess(t('disc.toast_reviewed')); refresh(); },
    onError: (e: any) => notifyError(e?.message ?? t('disc.err_review')),
  });

  const issue = useMutation<Checklist, Error, void>({
    mutationFn: () => api(`/api/close/disclosure/${chk!.id}/issue`, { method: 'POST' }) as Promise<Checklist>,
    onSuccess: () => { notifySuccess(t('disc.toast_issued')); refresh(); },
    onError: (e: any) => notifyError(e?.message ?? t('disc.err_issue')),
  });

  const items = chk?.items ?? [];
  const openCount = items.filter((i) => i.status === 'Open').length;
  const editable = chk?.status === 'Draft';

  return (
    <div className="space-y-6">
      <PageHeader title={t('disc.title')} description={t('disc.subtitle')} />

      {/* Open a checklist */}
      <Card>
        <CardHeader><CardTitle className="text-sm">{t('disc.open_title')}</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label>{t('disc.period_label')}</Label>
              <Input className="w-36" placeholder="2026-06" value={period} onChange={(e) => setPeriod(e.target.value)} pattern="\d{4}-\d{2}" />
            </div>
            <Button disabled={open.isPending || !/^\d{4}-\d{2}$/.test(period)} onClick={() => open.mutate()}>
              <ClipboardCheck className="mr-2 h-4 w-4" />{t('disc.open_btn')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Checklist list */}
        <Card className="lg:col-span-1">
          <CardHeader><CardTitle className="text-sm">{t('disc.list_title')}</CardTitle></CardHeader>
          <CardContent className="p-0">
            <StateView q={list}>
              <div className="divide-y">
                {(list.data?.checklists ?? []).map((c) => (
                  <button key={c.id} className={`w-full px-4 py-3 text-left text-sm hover:bg-muted/50 transition-colors ${selectedId === c.id ? 'bg-muted' : ''}`} onClick={() => setSelectedId(c.id)}>
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{c.period}</span>
                      <Badge variant={STATUS_VARIANT[c.status] ?? 'default'}>{statusLabel(c.status)}</Badge>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{c.checklist_no}</div>
                  </button>
                ))}
                {(list.data?.count ?? 0) === 0 && <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('disc.list_empty')}</p>}
              </div>
            </StateView>
          </CardContent>
        </Card>

        {/* Detail + workflow */}
        <div className="lg:col-span-2 space-y-4">
          {!chk ? (
            <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">{t('disc.select_prompt')}</CardContent></Card>
          ) : (
            <>
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm">{chk.title ?? chk.checklist_no} · {chk.period}</CardTitle>
                    <Badge variant={STATUS_VARIANT[chk.status] ?? 'default'}>{statusLabel(chk.status)}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-1 text-sm">
                  <p className="text-muted-foreground">{t('disc.prepared_by')} <span className="text-foreground font-medium">{chk.prepared_by}</span></p>
                  {chk.reviewed_by && <p className="text-muted-foreground">{t('disc.reviewed_by')} <span className="text-foreground font-medium">{chk.reviewed_by}</span>{chk.reviewed_at && <> · {thaiDate(chk.reviewed_at)}</>}</p>}
                  {chk.issued_by && <p className="text-muted-foreground">{t('disc.issued_by')} <span className="text-foreground font-medium">{chk.issued_by}</span>{chk.issued_at && <> · {thaiDate(chk.issued_at)}</>}</p>}
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="text-sm">{t('disc.items_title')}</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {items.map((it) => (
                    <div key={it.id} className="rounded-lg border bg-background px-3 py-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2 min-w-0">
                          {it.status === 'Complete' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                            : it.status === 'NA' ? <MinusCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                            : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />}
                          <div className="min-w-0">
                            <p className="text-sm">{it.item}</p>
                            <p className="text-xs text-muted-foreground">{it.standard_ref}{it.owner ? ` · ${it.owner}` : ''}{it.completed_by ? ` · ${it.completed_by}` : ''}{it.support_doc_ref ? ` · 📎 ${it.support_doc_ref}` : ''}</p>
                          </div>
                        </div>
                        {editable && (
                          <div className="flex items-center gap-1 shrink-0">
                            <Button size="sm" variant={it.status === 'Complete' ? 'default' : 'outline'} disabled={updateItem.isPending} onClick={() => updateItem.mutate({ itemId: it.id, status: 'Complete', support_doc_ref: docRef[it.id] })}>{t('disc.mark_complete')}</Button>
                            <Button size="sm" variant={it.status === 'NA' ? 'default' : 'outline'} disabled={updateItem.isPending} onClick={() => updateItem.mutate({ itemId: it.id, status: 'NA' })}>{t('disc.mark_na')}</Button>
                          </div>
                        )}
                      </div>
                      {editable && (
                        <Input className="mt-2 h-8 text-xs" placeholder={t('disc.support_ref_ph')} value={docRef[it.id] ?? it.support_doc_ref ?? ''} onChange={(e) => setDocRef((m) => ({ ...m, [it.id]: e.target.value }))} />
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>

              {/* Sign-off gate */}
              {chk.status !== 'Issued' && (
                <Card>
                  <CardHeader><CardTitle className="text-sm">{t('disc.signoff_title')}</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    {chk.status === 'Draft' && openCount > 0 && (
                      <div className="flex items-center gap-2 text-sm text-orange-600 dark:text-orange-400">
                        <AlertTriangle className="h-4 w-4 shrink-0" /><span>{t('disc.open_remaining', { count: openCount })}</span>
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">{t('disc.sod_note', { by: chk.prepared_by ?? '' })}</p>
                    {chk.status === 'Draft' && (
                      <Button disabled={review.isPending || openCount > 0} onClick={() => review.mutate()}>
                        <FileCheck2 className="mr-2 h-4 w-4" />{t('disc.review_btn')}
                      </Button>
                    )}
                    {chk.status === 'Reviewed' && (
                      <Button disabled={issue.isPending} onClick={() => issue.mutate()}>
                        <Send className="mr-2 h-4 w-4" />{t('disc.issue_btn')}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
