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
import { thaiDateTime } from '@/lib/format';

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
  const { t } = useLang();
  const webhookUrl = ch.webhook_path ? `${API_BASE}${ch.webhook_path}` : null;
  const testSelf = useMutation({
    mutationFn: () => api<{ status: string; provider: string; to: string }>(`/api/messaging/providers/line/test-self`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (r) => r.status === 'sent' ? notifySuccess(t('st.msg.test_self_sent', { to: r.to })) : notifyError(t('st.msg.send_failed', { status: r.status })),
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="space-y-2 rounded-lg border border-dashed p-3">
      <div className="text-xs font-semibold">{t('st.msg.golive_title')}</div>
      {webhookUrl ? (
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded bg-muted px-2 py-1 text-xs">{webhookUrl}</code>
          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => { navigator.clipboard?.writeText(webhookUrl); notifySuccess(t('st.msg.copied_webhook')); }}>
            <Copy className="size-3" /> {t('st.msg.copy')}
          </Button>
          <span className="text-xs text-muted-foreground">{t('st.msg.paste_hint')}</span>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t('st.msg.hq_no_oa')}</p>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant={ch.webhook_secret_set ? 'success' : 'muted'} className="text-[10px]">
          {ch.webhook_secret_set ? `🟢 ${t('st.msg.wh_secret_ok')}` : `⚪ ${t('st.msg.wh_secret_none')}`}
        </Badge>
        <span className="text-muted-foreground">
          {ch.last_webhook_at
            ? `${t(WEBHOOK_STATUS_TH[ch.last_webhook_status ?? ''] ?? ch.last_webhook_status ?? '')} · ${thaiDateTime(ch.last_webhook_at)}`
            : t('st.msg.no_webhook_yet')}
        </span>
      </div>
      <Button size="sm" variant="outline" className="gap-1" disabled={testSelf.isPending} onClick={() => testSelf.mutate()}>
        <Send className="size-3" /> {t('st.msg.test_self_btn')}
      </Button>
    </div>
  );
}

function ChannelCard({ ch, onSaved }: { ch: Channel; onSaved: () => void }) {
  const { t } = useLang();
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [to, setTo] = useState('');
  const fields = FIELDS[ch.channel];

  const save = useMutation({
    mutationFn: () => api(`/api/messaging/providers/${ch.channel}`, { method: 'PUT', body: JSON.stringify({ creds, enabled: true }) }),
    onSuccess: () => { notifySuccess(t('st.msg.saved_provider')); setCreds({}); onSaved(); },
    onError: (e: any) => notifyError(e.message),
  });
  const test = useMutation({
    mutationFn: () => api<{ status: string; provider: string; error?: string }>(`/api/messaging/providers/${ch.channel}/test`, { method: 'POST', body: JSON.stringify({ to }) }),
    onSuccess: (r) => r.status === 'sent' ? notifySuccess(t('st.msg.test_sent', { provider: r.provider })) : notifyError(t('st.msg.send_failed', { status: r.error ?? r.status })),
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 font-semibold">
          {t(CHANNEL_LABEL[ch.channel])}
          <Badge variant={READINESS[ch.resolved_provider].variant} className="gap-1 text-[10px]">{READINESS[ch.resolved_provider].dot} {t(READINESS[ch.resolved_provider].label)}</Badge>
          {ch.configured
            ? <Badge variant="muted" className="gap-1 text-[10px]"><CheckCircle2 className="size-3 text-success" /> {t('st.msg.connected')}{ch.enabled ? '' : ` ${t('st.msg.disabled_suffix')}`}</Badge>
            : <Badge variant="muted" className="gap-1 text-[10px]"><XCircle className="size-3 text-muted-foreground" /> {t('st.msg.not_configured')}</Badge>}
          {ch.callback_token_set && <Badge variant="muted" className="text-[10px]">{t('st.msg.delivery_receipt')}</Badge>}
        </div>
        <span className="text-xs text-muted-foreground">
          {ch.last_send_at ? t('st.msg.last_send', { status: ch.last_status ?? '—', provider: ch.last_provider ?? '—', when: thaiDateTime(ch.last_send_at) }) : t('st.msg.never_sent')}
          {ch.updated_by ? ` · ${t('st.msg.edited_by', { by: ch.updated_by })}` : ''}
        </span>
      </div>
      <div className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map((f) => (
            <div key={f.key} className="space-y-1">
              <Label className="text-xs">{t(f.label)}</Label>
              <Input type={f.type ?? 'text'} placeholder={f.placeholder} value={creds[f.key] ?? ''} onChange={(e) => setCreds((c) => ({ ...c, [f.key]: e.target.value }))} />
            </div>
          ))}
        </div>
        {ch.channel === 'line' && <LineGoLivePanel ch={ch} />}
        {ch.resolved_provider === 'mock' && ch.last_send_at && (
          <p className="text-xs text-warning">⚠ {t('st.msg.mock_warn')}</p>
        )}
        <p className="text-xs text-muted-foreground">{t('st.msg.secret_note')}</p>
        <div className="flex flex-wrap items-end gap-2">
          <Button size="sm" disabled={save.isPending || fields.every((f) => !creds[f.key])} onClick={() => save.mutate()}>{t('fin.save')}</Button>
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs">{t('st.msg.test_to_label')}</Label>
              <Input className="w-64" value={to} onChange={(e) => setTo(e.target.value)} placeholder={t('st.msg.test_to_ph')} />
            </div>
            <Button size="sm" variant="outline" disabled={test.isPending || !to} onClick={() => test.mutate()}>{t('st.msg.test_btn')}</Button>
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
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ governance: Governance }>({ queryKey: ['messaging-governance'], queryFn: () => api('/api/messaging/governance') });
  const [draft, setDraft] = useState<Governance | null>(null);
  const g = draft ?? q.data?.governance ?? null;
  const save = useMutation({
    mutationFn: () => api('/api/messaging/governance', { method: 'PUT', body: JSON.stringify(g) }),
    onSuccess: () => { notifySuccess(t('st.msg.gov_saved')); setDraft(null); qc.invalidateQueries({ queryKey: ['messaging-governance'] }); },
    onError: (e) => notifyError((e as Error).message),
  });
  if (!g) return null;
  return (
    <div className="rounded-lg border p-4">
      <div className="font-semibold">{t('st.msg.gov_title')}</div>
      <p className="pb-3 text-sm text-muted-foreground">{t('st.msg.gov_desc')}</p>
      <div className="grid max-w-lg grid-cols-3 items-end gap-3">
        <div className="grid gap-1"><Label className="text-xs">{t('st.msg.quiet_start')}</Label><Input value={g.quiet_start} onChange={(e) => setDraft({ ...g, quiet_start: e.target.value })} placeholder="21:00" /></div>
        <div className="grid gap-1"><Label className="text-xs">{t('st.msg.quiet_end')}</Label><Input value={g.quiet_end} onChange={(e) => setDraft({ ...g, quiet_end: e.target.value })} placeholder="09:00" /></div>
        <div className="grid gap-1"><Label className="text-xs">{t('st.msg.weekly_cap')}</Label><Input type="number" value={g.weekly_cap} onChange={(e) => setDraft({ ...g, weekly_cap: +e.target.value })} /></div>
      </div>
      <div className="pt-3"><Button size="sm" disabled={save.isPending || !draft} onClick={() => save.mutate()}>{save.isPending ? t('st.msg.saving') : t('st.msg.save_gov')}</Button></div>
    </div>
  );
}

export default function MessagingProvidersPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ channels: Channel[] }>({ queryKey: ['messaging-providers'], queryFn: () => api('/api/messaging/providers') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['messaging-providers'] });

  return (
    <div>
      <PageHeader
        title={t('st.msg.page_title')}
        description={t('st.msg.page_desc')}
      />
      <StateView q={q}>
        {q.data && (
          <div className="flex items-center gap-2 pb-3 text-sm text-muted-foreground"><MessageSquare className="size-4" /> {t('st.msg.per_shop_note')}</div>
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
