'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Megaphone, Plus, Send, Ban, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const selectCls = 'h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';
const tone: Record<string, any> = { draft: 'muted', scheduled: 'info', sent: 'success', cancelled: 'destructive' };

interface Campaign { id: number; campaign_code: string; name: string; channel: string; audience: string; segment: string | null; tier: string | null; saved_segment_id: number | null; status: string; targeted: number; sent_count: number; skipped_count: number; failed_count: number; schedule_at: string | null }
interface SavedSegment { id: number; name: string }

export default function CampaignsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const list = useQuery<{ campaigns: Campaign[] }>({ queryKey: ['loy-campaigns'], queryFn: () => api('/api/loyalty/campaigns') });
  const segs = useQuery<{ segments: SavedSegment[] }>({ queryKey: ['saved-segments'], queryFn: () => api('/api/loyalty/saved-segments') });

  const [f, setF] = useState({ name: '', channel: 'sms', audience: 'all', segment: '', tier: '', saved_segment_id: '', body: '', variant_b_body: '', split_b_pct: '0', schedule_at: '' });
  const set = (p: Partial<typeof f>) => setF((s) => ({ ...s, ...p }));

  const create = useMutation({
    mutationFn: () => api('/api/loyalty/campaigns', { method: 'POST', body: JSON.stringify({
      name: f.name, channel: f.channel, audience: f.audience, body: f.body,
      ...(f.audience === 'segment' ? { segment: f.segment } : {}), ...(f.audience === 'tier' ? { tier: f.tier } : {}), ...(f.audience === 'saved_segment' ? { saved_segment_id: Number(f.saved_segment_id) } : {}), ...(f.variant_b_body.trim() ? { variant_b_body: f.variant_b_body.trim(), split_b_pct: Number(f.split_b_pct) || 0 } : {}),
      ...(f.schedule_at ? { schedule_at: new Date(f.schedule_at).toISOString() } : {}),
    }) }),
    onSuccess: () => { notifySuccess(t('ly.mk_campaign_created')); setF({ name: '', channel: 'sms', audience: 'all', segment: '', tier: '', saved_segment_id: '', body: '', variant_b_body: '', split_b_pct: '0', schedule_at: '' }); qc.invalidateQueries({ queryKey: ['loy-campaigns'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const sendNow = useMutation({ mutationFn: (c: Campaign) => api(`/api/loyalty/campaigns/${c.id}/send`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['loy-campaigns'] }), onError: (e: Error) => notifyError(e.message) });
  const cancel = useMutation({ mutationFn: (c: Campaign) => api(`/api/loyalty/campaigns/${c.id}/cancel`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['loy-campaigns'] }), onError: (e: Error) => notifyError(e.message) });

  return (
    <div>
      <PageHeader title={t('ly.lc_title')} description={t('ly.lc_desc')} actions={<Link href="/loyalty/members"><Button variant="outline"><Users className="size-4" /> {t('ly.members')}</Button></Link>} />

      <div className="space-y-6">
        <Card className="gap-4">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Plus className="size-4" /> {t('ly.lc_create')}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="grid gap-1.5"><Label>{t('ly.campaign_name')}</Label><Input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder={t('ly.lc_name_ph')} /></div>
              <div className="grid gap-1.5"><Label>{t('ly.lc_channel')}</Label><select className={selectCls} value={f.channel} onChange={(e) => set({ channel: e.target.value })}><option value="sms">SMS</option><option value="email">Email</option><option value="line">LINE</option></select></div>
              <div className="grid gap-1.5"><Label>{t('ly.mk_target_group')}</Label><select className={selectCls} value={f.audience} onChange={(e) => set({ audience: e.target.value })}><option value="all">{t('ly.mk_trig_all')}</option><option value="segment">{t('ly.seg_f_segment')}</option><option value="saved_segment">{t('ly.lc_aud_saved')}</option><option value="tier">{t('ly.seg_f_tier')}</option><option value="birthdays_today">{t('ly.lc_aud_bday')}</option></select></div>
              {f.audience === 'segment' && <div className="grid gap-1.5"><Label>{t('ly.seg_f_segment')}</Label><Input value={f.segment} onChange={(e) => set({ segment: e.target.value })} placeholder={t('ly.seg_value_ph')} /></div>}
              {f.audience === 'tier' && <div className="grid gap-1.5"><Label>{t('ly.lc_tier')}</Label><Input value={f.tier} onChange={(e) => set({ tier: e.target.value })} placeholder={t('ly.lc_tier_ph')} /></div>}
              {f.audience === 'saved_segment' && <div className="grid gap-1.5"><Label>{t('ly.lc_segment')}</Label><select className={selectCls} value={f.saved_segment_id} onChange={(e) => set({ saved_segment_id: e.target.value })}><option value="">{t('ly.lc_select_segment')}</option>{(segs.data?.segments ?? []).map((sg) => <option key={sg.id} value={sg.id}>{sg.name}</option>)}</select></div>}
              <div className="grid gap-1.5"><Label>{t('ly.lc_schedule')}</Label><Input type="datetime-local" value={f.schedule_at} onChange={(e) => set({ schedule_at: e.target.value })} /></div>
            </div>
            <div className="grid gap-1.5"><Label>{t('ly.lc_message')}</Label><textarea className="min-h-20 rounded-md border border-input bg-transparent p-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" value={f.body} onChange={(e) => set({ body: e.target.value })} placeholder={t('ly.lc_message_ph')} /></div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="grid gap-1.5 sm:col-span-2"><Label>{t('ly.mk_variant_b')}</Label><Input value={f.variant_b_body} onChange={(e) => set({ variant_b_body: e.target.value })} placeholder={t('ly.lc_variant_b_ph')} /></div>
              {f.variant_b_body.trim() !== '' && <div className="grid gap-1.5"><Label>{t('ly.mk_split_b')}</Label><Input type="number" min="0" max="90" value={f.split_b_pct} onChange={(e) => set({ split_b_pct: e.target.value })} /></div>}
            </div>
            <div className="flex items-center gap-3"><Button onClick={() => create.mutate()} disabled={!f.name.trim() || !f.body.trim() || (f.audience === 'saved_segment' && !f.saved_segment_id) || create.isPending}>{create.isPending ? t('ly.saving') : t('ly.lc_create')}</Button></div>
          </CardContent>
        </Card>

        <StateView q={list}>
          {list.data && (
            <DataTable
              rows={list.data.campaigns}
              rowKey={(c) => c.id}
              emptyState={{ icon: Megaphone, title: t('ly.no_campaigns'), description: t('ly.lc_empty_desc') }}
              columns={[
                { key: 'campaign_code', label: t('ly.col_code'), render: (c) => <span className="font-mono text-xs">{c.campaign_code}</span> },
                { key: 'name', label: t('ly.col_name'), render: (c) => <span className="inline-flex items-center gap-1.5"><Megaphone className="size-3.5 text-muted-foreground" />{c.name}</span> },
                { key: 'audience', label: t('ly.col_group'), render: (c) => <Badge variant="info">{c.audience}{c.segment ? `:${c.segment}` : c.tier ? `:${c.tier}` : c.saved_segment_id ? `:${segs.data?.segments.find((sg) => sg.id === c.saved_segment_id)?.name ?? c.saved_segment_id}` : ''}</Badge> },
                { key: 'channel', label: t('ly.lc_channel') },
                { key: 'status', label: t('fin.col_status'), render: (c) => <Badge variant={tone[c.status] ?? 'muted'}>{c.status}</Badge> },
                { key: 'sent_count', label: t('ly.lc_col_sspf'), align: 'right', render: (c) => c.status === 'sent' ? <span className="tabular text-xs">{num(c.sent_count)}/{num(c.skipped_count)}/{num(c.failed_count)}</span> : '—' },
                { key: 'act', label: '', align: 'right', render: (c) => (c.status === 'draft' || c.status === 'scheduled') ? (
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="outline" disabled={sendNow.isPending} onClick={() => sendNow.mutate(c)}><Send className="size-3.5" /> {t('ly.lc_send_now')}</Button>
                    <Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate(c)}><Ban className="size-3.5" /></Button>
                  </div>
                ) : null },
              ]}
            />
          )}
        </StateView>
      </div>
    </div>
  );
}
