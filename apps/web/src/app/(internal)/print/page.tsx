'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Printer, RefreshCw, Send, FileText } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

interface Job {
  id: number; job_type: string; station: string | null; sale_no: string | null; order_no: string | null;
  format: string; status: string; attempts: number; error: string | null; created_at: string | null; printed_at: string | null;
}

const statusVariant: Record<string, 'success' | 'warning' | 'destructive' | 'muted' | 'info'> = {
  printed: 'success', queued: 'info', sent: 'warning', failed: 'destructive',
};

// Open the server-rendered receipt HTML in a new window (auth header → can't be a plain link).
async function openReceipt(saleNo: string, lang?: string) {
  const qs = lang ? `?lang=${encodeURIComponent(lang)}` : '';
  const res = await fetch(`${BASE}/api/print/receipt/${encodeURIComponent(saleNo)}${qs}`, { credentials: 'include' });
  const html = await res.text();
  const w = window.open('', '_blank', 'width=420,height=640');
  if (w) { w.document.open(); w.document.write(html); w.document.close(); }
}

type SendChannel = 'email' | 'line' | 'sms';
const CHANNEL_META: Record<SendChannel, { label: string; toLabel: string; placeholder: string }> = {
  email: { label: 'อีเมล (Email)', toLabel: 'อีเมลผู้รับ', placeholder: 'guest@example.com' },
  line: { label: 'LINE', toLabel: 'LINE User ID', placeholder: 'Uxxxxxxxxxxxxxxxx' },
  sms: { label: 'SMS', toLabel: 'เบอร์โทร', placeholder: '08x-xxx-xxxx' },
};

export default function PrintPage() {
  const qc = useQueryClient();
  const [saleNo, setSaleNo] = useState('');
  const [channel, setChannel] = useState<SendChannel>('email');
  const [to, setTo] = useState('');
  const [lang, setLang] = useState('');   // '' = tenant default; th | en | both
  const [msg, setMsg] = useState('');
  const q = useQuery<{ jobs: Job[] }>({ queryKey: ['print-jobs'], queryFn: () => api('/api/print/jobs?limit=100'), refetchInterval: 10_000 });

  const reprint = useMutation({
    mutationFn: (s: string) => api(`/api/print/reprint/${encodeURIComponent(s)}${lang ? `?lang=${lang}` : ''}`, { method: 'POST' }),
    onSuccess: () => { setMsg(`✅ ส่งพิมพ์ใบเสร็จซ้ำแล้ว (${saleNo}) — สำเนา`); qc.invalidateQueries({ queryKey: ['print-jobs'] }); },
    onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });
  const send = useMutation({
    mutationFn: (b: { sale_no: string; channel: SendChannel; to: string }) => api(`/api/print/receipt/${encodeURIComponent(b.sale_no)}/send`, { method: 'POST', body: JSON.stringify({ channel: b.channel, to: b.to }) }),
    onSuccess: () => setMsg(`✅ ส่งใบเสร็จทาง ${CHANNEL_META[channel].label} ไปยัง ${to} แล้ว`),
    onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });

  return (
    <div>
      <PageHeader title="ใบเสร็จ & งานพิมพ์ (Receipts & printing)" description="คิวงานพิมพ์ที่เครื่องพิมพ์/เอเจนต์ดึงไปพิมพ์ — เปิดดูใบเสร็จ พิมพ์ซ้ำ (สำเนา) หรือส่งใบเสร็จทาง LINE / SMS / อีเมล" />

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-sm">พิมพ์ซ้ำ / ส่งใบเสร็จ</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label>เลขที่การขาย (SALE-…)</Label>
              <Input value={saleNo} onChange={(e) => setSaleNo(e.target.value.trim())} placeholder="SALE-T1-…" />
            </div>
            <div>
              <Label>ภาษาใบเสร็จ (Receipt language)</Label>
              <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={lang} onChange={(e) => setLang(e.target.value)}>
                <option value="">ค่าเริ่มต้นของร้าน (tenant default)</option>
                <option value="th">ไทย</option>
                <option value="en">English</option>
                <option value="both">ไทย / English</option>
              </select>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={!saleNo} onClick={() => openReceipt(saleNo, lang || undefined)}><FileText className="mr-1 h-4 w-4" />เปิดดู / พิมพ์</Button>
              <Button disabled={!saleNo || reprint.isPending} onClick={() => reprint.mutate(saleNo)}><Printer className="mr-1 h-4 w-4" />พิมพ์ซ้ำ (สำเนา)</Button>
            </div>
            <div className="flex items-end gap-2">
              <div>
                <Label>ช่องทาง</Label>
                <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={channel} onChange={(e) => { setChannel(e.target.value as SendChannel); setTo(''); }}>
                  {(Object.keys(CHANNEL_META) as SendChannel[]).map((c) => <option key={c} value={c}>{CHANNEL_META[c].label}</option>)}
                </select>
              </div>
              <div className="flex-1">
                <Label>{CHANNEL_META[channel].toLabel}</Label>
                <Input value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder={CHANNEL_META[channel].placeholder} />
              </div>
              <Button variant="outline" disabled={!saleNo || !to || send.isPending} onClick={() => send.mutate({ sale_no: saleNo, channel, to })}><Send className="mr-1 h-4 w-4" />ส่ง</Button>
            </div>
            <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">เครื่องพิมพ์ดึงงานอัตโนมัติ</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>ใบเสร็จจะถูกจัดคิวอัตโนมัติเมื่อปิดบิล เครื่องพิมพ์ CloudPRNT หรือเอเจนต์ในร้านจะ <b>ดึงงานถัดไป</b> (queued → sent) แล้วยืนยันเมื่อพิมพ์เสร็จ (→ printed) งานที่ล้มเหลวจะถูกพยายามใหม่จนถึง 5 ครั้ง</p>
            <p>รูปแบบ ESC/POS จะถูกเข้ารหัส base64 ในคิว และเอเจนต์ถอดรหัสก่อนส่งเข้าหัวพิมพ์</p>
          </CardContent>
        </Card>
      </div>

      <StateView q={q}>
        <DataTable
          rows={q.data?.jobs ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: 'id', label: '#', render: (r) => <span className="tabular">{r.id}</span> },
            { key: 'job_type', label: 'ประเภท', render: (r) => r.job_type === 'receipt' ? 'ใบเสร็จ' : `ครัว${r.station ? ` · ${r.station}` : ''}` },
            { key: 'sale_no', label: 'อ้างอิง', render: (r) => r.sale_no ?? r.order_no ?? '—' },
            { key: 'format', label: 'รูปแบบ', render: (r) => <Badge variant="muted" className="uppercase text-[10px]">{r.format}</Badge> },
            { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={statusVariant[r.status] ?? 'muted'}>{r.status}{r.attempts > 1 ? ` (${r.attempts})` : ''}</Badge> },
            { key: 'created_at', label: 'สร้างเมื่อ', render: (r) => r.created_at ? new Date(r.created_at).toLocaleString('th-TH') : '—' },
            { key: 'act', label: '', align: 'right', render: (r) => r.sale_no ? <Button size="sm" variant="ghost" onClick={() => openReceipt(r.sale_no!)}><RefreshCw className="h-4 w-4" /></Button> : null },
          ]}
          emptyText="ยังไม่มีงานพิมพ์"
        />
      </StateView>
    </div>
  );
}
