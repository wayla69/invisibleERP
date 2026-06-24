'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Code, ExternalLink } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Key = { id: number; name: string; prefix: string; scopes: string[]; tier: string; revoked: boolean; last_used_at: string | null };
type Portal = { scopes: { key: string; desc: string }[]; endpoints: { method: string; path: string; scope: string }[]; tiers: { key: string; label: string; rate_per_min: number }[]; openapi_url: string; keys: Key[] };

// D1 (Phase 23) — developer portal over the shipped public API v1: keys + rate tiers, scopes, endpoints, OpenAPI.
export default function DeveloperPage() {
  const q = useQuery<Portal>({ queryKey: ['developer-portal'], queryFn: () => api('/api/developer/portal') });
  const [msg, setMsg] = useState('');
  const setTier = useMutation({
    mutationFn: ({ id, tier }: { id: number; tier: string }) => api(`/api/developer/keys/${id}/tier`, { method: 'PUT', body: JSON.stringify({ tier }) }),
    onSuccess: () => { setMsg('อัปเดตระดับแล้ว ✓'); q.refetch(); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

  return (
    <div>
      <PageHeader title="พอร์ทัลนักพัฒนา (Developer)" description="จัดการ API key + ระดับการใช้งาน (tier) ดู scope / endpoint และเอกสาร OpenAPI ของ Public API v1" />
      <StateView q={q}>
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Code className="size-4 text-primary" /> API keys</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto">
              {(q.data?.keys ?? []).length === 0 ? <p className="text-sm text-muted-foreground">ยังไม่มี API key — สร้างได้ที่หน้าตั้งค่าแพลตฟอร์ม</p> : (
                <table className="w-full text-sm">
                  <thead><tr className="border-b text-left text-muted-foreground"><th className="px-2 py-1 font-medium">Prefix</th><th className="px-2 py-1 font-medium">Scopes</th><th className="px-2 py-1 font-medium">Tier</th></tr></thead>
                  <tbody>{(q.data?.keys ?? []).map((k) => (
                    <tr key={k.id} className="border-b">
                      <td className="px-2 py-1 font-mono text-xs">{k.prefix}…{k.revoked && <span className="ml-1 text-destructive">(revoked)</span>}</td>
                      <td className="px-2 py-1 text-xs">{k.scopes.join(', ') || '—'}</td>
                      <td className="px-2 py-1">
                        <select className="h-8 rounded border bg-transparent px-1 text-xs" value={k.tier} disabled={k.revoked} onChange={(e) => setTier.mutate({ id: k.id, tier: e.target.value })}>
                          {(q.data?.tiers ?? []).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              {msg && <p className="mt-2 text-sm text-muted-foreground">{msg}</p>}
              <a className="mt-3 inline-flex items-center gap-1 text-sm text-primary" href={`${base}${q.data?.openapi_url ?? ''}`} target="_blank" rel="noreferrer">OpenAPI 3.1 <ExternalLink className="size-3" /></a>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">Scopes &amp; endpoints</CardTitle></CardHeader>
            <CardContent>
              <p className="mb-1 text-xs font-medium text-muted-foreground">ระดับการใช้งาน (req/นาที)</p>
              <ul className="mb-3 text-sm">{(q.data?.tiers ?? []).map((t) => <li key={t.key}>{t.label}: {t.rate_per_min}/min</li>)}</ul>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Endpoints</p>
              <ul className="text-sm">{(q.data?.endpoints ?? []).map((e) => <li key={e.path} className="font-mono text-xs">{e.method} {e.path} <span className="text-muted-foreground">[{e.scope}]</span></li>)}</ul>
            </CardContent>
          </Card>
        </div>
      </StateView>
    </div>
  );
}
