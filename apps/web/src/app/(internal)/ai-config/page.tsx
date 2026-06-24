'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Wand2, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

const TARGETS = [{ k: 'custom_object', l: 'ออบเจ็กต์กำหนดเอง' }, { k: 'alert', l: 'การแจ้งเตือน' }, { k: 'automation', l: 'กฎอัตโนมัติ' }, { k: 'document_template', l: 'เทมเพลตเอกสาร' }];
type Res = { target: string; proposal: any; source: string; note: string };

// AI configuration assistant (Platform Phase 18 — B4). Describe → proposed Studio config (review first).
export default function AiConfigPage() {
  const [target, setTarget] = useState('custom_object');
  const [desc, setDesc] = useState('');
  const [res, setRes] = useState<Res | null>(null);
  const [err, setErr] = useState('');
  const run = useMutation({
    mutationFn: () => api<Res>('/api/ai-config/suggest', { method: 'POST', body: JSON.stringify({ target, description: desc }) }),
    onSuccess: (r) => { setRes(r); setErr(''); },
    onError: (e: any) => setErr(`❌ ${e.message}`),
  });

  return (
    <div>
      <PageHeader title="ผู้ช่วยตั้งค่า (AI Config)" description="อธิบายสิ่งที่ต้องการเป็นภาษาคน ระบบเสนอร่างคอนฟิกให้ตรวจทานก่อนนำไปสร้างในหน้า Studio (ไม่บันทึกอัตโนมัติ)" />

      <Card className="mb-6">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Wand2 className="size-4 text-primary" /> อธิบายสิ่งที่ต้องการ</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-1"><Label>ประเภท</Label>
            <select className="h-9 rounded-md border bg-transparent px-3 text-sm" value={target} onChange={(e) => setTarget(e.target.value)}>{TARGETS.map((t) => <option key={t.k} value={t.k}>{t.l}</option>)}</select>
          </div>
          <div className="grid gap-1"><Label>คำอธิบาย</Label>
            <textarea className="min-h-24 rounded-md border bg-transparent p-3 text-sm" placeholder="เช่น บันทึกการบำรุงรักษาอุปกรณ์ พร้อมวันที่และผู้รับผิดชอบ" value={desc} onChange={(e) => setDesc(e.target.value)} />
          </div>
          <Button disabled={run.isPending || !desc.trim()} onClick={() => run.mutate()}>{run.isPending ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />} เสนอคอนฟิก</Button>
          {err && <p className="text-sm text-destructive">{err}</p>}
        </CardContent>
      </Card>

      {res && (
        <Card>
          <CardHeader><CardTitle className="text-base">ร่างคอนฟิก <span className="ml-2 text-xs text-muted-foreground">({res.source}) — {res.note}</span></CardTitle></CardHeader>
          <CardContent><pre className="overflow-x-auto rounded border bg-muted/30 p-3 text-xs">{JSON.stringify(res.proposal, null, 2)}</pre></CardContent>
        </Card>
      )}
    </div>
  );
}
