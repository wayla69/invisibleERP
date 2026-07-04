'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Upload, Loader2, CheckCircle2, Receipt, FileText, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Intake = {
  intake_no: string; status: string; extract_source: string | null;
  vendor_name: string | null; invoice_no: string | null; invoice_date: string | null;
  amount: number | null; currency: string | null; created_at?: string | null;
};

const STATUS_TH: Record<string, string> = { NeedsReview: 'รอตรวจสอบ', Mapped: 'จับคู่ PO แล้ว', Posted: 'บันทึกบิลแล้ว' };
const statusVariant = (s: string) => (s === 'Posted' ? 'success' : s === 'Mapped' ? 'info' : 'warning');

function readAsDataUrl(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error('อ่านไฟล์ไม่สำเร็จ'));
    r.readAsDataURL(f);
  });
}

// Quick Capture lane (docs/34, paypers-style). Any staffer holding a bill snaps/uploads it; the AP-intake
// engine extracts the fields and files it as a NeedsReview draft for Accounting to book. Draft-only — this
// screen never books a bill or touches the GL (that stays a creditors action, SoD/EXP-06).
export default function CapturePage() {
  const qc = useQueryClient();
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [last, setLast] = useState<Intake | null>(null);

  const mine = useQuery({
    queryKey: ['ap-capture-mine'],
    queryFn: () => api<{ intakes: Intake[]; count: number }>('/api/procurement/ap-intake/mine?limit=20'),
  });

  const capture = useMutation({
    mutationFn: async (f: File) => {
      const dataUrl = await readAsDataUrl(f);
      return api<Intake>('/api/procurement/ap-intake/capture', { method: 'POST', body: JSON.stringify({ file_name: f.name, data_url: dataUrl }) });
    },
    onSuccess: (r) => {
      setLast(r);
      notifySuccess(`ส่งให้ฝ่ายบัญชีแล้ว · ${r.intake_no}`);
      qc.invalidateQueries({ queryKey: ['ap-capture-mine'] });
    },
    onError: (e) => notifyError((e as Error).message),
  });

  const pick = (f: File | undefined) => { if (f) capture.mutate(f); };

  return (
    <div>
      <PageHeader
        title="เก็บบิลเร็ว (Quick Capture)"
        description="ถ่ายรูปหรืออัปโหลดใบเสร็จ/ใบแจ้งหนี้ ระบบอ่านข้อมูลให้อัตโนมัติ แล้วส่งเข้าคิวให้ฝ่ายบัญชีตรวจสอบและบันทึกบิลต่อ — จากมือถือหรือหน้าจอไหนก็ได้"
      />

      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,application/pdf" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Sparkles className="size-4 text-primary" /> ถ่าย / อัปโหลดบิล</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Button size="lg" className="h-24 flex-col gap-2" disabled={capture.isPending} onClick={() => cameraRef.current?.click()}>
                {capture.isPending ? <Loader2 className="size-6 animate-spin" /> : <Camera className="size-6" />}
                <span>ถ่ายรูปบิล</span>
              </Button>
              <Button size="lg" variant="outline" className="h-24 flex-col gap-2" disabled={capture.isPending} onClick={() => fileRef.current?.click()}>
                <Upload className="size-6" />
                <span>เลือกไฟล์ / PDF</span>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              รองรับรูปภาพ (PNG/JPEG/WebP) และ PDF · PDF ที่มีชั้นข้อความอ่านได้ทันที ส่วนรูปถ่าย/สแกนใช้ AI —
              ถ้าอ่านอัตโนมัติไม่ได้ ระบบจะแนบไฟล์เข้าคิวให้ฝ่ายบัญชีตรวจสอบเอง ไม่มีการเดา
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">ผลล่าสุด</CardTitle></CardHeader>
          <CardContent>
            {last ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="size-4" /> เก็บเข้าระบบแล้ว · {last.intake_no}
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">ผู้ขาย</dt><dd>{last.vendor_name ?? '—'}</dd>
                  <dt className="text-muted-foreground">เลขที่ใบแจ้งหนี้</dt><dd>{last.invoice_no ?? '—'}</dd>
                  <dt className="text-muted-foreground">วันที่</dt><dd>{last.invoice_date ?? '—'}</dd>
                  <dt className="text-muted-foreground">จำนวนเงิน</dt><dd>{last.amount != null ? `${num(last.amount)} ${last.currency ?? 'THB'}` : '—'}</dd>
                  <dt className="text-muted-foreground">สถานะ</dt><dd><Badge variant={statusVariant(last.status)}>{STATUS_TH[last.status] ?? last.status}</Badge></dd>
                </dl>
                <p className="text-xs text-muted-foreground">
                  {last.extract_source === 'none'
                    ? 'ยังอ่านข้อมูลอัตโนมัติไม่ได้ — ฝ่ายบัญชีจะตรวจสอบจากไฟล์ที่แนบ'
                    : 'AI อ่านข้อมูลให้แล้ว — ฝ่ายบัญชีจะตรวจสอบและบันทึกบิลต่อ'}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">ถ่ายหรืออัปโหลดบิลแล้วผลจะแสดงที่นี่</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Receipt className="size-4 text-primary" /> บิลที่คุณเพิ่งเก็บ</CardTitle></CardHeader>
        <CardContent>
          {mine.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> กำลังโหลด…</div>
          ) : (mine.data?.intakes.length ?? 0) === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center text-muted-foreground">
              <FileText className="size-8 opacity-40" />
              <p className="text-sm">ยังไม่มีบิลที่เก็บไว้ — ถ่ายรูปบิลใบแรกได้เลย</p>
            </div>
          ) : (
            <ul className="divide-y">
              {mine.data!.intakes.map((it) => (
                <li key={it.intake_no} className="flex items-center justify-between gap-3 py-3 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{it.vendor_name ?? 'ไม่ทราบผู้ขาย'}</div>
                    <div className="text-xs text-muted-foreground">{it.intake_no} · {it.invoice_no ?? 'ไม่มีเลขที่'} · {it.invoice_date ?? '—'}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="tabular-nums">{it.amount != null ? num(it.amount) : '—'}</span>
                    <Badge variant={statusVariant(it.status)}>{STATUS_TH[it.status] ?? it.status}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
