'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Cable, Plug, Loader2, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type Cat = { type: string; label: string; capabilities: string[] };
type Conn = { id: number; type: string; label: string; status: string };

// D2 (Phase 24) — connector framework. Register + sync (stub transport, idempotent); never auto-posts.
export default function ConnectorsPage() {
  const { t } = useLang();
  const cat = useQuery<{ connectors: Cat[] }>({ queryKey: ['connector-catalog'], queryFn: () => api('/api/connectors/catalog') });
  const list = useQuery<{ connectors: Conn[] }>({ queryKey: ['connectors'], queryFn: () => api('/api/connectors') });
  const [csv, setCsv] = useState('2026-06-01,1500.00,Acme deposit\n2026-06-02,-220.00,Supplier payment');
  const [result, setResult] = useState('');
  const register = useMutation({ mutationFn: (type: string) => api('/api/connectors', { method: 'POST', body: JSON.stringify({ type }) }), onSuccess: () => list.refetch() });
  const sync = useMutation({
    mutationFn: (c: Conn) => api<{ pulled: number; created: number; duplicates: number }>(`/api/connectors/${c.id}/sync`, { method: 'POST', body: JSON.stringify(c.type === 'bank_csv' ? { csv } : {}) }),
    onSuccess: (r) => setResult(t('st.conn.sync_result', { pulled: r.pulled, created: r.created, duplicates: r.duplicates })),
    onError: (e: any) => setResult(`❌ ${e.message}`),
  });

  return (
    <div>
      <PageHeader title={t('st.conn.title')} description={t('st.conn.desc')} />
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Plug className="size-4 text-primary" /> {t('st.conn.add')}</CardTitle></CardHeader>
          <CardContent><StateView q={cat}><ul className="space-y-2">{(cat.data?.connectors ?? []).map((c) => (
            <li key={c.type} className="flex items-center justify-between rounded border p-2"><span>{c.label} <span className="text-xs text-muted-foreground">[{c.capabilities.join(', ')}]</span></span><Button variant="outline" size="sm" disabled={register.isPending} onClick={() => register.mutate(c.type)}>{t('st.conn.add_btn')}</Button></li>
          ))}</ul></StateView></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Cable className="size-4 text-primary" /> {t('st.conn.mine')}</CardTitle></CardHeader>
          <CardContent>
            <StateView q={list}>
              {(list.data?.connectors ?? []).length === 0 ? <p className="text-sm text-muted-foreground">{t('st.conn.empty')}</p> : (
                <ul className="space-y-2">{(list.data?.connectors ?? []).map((c) => (
                  <li key={c.id} className="rounded border p-2">
                    <div className="flex items-center justify-between"><span>{c.label}</span><Button variant="outline" size="sm" disabled={sync.isPending} onClick={() => sync.mutate(c)}>{sync.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {t('st.conn.sync')}</Button></div>
                    {c.type === 'bank_csv' && <textarea className="mt-2 min-h-20 w-full rounded border bg-transparent p-2 font-mono text-xs" value={csv} onChange={(e) => setCsv(e.target.value)} />}
                  </li>
                ))}</ul>
              )}
              {result && <p className="mt-2 text-sm text-muted-foreground">{result}</p>}
            </StateView>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
