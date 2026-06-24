'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { ShieldAlert, Play, Loader2, Check } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type Finding = { id: number; control_key: string; severity: string; entity_ref: string; detail: string; amount: number | null; status: string; detected_at: string };
const sevColor: Record<string, string> = { critical: 'text-destructive', warning: 'text-amber-600', info: 'text-muted-foreground' };

// Continuous controls monitoring (Platform Phase 19 — B5). Scan for red flags; review findings. Read-only.
export default function ControlsPage() {
  const [msg, setMsg] = useState('');
  const findings = useQuery<{ findings: Finding[] }>({ queryKey: ['control-findings'], queryFn: () => api('/api/controls/findings') });
  const scan = useMutation({
    mutationFn: () => api<{ candidates: number }>('/api/controls/scan', { method: 'POST' }),
    onSuccess: (r) => { setMsg(`สแกนแล้ว พบ ${r.candidates} รายการ`); findings.refetch(); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const review = useMutation({
    mutationFn: (id: number) => api(`/api/controls/findings/${id}/review`, { method: 'POST', body: JSON.stringify({ status: 'reviewed' }) }),
    onSuccess: () => findings.refetch(),
  });

  return (
    <div>
      <PageHeader title="เฝ้าระวังการควบคุม (Controls monitoring)" description="สแกนหาสัญญาณผิดปกติ — ใบแจ้งหนี้ซ้ำ จ่ายซ้ำ ผู้ขายเลขภาษีซ้ำ — เพื่อให้ตรวจสอบ (อ่านอย่างเดียว ไม่กระทบบัญชี แยกตามกิจการ)" />

      <Card className="mb-6">
        <CardContent className="flex items-center gap-3 py-4">
          <Button disabled={scan.isPending} onClick={() => scan.mutate()}>{scan.isPending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} รันสแกน</Button>
          {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldAlert className="size-4 text-primary" /> รายการตรวจพบ</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <StateView q={findings}>
            {(findings.data?.findings ?? []).length === 0 ? <p className="text-sm text-muted-foreground">ยังไม่มีรายการ — กดรันสแกน</p> : (
              <table className="w-full text-sm">
                <thead><tr className="border-b text-left text-muted-foreground"><th className="px-2 py-1 font-medium">ระดับ</th><th className="px-2 py-1 font-medium">การควบคุม</th><th className="px-2 py-1 font-medium">รายละเอียด</th><th className="px-2 py-1 font-medium">สถานะ</th><th /></tr></thead>
                <tbody>{(findings.data?.findings ?? []).map((f) => (
                  <tr key={f.id} className="border-b">
                    <td className={`px-2 py-1 font-medium ${sevColor[f.severity] ?? ''}`}>{f.severity}</td>
                    <td className="px-2 py-1">{f.control_key}</td>
                    <td className="px-2 py-1">{f.detail}</td>
                    <td className="px-2 py-1">{f.status}</td>
                    <td className="px-2 py-1 text-right">{f.status === 'open' && <Button variant="outline" size="sm" disabled={review.isPending} onClick={() => review.mutate(f.id)}><Check className="size-3" /> ทบทวนแล้ว</Button>}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </StateView>
        </CardContent>
      </Card>
    </div>
  );
}
