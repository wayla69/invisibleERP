'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, CheckCircle2, XCircle, Copy, Send } from 'lucide-react';
import { api, API_BASE } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Channel = { channel: 'line' | 'sms' | 'email'; configured: boolean; enabled: boolean; resolved_provider: 'tenant' | 'env' | 'mock'; callback_token_set: boolean; last_send_at: string | null; last_status: string | null; last_provider: string | null; updated_at: string | null; updated_by: string | null;
  // LP-1 (docs/31) — LINE go-live readiness (line channel only)
  webhook_secret_set?: boolean; webhook_path?: string | null; last_webhook_at?: string | null; last_webhook_status?: string | null };

// The credential fields we collect per channel (write-only — never returned by the API).
// `label` holds an i18n key (t() falls back to the raw string, so plain English labels pass through).
const FIELDS: Record<string, { key: string; label: string; placeholder?: string; type?: string }[]> = {
  line: [
    { key: 'token', label: 'Channel access token (LINE OA)', type: 'password' },
    { key: 'secret', label: 'st.msg.f_line_secret', type: 'password' },
    { key: 'callbackToken', label: 'st.msg.f_callback_token', type: 'password' },
  ],
  sms: [
    { key: 'apiKey', label: 'API key', type: 'password' },
    { key: 'apiUrl', label: 'API endpoint (URL)', placeholder: 'https://…' },
    { key: 'sender', label: 'st.msg.f_sender' },
    { key: 'callbackToken', label: 'st.msg.f_callback_token', type: 'password' },
  ],
  email: [
    { key: 'host', label: 'SMTP host', placeholder: 'smtp.example.com' },
    { key: 'port', label: 'Port', placeholder: '587' },
    { key: 'user', label: 'Username' },
    { key: 'pass', label: 'Password', type: 'password' },
    { key: 'from', label: 'From address', placeholder: 'no-reply@shop.co' },
    { key: 'callbackToken', label: 'st.msg.f_callback_token', type: 'password' },
  ],
};
// `t()` falls back to the raw string, so machine labels (LINE/SMS) pass through unchanged.
const CHANNEL_LABEL: Record<string, string> = { line: 'LINE Official Account', sms: 'SMS', email: 'st.msg.ch_email' };

// Go-live readiness (Phase F3) — mirrors the gateway's resolution order (tenant creds → platform env → mock).
// `label` holds an i18n key resolved via t() at render.
const READINESS: Record<Channel['resolved_provider'], { dot: string; label: string; variant: 'success' | 'info' | 'muted' }> = {
  tenant: { dot: '🟢', label: 'st.msg.rd_tenant', variant: 'success' },
  env: { dot: '🟡', label: 'st.msg.rd_env', variant: 'info' },
  mock: { dot: '⚪', label: 'st.msg.rd_mock', variant: 'muted' },
};

// LP-1 (docs/31) — LINE OA go-live panel: the exact webhook URL to paste into the LINE Developers
// console, webhook receipt health (has LINE actually reached us + verify outcome), and a one-tap test
// push to the clicking admin's own linked LINE. See docs/ops/line-oa-golive.md for the full runbook.
// values are i18n keys resolved via t() at render (the emoji is baked into the catalog value).
const WEBHOOK_STATUS_TH: Record<string, string> = {
  verified: 'st.msg.wh_verified',
  bad_signature: 'st.msg.wh_bad_signature',
  unverified_dev: 'st.msg.wh_unverified_dev',
};

function LineGoLivePanel({ ch }: { ch: Channel }) {
  const webhookUrl = ch.webhook_path ? `${API_BASE}${ch.webhook_path}` : null;
  const testSelf = useMutation({
    mutationFn: () => api<{ status: string; provider: string; to: string }>(`/api/messaging/providers/line/test-self`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (r) => r.status === 'sent' ? notifySuccess(`ส่งทดสอบไปที่ LINE ของคุณแล้ว (${r.to})`) : notifyError(`ส่งไม่สำเร็จ: ${r.status}`),
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="space-y-2 rounded-lg border border-dashed p-3">
      <div className="text-xs font-semibold">เชื่อม LINE Official Account ของร้าน (go-live)</div>
      {webhookUrl ? (
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded bg-muted px-2 py-1 text-xs">{webhookUrl}</code>
          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => { navigator.clipboard?.writeText(webhookUrl); notifySuccess('คัดลอก webhook URL แล้ว'); }}>
            <Copy className="size-3" /> คัดลอก
          </Button>
          <span className="text-xs text-muted-foreground">วางเป็น Webhook URL ใน LINE Developers console (เปิด Use webhook)</span>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">บัญชีสำนักงานใหญ่ไม่มี OA ของร้าน — เข้าสู่ระบบด้วยบัญชีของสาขาเพื่อดู webhook URL</p>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant={ch.webhook_secret_set ? 'success' : 'muted'} className="text-[10px]">
          {ch.webhook_secret_set ? '🟢 ยืนยันลายเซ็น webhook ได้' : '⚪ ยังไม่ได้บันทึก Channel secret'}
        </Badge>
        <span className="text-muted-foreground">
          {ch.last_webhook_at
            ? `${WEBHOOK_STATUS_TH[ch.last_webhook_status ?? ''] ?? ch.last_webhook_status} · ${new Date(ch.last_webhook_at).toLocaleString('th-TH')}`
            : 'ยังไม่เคยได้รับ webhook จาก LINE — กด Verify ใน LINE console หรือทักแชท OA เพื่อทดสอบ'}
        </span>
      </div>
      <Button size="sm" variant="outline" className="gap-1" disabled={testSelf.isPending} onClick={() => testSelf.mutate()}>
        <Send className="size-3" /> ส่งข้อความทดสอบถึง LINE ของฉัน
      </Button>
    </div>
  );
}

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
        {ch.channel === 'line' && <LineGoLivePanel ch={ch} />}
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

type Governance = { quiet_start: string; quiet_end: string; weekly_cap: number };

// W3 (docs/27) — tenant-wide messaging governance: quiet hours + a global weekly marketing cap. Applies to
// MARKETING sends only (journeys/blasts/automation); OTP, receipts and service notices are exempt.
function GovernanceCard() {
  const qc = useQueryClient();
  const q = useQuery<{ governance: Governance }>({ queryKey: ['messaging-governance'], queryFn: () => api('/api/messaging/governance') });
  const [draft, setDraft] = useState<Governance | null>(null);
  const g = draft ?? q.data?.governance ?? null;
  const save = useMutation({
    mutationFn: () => api('/api/messaging/governance', { method: 'PUT', body: JSON.stringify(g) }),
    onSuccess: () => { notifySuccess('บันทึกกติกาการส่งแล้ว'); setDraft(null); qc.invalidateQueries({ queryKey: ['messaging-governance'] }); },
    onError: (e) => notifyError((e as Error).message),
  });
  if (!g) return null;
  return (
    <div className="rounded-lg border p-4">
      <div className="font-semibold">กติกาการส่งข้อความ (Governance)</div>
      <p className="pb-3 text-sm text-muted-foreground">ใช้กับข้อความการตลาดเท่านั้น (journey/บรอดแคสต์/ออโตเมชัน) — OTP ใบเสร็จ และแจ้งเตือนบริการส่งได้เสมอ · ช่วงเงียบเลื่อนส่ง journey ไปหลังสิ้นสุดช่วง ส่วนบรอดแคสต์จะข้ามพร้อมบันทึกเหตุผล · ค่าแนะนำ: 21:00–09:00 และ 4 ข้อความ/สมาชิก/7วัน (ปิด = 00:00/00:00 และ 0)</p>
      <div className="grid max-w-lg grid-cols-3 items-end gap-3">
        <div className="grid gap-1"><Label className="text-xs">ช่วงเงียบเริ่ม (Quiet start)</Label><Input value={g.quiet_start} onChange={(e) => setDraft({ ...g, quiet_start: e.target.value })} placeholder="21:00" /></div>
        <div className="grid gap-1"><Label className="text-xs">สิ้นสุด (Quiet end)</Label><Input value={g.quiet_end} onChange={(e) => setDraft({ ...g, quiet_end: e.target.value })} placeholder="09:00" /></div>
        <div className="grid gap-1"><Label className="text-xs">เพดานต่อสมาชิก/7วัน (0 = ไม่จำกัด)</Label><Input type="number" value={g.weekly_cap} onChange={(e) => setDraft({ ...g, weekly_cap: +e.target.value })} /></div>
      </div>
      <div className="pt-3"><Button size="sm" disabled={save.isPending || !draft} onClick={() => save.mutate()}>{save.isPending ? 'กำลังบันทึก…' : 'บันทึกกติกา'}</Button></div>
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
            <GovernanceCard />
          </div>
        )}
      </StateView>
    </div>
  );
}
