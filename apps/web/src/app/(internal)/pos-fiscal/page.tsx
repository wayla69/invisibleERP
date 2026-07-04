'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, Send, BookText, FileCheck2 } from 'lucide-react';
import { api } from '@/lib/api';
import { thaiDate } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { statusVariant } from '@/components/ui';

export default function PosFiscalPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('px.fiscal_title')} description={t('px.fiscal_desc')} />
      <Tabs tabs={[{ key: 'journal', label: t('px.fiscal_tab_journal'), content: <Journal /> }, { key: 'etax', label: t('px.fiscal_tab_etax'), content: <Etax /> }]} />
    </div>
  );
}

function Journal() {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['pos-journal'], queryFn: () => api('/api/pos/journal?limit=100') });
  const [verify, setVerify] = useState<any>(null);
  const run = useMutation({ mutationFn: () => api('/api/pos/journal/verify'), onSuccess: (r: any) => setVerify(r) });
  return (
    <div className="space-y-4">
      <Card className="flex-row items-center gap-3 p-5">
        <Button disabled={run.isPending} onClick={() => run.mutate()}><ShieldCheck className="size-4" /> {t('px.fiscal_verify_btn')}</Button>
        {verify && (verify.ok
          ? <Badge variant={statusVariant('paid')}>{t('px.fiscal_valid', { n: verify.length })}</Badge>
          : <Badge variant={statusVariant('cancelled')}>{t('px.fiscal_broken', { seq: verify.broken_at, reason: verify.reason })}</Badge>)}
      </Card>
      <StateView q={q}>
        {q.data && (
          <DataTable rows={q.data.entries} columns={[
            { key: 'seq', label: t('px.fiscal_col_seq'), align: 'right' },
            { key: 'doc_type', label: t('px.fiscal_col_type') },
            { key: 'doc_no', label: t('dash.col_no') },
            { key: 'created_at', label: t('px.fiscal_col_time'), render: (r: any) => thaiDate(r.created_at) },
            { key: 'hash', label: 'Hash', render: (r: any) => <span className="font-mono text-xs">{String(r.hash).slice(0, 16)}…</span> },
          ]} emptyState={{ icon: BookText, title: t('px.fiscal_journal_empty_title'), description: t('px.fiscal_journal_empty_desc') }} />
        )}
      </StateView>
    </div>
  );
}

function Etax() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['etax'], queryFn: () => api('/api/tax/etax?limit=100') });
  const [docNo, setDocNo] = useState('');
  const submit = useMutation({
    mutationFn: () => api(`/api/tax/etax/submit/${docNo}`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (r: any) => { notifySuccess(`${r.doc_no} → ${r.status}${r.idempotent ? ` (${t('px.fiscal_resubmit')})` : ''}`); qc.invalidateQueries({ queryKey: ['etax'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('px.fiscal_etax_heading')}</h3>
        <div className="flex gap-2">
          <Input className="max-w-[240px]" placeholder={t('px.fiscal_docno_ph')} value={docNo} onChange={(e) => setDocNo(e.target.value)} />
          <Button disabled={!docNo || submit.isPending} onClick={() => submit.mutate()}><Send className="size-4" /> {t('px.fiscal_submit')}</Button>
        </div>
      </Card>
      <StateView q={q}>
        {q.data && (
          <DataTable rows={q.data.submissions} columns={[
            { key: 'doc_no', label: t('dash.col_no') },
            { key: 'provider', label: t('px.fiscal_col_provider') },
            { key: 'provider_ref', label: t('px.fiscal_col_ref') },
            { key: 'submitted_at', label: t('px.fiscal_col_submitted'), render: (r: any) => thaiDate(r.submitted_at) },
            { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status === 'Accepted' ? 'paid' : r.status === 'Rejected' ? 'cancelled' : 'open')}>{r.status}</Badge> },
          ]} emptyState={{ icon: FileCheck2, title: t('px.fiscal_etax_empty_title'), description: t('px.fiscal_etax_empty_desc') }} />
        )}
      </StateView>
    </div>
  );
}
