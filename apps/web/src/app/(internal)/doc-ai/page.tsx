'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { FileScan, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useLang } from '@/lib/i18n';

type Fields = { vendor_name: string | null; vendor_tax_id: string | null; invoice_no: string | null; invoice_date: string | null; amount: number | null; currency: string };
type Extracted = { fields: Fields; source: string };

// Document-AI intake (Platform Phase 16 — B2). Extract a draft from pasted invoice text for human review.
export default function DocAiPage() {
  const { t } = useLang();
  const [text, setText] = useState('');
  const [res, setRes] = useState<Extracted | null>(null);
  const [err, setErr] = useState('');
  const run = useMutation({
    mutationFn: () => api<Extracted>('/api/doc-ai/extract', { method: 'POST', body: JSON.stringify({ text }) }),
    onSuccess: (r) => { setRes(r); setErr(''); },
    onError: (e: any) => setErr(`❌ ${e.message}`),
  });
  const rows: [string, any][] = res ? [[t('mx.dai_vendor'), res.fields.vendor_name], [t('mx.dai_tax_id'), res.fields.vendor_tax_id], [t('mx.dai_invoice_no'), res.fields.invoice_no], [t('dash.col_date'), res.fields.invoice_date], [t('mx.dai_amount'), res.fields.amount], [t('mx.dai_currency'), res.fields.currency]] : [];

  return (
    <div>
      <PageHeader title={t('mx.dai_title')} description={t('mx.dai_desc')} />
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><FileScan className="size-4 text-primary" /> {t('mx.dai_doc_text')}</CardTitle></CardHeader>
          <CardContent>
            <textarea className="min-h-48 w-full rounded-md border bg-transparent p-3 text-sm" placeholder={t('mx.dai_paste_ph')} value={text} onChange={(e) => setText(e.target.value)} />
            <Button className="mt-2" disabled={run.isPending || !text.trim()} onClick={() => run.mutate()}>{run.isPending ? <Loader2 className="size-4 animate-spin" /> : <FileScan className="size-4" />} {t('mx.dai_extract')}</Button>
            {err && <p className="mt-2 text-sm text-destructive">{err}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">{t('mx.dai_draft')} {res && <span className="ml-2 text-xs text-muted-foreground">({res.source})</span>}</CardTitle></CardHeader>
          <CardContent>
            {!res ? <p className="text-sm text-muted-foreground">{t('mx.dai_no_data')}</p> : (
              <table className="w-full text-sm">
                <tbody>{rows.map(([k, v]) => <tr key={k} className="border-b"><td className="px-2 py-1 text-muted-foreground">{k}</td><td className="px-2 py-1 text-right">{v == null || v === '' ? '—' : String(v)}</td></tr>)}</tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
