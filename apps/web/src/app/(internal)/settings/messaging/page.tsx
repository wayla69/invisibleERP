'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, CheckCircle2, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Channel = { channel: 'line' | 'sms' | 'email'; configured: boolean; enabled: boolean; resolved_provider: 'tenant' | 'env' | 'mock'; callback_token_set: boolean; last_send_at: string | null; last_status: string | null; last_provider: string | null; updated_at: string | null; updated_by: string | null };

// The credential fields we collect per channel (write-only — never returned by the API).
const FIELDS: Record<string, { key: string; label: string; placeholder?: string; type?: string }[]> = {
  line: [
    { key: 'token', label: 'Channel access token (LINE OA)', type: 'password' },
    { key: 'secret', label: 'Channel secret (สำหรับ webhook follow/unfollow) — ถ้ามี', type: 'password' },
    { key: 'callbackToken', label: 'Callback token (สำหรับ delivery-status callback) — ถ้ามี', type: 'password' },
  ],
  sms: [
    { key: 'apiKey', label: 'API key', type: 'password' },
    { key: 'apiUrl', label: 'API endpoint (URL)', placeholder: 'https://…' },
    { key: 'sender', label: 'ชื่อผู้ส่ง (Sender ID) — ถ้ามี' },
    { key: 'callbackToken', label: 'Callback token (สำหรับ delivery-status callback) — ถ้ามี', type: 'password' },
  ],
  email: [
    { key: 'host', label: 'SMTP host', placeholder: 'smtp.example.com' },
    { key: 'port', label: 'Port', placeholder: '587' },
    { key: 'user', label: 'Username' },
    { key: 'pass', label: 'Password', type: 'password' },
    { key: 'from', label: 'From address', placeholder: 'no-reply@shop.co' },
    { key: 'callbackToken', label: 'Callback token (สำหรับ delivery-status callback) — ถ้ามี', type: 'password' },
  ],
};
const CHANNEL_LABEL: Record<string, string> = { line: 'LINE Official Account', sms: 'SMS', email: 'อีเมล (SMTP)' };

// Go-live readiness (Phase F3) — mirrors the gateway's resolution order (tenant creds → platform env → mock).
const READINESS: Record<Channel['resolved_provider'], { dot: string; label: string; variant: 'success' | 'info' | 'muted' }> = {
  tenant: { dot: '🟢', label: 'พร้อมใช้งาน — ผู้ให้บริการของร้าน', variant: 'success' },
  env: { dot: '🟡', label: 'ใช้ผู้ให้บริการกลางของแพลตฟอร์ม', variant: 'info' },
  mock: { dot: '⚪', label: 'โหมดเดโม — ข้อความไม่ออกจริง', variant: 'muted' },
};

function ChannelCard({ ch, onSaved }: { ch: Channel; onSaved: () => void }) {
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [to, setTo] = useState('');
  const fields = FIELDS[ch.channel];

  const save = useMutation({
    mutationFn: () => api(`/api/messaging/providers/${ch.channel}`, { method: 'PUT', body: JSON.stringify({ creds, enabled: true }) }),
    onSuccess: () => { notifySuccess('บันทึกผู้ให้บริการแล้ว'); setCreds({}); onSaved(); },
    onError: (e: any) => notifyError(e.message),
  });
  const test = useMutation({
    mutationFn: () => api<{ status: string; provider: string; error?: string }>(`/api/messaging/providers/${ch.channel}/test`, { method: 'POST', body: JSON.stringify({ to }) }),
    onSuccess: (r) => r.status === 'sent' ? notifySuccess(`ส่งทดสอบสำเร็จ (provider: ${r.provider})`) : notifyError(`ส่งไม่สำเร็จ: ${r.error ?? r.status}`),
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 font-semibold">
          {CHANNEL_LABEL[ch.channel]}
          <Badge variant={READINESS[ch.resolved_provider].variant} className="gap-1 text-[10px]">{READINESS[ch.resolved_provider].dot} {READINESS[ch.resolved_provider].label}</Badge>
          {ch.configured
            ? <Badge variant="muted" className="gap-1 text-[10px]"><CheckCircle2 className="size-3 text-success" /> เชื่อมต่อแล้ว{ch.enabled ? '' : ' (ปิดใช้งาน)'}</Badge>
            : <Badge variant="muted" className="gap-1 text-[10px]"><XCircle className="size-3 text-muted-foreground" /> ยังไม่ตั้งค่า</Badge>}
          {ch.callback_token_set && <Badge variant="muted" className="text-[10px]">รับ delivery receipt</Badge>}
        </div>
        <span className="text-xs text-muted-foreground">
          {ch.last_send_at ? `ส่งล่าสุด: ${ch.last_status} ผ่าน ${ch.last_provider ?? '—'} · ${new Date(ch.last_send_at).toLocaleString('th-TH')}` : 'ยังไม่เคยส่ง'}
          {ch.updated_by ? ` · แก้ไขโดย ${ch.updated_by}` : ''}
        </span>
      </div>
      <div className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map((f) => (
            <div key={f.key} className="space-y-1">
              <Label className="text-xs">{f.label}</Label>
              <Input type={f.type ?? 'text'} placeholder={f.placeholder} value={creds[f.key] ?? ''} onChange={(e) => setCreds((c) => ({ ...c, [f.key]: e.target.value }))} />
            </div>
          ))}
        </div>
        {ch.resolved_provider === 'mock' && ch.last_send_at && (
          <p className="text-xs text-warning">⚠ ช่องทางนี้อยู่ในโหมดเดโม — ข้อความที่ผ่านมาถูกบันทึกว่า "ส่ง" แต่ไม่ได้ออกไปถึงลูกค้าจริง เชื่อมต่อผู้ให้บริการเพื่อส่งจริง</p>
        )}
        <p className="text-xs text-muted-foreground">ข้อมูลลับถูกเข้ารหัสและเป็นแบบเขียนอย่างเดียว (ระบบไม่แสดงค่าที่บันทึกไว้)</p>
        <div className="flex flex-wrap items-end gap-2">
          <Button size="sm" disabled={save.isPending || fields.every((f) => !creds[f.key])} onClick={() => save.mutate()}>บันทึก</Button>
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs">ส่งทดสอบถึง (เบอร์ / LINE userId / อีเมล)</Label>
              <Input className="w-64" value={to} onChange={(e) => setTo(e.target.value)} placeholder="ปลายทางสำหรับทดสอบ" />
            </div>
            <Button size="sm" variant="outline" disabled={test.isPending || !to} onClick={() => test.mutate()}>ส่งทดสอบ</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function MessagingProvidersPage() {
  const qc = useQueryClient();
  const q = useQuery<{ channels: Channel[] }>({ queryKey: ['messaging-providers'], queryFn: () => api('/api/messaging/providers') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['messaging-providers'] });

  return (
    <div>
      <PageHeader
        title="ผู้ให้บริการข้อความ (Messaging providers)"
        description="เชื่อมต่อ LINE Official Account / ผู้ให้บริการ SMS / อีเมล (SMTP) ของร้านเอง เพื่อส่งข้อความในนามแบรนด์ของคุณ — ถ้าไม่ตั้งค่า ระบบจะใช้ผู้ให้บริการกลางหรือโหมดเดโม"
      />
      <StateView q={q}>
        {q.data && (
          <div className="flex items-center gap-2 pb-3 text-sm text-muted-foreground"><MessageSquare className="size-4" /> ตั้งค่าแยกต่อร้าน · ข้อมูลลับเข้ารหัสที่จัดเก็บ</div>
        )}
        {q.data && (
          <div className="space-y-4">
            {q.data.channels.map((ch) => <ChannelCard key={ch.channel} ch={ch} onSaved={refresh} />)}
          </div>
        )}
      </StateView>
    </div>
  );
}
