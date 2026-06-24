'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Cable, Plug, Loader2, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type Cat = { type: string; label: string; capabilities: string[] };
type Conn = { id: number; type: string; label: string; status: string };

// D2 (Phase 24) — connector framework. Register + sync (stub transport, idempotent); never auto-posts.
export default function ConnectorsPage() {
  const cat = useQuery<{ connectors: Cat[] }>({ queryKey: ['connector-catalog'], queryFn: () => api('/api/connectors/catalog') });
  const list = useQuery<{ connectors: Conn[] }>({ queryKey: ['connectors'], queryFn: () => api('/api/connectors') });
  const [csv, setCsv] = useState('2026-06-01,1500.00,Acme deposit\n2026-06-02,-220.00,Supplier payment');
  const [result, setResult] = useState('');
  const register = useMutation({ mutationFn: (type: string) => api('/api/connectors', { method: 'POST', body: JSON.stringify({ type }) }), onSuccess: () => list.refetch() });
  const sync = useMutation({
    mutationFn: (c: Conn) => api<{ pulled: number; created: number; duplicates: number }>(`/api/connectors/${c.id}/sync`, { method: 'POST', body: JSON.stringify(c.type === 'bank_csv' ? { csv } : {}) }),
    onSuccess: (r) => setResult(`ดึง ${r.pulled} รายการ — ใหม่ ${r.created}, ซ้ำ ${r.duplicates}`),
    onError: (e: any) => setResult(`❌ ${e.message}`),
  });

  return (
    <div>
      <PageHeader title="ตัวเชื่อมต่อ (Connectors)" description="เชื่อมต่อ LINE / Shopee / นำเข้าสเตทเมนต์ธนาคาร — ดึงข้อมูลแบบ idempotent เพื่อตรวจทาน (ไม่ลงบัญชีอัตโนมัติ แยกตามกิจการ)" />
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Plug className="size-4 text-primary" /> เพิ่มตัวเชื่อมต่อ</CardTitle></CardHeader>
          <CardContent><StateView q={cat}><ul className="space-y-2">{(cat.data?.connectors ?? []).map((c) => (
            <li key={c.type} className="flex items-center justify-between rounded border p-2"><span>{c.label} <span className="text-xs text-muted-foreground">[{c.capabilities.join(', ')}]</span></span><Button variant="outline" size="sm" disabled={register.isPending} onClick={() => register.mutate(c.type)}>เพิ่ม</Button></li>
          ))}</ul></StateView></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Cable className="size-4 text-primary" /> ตัวเชื่อมต่อของฉัน</CardTitle></CardHeader>
          <CardContent>
            <StateView q={list}>
              {(list.data?.connectors ?? []).length === 0 ? <p className="text-sm text-muted-foreground">ยังไม่มี — เพิ่มจากด้านซ้าย</p> : (
                <ul className="space-y-2">{(list.data?.connectors ?? []).map((c) => (
                  <li key={c.id} className="rounded border p-2">
                    <div className="flex items-center justify-between"><span>{c.label}</span><Button variant="outline" size="sm" disabled={sync.isPending} onClick={() => sync.mutate(c)}>{sync.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} ซิงค์</Button></div>
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
