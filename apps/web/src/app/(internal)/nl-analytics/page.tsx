'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { MessageSquare, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const money = (x: number) => (Number(x) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
type Res = { question: string; resolved: { dimension: string; date_from?: string; date_to?: string } | null; source: string; result: { dimension: string; rows: any[] } | null };

// NL analytics (Platform Phase 17 — B3). Plain-language question → governed query over the semantic layer.
export default function NlAnalyticsPage() {
  const { t } = useLang();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<Res | null>(null);
  const [err, setErr] = useState('');
  const ask = useMutation({
    mutationFn: () => api<Res>('/api/nl-analytics/ask', { method: 'POST', body: JSON.stringify({ question: q }) }),
    onSuccess: (r) => { setRes(r); setErr(''); },
    onError: (e: any) => setErr(`❌ ${e.message}`),
  });
  const rows = res?.result?.rows ?? [];
  const maxSales = Math.max(1, ...rows.map((r) => Number(r.sales_total) || 0));

  return (
    <div>
      <PageHeader title="ถามข้อมูลด้วยภาษาธรรมชาติ (NL Analytics)" description="พิมพ์คำถามเป็นภาษาคน ระบบแปลงเป็นรายงานบนชั้นข้อมูลที่ควบคุมแล้ว (ไม่สร้าง SQL อิสระ) แล้วแสดงผล แยกตามกิจการ" />

      <Card className="mb-6">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><MessageSquare className="size-4 text-primary" /> ถามข้อมูล</CardTitle></CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <input className="h-9 flex-1 rounded-md border bg-transparent px-3 text-sm" placeholder="เช่น ยอดขายแยกตามวิธีชำระเงิน" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && q.trim() && ask.mutate()} />
            <Button disabled={ask.isPending || !q.trim()} onClick={() => ask.mutate()}>{ask.isPending ? <Loader2 className="size-4 animate-spin" /> : 'ถาม'}</Button>
          </div>
          {err && <p className="mt-2 text-sm text-destructive">{err}</p>}
          {res?.resolved && <p className="mt-2 text-xs text-muted-foreground">ตีความเป็น: จัดกลุ่มตาม <span className="font-medium">{res.resolved.dimension}</span>{res.resolved.date_from ? ` · ตั้งแต่ ${res.resolved.date_from}` : ''}{res.resolved.date_to ? ` · ถึง ${res.resolved.date_to}` : ''} ({res.source})</p>}
        </CardContent>
      </Card>

      {res?.result && (
        <Card>
          <CardHeader><CardTitle className="text-base">ผลลัพธ์</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            {rows.length === 0 ? <p className="text-sm text-muted-foreground">ไม่มีข้อมูล</p> : (
              <table className="w-full text-sm">
                <thead><tr className="border-b text-left text-muted-foreground"><th className="px-2 py-1 font-medium">{res.result.dimension}</th><th className="px-2 py-1 text-right font-medium">ยอดขาย</th><th className="px-2 py-1 text-right font-medium">ออร์เดอร์</th></tr></thead>
                <tbody>{rows.map((r, i) => (
                  <tr key={i} className="border-b">
                    <td className="px-2 py-1"><div>{String(r.dim)}</div><div className="mt-0.5 h-1.5 rounded bg-primary/20"><div className="h-1.5 rounded bg-primary" style={{ width: `${Math.round((Number(r.sales_total) / maxSales) * 100)}%` }} /></div></td>
                    <td className="px-2 py-1 text-right tabular-nums">{money(r.sales_total)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{Number(r.orders).toLocaleString()}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
