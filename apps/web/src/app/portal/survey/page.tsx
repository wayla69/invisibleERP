'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Msg } from '@/components/tabs';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function PortalSurveyPage() {
  const list = useQuery<any>({ queryKey: ['portal-surveys'], queryFn: () => api('/api/portal/surveys') });
  const [sel, setSel] = useState('');
  const [nps, setNps] = useState(10);
  const [comments, setComments] = useState('');
  const [q, setQ] = useState({ q1: '', q2: '', q3: '' });
  const [msg, setMsg] = useState('');

  const submit = useMutation({
    mutationFn: () => api(`/api/portal/surveys/${encodeURIComponent(sel)}/responses`, { method: 'POST', body: JSON.stringify({ nps_score: nps, comments: comments || undefined, q1: q.q1 || undefined, q2: q.q2 || undefined, q3: q.q3 || undefined }) }),
    onSuccess: () => { setMsg('✅ ขอบคุณสำหรับความคิดเห็น!'); setComments(''); setQ({ q1: '', q2: '', q3: '' }); setSel(''); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  const surveys = (list.data?.surveys ?? []).filter((s: any) => s.active !== false);
  const sid = (s: any) => s.surveyId ?? s.survey_id;
  const sname = (s: any) => s.surveyName ?? s.survey_name;

  return (
    <div className="space-y-4">
      <PageHeader title="แบบสำรวจความพึงพอใจ (Survey)" description="ให้คะแนนและความคิดเห็นเพื่อช่วยเราพัฒนาบริการ" />
      <StateView q={list}>
        {!sel ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {surveys.length === 0 && <Card className="p-5 text-sm text-muted-foreground">ยังไม่มีแบบสำรวจที่เปิดอยู่</Card>}
            {surveys.map((s: any) => (
              <Card key={sid(s)} className="gap-2 p-5">
                <h3 className="text-base font-semibold">{sname(s)}</h3>
                <p className="text-sm text-muted-foreground">{s.surveyType ?? s.survey_type ?? 'NPS'}</p>
                <Button className="w-fit" onClick={() => { setSel(sid(s)); setMsg(''); }}>ทำแบบสำรวจ</Button>
              </Card>
            ))}
          </div>
        ) : (
          <Card className="max-w-xl gap-4 p-5">
            <div className="grid gap-1.5">
              <Label>คุณจะแนะนำเราให้เพื่อนไหม? (0–10)</Label>
              <div className="flex flex-wrap gap-1">
                {Array.from({ length: 11 }, (_, i) => (
                  <Button key={i} size="sm" variant={nps === i ? 'default' : 'outline'} onClick={() => setNps(i)}>{i}</Button>
                ))}
              </div>
            </div>
            <div className="grid gap-1.5"><Label>ความคิดเห็น</Label><Input value={comments} onChange={(e) => setComments(e.target.value)} placeholder="บอกเราเพิ่มเติม…" /></div>
            <div className="grid gap-1.5"><Label>สิ่งที่ชอบที่สุด</Label><Input value={q.q1} onChange={(e) => setQ({ ...q, q1: e.target.value })} /></div>
            <div className="grid gap-1.5"><Label>สิ่งที่ควรปรับปรุง</Label><Input value={q.q2} onChange={(e) => setQ({ ...q, q2: e.target.value })} /></div>
            <div className="grid gap-1.5"><Label>ข้อเสนอแนะอื่น ๆ</Label><Input value={q.q3} onChange={(e) => setQ({ ...q, q3: e.target.value })} /></div>
            <div className="flex gap-2">
              <Button disabled={submit.isPending} onClick={() => submit.mutate()}><Send className="size-4" /> ส่งแบบสำรวจ</Button>
              <Button variant="ghost" onClick={() => setSel('')}>ยกเลิก</Button>
            </div>
            <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
          </Card>
        )}
      </StateView>
      {!sel && <Msg ok={msg.startsWith('✅')}>{msg}</Msg>}
    </div>
  );
}
