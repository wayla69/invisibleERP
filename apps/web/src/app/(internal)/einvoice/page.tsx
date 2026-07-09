'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { FileCheck, Send, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { useLang } from '@/lib/i18n';
import { DataTable } from '@/components/data-table';
import { selectCls } from '@/components/form-controls';

type Provider = { key: string; country: string; label: string };
type Sub = { id: number; doc_ref: string; provider: string; status: string; ref: string };

// C3 (Phase 22) — pluggable e-invoicing. Submit via the configured provider (stub default); no GL.
export default function EInvoicePage() {
  const { t } = useLang();
  const provs = useQuery<{ providers: Provider[] }>({ queryKey: ['einvoice-providers'], queryFn: () => api('/api/einvoice/providers') });
  const cfg = useQuery<{ provider: string }>({ queryKey: ['einvoice-config'], queryFn: () => api('/api/einvoice/config') });
  const subs = useQuery<{ submissions: Sub[] }>({ queryKey: ['einvoice-subs'], queryFn: () => api('/api/einvoice/submissions') });
  const [docRef, setDocRef] = useState('INV-2026-0001');
  const [total, setTotal] = useState('1500');
  const [msg, setMsg] = useState('');
  const setProv = useMutation({ mutationFn: (p: string) => api('/api/einvoice/config', { method: 'PUT', body: JSON.stringify({ provider: p }) }), onSuccess: () => cfg.refetch() });
  const submit = useMutation({
    mutationFn: () => api<{ status: string; ref: string }>('/api/einvoice/submit', { method: 'POST', body: JSON.stringify({ doc: { doc_ref: docRef, seller: 'My Co', buyer: 'Customer', total: Number(total) } }) }),
    onSuccess: (r) => { setMsg(`${r.status} — ${r.ref}`); subs.refetch(); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  return (
    <div>
      <PageHeader title={t('mx.ei_title')} description={t('mx.ei_desc')} />
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><FileCheck className="size-4 text-primary" /> {t('mx.ei_submit_doc')}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <StateView q={provs}>
              <div className="grid gap-1"><Label>{t('mx.ei_provider')}</Label>
                <select className={selectCls} value={cfg.data?.provider ?? 'stub'} onChange={(e) => setProv.mutate(e.target.value)}>
                  {(provs.data?.providers ?? []).map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
              </div>
              <div className="grid gap-1"><Label>{t('mx.ei_doc_no')}</Label><Input value={docRef} onChange={(e) => setDocRef(e.target.value)} /></div>
              <div className="grid gap-1"><Label>{t('mx.ei_total')}</Label><Input type="number" value={total} onChange={(e) => setTotal(e.target.value)} /></div>
              <Button disabled={submit.isPending} onClick={() => submit.mutate()}>{submit.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} {t('mx.ei_send')}</Button>
              {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
            </StateView>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">{t('mx.ei_history')}</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <StateView q={subs}>
              <DataTable
                rows={subs.data?.submissions ?? []}
                rowKey={(r) => String(r.id)}
                emptyText={t('mx.ei_none')}
                columns={[
                  { key: 'doc_ref', label: t('dash.col_no') },
                  { key: 'ref', label: 'Ref', render: (r) => <span className="font-mono text-xs">{r.ref}</span> },
                  { key: 'status', label: t('fin.col_status') },
                ]}
              />
            </StateView>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
